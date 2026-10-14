import { beforeEach, describe, expect, it } from "vitest";
import {
  BAR_MAX,
  DEFAULTS,
  STORE_KEY,
  addToBar,
  clampBlock,
  loadSettings,
  loadTickerPos,
  moveItem,
  normalizePins,
  pinCount,
  pinItem,
  saveSettings,
  saveTickerPos,
  unpinItem,
} from "./settings";

const put = (v: unknown) => localStorage.setItem(STORE_KEY, typeof v === "string" ? v : JSON.stringify(v));

describe("loadSettings", () => {
  beforeEach(() => localStorage.clear());

  it("空存储返回默认值", () => {
    expect(loadSettings()).toEqual(DEFAULTS);
  });

  it("损坏的 JSON 按默认值处理", () => {
    put("{not json");
    expect(loadSettings()).toEqual(DEFAULTS);
  });

  it("旧版 pinned 迁移为 bar 列表", () => {
    put({ watchlist: ["0.300750"], pinned: "0.300750" });
    const s = loadSettings();
    expect(s.bar).toEqual(["0.300750"]);
    expect("pinned" in s).toBe(false);
  });

  it("旧版 pinned 为空时 bar 为空", () => {
    put({ watchlist: ["0.300750"], pinned: null });
    expect(loadSettings().bar).toEqual([]);
  });

  it("bar 只保留自选或大盘指数，且不超过 BAR_MAX", () => {
    put({ watchlist: ["1.600519", "0.300750"], bar: ["9.999", "1.000001", "1.600519", "0.300750", "0.399001"] });
    const s = loadSettings();
    expect(s.bar).toEqual(["1.000001", "1.600519", "0.300750"]);
    expect(s.bar.length).toBeLessThanOrEqual(BAR_MAX);
  });

  it("barFields 为空时恢复默认字段", () => {
    put({ barFields: [] });
    expect(loadSettings().barFields).toEqual(DEFAULTS.barFields);
  });

  it("saveSettings 写入后能原样读回", () => {
    const s = { ...DEFAULTS, interval: 30, theme: "dark" as const };
    saveSettings(s);
    expect(loadSettings()).toEqual(s);
  });
  it("置顶的排到最前，pins 里已不在自选的 id 丢掉", () => {
    put({ watchlist: ["a", "b", "c"], pins: ["c", "zzz"] });
    const s = loadSettings();
    expect(s.watchlist).toEqual(["c", "a", "b"]);
    expect(s.pins).toEqual(["c"]);
  });

  it("pins 不是数组时按空处理，自选顺序保持原样", () => {
    put({ watchlist: ["a", "b"], pins: "bad" });
    const s = loadSettings();
    expect(s.watchlist).toEqual(["a", "b"]);
    expect(s.pins).toEqual([]);
  });

});

describe("悬浮行情条位置", () => {
  beforeEach(() => localStorage.clear());

  it("旧数据没有 ticker 字段时默认开启", () => {
    put({ watchlist: ["1.600519"] });
    expect(loadSettings().ticker).toBe(true);
  });

  it("未保存时返回 null", () => {
    expect(loadTickerPos()).toBeNull();
  });

  it("保存后读回取整坐标，支持副屏负坐标", () => {
    saveTickerPos(-1200.4, 860.6);
    expect(loadTickerPos()).toEqual({ x: -1200, y: 861 });
  });

  it("损坏或缺字段的数据按 null 处理", () => {
    localStorage.setItem("stockbar.ticker.pos", "{bad");
    expect(loadTickerPos()).toBeNull();
    localStorage.setItem("stockbar.ticker.pos", JSON.stringify({ x: 1 }));
    expect(loadTickerPos()).toBeNull();
  });

  it("位置不写入设置存储（拖动不触发设置同步）", () => {
    saveTickerPos(10, 20);
    expect(localStorage.getItem(STORE_KEY)).toBeNull();
  });
});

