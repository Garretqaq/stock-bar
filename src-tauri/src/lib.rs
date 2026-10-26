use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{
    menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
#[cfg(target_os = "macos")]
use tauri_plugin_positioner::{Position, WindowExt};

mod backup;
mod bridge;
mod notify;
mod qqrank;
mod update;

const TRAY_ID: &str = "main";
const WINDOW_LABEL: &str = "main";
const SETTINGS_LABEL: &str = "settings";
/// Windows 悬浮行情条（托盘不能显示文字时的替代）
const TICKER_LABEL: &str = "ticker";

/// 托盘右键菜单里的项（见 tray_menu）
const MENU_SETTINGS: &str = "open-settings";
const MENU_TICKER: &str = "toggle-ticker";
const MENU_QUIT: &str = "quit";

/// 小窗最近一次因失焦而隐藏的时间（毫秒）。
/// 点击托盘图标时，窗口会先失焦隐藏、再收到点击事件；
/// 若刚刚隐藏过，就不要立即重新弹出，实现「再点一次关闭」。
static LAST_HIDDEN_MS: AtomicU64 = AtomicU64::new(0);

/// Windows 上「失焦」发生在按下、「点击」在抬起，两者间隔就是按住的时长，留宽一些
#[cfg(target_os = "macos")]
const TOGGLE_DEBOUNCE_MS: u64 = 250;
#[cfg(not(target_os = "macos"))]
const TOGGLE_DEBOUNCE_MS: u64 = 400;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn hide_panel(win: &WebviewWindow) {
    LAST_HIDDEN_MS.store(now_ms(), Ordering::Relaxed);
    let _ = win.hide();
}

fn recently_hidden() -> bool {
    now_ms().saturating_sub(LAST_HIDDEN_MS.load(Ordering::Relaxed)) <= TOGGLE_DEBOUNCE_MS
}

// ---------- 弹窗定位 ----------

/// 物理像素矩形：x, y, w, h
#[derive(Clone, Copy)]
#[cfg_attr(target_os = "macos", allow(dead_code))] // macOS 用 positioner 定位，不读这些字段
struct Anchor(f64, f64, f64, f64);

/// 最近一次托盘事件里的图标位置（非 macOS 自己算弹窗位置用）
#[cfg(not(target_os = "macos"))]
static TRAY_RECT: std::sync::Mutex<Option<(f64, f64, f64, f64)>> = std::sync::Mutex::new(None);

#[cfg(not(target_os = "macos"))]
fn remember_tray_rect(rect: &tauri::Rect) {
    let p = rect.position.to_physical::<f64>(1.0);
    let s = rect.size.to_physical::<f64>(1.0);
    if let Ok(mut r) = TRAY_RECT.lock() {
        *r = Some((p.x, p.y, s.width, s.height));
    }
}

/// 把窗口贴着锚点（托盘图标 / 悬浮行情条）放，并限制在锚点所在屏幕的工作区内。
/// 任务栏在底部 → 放在锚点上方；在顶部 → 下方；在左右两侧 → 放在侧边。
/// 没有锚点时放到主屏工作区右下角。
#[cfg(not(target_os = "macos"))]
fn place_near(win: &WebviewWindow, anchor: Option<Anchor>) {
    let Ok(size) = win.outer_size() else { return };
    let (w, h) = (size.width as f64, size.height as f64);
    let monitor = match anchor {
        Some(Anchor(x, y, aw, ah)) => win.monitor_from_point(x + aw / 2.0, y + ah / 2.0).ok().flatten(),
        None => None,
    }
    .or_else(|| win.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let wa = monitor.work_area();
    let (l, t) = (wa.position.x as f64, wa.position.y as f64);
    let (r, b) = (l + wa.size.width as f64, t + wa.size.height as f64);
    let gap = 6.0 * monitor.scale_factor();

    let (mut x, mut y) = match anchor {
        None => (r - w - gap, b - h - gap),
        Some(Anchor(ax, ay, aw, ah)) => {
            let (cx, cy) = (ax + aw / 2.0, ay + ah / 2.0);
            if ax + aw <= l {
                (l + gap, cy - h / 2.0) // 任务栏在左
            } else if ax >= r {
                (r - w - gap, cy - h / 2.0) // 任务栏在右
            } else if cy > (t + b) / 2.0 {
                (cx - w / 2.0, ay - h - gap) // 锚点在下半屏：往上弹
            } else {
                (cx - w / 2.0, ay + ah + gap) // 锚点在上半屏：往下弹
            }
        }
    };
    x = x.min(r - w).max(l);
    y = y.min(b - h).max(t);
    let _ = win.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
}

/// 面板该放在哪儿（物理像素）：优先「鼠标正下方居中」—— 点菜单栏图标时鼠标就在图标上，
/// 然后夹进工作区，保证整块面板都在屏幕里。纯计算，方便单测；work 是工作区的 (左, 上, 右, 下)。
#[cfg(target_os = "macos")]
fn panel_position(
    cursor: Option<(f64, f64)>,
    work: (f64, f64, f64, f64),
    size: (f64, f64),
    gap: f64,
) -> (f64, f64) {
    let (l, t, r, b) = work;
    let (w, h) = size;
    // 拿不到鼠标位置就贴右边（菜单栏图标都在右边）
    let x = cursor.map_or(r - w - gap, |(cx, _)| cx - w / 2.0);
    let x = x.min(r - w - gap).max(l + gap);
    let y = (t + gap).min(b - h - gap).max(t + gap);
    (x.round(), y.round())
}

/// macOS：面板挂在菜单栏图标下方。
/// 不用 positioner 算出来的坐标：多显示器 / 缩放不一致的机器上它会把窗口丢到屏幕外
/// （实测主屏 2304 宽、窗口被放到 x=2795，点图标看着就是「点了没反应」）。
#[cfg(target_os = "macos")]
fn place_panel(win: &WebviewWindow) {
    let Ok(size) = win.outer_size() else { return };
    let cursor = win.cursor_position().ok();
    let monitor = cursor
        .and_then(|c| win.monitor_from_point(c.x, c.y).ok().flatten())
        .or_else(|| win.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else {
        // 连屏幕都问不出来（几乎不会发生）：退回 positioner，至少别什么都不做
        let _ = win.move_window(Position::TrayBottomCenter);
        return;
    };
    let wa = monitor.work_area();
    let (l, t) = (wa.position.x as f64, wa.position.y as f64);
    let (x, y) = panel_position(
        cursor.map(|c| (c.x, c.y)),
        (l, t, l + wa.size.width as f64, t + wa.size.height as f64),
        (size.width as f64, size.height as f64),
        6.0 * monitor.scale_factor(),
    );
    let _ = win.set_position(tauri::PhysicalPosition::new(x as i32, y as i32));
}

fn show_panel(win: &WebviewWindow, anchor: Option<Anchor>) {
    // macOS 菜单栏在顶部：窗口挂在图标正下方
    #[cfg(target_os = "macos")]
    {
        let _ = anchor;
        place_panel(win);
    }
    // Windows/Linux：任务栏位置不固定，按托盘图标（或悬浮条）位置和屏幕工作区自己算
    #[cfg(not(target_os = "macos"))]
    {
        let anchor = anchor.or_else(|| TRAY_RECT.lock().ok().and_then(|r| r.map(|(x, y, w, h)| Anchor(x, y, w, h))));
        place_near(win, anchor);
    }

    let _ = win.show();
    let _ = win.set_focus();
    let _ = win.emit_to(WINDOW_LABEL, "panel-shown", ());
}

fn toggle_panel(app: &AppHandle, anchor: Option<Anchor>) {
    let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    if win.is_visible().unwrap_or(false) {
        hide_panel(&win);
    } else if !recently_hidden() {
        show_panel(&win, anchor);
    }
}

// ---------- 托盘 ----------

const DEFAULT_TRAY_ICON: &[u8] = include_bytes!("../icons/tray.png");

/// Windows 任务栏是否为浅色（读注册表 SystemUsesLightTheme；读不到按深色处理，Win10/11 默认深色）
#[cfg(target_os = "windows")]
fn taskbar_is_light() -> bool {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize")
        .and_then(|k| k.get_value::<u32, _>("SystemUsesLightTheme"))
        .map(|v| v != 0)
        .unwrap_or(false)
}

/// 默认托盘图标。tray.png 是黑色剪影：macOS 当 template 图自动适配；
/// Windows 不支持 template，深色任务栏上要自己染成白色，否则看不见。
fn default_tray_icon() -> tauri::Result<tauri::image::Image<'static>> {
    let img = tauri::image::Image::from_bytes(DEFAULT_TRAY_ICON)?;
    #[cfg(target_os = "windows")]
    if !taskbar_is_light() {
        let mut rgba = img.rgba().to_vec();
        for px in rgba.chunks_exact_mut(4) {
            px[0] = 255;
            px[1] = 255;
            px[2] = 255;
        }
        return Ok(tauri::image::Image::new_owned(rgba, img.width(), img.height()));
    }
    Ok(img.to_owned())
}

/// Windows 托盘 tooltip 的长度上限：128 个 UTF-16 字符，留 1 个给省略号
/// （裁剪只在 Windows 用得上，其他平台托盘 tooltip 没有长度限制）
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
const TOOLTIP_LIMIT: usize = 127;

/// 托盘 tooltip：Windows 限制 128 个 UTF-16 字符；多只股票分行显示
fn tray_tooltip(title: &str) -> String {
    if title.is_empty() {
        return "StockBar".into();
    }
    #[cfg(target_os = "windows")]
    {
        clip_tooltip(title, TOOLTIP_LIMIT)
    }
    #[cfg(not(target_os = "windows"))]
    {
        title.to_string()
    }
}

/// 按 UTF-16 单元截断一行文字（Windows 的 128 字符上限就是这么算的）
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn clip_utf16(s: &str, limit: usize) -> String {
    let mut out = String::new();
    for c in s.chars() {
        if out.encode_utf16().count() + c.len_utf16() > limit {
            break;
        }
        out.push(c);
    }
    out
}

/// 把「名称 价格 涨跌幅  │  名称 价格 涨跌幅 …」裁到 limit 个 UTF-16 单元以内。
/// 菜单栏放到 10 只之后 tooltip 一定装不下：整只放不下的直接丢掉（不留半只的残缺数字），
/// 末尾补一行省略号；连第一只自己都超长时只能截断这一行（也要留出省略号的位置）。
/// 纯函数，单测直接喂字符串，不必起托盘。
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn clip_tooltip(title: &str, limit: usize) -> String {
    const ELLIPSIS: &str = "\n…";
    let items: Vec<&str> = title.split("  │  ").filter(|s| !s.is_empty()).collect();
    let mut out = String::new();
    for (i, item) in items.iter().enumerate() {
        let line = if out.is_empty() { (*item).to_string() } else { format!("\n{item}") };
        // 后面还有几只：先给省略号留位置，免得补上它就超了
        let reserve = if i + 1 < items.len() { ELLIPSIS.encode_utf16().count() } else { 0 };
        if out.encode_utf16().count() + line.encode_utf16().count() + reserve <= limit {
            out.push_str(&line);
        } else if out.is_empty() {
            // 第一只自己就放不下（还要给省略号留位置）：截断这一行，后面的更放不下
            out = clip_utf16(item, limit.saturating_sub(reserve)).trim_end().to_string();
            if reserve > 0 {
                out.push_str(ELLIPSIS);
            }
            break;
        } else {
            out.push_str(ELLIPSIS);
            break;
        }
    }
    out
}

/// 单行模式：默认图标 + 图标右侧文字（macOS / Linux 支持；Windows 只显示 tooltip，文字交给悬浮行情条）
#[tauri::command]
fn set_tray_text(app: AppHandle, title: String) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("tray not found")?;
    tray.set_icon(Some(default_tray_icon().map_err(|e| e.to_string())?)).map_err(|e| e.to_string())?;
    let _ = tray.set_icon_as_template(true);
    let text = if title.is_empty() { None } else { Some(title.clone()) };
    let _ = tray.set_title(text);
    let _ = tray.set_tooltip(Some(tray_tooltip(&title)));
    Ok(())
}

/// 双行紧凑模式：前端用 canvas 画好的 PNG 直接作为托盘图标（仅 macOS 使用）。
/// macOS 会按菜单栏高度等比缩放，所以宽图可以放多只股票。
/// `template = true` 时只用 alpha 通道，系统自动适配深/浅色菜单栏。
#[tauri::command]
fn set_tray_image(app: AppHandle, png: Vec<u8>, template: bool, tooltip: String) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID).ok_or("tray not found")?;
    let icon = tauri::image::Image::from_bytes(&png).map_err(|e| e.to_string())?;
    tray.set_icon(Some(icon)).map_err(|e| e.to_string())?;
    let _ = tray.set_icon_as_template(template);
    let _ = tray.set_title(None::<String>);
    let _ = tray.set_tooltip(Some(tray_tooltip(&tooltip)));
    Ok(())
}

