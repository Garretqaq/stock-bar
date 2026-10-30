// 东方财富公开行情接口封装
// secid = 市场代码.证券代码：1 沪、0 深、116 港股、105/106/107 美股、100 海外指数
import { IN_TAURI, callOrThrow } from "./tauri";

const UT = "b2884a393a59ad64002292a3e90d46a5";
const SEARCH_TOKEN = "D43BF722C8E33BDC906FB84D85E326E8";
/** 只保留能识别的市场：沪/深/港/美/海外指数（过滤板块 90.BK、中证指数 2.H 等）；MCP 侧也用它校验 secid */
export const SUPPORTED_MARKETS = new Set(["0", "1", "100", "105", "106", "107", "116"]);

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
  /**
   * 当日成交额（元）。东财 f6 各市场都是元；腾讯只有 A 股的 f[37] 可信
   * （A 股是万元，已换算），其港股/海外指数的 f[37] 量纲对不上，一律给 null。
   */
  amount: number | null;
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

/**
 * 行情请求失败的原因分类，界面据此区分「源站故障」和「本地网络问题」：
 * - `server`：行情接口自己出问题——返回 5xx/4xx、返回非 JSON，或者连接被对方掐断
 * - `timeout`：超过 8 秒没有响应
 * - `network`：整条链路都不通（断网、DNS 失败、被本地代理拦截）
 */
export type ApiErrorKind = "server" | "timeout" | "network";

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  /** 仅 `kind === "server"` 且有响应时才有值 */
  readonly status: number | null;

  constructor(kind: ApiErrorKind, message: string, status: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.kind = kind;
    this.status = status;
  }
}

/** 把失败原因翻译成错误条文案；不认识的错误退回通用提示 */
export function apiErrorText(e: unknown): string {
  if (!(e instanceof ApiError)) return "行情获取失败，正在重试…";
  if (e.kind === "server") return `行情源故障${e.status ? `（HTTP ${e.status}）` : ""}，正在重试…`;
  if (e.kind === "timeout") return "请求超时，正在重试…";
  return "网络异常，正在重试…";
}

/**
 * 探活：对同一个域名的根路径发一次 no-cors 请求，只关心「有没有收到响应」。
 * no-cors 不受 CORS 头影响，所以能拿到响应就说明 DNS、连接、TLS 都是通的；
 * 探针本身失败说明是本地网络的问题。超时设短一点，别拖慢错误提示。
 */
