// 主面板自选行「置顶」的流程测试：真起一遍 main.ts，用假报价 / 搜索 / 分时喂数据。
// 纯逻辑（pinItem / unpinItem / pinCount / clampBlock）在 settings.test.ts 里测，这里只管界面接线：
// 行右键菜单能不能置顶 / 取消置顶，置顶区有没有和普通自选区分开。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 每个用例都重新 import 一遍 main.ts（模块级会挂监听 / 起定时器），跑完清掉假的定时器，
// 免得后面用例拿到上一个用例残留的 interval
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// 搜索走 JSONP（真浏览器里插 script），报价与分时都要联网，happy-dom 里全换成固定结果
vi.mock("./api", async (orig) => {
  const actual = await orig<typeof import("./api")>();
  return {
    ...actual,
    searchStocks: vi.fn(async () => []),
    fetchQuotes: vi.fn(async () => new Map()),
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
  };
});

/** 起一个只带 #app 的页面（与 index.html 一致），并先写一份设置 */
async function boot(settings: Record<string, unknown> = {}) {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem(
    "stockbar.settings.v1",
    JSON.stringify({
      watchlist: ["1.600519", "0.300750", "116.00700"],
      selected: "1.600519",
      bar: [],
      ...settings,
    }),
  );
  document.body.innerHTML = '<div id="app" class="panel"></div>';
  vi.useFakeTimers();
  await import("./main");
  // 让启动时那次 refresh() 落地（假报价是空 Map，这里只为走完 renderAll）
  await vi.advanceTimersByTimeAsync(0);
}

const saved = () => JSON.parse(localStorage.getItem("stockbar.settings.v1")!);
const rows = () => [...document.querySelectorAll<HTMLElement>("#list .row")];
const rowOf = (id: string) => rows().find((r) => r.dataset.id === id)!;
const menuLabels = () => [...document.querySelectorAll<HTMLButtonElement>(".ctx-item")].map((b) => b.textContent);
const menuPick = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".ctx-item")].find((b) => b.textContent === label)!.click();
const rightClick = (id: string) =>
  rowOf(id).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));


/** 走右键菜单置顶 / 取消置顶（菜单里那一项叫什么就点什么） */
function pinViaMenu(id: string): void {
  rightClick(id);
  menuPick(menuLabels().includes("取消置顶") ? "取消置顶" : "置顶");
}
describe("主面板：右键菜单里的置顶", () => {
  beforeEach(() => boot());

  it("还没置顶的自选，右键给带图标的「置顶」；置顶后给「取消置顶」", () => {
    const iconOf = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>(".ctx-item")]
        .find((b) => b.textContent === label)!
        .querySelector(".ctx-ico svg");

    rightClick("116.00700");
    expect(menuLabels()).toContain("置顶");
    expect(iconOf("置顶")).not.toBeNull(); // 菜单项带图标

    menuPick("置顶");
    expect(saved().pins).toEqual(["116.00700"]);

    rightClick("116.00700");
    expect(menuLabels()).toContain("取消置顶");
    expect(iconOf("取消置顶")).not.toBeNull();
  });

  it("置顶：写进设置、标的挪到最前", () => {
    pinViaMenu("116.00700");

    const s = saved();
    expect(s.pins).toEqual(["116.00700"]);
    expect(s.watchlist[0]).toBe("116.00700"); // 置顶的排到最前
    expect(rows().map((r) => r.dataset.id)).toEqual(["116.00700", "1.600519", "0.300750"]);
  });

  it("取消置顶：落到置顶区之后（不会挪到最前）", () => {
    pinViaMenu("0.300750");
    pinViaMenu("116.00700");
    expect(saved().pins).toEqual(["0.300750", "116.00700"]);

    pinViaMenu("0.300750"); // 取消置顶区里的第一只
    const s = saved();
    expect(s.pins).toEqual(["116.00700"]);
    // 落在还置顶着的 116.00700 之后，而不是挪到最前
    expect(s.watchlist).toEqual(["116.00700", "0.300750", "1.600519"]);
  });

  it("置顶不影响选中项、菜单栏显示与展开的分时图", () => {
    // 先把某一行的分时图展开，再置顶另一只
    rowOf("0.300750").querySelector<HTMLElement>(".row-name")!.click();
    expect(rowOf("0.300750").classList.contains("open")).toBe(true);

    pinViaMenu("116.00700");

    const s = saved();
    expect(s.selected).toBe("0.300750"); // 选中项没被置顶动作改掉
    expect(s.bar).toEqual([]);
    // 展开的那一行重画后仍然是展开的
    expect(rowOf("0.300750").classList.contains("open")).toBe(true);
    expect(document.querySelector('#list .trend[data-id="0.300750"]')!.classList.contains("show")).toBe(true);
  });

  it("置顶后删除自选，pins 里不留残余", () => {
    pinViaMenu("116.00700");
    expect(saved().pins).toEqual(["116.00700"]);

    rightClick("116.00700");
    menuPick("删除自选");

    const s = saved();
    expect(s.watchlist).not.toContain("116.00700");
    expect(s.pins).toEqual([]);
  });

  it("行上的左键仍然只负责展开分时图", () => {
    rowOf("0.300750").querySelector<HTMLElement>(".row-name")!.click();
    expect(rowOf("0.300750").classList.contains("open")).toBe(true);
    expect(saved().selected).toBe("0.300750");
    expect(saved().pins).toEqual([]); // 左键不会顺手置顶
  });
});

