//! 连接与配置层：实例列表、当前实例、网络代理。规则与 packages/core/src/instance.ts 保持一致。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use url::Url;

/// 默认实例：必须是 GitHub OAuth App 登记回调的域名（与桌面端一致）
pub const DEFAULT_WORKER_URL: &str = "https://bash.al";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    pub name: String,
    pub base_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub instances: Vec<Instance>,
    pub current_id: String,
    /// 可选网络代理（http://host:port），HTTP 与 WebSocket 都走它
    #[serde(default)]
    pub proxy: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            instances: vec![Instance {
                id: "default".into(),
                name: "CloudSSH".into(),
                base_url: DEFAULT_WORKER_URL.into(),
            }],
            current_id: "default".into(),
            proxy: None,
        }
    }
}

impl Settings {
    pub fn load(path: &Path) -> Settings {
        let parsed = fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Settings>(&text).ok());
        let mut settings = parsed.unwrap_or_default();
        settings.instances.retain(|i| is_valid_id(&i.id) && normalize_worker_url(&i.base_url).is_ok());
        if settings.instances.is_empty() {
            settings = Settings::default();
        }
        if !settings.instances.iter().any(|i| i.id == settings.current_id) {
            settings.current_id = settings.instances[0].id.clone();
        }
        settings
    }

    pub fn save(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(self).unwrap_or_default())?;
        fs::rename(tmp, path)
    }

    pub fn current(&self) -> &Instance {
        self.instances
            .iter()
            .find(|i| i.id == self.current_id)
            .unwrap_or(&self.instances[0])
    }
}

/// 只保留 origin；仅允许 https（本地开发地址允许 http），拒绝路径、凭据与参数
pub fn normalize_worker_url(input: &str) -> Result<String, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("Worker 地址不能为空".into());
    }
    let with_scheme = if raw.contains("://") { raw.to_string() } else { format!("https://{raw}") };
    let url = Url::parse(&with_scheme).map_err(|_| format!("无法解析 Worker 地址：{raw}"))?;
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Worker 地址不能包含用户名或密码".into());
    }
    let host = url.host_str().ok_or_else(|| format!("无法解析 Worker 地址：{raw}"))?.to_lowercase();
    match url.scheme() {
        "https" => {}
        "http" if ["localhost", "127.0.0.1", "[::1]", "10.0.2.2"].contains(&host.as_str()) => {}
        "http" => return Err("仅本地开发地址允许使用 http，其余必须使用 https".into()),
        other => return Err(format!("不支持的协议：{other}")),
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err("Worker 地址只能是根地址，不能带路径".into());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Worker 地址只能是根地址，不能带参数".into());
    }
    Ok(url.origin().ascii_serialization())
}

pub fn is_valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

pub fn create_id(name: &str, existing: &[String]) -> String {
    let mut base = String::new();
    for ch in name.to_lowercase().chars() {
        if ch.is_ascii_lowercase() || ch.is_ascii_digit() {
            base.push(ch);
        } else if !base.ends_with('-') {
            base.push('-');
        }
    }
    let base = base.trim_matches('-').chars().take(40).collect::<String>();
    let base = if base.is_empty() { "instance".to_string() } else { base };
    if !existing.contains(&base) {
        return base;
    }
    (2..10_000)
        .map(|i| format!("{base}-{i}"))
        .find(|candidate| !existing.contains(candidate))
        .unwrap_or_else(|| format!("{base}-x"))
}

pub fn normalize_proxy(input: &str) -> Result<Option<String>, String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Ok(None);
    }
    let url = Url::parse(if raw.contains("://") { raw.to_string() } else { format!("http://{raw}") }.as_str())
        .map_err(|_| format!("无法解析代理地址：{raw}"))?;
    if url.scheme() != "http" {
        return Err("目前只支持 http 代理（例如 http://127.0.0.1:7890）".into());
    }
    if url.host_str().is_none() || url.port_or_known_default().is_none() {
        return Err(format!("无法解析代理地址：{raw}"));
    }
    Ok(Some(format!("http://{}:{}", url.host_str().unwrap(), url.port_or_known_default().unwrap())))
}

pub fn settings_path(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_worker_urls() {
        assert_eq!(normalize_worker_url("bash.al").unwrap(), "https://bash.al");
        assert_eq!(normalize_worker_url(" https://Example.Workers.dev/ ").unwrap(), "https://example.workers.dev");
        assert_eq!(normalize_worker_url("http://10.0.2.2:8787").unwrap(), "http://10.0.2.2:8787");
        for bad in ["", "http://example.com", "https://x.com/app", "https://u:p@x.com", "ftp://x.com", "https://x.com/?a=1"] {
            assert!(normalize_worker_url(bad).is_err(), "should reject {bad}");
        }
    }

    #[test]
    fn creates_ids() {
        assert_eq!(create_id("My Server", &[]), "my-server");
        assert_eq!(create_id("My Server", &["my-server".into()]), "my-server-2");
        assert_eq!(create_id("生产环境", &[]), "instance");
        assert!(is_valid_id("default") && !is_valid_id("Bad ID"));
    }

    #[test]
    fn normalizes_proxy() {
        assert_eq!(normalize_proxy("127.0.0.1:7890").unwrap().as_deref(), Some("http://127.0.0.1:7890"));
        assert_eq!(normalize_proxy("").unwrap(), None);
        assert!(normalize_proxy("socks5://1.2.3.4:1080").is_err());
    }
}
