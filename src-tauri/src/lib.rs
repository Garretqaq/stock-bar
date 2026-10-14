use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
#[cfg(target_os = "macos")]
use tauri_plugin_positioner::{Position, WindowExt};

mod bridge;

const TRAY_ID: &str = "main";
const WINDOW_LABEL: &str = "main";
const SETTINGS_LABEL: &str = "settings";
/// Windows 悬浮行情条（托盘不能显示文字时的替代）
const TICKER_LABEL: &str = "ticker";

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

fn show_panel(win: &WebviewWindow, anchor: Option<Anchor>) {
    // macOS 菜单栏在顶部：窗口挂在图标正下方
    #[cfg(target_os = "macos")]
    {
        let _ = anchor;
        let _ = win.move_window(Position::TrayBottomCenter);
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

/// 托盘 tooltip：Windows 限制 128 个 UTF-16 字符；多只股票分行显示
fn tray_tooltip(title: &str) -> String {
    if title.is_empty() {
        return "StockBar".into();
    }
    #[cfg(target_os = "windows")]
    {
        let s = title.replace("  │  ", "\n");
        let mut out = String::new();
        for c in s.chars() {
            if out.encode_utf16().count() + c.len_utf16() > 127 {
                break;
            }
            out.push(c);
        }
        out
    }
    #[cfg(not(target_os = "windows"))]
    {
        title.to_string()
    }
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

// ---------- 设置窗口 ----------

/// 打开（或聚焦）独立的设置窗口：仪表盘 + 设置，类似 macOS 系统设置
#[tauri::command]
fn open_settings(app: AppHandle) -> Result<(), String> {
    if let Some(main) = app.get_webview_window(WINDOW_LABEL) {
        hide_panel(&main);
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
    builder.build().map_err(|e| e.to_string())?;
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
#[tauri::command]
fn set_ticker(app: AppHandle, show: bool, x: Option<i32>, y: Option<i32>) -> Result<(), String> {
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

/// 悬浮条按内容调整大小（逻辑像素）
#[tauri::command]
fn fit_ticker(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    let win = app.get_webview_window(TICKER_LABEL).ok_or("ticker not found")?;
    win.set_size(tauri::LogicalSize::new(width.max(40.0), height.max(20.0)))
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // 单实例必须最先注册：重复启动时不再出现第二个托盘图标，而是打开设置窗口
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = open_settings(app.clone());
        }))
        .plugin(tauri_plugin_positioner::init())
        .invoke_handler(tauri::generate_handler![
            set_tray_text,
            set_tray_image,
            open_settings,
            set_ticker,
            fit_ticker,
            ticker_click,
            hide_window,
            quit_app,
            mcp_ready,
            mcp_reply
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

            // MCP 本地桥：外部客户端改自选/分组的入口（命令仍由前端执行）
            bridge::start(app.handle().clone());

            let quit = MenuItem::with_id(app, "quit", "退出 StockBar", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit])?;

            TrayIconBuilder::with_id(TRAY_ID)
                .icon(default_tray_icon()?)
                .icon_as_template(true)
                .tooltip("StockBar")
                .menu(&menu)
                .show_menu_on_left_click(false) // 左键弹小窗，右键出菜单
                .on_menu_event(|app, event| {
                    if event.id.as_ref() == "quit" {
                        app.exit(0);
                    }
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
