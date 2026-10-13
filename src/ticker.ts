// Windows 悬浮行情条（label="ticker"）：托盘不能显示文字，用一个置顶小条代替菜单栏行情。
// 自己拉行情（窗口常驻可见，不受隐藏窗口定时器节流影响），显隐由主面板通过 set_ticker 控制。

import { fetchQuotes, type Quote } from "./api";
import { barText, tickerClass, tickerHtml } from "./bar";
import { applyAppearance, loadSettings, onSettingsChange, saveTickerPos, type Settings } from "./settings";
import { IN_TAURI, call } from "./tauri";

let S: Settings = loadSettings();
const quotes = new Map<string, Quote>();
let timer: number | undefined;
const box = document.getElementById("ticker")!;

function render(): void {
  applyAppearance(S);
  box.className = `ticker ${tickerClass(S)}`;
  box.innerHTML = tickerHtml(S, quotes);
  box.title = barText(S, quotes).replaceAll("  │  ", "\n");
  fit();
}

/** 窗口尺寸跟随内容 */
let lastSize = "";
function fit(): void {
  requestAnimationFrame(() => {
    const r = box.getBoundingClientRect();
    const width = Math.ceil(r.width);
    const height = Math.ceil(r.height);
    const sig = `${width}x${height}`;
    if (!width || sig === lastSize) return;
    lastSize = sig;
    void call("fit_ticker", { width, height });
  });
}

async function refresh(): Promise<void> {
  if (!S.bar.length) return render();
  try {
    const got = await fetchQuotes(S.bar);
    got.forEach((q, k) => quotes.set(k, q));
  } catch {
    /* 网络失败保留上一次数据 */
  }
  render();
}

function schedule(): void {
  window.clearInterval(timer);
  timer = window.setInterval(refresh, S.interval * 1000);
}

// ---------- 拖动 / 单击 ----------
// 不用 data-tauri-drag-region：它会吞掉 click，且双击会触发最大化。
// 按下后移动超过 4px 才开始拖动，否则视为单击 → 弹出/收起主面板。

let down: { x: number; y: number } | null = null;
box.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  down = { x: e.screenX, y: e.screenY };
});
box.addEventListener("pointermove", async (e) => {
  if (!down || Math.hypot(e.screenX - down.x, e.screenY - down.y) < 4) return;
  down = null;
  if (!IN_TAURI) return;
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  await getCurrentWindow().startDragging().catch(() => {});
});
box.addEventListener("pointerup", (e) => {
  if (!down || e.button !== 0) return;
  down = null;
  void call("ticker_click");
});
document.addEventListener("contextmenu", (e) => e.preventDefault());

if (IN_TAURI) {
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
    let t: number | undefined;
    void getCurrentWindow().onMoved(({ payload }) => {
      window.clearTimeout(t);
      t = window.setTimeout(() => saveTickerPos(payload.x, payload.y), 300);
    });
  });
}

// ---------- 同步 ----------

onSettingsChange((next) => {
  const intervalChanged = next.interval !== S.interval;
  const barChanged = next.bar.join() !== S.bar.join();
  S = next;
  render();
  if (intervalChanged) schedule();
  if (barChanged) void refresh();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);

render();
void refresh();
schedule();