/// 系统深浅色切换后重新着色托盘图标（只有 Windows 需要）
#[cfg(target_os = "windows")]
fn refresh_tray_icon(app: &AppHandle) {
    if let (Some(tray), Ok(icon)) = (app.tray_by_id(TRAY_ID), default_tray_icon()) {
        let _ = tray.set_icon(Some(icon));
    }
}

// ---------- 托盘右键菜单 ----------
// 左键点图标弹小窗，右键出这个菜单（见 setup 里的 show_menu_on_left_click(false)）。
// 菜单里的「桌面悬浮行情条」改的是用户设置，而设置存在 localStorage 里、Rust 读不到，
// 所以这一项只发事件给主面板，勾选状态再由主面板用 set_tray_ticker 推回来。

/// 菜单里的「桌面悬浮行情条」勾选项：设置改过之后要跟着变，所以句柄留着。
/// 只有 Windows 会建这一项（其他平台一直是 None，set_tray_ticker 就成了空操作）。
static TRAY_TICKER_ITEM: LazyLock<Mutex<Option<CheckMenuItem<tauri::Wry>>>> =
    LazyLock::new(|| Mutex::new(None));

/// 托盘右键菜单：打开设置 / 桌面悬浮行情条（Windows）/ 退出
fn tray_menu(app: &AppHandle, ticker_on: bool) -> tauri::Result<Menu<tauri::Wry>> {
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "打开设置…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "退出 StockBar", true, None::<&str>)?;
    // 托盘放不下文字的平台（Windows）才用悬浮行情条顶替，其他平台没有这一项
    #[cfg(not(target_os = "windows"))]
    let _ = ticker_on;
    #[cfg(target_os = "windows")]
    let ticker = Some(CheckMenuItem::with_id(
        app,
        MENU_TICKER,
        "桌面悬浮行情条",
        true,
        ticker_on,
        None::<&str>,
    )?);
    #[cfg(not(target_os = "windows"))]
    let ticker: Option<CheckMenuItem<tauri::Wry>> = None;

    let mut items: Vec<&dyn IsMenuItem<tauri::Wry>> = vec![&settings];
    if let Some(item) = &ticker {
        if let Ok(mut slot) = TRAY_TICKER_ITEM.lock() {
            *slot = Some(item.clone());
        }
        items.push(item);
    }
    items.push(&quit);
    Menu::with_items(app, &items)
}

