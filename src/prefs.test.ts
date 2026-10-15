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
