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

use crate::native;
use crate::net::Net;
use tauri::{Manager, Runtime, Webview};
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

/// 返回 true 表示允许 WebView 继续导航
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
            native::open_external(webview.app_handle(), url.as_str());
            false
        }
        "about" | "data" | "blob" => true,
        _ => {
            native::open_external(webview.app_handle(), url.as_str());
            false
        }
    }
}

fn app_url_with(home: &Url, query: &str) -> Url {
    let mut target = home.clone();
    target.set_query(Some(query));
    target
}

async fn start_login<R: Runtime>(webview: Webview<R>, home: Url) {
    let net = webview.state::<Net>();
    let instance = net.current();
    let start = Url::parse(&format!("{}/api/auth/github", instance.base_url)).expect("valid url");
    match net.get_no_follow(&instance, &start).await {
        Ok((status, Some(location))) if (300..400).contains(&status) => {
            if let Ok(target) = Url::parse(&location) {
                let _ = webview.navigate(target);
                return;
            }
            let _ = webview.navigate(app_url_with(&home, "login_error=bad_redirect"));
        }
        Ok((status, _)) => {
            log::warn!("login start returned {status}");
            let _ = webview.navigate(app_url_with(&home, &format!("login_error=http_{status}")));
        }
        Err(error) => {
            log::warn!("login start failed: {error}");
            let _ = webview.navigate(app_url_with(&home, "login_error=network"));
        }
    }
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
    let result = net.get_no_follow(&instance, &callback).await;
    let target = match result {
        Ok(_) if net.has_session(&instance) => app_url_with(&home, "login=ok"),
        Ok((status, _)) => app_url_with(&home, &format!("login_error=http_{status}")),
        Err(_) => app_url_with(&home, "login_error=network"),
    };
    let _ = webview.navigate(target);
}

pub fn default_app_home() -> &'static str {
    if cfg!(any(target_os = "android", target_os = "windows")) {
        "https://tauri.localhost/"
    } else {
        "tauri://localhost/"
    }
}
