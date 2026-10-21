//! 网络层：页面里的 /api 请求与 SSH/SFTP WebSocket 全部由这里发出。
//!
//! 页面运行在 tauri.localhost，而 Worker 要求同源 Origin 与 HttpOnly session Cookie。
//! 这里按实例维护 Cookie 罐，并给每个请求补上 `Origin: <实例 origin>`，所以不需要改 Worker。
//! 只代理 /api 路径，页面无法把它当成任意地址的代理。

use crate::settings::{Instance, Settings};
use cookie_store::{CookieStore, RawCookie};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::Duration;
use tauri::ipc::{Channel, InvokeResponseBody};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::Connector;
use url::Url;

const USER_AGENT: &str = concat!("CloudSSH-Mobile/", env!("CARGO_PKG_VERSION"));

/// rustls 客户端配置：ring 加密 + 内置 Mozilla 根证书（不依赖系统证书库，安卓上行为一致）
pub fn tls_config() -> Arc<rustls::ClientConfig> {
    static CONFIG: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let _ = rustls::crypto::ring::default_provider().install_default();
            let roots = rustls::RootCertStore { roots: webpki_roots::TLS_SERVER_ROOTS.to_vec() };
            let mut config = rustls::ClientConfig::builder_with_provider(Arc::new(rustls::crypto::ring::default_provider()))
                .with_safe_default_protocol_versions()
                .expect("rustls protocol versions")
                .with_root_certificates(roots)
                .with_no_client_auth();
            // 只用 HTTP/1.1：reqwest 没启用 http2（压缩体积），WebSocket 本来也不能走 h2。
            // 若在这里声明 h2，服务端选中后 hyper 会直接 panic。
            config.alpn_protocols = vec![b"http/1.1".to_vec()];
            Arc::new(config)
        })
        .clone()
}

enum WsCommand {
    Text(String),
    Binary(Vec<u8>),
    Close(u16, String),
}

