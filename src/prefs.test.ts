// 设置窗口「行情」页搜索结果右键的流程测试：真起一遍 prefs.ts，用假搜索/报价喂数据。
// 纯逻辑（菜单有哪些项、动作怎么落设置）在 settings.test.ts 里测，这里只管界面接线。
import { beforeEach, describe, expect, it, vi } from "vitest";

const SEARCH = [{ secid: "1.600988", code: "600988", name: "赤峰黄金", type: "沪A" }];

// 搜索接口走 JSONP（真浏览器里插 script），happy-dom 里跑不了，换成固定结果；报价也一并挡掉
vi.mock("./api", async (orig) => {
  const actual = await orig<typeof import("./api")>();
  return { ...actual, searchStocks: vi.fn(async () => SEARCH), fetchQuotes: vi.fn(async () => new Map()) };
});

/** 起一个只带 #prefs 的页面（与 settings.html 一致），并先写一份带分组的设置 */
async function boot() {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem(
    "stockbar.settings.v1",
    JSON.stringify({
      watchlist: ["1.600519"],
      selected: "1.600519",
      bar: ["1.600519"],
      groups: [{ id: "g1", name: "持仓" }],
      groupOf: {},
    }),
  );
  document.body.innerHTML = '<div id="prefs" class="prefs"></div>';
  vi.useFakeTimers();
  await import("./prefs");
}

/** 往新增自选的搜索框里敲字，等过防抖，返回搜出来的第一行 */
async function search(kw = "赤峰"): Promise<HTMLElement> {
  const input = document.querySelector<HTMLInputElement>("#add-input")!;
  input.value = kw;
  input.dispatchEvent(new Event("input"));
  await vi.advanceTimersByTimeAsync(350);
  return document.querySelector<HTMLElement>(".sr")!;
}

const item = (label: string) =>
  [...document.querySelectorAll<HTMLButtonElement>(".ctx-item")].find((b) => b.textContent === label)!;
const labels = () => [...document.querySelectorAll<HTMLButtonElement>(".ctx-item")].map((b) => b.textContent);
const rightClick = (el: Element) =>
  el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: 10, clientY: 20 }));
const saved = () => JSON.parse(localStorage.getItem("stockbar.settings.v1")!);