async function hostResponds(url: string): Promise<boolean> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  try {
    await fetch(new URL(url).origin + "/", {
      mode: "no-cors",
      cache: "no-store",
      signal: ctl.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- 数据源 ----------

/**
 * 行情数据源：
 * - `eastmoney`：只用东方财富
 * - `tencent`：只用腾讯
 * - `auto`：优先东方财富，失败时自动切到腾讯
 */
export type DataSource = "auto" | "eastmoney" | "tencent";

/** 最近一次成功取到行情的实际来源：界面显示「自动」时用它说明当前走的是哪家 */
let activeSource: "eastmoney" | "tencent" | null = null;

export function getActiveSource(): "eastmoney" | "tencent" | null {
  return activeSource;
}

/**
 * 带超时与失败分类的请求，返回原始字节。
 * 不直接返回文本：东财与腾讯的 JSON 是 UTF-8，而腾讯报价接口是 GBK，得各自解码。
 */
async function getBytes(url: string): Promise<ArrayBuffer> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 8000);
  try {
    const resp = await fetch(url, { signal: ctl.signal, cache: "no-store" });
    if (!resp.ok) throw new ApiError("server", `HTTP ${resp.status}`, resp.status);
    return await resp.arrayBuffer();
  } catch (e) {
    // 上面抛出的 ApiError 直接透传，别被下面的探活逻辑重新归类
    if (e instanceof ApiError) throw e;
    // AbortError 是 8 秒超时；其余（Failed to fetch / NetworkError）要再分辨一次
    if ((e as Error | undefined)?.name === "AbortError") {
      throw new ApiError("timeout", "请求超时");
    }
    // 浏览器把「CORS 失败」「连接被掐断」「压根断网」都报成同一个 TypeError，
    // 所以探一次同域名的根路径：能收到响应就说明链路是通的，是行情接口自己挂了
    const alive = await hostResponds(url);
    throw new ApiError(alive ? "server" : "network", alive ? "行情接口无响应" : "网络异常");
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url: string): Promise<any> {
  const text = new TextDecoder().decode(await getBytes(url));
  try {
    return JSON.parse(text);
  } catch {
    // 源站返回了非 JSON（502 的 HTML 页面、空响应等），仍算源站故障
    throw new ApiError("server", "响应不是 JSON");
  }
}

/** 腾讯报价是 GBK；万一运行环境没有 gbk 解码器，退回 utf-8（只影响股票名，数值不受影响） */
function decodeGbk(buf: ArrayBuffer): string {
  try {
    return new TextDecoder("gbk").decode(buf);
  } catch {
    return new TextDecoder().decode(buf);
  }
}

async function getGbkText(url: string): Promise<string> {
  return decodeGbk(await getBytes(url));
}

// ---------- secid ↔ 腾讯代码 ----------

/**
 * 海外指数（东财 100. 市场）→ 腾讯代码。
 * 两家的代码并不同形，必须查表：腾讯的标普是 us.INX（不是 usSPX），
 * 而 usDJIA / usDJI 都指向「道琼斯ETF-Global X」这种别的标的，会显示错价格。
 * 表里没有的指数返回 null，宁可缺一条也不要显示错的价格。
 */
const INDEX_CODES: Record<string, string> = {
  HSI: "hkHSI",
  HSTECH: "hkHSTECH",
  HSCEI: "hkHSCEI",
  NDX: "usNDX",
  DJIA: "usDJI",
  SPX: "us.INX",
  IXIC: "usIXIC",
};

/**
 * 把东财 secid 转成腾讯代码。
 * 腾讯的规则：sh/sz/bj + 代码，港股 hk+5 位，美股 us+代码，海外指数查 INDEX_CODES。
 * 注意北交所在腾讯要写 bj（不是 sz），否则会返回 none_match。
 */
export function tencentCode(secid: string): string | null {
  const m = marketOf(secid);
  const c = codeOf(secid);
  switch (m) {
    case "1":
      return `sh${c}`;
    case "0":
      // 腾讯把北交所归在 bj 前缀（东财用 0. 市场 + 8/4/92 开头的代码表示）
      return /^(8|4|92)/.test(c) ? `bj${c}` : `sz${c}`;
    case "116":
      return `hk${c}`;
    case "105":
    case "106":
    case "107":
      return `us${c}`;
    case "100":
      return INDEX_CODES[c.toUpperCase()] ?? null;
    case "91":
      // 腾讯板块（91.pt01801120）：它自己的板块代码就是腾讯代码，直接拿去用
      return c;
    default:
      return null;
  }
}


// ---------- 东方财富 ----------

async function quotesFromEastmoney(ids: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const url =
    `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&invt=2` +
    `&fields=f2,f3,f4,f6,f12,f13,f14,f124&secids=${encodeURIComponent(ids.join(","))}` +
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
      // f6 是成交额（元），各市场口径一致
      amount: num(d.f6),
      time: num(d.f124),
    });
  }
  return out;
}

// ---------- 腾讯 ----------

/**
 * 腾讯报价：qt.gtimg.cn/q=<code1>,<code2>
 * 响应形如 `v_sh600519="1~贵州茅台~600519~1283.61~1274.89~...";`，按 `~` 切分后：
 * 1 名称、2 代码、3 最新价、4 昨收、30 时间、31 涨跌额、32 涨跌幅(%)。
 * 注意：接口是 GBK 编码，且一次请求的代码数有限（实测 60 个只回 47 个），所以分批请求。
 */
const TENCENT_BATCH = 20;


/**
 * 墙上时间 → Unix 秒。直接用 Date.UTC 会被当成 UTC，
 * 所以在目标时区里反查偏移量再修正（含夏令时，比如美股冬夏差一小时）。
 */
function wallTimeToUnix(
  tz: string,
  y: number, mo: number, d: number, h: number, mi: number, sec: number,
): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, sec);
  const asUtc = tzPartsUtc(tz, new Date(guess));
  const off = Math.round((asUtc - guess) / 60000);
  return Math.floor((guess - off * 60000) / 1000);
}

/** 把某时刻在 tz 的墙上时间重新解释成 UTC 毫秒，用于求偏移量 */
function tzPartsUtc(tz: string, at: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(at);
  const g = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
}