pub struct Net {
    data_dir: PathBuf,
    settings: RwLock<Settings>,
    cookies: Mutex<HashMap<String, CookieStore>>,
    client: RwLock<reqwest::Client>,
    sockets: Arc<Mutex<HashMap<u32, mpsc::UnboundedSender<WsCommand>>>>,
    next_socket: AtomicU32,
    /// 页面代数：每次页面重新加载加一，在 sockets 锁内读写
    page_generation: AtomicU32,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpRequest {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    pub body: Option<String>,
    #[serde(default)]
    pub body_base64: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub base64: bool,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum WsEvent {
    Open { protocol: String },
    Text { data: String },
    Close { code: u16, reason: String, was_clean: bool },
    Error { message: String },
}

/// 页面能转发的请求头（其余如 Cookie/Origin/Host 由这里决定）
const FORWARDED_HEADERS: &[&str] = &["accept", "content-type", "accept-language", "cache-control"];

impl Net {
    pub fn new(data_dir: PathBuf) -> Net {
        let settings = Settings::load(&crate::settings::settings_path(&data_dir));
        let client = build_client(settings.proxy.as_deref());
        Net {
            data_dir,
            settings: RwLock::new(settings),
            cookies: Mutex::new(HashMap::new()),
            client: RwLock::new(client),
            sockets: Arc::new(Mutex::new(HashMap::new())),
            next_socket: AtomicU32::new(1),
            page_generation: AtomicU32::new(0),
        }
    }

    pub fn settings(&self) -> Settings {
        self.settings.read().unwrap().clone()
    }

    pub fn update_settings<T>(&self, change: impl FnOnce(&mut Settings) -> Result<T, String>) -> Result<T, String> {
        let mut settings = self.settings.write().unwrap();
        let result = change(&mut settings)?;
        settings
            .save(&crate::settings::settings_path(&self.data_dir))
            .map_err(|e| format!("保存设置失败：{e}"))?;
        *self.client.write().unwrap() = build_client(settings.proxy.as_deref());
        Ok(result)
    }

    pub fn current(&self) -> Instance {
        self.settings.read().unwrap().current().clone()
    }

    // ---------- 界面缓存（服务器列表等，启动时先用它显示） ----------
    // 存在应用数据目录的 ui-cache/ 下、按实例分开：不在缓存目录里，“清除缓存”与系统清理缓存都不会删；
    // 删除实例、清除登录时一起删（clear_ui_cache）

    fn ui_cache_dir(&self) -> PathBuf {
        self.data_dir.join("ui-cache")
    }

    fn ui_cache_path(&self, id: &str, key: &str) -> PathBuf {
        self.ui_cache_dir().join(format!("{id}-{key}.json"))
    }

    /// 当前实例的一项界面缓存；没有就是 None
    pub fn ui_cache_read(&self, key: &str) -> Option<String> {
        std::fs::read_to_string(self.ui_cache_path(&self.current().id, key)).ok()
    }

    /// 写入当前实例的一项界面缓存（先写临时文件再改名，不会留下写了一半的文件）；None 删除
    pub fn ui_cache_write(&self, key: &str, value: Option<&str>) -> Result<(), String> {
        let path = self.ui_cache_path(&self.current().id, key);
        let Some(value) = value else {
            let _ = std::fs::remove_file(&path);
            return Ok(());
        };
        std::fs::create_dir_all(self.ui_cache_dir()).map_err(|e| format!("创建缓存目录失败：{e}"))?;
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, value).map_err(|e| format!("写入缓存失败：{e}"))?;
        std::fs::rename(&temp, &path).map_err(|e| format!("写入缓存失败：{e}"))
    }

    /// 删除某个实例的全部界面缓存
    pub fn clear_ui_cache(&self, id: &str) {
        let prefix = format!("{id}-");
        if let Ok(entries) = std::fs::read_dir(self.ui_cache_dir()) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with(&prefix) {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    }

    // ---------- Cookie ----------

    fn cookie_path(&self, id: &str) -> PathBuf {
        self.data_dir.join(format!("cookies-{id}.json"))
    }

    fn with_cookies<T>(&self, id: &str, f: impl FnOnce(&mut CookieStore) -> T) -> T {
        let mut stores = self.cookies.lock().unwrap();
        let store = stores.entry(id.to_string()).or_insert_with(|| {
            fs::File::open(self.cookie_path(id))
                .ok()
                .and_then(|file| cookie_store::serde::json::load(std::io::BufReader::new(file)).ok())
                .unwrap_or_default()
        });
        f(store)
    }

    pub fn cookie_header(&self, instance: &Instance, url: &Url) -> Option<String> {
        self.with_cookies(&instance.id, |store| {
            let pairs: Vec<String> = store.get_request_values(url).map(|(n, v)| format!("{n}={v}")).collect();
            if pairs.is_empty() { None } else { Some(pairs.join("; ")) }
        })
    }

    pub fn store_cookies<'a>(&self, instance: &Instance, url: &Url, set_cookies: impl Iterator<Item = &'a str>) {
        let parsed: Vec<RawCookie<'static>> = set_cookies.filter_map(|raw| RawCookie::parse(raw.to_string()).ok()).collect();
        if parsed.is_empty() {
            return;
        }
        let path = self.cookie_path(&instance.id);
        self.with_cookies(&instance.id, |store| {
            store.store_response_cookies(parsed.into_iter(), url);
            if let Ok(mut file) = fs::File::create(&path) {
                let _ = cookie_store::serde::json::save(store, &mut file);
            }
        });
    }

    pub fn has_session(&self, instance: &Instance) -> bool {
        let url = Url::parse(&instance.base_url).unwrap();
        self.with_cookies(&instance.id, |store| store.get_request_values(&url).any(|(n, _)| n == "session"))
    }

    pub fn clear_cookies(&self, id: &str) {
        self.cookies.lock().unwrap().remove(id);
        let _ = fs::remove_file(self.cookie_path(id));
    }

    // ---------- HTTP ----------

    pub async fn http(&self, request: HttpRequest) -> Result<HttpResponse, String> {
        if !request.path.starts_with("/api/") && request.path != "/api" {
            return Err("只允许转发 /api 请求".into());
        }
        let instance = self.current();
        let url = Url::parse(&instance.base_url)
            .and_then(|base| base.join(&request.path))
            .map_err(|e| e.to_string())?;
        let method = reqwest::Method::from_bytes(request.method.to_uppercase().as_bytes()).map_err(|e| e.to_string())?;
        let client = self.client.read().unwrap().clone();
        let mut builder = client
            .request(method, url.clone())
            .header("Origin", &instance.base_url)
            .header("User-Agent", USER_AGENT);
        for (name, value) in &request.headers {
            if FORWARDED_HEADERS.contains(&name.to_lowercase().as_str()) {
                builder = builder.header(name, value);
            }
        }
        if let Some(cookie) = self.cookie_header(&instance, &url) {
            builder = builder.header("Cookie", cookie);
        }
        if let Some(body) = request.body {
            let bytes = if request.body_base64 {
                use base64::Engine;
                base64::engine::general_purpose::STANDARD.decode(body).map_err(|e| e.to_string())?
            } else {
                body.into_bytes()
            };
            builder = builder.body(bytes);
        }
        let response = builder.send().await.map_err(|e| format!("网络请求失败：{e}"))?;
        self.store_cookies(
            &instance,
            &url,
            response.headers().get_all("set-cookie").iter().filter_map(|v| v.to_str().ok()),
        );
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .filter(|(name, _)| name.as_str() != "set-cookie")
            .filter_map(|(name, value)| value.to_str().ok().map(|v| (name.to_string(), v.to_string())))
            .collect();
        let bytes = response.bytes().await.map_err(|e| format!("读取响应失败：{e}"))?;
        let (body, base64) = match String::from_utf8(bytes.to_vec()) {
            Ok(text) => (text, false),
            Err(_) => {
                use base64::Engine;
                (base64::engine::general_purpose::STANDARD.encode(&bytes), true)
            }
        };
        Ok(HttpResponse { status, headers, body, base64 })
    }

    /// GET 并解析 JSON（测试连接用）
    pub async fn get_json(&self, instance: &Instance, url: &Url) -> Result<serde_json::Value, String> {
        let client = self.client.read().unwrap().clone();
        let response = client
            .get(url.clone())
            .header("User-Agent", USER_AGENT)
            .header("Accept", "application/json")
            .send()
            .await
            .map_err(|e| format!("网络请求失败：{e}"))?;
        let _ = instance;
        if !response.status().is_success() {
            return Err(format!("HTTP {}", response.status().as_u16()));
        }
        response.json::<serde_json::Value>().await.map_err(|e| format!("响应不是 JSON：{e}"))
    }

    /// 不跟随重定向的 GET（OAuth 用），返回状态码与 Location
    pub async fn get_no_follow(&self, instance: &Instance, url: &Url) -> Result<(u16, Option<String>), String> {
        let client = self.client.read().unwrap().clone();
        let mut builder = client.get(url.clone()).header("User-Agent", USER_AGENT);
        if let Some(cookie) = self.cookie_header(instance, url) {
            builder = builder.header("Cookie", cookie);
        }
        let response = builder.send().await.map_err(|e| format!("网络请求失败：{e}"))?;
        self.store_cookies(
            instance,
            url,
            response.headers().get_all("set-cookie").iter().filter_map(|v| v.to_str().ok()),
        );
        let location = response.headers().get("location").and_then(|v| v.to_str().ok()).map(str::to_string);
        Ok((response.status().as_u16(), location))
    }

    // ---------- WebSocket ----------

    pub async fn ws_open(&self, path: String, events: Channel<InvokeResponseBody>) -> Result<u32, String> {
        if !path.starts_with("/api/ssh") {
            return Err("只允许连接 /api/ssh 与 /api/ssh/sftp".into());
        }
        let generation = self.page_generation.load(Ordering::Relaxed);
        let instance = self.current();
        let mut url = Url::parse(&instance.base_url).and_then(|base| base.join(&path)).map_err(|e| e.to_string())?;
        let cookie_url = url.clone();
        url.set_scheme(if url.scheme() == "https" { "wss" } else { "ws" }).ok();

        let mut request = url.as_str().into_client_request().map_err(|e| e.to_string())?;
        let headers = request.headers_mut();
        headers.insert("Origin", instance.base_url.parse().map_err(|_| "bad origin")?);
        headers.insert("User-Agent", USER_AGENT.parse().unwrap());
        if let Some(cookie) = self.cookie_header(&instance, &cookie_url) {
            headers.insert("Cookie", cookie.parse().map_err(|_| "bad cookie")?);
        }

        let proxy = self.settings.read().unwrap().proxy.clone();
        let host = url.host_str().ok_or("bad host")?.to_string();
        let port = url.port_or_known_default().ok_or("bad port")?;
        let tcp = match proxy.as_deref() {
            Some(proxy) => connect_via_proxy(proxy, &host, port).await?,
            None => TcpStream::connect((host.as_str(), port)).await.map_err(|e| format!("连接失败：{e}"))?,
        };
        let _ = tcp.set_nodelay(true);
        let connector = if url.scheme() == "wss" { Some(Connector::Rustls(tls_config())) } else { Some(Connector::Plain) };
        let (stream, response) = tokio_tungstenite::client_async_tls_with_config(request, tcp, None, connector)
            .await
            .map_err(|e| format!("WebSocket 握手失败：{e}"))?;
        let protocol = response
            .headers()
            .get("sec-websocket-protocol")
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default()
            .to_string();

        let id = self.next_socket.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::unbounded_channel::<WsCommand>();
        let stale = {
            let mut registry = self.sockets.lock().unwrap();
            let stale = self.page_generation.load(Ordering::Relaxed) != generation;
            if !stale {
                registry.insert(id, tx);
            }
            stale
        };
        if stale {
            // 握手期间页面已经重新加载，发起它的页面不在了
            let mut stream = stream;
            let frame = CloseFrame { code: CloseCode::Away, reason: PAGE_RELOADED.into() };
            let _ = tokio::time::timeout(WS_CLOSE_GRACE, stream.close(Some(frame))).await;
            return Err("页面已重新加载".into());
        }
        let _ = events.send(json_event(&WsEvent::Open { protocol }));

        let registry = self.sockets.clone();
        tokio::spawn(async move {
            let close = pump_socket(id, stream, rx, &events).await;
            registry.lock().unwrap().remove(&id);
            let _ = events.send(json_event(&close));
        });
        Ok(id)
    }

    fn socket(&self, id: u32) -> Result<mpsc::UnboundedSender<WsCommand>, String> {
        self.sockets.lock().unwrap().get(&id).cloned().ok_or_else(|| "WebSocket 已关闭".into())
    }

    pub fn ws_send_text(&self, id: u32, text: String) -> Result<(), String> {
        self.socket(id)?.send(WsCommand::Text(text)).map_err(|_| "WebSocket 已关闭".into())
    }

    pub fn ws_send_binary(&self, id: u32, bytes: Vec<u8>) -> Result<(), String> {
        self.socket(id)?.send(WsCommand::Binary(bytes)).map_err(|_| "WebSocket 已关闭".into())
    }

    pub fn ws_close(&self, id: u32, code: u16, reason: String) {
        if let Some(tx) = self.sockets.lock().unwrap().remove(&id) {
            let _ = tx.send(WsCommand::Close(code, reason));
        }
    }

    /// 页面开始重新加载（刷新、登录跳转、渲染进程崩溃后重建）：旧页面的连接已经没人接收，全部关掉，
    /// 免得 SSH 会话在服务端空挂；正在握手的连接完成后也会立即关闭。返回关掉的数量。
    pub fn ws_close_page(&self) -> usize {
        let closing: Vec<_> = {
            let mut registry = self.sockets.lock().unwrap();
            self.page_generation.fetch_add(1, Ordering::Relaxed);
            registry.drain().map(|(_, tx)| tx).collect()
        };
        for tx in &closing {
            let _ = tx.send(WsCommand::Close(CloseCode::Away.into(), PAGE_RELOADED.into()));
        }
        closing.len()
    }
}

const PAGE_RELOADED: &str = "page reloaded";

/// 单写操作的上限：网络卡死时不要无限等待，按断线处理让网页版重连
const WS_WRITE_TIMEOUT: Duration = Duration::from_secs(60);
/// 主动关闭后等服务端回 Close 帧的上限
const WS_CLOSE_GRACE: Duration = Duration::from_secs(5);

/// 同一个任务里收发：任何一个方向出错都结束整条连接并通知页面。
/// （读写分成两个任务时，写端出错会静默退出，连接变成“只能收不能发”，心跳和输出确认都发不出去。）
async fn pump_socket<S>(
    id: u32,
    stream: tokio_tungstenite::WebSocketStream<S>,
    mut rx: mpsc::UnboundedReceiver<WsCommand>,
    events: &Channel<InvokeResponseBody>,
) -> WsEvent
where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let (mut sink, mut source) = stream.split();
    let failed = |message: String| {
        log::warn!("websocket #{id}: {message}");
        let _ = events.send(json_event(&WsEvent::Error { message }));
        WsEvent::Close { code: 1006, reason: String::new(), was_clean: false }
    };
    loop {
        tokio::select! {
            incoming = source.next() => match incoming {
                Some(Ok(Message::Text(text))) => {
                    let _ = events.send(json_event(&WsEvent::Text { data: text.to_string() }));
                }
                Some(Ok(Message::Binary(bytes))) => {
                    let _ = events.send(InvokeResponseBody::Raw(bytes.to_vec()));
                }
                Some(Ok(Message::Close(frame))) => return close_event(frame),
                Some(Ok(_)) => {}
                Some(Err(error)) => return failed(error.to_string()),
                None => return failed("连接已断开".into()),
            },
            command = rx.recv() => {
                let message = match command {
                    Some(WsCommand::Text(text)) => Message::Text(text.into()),
                    Some(WsCommand::Binary(bytes)) => Message::Binary(bytes.into()),
                    Some(WsCommand::Close(code, reason)) => {
                        let frame = CloseFrame { code: CloseCode::from(code), reason: reason.into() };
                        let _ = tokio::time::timeout(WS_CLOSE_GRACE, sink.send(Message::Close(Some(frame)))).await;
                        // 等服务端回 Close 帧，拿到真实的关闭码；超时就按本地关闭处理
                        let reply = tokio::time::timeout(WS_CLOSE_GRACE, async {
                            while let Some(message) = source.next().await {
                                if let Ok(Message::Close(frame)) = message {
                                    return Some(frame);
                                }
                            }
                            None
                        })
                        .await;
                        return match reply {
                            Ok(Some(frame)) => close_event(frame),
                            _ => WsEvent::Close { code, reason: String::new(), was_clean: false },
                        };
                    }
                    // 发送端全部释放（ws_close 已经移除登记）却没收到 Close 命令：直接结束
                    None => return WsEvent::Close { code: 1000, reason: String::new(), was_clean: false },
                };
                match tokio::time::timeout(WS_WRITE_TIMEOUT, sink.send(message)).await {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) => return failed(format!("发送失败：{error}")),
                    Err(_) => return failed("发送超时".into()),
                }
            }
        }
    }
}

