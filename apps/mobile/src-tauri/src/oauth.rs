//! GitHub 登录与页面导航规则（由插件的 on_navigation 钩子调用）。
//!
//! Worker 的 OAuth 回调地址固定为实例域名（例如 https://bash.al/api/auth/callback），
//! 且回调要校验 oauth_state Cookie。做法：
//!   1. 页面点“使用 GitHub 登录”会导航到 <app>/api/auth/github → 拦下，由 Rust 请求实例的
//!      /api/auth/github（oauth_state 存进 Rust 的 Cookie 罐），再把 WebView 导航到 GitHub 授权页
//!   2. 用户在 WebView 里登录/授权 GitHub
//!   3. GitHub 跳回 <实例>/api/auth/callback?code&state → 拦下，由 Rust 带着 oauth_state 去请求，
//!      Worker 返回的 HttpOnly session Cookie 直接进 Rust 的 Cookie 罐，然后回到应用首页
//! GitHub 页面本身是普通网页，不经过任何代理；session 永远不会暴露给页面脚本。
//!
//! 另一种方式“用浏览器登录”（login_in_browser）：第 2 步改在系统浏览器的 Custom Tab 里完成，
//! passkey、密码管理器、浏览器里已登录的 GitHub 都能用（应用内的 WebView 不支持 WebAuthn）。
//! GitHub 会把标签页带到实例的回调地址：浏览器没有 oauth_state，Worker 先校验 state 就拒绝（403），
//! 不会用掉 code；用户点标签页底部的“完成登录”，浏览器把当前地址交回应用，再由 Rust 照第 3 步重放。

use crate::native;
use crate::net::Net;
use crate::settings::Instance;
use tauri::{AppHandle, Manager, Runtime, Webview};
use url::Url;

/// 应用自身页面的 origin（Android/Windows 为 tauri.localhost，开启了 https scheme）
pub fn is_app_url(url: &Url) -> bool {
    if cfg!(dev) && matches!(url.host_str(), Some("127.0.0.1")) && url.port() == Some(5174) {
        return true; // tauri dev：页面来自 ui-web 的 dev:mobile 服务器
    }
    matches!(url.host_str(), Some("tauri.localhost") | Some("localhost"))
        && matches!(url.scheme(), "http" | "https" | "tauri")
}

pub fn app_home(current: &Url) -> Url {
    let mut home = current.clone();
    home.set_path("/");
    home.set_query(None);
    home.set_fragment(None);
    home
}

fn is_github_auth(url: &Url) -> bool {
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && ["/login", "/session", "/sessions"]
            .iter()
            .any(|p| url.path() == *p || url.path().starts_with(&format!("{p}/")))
}

/// 交给系统打开外部链接。
///
/// 导航回调运行在 Android 主线程上（WebViewClient.shouldOverrideUrlLoading / RustWebView.loadUrl），
/// 而调用 Kotlin 插件会阻塞等待、插件又要在主线程执行 —— 在这里同步调用会让主线程自己等自己（ANR）。
/// 所以放到阻塞线程池里异步执行，导航回调立即返回。
fn open_external_later<R: Runtime>(webview: &Webview<R>, url: &Url) {
    let app = webview.app_handle().clone();
    let url = url.to_string();
    tauri::async_runtime::spawn_blocking(move || native::open_external(&app, &url));
}

/// 返回 true 表示允许 WebView 继续导航。这里运行在主线程：不能做任何阻塞调用（包括调用原生插件）。
pub fn on_navigation<R: Runtime>(webview: &Webview<R>, url: &Url) -> bool {
    let net = webview.state::<Net>();
    let instance = net.current();
    let instance_url = Url::parse(&instance.base_url).expect("valid instance url");
    let same_instance = url.origin() == instance_url.origin();

    if is_app_url(url) {
        if url.path() == "/api/auth/github" {
            let webview = webview.clone();
            let home = app_home(url);
            tauri::async_runtime::spawn(async move { start_login(webview, home).await });
            return false;
        }
        return true;
    }
    if same_instance && url.path() == "/api/auth/callback" {
        let webview = webview.clone();
        let callback = url.clone();
        tauri::async_runtime::spawn(async move { finish_login(webview, callback).await });
        return false;
    }
    if is_github_auth(url) {
        return true;
    }
    match url.scheme() {
        "http" | "https" => {
            // 其他网页交给系统浏览器，避免离开应用页面导致 SSH 会话被销毁
            open_external_later(webview, url);
            false
        }
        // javascript: 是在当前页面执行脚本，不是跳转（例如 HyperOS 点状态栏回顶部会 loadUrl("javascript:...")）
        "javascript" | "about" | "data" | "blob" => true,
        _ => {
            // mailto:、tel:、intent: 等交给系统
            open_external_later(webview, url);
            false
        }
    }
}

fn app_url_with(home: &Url, query: &str) -> Url {
    let mut target = home.clone();
    target.set_query(Some(query));
    target
}

fn query_value(url: &Url, name: &str) -> Option<String> {
    url.query_pairs().find(|(key, _)| key == name).map(|(_, value)| value.into_owned())
}