/// 主面板把「桌面悬浮行情条」的开关状态推过来：托盘菜单里的勾选项跟着变
#[tauri::command]
fn set_tray_ticker(on: bool) {
    if let Ok(slot) = TRAY_TICKER_ITEM.lock() {
        if let Some(item) = slot.as_ref() {
            let _ = item.set_checked(on);
        }
    }
}

// ---------- 设置窗口 ----------

/// 打开（或聚焦）独立的设置窗口：仪表盘 / 行情 / MCP / 关于 / 设置，类似 macOS 系统设置。
///
/// page 是希望直接打开的那一页（主面板发现新版本时会要求打开「关于」页）；不传就维持现状。
///
/// 必须是 async：Windows 上 WebView2 不会在事件回调里重入，而同步命令是跑在 IPC 回调里的，
/// 在里面创建 webview 会让 create_controller 永远等不到完成回调，整个应用就此卡死
/// （tauri 的 `WebviewWindowBuilder::new` Known issues 写着「在同步命令与事件处理器里
/// 建窗口会死锁，请改用 async 命令或独立线程」，即 wry#583）。async 命令跑在 tokio
/// 线程池上，窗口创建回到事件循环自己的派发里，不再嵌在 WebView2 回调中。
#[tauri::command]
async fn open_settings(app: AppHandle, page: Option<String>) -> Result<(), String> {
    open_settings_window(app, page)
}

