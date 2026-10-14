// 东方财富公开行情接口封装
// secid = 市场代码.证券代码：1 沪、0 深、116 港股、105/106/107 美股、100 海外指数

const UT = "b2884a393a59ad64002292a3e90d46a5";
const SEARCH_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";
/** 只保留能识别的市场：沪/深/港/美/海外指数（过滤板块 90.BK、中证指数 2.H 等） */
const SUPPORTED_MARKETS = new Set(["0", "1", "100", "105", "106", "107", "116"]);

export interface Quote {
  secid: string;
  code: string;
  market: number;
  name: string;
  price: number | null;
  change: number | null;
  pct: number | null;
  /** 最后成交时间（Unix 秒，f124），用于识别节假日休市 */
  time: number | null;
}

export interface SearchItem {
  secid: string;
  code: string;
  name: string;
  type: string;
}

export type Region = "CN" | "HK" | "US";

/** 东方财富在无数据时返回 "-"，统一转成 null */
function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v !== "" && v !== "-") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

async function getJson(url: string): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const resp = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/** 批量报价：一次请求取回所有 secid */
export async function fetchQuotes(secids: string[]): Promise<Map<string, Quote>> {
  const ids = [...new Set(secids.filter(Boolean))];
  const out = new Map<string, Quote>();
  if (!ids.length) return out;
  const url =
    `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2` +
    `&fields=f2,f3,f4,f12,f13,f14,f124&secids=${encodeURIComponent(ids.join(","))}` +
    `&ut=${UT}&np=1&pi=0&pz=${ids.length}`;
  const json = await getJson(url);
  const diff = json?.data?.diff;
  const rows: any[] = Array.isArray(diff) ? diff : diff ? Object.values(diff) : [];
  for (const d of rows) {
    const secid = `${d.f13}.${d.f12}`;
    out.set(secid, {
      secid,
      code: String(d.f12),
      market: Number(d.f13),
      name: String(d.f14 ?? d.f12),
      price: num(d.f2),
      pct: num(d.f3),
      change: num(d.f4),
      time: num(d.f124),
    });
  }
  return out;
}

/** JSONP：搜索接口不返回 CORS 头，fetch 读不到，改用 <script> 回调（零依赖） */
let jsonpSeq = 0;
function jsonp(url: string, timeout = 8000): Promise<any> {
  return new Promise((resolve, reject) => {
    const cb = `__sb_jsonp_${Date.now()}_${jsonpSeq++}`;
    const w = window as any;
    const el = document.createElement("script");
    const done = () => {
      clearTimeout(timer);
      delete w[cb];
      el.remove();
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error("timeout"));
    }, timeout);
    w[cb] = (data: unknown) => {
      done();
      resolve(data);
    };
    el.onerror = () => {
      done();
      reject(new Error("network"));
    };
    el.src = `${url}&cb=${cb}`;
    document.head.append(el);
  });
}

/** 股票搜索（代码 / 名称 / 拼音） */
export async function searchStocks(keyword: string): Promise<SearchItem[]> {
  const url =
    `https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(keyword)}` +
    `&type=14&token=${SEARCH_TOKEN}&count=8`;
  const json = await jsonp(url);
  const list: any[] = json?.QuotationCodeTable?.Data ?? [];
  return list
    .filter((d) => d && d.QuoteID && SUPPORTED_MARKETS.has(String(d.QuoteID).split(".")[0]))
    .map((d) => ({
      secid: String(d.QuoteID),
      code: String(d.Code),
      name: String(d.Name),
      type: String(d.SecurityTypeName ?? ""),
    }));
}

// ---------- 分时图数据 ----------

export interface TrendPoint {
  time: string; // "0930" 等分钟标签
  price: number;
  avg: number | null;
  vol: number | null;
  /** 该分钟的成交额（元） */
  amount: number | null;
}

export interface TrendData {
  secid: string;
  name: string;
  preClose: number | null;
  /** 整个交易日的分钟点数（A 股 241），用于让折线随时间铺满横轴 */
  total: number | null;
  points: TrendPoint[];

