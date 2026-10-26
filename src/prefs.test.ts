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

  it("从把手拖到置顶行上面：跨过分界就顺手置顶（顺序与 pins 一起写回）", async () => {
    await bootWith({
      watchlist: ["1.600519", "0.300750", "116.00700"],
      selected: "1.600519",
      bar: [],
      pins: ["1.600519"],
    });
    const handle = row("0.300750").querySelector<HTMLElement>(".stock-handle")!;
    pointer(handle, "pointerdown", 10); // 把手起拖按下即算，不等「按住」
    // 落点只看指针的 y（happy-dom 量不出布局）：负值 = 拖到列表上方，落在第 0 格
    handle.dispatchEvent(
      new PointerEvent("pointermove", { bubbles: true, button: 0, buttons: 1, pointerId: 1, clientX: 10, clientY: -20 }),
    );
    pointer(handle, "pointerup", 10, 0);

    expect(saved().watchlist).toEqual(["0.300750", "1.600519", "116.00700"]);
    expect(saved().pins).toEqual(["0.300750", "1.600519"]); // 拖进置顶区，顺手顶上
    expect(row("0.300750").classList.contains("pinned")).toBe(true);
  });
});

describe("设置窗口：提醒页的标的选择框", () => {
  // 自选里只有茅台，报价是空的 —— 名字退回代码，正好用来验「代码也能搜」
  beforeEach(async () => {
    await boot();
    document.querySelector<HTMLElement>('.nav-item[data-page="alerts"]')!.click();
  });

  const input = () => document.querySelector<HTMLInputElement>("#alert-target")!;
  const items = () => [...document.querySelectorAll<HTMLElement>(".alert-pick-item")];
  const listHidden = () => document.querySelector<HTMLElement>("#alert-pick-list")!.hidden;
  const savedAlerts = () => (saved().alerts ?? []) as { secid: string; kind: string; op: string; value: number }[];

  /** 聚焦 → 摊开列表（等价于用户点一下输入框） */
  const open = () => input().dispatchEvent(new Event("focus"));
  /** 往输入框里敲字 */
  const type = (kw: string) => {
    input().value = kw;
    input().dispatchEvent(new Event("input"));
  };

  it("聚焦就摊开全部可选标的：三只大盘指数 + 自选（板块不是标的，不在这里）", () => {
    open();
    expect(listHidden()).toBe(false);
    expect(items()).toHaveLength(4);
    expect(items()[0].textContent).toContain("上证指数");
  });

  it("打字即筛（代码也认），点一项就选中并收起，输入框显示「名称（代码）」", () => {
    open();
    type("6005");
    expect(items()).toHaveLength(1);
    items()[0].click();
    expect(input().value).toBe("600519（600519）");
    expect(listHidden()).toBe(true);
  });

  it("搜不到时给一句说明，不是空白一片", () => {
    open();
    type("没有这只");
    expect(items()).toHaveLength(0);
    expect(document.querySelector(".alert-pick-empty")!.textContent).toContain("没有匹配的标的");
  });

  it("选好标的、填上阈值，添加规则写进设置", () => {
    open();
    type("6005");
    items()[0].click();
    document.querySelector<HTMLInputElement>("#alert-value")!.value = "1500";
    document.querySelector<HTMLElement>("#alert-add")!.click();
    expect(savedAlerts()).toHaveLength(1);
    expect(savedAlerts()[0]).toMatchObject({ secid: "1.600519", kind: "price", op: "below", value: 1500 });
    // 加完清空阈值，方便接着加下一条
    expect(document.querySelector<HTMLInputElement>("#alert-value")!.value).toBe("");
  });
});

