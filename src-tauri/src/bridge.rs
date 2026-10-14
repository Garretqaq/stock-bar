//! MCP 本地桥：外部 MCP 客户端（`mcp/stockbar-mcp.mjs`）把命令交给正在运行的应用。
//!
//! 命令本身不在这里执行 —— 这里只做「转发 + 配对」：把命令变成 `mcp-request` 事件送给主面板，
//! 前端用与界面同一套逻辑改完设置（并保存、重绘、刷新菜单栏）后调 `mcp_reply` 回信，
//! 再原样写回 HTTP 响应。这样 MCP 改动与手点界面改动的行为完全一致。
//!
//! 端口是随机的，且只监听回环地址；连接信息（端口 + 令牌）写在 app data 目录的
//! `mcp-endpoint.json` 里，权限 0600 —— 挡的是本机其他进程，不是网络。

use std::collections::HashMap;
use std::io::Read;
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU16, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

/// 连接信息文件名（与 mcp/stockbar-mcp.mjs 里的路径规则对应）
const ENDPOINT_FILE: &str = "mcp-endpoint.json";
/// MCP 服务脚本：打包时按 bundle.resources 放进资源目录的 mcp/ 下，设置面板的卡片要把它报给用户
const SCRIPT_FILE: &str = "stockbar-mcp.mjs";
/// 命令事件名；前端监听它
const CHANNEL: &str = "mcp-request";
/// 执行命令的窗口：主面板一直存在（只是隐藏），设置窗口与行情条不一定开着
const WINDOW: &str = "main";
/// 请求体上限，防止有人往本地端口灌大数据
const MAX_BODY_BYTES: u64 = 64 * 1024;
/// 等前端回信的上限：命令里要联网搜索、拉报价。前端拿到的 deadline 比它早一点，
/// 这样前端发现来不及了还能赶在超时前回一句「没改动」，而不是「报了错其实改了」
const REPLY_TIMEOUT: Duration = Duration::from_secs(32);
/// 交给前端的处理预算（毫秒）：它必须在 deadline 之前动手改设置
const PANEL_BUDGET_MS: u64 = 28_000;

/// 只监听回环地址；端口交给系统分配
const LOOPBACK: &str = "127.0.0.1:0";

/// 主面板是否已经注册好监听（前端就绪前发过去的事件会丢）
static READY: AtomicBool = AtomicBool::new(false);
/// 在途请求：id → 回信通道
static PENDING: LazyLock<Mutex<HashMap<u64, Sender<String>>>> = LazyLock::new(|| Mutex::new(HashMap::new()));
/// 退出时删掉这里记录的连接信息文件
static ENDPOINT: LazyLock<Mutex<Option<PathBuf>>> = LazyLock::new(|| Mutex::new(None));
/// 请求序号
static SEQ: AtomicU64 = AtomicU64::new(1);
/// 监听端口（0 = 桥没起来）。设置面板的 MCP 卡片拿它显示状态
static PORT: AtomicU16 = AtomicU16::new(0);
/// 正在跑的服务（None = 桥关着）。关桥时先 unblock 让服务线程退出，再丢掉它释放端口
static SERVER: LazyLock<Mutex<Option<Arc<tiny_http::Server>>>> = LazyLock::new(|| Mutex::new(None));

/// 一条命令的转发函数：Ok 是前端产出的 JSON 文本，Err 是给用户看的中文原因
type Dispatch = dyn Fn(&str, Value) -> Result<String, String> + Send + Sync;

#[derive(Clone, Serialize)]
struct Request {
    id: u64,
    op: String,
    /// 前端必须在此之前动手改设置（毫秒时间戳），免得「客户端收到超时、设置其实改了」
    deadline: u64,
    args: Value,
}

/// 按设置开 / 关本地桥（幂等）。关掉后端口不再监听、连接信息文件也删掉，
/// 外部客户端拿到的是「没找到运行信息」——和「应用没在运行」是同一个提示。
pub fn set_enabled(app: &AppHandle, on: bool) {
    if on {
        enable(app);
    } else {
        disable();
    }
}

