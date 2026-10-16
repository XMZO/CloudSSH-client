//! CloudSSH 移动客户端（Tauri 2）
//!
//! 分层：
//!   settings.rs  连接与配置层（实例、当前实例、代理），规则与 packages/core 一致
//!   net.rs       网络层：代理 /api 与 SSH/SFTP WebSocket，按实例保存 Cookie，补同源 Origin
//!   oauth.rs     GitHub 登录与导航规则（拦截 OAuth 回调，session 只存在 Rust 侧）
//!   native.rs    平台原生能力（Android Kotlin 插件：前台服务保活、下载、剪贴板……）
//! 界面是 packages/ui-web 的移动端构建（网页版完整功能 + overrides/mobile 的移动端功能）。

mod native;
mod net;
mod oauth;
mod settings;

use net::{HttpRequest, HttpResponse, Net};
use serde::Serialize;
use settings::{create_id, normalize_proxy, normalize_worker_url, Instance};
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::plugin::TauriPlugin;
use tauri::{AppHandle, Manager, Runtime, State, WebviewWindowBuilder};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppStateDto {
    instances: Vec<Instance>,
    current_id: String,
    current: Instance,
    proxy: Option<String>,
    logged_in: bool,
    app_version: &'static str,
    platform: &'static str,
}

fn state_dto(net: &Net) -> AppStateDto {
    let settings = net.settings();
    let current = settings.current().clone();
    AppStateDto {
        logged_in: net.has_session(&current),
        instances: settings.instances.clone(),
        current_id: settings.current_id.clone(),
        current,
        proxy: settings.proxy.clone(),
        app_version: env!("CARGO_PKG_VERSION"),
        platform: std::env::consts::OS,
    }
}

// ---------- 实例与设置 ----------

#[tauri::command]
fn app_state(net: State<'_, Net>) -> AppStateDto {
    state_dto(&net)
}

#[tauri::command]
fn save_instance(net: State<'_, Net>, id: Option<String>, name: String, base_url: String) -> Result<Instance, String> {
    let base_url = normalize_worker_url(&base_url)?;
    net.update_settings(|settings| {
        let existing: Vec<String> = settings.instances.iter().map(|i| i.id.clone()).collect();
        let id = id.filter(|id| existing.contains(id)).unwrap_or_else(|| {
            let seed = if name.trim().is_empty() { url::Url::parse(&base_url).ok().and_then(|u| u.host_str().map(str::to_string)).unwrap_or_default() } else { name.clone() };
            create_id(&seed, &existing)
        });
        let instance = Instance {
            name: if name.trim().is_empty() { id.clone() } else { name.trim().chars().take(64).collect() },
            id: id.clone(),
            base_url: base_url.clone(),
        };
        match settings.instances.iter_mut().find(|i| i.id == id) {
            Some(slot) => *slot = instance.clone(),
            None => settings.instances.push(instance.clone()),
        }
        Ok(instance)
    })
}

#[tauri::command]
fn delete_instance(net: State<'_, Net>, id: String) -> Result<(), String> {
    net.update_settings(|settings| {
        if settings.instances.len() <= 1 {
            return Err("至少需要保留一个实例".into());
        }
        settings.instances.retain(|i| i.id != id);
        if settings.current_id == id {
            settings.current_id = settings.instances[0].id.clone();
        }
        Ok(())
    })?;
    net.clear_cookies(&id);
    Ok(())
}

#[tauri::command]
fn select_instance(net: State<'_, Net>, id: String) -> Result<(), String> {
    net.update_settings(|settings| {
        if !settings.instances.iter().any(|i| i.id == id) {
            return Err(format!("实例不存在：{id}"));
        }
        settings.current_id = id;
        Ok(())
    })
}

#[tauri::command]
fn set_proxy(net: State<'_, Net>, proxy: Option<String>) -> Result<Option<String>, String> {
    let proxy = normalize_proxy(proxy.as_deref().unwrap_or(""))?;
    net.update_settings(|settings| {
        settings.proxy = proxy.clone();
        Ok(proxy)
    })
}

