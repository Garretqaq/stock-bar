// 日K的纯逻辑：解析东财 / 腾讯两种返回、均线、纵轴范围、悬停下标换算。
// 绘图与接线在 main.test.ts 里验。
import { describe, expect, it } from "vitest";
import {
  KLINE_COUNT,
  barIndexAt,
  barPct,
  barSlot,
  candleBox,
  klineRange,
  movingAvg,
  parseKlineEastmoney,
  parseKlineTencent,
  type KlineBar,
} from "./kline";

const bar = (close: number, low = close, high = close): KlineBar => ({
  date: "2026-11-10",
  open: close,
  high,
  low,
  close,
  vol: null,
});

describe("东财日K解析", () => {
  it("按「日期,开,收,高,低,量」解析，名称取自 data.name", () => {
    const got = parseKlineEastmoney("1.600519", {
      data: {
        name: "贵州茅台",
        klines: [
          "2026-11-10,1438.23,1439.00,1444.50,1431.26,23038",
          "2026-11-11,1445.00,1402.30,1445.62,1402.00,39848",
        ],
      },
    });

    expect(got.name).toBe("贵州茅台");
    expect(got.secid).toBe("1.600519");
    expect(got.bars).toEqual([
      { date: "2026-11-10", open: 1438.23, close: 1439, high: 1444.5, low: 1431.26, vol: 23038 },
      { date: "2026-11-11", open: 1445, close: 1402.3, high: 1445.62, low: 1402, vol: 39848 },
    ]);
  });

  it("四个价格里缺任何一个的那一根跳过（东财没数据时给 \"-\"）", () => {
    const got = parseKlineEastmoney("1.600519", {
      data: {
        klines: [
          "2026-11-10,1438.23,1439.00,1444.50,1431.26,23038",
          "2026-11-11,-,-,-,-,0",
          "2026-11-12,1395.13,1403.42,1411.00,1388.11,25495",
        ],
      },
    });

    expect(got.bars.map((b) => b.date)).toEqual(["2026-11-10", "2026-11-12"]);
  });

  it("接口给了多于 60 根时只留最近 60 根", () => {
    const klines = Array.from({ length: 80 }, (_, i) => `${20260100 + i},1,1,1,1,0`);
    const got = parseKlineEastmoney("0.300750", { data: { klines } });

    expect(got.bars).toHaveLength(KLINE_COUNT);
    expect(got.bars[0].date).toBe(klines[80 - KLINE_COUNT].split(",")[0]);
  });

  it("没有 data / 没有 klines：给空表，不抛", () => {
    expect(parseKlineEastmoney("1.600519", {}).bars).toEqual([]);
    expect(parseKlineEastmoney("1.600519", { data: { klines: [] } }).bars).toEqual([]);
  });
});

describe("腾讯日K解析", () => {
  const json = (key: string) => ({
    data: {
      sh600519: {
        [key]: [
          ["2026-11-10", "1438.230", "1439.000", "1444.500", "1431.260", "23038.000"],
          ["2026-11-11", "1445.000", "1402.300", "1445.620", "1402.000", "39848"],
        ],
        qt: { sh600519: ["1", "贵州茅台", "600519"] },
      },
    },
  });

  it("前复权时键名是 qfqday、不复权是 day，两种都认", () => {
    for (const key of ["qfqday", "day"]) {
      const got = parseKlineTencent("1.600519", json(key), "sh600519");
      expect(got.bars).toHaveLength(2);
      expect(got.bars[1]).toEqual({
        date: "2026-11-11",
        open: 1445,
        close: 1402.3,
        high: 1445.62,
        low: 1402,
        vol: 39848,
      });
    }
  });

  it("名称取自 qt 的第 2 列", () => {
    expect(parseKlineTencent("1.600519", json("qfqday"), "sh600519").name).toBe("贵州茅台");
  });

  it("行里的数字缺失就跳过那一根", () => {
    const got = parseKlineTencent(
      "1.600519",
      {
        data: {
          sh600519: {
            qfqday: [["2026-11-11", "1445.000", "", "1445.620", "1402.000", "1"]],
            qt: { sh600519: ["1", "贵州茅台"] },
          },
        },
      },
      "sh600519",
    );
    expect(got.bars).toEqual([]);
  });
});

describe("均线", () => {
  it("窗口内的收盘价平均；不够窗口的前几根是 null", () => {
    expect(movingAvg([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("缺值的点不参与均线（那一根自己也是 null）", () => {
    expect(movingAvg([1, null, 3, 4], 2)).toEqual([null, null, null, 3.5]);
  });
});

describe("纵轴范围", () => {
  it("取 K 线的高低点与均线值的并集，再各留 6% 余量", () => {
    const bars = [bar(12, 10, 15), bar(18, 14, 20)];
    const got = klineRange(bars, [[16]]);

    expect(got.lo).toBeCloseTo(10 - (20 - 10) * 0.06);
    expect(got.hi).toBeCloseTo(20 + (20 - 10) * 0.06);
  });

  it("完全没有数据时不返回 NaN", () => {
    const got = klineRange([], []);
    expect(Number.isFinite(got.lo)).toBe(true);
    expect(Number.isFinite(got.hi)).toBe(true);
    expect(got.hi).toBeGreaterThan(got.lo);
  });
});

describe("悬停下标换算", () => {
  const W = 300;
  const LEFT = 2;

  it("不满 60 根时落在最后几格（barSlot 与 barIndexAt 互逆）", () => {
    expect(barSlot(0, 30)).toBe(30);
    expect(barSlot(29, 30)).toBe(59);
    expect(barSlot(0, 60)).toBe(0);
  });

  it("不满 60 根时靠右对齐：最左边那一格属于第一根", () => {
    // 30 根占右半边（第 30~59 格）：左半边留给空白
    expect(barIndexAt(LEFT, LEFT, W, 30)).toBe(0);
    expect(barIndexAt(LEFT + (W / KLINE_COUNT) * 31, LEFT, W, 30)).toBe(1);
  });

  it("指到最后一格换算成最后一根，越界钳住", () => {
    expect(barIndexAt(LEFT + W, LEFT, W, 30)).toBe(29);
    expect(barIndexAt(LEFT - 50, LEFT, W, 30)).toBe(0);
    expect(barIndexAt(LEFT + W * 2, LEFT, W, 60)).toBe(59);
  });
});

describe("单根涨跌幅", () => {
  it("与上一根收盘价比；第一根没有上一根", () => {
    const bars = [bar(10), { ...bar(11), close: 11 }];
    expect(barPct(bars, 0)).toBeNull();
    expect(barPct(bars, 1)).toBeCloseTo(10);
  });

  it("上一根收盘是 0 时不算（不显示 inf）", () => {
    expect(barPct([bar(0), bar(5)], 1)).toBeNull();
  });
});

describe("蜡烛实体的几何", () => {
  // 纵轴把价格映射成像素：100 - 价格（越高像素越小）
  const yOf = (v: number) => 100 - v;

  it("实体从开收里较高的那个画到较低的，高度只跟两者之差有关", () => {
    expect(candleBox(10, 5, yOf)).toEqual({ top: 90, height: 5 });
    expect(candleBox(5, 10, yOf)).toEqual({ top: 90, height: 5 });
  });

  it("开收相同（平盘）也留 1px，不然那一根什么都看不到", () => {
    expect(candleBox(10, 10, yOf)).toEqual({ top: 90, height: 1 });
  });
});