/// 设置窗口里可用的页（与 prefs.ts 的 Page 一一对应）：不认识的页名一律忽略，免得切到空白页
const PAGES: [&str; 5] = ["dashboard", "market", "alerts", "mcp", "about"];

/// 窗口是新建的时候，「要打开哪一页」先存在这里：建窗时前端还没挂上监听，事件发出去会丢
static PENDING_PAGE: LazyLock<Mutex<Option<String>>> = LazyLock::new(|| Mutex::new(None));

/// 设置窗口的前端是否已经挂好监听（它载入完成后会调 settings_ready）。
/// 刚建好那会儿还是 false，这时只能把页名存起来等它来取 —— 直接发事件会丢
static SETTINGS_READY: AtomicBool = AtomicBool::new(false);

/// 设置窗口挂好监听后取「该打开哪一页」（取走即清空；没有就返回 null）
#[tauri::command]
fn settings_ready() -> Option<String> {
    SETTINGS_READY.store(true, Ordering::Relaxed);
    take_pending_page()
}

fn set_pending_page(page: Option<String>) {
    if let Ok(mut pending) = PENDING_PAGE.lock() {
        *pending = page;
    }
}

fn take_pending_page() -> Option<String> {
    PENDING_PAGE.lock().ok().and_then(|mut page| page.take())
}

/// open_settings 的本体（同步）：async 命令与单实例回调共用
fn open_settings_window(app: AppHandle, page: Option<String>) -> Result<(), String> {
    let page = page.filter(|p| PAGES.contains(&p.as_str()));
    if let Some(main) = app.get_webview_window(WINDOW_LABEL) {
        hide_panel(&main);
    }
    if let Some(page) = page {
        // 先记下来：前端还没挂上监听时事件会丢，由它载入后来取（见 settings_ready）
        set_pending_page(Some(page.clone()));
        if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
            if SETTINGS_READY.load(Ordering::Relaxed) {
                // 前端在监听：事件就够用了，别把页名留着（下次重建窗口会串页）
                set_pending_page(None);
                let _ = win.emit_to(SETTINGS_LABEL, "goto-page", page);
            }
        }
    }
    if let Some(win) = app.get_webview_window(SETTINGS_LABEL) {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
        return Ok(());
    }
    let builder = WebviewWindowBuilder::new(&app, SETTINGS_LABEL, WebviewUrl::App("settings.html".into()))
        .title("StockBar 设置")
        .inner_size(860.0, 600.0)
        .min_inner_size(720.0, 500.0)
        .center()
        .focused(true);
    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true)
        .traffic_light_position(tauri::LogicalPosition::new(18.0, 22.0));
    if let Err(e) = builder.build() {
        // 没建成就把页名清掉：留着的话，下次不带 page 打开会莫名落到这一页
        set_pending_page(None);
        return Err(e.to_string());
    }
    Ok(())
}