fn close_event(frame: Option<CloseFrame>) -> WsEvent {
    let (code, reason) = frame.map(|f| (u16::from(f.code), f.reason.to_string())).unwrap_or((1005, String::new()));
    WsEvent::Close { code, reason, was_clean: true }
}

fn json_event(event: &WsEvent) -> InvokeResponseBody {
    InvokeResponseBody::Json(serde_json::to_string(event).unwrap_or_default())
}

fn build_client(proxy: Option<&str>) -> reqwest::Client {
    let mut builder = reqwest::Client::builder()
        .use_preconfigured_tls((*tls_config()).clone())
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(60));
    builder = match proxy.and_then(|p| reqwest::Proxy::all(p).ok()) {
        Some(proxy) => builder.proxy(proxy),
        None => builder.no_proxy(),
    };
    builder.build().expect("http client")
}

/// 通过 HTTP 代理的 CONNECT 隧道建立 TCP 连接（WebSocket 用）
async fn connect_via_proxy(proxy: &str, host: &str, port: u16) -> Result<TcpStream, String> {
    let proxy = Url::parse(proxy).map_err(|e| e.to_string())?;
    let address = (proxy.host_str().unwrap_or_default().to_string(), proxy.port_or_known_default().unwrap_or(80));
    let mut stream = TcpStream::connect(address).await.map_err(|e| format!("连接代理失败：{e}"))?;
    let request = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\nUser-Agent: {USER_AGENT}\r\n\r\n");
    stream.write_all(request.as_bytes()).await.map_err(|e| e.to_string())?;
    let mut response = Vec::with_capacity(256);
    let mut buf = [0u8; 256];
    while !response.windows(4).any(|w| w == b"\r\n\r\n") {
        let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
        if n == 0 || response.len() > 8192 {
            return Err("代理没有返回有效响应".into());
        }
        response.extend_from_slice(&buf[..n]);
    }
    let status_line = String::from_utf8_lossy(&response);
    if !status_line.starts_with("HTTP/1.1 200") && !status_line.starts_with("HTTP/1.0 200") {
        return Err(format!("代理拒绝了隧道：{}", status_line.lines().next().unwrap_or_default()));
    }
    Ok(stream)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn page_reload_closes_every_socket_of_the_previous_page() {
        let net = Net::new(std::env::temp_dir().join("cloudssh-net-test-missing"));
        let (tx1, mut rx1) = mpsc::unbounded_channel();
        let (tx2, mut rx2) = mpsc::unbounded_channel();
        net.sockets.lock().unwrap().insert(1, tx1);
        net.sockets.lock().unwrap().insert(2, tx2);

        assert_eq!(net.ws_close_page(), 2);
        assert!(net.sockets.lock().unwrap().is_empty());
        assert_eq!(net.page_generation.load(Ordering::Relaxed), 1);
        for rx in [&mut rx1, &mut rx2] {
            match rx.try_recv() {
                Ok(WsCommand::Close(code, reason)) => {
                    assert_eq!(code, 1001);
                    assert_eq!(reason, PAGE_RELOADED);
                }
                _ => panic!("expected a close command"),
            }
        }
        assert!(net.ws_send_text(1, "x".into()).is_err());
        // 没有连接时也推进页面代数，让握手中的连接作废
        assert_eq!(net.ws_close_page(), 0);
        assert_eq!(net.page_generation.load(Ordering::Relaxed), 2);
    }
}