/// 第 1 步：请求实例的 /api/auth/github，oauth_state 存进 Rust 的 Cookie 罐，返回 GitHub 授权页地址。
/// 错误为页面上 login_error 用的代码：bad_redirect / http_xxx / network
async fn authorize_url(net: &Net, instance: &Instance) -> Result<Url, String> {
    let start = Url::parse(&format!("{}/api/auth/github", instance.base_url)).map_err(|_| "bad_redirect".to_string())?;
    match net.get_no_follow(instance, &start).await {
        Ok((status, Some(location))) if (300..400).contains(&status) => Url::parse(&location).map_err(|_| "bad_redirect".to_string()),
        Ok((status, _)) => {
            log::warn!("login start returned {status}");
            Err(format!("http_{status}"))
        }
        Err(error) => {
            log::warn!("login start failed: {error}");
            Err("network".into())
        }
    }
}

/// 第 3 步：带着 oauth_state 请求回调，Worker 返回的 HttpOnly session Cookie 进 Rust 的 Cookie 罐
async fn complete_callback(net: &Net, instance: &Instance, callback: &Url) -> Result<(), String> {
    match net.get_no_follow(instance, callback).await {
        Ok(_) if net.has_session(instance) => Ok(()),
        Ok((status, _)) => Err(format!("http_{status}")),
        Err(_) => Err("network".into()),
    }
}

async fn start_login<R: Runtime>(webview: Webview<R>, home: Url) {
    let net = webview.state::<Net>();
    let instance = net.current();
    let target = match authorize_url(&net, &instance).await {
        Ok(target) => target,
        Err(code) => app_url_with(&home, &format!("login_error={code}")),
    };
    let _ = webview.navigate(target);
}

async fn finish_login<R: Runtime>(webview: Webview<R>, callback: Url) {
    let net = webview.state::<Net>();
    let instance = net.current();
    let home = webview
        .url()
        .ok()
        .filter(is_app_url)
        .map(|u| app_home(&u))
        .unwrap_or_else(|| Url::parse(default_app_home()).unwrap());
    let target = match complete_callback(&net, &instance, &callback).await {
        Ok(()) => app_url_with(&home, "login=ok"),
        Err(code) => app_url_with(&home, &format!("login_error={code}")),
    };
    let _ = webview.navigate(target);
}

/// 浏览器交回的地址必须是本实例的回调，并且 state 与这次登录发出的一致
fn is_callback_for(instance: &Instance, url: &Url, state: &str) -> bool {
    let Ok(base) = Url::parse(&instance.base_url) else {
        return false;
    };
    url.origin() == base.origin()
        && url.path() == "/api/auth/callback"
        && query_value(url, "code").is_some_and(|code| !code.is_empty())
        && query_value(url, "state").as_deref() == Some(state)
}

/// 用系统浏览器登录（见文件开头）。错误为代码：cancelled（关掉了标签页）/ not_callback（还没授权完就点了
/// “完成登录”）/ no_browser（没有支持 Custom Tab 的浏览器）/ bad_redirect / http_xxx / network
pub async fn login_in_browser<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let net = app.state::<Net>();
    let instance = net.current();
    let authorize = authorize_url(&net, &instance).await?;
    let state = query_value(&authorize, "state").ok_or("bad_redirect")?;
    let returned = {
        let app = app.clone();
        let url = authorize.to_string();
        // 打开标签页后一直等到用户点“完成登录”或关掉它：放在阻塞线程池里等，不占异步线程
        tauri::async_runtime::spawn_blocking(move || native::open_auth_tab(&app, &url))
            .await
            .map_err(|e| e.to_string())??
    };
    let returned = returned.ok_or("cancelled")?;
    let callback = Url::parse(&returned).map_err(|_| "not_callback")?;
    if !is_callback_for(&instance, &callback, &state) {
        return Err("not_callback".into());
    }
    complete_callback(&net, &instance, &callback).await
}

pub fn default_app_home() -> &'static str {
    if cfg!(any(target_os = "android", target_os = "windows")) {
        "https://tauri.localhost/"
    } else {
        "tauri://localhost/"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn instance(base_url: &str) -> Instance {
        Instance { id: "t".into(), name: "t".into(), base_url: base_url.into() }
    }

    #[test]
    fn accepts_only_the_callback_of_this_login() {
        let bash = instance("https://bash.al");
        let ok = Url::parse("https://bash.al/api/auth/callback?code=abc&state=s1").unwrap();
        assert!(is_callback_for(&bash, &ok, "s1"));
        // state 不一致、缺 code、别的域名、别的路径都不接受
        assert!(!is_callback_for(&bash, &ok, "s2"));
        assert!(!is_callback_for(&bash, &Url::parse("https://bash.al/api/auth/callback?state=s1").unwrap(), "s1"));
        assert!(!is_callback_for(&bash, &Url::parse("https://bash.al/api/auth/callback?code=&state=s1").unwrap(), "s1"));
        assert!(!is_callback_for(&bash, &Url::parse("https://evil.example/api/auth/callback?code=abc&state=s1").unwrap(), "s1"));
        assert!(!is_callback_for(&bash, &Url::parse("http://bash.al/api/auth/callback?code=abc&state=s1").unwrap(), "s1"));
        assert!(!is_callback_for(&bash, &Url::parse("https://bash.al/login?code=abc&state=s1").unwrap(), "s1"));
        assert!(!is_callback_for(&bash, &Url::parse("https://github.com/login/oauth/authorize?state=s1").unwrap(), "s1"));
    }
}
