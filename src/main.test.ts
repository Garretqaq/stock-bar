// 主面板自选行「置顶」的流程测试：真起一遍 main.ts，用假报价 / 搜索 / 分时喂数据。
// 纯逻辑（pinItem / unpinItem / pinCount / clampBlock）在 settings.test.ts 里测，这里只管界面接线：
// 行右键菜单能不能置顶 / 取消置顶，置顶区有没有和普通自选区分开。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_MS } from "./sortable";

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

/** 在某个元素上派发一次指针事件（happy-dom 量不出布局，只用来跑通接线）；pointerType 要是 mouse，否则竖排列表只认把手 */
const pointer = (el: Element, type: string, pos: number, buttons = 1) =>
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      buttons,
      pointerId: 1,
      pointerType: "mouse",
      clientX: pos,
      clientY: pos,
    }),
  );

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

// 筛选条上的分组胶囊只负责切分组：顺序调整放在设置 › 行情 里做 ——
// 筛选条上「横滑看后面的分组」和「拖胶囊排序」都是横向手势，放一起会撞
describe("主面板：分组胶囊", () => {
  const withGroups = {
    groups: [
      { id: "g1", name: "持仓" },
      { id: "g2", name: "关注" },
      { id: "g3", name: "观察池" },
    ],
    groupOf: { "0.300750": "g1" },
  };

  const chips = () => [...document.querySelectorAll<HTMLElement>("#gtab-scroll .gtab")];

  beforeEach(() => boot(withGroups));

  it("按分组顺序铺开，只有全部与用户分组（未分组的股票就在「全部」里）", () => {
    expect(chips().map((c) => c.dataset.gid)).toEqual(["*", "g1", "g2", "g3"]);
    expect(chips().map((c) => c.textContent)).toEqual(["全部3", "持仓1", "关注0", "观察池0"]);
  });

  it("点胶囊切分组", () => {
    [...document.querySelectorAll<HTMLElement>("#gtab-scroll .gtab")]
      .find((c) => c.textContent!.includes("持仓"))!
      .click();
    expect(rows().map((r) => r.dataset.id)).toEqual(["0.300750"]);
  });

  // 末尾 ☰ 的弹层：所有分组一次摊开，所以这里可以放心拖（不像筛选条那样要横滑）
  describe("☰ 弹层里的分组可以拖动排序", () => {
    const popup = () => document.querySelector<HTMLElement>(".ctx-menu.chips");
    const popChips = () => [...document.querySelectorAll<HTMLElement>(".ctx-menu.chips .ctx-chip")];
    const open = () => document.querySelector<HTMLElement>("#gtab-more")!.click();
    /** 弹层里可拖的那些胶囊的分组 id（「全部」没有 data-key，拖不走） */
    const keys = () => popChips().map((c) => c.dataset.key).filter((k): k is string => !!k);
    const order = () => saved().groups.map((g: { id: string }) => g.id);

    beforeEach(() => {
      // 分组多到筛选条放不下，☰ 才会出现
      document.querySelector<HTMLElement>("#gtab-scroll")!.style.width = "60px";
    });

    it("弹层里只有用户分组带 data-key（「全部」拖不走）", () => {
      open();
      expect(popup()).not.toBeNull();
      expect(popChips().map((c) => c.textContent)).toEqual(["全部3", "持仓1", "关注0", "观察池0"]);
      expect(keys()).toEqual(["g1", "g2", "g3"]);
    });

    it("Alt + → 把分组往后挪一位：写回设置，弹层按新顺序重开", () => {
      open();
      document
        .querySelector<HTMLElement>('.ctx-menu.chips .ctx-chip[data-key="g1"]')!
        .dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }));

      expect(order()).toEqual(["g2", "g1", "g3"]);
      // 重开的弹层仍开着，且按新顺序排
      expect(keys()).toEqual(["g2", "g1", "g3"]);
      expect(document.querySelectorAll(".ctx-menu").length).toBe(1);
    });

    it("鼠标拖动胶囊改顺序：就地换位（弹层不重建），松手那一下 click 不切分组", () => {
      open();
      const menu = popup()!;
      const first = menu.querySelector<HTMLElement>('.ctx-chip[data-key="g1"]')!;
      pointer(first, "pointerdown", 10);
      pointer(first, "pointermove", 400);
      pointer(first, "pointerup", 400, 0);

      expect(order()).toEqual(["g2", "g3", "g1"]);
      // 弹层还是同一层（不重建 → 入场动画不会重播，拖完不会闪一下）
      expect(popup()).toBe(menu);
      expect(keys()).toEqual(["g2", "g3", "g1"]);

      // 松手跟来的那一下 click 打在同一颗胶囊上：它属于这次拖动，不该切分组、也不该收起弹层
      menu.querySelector<HTMLElement>('.ctx-chip[data-key="g1"]')!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(popup()).toBe(menu);
      expect(rows().map((r) => r.dataset.id)).toEqual(["1.600519", "0.300750", "116.00700"]); // 仍是「全部」
    });

    it("点弹层里的胶囊仍然是切分组", () => {
      open();
      document.querySelector<HTMLElement>('.ctx-menu.chips .ctx-chip[data-key="g1"]')!.click();
      expect(rows().map((r) => r.dataset.id)).toEqual(["0.300750"]);
      expect(document.querySelector(".ctx-menu")).toBeNull(); // 选完弹层收起
    });
  });
});

