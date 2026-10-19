//! 系统通知（提醒触发时那一条，另加设置页的「发一条试试」）。
//!
//! macOS 上这里不走插件那条路。tauri-plugin-notification 在 macOS 侧是
//! notify-rust → mac-notification-sys → `NSUserNotificationCenter`（自 macOS 11 起废弃），
//! 在 macOS 26 上它只剩「静默进通知中心历史」：usernoted 日志里
//! `Delivering ... to [.alert ...]` 有，`Presenting ... as alert` 一次都没有，应用也不会出现在
//! 「系统设置 › 通知」的列表里（`defaults read com.apple.ncprefs` 里根本没有
//! com.stockbar.eastmoney）—— 用户一条都看不到，插件却照样报成功。所以 macOS 自己写：
//! `UNUserNotificationCenter` + `requestAuthorization`，投递失败把原因原样带回去。
//!
//! Windows / Linux 继续用插件（Toast / DBus），那边是好的。

use tauri::AppHandle;

/// 点了通知之后发给前端的事件名（前端在 src/notify.ts 里监听）
pub const TAP_EVENT: &str = "notify-tapped";

/// 启动时调一次：登记点击回调，让应用在「系统设置 › 通知」里有个条目。
/// 非 macOS 是空操作（插件自己管）。
pub fn init(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    {
        // tauri dev 跑的是没打包的裸二进制：那种进程没有通知身份，碰
        // UNUserNotificationCenter 会抛 objc 异常直接崩，所以只在 .app 里装 delegate
        if mac::bundled() {
            mac::remember_app(app);
            mac::setup();
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// 发一条通知；失败原因（系统拒绝、用户没允许等）原样回给界面
pub fn send(app: &AppHandle, title: &str, body: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let _ = app;
        if !mac::bundled() {
            return Err("`tauri dev` 跑的是没打包的二进制，系统不认它的通知身份 —— 装成 .app 再试".into());
        }
        mac::send(title, body)
    }
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use std::ptr::NonNull;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::mpsc;
    use std::sync::{Once, OnceLock};
    use std::time::Duration;

    use block2::{DynBlock, RcBlock};
    use objc2::rc::Retained;
    use objc2::runtime::{Bool, ProtocolObject};
    use objc2::{define_class, msg_send, ClassType};
    use objc2_foundation::{NSError, NSObject, NSObjectProtocol, NSString};
    use objc2_user_notifications::{
        UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
        UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
        UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
        UNUserNotificationCenterDelegate,
    };
    use tauri::{AppHandle, Emitter};

    use super::TAP_EVENT;

    /// 点击回调在任意线程触发，AppHandle 拿出来发事件用
    static APP: OnceLock<AppHandle> = OnceLock::new();

    pub fn remember_app(app: &AppHandle) {
        let _ = APP.set(app.clone());
    }

    define_class!(
        // SAFETY: NSObject 没有子类约束，这个类也不实现 Drop
        #[unsafe(super(NSObject))]
        // 类名要全进程唯一，别改成容易和别的 crate 撞的通用名字
        #[name = "StockBarNotificationCenterDelegate"]
        struct CenterDelegate;

        // SAFETY: NSObjectProtocol 没有安全要求
        unsafe impl NSObjectProtocol for CenterDelegate {}

        // SAFETY: 两个方法的签名与 UNUserNotificationCenterDelegate 一致
        unsafe impl UNUserNotificationCenterDelegate for CenterDelegate {
            #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
            fn will_present(
                &self,
                _center: &UNUserNotificationCenter,
                _notification: &UNNotification,
                completion_handler: &DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
            ) {
                // 应用在最前面时（比如用户正开着设置窗口点「发一条试试」）系统默认什么都不弹，
                // 这里明确要横幅 + 列表 + 声音，否则界面上看着还是「没反应」
                completion_handler.call((
                    UNNotificationPresentationOptions::Banner
                        | UNNotificationPresentationOptions::List
                        | UNNotificationPresentationOptions::Sound,
                ));
            }

            #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
            fn did_receive(
                &self,
                _center: &UNUserNotificationCenter,
                response: &UNNotificationResponse,
                completion_handler: &DynBlock<dyn Fn()>,
            ) {
                // 通知没有编号，靠标题认标的（标题里带着标的与条件，见 src/alerts.ts）
                let title = response.notification().request().content().title().to_string();
                if let Some(app) = APP.get() {
                    let _ = app.emit(TAP_EVENT, title);
                }
                completion_handler.call(());
            }
        }
    );

    /// 进程是不是跑在 .app 里 —— UNUserNotificationCenter 只认有 bundle 的进程
    /// （`tauri dev` 的裸二进制在 currentNotificationCenter 上会抛异常）
    pub fn bundled() -> bool {
        std::env::current_exe()
            .map(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"))
            .unwrap_or(false)
    }

    static SETUP: Once = Once::new();

    /// 装好 delegate（只做一次）。setDelegate 拿的是弱引用，所以 delegate 要泄漏到进程结束 ——
    /// 一只空对象，代价可以接受。
    pub fn setup() {
        SETUP.call_once(|| {
            let center = UNUserNotificationCenter::currentNotificationCenter();
            let delegate: Retained<CenterDelegate> = unsafe { msg_send![CenterDelegate::class(), new] };
            center.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
            std::mem::forget(delegate);
        });
    }

    /// 读当前的授权状态；读不到（回信超时）给 None，调用方别因此拦下通知
    fn status() -> Option<UNAuthorizationStatus> {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |settings: NonNull<UNNotificationSettings>| {
            let _ = tx.send(unsafe { settings.as_ref() }.authorizationStatus());
        });
        center.getNotificationSettingsWithCompletionHandler(&block);
        rx.recv_timeout(Duration::from_secs(3)).ok()
    }

    /// 请求授权（已经决定过的话系统立刻回现状，不会再弹窗）。
    /// 用户点弹窗要时间，所以等满 120 秒 —— 调用方在阻塞线程上（见 lib.rs 的 notify_send）。
    fn authorize() -> Result<bool, String> {
        let center = UNUserNotificationCenter::currentNotificationCenter();
        let (tx, rx) = mpsc::channel();
        let block = RcBlock::new(move |granted: Bool, _error: *mut NSError| {
            let _ = tx.send(granted.as_bool());
        });
        center.requestAuthorizationWithOptions_completionHandler(
            UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge,
            &block,
        );
        rx.recv_timeout(Duration::from_secs(120))
            .map_err(|_| "等系统授权的结果超时了（弹窗还在的话点一下「允许」再试一次）".to_string())
    }

    pub fn send(title: &str, body: &str) -> Result<(), String> {
        setup();
        match status() {
            Some(s)
                if s == UNAuthorizationStatus::Authorized
                    || s == UNAuthorizationStatus::Provisional
                    || s == UNAuthorizationStatus::Ephemeral => {}
            Some(s) if s == UNAuthorizationStatus::Denied => {
                return Err("系统没有允许 StockBar 发通知 —— 去「打开通知设置」里打开 StockBar 的通知".into())
            }
            // 第一次用（或读不到状态）：先要授权，用户点了「允许」再发
            _ => {
                if !authorize()? {
                    return Err("你还没允许 StockBar 发送通知 —— 去「打开通知设置」里打开".into());
                }
            }
        }
        push(title, body)
    }

    /// 真正投递一条，并等系统的回信（失败原因就在这）
    fn push(title: &str, body: &str) -> Result<(), String> {
        static SEQ: AtomicU64 = AtomicU64::new(0);
        let center = UNUserNotificationCenter::currentNotificationCenter();

        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(title));
        content.setBody(&NSString::from_str(body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));

        let ident = NSString::from_str(&format!(
            "stockbar-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let request = UNNotificationRequest::requestWithIdentifier_content_trigger(&ident, &content, None);

        let (tx, rx) = mpsc::channel::<Option<String>>();
        let block = RcBlock::new(move |error: *mut NSError| {
            let message = if error.is_null() {
                None
            } else {
                Some(unsafe { error.as_ref() }.map(|e| e.localizedDescription().to_string()))
            };
            let _ = tx.send(message.flatten());
        });
        center.addNotificationRequest_withCompletionHandler(&request, Some(&block));

        match rx.recv_timeout(Duration::from_secs(5)) {
            Ok(None) => Ok(()),
            Ok(Some(e)) => Err(e),
            // 系统没回信：多半已经进队列了，别谎报失败
            Err(_) => Ok(()),
        }
    }
}