// ---------- 悬浮行情条（Windows） ----------

/// 点是否落在某个屏幕的工作区内（保存的位置可能来自已拔掉的副屏）
fn on_some_monitor(win: &WebviewWindow, x: i32, y: i32) -> bool {
    win.available_monitors()
        .map(|ms| {
            ms.iter().any(|m| {
                let wa = m.work_area();
                let (l, t) = (wa.position.x, wa.position.y);
                x >= l && y >= t && x < l + wa.size.width as i32 - 20 && y < t + wa.size.height as i32 - 10
            })
        })
        .unwrap_or(false)
}

/// 窗口完整留在所在屏幕工作区内（内容变宽后右侧不要跑出屏幕）
fn clamp_to_screen(win: &WebviewWindow) {
    let (Ok(pos), Ok(size)) = (win.outer_position(), win.outer_size()) else { return };
    let Ok(Some(m)) = win.monitor_from_point(pos.x as f64 + 1.0, pos.y as f64 + 1.0) else { return };
    let wa = m.work_area();
    let (l, t) = (wa.position.x, wa.position.y);
    let (r, b) = (l + wa.size.width as i32, t + wa.size.height as i32);
    let x = pos.x.min(r - size.width as i32).max(l);
    let y = pos.y.min(b - size.height as i32).max(t);
    if x != pos.x || y != pos.y {
        let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
    }
}

/// 显示 / 关闭悬浮行情条。x/y 为上次拖到的位置（物理像素），由前端保存。
///
/// async 的理由同 open_settings：这里会创建 webview 窗口，同步命令里做在 Windows 上会死锁。
#[tauri::command]
async fn set_ticker(app: AppHandle, show: bool, x: Option<i32>, y: Option<i32>) -> Result<(), String> {
    set_ticker_window(app, show, x, y)
}

/// set_ticker 的本体（同步）
fn set_ticker_window(app: AppHandle, show: bool, x: Option<i32>, y: Option<i32>) -> Result<(), String> {
    let existing = app.get_webview_window(TICKER_LABEL);
    if !show {
        if let Some(win) = existing {
            let _ = win.close();
        }
        return Ok(());
    }
    if let Some(win) = existing {
        let _ = win.show();
        return Ok(());
    }
    let win = WebviewWindowBuilder::new(&app, TICKER_LABEL, WebviewUrl::App("ticker.html".into()))
        .title("StockBar 行情条")
        .inner_size(200.0, 28.0)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .focused(false)
        .focusable(false) // 点它不抢焦点，主面板不会因此失焦收起
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    match (x, y) {
        (Some(x), Some(y)) if on_some_monitor(&win, x, y) => {
            let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
        }
        _ => default_ticker_position(&win),
    }
    let _ = win.show();
    Ok(())
}

/// 默认位置：主屏工作区右下角（紧贴任务栏上方）
fn default_ticker_position(win: &WebviewWindow) {
    #[cfg(not(target_os = "macos"))]
    place_near(win, None);
    #[cfg(target_os = "macos")]
    let _ = win.center();
}

/// 悬浮条按内容调整大小（逻辑像素）。
/// 菜单栏能放到 10 只，窄屏上内容可能比屏幕还宽：夹到工作区宽度以内，
/// 超出的部分被窗口裁掉，总好过整条跑到屏幕外（右边一截点不到、还夹在屏幕边上）。
#[tauri::command]
fn fit_ticker(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let win = app.get_webview_window(TICKER_LABEL).ok_or("ticker not found")?;
    let max_w = win
        .current_monitor()
        .ok()
        .flatten()
        .map(|m| m.work_area().size.width as f64 / m.scale_factor() - 16.0)
        .unwrap_or(width);
    win.set_size(tauri::LogicalSize::new(
        width.min(max_w).max(40.0),
        height.max(20.0),
    ))
    .map_err(|e| e.to_string())?;
    clamp_to_screen(&win);
    Ok(())
}

/// 单击悬浮条：在它旁边弹出 / 收起主面板
#[tauri::command]
fn ticker_click(app: AppHandle) {
    let anchor = app.get_webview_window(TICKER_LABEL).and_then(|t| {
        let (p, s) = (t.outer_position().ok()?, t.outer_size().ok()?);
        Some(Anchor(p.x as f64, p.y as f64, s.width as f64, s.height as f64))
    });
    toggle_panel(&app, anchor);
}

#[tauri::command]
fn hide_window(app: AppHandle) {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        hide_panel(&win);
    }
}

/// 点提醒通知后把主面板叫出来：位置与点托盘图标一致（不是切换 —— 面板已经开着就留在原处）
#[tauri::command]
fn open_panel(app: AppHandle) {
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        show_panel(&win, None);
    }
}