describe("设置窗口：搜索结果右键", () => {
  beforeEach(boot);

  it("搜出的标的右键给「加入自选 / 加入并移入分组」", async () => {
    const row = await search();
    expect(row.textContent).toContain("赤峰黄金");
    rightClick(row);
    expect(labels()).toEqual(["加入自选", "加入并移入「持仓」"]);
  });

  it("「加入并移入分组」写进设置、行变成已添加，再右键给的是移入分组与置顶", async () => {
    await search();
    // 结果列表每次动作后都会重画，行要重新取
    const row = () => document.querySelector<HTMLElement>(".sr")!;

    rightClick(row());
    item("加入并移入「持仓」").click();

    const first = saved();
    expect(first.watchlist).toContain("1.600988");
    expect(first.groupOf).toEqual({ "1.600988": "g1" });
    // 结果列表留着：菜单收起，行当场变成「已添加」
    expect(document.querySelector(".ctx-menu")).toBeNull();
    expect(row().querySelector(".sr-add")!.textContent).toBe("已添加");

    // 已经是自选了：给「移入别的分组」与「置顶」
    rightClick(row());
    expect(labels()).toEqual(["移入「未分组」", "置顶"]);

    item("置顶").click();
    const pinned = saved();
    expect(pinned.pins).toEqual(["1.600988"]);
    expect(pinned.watchlist[0]).toBe("1.600988"); // 置顶的排到最前

    rightClick(row());
    expect(labels()).toEqual(["移入「未分组」", "取消置顶"]);
  });

  it("左键点结果照旧加入自选并收起结果", async () => {
    const row = await search();
    row.querySelector<HTMLElement>(".sr-add")!.click();
    expect(saved().watchlist).toContain("1.600988");
    expect(document.querySelector("#add-results")!.classList.contains("show")).toBe(false);
    expect(document.querySelector<HTMLInputElement>("#add-input")!.value).toBe("");
  });

  it("搜索结果里的指数（大盘）不给右键菜单", async () => {
    // 搜「上证指数」返回的正是内置的 1.000001：它不能被加进自选，也就没有菜单
    const row = await search("上证指数");
    row.dataset.id = "1.000001";
    rightClick(row);
    expect(document.querySelector(".ctx-menu")).toBeNull();
  });

  it("别的右键菜单点掉时，搜索结果照旧收起（只有搜索菜单自己留在原地）", async () => {
    const results = document.querySelector<HTMLElement>("#add-results")!;
    // 模拟自选行那种普通菜单：不挂 ctx-search
    const menu = document.createElement("div");
    menu.className = "ctx-menu";
    menu.innerHTML = `<button class="ctx-item" data-i="0">删除自选</button>`;
    document.body.append(menu);
    results.classList.add("show");

    menu.querySelector<HTMLElement>(".ctx-item")!.click();
    expect(results.classList.contains("show")).toBe(false);
    menu.remove();
  });

  it("指数（大盘）左键也加不进自选，只给一句提示", async () => {
    const row = await search("上证指数");
    row.dataset.id = "1.000001";
    row.querySelector<HTMLElement>(".sr-add")!.click();
    expect(saved().watchlist).not.toContain("1.000001");
    expect(document.querySelector("#mhint")!.textContent).toBe("大盘指数不能加入自选");
  });
});

/** 起一个设置窗口（与 settings.html 一致），设置内容由用例给 */
async function bootWith(raw: Record<string, unknown>) {
  vi.resetModules();
  localStorage.clear();
  localStorage.setItem("stockbar.settings.v1", JSON.stringify(raw));
  document.body.innerHTML = '<div id="prefs" class="prefs"></div>';
  vi.useFakeTimers();
  await import("./prefs");
}

/** 在某个元素上派发一次指针事件（happy-dom 量不出布局，只用来跑通接线） */
const pointer = (el: Element, type: string, x: number, buttons = 1) =>
  el.dispatchEvent(
    new PointerEvent(type, { bubbles: true, button: 0, buttons, pointerId: 1, clientX: x, clientY: 0 }),
  );