#[tauri::command]
fn clear_login(net: State<'_, Net>, id: String) {
    net.clear_cookies(&id);
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ProbeResult {
    latency_ms: u128,
    auth_mode: String,
    login_required: bool,
    oauth_redirect_uri: Option<String>,
}

/// 测试连接：读 /api/config，并探测服务端实际使用的 OAuth 回调地址
#[tauri::command]
async fn test_instance(net: State<'_, Net>, base_url: String) -> Result<ProbeResult, String> {
    let base_url = normalize_worker_url(&base_url)?;
    let probe = Instance { id: "probe".into(), name: "probe".into(), base_url: base_url.clone() };
    let started = std::time::Instant::now();
    let config_url = url::Url::parse(&format!("{base_url}/api/config")).map_err(|e| e.to_string())?;
    let config = net.get_json(&probe, &config_url).await?;
    let latency_ms = started.elapsed().as_millis();
    let mut oauth_redirect_uri = None;
    if config.get("githubAuthEnabled").and_then(|v| v.as_bool()) == Some(true) {
        let start = url::Url::parse(&format!("{base_url}/api/auth/github")).unwrap();
        if let Ok((_, Some(location))) = net.get_no_follow(&probe, &start).await {
            oauth_redirect_uri = url::Url::parse(&location)
                .ok()
                .and_then(|u| u.query_pairs().find(|(k, _)| k == "redirect_uri").map(|(_, v)| v.to_string()));
        }
        net.clear_cookies("probe");
    }
    Ok(ProbeResult {
        latency_ms,
        auth_mode: config.get("authMode").and_then(|v| v.as_str()).unwrap_or("anonymous").to_string(),
        login_required: config.get("githubAuthRequired").and_then(|v| v.as_bool()).unwrap_or(false),
        oauth_redirect_uri,
    })
}

// ---------- 网络 ----------

#[tauri::command]
async fn http_request(net: State<'_, Net>, request: HttpRequest) -> Result<HttpResponse, String> {
    net.http(request).await
}

#[tauri::command]
async fn ws_open(net: State<'_, Net>, path: String, on_event: Channel<InvokeResponseBody>) -> Result<u32, String> {
    net.ws_open(path, on_event).await
}

#[tauri::command]
fn ws_send(net: State<'_, Net>, id: u32, text: String) -> Result<(), String> {
    net.ws_send_text(id, text)
}

fn header<'a>(request: &'a Request<'_>, name: &str) -> Option<&'a str> {
    request.headers().get(name).and_then(|v| v.to_str().ok())
}

fn raw_body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(value) => serde_json::from_value::<Vec<u8>>(value.clone()).map_err(|_| "需要二进制请求体".into()),
    }
}

/// 二进制帧：请求体为原始字节，WebSocket id 放在 x-ws-id 头里
#[tauri::command]
fn ws_send_binary(net: State<'_, Net>, request: Request<'_>) -> Result<(), String> {
    let id: u32 = header(&request, "x-ws-id").and_then(|v| v.parse().ok()).ok_or("缺少 x-ws-id")?;
    net.ws_send_binary(id, raw_body(&request)?)
}

#[tauri::command]
fn ws_close(net: State<'_, Net>, id: u32, code: Option<u16>, reason: Option<String>) {
    net.ws_close(id, code.unwrap_or(1000), reason.unwrap_or_default());
}

// ---------- 原生能力 ----------

#[tauri::command]
fn keep_alive<R: Runtime>(app: AppHandle<R>, sessions: u32) -> Result<(), String> {
    native::keep_alive(&app, sessions)
}

/// 下载：请求体为文件内容，文件名（encodeURIComponent）与 MIME 放在头里
#[tauri::command]
fn save_download<R: Runtime>(app: AppHandle<R>, request: Request<'_>) -> Result<String, String> {
    let name = header(&request, "x-file-name").map(percent_decode).unwrap_or_else(|| "download".into());
    let mime = header(&request, "x-mime").unwrap_or("application/octet-stream").to_string();
    let bytes = raw_body(&request)?;
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let tmp = dir.join(format!("download-{}.part", std::process::id() as u128 * 1_000 + bytes.len() as u128));
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    let result = native::save_download(&app, &tmp.to_string_lossy(), &sanitize_file_name(&name), &mime);
    let _ = std::fs::remove_file(&tmp);
    result
}

#[tauri::command]
fn clipboard_read<R: Runtime>(app: AppHandle<R>) -> Result<String, String> {
    native::clipboard_read(&app)
}

