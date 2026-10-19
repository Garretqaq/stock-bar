// 系统通知（macOS 通知中心 / Windows Toast）。浏览器里 `pnpm dev` 预览时全部降级为空操作。
//
// 为什么不用插件的 JS API：桌面端 `sendNotification()` 的实现就是 `new window.Notification(...)`，
// 而 macOS 的 WKWebView 不实现 Web 通知 —— `Notification.permission` 还恒报 granted
// （界面显示「已授权」却一条都收不到）。投递因此走 Rust 侧的 `notify_send`（见 src-tauri/src/notify.rs）：
// macOS 用 UNUserNotificationCenter，把「发没发出去」的原因带回来；Windows 用插件的 Toast。
import { IN_TAURI, call, callOrThrow, listenAll } from "./tauri";

export interface NotifyResult {
  ok: boolean;
  /** 没发出去时的原因（系统拒绝、应用没被允许等），直接显示给用户 */
  error?: string;
}

/** 发一条系统通知；不抛异常，失败原因放在返回值里 */
export async function sendNotify(title: string, body: string): Promise<NotifyResult> {
  if (!IN_TAURI) return { ok: false, error: "浏览器预览没有系统通知" };
  try {
    await callOrThrow("notify_send", { title, body });
    return { ok: true };
  } catch (e) {
    const s = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    return { ok: false, error: s.trim() || "系统拒绝了这条通知" };
  }
}

/** 打开系统的「通知」设置页：通知发不出去时，用户接下来要去的就是那一页 */
export async function openNotifySettings(): Promise<void> {
  await call("open_notification_settings");
}

/**
 * 监听「点了通知」：回调带上通知标题。
 *
 * macOS 侧是我们自己的 delegate 发出来的 Tauri 事件（`notify-tapped`，见 src-tauri/src/notify.rs），
 * 通知本身没有编号可用，标题里已经带着标的与条件（见 alerts.ts 的 alertText），
 * 调用方按标题认标的即可。
 */
export async function onNotifyTap(fn: (title: string | null) => void): Promise<void> {
  if (!IN_TAURI) return;
  await listenAll<string | null>("notify-tapped", (title) => fn(title ?? null));
}