/// 起桥：绑定回环端口、写连接信息文件、开服务线程。已经开着就什么都不做。
pub fn enable(app: &AppHandle) {
    // 已经开着就直接返回；锁坏了也当开着，宁可不重复起
    if SERVER.lock().map(|s| s.is_some()).unwrap_or(true) {
        return;
    }
    let listener = match TcpListener::bind(LOOPBACK) {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[mcp] 本地桥监听失败：{e}");
            return;
        }
    };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let server = match tiny_http::Server::from_listener(listener, None) {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("[mcp] 本地桥启动失败：{e}");
            return;
        }
    };
    let token = random_token();
    if let Some(path) = write_endpoint(app, port, &token) {
        if let Ok(mut slot) = ENDPOINT.lock() {
            *slot = Some(path);
        }
    }
    PORT.store(port as u16, Ordering::Relaxed);
    if let Ok(mut slot) = SERVER.lock() {
        *slot = Some(Arc::clone(&server));
    }
    let handle = app.clone();
    let dispatch: Arc<Dispatch> = Arc::new(move |op, args| dispatch_to_panel(&handle, op, args));
    std::thread::spawn(move || serve(server, token, dispatch));
}

/// 停桥：unblock 让服务线程退出（incoming_requests 就此结束），丢掉最后一份 Server 释放端口，
/// 再删掉连接信息文件。
pub fn disable() {
    let server = SERVER.lock().ok().and_then(|mut slot| slot.take());
    if let Some(server) = server {
        server.unblock();
    }
    PORT.store(0, Ordering::Relaxed);
    if let Ok(mut slot) = ENDPOINT.lock() {
        if let Some(path) = slot.take() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// 退出前收拾：停桥（顺带删掉连接信息文件）
pub fn shutdown() {
    disable();
}

/// 主面板就绪（由 lib.rs 里的 mcp_ready 命令调用）
pub fn mark_ready() {
    READY.store(true, Ordering::Relaxed);
}

/// 给设置面板看的桥状态（lib.rs 的 mcp_info 命令返回它）
#[derive(Serialize)]
pub struct McpInfo {
    /// 本地桥是否在监听（也就是设置里的 MCP 开关是否真的打开了）
    running: bool,
    /// 主面板是否已注册好监听：没就绪时命令会被明确拒绝
    ready: bool,
    /// 监听端口；桥没起来就是 null
    port: Option<u16>,
    /// 连接信息文件（端口 + 令牌）路径，退出应用时删除
    endpoint: Option<String>,
    /// MCP 服务脚本路径；找不到就是 null，前端退回占位符让用户自己填
    script: Option<String>,
}

/// 收集桥状态。脚本路径优先用打包进资源目录的那份（安装后直接可用），
/// 开发时资源目录里通常没有，再退回仓库里的 mcp/。
pub fn info(app: &AppHandle) -> McpInfo {
    let port = PORT.load(Ordering::Relaxed);
    McpInfo {
        running: SERVER.lock().map(|s| s.is_some()).unwrap_or(false),
        ready: READY.load(Ordering::Relaxed),
        port: (port != 0).then_some(port),
        endpoint: ENDPOINT
            .lock()
            .ok()
            .and_then(|slot| slot.as_ref().map(|p| p.display().to_string())),
        script: script_path(app).map(|p| p.display().to_string()),
    }
}

fn script_path(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        candidates.push(dir.join("mcp").join(SCRIPT_FILE));
    }
    // 开发期（tauri dev）资源目录里未必有拷贝，退回仓库里的脚本；
    // 只在 debug 构建里编进去，免得把构建机的路径带进发行包
    #[cfg(debug_assertions)]
    candidates.push(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("mcp")
            .join(SCRIPT_FILE),
    );
    candidates.into_iter().find(|p| p.is_file())
}

/// 前端回信：payload 是它自己拼好的 JSON 文本，原样交给 HTTP 响应
pub fn reply(id: u64, payload: String) {
    let sender = PENDING.lock().ok().and_then(|mut map| map.remove(&id));
    if let Some(tx) = sender {
        let _ = tx.send(payload);
    }
}

// ---------- 转发 ----------

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}


fn dispatch_to_panel(app: &AppHandle, op: &str, args: Value) -> Result<String, String> {
    if !READY.load(Ordering::Relaxed) {
        return Err("StockBar 还在启动，请稍等几秒再试".into());
    }
    if app.get_webview_window(WINDOW).is_none() {
        return Err("主面板不存在，无法执行命令".into());
    }
    let id = SEQ.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel::<String>();
    PENDING
        .lock()
        .map_err(|_| "内部状态损坏".to_string())?
        .insert(id, tx);
    let payload = Request {
        id,
        op: op.to_string(),
        deadline: now_ms() + PANEL_BUDGET_MS,
        args,
    };
    if let Err(e) = app.emit_to(WINDOW, CHANNEL, payload) {
        forget(id);
        return Err(format!("命令没能送达主面板：{e}"));
    }
    match rx.recv_timeout(REPLY_TIMEOUT) {
        Ok(text) => Ok(text),
        Err(_) => {
            forget(id);
            Err("主面板响应超时".into())
        }
    }
}