  /** 当日累计成交额（元） */
  amount: number | null;
  /** 上一交易日相同时长内的累计成交额（元）；没有可比数据时为 null */
  prevAmount: number | null;
  /** 上一交易日的日期（"2026-10-13"），用来说明对比的是哪一天 */
  prevDate: string | null;
}

/** 分时原始行：带日期，用于把两天数据分开（画图只取最新一天） */
export interface TrendRawPoint extends TrendPoint {
  date: string; // "2026-10-13"
}

/**
 * 前 `count` 条的成交额之和；不传 `count` 就是全部。
 * 一条成交额都没有（字段缺失）时返回 null，调用方据此不显示。
 */
export function cumAmount(points: { amount: number | null }[], count?: number): number | null {
  let sum = 0;
  let seen = false;
  for (const p of count == null ? points : points.slice(0, count)) {
    if (p.amount == null) continue;
    sum += p.amount;
    seen = true;
  }
  return seen ? sum : null;
}

/**
 * 把分时原始行切成「最新一天作图 + 与上一日同期成交额对比」。
 * `days` 传 2 时接口返回两天：只画最新一天；成交额按分钟累加，
 * 上一日只累加到与当日同样的时长（同一天的分钟结构一致，按条数对齐即可），
 * 盘中才能直接看出放量还是缩量。目前只给 A 股大盘指数用，它们的交易日不跨自然日。
 */
export function pickTrendDay(
  raw: TrendRawPoint[],
  trendsTotal: number | null,
  days: number,
): {
  points: TrendPoint[];
  total: number;
  amount: number | null;
  prevAmount: number | null;
  prevDate: string | null;
} {
  const toPoints = (list: TrendRawPoint[]): TrendPoint[] =>
    list.map((p) => ({ time: p.time, price: p.price, avg: p.avg, vol: p.vol, amount: p.amount }));
  if (days < 2) {
    // 单日：原样交给图表，不做成交额对比
    return {
      points: toPoints(raw),
      total: Math.max(trendsTotal ?? 0, raw.length),
      amount: null,
      prevAmount: null,
      prevDate: null,
    };
  }
  // 按日期分组（接口按时间顺序返回，相邻同日期即同一天）
  const groups: TrendRawPoint[][] = [];
  for (const p of raw) {
    const cur = groups[groups.length - 1];
    if (cur && cur[0].date === p.date) cur.push(p);
    else groups.push([p]);
  }
  const last = groups[groups.length - 1] ?? [];
  const prev = groups[groups.length - 2] ?? [];
  const all = trendsTotal ?? last.length;
  // trendsTotal 是两天之和：减掉上一日的点数就是当日全天的分钟数；接口只给单日时按单日算
  const fullDay = prev.length > 0 && all > prev.length ? all - prev.length : all;
  return {
    points: toPoints(last),
    total: Math.max(last.length, fullDay),
    amount: cumAmount(last),
    // 上一日至少要走到当日同样的时长，否则（半日市、数据缺口）对比会失真
    prevAmount: prev.length >= last.length && last.length > 0 ? cumAmount(prev, last.length) : null,
    prevDate: prev.length > 0 ? prev[0].date : null,
  };
}

/**
 * 分时走势：push2his.eastmoney.com/api/qt/stock/trends2/get
 * `days` 传 2 时取两天（ndays=2）：画图仍只用最新一天，另一天用来算「与上一日同期」的成交额对比。
 */
