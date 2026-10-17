//! 平台原生能力。Android 上调用 Kotlin 插件 `NativePlugin`（gen/android 里，代码很少，
//! 只做 Rust 做不了的事：前台服务保活、写入系统“下载”、剪贴板、打开外部链接、退到后台）。
//! 桌面调试（tauri dev）时给出等价或空实现，方便在电脑上迭代界面。

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime};

#[cfg(target_os = "android")]
pub struct NativeHandle<R: Runtime>(pub tauri::plugin::PluginHandle<R>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeepAliveArgs {
    sessions: u32,
    title: String,
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SaveArgs<'a> {
    path: &'a str,
    name: &'a str,
    mime: &'a str,
}

#[derive(Serialize)]
struct TextArgs<'a> {
    text: &'a str,
}

#[derive(Serialize)]
struct UrlArgs<'a> {
    url: &'a str,
}

#[derive(Deserialize, Default)]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct TextResult {
    #[serde(default)]
    text: String,
}

#[derive(Serialize)]
struct ColorArgs<'a> {
    color: &'a str,
}

/// 应用数据（不含 APK）与其中缓存的字节数
#[derive(Serialize, Deserialize, Default)]
pub struct StorageInfo {
    #[serde(default)]
    pub data: u64,
    #[serde(default)]
    pub cache: u64,
}

#[derive(Deserialize, Default)]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct BatteryResult {
    #[serde(default)]
    ignoring: bool,
}

#[derive(Deserialize, Default)]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct NameResult {
    #[serde(default)]
    name: String,
}

/// Custom Tab 登录的结果：用户点“完成登录”时的页面地址；直接关掉标签页时为空
#[derive(Deserialize, Default)]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
struct AuthTabResult {
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[cfg(target_os = "android")]
fn call<R: Runtime, T: serde::de::DeserializeOwned + Default>(app: &AppHandle<R>, method: &str, payload: impl Serialize) -> Result<T, String> {
    // run_mobile_plugin 会把调用投递到 Android 主线程再阻塞等结果：在主线程上调用必然永久死锁（ANR）。
    // 主线程的线程号等于进程号，遇到就直接报错，让问题暴露成日志而不是卡死。
    if unsafe { libc::gettid() } == std::process::id() as libc::pid_t {
        log::error!("refused native call {method} on the Android main thread");
        return Err(format!("不能在主线程调用原生能力：{method}"));
    }
    let handle = app.state::<NativeHandle<R>>();
    handle.0.run_mobile_plugin::<T>(method, payload).map_err(|e| e.to_string())
}

pub fn keep_alive<R: Runtime>(app: &AppHandle<R>, sessions: u32) -> Result<(), String> {
    // 文案留空：由 Kotlin 按系统语言取 strings.xml（values / values-en）
    let args = KeepAliveArgs { sessions, title: "CloudSSH".into(), text: String::new() };
    #[cfg(target_os = "android")]
    {
        call::<R, serde_json::Value>(app, "keepAlive", args).map(|_| ())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, args);
        Ok(())
    }
}

/// 把临时文件存入系统“下载”目录，返回最终文件名
pub fn save_download<R: Runtime>(app: &AppHandle<R>, path: &str, name: &str, mime: &str) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        call::<R, NameResult>(app, "saveDownload", SaveArgs { path, name, mime }).map(|r| r.name)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (SaveArgs { path, name, mime }, NameResult::default());
        let dir = app.path().download_dir().map_err(|e| e.to_string())?;
        let target = dir.join(name);
        std::fs::copy(path, &target).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(path);
        Ok(name.to_string())
    }
}

pub fn clipboard_read<R: Runtime>(app: &AppHandle<R>) -> Result<String, String> {
    #[cfg(target_os = "android")]
    {
        call::<R, TextResult>(app, "clipboardRead", serde_json::json!({})).map(|r| r.text)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, TextResult::default());
        Ok(String::new())
    }
}

pub fn clipboard_write<R: Runtime>(app: &AppHandle<R>, text: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        call::<R, serde_json::Value>(app, "clipboardWrite", TextArgs { text }).map(|_| ())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, TextArgs { text });
        Ok(())
    }
}

/// 在系统浏览器的 Custom Tab 里打开登录页并一直等待：用户点底部“完成登录”返回当时的页面地址，
/// 直接关掉标签页返回 None。没有支持 Custom Tab 的浏览器时返回错误 no_browser。
pub fn open_auth_tab<R: Runtime>(app: &AppHandle<R>, url: &str) -> Result<Option<String>, String> {
    #[cfg(target_os = "android")]
    {
        let result = call::<R, AuthTabResult>(app, "openAuthTab", UrlArgs { url })?;
        match result.error {
            Some(error) => Err(error),
            None => Ok(result.url),
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, UrlArgs { url }, AuthTabResult::default());
        Err("no_browser".into())
    }
}

pub fn open_external<R: Runtime>(app: &AppHandle<R>, url: &str) {
    #[cfg(target_os = "android")]
    {
        if let Err(error) = call::<R, serde_json::Value>(app, "openUrl", UrlArgs { url }) {
            log::warn!("open external failed: {error}");
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, UrlArgs { url });
        log::info!("open external: {url}");
    }
}

pub fn move_to_background<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        call::<R, serde_json::Value>(app, "moveToBackground", serde_json::json!({})).map(|_| ())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}

/// 系统栏与网页背景同色（#rrggbb）
pub fn system_bars<R: Runtime>(app: &AppHandle<R>, color: &str) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        call::<R, serde_json::Value>(app, "systemBars", ColorArgs { color }).map(|_| ())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, ColorArgs { color });
        Ok(())
    }
}

/// 是否已加入“不受电池优化限制”；非 Android 返回 None
pub fn battery_status<R: Runtime>(app: &AppHandle<R>) -> Result<Option<bool>, String> {
    #[cfg(target_os = "android")]
    {
        call::<R, BatteryResult>(app, "batteryStatus", serde_json::json!({})).map(|r| Some(r.ignoring))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, BatteryResult::default());
        Ok(None)
    }
}

pub fn request_battery_exemption<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        call::<R, serde_json::Value>(app, "requestBatteryExemption", serde_json::json!({})).map(|_| ())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}

/// 非 Android 返回 None（设置页隐藏这一项）
pub fn storage_info<R: Runtime>(app: &AppHandle<R>) -> Result<Option<StorageInfo>, String> {
    #[cfg(target_os = "android")]
    {
        call::<R, StorageInfo>(app, "storageInfo", serde_json::json!({})).map(Some)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(None)
    }
}

pub fn clear_cache<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    #[cfg(target_os = "android")]
    {
        call::<R, serde_json::Value>(app, "clearCache", serde_json::json!({})).map(|_| ())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(())
    }
}
