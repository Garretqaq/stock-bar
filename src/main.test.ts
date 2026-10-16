// 主面板自选行「置顶」的流程测试：真起一遍 main.ts，用假报价 / 搜索 / 分时喂数据。
// 纯逻辑（pinItem / unpinItem / pinCount / moveRowInView）在 settings.test.ts 里测，这里只管界面接线：
// 行右键菜单能不能置顶 / 取消置顶，置顶区有没有和普通自选区分开。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HOLD_MS } from "./sortable";
import type { Board } from "./api";

// 每个用例都重新 import 一遍 main.ts（模块级会挂监听 / 起定时器），跑完清掉假的定时器，
// 免得后面用例拿到上一个用例残留的 interval
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

/** 假板块列表：行业那一份里混着两条 Ⅱ / Ⅲ 细分（与真实接口一样，是同值的重复项） */
const BOARDS: Board[] = [
  { secid: "90.BK0480", code: "BK0480", name: "航天航空", pct: 5.4, price: 50520.08, leader: "晨曦航空", leaderPct: 20.02 },
  { secid: "90.BK0994", code: "BK0994", name: "空间站概念", pct: 4.73, price: 2008.83, leader: "华力创通", leaderPct: 20.04 },
  { secid: "90.BK0148", code: "BK0148", name: "吉林板块", pct: 3.11, price: 20173.83, leader: "长春一东", leaderPct: 10 },
  { secid: "90.BK1305", code: "BK1305", name: "燃料电池", pct: -2.2, price: 273.47, leader: "中视传媒", leaderPct: -3.5 },
  { secid: "90.BK1230", code: "BK1230", name: "航海装备Ⅲ", pct: 6.93, price: 5157.01, leader: "中科海讯", leaderPct: 19.99 },
  { secid: "90.BK1229", code: "BK1229", name: "航海装备Ⅱ", pct: 6.93, price: 5157.01, leader: "中科海讯", leaderPct: 19.99 },
];
/** 地域那一份：换口径时要看到榜单整份换过来 */
const REGION_BOARDS: Board[] = [
  { secid: "90.BK0148", code: "BK0148", name: "吉林板块", pct: 3.11, price: 20173.83, leader: "长春一东", leaderPct: 10 },
  { secid: "90.BK0169", code: "BK0169", name: "四川板块", pct: 2.83, price: 23992.81, leader: "华图山鼎", leaderPct: 14.76 },
];