/// 发一条系统通知（提醒用）。
///
/// 实现在 src/notify.rs：macOS 走 UNUserNotificationCenter（插件走的 NSUserNotificationCenter
/// 在 macOS 26 上已经不弹了），Windows 走插件的 Toast。这里只把「发没发出去」的原因带回去 ——
/// 界面上的「发一条试试」靠它说真话。
///
/// 必须 async：macOS 那边要等系统授权（用户点弹窗）与投递回信，同步命令会卡住主线程。
#[tauri::command]
async fn notify_send(app: AppHandle, title: String, body: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || notify::send(&app, &title, &body))
        .await
        .map_err(|e| e.to_string())?
}

/// 打开系统的「通知」设置页：通知发不出去时，用户接下来要去的就那一页
#[tauri::command]
fn open_notification_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    let target = "x-apple.systempreferences:com.apple.Notifications-Settings.extension";
    #[cfg(target_os = "windows")]
    let target = "ms-settings:notifications";
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    let target = "settings://notifications";
    #[cfg(target_os = "windows")]
    let spawned = std::process::Command::new("cmd").args(["/C", "start", "", target]).spawn();
    #[cfg(not(target_os = "windows"))]
    let spawned = std::process::Command::new("open").arg(target).spawn();
    spawned.map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    app.exit(0);
}

// MCP 本地桥的两条命令：命令本体在 bridge.rs 里是普通函数，
// 放在这里是为了走 crate 根上的命令宏（子模块里定义还要额外处理宏路径）

/// 主面板注册好 MCP 监听后调用
#[tauri::command]
fn mcp_ready() {
    bridge::mark_ready();
}

/// 前端执行完一条 MCP 命令后回信
#[tauri::command]
fn mcp_reply(id: u64, payload: String) {
    bridge::reply(id, payload);
}

/// 设置面板的 MCP 卡片：桥状态（端口 / 就绪）与 MCP 服务脚本路径
#[tauri::command]
fn mcp_info(app: AppHandle) -> bridge::McpInfo {
    bridge::info(&app)
}

/// 设置面板的 MCP 开关：按设置开 / 关本地桥，返回开关之后的状态（一次往返就能刷新卡片）
#[tauri::command]
fn mcp_set_enabled(app: AppHandle, on: bool) -> bridge::McpInfo {
    bridge::set_enabled(&app, on);
    bridge::info(&app)
}


// ---------- 腾讯板块排行 ----------
// 命令壳在这里，本体在 qqrank.rs（理由同 MCP / 更新：子模块里定义命令宏路径难伺候）。
// 这条接口不返回 CORS 头，webview 里 fetch 读不到，只能由 Rust 侧代取。

/// 取一页腾讯板块排行（口径 hy / hy2 / gn / dy），原样回 JSON 文本
#[tauri::command]
async fn qq_board_rank(ftype: String, offset: u32) -> Result<String, String> {
    qqrank::page(ftype, offset).await
}

// ---------- WebDAV 备份 / 恢复 ----------
// 命令壳在这里，本体在 backup.rs（理由同上）。WebDAV 服务器基本不回 CORS 头，
// webview 里 fetch 过不了预检，所以 PUT / GET / OPTIONS 都由 Rust 侧代发。
// 密码的加密 / 解密也在这里 —— 明文不进 localStorage，密钥是 app data 目录里的随机文件。

/// 测试连接：OPTIONS 一次配置的目录，成功时回一句能看懂的结果
#[tauri::command]
async fn backup_test(url: String, user: String, pass: String) -> Result<String, String> {
    backup::test(url, user, pass).await
}

/// 上传一份备份（slot = backup 常规备份 / safety 恢复前的安全副本）
#[tauri::command]
async fn backup_upload(
    url: String,
    user: String,
    pass: String,
    slot: String,
    content: String,
) -> Result<(), String> {
    backup::upload(url, user, pass, slot, content).await
}

/// 下载一份备份，原样回文本（解析与校验由前端做，见 src/backup.ts）
#[tauri::command]
async fn backup_download(url: String, user: String, pass: String, slot: String) -> Result<String, String> {
    backup::download(url, user, pass, slot).await
}

/// 加密 WebDAV 密码：设置里只存这一串 `v1:…` 密文
#[tauri::command]
fn secret_encrypt(app: AppHandle, plain: String) -> Result<String, String> {
    backup::encrypt(&app, &plain)
}

/// 解密 WebDAV 密码（换过机器 / 密钥文件丢了会失败，界面据此提示重新输入）
#[tauri::command]
fn secret_decrypt(app: AppHandle, stored: String) -> Result<String, String> {
    backup::decrypt(&app, &stored)
}

// ---------- 版本更新 ----------
// 命令壳在这里，本体在 update.rs（理由同 MCP：子模块里定义命令宏路径难伺候）

/// 当前版本（「关于」页不联网就能显示）
#[tauri::command]
fn app_version() -> String {
    update::current_version()
}

