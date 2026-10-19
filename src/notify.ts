// 系统通知（macOS 通知中心 / Windows 通知）。浏览器里 `pnpm dev` 预览时全部降级为空操作。
//
// 两点与插件行为有关，别当成多余：① 桌面上只有挂过 onAction 监听的窗口才能收到点击，
// 所以主面板一起床就挂（见 main.ts）；② 没有授权的通知会被系统直接丢掉，发之前先问一句。

import { IN_TAURI } from "./tauri";

/** 当前是否已授权（不弹系统窗） */
export async function notifyGranted(): Promise<boolean> {
  if (!IN_TAURI) return false;
  const m = await import("@tauri-apps/plugin-notification");
  return m.isPermissionGranted().catch(() => false);
}

/** 请求授权：第一次会弹系统窗；返回是否已经可以发通知 */
export async function requestNotify(): Promise<boolean> {
  if (!IN_TAURI) return false;
  const m = await import("@tauri-apps/plugin-notification");
  return m.requestPermission().then((s) => s === "granted", () => false);
}

/**
 * 发一条通知。没授权就什么都不做并返回 false —— 调用方据此决定要不要提示用户去授权，
 * 而不是让一条通知静默消失。
 */
export async function sendNotify(title: string, body: string, id?: number): Promise<boolean> {
  if (!IN_TAURI) return false;
  const m = await import("@tauri-apps/plugin-notification");
  if (!(await notifyGranted())) return false;
  try {
    m.sendNotification({ title, body, id });
    return true;
  } catch {
    return false;
  }
}

/** 监听「点了通知」：回调带上通知编号（平台没报就传 null） */
export async function onNotifyTap(fn: (id: number | null) => void): Promise<void> {
  if (!IN_TAURI) return;
  const m = await import("@tauri-apps/plugin-notification");
  await m
    .onAction((e) => {
      // 桌面上点通知本身报的是 "tap"；自定义按钮（第一版没做）另有 actionId
      if (e.actionId !== "tap") return;
      fn(e.notification?.id ?? null);
    })
    .catch(() => {});
}
