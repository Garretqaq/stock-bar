// 日K的纯逻辑：两种接口返回的解析、均线、纵轴范围、悬停下标换算。
// 联网在 api.ts 的 fetchKline，绘制在 main.ts 的 drawKline，这里不碰 DOM。

/** 一屏显示的K线根数：约三个月。不满这么多根时靠右对齐（见 barIndexAt） */
export const KLINE_COUNT = 60;

/** 均线窗口：MA5 / MA10 / MA20 */
export const MA_WINDOWS = [5, 10, 20] as const;

export interface KlineBar {
  /** "2026-11-10" */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  vol: number | null;
}

export interface KlineData {
  secid: string;
  name: string;
  bars: KlineBar[];
}

/** 东方财富在无数据时返回 "-"，这里一并当成缺失（与 api.ts 的 num() 同一条规则） */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v !== "" && v !== "-") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** 开高低收缺任何一个的那一根没法画，直接跳过（均线也就不算它） */
function makeBar(date: string, o: unknown, c: unknown, h: unknown, l: unknown, v: unknown): KlineBar | null {
  const open = num(o);
  const close = num(c);
  const high = num(h);
  const low = num(l);
  if (open == null || close == null || high == null || low == null) return null;
  return { date, open, high, low, close, vol: num(v) };
}

/**
 * 东财日K：push2his.eastmoney.com/api/qt/stock/kline/get（klt=101 日线、fqt=1 前复权）。
 * klines 每行是「日期,开,收,高,低,成交量,成交额,振幅,涨跌幅,涨跌额,换手率」。
 */
export function parseKlineEastmoney(secid: string, json: any): KlineData {
  const d = json?.data;
  const rows: unknown[] = Array.isArray(d?.klines) ? d.klines : [];
  const bars: KlineBar[] = [];
  for (const row of rows) {
    // 字段：日期,开,收,高,低,量,额,…
    const f = String(row).split(",");
    const b = makeBar(f[0] ?? "", f[1], f[2], f[3], f[4], f[5]);
    if (b) bars.push(b);
  }
  return {
    secid,
    name: String(d?.name ?? ""),
    bars: bars.slice(-KLINE_COUNT),
  };
}

/**
 * 腾讯日K：web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=<code>,day,,,<n>,qfq
 * 每行是「日期,开,收,高,低,量[,…]」。前复权时数组键名是 `qfqday`，
 * 不复权（以及港股那种走自己接口的）是 `day`，两种都要认。
 * 名称取自同一份响应里的 qt 第 2 列。
 */
export function parseKlineTencent(secid: string, json: any, code: string): KlineData {
  const node = json?.data?.[code];
  const rows: unknown[] = Array.isArray(node?.qfqday)
    ? node.qfqday
    : Array.isArray(node?.day)
      ? node.day
      : [];
  const bars: KlineBar[] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const b = makeBar(String(row[0] ?? ""), row[1], row[2], row[3], row[4], row[5]);
    if (b) bars.push(b);
  }
  const qt = node?.qt?.[code];
  return {
    secid,
    name: Array.isArray(qt) ? String(qt[1] ?? "") : "",
    bars: bars.slice(-KLINE_COUNT),
  };
}

/**
 * 简单移动平均。带 null 的窗口整段算不出来（那一格也是 null）：
 * 缺值的那根既不充当分子，也不让前后几根变成「少算一根」的假均线。
 */
export function movingAvg(values: (number | null)[], window: number): (number | null)[] {
  const out: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i + 1 < window) {
      out.push(null);
      continue;
    }
    let sum = 0;
    let ok = true;
    for (let k = i - window + 1; k <= i; k++) {
      const v = values[k];
      if (v == null) {
        ok = false;
        break;
      }
      sum += v;
    }
    out.push(ok ? sum / window : null);
  }
  return out;
}

/**
 * 纵轴范围：K 线的高低点与三条均线的值一起取，上下各留 6% 余量。
 * 均线要算进来 —— MA20 在下跌行情里会落在最低价下方，不带着取就会被裁掉。
 */
export function klineRange(
  bars: KlineBar[],
  mas: (number | null)[][],
): { lo: number; hi: number } {
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of bars) {
    if (b.low < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
  }
  for (const s of mas) {
    for (const v of s) {
      if (v == null) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return { lo: 0, hi: 1 };
  const pad = (hi - lo) * 0.06 || Math.max(Math.abs(hi) * 0.01, 0.01);
  return { lo: lo - pad, hi: hi + pad };
}

/**
 * 第 i 根落在哪一格。横轴永远按 `total` 格铺：新股只有 30 根就靠右占后 30 格、左边留白，
 * 蜡烛宽度才不会因为只有几根被拉粗。绘制与悬停换算都用这一个算式。
 */
export function barSlot(i: number, count: number, total = KLINE_COUNT): number {
  return total - count + i;
}

/** 指针横坐标 → 第几根K线（barSlot 的反向），越界钳到首尾 */
export function barIndexAt(
  px: number,
  left: number,
  width: number,
  count: number,
  total = KLINE_COUNT,
): number {
  if (count <= 0) return 0;
  const slotW = width / Math.max(total, 1);
  const slot = Math.floor((px - left) / slotW);
  return Math.min(Math.max(slot - barSlot(0, count, total), 0), count - 1);
}

/** 这一根相对上一根收盘的涨跌幅；第一根（或上一根收盘为 0）没有 */
export function barPct(bars: KlineBar[], i: number): number | null {
  const prev = bars[i - 1]?.close;
  const cur = bars[i]?.close;
  if (prev == null || cur == null || prev === 0) return null;
  return (cur / prev - 1) * 100;
}

/**
 * 一根蜡烛实体的位置与高度：从开收里较高的那个画到较低的，至少 1px。
 * 高度必须用「两个价格各自映射出来的像素差」，不能借布局常量 —— 那样每根都会被画成
 * 从自身顶部往下几十像素的粗柱子，压掉真实的开收位置（这个 bug 真的发生过）。
 */
export function candleBox(
  open: number,
  close: number,
  yOf: (v: number) => number,
): { top: number; height: number } {
  const a = yOf(Math.max(open, close));
  const b = yOf(Math.min(open, close));
  return { top: Math.min(a, b), height: Math.max(1, Math.abs(b - a)) };
}
