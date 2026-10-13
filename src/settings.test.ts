import { beforeEach, describe, expect, it } from "vitest";
import { BAR_MAX, DEFAULTS, STORE_KEY, loadSettings, loadTickerPos, saveSettings, saveTickerPos } from "./settings";

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