/// 检查更新：有新版就报出版本号与更新说明，没有就是 available = false
#[tauri::command]
async fn update_check(app: AppHandle) -> Result<update::UpdateInfo, String> {
    update::check(&app).await
}

/// 下载并安装更新；进度通过 Channel 回传（Started → Progress → Finished）
#[tauri::command]
async fn update_install(on_event: tauri::ipc::Channel<update::DownloadEvent>) -> Result<(), String> {
    update::install(on_event).await
}

/// 装完重启：macOS / Linux 上新版本要重启才生效（Windows 由安装器负责重启）
#[tauri::command]
fn update_restart(app: AppHandle) {
    update::restart(&app);
}

/// 自动更新走不通时，去发布页自己下安装包
#[tauri::command]
fn open_release_page() -> Result<(), String> {
    update::open_release_page()
}
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // 单实例必须最先注册：重复启动时不再出现第二个托盘图标，而是打开设置窗口
        // 建窗口不能在这个回调里同步做：Windows 上它跑在单实例插件的窗口过程里，
        // 而创建 webview 有重入限制（见 open_settings 的注释）。交给独立线程，
        // 顺带让第二个实例的 WM_COPYDATA 立刻拿到回信、直接退出，不再干等。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let app = app.clone();
            std::thread::spawn(move || {
                let _ = open_settings_window(app, None);
            });
        }))
        .plugin(tauri_plugin_positioner::init())
        // 应用内更新：端点与公钥在 tauri.conf.json 的 plugins.updater 里（实现见 src/update.rs）
        .plugin(tauri_plugin_updater::Builder::new().build())
        // 系统通知（提醒触发时那条）：权限与投递都由插件管，前端只管发（见 src/notify.ts）
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            set_tray_text,
            set_tray_image,
            set_tray_ticker,
            open_settings,
            set_ticker,
            fit_ticker,
            ticker_click,
            hide_window,
            open_panel,
            notify_send,
            open_notification_settings,
            quit_app,
            mcp_ready,
            mcp_reply,
            mcp_info,
            mcp_set_enabled,
            qq_board_rank,
            backup_test,
            backup_upload,
            backup_download,
            secret_encrypt,
            secret_decrypt,
            app_version,
            update_check,
            update_install,
            update_restart,
            open_release_page,
            settings_ready
        ])
        .setup(|app| {
            // macOS：不在 Dock 显示，只做菜单栏应用
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Windows：无边框透明窗的系统阴影是直角矩形，和圆角面板不搭，改由 CSS 画；
            // CSS 四周各留 8px 画阴影，窗口相应放大，面板内容尺寸与 macOS 保持一致
            #[cfg(target_os = "windows")]
            if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
                let _ = win.set_shadow(false);
                let _ = win.set_size(tauri::LogicalSize::new(376.0, 576.0));
            }

           // 通知：macOS 上把 UNUserNotificationCenter 的 delegate 挂好（点击通知要能回到主面板），
           // 顺带让应用在「系统设置 › 通知」里建出条目；Windows 侧是空操作。见 src/notify.rs
           notify::init(app.handle());

            // MCP 本地桥不在这里起：开关是用户设置（存在 localStorage 里，Rust 读不到），
            // 由主面板启动后按设置调 mcp_set_enabled 打开或保持关闭。见 bridge.rs 的 set_enabled()。

            // 托盘右键菜单：打开设置 / 桌面悬浮行情条（Windows）/ 退出。
            // 勾选状态先按「关」建，主面板起来后会按设置推一次真实状态过来
            let menu = tray_menu(app.handle(), false)?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(default_tray_icon()?)
                .icon_as_template(true)
                .tooltip("StockBar")
                .menu(&menu)
                .show_menu_on_left_click(false) // 左键弹小窗，右键出菜单
                .on_menu_event(|app, event| match event.id.as_ref() {
                    MENU_SETTINGS => {
                        // 建窗口不能在这个回调里同步做：Windows 上会死锁（见 open_settings 的注释）
                        let app = app.clone();
                        std::thread::spawn(move || {
                            let _ = open_settings_window(app, None);
                        });
                    }
                    // 悬浮行情条改的是用户设置（存在 localStorage 里，Rust 读不到）：
                    // 交给主面板翻开关，它改完再调 set_tray_ticker 把勾选状态推回来
                    MENU_TICKER => {
                        let _ = app.emit_to(WINDOW_LABEL, "tray-menu", "ticker");
                    }
                    MENU_QUIT => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // positioner 需要记录托盘图标位置（macOS 用）
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
                    #[cfg(not(target_os = "macos"))]
                    match &event {
                        TrayIconEvent::Click { rect, .. }
                        | TrayIconEvent::Enter { rect, .. }
                        | TrayIconEvent::Move { rect, .. } => remember_tray_rect(rect),
                        _ => {}
                    }
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        toggle_panel(tray.app_handle(), None);
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // 点击小窗外部（失焦）自动收起，和系统菜单栏弹窗行为一致
            WindowEvent::Focused(false) if window.label() == WINDOW_LABEL => {
                LAST_HIDDEN_MS.store(now_ms(), Ordering::Relaxed);
                let _ = window.hide();
            }
            // 设置窗口被关掉了：下次是重新载入的前端，监听还没挂上（见 open_settings_window）
            WindowEvent::Destroyed if window.label() == SETTINGS_LABEL => {
                SETTINGS_READY.store(false, Ordering::Relaxed);
            }
            // Windows 切换深浅色 → 托盘图标跟着换色
            #[cfg(target_os = "windows")]
            WindowEvent::ThemeChanged(_) if window.label() == WINDOW_LABEL => {
                refresh_tray_icon(window.app_handle());
            }
            _ => {}
        })
        .build(tauri::generate_context!())
        .expect("启动 StockBar 失败");
    // 退出前删掉 MCP 连接信息文件，免得外部客户端照着过期端口乱撞
    app.run(|_, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            bridge::shutdown();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 用户那台机器的主屏：2304×1296 点 @2x、菜单栏 81 点 → 物理工作区 (0, 162) ~ (4608, 2540)
    #[cfg(target_os = "macos")]
    const WORK: (f64, f64, f64, f64) = (0.0, 162.0, 4608.0, 2540.0);
    #[cfg(target_os = "macos")]
    const SIZE: (f64, f64) = (720.0, 1120.0);
    #[cfg(target_os = "macos")]
    const GAP: f64 = 12.0;

    #[test]
    #[cfg(target_os = "macos")]
    fn 面板跟在鼠标下方并夹进工作区() {
        // 鼠标停在菜单栏图标上：面板水平居中在它下面，上沿贴菜单栏下沿再加间距
        assert_eq!(panel_position(Some((2969.0, 100.0)), WORK, SIZE, GAP), (2609.0, 174.0));
        // 鼠标贴左 / 贴右：都不会跑出工作区
        assert_eq!(panel_position(Some((10.0, 100.0)), WORK, SIZE, GAP), (12.0, 174.0));
        assert_eq!(panel_position(Some((4600.0, 100.0)), WORK, SIZE, GAP), (3876.0, 174.0));
        // positioner 那种离谱坐标（整块跑到屏幕右边外面）会被夹回来
        assert_eq!(panel_position(Some((5938.0, 100.0)), WORK, SIZE, GAP), (3876.0, 174.0));
        // 拿不到鼠标位置：贴右边
        assert_eq!(panel_position(None, WORK, SIZE, GAP), (3876.0, 174.0));
        // 面板比工作区还高：至少顶在工作区上沿，别把标题栏顶到屏幕外
        assert_eq!(panel_position(Some((1000.0, 100.0)), WORK, (720.0, 3000.0), GAP).1, 174.0);
    }

    #[test]
    fn 页名白名单只放行认识的页() {
        for page in ["dashboard", "market", "alerts", "mcp", "about"] {
            assert!(PAGES.contains(&page), "{page} 应该在白名单里");
        }
        assert!(!PAGES.contains(&"nope"));
        // 「设置」页已经并进「仪表盘」：老链接带 #settings 会被挡下，前端回落到第一页
        assert!(!PAGES.contains(&"settings"));
    }

    #[test]
    fn 待打开的页取一次就清空() {
        set_pending_page(Some("about".into()));
        assert_eq!(take_pending_page().as_deref(), Some("about"));
        // 取走即清空：不然下次窗口重建会莫名串到这一页
        assert_eq!(take_pending_page(), None);
    }

    /// 菜单栏能放到 10 只，Windows 的 tooltip 一定装不下：按整只裁剪，别留半只的残缺数字
    #[test]
    fn tooltip_按整只裁剪并补省略号() {
        let a = "上证 3800.86 +1.23%";
        let b = "深证 12000.00 -0.50%";
        let c = "创业板 2500.00 +0.10%";
        let title = format!("{a}  │  {b}  │  {c}");
        // 放得下：一只一行，原样显示
        assert_eq!(clip_tooltip(&title, 200), format!("{a}\n{b}\n{c}"));
        // 只放得下前两只：第三只整只丢掉，末尾补一行省略号，且不超上限
        let limit = format!("{a}\n{b}").encode_utf16().count() + 2;
        assert_eq!(clip_tooltip(&title, limit), format!("{a}\n{b}\n…"));
        assert!(clip_tooltip(&title, limit).encode_utf16().count() <= limit);
        // 第一只自己就放不下（后面还有别的）：截断这一行 + 省略号，仍然不超上限
        assert_eq!(clip_tooltip(&format!("{a}  │  {b}"), 5), "上证\n…");
        // 只有一只时没有省略号的位置，直接截断
        assert_eq!(clip_tooltip(a, 5), "上证 38");
        // 空标题不该产出空 tooltip
        assert_eq!(tray_tooltip(""), "StockBar");
    }
}
