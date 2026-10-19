// 提醒的判定接线：真起一遍 main.ts，喂一轮报价，看条件成立时有没有把「已触发」落进状态里。
// 纯逻辑（判定、冷却、重新武装）在 alerts.test.ts 里测，这里只管主面板那一根线还通不通。
//
// 通知本身在浏览器里是空操作（notify.ts 的 IN_TAURI 判断），所以这里看的是状态存储 ——
// 状态写下去了，就说明「刷新 → 判定 → 决定发不发」这条链路走完了。
// 单独一个文件：它要一张干净的模块表（main.test.ts 跑过十几个用例之后，旧实例的定时器还活着）。
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Quote } from "./api";

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** 这一轮报价的回复（每个用例自己填）；交易时段开关用来验「非盘中不判」 */
let quoteReply = new Map<string, Quote>();
let sessionOpen = true;

vi.mock("./api", async (orig) => {
  const actual = await orig<typeof import("./api")>();
  return {
    ...actual,
    searchStocks: vi.fn(async () => []),
    fetchQuotes: vi.fn(async () => quoteReply),
    // 真正实现要看时钟，用例里跟着开关走
    sessionStatus: vi.fn(() => ({ open: sessionOpen, text: sessionOpen ? "交易中" : "已收盘" })),
    fetchTrend: vi.fn(async () => ({
      secid: "1.600519",
      name: "贵州茅台",
      preClose: 1700,
      total: 241,
      points: [],
      amount: null,
      prevAmount: null,
      prevDate: null,
    })),
    fetchMarketAmount: vi.fn(async () => null),
    fetchBoards: vi.fn(async () => []),
  };
});

/** 起一个只带 #app 的页面（与 index.html 一致），先写一份设置 */
async function boot(settings: Record<string, unknown> = {}) {
  vi.resetModules();
  localStorage.clear();
  quoteReply = new Map();
  sessionOpen = true;
  localStorage.setItem(
    "stockbar.settings.v1",
    JSON.stringify({ watchlist: ["1.600519"], selected: "1.600519", bar: [], ...settings }),
  );
  document.body.innerHTML = '<div id="app" class="panel"></div>';
  vi.useFakeTimers();
  await import("./main");
  await vi.advanceTimersByTimeAsync(0);
}

/** 起一遍主面板，再让它按设置重拉一轮报价（storage 事件 = 设置变了一条，是主面板自己认的那条路） */
async function withQuotes(settings: Record<string, unknown>, q: Map<string, Quote>) {
  await boot(settings);
  quoteReply = q;
  window.dispatchEvent(new StorageEvent("storage", { key: "stockbar.settings.v1" }));
  await vi.advanceTimersByTimeAsync(0);
}

/** 一只已经跌破阈值的自选（time 固定，交易日键跟着它走） */
const crossed = () =>
  new Map<string, Quote>([
    [
      "1.600519",
      {
        secid: "1.600519",
        code: "600519",
        market: 1,
        name: "贵州茅台",
        price: 1400,
        change: -100,
        pct: -6.7,
        time: Date.UTC(2026, 9, 13, 2, 0) / 1000,
        amount: null,
      },
    ],
  ]);

/** 「跌破 1500」 */
const rule = { id: "a1", secid: "1.600519", kind: "price", op: "below", value: 1500, enabled: true };
const states = () => JSON.parse(localStorage.getItem("stockbar.alerts.state.v1") ?? "null");
const priceOf = (id: string) =>
  document.querySelector<HTMLElement>(`#list .row[data-id="${id}"] .row-price`)?.textContent;

describe("主面板：提醒的判定接线", () => {
  it("条件刚成立：状态里记下已触发（通知在这条路径的尽头，浏览器里是空操作）", async () => {
    await withQuotes({ alerts: [rule] }, crossed());
    // 先在界面上确认这一轮的报价真到了（否则「没触发」可能只是没数据）
    expect(priceOf("1.600519")).toBe("1400.00");
    expect(states().a1).toMatchObject({ fired: true });
  });

  it("总开关关掉：一条都不判，状态不落盘", async () => {
    await withQuotes({ alerts: [rule], alertsOn: false }, crossed());
    expect(priceOf("1.600519")).toBe("1400.00");
    expect(states()).toBeNull();
  });

  it("非交易时段不判：收盘后价格不再动，凭残留的最后一笔成交触发没有意义", async () => {
    await boot({ alerts: [rule] });
    quoteReply = crossed();
    sessionOpen = false;
    window.dispatchEvent(new StorageEvent("storage", { key: "stockbar.settings.v1" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(priceOf("1.600519")).toBe("1400.00");
    expect(states()).toBeNull();
  });

  it("价格回到阈值之上：状态改回「没触发」，下次再跌破才重新通知", async () => {
    await withQuotes({ alerts: [rule] }, crossed());
    expect(states().a1?.fired).toBe(true);
    // 同一交易日里价格回到 1600：重新武装（状态还在，只是 fired 变回 false）
    quoteReply = new Map<string, Quote>([
      [
        "1.600519",
        {
          secid: "1.600519",
          code: "600519",
          market: 1,
          name: "贵州茅台",
          price: 1600,
          change: 100,
          pct: 6.7,
          time: Date.UTC(2026, 9, 13, 3, 0) / 1000,
          amount: null,
        },
      ],
    ]);
    window.dispatchEvent(new StorageEvent("storage", { key: "stockbar.settings.v1" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(states().a1?.fired).toBe(false);
  });
});