fn forget(id: u64) {
    if let Ok(mut map) = PENDING.lock() {
        map.remove(&id);
    }
}

// ---------- HTTP ----------

/// 服务循环：unblock()（停桥时调用）会让 incoming_requests 结束，线程随之退出
fn serve(server: Arc<tiny_http::Server>, token: String, dispatch: Arc<Dispatch>) {
    let token = Arc::new(token);
    // 每个请求单开线程：转发要等前端（可能联网），别让并发请求互相排队
    for mut request in server.incoming_requests() {
        let dispatch = Arc::clone(&dispatch);
        let token = Arc::clone(&token);
        std::thread::spawn(move || {
            let (code, body) = route(&mut request, &token, dispatch.as_ref());
            let _ = request.respond(response(code, body));
        });
    }
}

fn response(code: u16, body: String) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let header = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json; charset=utf-8"[..])
        .expect("常量头合法");
    tiny_http::Response::from_string(body)
        .with_status_code(code)
        .with_header(header)
}

/// 只认回环地址上的合法令牌：令牌不对就当没这个接口，别让人靠错误信息摸清结构
fn authorized(request: &tiny_http::Request, token: &str) -> bool {
    request
        .headers()
        .iter()
        .any(|h| h.field.equiv("X-StockBar-Token") && h.value.as_str() == token)
}

fn route(request: &mut tiny_http::Request, token: &str, dispatch: &Dispatch) -> (u16, String) {
    if !authorized(request, token) {
        return (401, error_body("令牌不对"));
    }
    let path = request.url().split('?').next().unwrap_or("").to_string();
    if request.method() == &tiny_http::Method::Get && path == "/health" {
        return (
            200,
            json!({ "ok": true, "app": "StockBar", "version": env!("CARGO_PKG_VERSION"), "pid": std::process::id() })
                .to_string(),
        );
    }
    if request.method() != &tiny_http::Method::Post || path != "/command" {
        return (404, error_body("没有这个接口"));
    }
    let mut raw = String::new();
    if request.as_reader().take(MAX_BODY_BYTES).read_to_string(&mut raw).is_err() {
        return (400, error_body("读请求体失败"));
    }
    let body: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(_) => return (400, error_body("请求体不是合法 JSON")),
    };
    let op = body.get("op").and_then(Value::as_str).unwrap_or("").trim().to_string();
    if op.is_empty() {
        return (400, error_body("缺少 op"));
    }
    let args = body.get("args").cloned().unwrap_or(Value::Null);
    match dispatch(&op, args) {
        Ok(text) => (200, text),
        Err(message) => (200, error_body(&message)),
    }
}

fn error_body(message: &str) -> String {
    json!({ "ok": false, "error": message }).to_string()
}

// ---------- 连接信息 ----------

fn endpoint_path(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir.join(ENDPOINT_FILE))
}

/// 把连接信息写到 app data 目录：Unix 上一步就按 0600 建，别先按 umask（通常 0644）建再改权限
fn write_endpoint(app: &AppHandle, port: u16, token: &str) -> Option<PathBuf> {
    let path = endpoint_path(app)?;
    let body = json!({
        "app": "StockBar",
        "port": port,
        "token": token,
        "pid": std::process::id(),
        "version": env!("CARGO_PKG_VERSION"),
    })
    .to_string();

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&path)
            .ok()?;
        file.write_all(body.as_bytes()).ok()?;
        // mode 只管新建：开发期残留的旧文件可能还是 0644，这里补一刀
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    {
        std::fs::write(&path, body).ok()?;
    }
    Some(path)
}