describe("addToBar", () => {
  it("按传入顺序填满剩余名额，放不下的进 overflow", () => {
    const r = addToBar(["1.600519"], ["0.300750", "116.00700", "105.NVDA"], 3);
    expect(r.bar).toEqual(["1.600519", "0.300750", "116.00700"]);
    expect(r.added).toEqual(["0.300750", "116.00700"]);
    expect(r.overflow).toEqual(["105.NVDA"]);
  });

  it("已在菜单栏里的标的跳过，且不算放不下", () => {
    const r = addToBar(["1.600519"], ["1.600519", "0.300750"], 3);
    expect(r.added).toEqual(["0.300750"]);
    expect(r.overflow).toEqual([]);
  });

  it("名额已满时全部进 overflow", () => {
    const r = addToBar(["a", "b", "c"], ["d"], 3);
    expect(r.bar).toEqual(["a", "b", "c"]);
    expect(r.added).toEqual([]);
    expect(r.overflow).toEqual(["d"]);
  });

  it("不改动传入的原列表", () => {
    const bar = ["a"];
    addToBar(bar, ["b"]);
    expect(bar).toEqual(["a"]);
  });
});

describe("moveItem", () => {
  it("向后移动", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("向前移动", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("原地不动或越界时原样返回副本", () => {
    const list = ["a", "b"];
    expect(moveItem(list, 1, 1)).toEqual(list);
    expect(moveItem(list, 0, 5)).toEqual(list);
    expect(moveItem(list, -1, 0)).toEqual(list);
    expect(moveItem(list, 0, 1)).not.toBe(list);
  });
});

describe("置顶", () => {
  it("pinCount 只数开头连续被置顶的", () => {
    expect(pinCount(["a", "b", "c"], ["a", "b"])).toBe(2);
    expect(pinCount(["a", "b", "c"], ["b"])).toBe(0);
    expect(pinCount([], ["a"])).toBe(0);
  });

  it("pinItem 把标的挪到最前并记进 pins", () => {
    const r = pinItem(["a", "b", "c"], [], "c");
    expect(r.list).toEqual(["c", "a", "b"]);
    expect(r.pins).toEqual(["c"]);
  });

  it("pinItem 对已置顶或不在自选里的 id 原样返回副本", () => {
    const list = ["a", "b"];
    const pins = ["a"];
    expect(pinItem(list, pins, "a")).toEqual({ list, pins });
    expect(pinItem(list, pins, "zzz")).toEqual({ list, pins });
    expect(pinItem(list, pins, "a").list).not.toBe(list);
  });

  it("unpinItem 落到置顶区之后的第一位", () => {
    // a、b 置顶；取消 a 后 a 落在还置顶着的 b 后面
    const r = unpinItem(["a", "b", "c"], ["a", "b"], "a");
    expect(r.list).toEqual(["b", "a", "c"]);
    expect(r.pins).toEqual(["b"]);
  });

  it("unpinItem 对没置顶的 id 原样返回副本", () => {
    const list = ["a", "b"];
    const r = unpinItem(list, [], "a");
    expect(r.list).toEqual(list);
    expect(r.list).not.toBe(list);
  });

  it("normalizePins 把置顶的排到最前并清掉失效 id", () => {
    const r = normalizePins(["a", "b", "c"], ["c", "zzz"]);
    expect(r.list).toEqual(["c", "a", "b"]);
    expect(r.pins).toEqual(["c"]);
  });

  it("clampBlock：置顶的只能在置顶区里挪", () => {
    const list = ["a", "b", "c", "d"];
    const pins = ["a", "b"];
    expect(clampBlock(list, pins, 0, 3)).toBe(1); // 置顶的往下最多到置顶区末尾
    expect(clampBlock(list, pins, 1, 0)).toBe(0);
    expect(clampBlock(list, pins, 3, 0)).toBe(2); // 非置顶的往上最多到置顶区之后
    expect(clampBlock(list, pins, 2, 3)).toBe(3);
  });

  it("clampBlock：没有置顶时只受列表边界限制", () => {
    const list = ["a", "b", "c"];
    expect(clampBlock(list, [], 2, 0)).toBe(0);
    expect(clampBlock(list, [], 0, 2)).toBe(2);
  });

  it("clampBlock：全都置顶时可以在整列里挪", () => {
    const list = ["a", "b", "c"];
    const pins = ["a", "b", "c"];
    expect(clampBlock(list, pins, 0, 2)).toBe(2);
    expect(clampBlock(list, pins, 2, 0)).toBe(0);
  });
});
