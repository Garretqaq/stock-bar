import { describe, expect, it } from "vitest";
import type { Quote } from "./api";
import { barPct, barPrice, barText, shortName } from "./bar";
import { DEFAULTS, type Settings } from "./settings";

const q = (secid: string, name: string, price: number | null, pct: number | null): Quote => ({
  secid,
  code: secid.split(".")[1],
  market: Number(secid.split(".")[0]),
  name,
  price,
  pct,
  change: null,
  time: null,
  amount: null,
});

describe("bar 格式化", () => {
  it("shortName 最多 4 个字", () => {
    expect(shortName("贵州茅台")).toBe("贵州茅台");
    expect(shortName("宁德时代新能源")).toBe("宁德时代");
  });

  it("barPrice 按量级取小数位", () => {
    expect(barPrice(null)).toBe("--");
    expect(barPrice(0.5)).toBe("0.500");
    expect(barPrice(12.345)).toBe("12.35");
    expect(barPrice(12345.67)).toBe("12345.7");
  });

  it("barPct 带箭头 / 带符号", () => {
    expect(barPct(undefined)).toBe("--");
    expect(barPct(q("1.1", "a", 1, 1.234))).toBe("▲1.23%");
    expect(barPct(q("1.1", "a", 1, -2))).toBe("▼2.00%");
    expect(barPct(q("1.1", "a", 1, 0))).toBe("0.00%");
    expect(barPct(q("1.1", "a", 1, 1.5), false)).toBe("+1.50%");
    expect(barPct(q("1.1", "a", 1, -1.5), false)).toBe("-1.50%");
  });
});

describe("barText", () => {
  const quotes = new Map([
    ["1.600519", q("1.600519", "贵州茅台", 1500, 1)],
    ["105.NVDA", q("105.NVDA", "英伟达", 180.5, -0.5)],
  ]);
  const s = (patch: Partial<Settings>): Settings => ({ ...DEFAULTS, ...patch });

  it("多只股票用 │ 分隔，按字段拼接", () => {
    expect(barText(s({ bar: ["1.600519", "105.NVDA"] }), quotes)).toBe(
      "贵州茅台 1500.00 ▲1.00%  │  英伟达 180.50 ▼0.50%",
    );
  });

  it("只选部分字段", () => {
    expect(barText(s({ bar: ["1.600519"], barFields: ["pct"] }), quotes)).toBe("▲1.00%");
  });

  it("没有行情时用代码占位", () => {
    expect(barText(s({ bar: ["0.300750"] }), quotes)).toBe("3007 -- --");
  });

  it("仅图标样式不输出文字", () => {
    expect(barText(s({ barStyle: "icon" }), quotes)).toBe("");
  });
});