/// 令牌：用系统随机源。它只用来挡住本机其他进程（端口本身只监听回环），
/// 但既然随机源唾手可得，就别用可推测的时间/进程号拼出来
fn random_token() -> String {
    let mut buf = [0u8; 16];
    if getrandom::fill(&mut buf).is_err() {
        // 极端情况下退回时间戳：宁可弱一点，也别让 MCP 用不了
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(0);
        buf[..8].copy_from_slice(&nanos.to_le_bytes());
        buf[8..].copy_from_slice(&(std::process::id() as u64).to_le_bytes());
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use std::io::Write;
    use std::net::TcpStream;

    use super::*;

    fn echo_dispatch(op: &str, args: Value) -> Result<String, String> {
        match op {
            "boom" => Err("炸了".into()),
            _ => Ok(json!({ "ok": true, "text": op, "args": args }).to_string()),
        }
    }

    /// 起一个真的测试服务：返回端口、令牌，以及服务本体（要测「停桥释放端口」得拿着它）
    fn test_server() -> (u16, String, Arc<tiny_http::Server>) {
        let listener = TcpListener::bind(LOOPBACK).expect("绑定回环端口");
        let port = listener.local_addr().unwrap().port();
        let server = Arc::new(tiny_http::Server::from_listener(listener, None).expect("起测试服务"));
        let token = random_token();
        let dispatch: Arc<Dispatch> = Arc::new(echo_dispatch);
        let t = token.clone();
        let s = Arc::clone(&server);
        std::thread::spawn(move || serve(s, t, dispatch));
        (port, token, server)
    }

    fn start_test_server() -> (u16, String) {
        let (port, token, _) = test_server();
        (port, token)
    }

    /// 手写一个最小 HTTP 请求，够测路由与鉴权
    fn http(port: u16, token: &str, method: &str, path: &str, body: &str) -> (u16, String) {
        let mut stream = TcpStream::connect(("127.0.0.1", port)).expect("连上本地桥");
        stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-StockBar-Token: {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(request.as_bytes()).unwrap();
        let mut raw = Vec::new();
        // 服务端回完就关连接；读超时只说明读完了
        let _ = stream.read_to_end(&mut raw);
        let text = String::from_utf8_lossy(&raw).to_string();
        let status = text
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);
        let body = text.split("\r\n\r\n").nth(1).unwrap_or("").trim().to_string();
        (status, body)
    }

    #[test]
    fn 令牌不对时拒绝服务() {
        let (port, token) = start_test_server();
        assert_eq!(http(port, "wrong", "GET", "/health", "").0, 401);
        assert_eq!(http(port, "", "POST", "/command", "{}").0, 401);
        assert_eq!(http(port, &token, "GET", "/health", "").0, 200);
    }

    #[test]
    fn 健康检查带上进程信息() {
        let (port, token) = start_test_server();
        let (status, body) = http(port, &token, "GET", "/health", "");
        assert_eq!(status, 200);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["ok"], json!(true));
        assert_eq!(v["app"], json!("StockBar"));
        assert_eq!(v["pid"], json!(std::process::id()));
    }

    #[test]
    fn 命令带着参数转发出去() {
        let (port, token) = start_test_server();
        let (status, body) = http(
            port,
            &token,
            "POST",
            "/command",
            r#"{"op":"watchlist.add","args":{"target":"1.600519"}}"#,
        );
        assert_eq!(status, 200);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["ok"], json!(true));
        assert_eq!(v["text"], json!("watchlist.add"));
        assert_eq!(v["args"]["target"], json!("1.600519"));
    }

    #[test]
    fn 前端报错也带上原因() {
        let (port, token) = start_test_server();
        let (status, body) = http(port, &token, "POST", "/command", r#"{"op":"boom"}"#);
        assert_eq!(status, 200);
        let v: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["ok"], json!(false));
        assert_eq!(v["error"], json!("炸了"));
    }

    #[test]
    fn 请求体不合法时给出可读原因() {
        let (port, token) = start_test_server();
        let (status, body) = http(port, &token, "POST", "/command", "not json");
        assert_eq!(status, 400);
        assert!(body.contains("不是合法 JSON"));

        let (status, body) = http(port, &token, "POST", "/command", "{}");
        assert_eq!(status, 400);
        assert!(body.contains("缺少 op"));
    }

    #[test]
    fn 其他路径与方法一律找不到() {
        let (port, token) = start_test_server();
        assert_eq!(http(port, &token, "GET", "/settings", "").0, 404);
        assert_eq!(http(port, &token, "POST", "/health", "").0, 404);
    }

    #[test]
    fn 令牌够长且每次都不同() {
        let a = random_token();
        let b = random_token();
        assert_eq!(a.len(), 32);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }

    #[test]
    fn 交给前端的预算比超时上限短() {
        // 前端先在 deadline 前收手，Rust 再多等一会儿收它的回信
        assert!(Duration::from_millis(PANEL_BUDGET_MS) < REPLY_TIMEOUT);
    }

    #[test]
    fn 停桥后端口立刻释放() {
        let (port, token, server) = test_server();
        // 起着的时候服务是通的（令牌对得上就 200）
        assert_eq!(http(port, &token, "GET", "/health", "").0, 200);
        assert!(
            TcpListener::bind(("127.0.0.1", port)).is_err(),
            "停桥前端口应该是占着的"
        );

        // 停桥 = unblock + 丢掉最后一份 Server：服务线程退出后端口就能再绑上
        server.unblock();
        drop(server);
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while TcpListener::bind(("127.0.0.1", port)).is_err() {
            assert!(std::time::Instant::now() < deadline, "停桥后端口没释放");
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}