// 行情页的分组胶囊：顺序展示 + 拖动（键盘 Alt + ←/→）调整顺序
describe("设置窗口：分组胶囊", () => {
  /** 三个分组、只数各不同：未分组 1 只、持仓 2 只、关注与观察池 0 只 */
  const RAW = {
    watchlist: ["1.600519", "0.300750", "116.00700"],
    selected: "1.600519",
    bar: ["1.600519"],
    groups: [
      { id: "g1", name: "持仓" },
      { id: "g2", name: "关注" },
      { id: "g3", name: "观察池" },
    ],
    groupOf: { "0.300750": "g1", "116.00700": "g1" },
  };

  const chips = () => [...document.querySelectorAll<HTMLElement>("#gchip-list .gchip")];
  const gids = () => chips().map((c) => c.dataset.gid);
  const order = () => saved().groups.map((g: { id: string }) => g.id);
  /** 鼠标从第 i 颗胶囊按下、拖到 x 再松手（happy-dom 量不出布局，落点恒为最后一格） */
  const dragChip = (i: number, x = 400) => {
    const chip = chips()[i];
    pointer(chip, "pointerdown", 10);
    pointer(chip, "pointermove", x);
    pointer(chip, "pointerup", x, 0);
  };

  beforeEach(() => bootWith(RAW));

  it("按分组顺序铺一排胶囊，未分组固定在最前且带只数", () => {
    expect(document.querySelector("#gchips")!.hasAttribute("hidden")).toBe(false);
    expect(gids()).toEqual(["g1", "g2", "g3"]);
    expect(chips().map((c) => c.textContent)).toEqual(["持仓2", "关注0", "观察池0"]);
    expect(document.querySelector("#gchip-un")!.textContent).toBe("1");
    // 未分组画在拖动容器之外：它固定在最前，拖不走
    expect(document.querySelectorAll("#gchip-list .gchip.fixed")).toHaveLength(0);
  });

  it("Alt + → 把分组往后挪一位，顺序写回设置并重画胶囊", () => {
    chips()[0].dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", altKey: true, bubbles: true }),
    );
    expect(order()).toEqual(["g2", "g1", "g3"]);
    expect(gids()).toEqual(["g2", "g1", "g3"]);
  });

  it("点胶囊不改顺序：只把对应分组带进视野并闪一下", () => {
    chips()[1].click();
    expect(order()).toEqual(["g1", "g2", "g3"]);
    expect(document.querySelector('.gsec-head[data-gid="g2"]')!.classList.contains("flash")).toBe(true);
  });

  it("鼠标把胶囊拖到后面，顺序写回设置，拖动尾巴那一下 click 不算跳转", () => {
    dragChip(0);
    expect(order()).toEqual(["g2", "g3", "g1"]);
    expect(gids()).toEqual(["g2", "g3", "g1"]);
    chips()[2].click(); // 拖完松手浏览器还会跟一个 click
    expect(document.querySelector(".gsec-head.flash")).toBeNull();
  });

  it("只按下没挪动就松手：顺序不动，随后的 click 照常跳到这个分组", () => {
    const chip = chips()[1];
    pointer(chip, "pointerdown", 10);
    pointer(chip, "pointerup", 10, 0);
    expect(order()).toEqual(["g1", "g2", "g3"]);
    chip.click();
    expect(document.querySelector('.gsec-head[data-gid="g2"]')!.classList.contains("flash")).toBe(true);
  });

  it("拖完过一会儿再点固定胶囊（未分组）照样跳过去：拖动标记只在那一下 click 里有效", () => {
    dragChip(0);
    vi.advanceTimersByTime(600); // 时间窗过去了，这一下就是普通点击
    document.querySelector<HTMLElement>(".gchip.fixed")!.click();
    expect(document.querySelector('.gsec-head[data-gid=""]')!.classList.contains("flash")).toBe(true);
  });

  it("没建过分组时整排不出现（没有可排序的胶囊）", async () => {
    await bootWith({ ...RAW, groups: [], groupOf: {} });
    expect(document.querySelector("#gchips")!.hasAttribute("hidden")).toBe(true);
    expect(chips()).toEqual([]);
  });
});

// 竖排列表（自选行）的拖动标记语义：从把手按下、又没挪动的那一下 click 不该被当成勾选行
describe("设置窗口：自选行的拖动把手", () => {
  const row = (id: string) => document.querySelector<HTMLElement>(`.stock[data-id="${id}"]`)!;

  beforeEach(() => bootWith({ watchlist: ["1.600519", "0.300750"], selected: "1.600519", bar: [] }));

  it("按下把手没挪动就松手：只算点把手，不勾选这一行", () => {
    const handle = row("1.600519").querySelector<HTMLElement>(".stock-handle")!;
    pointer(handle, "pointerdown", 10);
    pointer(handle, "pointerup", 10, 0);
    row("1.600519").click(); // 指针捕获会把松手那一下 click 派到整行上，光看 target 认不出把手
    expect(row("1.600519").classList.contains("picked")).toBe(false);
    expect(document.querySelector("#sel-count")!.textContent).toBe("0");
  });

  it("直接点行才是勾选", () => {
    row("0.300750").click();
    expect(row("0.300750").classList.contains("picked")).toBe(true);
    expect(document.querySelector("#sel-count")!.textContent).toBe("1");
  });
});