/** 腾讯那一套：代码空间是 91.pt…（数量也少得多，只有一级行业） */
const TENCENT_BOARDS: Board[] = [
  { secid: "91.pt01801120", code: "pt01801120", name: "食品饮料", pct: 0.66, price: 13938.75, leader: "金达威", leaderPct: 10.03 },
];
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
    // 数据源是腾讯时给腾讯那一套（91.pt…），否则给东财的
    fetchBoards: vi.fn(async (kind: string, source?: string) =>
      source === "tencent" ? TENCENT_BOARDS : kind === "region" ? REGION_BOARDS : BOARDS,
    ),
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

    it("弹层里只有用户分组带 data-key（「全部」与末尾的「＋ 新建分组」都拖不走）", () => {
      open();
      expect(popup()).not.toBeNull();
      expect(popChips().map((c) => c.textContent)).toEqual([
        "全部3",
        "持仓1",
        "关注0",
        "观察池0",
        "＋ 新建分组",
      ]);
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

// 自选行直接拖动排序：顺序写回 watchlist（分组视图换算成整表下标，跨过置顶分界的那一下由
// moveRowInView 顺手改置顶状态）
describe("主面板：拖动自选行排序", () => {
  const ids = () => rows().map((r) => r.dataset.id);
  /**
   * 从某一行起拖：happy-dom 量不出布局，所以落点只看指针的 y —— y 为负（拖到列表上方）就落在第 0 格，
   * 否则恒为最后一格。行上起拖要先按住 HOLD_MS（见 sortable.ts），所以这里得先推进一次假定时器。
   */
  const dragRow = async (id: string, y = 400) => {
    const row = rowOf(id);
    pointer(row, "pointerdown", 10);
    await vi.advanceTimersByTimeAsync(HOLD_MS);
    pointer(row, "pointermove", y);
    pointer(row, "pointerup", y, 0);
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

  it("置顶的行拖到分界之下：位置跟着落点走，顺手取消置顶", async () => {
    await boot({ pins: ["1.600519"] });

    await dragRow("1.600519"); // 落点恒为最后一格

    expect(saved().watchlist).toEqual(["0.300750", "116.00700", "1.600519"]);
    expect(saved().pins).toEqual([]);
    expect(rowOf("1.600519").classList.contains("pinned")).toBe(false);
    expect(rows()[0].classList.contains("first-unpinned")).toBe(false); // 没有置顶区，也就不画分界
  });

  it("未置顶的行拖到置顶行上面：排上去，还顺手置顶", async () => {
    await boot({ pins: ["1.600519"] });

    await dragRow("0.300750", -10); // 落点在置顶区里（第 0 格）

    expect(saved().watchlist).toEqual(["0.300750", "1.600519", "116.00700"]);
    expect(saved().pins).toEqual(["0.300750", "1.600519"]);
    expect(rowOf("0.300750").classList.contains("pinned")).toBe(true);
    expect(rowOf("116.00700").classList.contains("first-unpinned")).toBe(true); // 分界跟着挪到置顶区之后
    rightClick("0.300750"); // 行右键菜单此时给的是「取消置顶」
    expect(menuLabels()).toContain("取消置顶");
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

  it("分组视图里跨过置顶分界拖动：组内顺序与置顶一起改（按可见列表判定）", async () => {
    await boot({
      pins: ["1.600519"],
      groups: [{ id: "g1", name: "持仓" }],
      groupOf: { "1.600519": "g1", "0.300750": "g1" },
    });
    [...document.querySelectorAll<HTMLElement>("#gtab-scroll .gtab")]
      .find((c) => c.textContent!.includes("持仓"))!
      .click();
    expect(ids()).toEqual(["1.600519", "0.300750"]); // 置顶的排在该分组最前

    await dragRow("0.300750", -10); // 拖到置顶那一行上面

    expect(saved().watchlist).toEqual(["0.300750", "1.600519", "116.00700"]);
    expect(saved().pins).toEqual(["0.300750", "1.600519"]);
    expect(ids()).toEqual(["0.300750", "1.600519"]);
  });

  it("Alt + ↑ 跨过置顶分界：一样顺手置顶（鼠标之外的第二条路同一条规则）", async () => {
    await boot({ pins: ["1.600519"] });

    rowOf("0.300750").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", altKey: true, bubbles: true }));

    expect(saved().watchlist).toEqual(["0.300750", "1.600519", "116.00700"]);
    expect(saved().pins).toEqual(["0.300750", "1.600519"]);
  });
});

// 板块榜单：视图切换、口径 / 排序 / 细分三个开关、点开板块分时。
// 板块不是标的（见 CONTEXT.md 与 docs/adr/0001），所以这里还要钉住「不动设置」。
describe("主面板：板块榜单", () => {
  const tab = (v: string) => document.querySelector<HTMLElement>(`.vtab[data-view="${v}"]`)!;
  const bRows = () => [...document.querySelectorAll<HTMLElement>("#boards .row")];
  const bNames = () => bRows().map((r) => r.querySelector(".row-name")!.textContent);
  const bRowOf = (name: string) =>
    bRows().find((r) => r.querySelector(".row-name")!.textContent === name)!;
  /** 切到板块视图并把那次拉取跑完 */
  const openBoards = async () => {
    tab("board").click();
    await vi.advanceTimersByTimeAsync(0);
  };
  /** 被 mock 掉的 api 函数（每个用例 boot 之后都是新的一份） */
  const mocked = async <K extends "fetchBoards" | "fetchTrend">(name: K) =>
    (await import("./api"))[name] as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => boot());

  it("默认停在自选视图：板块榜单与控制条都藏着", () => {
    expect(document.querySelector<HTMLElement>("#boards")!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#bctl")!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#list")!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>(".search")!.hidden).toBe(false);
  });

  it("切到板块：搜索框留着（换成搜板块的提示）、榜单按涨幅降序，默认藏起 Ⅱ / Ⅲ 细分", async () => {
    await openBoards();

    expect(tab("board").classList.contains("on")).toBe(true);
    expect(tab("board").getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector<HTMLElement>(".search")!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#list")!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#boards")!.hidden).toBe(false);
    // 航海装备Ⅱ / Ⅲ 是同值的重复项，默认不该出现在榜上
    expect(bNames()).toEqual(["航天航空", "空间站概念", "吉林板块", "燃料电池"]);
  });

  it("一行里有涨跌幅和领涨股", async () => {
    await openBoards();

    const row = bRowOf("航天航空");
    expect(row.querySelector(".pill")!.textContent).toBe("+5.40%");
    expect(row.querySelector(".pill")!.className).toBe("pill up");
    expect(row.querySelector(".row-meta")!.textContent).toBe("领涨晨曦航空+20.02%");
  });

  it("领涨股自己在跌时写成「领跌」", async () => {
    await openBoards();

    const meta = bRowOf("燃料电池").querySelector(".row-meta")!;
    expect(meta.textContent).toBe("领跌中视传媒-3.50%");
    expect(meta.querySelector("b")!.className).toBe("down");
  });

  it("点「涨幅 ↓」切成跌幅榜：跌得最狠的排到最前", async () => {
    await openBoards();
    document.querySelector<HTMLElement>("#border")!.click();

    expect(document.querySelector<HTMLElement>("#border")!.textContent).toBe("跌幅 ↑");
    expect(bNames()).toEqual(["燃料电池", "吉林板块", "空间站概念", "航天航空"]);
  });

  it("点「细分」：Ⅱ / Ⅲ 的细分放出来，仍按涨幅排", async () => {
    await openBoards();
    document.querySelector<HTMLElement>("#bsubs")!.click();

    expect(bNames()).toEqual([
      "航海装备Ⅲ",
      "航海装备Ⅱ",
      "航天航空",
      "空间站概念",
      "吉林板块",
      "燃料电池",
    ]);
  });

  it("换口径：按新口径重新拉一次，榜单整份换过来", async () => {
    await openBoards();
    const fetchBoards = await mocked("fetchBoards");
    expect(fetchBoards).toHaveBeenLastCalledWith("industry", "auto", false);

    [...document.querySelectorAll<HTMLElement>("#bkind .gtab")]
      .find((b) => b.textContent === "地域")!
      .click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchBoards).toHaveBeenLastCalledWith("region", "auto", false);
    expect(bNames()).toEqual(["吉林板块", "四川板块"]);
  });

  it("点一行展开这个板块的分时，但不改「当前选中的标的」", async () => {
    await openBoards();
    bRowOf("航天航空").click();
    await vi.advanceTimersByTimeAsync(0);

    expect(document.querySelector<HTMLElement>("#boards .trend.show")!.dataset.id).toBe("90.BK0480");
    expect(bRowOf("航天航空").classList.contains("open")).toBe(true);
    expect(saved().selected).toBe("1.600519"); // 板块不是标的，不进设置
    expect(saved().watchlist).toEqual(["1.600519", "0.300750", "116.00700"]);
  });

  it("板块分时只走东方财富：腾讯不提供板块数据", async () => {
    await openBoards();
    const fetchTrend = await mocked("fetchTrend");
    bRowOf("航天航空").click();
    await vi.advanceTimersByTimeAsync(0);

    expect(fetchTrend).toHaveBeenCalledWith("90.BK0480", 1, "eastmoney");
  });

  it("点第二下收起分时", async () => {
    await openBoards();
    bRowOf("航天航空").click();
    await vi.advanceTimersByTimeAsync(0);

    bRowOf("航天航空").click();
    expect(document.querySelector("#boards .trend.show")).toBeNull();
  });

  it("切回自选：榜单与控制条收起，搜索框和自选列表回来", async () => {
    await openBoards();
    tab("watch").click();

    expect(document.querySelector<HTMLElement>("#boards")!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#bctl")!.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>(".search")!.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#list")!.hidden).toBe(false);
    expect(rows().map((r) => r.dataset.id)).toEqual(["1.600519", "0.300750", "116.00700"]);
  });

  it("只有板块视图在前台时才跟着刷新间隔拉榜单", async () => {
    await openBoards();
    const fetchBoards = await mocked("fetchBoards");
    const opened = fetchBoards.mock.calls.length;

    await vi.advanceTimersByTimeAsync(5000); // 一个刷新周期
    expect(fetchBoards.mock.calls.length).toBe(opened + 1);

    tab("watch").click();
    await vi.advanceTimersByTimeAsync(5000); // 切回自选后不该再拉
    expect(fetchBoards.mock.calls.length).toBe(opened + 1);
  });

  it("名次变化只搬 DOM：展开中的分时图不会被重建掉", async () => {
    await openBoards();
    const fetchBoards = await mocked("fetchBoards");
    bRowOf("航天航空").click();
    await vi.advanceTimersByTimeAsync(0);
    const panel = document.querySelector<HTMLElement>("#boards .trend.show")!;
    expect(panel.querySelector(".trend-title")!.textContent).toBe("航天航空 · 分时");

    // 下一次刷新时名次换了（燃料电池涨上来了）：成员没变，只是顺序变了
    fetchBoards.mockResolvedValueOnce([
      { ...BOARDS[3], pct: 9.9, leaderPct: 10.2 },
      ...BOARDS.slice(0, 3),
      ...BOARDS.slice(4),
    ]);
    await vi.advanceTimersByTimeAsync(5000);

    expect(bNames()[0]).toBe("燃料电池");
    // 还是原来那一个节点：重建的话画好的 canvas 就没了（曾经就是这么丢的）
    expect(document.querySelector("#boards .trend.show")).toBe(panel);
    expect(panel.querySelector(".trend-title")!.textContent).toBe("航天航空 · 分时");
  });

  it("成员变了要重建榜单，展开中的分时图跟着补画一次", async () => {
    await openBoards();
    bRowOf("航天航空").click();
    await vi.advanceTimersByTimeAsync(0);

    document.querySelector<HTMLElement>("#bsubs")!.click(); // 放出细分：成员变了

    const panel = document.querySelector<HTMLElement>("#boards .trend.show")!;
    expect(panel.dataset.id).toBe("90.BK0480");
    // 新建出来的面板只有 .show、还没画过，标题是空的 —— 补画过才有标题
    expect(panel.querySelector(".trend-title")!.textContent).toBe("航天航空 · 分时");
  });

  it("控制条上报出当前榜上有多少个板块", async () => {
    await openBoards();
    // 6 条里藏掉 2 条 Ⅱ / Ⅲ 细分
    expect(document.querySelector("#bcount")!.textContent).toBe("4 个");

    document.querySelector<HTMLElement>("#bsubs")!.click();
    expect(document.querySelector("#bcount")!.textContent).toBe("6 个");
  });

  it("榜单按设置里的数据源拉（默认 auto）", async () => {
    await openBoards();
    const fetchBoards = await mocked("fetchBoards");
    expect(fetchBoards).toHaveBeenLastCalledWith("industry", "auto", false);
  });

  it("数据源是腾讯：榜单换成腾讯那一套，分时也走腾讯", async () => {
    await boot({ source: "tencent" });
    await openBoards();
    const fetchTrend = await mocked("fetchTrend");

    expect(bNames()).toEqual(["食品饮料"]);

    bRowOf("食品饮料").click();
    await vi.advanceTimersByTimeAsync(0);

    // 91.pt… 是腾讯的代码空间：分时得找腾讯要，不能按设置里的源去猜
    expect(fetchTrend).toHaveBeenCalledWith("91.pt01801120", 1, "tencent");
  });
});

// 分组筛选条的可见性：没建分组时整条不出现；建了就一直在。
// 板块视图里它要收起来（那边没有自选列表），切回自选必须回来 —— 差一行 box.hidden
// 就会「胶囊渲染了但整条永远藏着」，这一条就是为那次事故钉的。
describe("主面板：分组筛选条的可见性", () => {
  const strip = () => document.querySelector<HTMLElement>("#gtabs")!;
  const tab = (v: string) => document.querySelector<HTMLElement>(`.vtab[data-view="${v}"]`)!;

  it("没建过分组：整条藏着，连胶囊都不渲染", async () => {
    await boot();

    expect(strip().hidden).toBe(true);
    expect(strip().querySelectorAll(".gtab").length).toBe(0);
  });

  it("建过分组：显示出来，胶囊是「全部 + 各分组（带数量）」", async () => {
    await boot({
      groups: [
        { id: "g1", name: "持仓" },
        { id: "g2", name: "观察" },
      ],
    });

    expect(strip().hidden).toBe(false);
    expect([...strip().querySelectorAll(".gtab")].map((b) => b.textContent)).toEqual([
      "全部3",
      "持仓0",
      "观察0",
    ]);
  });

  it("切到板块再切回自选：筛选条收起来又回来", async () => {
    await boot({ groups: [{ id: "g1", name: "持仓" }] });
    expect(strip().hidden).toBe(false);

    tab("board").click();
    await vi.advanceTimersByTimeAsync(0);
    expect(strip().hidden).toBe(true); // 板块视图里没有自选列表，筛选条不该出现

    tab("watch").click();
    expect(strip().hidden).toBe(false);
  });
});

// 板块搜索：搜索框在板块视图里就地过滤当前口径那份榜单（不发 suggest 请求）
describe("主面板：板块搜索", () => {
  const tab = (v: string) => document.querySelector<HTMLElement>(`.vtab[data-view="${v}"]`)!;
  const input = () => document.querySelector<HTMLInputElement>("#search-input")!;
  const bRows = () => [...document.querySelectorAll<HTMLElement>("#boards .row")];
  const bNames = () => bRows().map((r) => r.querySelector(".row-name")!.textContent);
  const bRowOf = (name: string) =>
    bRows().find((r) => r.querySelector(".row-name")!.textContent === name)!;
  const ALL = ["航天航空", "空间站概念", "吉林板块", "燃料电池"];
  const openBoards = async () => {
    tab("board").click();
    await vi.advanceTimersByTimeAsync(0);
  };
  const type = (kw: string) => {
    input().value = kw;
    input().dispatchEvent(new Event("input", { bubbles: true }));
  };

  beforeEach(() => boot());

  it("板块视图里搜索框还在，提示词换成搜板块", async () => {
    expect(document.querySelector<HTMLElement>(".search")!.hidden).toBe(false);
    expect(input().placeholder).toBe("搜索代码 / 名称 / 拼音");

    await openBoards();
    expect(document.querySelector<HTMLElement>(".search")!.hidden).toBe(false);
    expect(input().placeholder).toBe("搜索板块名");
  });

  it("输入关键词就地过滤榜单，且不发搜索请求", async () => {
    await openBoards();
    type("空间");

    expect(bNames()).toEqual(["空间站概念"]);
    expect(document.querySelector("#bcount")!.textContent).toBe("1 个");
    const { searchStocks } = await import("./api");
    expect(searchStocks).not.toHaveBeenCalled();
  });

  it("清空关键词：榜单回到全量", async () => {
    await openBoards();
    type("空间");
    expect(bNames()).toEqual(["空间站概念"]);

    type("");
    expect(bNames()).toEqual(ALL);
  });

  it("搜不到：给空状态，并说明只搜当前口径", async () => {
    await openBoards();
    type("宁德时代");

    const empty = document.querySelector("#boards .empty")!;
    expect(empty.textContent).toContain("没有匹配「宁德时代」的板块");
    expect(empty.textContent).toContain("只搜当前口径（行业）");
  });

  it("搜索状态下点一行仍然展开这个板块的分时", async () => {
    await openBoards();
    type("空间");

    bRowOf("空间站概念").click();
    await vi.advanceTimersByTimeAsync(0);

    expect(document.querySelector<HTMLElement>("#boards .trend.show")!.dataset.id).toBe("90.BK0994");
  });

  it("换视图会清掉搜索词：切回板块时是完整榜单", async () => {
    await openBoards();
    type("空间");
    expect(bNames()).toEqual(["空间站概念"]);

    tab("watch").click();
    expect(input().value).toBe("");

    await openBoards();
    expect(bNames()).toEqual(ALL);
  });
});

// 分组管理（新增 / 改名 / 删除）在主面板上也能做，不必为改个名字去开设置窗口。
// 与设置 › 行情 是同一份数据、同一套纯函数（settings.ts），这里只管界面接线：
// ＋ 建组后就地改名、右键标签 / 弹层胶囊给菜单、删除要走两次确认。
describe("主面板：分组管理", () => {
  const tabs = () => [...document.querySelectorAll<HTMLElement>("#gtab-scroll .gtab")];
  const tabOf = (name: string) => tabs().find((t) => t.textContent!.startsWith(name))!;
  const rename = () => document.querySelector<HTMLInputElement>(".gtab-input");
  const groups = () => saved().groups as { id: string; name: string }[];
  const groupOf = () => saved().groupOf as Record<string, string>;
  const rightClickOn = (el: Element) =>
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 5, clientY: 5 }));
  /** 按一次键（可以顺带改掉输入框里的内容，模拟用户先打字再按回车） */
  const press = (el: HTMLInputElement, key: string, value?: string) => {
    if (value != null) el.value = value;
    el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  };

  /** ☰ 弹层（分组多时才露出，但 happy-dom 里点它就是点它）与里面按名字找胶囊 */
  const openChips = () => document.querySelector<HTMLElement>("#gtab-more")!.click();
  const chipNamed = (label: string) =>
    [...document.querySelectorAll<HTMLElement>(".ctx-menu.chips .ctx-chip")].find(
      (c) => c.textContent === label,
    )!;

  const withGroups = {
    groups: [
      { id: "g1", name: "持仓" },
      { id: "g2", name: "关注" },
      { id: "g3", name: "观察池" },
    ],
    groupOf: { "0.300750": "g1" },
  };

  beforeEach(() => boot(withGroups));

  it("新建的入口：☰ 弹层末尾那颗「＋ 新建分组」建好就地改名，回车提交", () => {
    openChips();
    chipNamed("＋ 新建分组").click();

    // 与设置 › 行情 一致：先建（占位名），紧接着进入改名
    expect(groups().map((g) => g.id)).toEqual(["g1", "g2", "g3", "g4"]);
    expect(document.querySelector(".ctx-menu")).toBeNull(); // 点完弹层收起
    const box = rename()!;
    expect(box).not.toBeNull();
    expect(box.value).toBe("新分组");
    expect(document.activeElement).toBe(box); // 直接把光标交出去，不必再点一下

    press(box, "Enter", "打板");

    expect(groups().map((g) => g.name)).toEqual(["持仓", "关注", "观察池", "打板"]);
    expect(rename()).toBeNull();
    expect(tabs().map((t) => t.textContent)).toEqual(["全部3", "持仓1", "关注0", "观察池0", "打板0"]);
  });

  it("分组少、☰ 没露头时也有入口：右键标签菜单里的「＋ 新建分组」", () => {
    // happy-dom 量不出宽度，☰ 一直是藏着的那一侧（真实面板里分组少时同样不出现）
    expect(document.querySelector<HTMLElement>("#gtab-more")!.hidden).toBe(true);

    rightClickOn(tabOf("持仓"));
    expect(menuLabels()).toEqual(["＋ 新建分组", "重命名", "删除分组…"]);
    menuPick("＋ 新建分组");

    expect(groups().map((g) => g.id)).toEqual(["g1", "g2", "g3", "g4"]);
    expect(rename()!.value).toBe("新分组");
  });

  it("右键分组标签：菜单第一项是新建，点重命名就地出输入框（预填当前名字）", () => {
    rightClickOn(tabOf("持仓"));
    expect(menuLabels()).toEqual(["＋ 新建分组", "重命名", "删除分组…"]);

    menuPick("重命名");
    expect(rename()!.value).toBe("持仓");
    expect(groups().map((g) => g.name)).toEqual(["持仓", "关注", "观察池"]); // 只是进了改名，还没写回
  });

  it("改名的三种收尾：回车提交、失焦提交、Esc 放弃", () => {
    rightClickOn(tabOf("关注"));
    menuPick("重命名");
    press(rename()!, "Escape", "改了一半"); // Esc 放弃：名字不动，输入框换回标签
    expect(groups().map((g) => g.name)).toEqual(["持仓", "关注", "观察池"]);
    expect(rename()).toBeNull();

    rightClickOn(tabOf("关注"));
    menuPick("重命名");
    const box = rename()!;
    box.value = "自选股";
    box.dispatchEvent(new Event("blur")); // 点到别处也算提交
    expect(groups().map((g) => g.name)).toEqual(["持仓", "自选股", "观察池"]);
    expect(tabs().map((t) => t.textContent)).toEqual(["全部3", "持仓1", "自选股0", "观察池0"]);
  });

  it("右键「全部」不给菜单：它不是分组，改不了名也删不掉", () => {
    rightClickOn(tabOf("全部"));

    expect(document.querySelector(".ctx-menu")).toBeNull();
  });

  it("删除分组要两次确认：第一次只换出确认条，确认后成员回到未分组", () => {
    rightClickOn(tabOf("持仓"));
    menuPick("删除分组…");

    // 第一次点只是把菜单换成确认：删除不可逆，别一手滑就没了
    expect(groups().map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
    expect(menuLabels()).toEqual(["确认删除「持仓」（1 只移入未分组）", "取消"]);

    menuPick("确认删除「持仓」（1 只移入未分组）");

    expect(groups().map((g) => g.id)).toEqual(["g2", "g3"]);
    expect(groupOf()).toEqual({}); // 成员回到未分组，自选一只都没少
    expect(tabs().map((t) => t.textContent)).toEqual(["全部3", "关注0", "观察池0"]);
  });

  it("确认条里点「取消」：什么都不改", () => {
    rightClickOn(tabOf("持仓"));
    menuPick("删除分组…");
    menuPick("取消");

    expect(groups().map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
    expect(groupOf()).toEqual({ "0.300750": "g1" });
    expect(rename()).toBeNull();
  });

  it("删掉的正是当前在看的那个分组：退回「全部」，一只自选都不少", () => {
    tabOf("持仓").click();
    expect(rows().map((r) => r.dataset.id)).toEqual(["0.300750"]);

    rightClickOn(tabOf("持仓"));
    menuPick("删除分组…");
    menuPick("确认删除「持仓」（1 只移入未分组）");

    // 分组没了，筛选态不能挂在一个不存在的分组上
    expect(rows().map((r) => r.dataset.id)).toEqual(["1.600519", "0.300750", "116.00700"]);
    expect(tabs()[0].classList.contains("on")).toBe(true); // 「全部」高亮
  });

  it("☰ 弹层里的胶囊右键也是同一套菜单：改名落在筛选条那一格，删除照样两次确认", () => {
    const chip = (k: string) => document.querySelector<HTMLElement>(`.ctx-menu.chips .ctx-chip[data-key="${k}"]`)!;

    openChips();
    rightClickOn(chip("g2"));
    expect(menuLabels()).toEqual(["＋ 新建分组", "重命名", "删除分组…"]);

    // 改名落在筛选条那一格上（弹层已经关掉了）
    menuPick("重命名");
    expect(rename()!.value).toBe("关注");
    press(rename()!, "Escape"); // 收掉这一轮，好接着试删除

    // 删除也一样走两次确认（这颗胶囊没有成员，确认条就不必报去向）
    openChips();
    rightClickOn(chip("g3"));
    menuPick("删除分组…");
    expect(menuLabels()).toEqual(["确认删除「观察池」", "取消"]);
    menuPick("确认删除「观察池」");
    expect(groups().map((g) => g.id)).toEqual(["g1", "g2"]);
  });

  it("改名时按 Esc：只放弃改名，不把面板一起收起来（Esc 不冒泡到 document）", () => {
    rightClickOn(tabOf("持仓"));
    menuPick("重命名");
    const seen: string[] = [];
    const spy = (e: KeyboardEvent) => seen.push(e.key);
    document.addEventListener("keydown", spy);
    press(rename()!, "Escape", "改了一半");
    document.removeEventListener("keydown", spy);

    // 面板自己那层 Esc（收起窗口）挂在 document 上：这一下不该冒到那儿去
    expect(seen).not.toContain("Escape");
    expect(groups().map((g) => g.name)).toEqual(["持仓", "关注", "观察池"]);
  });

  it("输入法还在拼字时的回车不算提交（别把拼音字母当成名字）", () => {
    rightClickOn(tabOf("持仓"));
    menuPick("重命名");
    const box = rename()!;
    box.value = "chicang";
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true }));

    expect(groups().map((g) => g.name)).toEqual(["持仓", "关注", "观察池"]);
    expect(rename()).toBe(box); // 还在这格里改
  });

  it("改名当中别的窗口改了设置：整条重画，手打了一半的字还在", async () => {
    rightClickOn(tabOf("关注"));
    menuPick("重命名");
    rename()!.value = "改了一半";

    // 另一个窗口（设置窗口 / MCP）改了别处：本窗口接到广播后整条重画
    localStorage.setItem(
      "stockbar.settings.v1",
      JSON.stringify({
        ...saved(),
        groups: [
          { id: "g1", name: "持仓" },
          { id: "g2", name: "关注着" },
          { id: "g3", name: "观察池" },
        ],
      }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: "stockbar.settings.v1" }));
    await vi.advanceTimersByTimeAsync(0);

    const box = rename()!;
    expect(box).not.toBeNull();
    expect(box.dataset.gid).toBe("g2"); // 还在改原来那个分组
    expect(box.value).toBe("改了一半"); // 草稿没被重画冲掉
    expect(document.activeElement).toBe(box);
  });
});