describe("主面板：置顶区的背景区分", () => {
  beforeEach(() => boot());

  it("置顶的行有 pinned 类，分界画在置顶区之后的第一行上", () => {
    pinViaMenu("1.600519");
    pinViaMenu("116.00700");

    const cls = rows().map((r) => ({
      id: r.dataset.id,
      pinned: r.classList.contains("pinned"),
      divider: r.classList.contains("first-unpinned"),
    }));
    // 置顶两只都在置顶区，都不带分界
    expect(cls[0]).toMatchObject({ pinned: true, divider: false });
    expect(cls[1]).toMatchObject({ pinned: true, divider: false });
    // 分界落在置顶区之后的第一行（没置顶的那只）
    expect(cls[2]).toMatchObject({ pinned: false, divider: true });
  });

  it("没置顶时整列都没有置顶样式，也没有分界", () => {
    expect(rows().every((r) => !r.classList.contains("pinned"))).toBe(true);
    expect(rows().some((r) => r.classList.contains("first-unpinned"))).toBe(false);
  });

  it("全都置顶时不画分界（下面没有可分开的东西）", () => {
    for (const id of ["1.600519", "0.300750", "116.00700"]) pinViaMenu(id);

    expect(rows().every((r) => r.classList.contains("pinned"))).toBe(true);
    expect(rows().some((r) => r.classList.contains("first-unpinned"))).toBe(false);
  });

  it("置顶区最后一行展开分时图时，分界不会跑到行与自己的图之间", () => {
    pinViaMenu("0.300750");
    rowOf("0.300750").querySelector<HTMLElement>(".row-name")!.click();

    // 分界仍在「置顶区之后的第一行」（1.600519）上，不落在置顶那行
    expect(rowOf("0.300750").classList.contains("first-unpinned")).toBe(false);
    expect(rowOf("1.600519").classList.contains("first-unpinned")).toBe(true);
  });

  it("窗口外（设置窗口 / MCP）改的置顶，主面板接到广播后跟着变", async () => {
    expect(rows().every((r) => !r.classList.contains("pinned"))).toBe(true);

    // 模拟别的窗口写盘并广播：主面板应当自己同步过来
    localStorage.setItem(
      "stockbar.settings.v1",
      JSON.stringify({
        ...saved(),
        watchlist: ["116.00700", "1.600519", "0.300750"],
        pins: ["116.00700"],
      }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: "stockbar.settings.v1" }));
    await vi.advanceTimersByTimeAsync(0);

    expect(rows().map((r) => r.dataset.id)).toEqual(["116.00700", "1.600519", "0.300750"]);
    expect(rows()[0].classList.contains("pinned")).toBe(true);
    // 置顶区之后的第一行（1.600519）带分界
    expect(rowOf("1.600519").classList.contains("first-unpinned")).toBe(true);
  });

  it("分组视图里置顶：置顶的排到该分组最前，分界跟着走", async () => {
    await boot({
      watchlist: ["1.600519", "0.300750", "116.00700"],
      pins: [],
      selected: "1.600519",
      groups: [{ id: "g1", name: "持仓" }],
      groupOf: { "0.300750": "g1", "116.00700": "g1" },
    });

    [...document.querySelectorAll<HTMLButtonElement>(".gtab")]
      .find((b) => b.textContent!.includes("持仓"))!
      .click();
    expect(rows().map((r) => r.dataset.id)).toEqual(["0.300750", "116.00700"]);
    expect(rows().every((r) => !r.classList.contains("first-unpinned"))).toBe(true);

    // 置顶分组里的第二只：它在该分组里排到最前，分界落到下一行
    pinViaMenu("116.00700");

    expect(rows().map((r) => r.dataset.id)).toEqual(["116.00700", "0.300750"]);
    expect(rowOf("116.00700").classList.contains("pinned")).toBe(true);
    expect(rowOf("0.300750").classList.contains("first-unpinned")).toBe(true);
    // 整表顺序也跟着置顶走（分组只影响怎么看）
    expect(saved().watchlist[0]).toBe("116.00700");
    expect(saved().pins).toEqual(["116.00700"]);
  });
});