export async function fetchTrend(secid: string, days = 1): Promise<TrendData> {
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/trends2/get?secid=${encodeURIComponent(secid)}` +
    `&fields1=f1,f2,f3,f4,f5,f6,f7,f8,f9,f10,f11,f12,f13` +
    `&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ut=${UT}&ndays=${days}&iscr=0`;
  const json = await getJson(url);
  const d = json?.data;
  const trends: string[] = Array.isArray(d?.trends) ? d.trends : [];
  const raw: TrendRawPoint[] = trends.map((line) => {
    // 字段：时间,开,收,高,低,成交量,成交额,均价；时间形如 "2026-10-13 09:30"
    const f = String(line).split(",");
    const [date, hm] = f[0].split(" ");
    return {
      date: date ?? "",
      time: (hm ?? f[0]).replace(":", "").padStart(4, "0"),
      price: num(f[2]) ?? num(f[1]) ?? 0,
      avg: num(f[7]),
      vol: num(f[5]),
      amount: num(f[6]),
    };
  });
  const day = pickTrendDay(raw, num(d?.trendsTotal), days);
  return {
    secid,
    name: String(d?.name ?? ""),
    preClose: num(d?.preClose),
    total: day.total,
    points: day.points,
    amount: day.amount,
    prevAmount: day.prevAmount,
    prevDate: day.prevDate,
  };
}

// ---------- secid 辅助 ----------

export function codeOf(secid: string): string {
  return secid.slice(secid.indexOf(".") + 1);
}

function marketOf(secid: string): string {
  return secid.slice(0, secid.indexOf("."));
}

export function marketTag(secid: string): string {
  const m = marketOf(secid);
  const c = codeOf(secid);
  switch (m) {
    case "1":
      return "SH";
    case "0":
      return /^(8|4|92)/.test(c) ? "BJ" : "SZ";
    case "116":
      return "HK";
    case "105":
    case "106":
    case "107":
      return "US";
    case "100":
      return "指数";
    default:
      return "--";
  }
}

export function regionOf(secid: string): Region {
  const m = marketOf(secid);
  if (m === "116") return "HK";
  if (m === "105" || m === "106" || m === "107") return "US";
  if (m === "100") return /^HS/i.test(codeOf(secid)) ? "HK" : "US";
  return "CN";
}

const SESSIONS: Record<Region, { tz: string; s: [number, number][] }> = {
  CN: { tz: "Asia/Shanghai", s: [[570, 690], [780, 900]] },
  HK: { tz: "Asia/Hong_Kong", s: [[570, 720], [780, 960]] },
  US: { tz: "America/New_York", s: [[570, 960]] },
};

/** 开盘后多久仍无当日成交就判定为节假日休市（分钟），留出数据延迟的余量 */
const HOLIDAY_GRACE_MIN = 10;

/** 某时刻在指定时区的日期 "YYYY-MM-DD"、星期和当日分钟数 */
function zoned(tz: string, at: Date): { date: string; wd: string; min: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    wd: get("weekday"),
    min: (Number(get("hour")) % 24) * 60 + Number(get("minute")),
  };
}

/**
 * 交易时段。没有内置节假日日历，而是用行情接口的最后成交时间 `lastTrade`（Unix 秒）推断：
 * 工作日开盘超过 HOLIDAY_GRACE_MIN 分钟后，若最后成交仍不在当日，视为节假日休市。
 * 不传 `lastTrade` 时只按星期和时钟判断。开盘前无法提前得知当天是否休市。
 */
export function sessionStatus(
  r: Region,
  now = new Date(),
  lastTrade?: number | null,
): { open: boolean; text: string } {
  const { tz, s } = SESSIONS[r];
  const cur = zoned(tz, now);
  if (cur.wd === "Sat" || cur.wd === "Sun") return { open: false, text: "休市" };
  const t = cur.min;
  if (lastTrade != null && t >= s[0][0] + HOLIDAY_GRACE_MIN) {
    const last = zoned(tz, new Date(lastTrade * 1000));
    if (last.date < cur.date) return { open: false, text: "休市" };
  }
  if (s.some(([a, b]) => t >= a && t < b)) return { open: true, text: "交易中" };
  if (t < s[0][0]) return { open: false, text: "未开盘" };
  if (t >= s[s.length - 1][1]) return { open: false, text: "已收盘" };
  return { open: false, text: "午间休市" };
}
