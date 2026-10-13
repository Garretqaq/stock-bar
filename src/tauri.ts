// Tauri 桥接：在普通浏览器里 `pnpm dev` 预览时自动降级为空操作

export const IN_TAURI = "__TAURI_INTERNALS__" in window;

/** Windows（WebView2）：托盘不能显示文字，改用悬浮行情条；标题栏、字体等也走 Windows 样式 */
// 开发时可在浏览器地址后加 ?win 预览 Windows 布局（仅 pnpm dev 生效）
export const IS_WIN =
  /Windows/i.test(navigator.userAgent) || (import.meta.env.DEV && new URLSearchParams(location.search).has("win"));

/** canvas 用的系统字体栈（CSS 里的 font-family 与之保持一致） */
export const UI_FONT = `-apple-system, BlinkMacSystemFont, "PingFang SC", "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`;

export async function call<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T | undefined> {
  if (!IN_TAURI) return undefined;
  const { invoke } = await import("@tauri-apps/api/core");
  try {
    return await invoke<T>(cmd, args);
  } catch (e) {
    console.warn(`[tauri] ${cmd} 调用失败:`, e);
    return undefined;
  }
}

/** 广播给所有窗口（含自己） */
export async function emitAll(event: string, payload?: unknown): Promise<void> {
  if (!IN_TAURI) return;
  const { emit } = await import("@tauri-apps/api/event");
  await emit(event, payload).catch(() => {});
}

export async function listenAll<T>(event: string, fn: (payload: T) => void): Promise<void> {
  if (!IN_TAURI) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<T>(event, (e) => fn(e.payload));
}