describe("设置窗口：修改已有的提醒规则", () => {
  // 起一份已经有两规则的设置：a1 价格跌破 1500（开着）、a2 涨超 5%（关着）
  beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem(
      "stockbar.settings.v1",
      JSON.stringify({
        watchlist: ["1.600519"],
        selected: "1.600519",
        bar: ["1.600519"],
        alerts: [
          { id: "a1", secid: "1.600519", kind: "price", op: "below", value: 1500, enabled: true },
          { id: "a2", secid: "1.600519", kind: "pct", op: "above", value: 5, enabled: false },
        ],
      }),
    );
    document.body.innerHTML = '<div id="prefs" class="prefs"></div>';
    vi.useFakeTimers();
    await import("./prefs");
    document.querySelector<HTMLElement>('.nav-item[data-page="alerts"]')!.click();
  });

  const value = () => document.querySelector<HTMLInputElement>("#alert-value")!;
  const title = () => document.querySelector("#alert-form-title")!.textContent;
  const addBtn = () => document.querySelector<HTMLElement>("#alert-add")!;
  const row = (id: string) => document.querySelector<HTMLElement>(`.alert-item[data-id="${id}"]`)!;
  const editRow = (id: string) => row(id).querySelector<HTMLElement>(".alert-edit")!.click();
  const savedAlerts = () =>
    saved().alerts as { id: string; kind: string; op: string; value: number; enabled: boolean }[];

  it("点行尾的笔把那条装进表单：标题变「修改规则」，阈值是原来那个数", () => {
    editRow("a1");
    expect(title()).toBe("修改规则");
    expect(value().value).toBe("1500");
    expect(row("a1").classList.contains("editing")).toBe(true);
    expect(addBtn().textContent).toContain("保存修改");
  });

  it("改阈值后保存：就地更新那一条，id 与位置都不动，表单退回「新建」", () => {
    editRow("a1");
    value().value = "1200";
    addBtn().click();
    const list = savedAlerts();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: "a1", kind: "price", op: "below", value: 1200, enabled: true });
    expect(list[1].id).toBe("a2");
    expect(title()).toBe("新建规则");
    expect(value().value).toBe("");
    expect(row("a1").classList.contains("editing")).toBe(false);
  });

  it("关掉的规则改完还是关着的", () => {
    editRow("a2");
    value().value = "8";
    addBtn().click();
    expect(savedAlerts()[1]).toMatchObject({ id: "a2", kind: "pct", op: "above", value: 8, enabled: false });
  });

  it("取消就退回「新建」，设置一个字段都不动", () => {
    editRow("a1");
    value().value = "999";
    document.querySelector<HTMLElement>("#alert-cancel")!.click();
    expect(title()).toBe("新建规则");
    expect(value().value).toBe("");
    expect(savedAlerts()[0].value).toBe(1500);
  });
});

// WebDAV 备份卡片：浏览器预览（happy-dom 里 IN_TAURI = false）下按钮全禁、状态与说明都能读出来。
// 真正的联网 / 加解密在应用里跑（Rust 侧 backup.rs 有自己的单测），这里只钉住接线没有写坏。
describe("设置窗口：备份卡片", () => {
  beforeEach(boot);

  const disabled = (id: string) => document.querySelector<HTMLButtonElement>(id)!.disabled;

  it("三个动作按钮都在，预览里一律禁用", () => {
    expect(document.querySelector("#dav-url")).toBeTruthy();
    expect(document.querySelector("#dav-user")).toBeTruthy();
    expect(document.querySelector("#dav-pass")).toBeTruthy();
    expect(disabled("#dav-test")).toBe(true);
    expect(disabled("#dav-backup")).toBe(true);
    expect(disabled("#dav-restore")).toBe(true);
    // 恢复的确认条默认藏着，别让人一进页面就看到「覆盖本地」
    expect(document.querySelector<HTMLElement>("#dav-confirm")!.hidden).toBe(true);
  });

  it("状态与说明写清楚当前处境", () => {
    expect(document.querySelector("#dav-state")!.textContent).toContain("还没连过");
    expect(document.querySelector("#dav-hint")!.textContent).toContain("浏览器预览");
  });

  it("地址落进设置：change 才写，末尾斜杠会被规整掉", () => {
    const url = document.querySelector<HTMLInputElement>("#dav-url")!;
    url.value = "https://dav.example.com/stockbar/  ";
    url.dispatchEvent(new Event("change"));
    expect(saved().backup.url).toBe("https://dav.example.com/stockbar");
    // 密码：预览里不加密就不落盘，明文绝不进 localStorage
    const pass = document.querySelector<HTMLInputElement>("#dav-pass")!;
    pass.value = "plain-password";
    pass.dispatchEvent(new Event("change"));
    expect(saved().backup.pass).toBe("");
  });
});