async function quotesFromTencent(ids: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  // 腾讯代码 → 原始 secid：反解不出唯一市场号（尤其海外指数），所以靠正查表还原
  const byCode = new Map<string, string>();
  for (const id of ids) {
    const tc = tencentCode(id);
    if (tc && !byCode.has(tc)) byCode.set(tc, id);
  }
  const codes = [...byCode.keys()];
  let lastErr: unknown;
  for (let i = 0; i < codes.length; i += TENCENT_BATCH) {
    const chunk = codes.slice(i, i + TENCENT_BATCH);
    let text: string;
    try {
      text = await getGbkText(`https://qt.gtimg.cn/q=${chunk.join(",")}`);
    } catch (e) {
      // 某一批失败不该连累其它批：记下错误继续，全部批次都失败时再抛
      lastErr = e;
      continue;
    }
    for (const line of text.split(";")) {
      const eq = line.indexOf('="');
      if (eq < 0) continue;
      const tcode = line.slice(0, eq).trim().replace(/^v_/, "");
      const body = line.slice(eq + 2).replace(/";?\s*$/, "").trim();
      if (!body || body.startsWith("pv_none_match")) continue;
      const f = body.split("~");
      if (f.length < 33) continue;
      const secid = byCode.get(tcode);
      if (!secid) continue;
      out.set(secid, {
        secid,
        code: f[2],
        market: Number(marketOf(secid)),
        name: f[1] || f[2],
        price: num(f[3]),
        pct: num(f[32]),
        change: num(f[31]),
        // 成交额：只有 A 股的 f[37] 是「万元」，港美股/海外指数的 f[37] 量纲对不上，
        // 一律给 null（全市场成交额只统计 A 股，缺港美股不影响）
        amount: amountFromTencent(secid, f),
        time: tencentQuoteTime(secid, f[30]),
      });
    }
  }
  // 一条都没取到、且确实有批次失败过，才把错误抛给上层（交给 auto 换源或显示失败）
  if (!out.size && lastErr) throw lastErr;
  return out;
}

/**
 * 腾讯报价的成交额（f[37]）转成「元」。
 * 实测 A 股（含北交所）是万元：sh000001 的 66249184 → 6624.9 亿，与东财 f6 一致；
 * 但港股/海外指数给的是另一套量纲（恒生指数 15816621、纳指 31032551615262），
 * 按万元换算会得出荒唐值，所以只认 A 股，其余返回 null。
 */
function amountFromTencent(secid: string, f: string[]): number | null {
  if (regionOf(secid) !== "CN") return null;
  const wan = num(f[37]);
  return wan == null ? null : wan * 1e4;
}

/** 报价时间按标的所在市场的时区解析 */
function tencentQuoteTime(secid: string, raw: string): number | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 12) return null;
  const y = +digits.slice(0, 4);
  const mo = +digits.slice(4, 6);
  const d = +digits.slice(6, 8);
  const h = digits.length >= 14 ? +digits.slice(8, 10) : +digits.slice(8, 10);
  const mi = digits.length >= 14 ? +digits.slice(10, 12) : +digits.slice(10, 12);
  const sec = digits.length >= 14 ? +digits.slice(12, 14) : 0;
  if (!y || !mo || !d) return null;
  return wallTimeToUnix(SESSIONS[regionOf(secid)].tz, y, mo, d, h, mi, sec);
}

/**
 * 批量报价：按数据源取。
 * `auto` 先试东财，失败（源站故障/超时/网络）时自动切腾讯；两家都失败才抛最后一个错误。
 */