// 自选行直接拖动排序：顺序写回 watchlist（分组视图换算成整表下标，置顶的只能在自己那块里挪）
describe("主面板：拖动自选行排序", () => {
  const ids = () => rows().map((r) => r.dataset.id);
  /**
   * 从某一行起拖：happy-dom 量不出布局，落点恒为最后一格（置顶的会被 clampBlock 拉回置顶区）。
   * 行上起拖要先按住 HOLD_MS（见 sortable.ts），所以这里得先推进一次假定时器。
   */
  const dragRow = async (id: string) => {
    const row = rowOf(id);
    pointer(row, "pointerdown", 10);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    pointer(row, "pointermove", 400);
    pointer(row, "pointerup", 400, 0);
  };

  beforeEach(() => boot());

  it("拖动一行：顺序写回设置、行跟着重排", async () => {
    await dragRow("0.300750");

    expect(saved().watchlist).toEqual(["1.600519", "116.00700", "0.300750"]);
    expect(ids()).toEqual(["1.600519", "116.00700", "0.300750"]);
  });

  it("拖动松手跟来的那一下 click 不展开分时图", async () => {
    await dragRow("0.300750");
    rowOf("0.300750").click(); // 浏览器松手后补的那一下

    expect(rowOf("0.300750").classList.contains("open")).toBe(false);
    expect(document.querySelector("#list .trend.show")).toBeNull();
    expect(saved().selected).toBe("1.600519"); // 选中项也没被顺手动过
  });

  it("按下没挪动就松手：仍是普通点击（展开分时图）", () => {
    const row = rowOf("0.300750");
    pointer(row, "pointerdown", 10);
    pointer(row, "pointerup", 10, 0);

    expect(saved().watchlist).toEqual(["1.600519", "0.300750", "116.00700"]); // 顺序没动
    row.click();
    expect(rowOf("0.300750").classList.contains("open")).toBe(true);
  });

  it("按下就滑开（没按住）：不算拖动，顺序不动", () => {
    const row = rowOf("0.300750");
    pointer(row, "pointerdown", 10);
    pointer(row, "pointermove", 400); // 还没到 HOLD_MS 就滑开了
    pointer(row, "pointerup", 400, 0);

    expect(saved().watchlist).toEqual(["1.600519", "0.300750", "116.00700"]);
    expect(rowOf("0.300750").classList.contains("dragging")).toBe(false);
  });

  it("按住期间晃太多：这一下不当拖动（当成滑动手势）", async () => {
    const row = rowOf("0.300750");
    pointer(row, "pointerdown", 10);
    pointer(row, "pointermove", 30); // 超过 HOLD_SLOP：按住作废
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    pointer(row, "pointermove", 400);
    pointer(row, "pointerup", 400, 0);

    expect(saved().watchlist).toEqual(["1.600519", "0.300750", "116.00700"]);
  });

  it("按住到时间才进入拖动：那一刻行才挂上 .dragging", async () => {
    const row = rowOf("0.300750");
    pointer(row, "pointerdown", 10);
    expect(row.classList.contains("dragging")).toBe(false); // 还在等「按住」

    await vi.advanceTimersByTimeAsync(HOLD_MS);
    expect(row.classList.contains("dragging")).toBe(true);

    pointer(row, "pointerup", 10, 0); // 按住后没挪动就松手：顺序不动
    expect(row.classList.contains("dragging")).toBe(false);
    expect(saved().watchlist).toEqual(["1.600519", "0.300750", "116.00700"]);
  });

  it("置顶的行拖不出去：落点被钳在置顶区里", async () => {
    await boot({ pins: ["1.600519"] });

    await dragRow("1.600519");

    expect(saved().watchlist).toEqual(["1.600519", "0.300750", "116.00700"]);
    expect(saved().pins).toEqual(["1.600519"]);
  });

  it("分组视图里拖动：组内先后变了，整表顺序跟着走", async () => {
    await boot({
      groups: [{ id: "g1", name: "持仓" }],
      groupOf: { "0.300750": "g1", "116.00700": "g1" },
    });
    [...document.querySelectorAll<HTMLElement>("#gtab-scroll .gtab")]
      .find((c) => c.textContent!.includes("持仓"))!
      .click();
    expect(ids()).toEqual(["0.300750", "116.00700"]);

    await dragRow("0.300750"); // 组内第一只往后挪

    // 整表里它挪到了组内第二只之后；组视图里的先后也跟着变
    expect(saved().watchlist).toEqual(["1.600519", "116.00700", "0.300750"]);
    expect(ids()).toEqual(["116.00700", "0.300750"]);
  });
});