#[tauri::command]
fn clipboard_write<R: Runtime>(app: AppHandle<R>, text: String) -> Result<(), String> {
    native::clipboard_write(&app, &text)
}

#[tauri::command]
fn open_external<R: Runtime>(app: AppHandle<R>, url: String) -> Result<(), String> {
    let parsed = url::Url::parse(&url).map_err(|e| e.to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只允许打开 http(s) 链接".into());
    }
    native::open_external(&app, &url);
    Ok(())
}

#[tauri::command]
fn move_to_background<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    native::move_to_background(&app)
}

#[tauri::command]
fn system_bars<R: Runtime>(app: AppHandle<R>, color: String) -> Result<(), String> {
    let valid = color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit());
    if !valid {
        return Err("颜色格式应为 #rrggbb".into());
    }
    native::system_bars(&app, &color)
}

#[tauri::command]
fn battery_status<R: Runtime>(app: AppHandle<R>) -> Result<Option<bool>, String> {
    native::battery_status(&app)
}

#[tauri::command]
fn storage_info<R: Runtime>(app: AppHandle<R>) -> Result<Option<native::StorageInfo>, String> {
    native::storage_info(&app)
}

#[tauri::command]
fn clear_cache<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    native::clear_cache(&app)
}

#[tauri::command]
fn request_battery_exemption<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    native::request_battery_exemption(&app)
}

fn percent_decode(input: &str) -> String {
    url::form_urlencoded::parse(format!("n={}", input.replace('+', "%2B")).as_bytes())
        .next()
        .map(|(_, v)| v.to_string())
        .unwrap_or_else(|| input.to_string())
}

/// 去掉路径分隔符与控制字符；开头的点会让文件在文件管理器里隐藏，一并去掉
fn sanitize_file_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() || "\\/:*?\"<>|".contains(c) { '_' } else { c })
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').chars().take(200).collect::<String>();
    if cleaned.is_empty() { "download".into() } else { cleaned }
}

// ---------- 装配 ----------

fn cloudssh_plugin<R: Runtime>() -> TauriPlugin<R> {
    tauri::plugin::Builder::new("cloudssh")
        .on_navigation(|webview, url| oauth::on_navigation(webview, url))
        .setup(|_app, _api| {
            #[cfg(target_os = "android")]
            {
                let handle = _api.register_android_plugin("com.xmzo.cloudssh", "NativePlugin")?;
                _app.manage(native::NativeHandle(handle));
            }
            Ok(())
        })
        .build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "android")]
    android_logger::init_once(android_logger::Config::default().with_max_level(log::LevelFilter::Info).with_tag("CloudSSH"));

    tauri::Builder::default()
        .plugin(cloudssh_plugin())
        .setup(|app| {
            let dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&dir)?;
            app.manage(Net::new(dir));
            // 状态就绪后再创建窗口，避免页面早于 Net 调用命令
            let config = app.config().app.windows.first().cloned().ok_or("missing window config")?;
            #[allow(unused_mut)]
            let mut builder = WebviewWindowBuilder::from_config(app.handle(), &config)?;
            // Windows 调试构建：CLOUDSSH_WEBVIEW_DEBUG_PORT=9555 时开启 WebView2 远程调试（自动化测试用）
            #[cfg(all(debug_assertions, windows))]
            if let Ok(port) = std::env::var("CLOUDSSH_WEBVIEW_DEBUG_PORT") {
                builder = builder.additional_browser_args(&format!(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
                ));
            }
            builder.build()?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_state,
            save_instance,
            delete_instance,
            select_instance,
            set_proxy,
            clear_login,
            test_instance,
            http_request,
            ws_open,
            ws_send,
            ws_send_binary,
            ws_close,
            keep_alive,
            save_download,
            clipboard_read,
            clipboard_write,
            open_external,
            move_to_background,
            system_bars,
            battery_status,
            request_battery_exemption,
            storage_info,
            clear_cache,
        ])
        .run(tauri::generate_context!())
        .expect("error while running CloudSSH");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_file_names() {
        assert_eq!(sanitize_file_name(".profile"), "profile");
        assert_eq!(sanitize_file_name("a/b\\c.txt"), "a_b_c.txt");
        assert_eq!(sanitize_file_name(""), "download");
        assert_eq!(percent_decode("%E4%B8%AD%E6%96%87.txt"), "中文.txt");
    }
}
