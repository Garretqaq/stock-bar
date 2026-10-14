//! 应用内更新：检查 GitHub Release 上的 latest.json，下载并安装新版本。
//!
//! 联网、校验签名、替换安装包都由 tauri-plugin-updater 完成，这里只做三件事：
//! 把结果整理成前端好用的形状、把「已检查到但还没装」的更新存下来、把下载进度回传。
//! 端点与公钥在 tauri.conf.json 的 plugins.updater 里配置；更新包与签名由 CI 产出
//! （见 .github/workflows/build.yml 与 scripts/latest-json.mjs）。
//!
//! 命令壳在 crate 根（lib.rs），本体在这里 —— 与 MCP 一样，子模块里定义命令宏路径难伺候。

use std::sync::{LazyLock, Mutex};

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

/// 发布页：自动更新走不通时（比如安装目录没有写权限）用户能自己去下安装包
const RELEASE_PAGE: &str = "https://github.com/Garretqaq/stock-bar/releases/latest";
/// 更新说明的截断长度（按字符）：Release 正文可能几千字，界面上放不下
const NOTES_MAX: usize = 600;

/// 一次检查的结果：设置窗口「关于」页与主面板提示条共用
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    /// 当前运行的版本
    current_version: String,
    /// 有没有新版
    available: bool,
    /// 有新版时是新版本号，没有时就是当前版本号
    version: String,
    /// 更新说明（Release 正文），可能没有
    notes: Option<String>,
    /// 发布时间（RFC 3339 文本），可能没有
    date: Option<String>,
}

/// 下载 / 安装进度：走 Channel 回传，形状对齐官方 updater 的 DownloadEvent
#[derive(Clone, Serialize)]
#[serde(tag = "event", content = "data", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DownloadEvent {
    /// 开始下载；服务器没给 Content-Length 时 contentLength 为 null
    Started { content_length: Option<u64> },
    /// 又收到一块
    Progress { chunk_length: u64 },
    /// 下载完成，接着就是安装
    Finished,
}

/// 已检查到、还没安装的更新：下载与安装要用同一个 Update（里面有下载地址与签名）。
/// 与 bridge.rs 一样用模块级静态量，不往 tauri 的 state 里塞。
static PENDING: LazyLock<Mutex<Option<Update>>> = LazyLock::new(|| Mutex::new(None));

/// 当前版本（「关于」页不联网就能显示）
pub fn current_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// 检查更新。有新版就存下来等前端让装，并把版本号、更新说明与发布日期报给前端。
pub async fn check(app: &AppHandle) -> Result<UpdateInfo, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
    let found = updater.check().await.map_err(|e| e.to_string())?;
    let current = current_version();
    let info = match &found {
        Some(update) => UpdateInfo {
            current_version: current,
            available: true,
            version: normalize_version(&update.version),
            notes: trim_notes(update.body.as_deref()),
            date: release_date(update),
        },
        None => UpdateInfo {
            current_version: current.clone(),
            available: false,
            version: current,
            notes: None,
            date: None,
        },
    };
    set_pending(found);
    Ok(info)
}

/// 下载并安装。进度通过 Channel 回传：Started → Progress（每次一块）→ Finished。
///
/// 不用 AppHandle：要装的那个 Update 里带着自己的上下文（检查时就抓好了）。
/// Windows 上安装器会让应用自己退出，不会走到返回；macOS 上装完要重启才生效（见 restart）。
/// 失败时把待装的更新放回去：网络抖一下重试一次，不必让用户重新点「检查更新」。
pub async fn install(on_event: Channel<DownloadEvent>) -> Result<(), String> {
    let Some(update) = take_pending() else {
        return Err("还没有可安装的更新，请先检查更新".into());
    };
    let mut started = false;
    let result = update
        .download_and_install(
            |chunk_length, content_length| {
                if !started {
                    started = true;
                    let _ = on_event.send(DownloadEvent::Started {
                        content_length: content_length.map(|n| n as u64),
                    });
                }
                let _ = on_event.send(DownloadEvent::Progress { chunk_length: chunk_length as u64 });
            },
            || {
                let _ = on_event.send(DownloadEvent::Finished);
            },
        )
        .await;
    if result.is_err() {
        set_pending(Some(update));
    }
    result.map_err(|e| e.to_string())
}

/// 装完重启：macOS / Linux 上新版本要重启才生效（Windows 由安装器负责重启）。
///
/// 用 request_restart() 而不是 restart()：前者走一遍正常的退出流程（ExitRequested / Exit 事件），
/// 于是 bridge::shutdown() 会删掉 mcp-endpoint.json、单实例的 socket 也会清理干净；
/// 后者在主线程上直接 cleanup + 重启，跳过这些收尾，还可能让新实例被旧实例的 socket 顶掉。
pub fn restart(app: &AppHandle) {
    app.request_restart();
}