export async function fetchQuotes(
  secids: string[],
  source: DataSource = "auto",
): Promise<Map<string, Quote>> {
  const ids = [...new Set(secids.filter(Boolean))];
  if (!ids.length) return new Map();

  const order: ("eastmoney" | "tencent")[] =
    source === "tencent" ? ["tencent"] : source === "eastmoney" ? ["eastmoney"] : ["eastmoney", "tencent"];

  let lastErr: unknown;
  for (const which of order) {
    try {
      const got = which === "eastmoney" ? await quotesFromEastmoney(ids) : await quotesFromTencent(ids);
      // 成功但一条都没解析出来，说明对方返回了空/异常数据，换下一家再试
      if (got.size) {
        activeSource = which;
        return got;
      }
      lastErr = new ApiError("server", "返回数据为空");
    } catch (e) {
      lastErr = e;
    }
  }
  activeSource = null;
  throw lastErr ?? new ApiError("server", "行情获取失败");
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

// ---------- 板块（行业 / 概念 / 地域） ----------
//
// 两家都提供板块行情，但那是**两套东西**：代码空间与分类颗粒度都不同（见下面两段）。
// 所以板块的 secid 自带来源：`90.BK0480` 是东财的，`91.pt01801120` 是腾讯的。
// 榜单跟着「数据源」设置走，而某一行的分时永远跟着**那一行自己的来源**走 —— 否则
// 换源之后屏上还留着上一家的板块，点开就会画不出来。

/**
 * 板块口径。东方财富的 clist 接口用 `fs=m:90+t:N` 区分：1 地域、2 行业、3 概念。
 * 行业那一类里混着一级、二级、三级，细分的名字带 Ⅱ / Ⅲ 后缀（见 boards.ts 的 isSubBoard）。
 */
export type BoardKind = "industry" | "concept" | "region";

/** 板块列表实际取自哪一家（fetchBoards 里 auto 回退之后就已经定下来了） */
export type BoardSource = "eastmoney" | "tencent";

export interface Board {
  /** `90.BK0480`（东财）或 `91.pt01801120`（腾讯）—— 分时也用它，两家各自认自己的代码 */
  secid: string;
  code: string;
  name: string;
  /** 当日涨跌幅（%） */
  pct: number | null;
  /** 板块点位 */
  price: number | null;
  /** 领涨股名称 */
  leader: string | null;
  /** 领涨股涨跌幅（%） */
  leaderPct: number | null;
}

// ---------- 东方财富（行业 496 个含二三级细分 / 概念 508 / 地域 31） ----------

const BOARD_FS: Record<BoardKind, string> = {
  industry: "m:90+t:2",
  concept: "m:90+t:3",
  region: "m:90+t:1",
};

/** 接口每页最多给 100 条（pz 给再大也只回 100） */
const BOARD_PAGE = 100;
/** 翻页上限：正常最多 6 页（概念 508 个），留足余量，免得源站给个异常大的 total 时翻不完 */
const BOARD_MAX_PAGES = 20;

/** 东财板块列表的一页；页码越界时源站返回 data:null，用空数组表示「没有了」 */
async function boardsPageEastmoney(fs: string, page: number): Promise<{ total: number; rows: Board[] }> {
  const url =
    `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=${BOARD_PAGE}&po=1&np=1&fltt=2&invt=2` +
    `&fid=f3&fs=${encodeURIComponent(fs)}` +
    `&fields=f2,f3,f12,f13,f14,f128,f136&ut=${UT}`;
  const json = await getJson(url);
  const d = json?.data;
  const list: any[] = Array.isArray(d?.diff) ? d.diff : d?.diff ? Object.values(d.diff) : [];
  return {
    total: num(d?.total) ?? 0,
    rows: list.map((x) => ({
      secid: `90.${x.f12}`,
      code: String(x.f12),
      name: String(x.f14 ?? x.f12),
      pct: num(x.f3),
      price: num(x.f2),
      // 板块没有成分股时领涨股字段是 "-"
      leader: x.f128 == null || x.f128 === "-" ? null : String(x.f128),
      leaderPct: num(x.f136),
    })),
  };
}

/** 东财：某类口径下的全部板块。第一页顺带给出总数，其余页并发拉 */
async function boardsFromEastmoney(kind: BoardKind): Promise<Board[]> {
  const fs = BOARD_FS[kind];
  const first = await boardsPageEastmoney(fs, 1);
  const out = [...first.rows];
  const pages = Math.min(BOARD_MAX_PAGES, Math.ceil(first.total / BOARD_PAGE));
  if (pages > 1) {
    const rest = await Promise.all(
      Array.from({ length: pages - 1 }, (_, i) => boardsPageEastmoney(fs, i + 2)),
    );
    for (const r of rest) out.push(...r.rows);
  }
  return out;
}

// ---------- 腾讯（一级行业 31 / 二级行业 124 / 概念 805 / 地域 31） ----------

/** 腾讯板块的虚拟市场号：东财板块是 90.，腾讯的用它自己的板块代码，市场号取 91. */
const TENCENT_BOARD_MARKET = "91";
/**
 * 腾讯板块排行的口径。地域用简称（「贵州」），东财那边叫「贵州板块」。
 * 行业分两级：`hy` 是一级（31 个）、`hy2` 是二级（124 个）。二级里**只有 36 个名字带 Ⅱ**，
 * 靠名字过滤不干净，所以「细分」开关直接决定要不要拉 hy2 —— 关着就只给一级的 31 个。
 */
const TENCENT_BOARD_TYPE: Record<BoardKind, { base: string[]; sub: string[] }> = {
  industry: { base: ["hy"], sub: ["hy2"] },
  concept: { base: ["gn"], sub: [] },
  region: { base: ["dy"], sub: [] },
};
/** 腾讯每页最多给 200 条（再大就报参数错误）；offset 翻页有效 */
const TENCENT_PAGE = 200;
/** 翻页上限：概念 805 个 = 5 页，留足余量 */
const TENCENT_MAX_PAGES = 20;
/**
 * 腾讯板块排行的一页。
 *
 * 这条接口**不返回 CORS 头**（实测只对自家站点回 `Access-Control-Allow-Origin`，
 * 对 `tauri://localhost` / `http://tauri.localhost` 都没有），也不支持 JSONP
 * （`cb=` / `callback=` 都只回纯 JSON，与搜索接口不同）——所以在 webview 里 fetch 一定被拦，
 * 榜单只要落到腾讯就加载失败。应用里改由 Rust 侧代取（`qq_board_rank`，见 src-tauri/src/qqrank.rs），
 * 不经 webview 也就没有 CORS / CSP 这回事；东财那侧有 CORS 头，仍旧走 fetch。
 * `sort_type` 只认 `price`（别的值报参数错误），顺序无所谓，榜单在本地重排。
 */
async function boardsPageTencent(type: string, offset: number): Promise<Board[]> {
  const json = await qqRankJson(type, offset);
  const list: any[] = Array.isArray(json?.data?.rank_list) ? json.data.rank_list : [];
  return list.map((x) => ({
    secid: `${TENCENT_BOARD_MARKET}.${x.code}`,
    code: String(x.code),
    name: String(x.name ?? x.code),
    pct: num(x.zdf),
    price: num(x.zxj),
    leader: x.lzg?.name == null ? null : String(x.lzg.name),
    leaderPct: x.lzg ? num(x.lzg.zdf) : null,
  }));
}

/**
 * 腾讯板块排行的原始 JSON。
 * 应用里走 Rust 侧的 `qq_board_rank`（理由见 boardsPageTencent）；浏览器预览（`pnpm dev`）
 * 没有 Rust 侧，退到直接 fetch —— 那边会被 CORS 拦掉，所以板块榜单在预览里看不到腾讯那一份。
 */
async function qqRankJson(type: string, offset: number): Promise<any> {
  if (IN_TAURI) {
    let text: string;
    try {
      text = await callOrThrow<string>("qq_board_rank", { ftype: type, offset });
    } catch (e) {
      // Rust 侧把原因当字符串抛回来（连不上 / 非 200）：归到「源站故障」这一类
      throw new ApiError("server", `板块接口失败：${typeof e === "string" ? e : String(e)}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new ApiError("server", "板块接口返回的不是 JSON");
    }
  }
  const url =
    `https://proxy.finance.qq.com/cgi/cgi-bin/rank/pt/getRank?board_type=${type}` +
    `&sort_type=price&direct=down&offset=${offset}&count=${TENCENT_PAGE}`;
  return getJson(url);
}

/** 腾讯：某类口径下的全部板块（「细分」开着时行业多拉一段 hy2，各自翻页） */
async function boardsFromTencent(kind: BoardKind, subs: boolean): Promise<Board[]> {
  const out: Board[] = [];
  const spec = TENCENT_BOARD_TYPE[kind];
  for (const type of [...spec.base, ...(subs ? spec.sub : [])]) {
    for (let page = 0; page < TENCENT_MAX_PAGES; page++) {
      const rows = await boardsPageTencent(type, page * TENCENT_PAGE);
      out.push(...rows);
      if (rows.length < TENCENT_PAGE) break; // 最后一页
    }
  }
  return out;
}

/**
 * 某类口径下的**全部**板块，按「数据源」设置取：
 * `auto` 先东财、失败（源站故障 / 超时 / 网络不通）再退腾讯；两家都失败才抛最后一个错误。
 * `subs` 只有腾讯那边用得上（东财一次就把一二级全拿回来了，过滤在本地做，见 boards.ts）。
 * 任何一页失败都整体抛出：宁可让调用方留着上一份完整榜单，也不要给一份缺了一半的排序。
 */
export async function fetchBoards(
  kind: BoardKind,
  source: DataSource = "auto",
  subs = false,
): Promise<Board[]> {
  const order: BoardSource[] =
    source === "tencent"
      ? ["tencent"]
      : source === "eastmoney"
        ? ["eastmoney"]
        : ["eastmoney", "tencent"];
  let lastErr: unknown;
  for (const which of order) {
    try {
      const got =
        which === "eastmoney" ? await boardsFromEastmoney(kind) : await boardsFromTencent(kind, subs);
      // 成功但一条都没有：当成这家给不出数据，换下一家再试
      if (got.length) return got;
      lastErr = new ApiError("server", "返回数据为空");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new ApiError("server", "板块列表获取失败");
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
async function trendFromEastmoney(secid: string, days: number): Promise<TrendData> {
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

/**
 * 午后开盘那一分钟是否只是上午收盘点的复制。
 * 腾讯的日内序列在午休处会多给一条：A 股是 1130 和 1300 两条内容一样，
 * 港股是 1200 和 1300 一样（上午收盘时间不同，但复制的那条都是午后开盘那一刻）。
 * 判据用「午后开盘分钟 + 三个数值与上一条完全相同」，不靠写死时间对，
 * 这样既不会误删其它分钟，又能让整日点数与东财一致（A 股 241、港股 331）。
 */
function isAfternoonOpenDup(region: Region, hm: string, parts: string[], prev: string[]): boolean {
  const afternoonStart = SESSIONS[region].s[1]?.[0];
  if (afternoonStart == null) return false;
  const m = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(2, 4));
  if (m !== afternoonStart) return false;
  // 价格 / 累计量 / 累计额三项都一样，才认定是复制点
  return parts[1] === prev[1] && parts[2] === prev[2] && parts[3] === prev[3];
}

/**
 * 腾讯分时：web.ifzq.gtimg.cn/appstock/app/day/query?code=<code>
 * 返回最近 5 个交易日，每天一组 `"HHMM 价格 累计量 累计额"`（都是累计值，不是分钟增量）。
 * 因此：
 * - 价格直接用；
 * - 均价由累计额/累计量反推（累计量的单位见 volUnit，按数据自己判），指数不画均价线；
 * - 成交额取每分钟增量（当日累计额差分），这样和东财的语义一致，
 *   `cumAmount()` 的「按分钟累加 + 与上一日同期对比」逻辑可以原样复用。
 * 注意美股没有分时数据（接口返回 param error），这种情况抛错交给上层显示「加载失败」。
 */
async function trendFromTencent(secid: string, days: number): Promise<TrendData> {
  const tc = tencentCode(secid);
  if (!tc) throw new ApiError("server", "该标的不支持腾讯分时");
  const json = await getJson(`https://web.ifzq.gtimg.cn/appstock/app/day/query?code=${tc}`);
  const node = json?.data?.[tc];
  const groups: any[] = Array.isArray(node?.data) ? node.data : [];
  if (!groups.length) throw new ApiError("server", "腾讯未返回分时数据");
  const region = regionOf(secid);
  // 累计量的单位不能按市场写死：多数 A 股接口给的是「手」（100 股），
  // 但科创板（688/689）给的是「股」—— 一律 ×100 会把均价算成真实值的 1/100，
  // 均价线掉到价格线下面一大截，纵轴被它撑成 ±100% 以上，价格线就成了一条平线。
  // 所以拿第一笔有量的「累计额 / 累计量」跟当时的成交价比一下：约等于价格是股，
  // 约等于百分之一价格是手。两者差 100 倍，判起来没有歧义。
  // null = 还没定（A 股要等第一笔有量的点）；港美股一直是股。
  let volUnit: number | null = region === "CN" ? null : 1;
  // 指数不画均价线：腾讯给指数的「累计量」是另一套口径（恒生指数 amt/vol ≈ 1，
  // 上证指数算出来是 14 而点位在 3800），画上去会把价格线压成一条细缝。个股才有真实均价。
  const isIdx = isIndexSecid(secid);
  // 腾讯按「新→旧」返回，而 pickTrendDay 假定最后一组是最新一天，所以先按日期升序排好
  const sorted = [...groups].sort((a, b) => String(a?.date ?? "").localeCompare(String(b?.date ?? "")));
  const raw: TrendRawPoint[] = [];
  let fullDay = 0;
  for (const g of sorted) {
    const date = String(g?.date ?? "");
    const iso = date.length === 8 ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : date;
    let prevAmt = 0;
    let prevParts: string[] | null = null;
    let count = 0;
    for (const line of (Array.isArray(g?.data) ? g.data : []) as string[]) {
      const p = String(line).trim().split(/\s+/);
      // 一行是「时间 价格 累计量 [累计额]」：个股 4 列，板块（pt…）只有 3 列
      if (p.length < 3) continue;
      const hm = p[0];
      // 只保留交易时段内的点：A 股个股会多给 15:00 之后的盘后成交
      if (!inSession(region, hm)) continue;
      // 午后开盘那条常常是上午收盘点的复制（内容完全相同），丢掉它，
      // 让整日点数与东财一致（A 股 241、港股 331），横轴刻度才不会错位
      if (prevParts && isAfternoonOpenDup(region, hm, p, prevParts)) continue;
      prevParts = p;
      const price = num(p[1]);
      const cumVol = num(p[2]);
      const cumAmt = p.length >= 4 ? num(p[3]) : null;
      if (price == null) continue;
      // 累计额偶发回退（接口给出坏行）：差分基准不能跟着回退，否则下一个正常点
      // 的增量会把当天累计额算成两倍。回退时该分钟增量记 null，基准维持不变。
      // 板块本来就没有累计额（cumAmt 恒为 null），于是成交额与均价线都没有 —— 正是想要的
      const bad = cumAmt == null || cumAmt < prevAmt;
      const amount = bad ? null : cumAmt - prevAmt;
      if (cumAmt != null && cumAmt >= prevAmt) prevAmt = cumAmt;
      // 第一笔有量的点定下累计量的单位（指数不参与：它的「累计量」是另一套口径）：
      // 累计额/累计量 约等于 100 倍价格 → 量是手；约等于价格 → 量是股
      if (!isIdx && volUnit == null && cumAmt != null && cumVol) {
        volUnit = cumAmt / cumVol > price * 5 ? 100 : 1;
      }
      count++;
      raw.push({
        date: iso,
        time: hm.padStart(4, "0"),
        price,
        avg: isIdx || bad || !cumVol || !volUnit ? null : cumAmt! / (cumVol * volUnit),
        vol: cumVol,
        amount,
      });
    }
    // 完整交易日的分钟数：这 5 天里最长的一天（半日市/停牌那天会短一些）
    if (count > fullDay) fullDay = count;
  }
  if (!raw.length) throw new ApiError("server", "腾讯未返回分时数据");
  // 与东财 ndays 对齐：days=2 时留最后两天；days=1 只留最新一天
  const dates = [...new Set(raw.map((p) => p.date))];
  const keep = new Set(days >= 2 ? dates.slice(-2) : dates.slice(-1));
  const kept = raw.filter((p) => keep.has(p.date));
  // 横轴按「一个完整交易日」铺满。pickTrendDay 是从「两天之和」里减掉上一日的点数来推算的，
  // 上一日偏短（半日市、停牌、数据缺口）时会算得比整日还长，所以这里以 fullDay 为准。
  const day = pickTrendDay(kept, fullDay * Math.max(1, keep.size), days);
  const total = Math.max(fullDay, day.points.length);
  const qt = node?.qt?.[tc];
  return {
    secid,
    name: Array.isArray(qt) ? String(qt[1] ?? "") : "",
    preClose: Array.isArray(qt) ? num(qt[4]) : null,
    total,
    points: day.points,
    amount: day.amount,
    prevAmount: day.prevAmount,
    prevDate: day.prevDate,
  };
}

/** 某个分钟标签是否落在该市场的交易时段内 */
function inSession(region: Region, hm: string): boolean {
  const m = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(2, 4));
  if (!Number.isFinite(m)) return false;
  return SESSIONS[region].s.some(([a, b]) => m >= a && m <= b);
}

/**
 * 分时走势：按数据源取，`auto` 先试东财、失败再试腾讯。
 * `days` 传 2 时取两天：画图仍只用最新一天，另一天用来算「与上一日同期」的成交额对比。
 */
export async function fetchTrend(
  secid: string,
  days = 1,
  source: DataSource = "auto",
): Promise<TrendData> {
  const order: ("eastmoney" | "tencent")[] =
    source === "tencent" ? ["tencent"] : source === "eastmoney" ? ["eastmoney"] : ["eastmoney", "tencent"];
  let lastErr: unknown;
  for (const which of order) {
    try {
      return which === "eastmoney"
        ? await trendFromEastmoney(secid, days)
        : await trendFromTencent(secid, days);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new ApiError("server", "分时获取失败");
}

// ---------- 全市场成交额 ----------

/** 全市场成交额用到的三个指数：沪深北各取一个代表性指数，其成交额即该市场总额 */
export const MARKET_INDEX = {
  sh: "1.000001", // 上证指数 → 沪市
  sz: "0.399001", // 深证成指 → 深市（与深证综指同为 7519 亿，口径一致）
  bj: "0.899050", // 北证50  → 北交所
} as const;

export interface MarketAmount {
  /** 沪/深/北各自的当日成交额（元）；取不到的市场为 null */
  parts: { sh: number | null; sz: number | null; bj: number | null };
  /** 全市场（沪+深+北）当日成交额；缺任何一个市场时为 null（不冒充全市场） */
  total: number | null;
  /** 沪深两市当日成交额；缺任一个时为 null */
  hsTotal: number | null;
  /** 沪深两市上一交易日同一时刻的合计（元）；没有可比数据时为 null */
  hsPrev: number | null;
  /** 上一交易日的日期（"2026-10-13"） */
  prevDate: string | null;
}

/** 全部有值才算得出来：缺一个市场就不能冒充「全市场」，宁可返回 null */
function sumStrict(...vs: (number | null)[]): number | null {
  if (vs.some((v) => v == null)) return null;
  return vs.reduce<number>((a, v) => a + (v as number), 0);
}

/**
 * 全市场成交额：沪 + 深 + 北。
 *
 * 今日的三个值直接读调用方刚取到的报价（`Quote.amount` 已是元），不再多打一次接口。
 * 「较上一日」要的是上一日的分钟累计成交额，只有沪深两市的分时接口给得出 ——
 * 北证50 在腾讯的分时只有 3 列（价格/量，没有成交额）、日线也只回当天，
 * 两家都取不到它的历史成交额，所以对比固定为沪深口径，界面上必须写明，不能假装成全市场对比。
 */
export async function fetchMarketAmount(
  quotes: Map<string, Quote>,
  source: DataSource = "auto",
): Promise<MarketAmount> {
  // 先把本轮的今日值定下来，免得和后面分时请求期间的新一轮刷新串味
  const partOf = (id: string) => quotes.get(id)?.amount ?? null;
  const sh = partOf(MARKET_INDEX.sh);
  const sz = partOf(MARKET_INDEX.sz);
  const bj = partOf(MARKET_INDEX.bj);
  // 沪深各取两天：图上不用，只借 prevAmount 算「与上一日同期」
  const [shTrend, szTrend] = await Promise.all([
    fetchTrend(MARKET_INDEX.sh, 2, source).catch(() => null),
    fetchTrend(MARKET_INDEX.sz, 2, source).catch(() => null),
  ]);
  return {
    parts: { sh, sz, bj },
    total: sumStrict(sh, sz, bj),
    hsTotal: sumStrict(sh, sz),
    hsPrev: sumStrict(shTrend?.prevAmount ?? null, szTrend?.prevAmount ?? null),
    prevDate: shTrend?.prevDate ?? szTrend?.prevDate ?? null,
  };
}

// ---------- secid 辅助 ----------

export function codeOf(secid: string): string {
  return secid.slice(secid.indexOf(".") + 1);
}

/**
 * 板块的 secid 属于哪一家：`90.BK…` 是东财的，`91.pt…` 是腾讯的；不是板块就返回 null。
 * 板块不是标的（见 CONTEXT.md 与 docs/adr/0001）：它只在板块榜单里被浏览。
 * 这一处判断有两个用处：分时该找哪一家要（各认各的代码），以及板块不画均价线。
 */
export function boardSourceOf(secid: string): BoardSource | null {
  const m = marketOf(secid);
  if (m === "90") return "eastmoney";
  if (m === TENCENT_BOARD_MARKET) return "tencent";
  return null;
}

export const isBoardSecid = (secid: string): boolean => boardSourceOf(secid) !== null;

function marketOf(secid: string): string {
  return secid.slice(0, secid.indexOf("."));
}

/** 是否是指数（东财 100. 海外指数，或常见的大盘指数代码），用于跳过均价线 */
function isIndexSecid(secid: string): boolean {
  if (marketOf(secid) === "100") return true;
  const c = codeOf(secid);
  return /^(000001|399001|399006|000300|000905|000016)$/.test(c) && marketOf(secid) !== "105";
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