/// 打开项目发布页。地址是写死的 https，没有外部输入，所以不必引 opener 插件。
pub fn open_release_page() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let mut cmd = {
        let mut c = std::process::Command::new("open");
        c.arg(RELEASE_PAGE);
        c
    };
    #[cfg(target_os = "windows")]
    let mut cmd = {
        use std::os::windows::process::CommandExt;
        let mut c = std::process::Command::new("cmd");
        c.args(["/C", "start", "", RELEASE_PAGE]);
        // 应用是 GUI 子系统：不设这个标志，cmd 会先闪一下黑色控制台窗口
        c.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut cmd = {
        let mut c = std::process::Command::new("xdg-open");
        c.arg(RELEASE_PAGE);
        c
    };
    cmd.spawn().map(|_| ()).map_err(|e| format!("打不开浏览器：{e}"))
}

/// 版本号去掉可能的前导 v：前端统一负责加 v，这里只保证数据干净
fn normalize_version(version: &str) -> String {
    version.trim().trim_start_matches(|c| c == 'v' || c == 'V').to_string()
}

/// 更新说明：全是空白的当没有；过长的按字符截断（别把 emoji 劈成半个）
fn trim_notes(notes: Option<&str>) -> Option<String> {
    let text = notes?.trim();
    if text.is_empty() {
        return None;
    }
    let mut out: String = text.chars().take(NOTES_MAX).collect();
    if text.chars().count() > NOTES_MAX {
        out.push('…');
    }
    Some(out)
}

/// 发布日期：manifest 里的 pub_date 本来就是 RFC 3339 文本，原样交给前端格式化
fn release_date(update: &Update) -> Option<String> {
    update.raw_json.get("pub_date")?.as_str().map(str::to_string)
}

/// 存下 / 清掉待装的更新（锁坏了就当没这回事，不让它把命令带崩）
fn set_pending(update: Option<Update>) {
    if let Ok(mut pending) = PENDING.lock() {
        *pending = update;
    }
}

fn take_pending() -> Option<Update> {
    PENDING.lock().ok().and_then(|mut pending| pending.take())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 版本号去掉前导v与空白() {
        assert_eq!(normalize_version("0.0.5"), "0.0.5");
        assert_eq!(normalize_version("v0.0.5"), "0.0.5");
        assert_eq!(normalize_version(" V1.2.3 "), "1.2.3");
    }

    #[test]
    fn 更新说明空白的当没有() {
        assert_eq!(trim_notes(None), None);
        assert_eq!(trim_notes(Some("   \n\t ")), None);
        assert_eq!(trim_notes(Some("  修了个 bug  ")), Some("修了个 bug".into()));
    }

    #[test]
    fn 更新说明过长时按字符截断并补省略号() {
        let long = "好".repeat(NOTES_MAX + 10);
        let out = trim_notes(Some(&long)).unwrap();
        assert_eq!(out.chars().count(), NOTES_MAX + 1);
        assert!(out.ends_with('…'));
        // 刚好到上限：不截断也不补省略号
        let exact = "好".repeat(NOTES_MAX);
        assert_eq!(trim_notes(Some(&exact)).unwrap().chars().count(), NOTES_MAX);
    }

    /// 命令返回的字段名与前端约定一致：前端按 currentVersion / available / version / notes / date 读
    #[test]
    fn 检查结果用驼峰字段名() {
        let info = UpdateInfo {
            current_version: "0.0.4".into(),
            available: true,
            version: "0.0.5".into(),
            notes: Some("修了个 bug".into()),
            date: None,
        };
        let v = serde_json::to_value(&info).unwrap();
        assert_eq!(v["currentVersion"], "0.0.4");
        assert_eq!(v["available"], true);
        assert_eq!(v["version"], "0.0.5");
        assert_eq!(v["notes"], "修了个 bug");
        assert_eq!(v["date"], serde_json::Value::Null);
        assert!(v.get("current_version").is_none());
    }

    /// 进度事件的形状：前端按 { event, data } 解析（见 prefs.ts 的 DownloadEvent）
    #[test]
    fn 进度事件用tag与驼峰data() {
        assert_eq!(
            serde_json::to_value(DownloadEvent::Started { content_length: Some(10) }).unwrap(),
            serde_json::json!({ "event": "started", "data": { "contentLength": 10 } })
        );
        assert_eq!(
            serde_json::to_value(DownloadEvent::Progress { chunk_length: 5 }).unwrap(),
            serde_json::json!({ "event": "progress", "data": { "chunkLength": 5 } })
        );
        // 单位变体不带 data
        assert_eq!(
            serde_json::to_value(DownloadEvent::Finished).unwrap(),
            serde_json::json!({ "event": "finished" })
        );
    }
}
