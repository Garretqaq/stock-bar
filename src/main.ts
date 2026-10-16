import {
  apiErrorText,
  getActiveSource,
  codeOf,
  fetchBoards,
  fetchMarketAmount,
  fetchQuotes,
  fetchTrend,
  boardSourceOf,
  isBoardSecid,
  MARKET_INDEX,
  marketTag,
  regionOf,
  searchStocks,
  sessionStatus,
  type Board,
  type BoardKind,
  type MarketAmount,
  type Quote,
  type SearchItem,
  type TrendData,
} from "./api";
import { barImage, barText, canvasPng } from "./bar";
import { BOARD_KINDS, boardKindLabel, boardRows, leaderTag, type BoardOrder } from "./boards";
import {
  GROUP_NAME_MAX,
  INDICES,
  UNGROUPED,
  applyAppearance,
  applySearchAction,
  dropGroupOf,
  groupIdOf,
  groupNameOf,
  groupTargets,
  isDark,
  isIndex,
  itemsOf,
  loadSettings,
  loadTickerPos,
  moveItem,
  moveRowInView,
  newGroup,
  onSettingsChange,
  pinCount,
  pinItem,
  removeGroup,
  renameGroup,
  saveSettings,
  searchActions,
  setGroup,
  unpinItem,
  type Settings,
} from "./settings";
import { IN_TAURI, IS_WIN, UI_FONT, call, listenAll } from "./tauri";
import { isDragClick, isDragMove, scrollDeltaFor } from "./tabs";
import { sortable } from "./sortable";
import { openMenu, type MenuItem } from "./ctxmenu";
import { McpError, prepareCommand } from "./mcp";
import { hintText, type UpdateInfo } from "./update";

let S: Settings = loadSettings();
const save = () => saveSettings(S);

/** 启动时查到的更新信息：没有新版本（或还没查）就是 null */
let updateInfo: UpdateInfo | null = null;

// ---------- 运行时状态 ----------

const quotes = new Map<string, Quote>();
let lastOk = 0;
let failCount = 0;
/** 最近一次失败的提示文案，由 apiErrorText() 按失败原因生成 */
let errorMsg = "";
let loaded = false;
let timer: number | undefined;
// ---------- 分时图展开 ----------
/** 当前展开分时图的 secid，null 表示收起 */
let trendOpen: string | null = null;
const trendCache = new Map<string, TrendData>();
let trendSeq = 0;
let refreshing = false;
/** 全市场成交额（沪+深+北），只在指数分时面板展开时拉取 */
let market: MarketAmount | null = null;
let marketSeq = 0;

// ---------- 板块榜单 ----------
// 板块不是标的（见 CONTEXT.md 与 docs/adr/0001-boards-are-read-only.md）：
// 下面这些状态一律不进设置、不持久化，主面板每次弹出都回到「自选 / 行业 / 涨幅榜」。
/** 当前视图：自选列表 / 板块榜单 */
let view: "watch" | "board" = "watch";
let boardKind: BoardKind = "industry";
let boardOrder: BoardOrder = "up";
/** 是否显示行业里的 Ⅱ / Ⅲ 细分（默认藏起来，它们是重复项，见 boards.ts） */
let boardSubs = false;
/** 板块搜索词：板块视图里的搜索框就地过滤当前口径那份榜单（见 boards.ts 的 searchBoards） */
let boardQuery = "";
/** 当前口径下最近一次成功拉到的板块；拉失败时保留上一份，不清空 */
let boards: Board[] = [];
let boardsLoading = false;
let boardsErr = false;
/** 拉取序号：口径切换后回来的旧数据直接丢掉 */
let boardsSeq = 0;
/** 正在路上的口径（同一口径不重复发请求，5 秒一轮的刷新不会叠起来） */
let boardsBusy: BoardKind | null = null;
/**
 * 板块名。板块不在 quotes 里，而分时面板的标题要显示名字，
 * 所以拉到的名字都记下来（不随口径切换清空，展开中的板块换了口径也还认得出）。
 */
const boardNames = new Map<string, string>();

// ---------- 工具 ----------
const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel)!;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function fmtPrice(v: number | null | undefined): string {
  if (v == null) return "--";
  const a = Math.abs(v);
  return v.toFixed(a >= 10000 ? 1 : a < 1 ? 3 : 2);
}

function fmtPct(v: number | null | undefined, sign = true): string {
  if (v == null) return "--";
  return `${sign && v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtChange(v: number | null | undefined): string {
  if (v == null) return "--";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
}

/** 成交额（元）折算成「亿」，千亿以上不再留小数 */
function fmtAmount(v: number | null | undefined): string {
  if (v == null) return "--";
  const yi = v / 1e8;
  return yi >= 1000 ? `${Math.round(yi)}亿` : `${yi.toFixed(1)}亿`;
}

/** 成交额差额：带正负号，万亿以上按「万亿」显示 */
function fmtAmountDiff(v: number | null | undefined): string {
  if (v == null) return "--";
  const sign = v > 0 ? "+" : v < 0 ? "-" : "";
  const yi = Math.abs(v) / 1e8;
  if (yi >= 1e4) return `${sign}${(yi / 1e4).toFixed(2)}万亿`;
  return `${sign}${yi >= 1000 ? Math.round(yi) : yi.toFixed(1)}亿`;
}

function nameOf(secid: string): string {
  // 板块不在 quotes 里（它没有报价），名字来自板块列表
  return quotes.get(secid)?.name ?? boardNames.get(secid) ?? codeOf(secid);
}

type Dir = "up" | "down" | "flat";
function dirOf(p: number | null | undefined): Dir {
  if (p == null || p === 0) return "flat";
  return p > 0 ? "up" : "down";
}

/** ☰（三条叠着的横杠）= 「还有更多分组」：横滑出去的分组从这里点（骨架里就要用，得先声明） */
const ICON_MORE = `<svg viewBox="0 0 24 24"><path d="M4.5 7.5h15M4.5 12h15M4.5 16.5h15"/></svg>`;

// ---------- 页面骨架 ----------

const app = $("#app");
app.innerHTML = `
  <div class="frost" aria-hidden="true"></div>
  <header class="top">
    <span class="top-spacer" aria-hidden="true"></span>
    <div class="title">
      <div class="title-name" id="title-name">StockBar</div>
      <div class="title-sub" id="title-sub">加载中…</div>
    </div>
    <div class="top-actions">
      <button class="icon-btn" id="btn-refresh" title="刷新">
        <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.34-5.66M20 4v5h-5"/></svg>
      </button>
      <button class="icon-btn" id="btn-settings" title="设置">
        <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>
      </button>
    </div>
  </header>
  <div class="error-bar" id="error-bar">行情获取失败，正在重试…</div>
  <button class="update-bar" id="update-bar" hidden><span id="update-text"></span><i>去更新</i></button>

  <main class="body" id="body">
    <section class="indices" id="indices"></section>
    <div class="trend trend-index" id="trend-index"><div class="trend-card"><div class="trend-head"><span class="trend-title"></span><span class="trend-meta"></span></div><canvas></canvas><div class="trend-foot"></div></div></div>

    <div class="vtabs" id="vtabs" role="tablist" aria-label="视图">
      <button class="vtab on" data-view="watch" role="tab" aria-selected="true">自选</button>
      <button class="vtab" data-view="board" role="tab" aria-selected="false">板块</button>
    </div>
    <div class="search">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="search-input" placeholder="搜索代码 / 名称 / 拼音" autocomplete="off" spellcheck="false" />
      <div class="search-results" id="search-results"></div>
    </div>
    <div class="gtabs" id="gtabs" hidden>
      <div class="gtab-scroll" id="gtab-scroll"></div>
      <button class="gtab-more" id="gtab-more" hidden title="更多分组" aria-label="更多分组" aria-haspopup="menu">${ICON_MORE}</button>
    </div>
    <section class="list" id="list"></section>
    <div class="bctl" id="bctl" hidden>
      <div class="bkind" id="bkind"></div>
      <button class="gtab" id="border"></button>
      <button class="gtab" id="bsubs" title="显示行业细分（Ⅱ / Ⅲ）">细分</button>
      <span class="bcount" id="bcount"></span>
    </div>
    <section class="list" id="boards" hidden></section>
  </main>

  <footer class="bottom">
    <select id="interval" title="刷新间隔">
      <option value="3">3 秒</option><option value="5">5 秒</option>
      <option value="10">10 秒</option><option value="30">30 秒</option>
    </select>
    <span class="src" id="src-label">数据来源：东方财富</span>
    <button class="text-btn" id="btn-quit">退出</button>
  </footer>
`;

// ---------- 大盘指数卡片 ----------


/** 卡片只创建一次，刷新时只改文字，避免整块重绘闪烁 */
function mountIndices(): void {
  $("#indices").innerHTML = INDICES.map(
    (it, i) =>
      `<button class="idx" data-id="${it.secid}" title="${it.name}" style="--i:${i}">` +
      `<div class="idx-name">${it.name}</div>` +
      `<div class="idx-price flat">--</div>` +
      `<div class="idx-chg flat"><span class="idx-change">--</span><span class="idx-pct">--</span></div></button>`,
  ).join("");
  $("#indices").addEventListener("click", (e) => {
    const id = (e.target as HTMLElement).closest<HTMLElement>(".idx")?.dataset.id;
    if (id) toggleTrend(id);
  });
}
mountIndices();

// ---------- 分时图 ----------

const PAD = { l: 2, r: 2, t: 10, b: 16 };
const trendAnim = new Map<HTMLElement, number>();
const trendHover = new WeakMap<HTMLElement, number>();
const trendErr = new Set<string>();
const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function trendInner(): string {
  return (
    `<div class="trend-card"><div class="trend-head">` +
    `<span class="trend-title"></span><span class="trend-meta"></span></div>` +
    `<canvas></canvas></div>`
  );
}

/** 展开/收起分时图；展开时选中该标的并拉取数据 */
async function toggleTrend(id: string): Promise<void> {
  if (trendOpen === id) {
    trendOpen = null;
    syncOpenState();
    return;
  }
  trendOpen = id;
  S.selected = id;
  save();
  renderHeader();
  syncOpenState();
  const had = trendCache.has(id);
  if (had) openHolders(id).forEach(animateTrend);
  // 全市场成交额（底部那两行）只在指数面板里出现，展开指数时顺带拉一次
  await Promise.all([loadTrend(id, !had), isIndex(id) ? loadMarket() : Promise.resolve()]);
}

/** 只切换 class、不重建 DOM，保证展开/收起过渡完整播放 */
function syncOpenState(): void {
  document.querySelectorAll<HTMLElement>(".idx, #list .row, #boards .row").forEach((el) => {
    el.classList.toggle("active", el.dataset.id === S.selected);
    el.classList.toggle("open", el.dataset.id === trendOpen);
  });
  renderTrendPanels();
}

function openHolders(id: string): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".trend.show")].filter((el) => el.dataset.id === id);
}

async function loadTrend(id: string, animate: boolean): Promise<void> {
  const seq = ++trendSeq;
  try {
    // 板块分时**跟着这一行自己的来源**走（90.BK… 找东财、91.pt… 找腾讯）：换源之后屏上
    // 可能还留着上一家的板块，按设置的源去拉会画不出来。大盘指数多取一天，
    // 用来算「与上一日同期」的成交额对比。
    const src = boardSourceOf(id) ?? S.source;
    const data = await fetchTrend(id, isIndex(id) ? 2 : 1, src);
    if (seq !== trendSeq || trendOpen !== id) return;
    trendCache.set(id, data);
    trendErr.delete(id);
    if (animate) openHolders(id).forEach(animateTrend);
    else renderTrendPanels();
  } catch {
    if (seq !== trendSeq) return;
    if (!trendCache.has(id)) trendErr.add(id);
    renderTrendPanels();
  }
}

/**
 * 拉全市场成交额（沪+深+北）。
 * 只在展开的标的是大盘指数时调用 —— 底部那两行只在指数面板里有位置。
 * 失败时保留上一次的值：多一行旧数据也好过整行闪没。
 */
async function loadMarket(): Promise<void> {
  const seq = ++marketSeq;
  try {
    const got = await fetchMarketAmount(quotes, S.source);
    if (seq !== marketSeq) return;
    market = got;
  } catch {
    // 拿不到就沿用上一次的值：多一行旧数据也好过整行闪没
    return;
  }
  renderTrendPanels();
}

/** 同步指数共用面板 + 个股行内嵌面板的展开状态 */
function renderTrendPanels(): void {
  const idxPanel = $("#trend-index");
  const idxOpen = INDICES.some((it) => it.secid === trendOpen);
  // 收起时保留旧 id，让收起过渡期间仍显示原图
  if (idxOpen) idxPanel.dataset.id = trendOpen!;
  const panels = [idxPanel, ...document.querySelectorAll<HTMLElement>("#list .trend, #boards .trend")];
  for (const el of panels) {
    const open = el === idxPanel ? idxOpen : el.dataset.id === trendOpen;
    el.classList.toggle("show", open);
    if (open && !trendAnim.has(el)) drawTrend(el);
  }
}

/** 折线从左到右"画"出来 */
function animateTrend(el: HTMLElement): void {
  const prev = trendAnim.get(el);
  if (prev) cancelAnimationFrame(prev);
  if (reduceMotion()) {
    trendAnim.delete(el);
    drawTrend(el);
    return;
  }
  const t0 = performance.now();
  const D = 720;
  const step = (now: number) => {
    const p = Math.min(1, (now - t0) / D);
    drawTrend(el, 1 - Math.pow(1 - p, 3));
    if (p < 1) trendAnim.set(el, requestAnimationFrame(step));
    else trendAnim.delete(el);
  };
  trendAnim.set(el, requestAnimationFrame(step));
}

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

function alpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

function fmtTime(t: string): string {
  return t.length === 4 ? `${t.slice(0, 2)}:${t.slice(2)}` : t;
}

function trendTotal(data: TrendData): number {
  return Math.max(data.total ?? 0, data.points.length);
}
/**
 * 大盘指数面板底部的成交额，两行：
 *   1. 今日全市场（沪+深+北）总额 + 三市明细 —— 这才是各家 App 报的「两市/全市场成交额」；
 *   2. 较上一日同期的增减 —— 只有沪深两市能比（北证50 没有历史成交额），所以要标「沪深」。
 * 个股的行内分时面板没有 .trend-foot，自然不显示。
 */
function renderAmount(holder: HTMLElement, data: TrendData | undefined): void {
  const foot = holder.querySelector<HTMLElement>(".trend-foot");
  if (!foot) return;
  // 全市场那行只在指数面板显示；个股面板没有 .trend-foot，走不到这里
  const m = market;
  const detail =
    m == null
      ? ""
      : ([
          ["沪", m.parts.sh],
          ["深", m.parts.sz],
          ["北", m.parts.bj],
        ] as [string, number | null][])
          .filter(([, v]) => v != null)
          // 明细只报数字，单位由前面的「亿」带着；重复三遍「亿」在 360px 宽下会被省略号截断
          .map(([k, v]) => `${k} ${Math.round((v as number) / 1e8)}`)
          .join(" · ");

  const amt = data?.amount ?? null;
  const diff = m?.hsTotal != null && m.hsPrev != null ? m.hsTotal - m.hsPrev : null;
  const pct =
    diff != null && m!.hsPrev! > 0 ? (m!.hsTotal! / m!.hsPrev! - 1) * 100 : null;

  // 内容里只有数字和固定的 class，不需要转义；没变化就不重写，免得展开动画每帧都动 DOM
  const line1 =
    m?.total == null
      ? ""
      : `<span><span>今日全市场 <b>${fmtAmount(m.total)}</b></span>${
          detail ? `<i>${detail}</i>` : ""
        }</span>`;
  const line2 =
    diff == null
      ? amt == null
        ? ""
        : `<span>成交额 <b>${fmtAmount(amt)}</b></span>`
      : `<span>较上一日（沪深）<b class="${dirOf(diff)}">${fmtAmountDiff(diff)}${
          pct == null ? "" : `（${fmtPct(pct)}）`
        }</b></span>`;
  const html = line1 || line2 ? `${line1}${line2}` : "";

  const title =
    m?.total == null
      ? ""
      : `全市场 ${fmtAmount(m.total)}（沪 ${fmtAmount(m.parts.sh)} + 深 ${fmtAmount(
          m.parts.sz,
        )} + 北 ${fmtAmount(m.parts.bj)}）` +
        (m.hsPrev == null
          ? ""
          : `\n沪深 ${fmtAmount(m.hsTotal)}，上一日同期（${m.prevDate ?? "--"}）${fmtAmount(
              m.hsPrev,
            )}` + (diff == null ? "" : `，${diff >= 0 ? "多" : "少"} ${fmtAmount(Math.abs(diff))}`));
  if (foot.innerHTML === html && foot.title === title) return;
  foot.innerHTML = html;
  if (title) foot.title = title;
  else foot.removeAttribute("title");
}

/** Canvas：渐变面积 + 价格线 + 均价线 + 昨收虚线 + 十字光标 */
function drawTrend(holder: HTMLElement, progress = 1): void {
  const id = holder.dataset.id ?? "";
  const cv = holder.querySelector<HTMLCanvasElement>("canvas");
  if (!cv) return;
  const title = holder.querySelector<HTMLElement>(".trend-title");
  const meta = holder.querySelector<HTMLElement>(".trend-meta");
  if (title) title.textContent = `${nameOf(id)} · 分时`;

  const cssW = cv.clientWidth || 300;
  const cssH = cv.clientHeight || 130;
  const dpr = window.devicePixelRatio || 1;
  const bw = Math.round(cssW * dpr);
  const bh = Math.round(cssH * dpr);
  if (cv.width !== bw || cv.height !== bh) {
    cv.width = bw;
    cv.height = bh;
  }
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const sub = cssVar("--sub", "#8e8e93");
  const data = trendCache.get(id);
  holder.classList.toggle("loading", !data && !trendErr.has(id));
  renderAmount(holder, data);
  if (!data || !data.points.length) {
    if (meta) meta.textContent = "";
    if (data || trendErr.has(id)) {
      ctx.fillStyle = sub;
      ctx.font = `12px ${UI_FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(trendErr.has(id) ? "分时图加载失败" : "暂无分时数据", cssW / 2, cssH / 2);
    }
    return;
  }

  const pts = data.points;
  const total = trendTotal(data);
  const w = cssW - PAD.l - PAD.r;
  const h = cssH - PAD.t - PAD.b;
  let min = Infinity;
  let max = -Infinity;
  for (const p of pts) {
    if (p.price < min) min = p.price;
    if (p.price > max) max = p.price;
  }
  const pre = data.preClose ?? pts[0].price;
  // 指数与板块的"均价"字段都不是真实均价（东财给的是另一套口径），只给个股画均价线；
  // 纵轴范围同时容纳均价
  const showAvg = !INDICES.some((it) => it.secid === id) && !isBoardSecid(id);
  let rMin = min;
  let rMax = max;
  if (showAvg) {
    for (const p of pts) {
      if (p.avg == null || p.avg <= 0) continue;
      if (p.avg < rMin) rMin = p.avg;
      if (p.avg > rMax) rMax = p.avg;
    }
  }
  const dev = Math.max(rMax - pre, pre - rMin, pre * 0.002) * 1.1;
  const lo = pre - dev;
  const hi = pre + dev;
  const x = (i: number) => PAD.l + (i / Math.max(total - 1, 1)) * w;
  const y = (v: number) => PAD.t + ((hi - v) / (hi - lo)) * h;

  const up = cssVar("--up", "#e0282e");
  const down = cssVar("--down", "#1a9f50");
  const grid = cssVar("--line", "rgba(0,0,0,0.06)");
  const last = pts[pts.length - 1].price;
  const color = last >= pre ? up : down;

  // 网格
  ctx.lineWidth = 1;
  ctx.strokeStyle = grid;
  for (const f of [0.25, 0.75]) {
    const gy = Math.round(PAD.t + h * f) + 0.5;
    ctx.beginPath();
    ctx.moveTo(PAD.l, gy);
    ctx.lineTo(PAD.l + w, gy);
    ctx.stroke();
  }
  // 昨收虚线
  const py0 = Math.round(y(pre)) + 0.5;
  ctx.strokeStyle = alpha(sub, 0.55);
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(PAD.l, py0);
  ctx.lineTo(PAD.l + w, py0);
  ctx.stroke();
  ctx.setLineDash([]);

  const n = Math.max(1, Math.ceil(pts.length * progress));

  // 渐变面积
  const grad = ctx.createLinearGradient(0, PAD.t, 0, PAD.t + h);
  grad.addColorStop(0, alpha(color, 0.24));
  grad.addColorStop(1, alpha(color, 0));
  ctx.beginPath();
  ctx.moveTo(x(0), y(pts[0].price));
  for (let i = 1; i < n; i++) ctx.lineTo(x(i), y(pts[i].price));
  ctx.lineTo(x(n - 1), PAD.t + h);
  ctx.lineTo(x(0), PAD.t + h);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // 均价线
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.strokeStyle = "rgba(255,159,10,0.85)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  let started = false;
  for (let i = 0; i < (showAvg ? n : 0); i++) {
    const a = pts[i].avg;
    if (a == null || a <= 0) continue;
    if (!started) ctx.moveTo(x(i), y(a));
    else ctx.lineTo(x(i), y(a));
    started = true;
  }
  if (started) ctx.stroke();

  // 价格线
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x(0), y(pts[0].price));
  for (let i = 1; i < n; i++) ctx.lineTo(x(i), y(pts[i].price));
  ctx.stroke();

  // 端点光晕
  const ex = x(n - 1);
  const ey = y(pts[n - 1].price);
  ctx.fillStyle = alpha(color, 0.22);
  ctx.beginPath();
  ctx.arc(ex, ey, 5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(ex, ey, 2.4, 0, Math.PI * 2);
  ctx.fill();

  // 涨跌幅刻度
  const pctDev = (dev / pre) * 100;
  ctx.font = `10px ${UI_FONT}`;
  ctx.textAlign = "right";
  ctx.textBaseline = "top";
  ctx.fillStyle = alpha(up, 0.8);
  ctx.fillText(`+${pctDev.toFixed(2)}%`, PAD.l + w, PAD.t - 8);
  ctx.textBaseline = "bottom";
  ctx.fillStyle = alpha(down, 0.8);
  ctx.fillText(`-${pctDev.toFixed(2)}%`, PAD.l + w, PAD.t + h - 1);

  // 时间轴
  ctx.fillStyle = sub;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";
  ctx.fillText(fmtTime(pts[0].time), PAD.l, cssH - 3);
  if (total === 241) {
    ctx.textAlign = "center";
    ctx.fillText("11:30/13:00", x(120), cssH - 3);
    ctx.textAlign = "right";
    ctx.fillText("15:00", PAD.l + w, cssH - 3);
  } else {
    ctx.textAlign = "right";
    ctx.fillText(fmtTime(pts[pts.length - 1].time), PAD.l + w, cssH - 3);
  }

  // 十字光标 + 顶部信息
  const hv = trendHover.get(holder);
  if (hv != null && progress >= 1) {
    const i = Math.min(Math.max(hv, 0), pts.length - 1);
    const p = pts[i];
    const hx = Math.round(x(i)) + 0.5;
    const hy = Math.round(y(p.price)) + 0.5;
    ctx.strokeStyle = alpha(sub, 0.6);
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(hx, PAD.t);
    ctx.lineTo(hx, PAD.t + h);
    ctx.moveTo(PAD.l, hy);
    ctx.lineTo(PAD.l + w, hy);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = color;
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(hx, hy, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    if (meta) {
      const pct = ((p.price - pre) / pre) * 100;
      const d = dirOf(pct);
      meta.innerHTML =
        `<span>${fmtTime(p.time)}</span>` +
        `<b class="${d}">${fmtPrice(p.price)}</b><b class="${d}">${fmtPct(pct)}</b>`;
    }
  } else if (meta) {
    meta.innerHTML =
      `<span>高 <b class="${dirOf(max - pre)}">${fmtPrice(max)}</b></span>` +
      `<span>低 <b class="${dirOf(min - pre)}">${fmtPrice(min)}</b></span>`;
  }
}

// 悬停十字光标
document.addEventListener("pointermove", (e) => {
  const cv = e.target as HTMLElement;
  if (!(cv instanceof HTMLCanvasElement)) return;
  const holder = cv.closest<HTMLElement>(".trend");
  const data = holder && trendCache.get(holder.dataset.id ?? "");
  if (!holder || !data || trendAnim.has(holder)) return;
  const r = cv.getBoundingClientRect();
  const w = r.width - PAD.l - PAD.r;
  const i = Math.round(((e.clientX - r.left - PAD.l) / w) * (trendTotal(data) - 1));
  if (trendHover.get(holder) === i) return;
  trendHover.set(holder, i);
  drawTrend(holder);
});
document.addEventListener("pointerout", (e) => {
  const cv = e.target as HTMLElement;
  if (!(cv instanceof HTMLCanvasElement)) return;
  const holder = cv.closest<HTMLElement>(".trend");
  if (!holder) return;
  trendHover.delete(holder);
  drawTrend(holder);
});

function renderIndices(): void {
  const wrap = $("#indices");
  for (const it of INDICES) {
    const card = $(`.idx[data-id="${it.secid}"]`, wrap);
    const q = quotes.get(it.secid);
    const d = dirOf(q?.pct);
    const price = $(".idx-price", card);
    const chg = $(".idx-chg", card);
    const pText = q?.price == null ? "--" : q.price.toFixed(2);
    const old = Number(price.dataset.v);
    if (q?.price != null && price.dataset.v && q.price !== old) {
      card.classList.remove("flash-up", "flash-down");
      void card.offsetWidth;
      card.classList.add(q.price > old ? "flash-up" : "flash-down");
    }
    if (q?.price != null) price.dataset.v = String(q.price);
    price.textContent = pText;
    $(".idx-change", chg).textContent = fmtChange(q?.change);
    $(".idx-pct", chg).textContent = fmtPct(q?.pct);
    price.className = `idx-price ${d}`;
    chg.className = `idx-chg ${d}`;
    card.dataset.dir = d;
    card.classList.toggle("active", S.selected === it.secid);
    card.classList.toggle("open", trendOpen === it.secid);
    card.classList.toggle("in-bar", S.bar.includes(it.secid));
  }
}

// ---------- 顶栏 ----------

function renderHeader(): void {
  const q = quotes.get(S.selected);
  const status = sessionStatus(regionOf(S.selected), new Date(), q?.time);
  $("#title-name").textContent = q?.name ?? codeOf(S.selected);
  $("#title-sub").textContent = `${marketTag(S.selected)} ${codeOf(S.selected)} · ${status.text}`;

  $("#src-label").textContent = `数据来源：${sourceLabel()}`;

  const bar = $("#error-bar");
  bar.classList.toggle("show", failCount > 0);
  if (failCount > 0) bar.textContent = errorMsg;

  // 更新提示条：启动时查到新版本才有，点它去设置窗口的「关于」页
  const hint = hintText(updateInfo);
  const updateBar = $("#update-bar");
  updateBar.hidden = !hint;
  if (hint) $<HTMLElement>("#update-text").textContent = hint;
}

/** 底部「数据来源」文案：自动模式时说明当前实际命中哪家；取不到数据时明说 */
function sourceLabel(): string {
  const NAME: Record<string, string> = { eastmoney: "东方财富", tencent: "腾讯" };
  if (S.source !== "auto") return NAME[S.source] ?? "东方财富";
  // 还没拿到过行情（activeSource 为 null，比如两家都挂了）时不谎报某一家
  const active = getActiveSource();
  return active ? `${NAME[active]}（自动）` : "自动";
}

// ---------- 自选列表 ----------

const prevPrice = new Map<string, number>();

const ICON_PIN = `<svg viewBox="0 0 24 24"><path d="M12 17v5M9 3h6l-1 7 4 3v2H6v-2l4-3z"/></svg>`;
const ICON_FOLDER = `<svg viewBox="0 0 24 24"><path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4l2 2.5h7A1.5 1.5 0 0 1 19 10v7a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17z"/></svg>`;
/**
 * 右键菜单里的置顶 / 取消置顶。
 * 置顶：向上钉到顶部横线；取消置顶：同一个横线、箭头朝下（从置顶区放下来）。
 * 别用「同图案 + 斜杠」—— 14px 下斜杠和箭头会糊成一个「不」字。
 */
const ICON_PIN_ON = `<svg viewBox="0 0 24 24"><path d="M4.5 4.5h15M12 20V9M7.5 13L12 8.5l4.5 4.5"/></svg>`;
const ICON_PIN_OFF = `<svg viewBox="0 0 24 24"><path d="M4.5 4.5h15M12 9v11M7.5 15l4.5 4.5 4.5-4.5"/></svg>`;

// ---------- 自选分组 ----------
// 分组只决定自选列表怎么看：菜单栏（bar）与置顶（pins）都不受它影响。

/** 筛选条的两块：横着滚的标签容器 + 放不下时才出现的 ☰ */
const tabScroll = $("#gtab-scroll");
const tabMore = $("#gtab-more");

/** 正在看的分组：null = 全部；未分组是空字符串，不能用假值判断 */
let groupFilter: string | null = null;

/** 正在改名的分组 id：筛选条上那一格换成输入框 */
let tabRename: string | null = null;

/** 按住拖动筛选条：tabDrag 是按下时的位置，tabDraggedAt 是最后一下拖动的时间 */
let tabDrag: { x: number; left: number } | null = null;
let tabDraggedAt = 0;

/** 当前视图里的自选（顺序仍与整表一致） */
function visibleIds(): string[] {
  return groupFilter === null ? S.watchlist : itemsOf(S.watchlist, S.groupOf, S.groups, groupFilter);
}

/**
 * 筛选条上的分组：没建过分组时整条不出现。
 * 只有「全部」与用户建的分组 —— 没有归属的股票就在「全部」里，不再单列一个「未分组」。
 * 成员数为 0 的分组也留着 —— 刚建好的空分组不该立刻消失。
 */
function groupTabs(): { gid: string | null; name: string; n: number }[] {
  return [
    { gid: null, name: "全部", n: S.watchlist.length },
    ...S.groups.map((g) => ({
      gid: g.id as string | null,
      name: g.name,
      n: itemsOf(S.watchlist, S.groupOf, S.groups, g.id).length,
    })),
  ];
}

/**
 * 筛选条内容没变就不重写 DOM，免得每次行情刷新都重建按钮（按下 / 悬停状态会被打断）。
 * 注意这里不把选中的标签「拉回视野」：行情每隔几秒就刷新一次，那样会把用户自己滑到的
 * 位置一次次拽回去，等于又点不到后面的分组了。只有选中项真的变了（见 pickGroup）才拉。
 */
function renderTabs(): void {
  const box = $("#gtabs");
  const tabs = groupTabs();

  // 正在改名的分组已经不在筛选条上了（别的窗口把它删了）：改名态跟着作废
  if (tabRename && !tabs.some((t) => t.gid === tabRename)) tabRename = null;
  // 正在看的分组已经不在筛选条上了（成员被移空、分组被删）：退回「全部」，
  // 否则会出现没有任何标签高亮、列表却还筛着的状态
  const fellBack = groupFilter !== null && !tabs.some((t) => t.gid === groupFilter);
  if (fellBack) groupFilter = null;
  // 板块视图里没有自选列表，筛选条也就不该出现
  const show = S.groups.length > 0 && view === "watch";
  box.hidden = !show;
  if (!show) {
    box.dataset.key = "";
    if (tabScroll.innerHTML) tabScroll.innerHTML = "";
    tabMore.hidden = true;
    tabRename = null; // 筛选条收起来了：改名态别留着（看不见的输入框也拿不到焦点）
    return;
  }
  // 改名中的那一格进 key：改名期间不因为「内容没变」被重画掉，输入框才拿得住焦点与光标
  const key = `${tabRename ?? ""}|${groupFilter ?? "*"}|${tabs.map((t) => `${t.gid}:${t.name}:${t.n}`).join(",")}`;
  if (key !== box.dataset.key) {
    // 别处（另一个窗口 / MCP）此刻改了设置，整条会被重画：手正打着的字先留一份，重画后填回去，
    // 否则「改了一半的名字被换回原名」看着就是自己白打了（只有同一格才认这份草稿）
    const editing = $<HTMLInputElement>(".gtab-input", tabScroll);
    const draft = editing && editing.dataset.gid === tabRename ? editing.value : undefined;
    box.dataset.key = key;
    tabScroll.innerHTML = tabs
      .map((t) => {
        // 正在改名的那一格：换成输入框（与设置 › 行情 一样就地改，只是这里改的是筛选条上的标签）
        if (t.gid && t.gid === tabRename) {
          return `<input class="gtab-input" data-gid="${t.gid}" maxlength="${GROUP_NAME_MAX}" aria-label="分组名称" />`;
        }
        const on = t.gid === groupFilter;
        return (
          `<button class="gtab${on ? " on" : ""}" data-gid="${t.gid ?? "*"}" aria-pressed="${on}">` +
          `${esc(t.name)}<b>${t.n}</b></button>`
        );
      })
      .join("");
    if (tabRename) mountRename(draft);
  }
  syncTabMore();
  // 退回「全部」也算换了选中项：它多半藏在左边，得带进视野
  if (fellBack) scrollTabIntoView();
}

/** 筛选条横着放不下才给末尾的 ☰（放得下就不占位置）；窗口宽度变了也要重算 */
function syncTabMore(): void {
  tabMore.hidden = tabScroll.scrollWidth <= tabScroll.clientWidth + 1;
}

/**
 * 把筛选条上的某一格带进视野（默认是当前选中的那个）。
 * 直接跳（不 smooth）：这是菜单里点一下的即时反馈，跳过去最干脆；
 * 平滑滚动在有些 webview 里不推进（面板不可见时被节流），那就等于没滚 —— 标签还藏在右边。
 */
function scrollTabIntoView(el: Element | null = $(".gtab.on", tabScroll)): void {
  if (!el || tabScroll.scrollWidth <= tabScroll.clientWidth) return;
  const d = scrollDeltaFor(el.getBoundingClientRect(), tabScroll.getBoundingClientRect());
  if (!d) return;
  tabScroll.scrollLeft += d;
}

/** 切到某个分组（null = 全部）：筛选条上的标签与末尾 ☰ 的菜单共用这一处 */
function pickGroup(gid: string | null): void {
  if (gid === groupFilter) return;
  groupFilter = gid;
  renderList(); // 重画筛选条
  scrollTabIntoView(); // 选中的那个可能还藏在右边
}

// ---------- 分组管理（新建 / 改名 / 删除） ----------
// 分组的几件事各有各的去处：筛选条上按分组筛、☰ 弹层里拖顺序，这里补上「新建 / 改名 / 删除」。
// 与设置 › 行情 是同一份数据、同一套纯函数（settings.ts 的 newGroup / renameGroup / removeGroup），
// 所以两边怎么改都立刻一致。

/** 新建分组：默认名字只是占位，建好立刻在筛选条上进入改名（与设置 › 行情 一致） */
function addGroup(): void {
  const g = newGroup(S.groups);
  S.groups = [...S.groups, g];
  tabRename = g.id;
  save();
  renderAll(); // renderTabs 会把新那一格渲染成输入框，并在重建后把光标交出去
}

/** 就地改名：筛选条上那一格换成输入框 */
function startRename(gid: string): void {
  if (!S.groups.some((g) => g.id === gid)) return;
  tabRename = gid;
  renderList();
}

/**
 * 筛选条上那一格的改名输入框：挂上焦点与收尾。
 * 回车 / 失焦提交，Esc 放弃 —— 与设置 › 行情的分组改名同一套手感。
 * draft：整条被重画之前留下的草稿（见 renderTabs），有它就把手打了一半的字填回去。
 */
function mountRename(draft?: string): void {
  const gid = tabRename;
  const input = $<HTMLInputElement>(".gtab-input", tabScroll);
  if (!gid || !input) return;
  input.value = draft ?? groupNameOf(S.groups, gid);
  syncTabMore(); // ☰ 出不出现会改变能滚的空间：先把它定下来，「带进视野」才算得准
  scrollTabIntoView(input); // 改名的那一格可能还横滑在右边
  input.focus();
  // 新起一次改名：旧名整段选中，直接打字就替换掉；接着改草稿的话，光标落在末尾
  if (draft == null) input.select();
  else input.setSelectionRange(input.value.length, input.value.length);
  let done = false;
  const finish = (submit: boolean) => {
    if (done) return;
    done = true;
    tabRename = null;
    if (submit) {
      S.groups = renameGroup(S.groups, gid, input.value); // 空名字视为放弃，原样返回
      save();
    }
    renderList(); // 输入框换回标签（tabRename 进 key，这一下必然重建）
  };
  input.addEventListener("keydown", (e) => {
    // 输入法还在拼字（拼音候选没定下来）时敲的回车 / Esc 是给输入法的，不是给这一格的：
    // 不管它就会把拼音字母当成名字提交（WebKit 这边 isComposing 不一定给，229 是通用兜底）
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.stopPropagation(); // 别让「Esc 收起面板」跟着触发
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

/** 删除分组：成员回落到未分组（自选一只都不少），自选顺序与菜单栏都不受影响 */
function removeGroupNow(gid: string): void {
  const next = removeGroup(S.groups, S.groupOf, gid);
  S.groups = next.groups;
  S.groupOf = next.groupOf;
  save();
  renderAll(); // 正在看的正是这个分组时，renderTabs 会把筛选退回「全部」
}

/**
 * 分组标签 / 弹层胶囊的右键菜单：新建、改名、删除。
 * 「＋ 新建分组」放在最前 —— 筛选条上不再有常驻的 ＋（那会一直占掉一格），
 * 而 ☰ 弹层只在筛选条放不下时才出现，分组少的人就只剩这一个入口了。
 * 调整顺序不在这里 —— 筛选条上「横滑看后面的分组」和「拖胶囊」都是横向手势，放一起会撞，
 * 拖顺序在 ☰ 弹层里做（见 openGroupChips）。
 */
function openGroupMenu(gid: string, x: number, y: number): void {
  if (!S.groups.some((g) => g.id === gid)) return;
  openMenu(x, y, [
    { label: "＋ 新建分组", onPick: () => addGroup() },
    { label: "重命名", onPick: () => startRename(gid) },
    { label: "删除分组…", danger: true, onPick: () => confirmRemoveGroup(gid, x, y) },
  ]);
}

/**
 * 删除分组不可逆，所以再问一次：菜单就地换成一条「确认删除」（把成员的去向说清楚），
 * Esc / 点别处即取消。主面板这条筛选条只有 26px 高，摊一条确认条放不下，就用第二次点击来确认。
 */
function confirmRemoveGroup(gid: string, x: number, y: number): void {
  const g = S.groups.find((it) => it.id === gid);
  if (!g) return; // 菜单是点开那一刻渲染的：这个分组可能已经被别的窗口删掉了
  const n = itemsOf(S.watchlist, S.groupOf, S.groups, gid).length;
  openMenu(x, y, [
    {
      label: n ? `确认删除「${g.name}」（${n} 只移入未分组）` : `确认删除「${g.name}」`,
      danger: true,
      onPick: () => removeGroupNow(gid),
    },
    { label: "取消" },
  ]);
}

$("#gtabs").addEventListener("click", (e) => {
  // 拖动那一下松手会跟一个 click：别顺手把分组切了
  if (isDragClick(tabDraggedAt, Date.now())) {
    tabDraggedAt = 0;
    return;
  }
  const gid = (e.target as HTMLElement).closest<HTMLElement>(".gtab")?.dataset.gid;
  if (gid === undefined) return;
  pickGroup(gid === "*" ? null : gid);
});
// 右键分组标签：改名 / 删除（「全部」不是分组，没有菜单，但系统右键菜单一样不弹）
$("#gtabs").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const gid = (e.target as HTMLElement).closest<HTMLElement>(".gtab")?.dataset.gid;
  if (!gid || gid === "*") return;
  openGroupMenu(gid, e.clientX, e.clientY);
});

// 末尾 ☰：横滑出去的分组从这里点。内容不按菜单排，而是摊成和筛选条上那排一模一样的
// 标签（带数量、当前这个高亮），分组多时自动换行，比一长条菜单矮得多。
// 弹层挂在 ☰ 上，筛选条自己横着滚不会挪动它，所以那种滚动不该把它收起来。
//
// 用户建的分组在这一层里也能直接拖动排序：这里把所有分组一次摊开（不像筛选条那样要横滑），
// 「拖动」和「看后面的分组」就不会撞。顺序 = 设置里的分组顺序，与设置 › 行情 那排胶囊共用同一份。
/** 刚在这层里拖完的时间：松手跟来的那一下 click 不该顺手切分组 */
let moreDraggedAt = 0;

/**
 * 弹层的内容：用户建的分组带 key（可拖），「全部」固定在最前、不给 key 也就拖不走；
 * 末尾再补一颗「＋ 新建分组」——这里分组一次摊开，正在整理分组的人顺手就能加一只
 * （同样不给 key，所以它不参与拖动排序）。
 */
function groupChips(): MenuItem[] {
  return [
    ...groupTabs().map((t) => ({
      label: t.name,
      count: t.n,
      on: t.gid === groupFilter,
      key: t.gid || undefined,
      onPick: () => pickGroup(t.gid),
    })),
    { label: "＋ 新建分组", onPick: () => addGroup() },
  ];
}

function openGroupChips(): void {
  const r = tabMore.getBoundingClientRect();
  openMenu(r.right, r.bottom + 4, groupChips(), {
    ignoreScrollFrom: tabScroll,
    layout: "chips",
    // 拖动排序挂在这一层上：弹层是每次点开新造的，所以按需注册（菜单一关就随 DOM 一起没了）
    onOpen: (el) => {
      // 拖动松手跟来的那一下 click：在捕获阶段就拦掉 —— 那一层自己的点击处理在冒泡阶段，
      // 不拦的话它会关掉弹层并「切分组」（拖完就想接着拖第二颗的人会白点一下）
      el.addEventListener(
        "click",
        (e) => {
          if (!isDragClick(moreDraggedAt, Date.now())) return;
          moreDraggedAt = 0;
          e.stopPropagation();
          e.preventDefault();
        },
        true,
      );

      // 弹层里的胶囊也能右键：与筛选条上的标签同一套菜单（改名照样落在筛选条那一格上）
      el.addEventListener("contextmenu", (e) => {
        const chip = (e.target as HTMLElement).closest<HTMLElement>(".ctx-chip[data-key]");
        if (!chip?.dataset.key) return;
        e.preventDefault();
        openGroupMenu(chip.dataset.key, e.clientX, e.clientY);
      });
      sortable({
        list: el,
        row: ".ctx-chip[data-key]",
        ident: "key",
        handle: ".ctx-chip[data-key]", // 整颗胶囊就是把手
        rowDrag: true,
        axis: "grid", // 会换行，落点按两轴算
        movable: () => S.groups.length > 1,
        apply: (from, to) => {
          moreDraggedAt = Date.now();
          S.groups = moveItem(S.groups, from, to);
          save();
          // 就地换位：把弹层里那排胶囊按新顺序重排，而不是关掉重开 ——
          // 重开会整层重建，看着就是「拖完闪一下」。data-i 跟着各自的项走，点哪个仍然切哪个。
          const chips = [...el.querySelectorAll<HTMLElement>(".ctx-chip[data-key]")];
          // 清位移这一步不该被动画化（胶囊上有 transform 过渡）：先关掉过渡、换完顺序强制回流，
          // 再恢复 —— 画面就停在松手那一刻，既不会跳也不会闪
          chips.forEach((c) => {
            c.style.transition = "none";
            c.style.transform = "";
          });
          const [moved] = chips.splice(from, 1);
          chips.splice(to, 0, moved);
          chips.forEach((c) => el.append(c));
          void el.offsetHeight;
          chips.forEach((c) => (c.style.transition = ""));
          renderList(); // 筛选条跟着换顺序
        },
        render: () => {
          /* 没换位的拖动只留下位移，由 sortable 自己复位；这里的 DOM 不重建 */
        },
      });
    },
  });
}

tabMore.addEventListener("click", () => openGroupChips());

// 横向滑：鼠标滚轮（竖直方向）也能把筛选条推向右边；触控板横滑是浏览器原生的，这里不拦
tabScroll.addEventListener(
  "wheel",
  (e) => {
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // 横向手势交给原生滚动
    if (tabScroll.scrollWidth <= tabScroll.clientWidth) return; // 没溢出就正常滚页面
    const before = tabScroll.scrollLeft;
    tabScroll.scrollLeft = before + e.deltaY;
    if (tabScroll.scrollLeft !== before) e.preventDefault(); // 已经到头就把滚动还给页面
  },
  { passive: false },
);

// 鼠标按住拖动也能往右滑：触控板有横滑手势，鼠标没有
tabScroll.addEventListener("pointerdown", (e) => {
  // 在改名输入框里按下是选文字，不是「按住横滑筛选条」
  if (e.button !== 0 || (e.target as HTMLElement).closest(".gtab-input")) return;
  if (tabScroll.scrollWidth <= tabScroll.clientWidth) return;
  tabDrag = { x: e.clientX, left: tabScroll.scrollLeft };
  tabDraggedAt = 0;
});
window.addEventListener("pointermove", (e) => {
  if (!tabDrag) return;
  const dx = e.clientX - tabDrag.x;
  if (!isDragMove(dx, tabDraggedAt > 0)) return; // 手抖不算拖动
  tabDraggedAt = Date.now();
  tabScroll.scrollLeft = tabDrag.left - dx;
});
const endTabDrag = () => {
  tabDrag = null;
};
window.addEventListener("pointerup", endTabDrag);
window.addEventListener("pointercancel", endTabDrag);

/** 右键菜单里的「移入分组」：一个目标一项（菜单没有子菜单），没建过分组或不是自选就整组不出现 */
function groupMenuItems(id: string): MenuItem[] {
  if (!S.groups.length || !S.watchlist.includes(id)) return [];
  return groupTargets(S.groups, S.groupOf, id).map((t) => ({
    label: `移入「${t.name}」`,
    onPick: () => {
      S.groupOf = setGroup(S.groupOf, id, t.gid);
      save();
      renderAll();
    },
  }));
}

/** 结构（自选 / 分组 / 置顶 / 筛选）变化才重建 DOM；行情刷新只原地改文字，动效与展开状态不被打断 */
function renderList(): void {
  const box = $("#list");
  renderTabs();
  const ids = visibleIds();
  if (!S.watchlist.length) {
    box.dataset.key = "";
    box.innerHTML =
      `<div class="empty list-empty"><svg viewBox="0 0 24 24"><path d="M3 17l6-6 4 4 8-8M15 7h6v6"/></svg>` +
      `<div>搜索并添加你的第一只股票</div></div>`;
    return;
  }
  if (!ids.length) {
    box.dataset.key = "";
    box.innerHTML =
      `<div class="empty list-empty">${ICON_FOLDER}` +
      `<div>「${esc(groupNameOf(S.groups, groupFilter ?? UNGROUPED))}」还没有标的</div>` +
      `<div class="list-tip">在设置 › 行情里右键「移入分组」</div></div>`;
    return;
  }
  // 分组名也要进 key：改名后没有别的变化，标签也得跟着换；
  // groupFilter 同理 —— 一个分组装下全部自选时，切「全部 / 该分组」的 ids 完全一样
  // 置顶区长度按「当前视图」算：分组视图里置顶的也排在该分组的最前
  const pinnedCount = pinCount(ids, S.pins);
  const gids = ids.map((id) => groupIdOf(S.groupOf, S.groups, id));
  const key =
    `${groupFilter ?? "*"}|${ids.join(",")}|${S.pins.join(",")}|${S.bar.join(",")}|` +
    gids.map((g) => groupNameOf(S.groups, g)).join(",");
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = ids
      .map((id, i) => {
        const gid = gids[i];
        const pinned = S.pins.includes(id);
        // 只在「全部」里标出分组：筛选到某个分组时这个标签是多余的
        const gtag =
          gid && groupFilter === null
            ? `<span class="tag gtag">${esc(groupNameOf(S.groups, gid))}</span>`
            : "";
        // 分界画在「置顶区之后的第一行」上：置顶那行自己的分时图紧跟其后，
        // 画在置顶行上会在行与自己的图之间也多出一条线
        const divider = !pinned && pinnedCount > 0 && i === pinnedCount;
        return (
          `<div class="row${pinned ? " pinned" : ""}${divider ? " first-unpinned" : ""}"` +
          ` data-id="${esc(id)}" style="--i:${i + INDICES.length}">` +
          `<div class="row-main"><div class="row-name"></div>` +
          `<div class="row-meta"><span class="tag">${marketTag(id)}</span>${gtag}${esc(codeOf(id))}` +
          `${S.bar.includes(id) ? `<span class="pin-mark" title="已显示在菜单栏（在设置 › 行情中调整）">${ICON_PIN}</span>` : ""}</div></div>` +
          `<div class="row-price"></div>` +
          `<div class="pill flat">--</div>` +
          `</div>` +
          `<div class="trend${trendOpen === id ? " show" : ""}" data-id="${esc(id)}">${trendInner()}</div>`
        );
      })
      .join("");
  }

  box.querySelectorAll<HTMLElement>(".row").forEach((row) => {
    const id = row.dataset.id!;
    const q = quotes.get(id);
    const d = dirOf(q?.pct);
    $(".row-name", row).textContent = nameOf(id);
    const price = $(".row-price", row);
    price.textContent = fmtPrice(q?.price);
    const pill = $(".pill", row);
    pill.textContent = fmtPct(q?.pct);
    pill.className = `pill ${d}`;
    row.classList.toggle("active", id === S.selected);
    row.classList.toggle("open", id === trendOpen);

    // 价格跳动闪烁
    const p = q?.price;
    const old = prevPrice.get(id);
    if (p != null && old != null && p !== old) {
      price.classList.remove("flash-up", "flash-down");
      void price.offsetWidth;
      price.classList.add(p > old ? "flash-up" : "flash-down");
    }
    if (p != null) prevPrice.set(id, p);
  });
}

/** 从自选与菜单栏中一并移除一只股票（列表行的右键删除） */
function removeStock(id: string): void {
  S.watchlist = S.watchlist.filter((x) => x !== id);
  S.pins = S.pins.filter((x) => x !== id);
  S.bar = S.bar.filter((x) => x !== id);
  S.groupOf = dropGroupOf(S.groupOf, [id]);
  if (S.selected === id) S.selected = S.watchlist[0] ?? INDICES[0].secid;
  if (trendOpen === id) trendOpen = null;
  save();
  renderAll();
  updateTray();
  syncTicker();
}

/**
 * 置顶 / 取消置顶（自选行的右键菜单）。
 * 只动自选顺序与 pins：选中项、展开的分时图与菜单栏都不受影响，所以不必刷新托盘。
 */
function togglePin(id: string): void {
  if (!S.watchlist.includes(id)) return;
  const on = S.pins.includes(id);
  const next = on ? unpinItem(S.watchlist, S.pins, id) : pinItem(S.watchlist, S.pins, id);
  S.watchlist = next.list;
  S.pins = next.pins;
  save();
  renderAll();
}

// 自选行也能直接拖动排序：顺序写回 watchlist。跨过置顶分界就是在两个区块之间搬 ——
// 拖进置顶区的那一只顺手置顶、拖出去的顺手取消置顶（见 settings.ts 的 moveRowInView），
// 所以「置顶的始终在最前」一直成立；分组视图里的落点按视图换算回整表下标。
const listIds = () => [...document.querySelectorAll<HTMLElement>("#list .row")].map((r) => r.dataset.id!);
/** 刚把某一行拖走的时间：松手跟来的那一下 click 不该顺手展开分时图 */
let rowDraggedAt = 0;
sortable({
  list: $("#list"),
  row: ".row",
  handle: ".row-name", // 触屏只有从名称起拖才排序：行其他地方拖动仍然是滚列表
  rowDrag: true,
  movable: () => visibleIds().length > 1,
  apply: (from, to) => {
    rowDraggedAt = Date.now();
    const next = moveRowInView(S.watchlist, S.pins, listIds(), from, to);
    S.watchlist = next.list;
    S.pins = next.pins;
    save();
    renderList();
  },
  render: renderList,
});

$("#list").addEventListener("click", (e) => {
  // 拖动松手跟来的那一下 click 不算点行（别顺手把分时图展开了）
  if (isDragClick(rowDraggedAt, Date.now())) {
    rowDraggedAt = 0;
    return;
  }
  const id = (e.target as HTMLElement).closest<HTMLElement>(".row")?.dataset.id;
  if (id) toggleTrend(id);
});

// 右键菜单：删除自选，或把已置顶的标的移出菜单栏
$("#list").addEventListener("contextmenu", (e) => {
  e.preventDefault(); // 面板里不弹系统右键菜单
  const id = (e.target as HTMLElement).closest<HTMLElement>(".row")?.dataset.id;
  if (!id) return;
  openMenu(e.clientX, e.clientY, [
    {
      label: S.pins.includes(id) ? "取消置顶" : "置顶",
      icon: S.pins.includes(id) ? ICON_PIN_OFF : ICON_PIN_ON,
      onPick: () => togglePin(id),
    },
    ...groupMenuItems(id),
    ...(S.bar.includes(id)
      ? [
          {
            label: "从菜单栏移除",
            onPick: () => {
              S.bar = S.bar.filter((x) => x !== id);
              save();
              renderAll();
              updateTray();
              syncTicker();
            },
          },
        ]
      : []),
    { label: "删除自选", danger: true, onPick: () => removeStock(id) },
  ]);
});

// ---------- 板块榜单 ----------
// 板块不是标的：它只是一块只读榜单，不进自选 / 分组 / 置顶 / 菜单栏 / MCP
//（见 CONTEXT.md 与 docs/adr/0001-boards-are-read-only.md）。

/**
 * 视图切换：自选 ↔ 板块。切到板块时才去拉榜单（不打开这个视图的用户一次请求都不多发）。
 * 换视图时把搜索清掉：两边搜索是两回事（自选走远程 suggest、板块是就地过滤），留着只会让人困惑。
 */
function setView(next: "watch" | "board"): void {
  if (view === next) return;
  view = next;
  searchInput.value = "";
  boardQuery = "";
  closeSearch();
  renderView();
  if (next === "board") void loadBoards();
}

/**
 * 按当前视图决定显示哪一块，并重画它。
 * 大盘指数卡片与搜索框两个视图都留着 —— 板块的搜索是**就地过滤**当前口径那份榜单
 * （搜索接口 suggest 不返回板块，见 boards.ts 的 searchBoards），所以换个提示词即可。
 */
function renderView(): void {
  const board = view === "board";
  $("#vtabs")
    .querySelectorAll<HTMLElement>(".vtab")
    .forEach((b) => {
      const on = (b.dataset.view === "board") === board;
      b.classList.toggle("on", on);
      b.setAttribute("aria-selected", String(on));
    });
  $(".search").hidden = false; // 两个视图都用得上，只是提示词不同
  searchInput.placeholder = board ? "搜索板块名" : "搜索代码 / 名称 / 拼音";
  $("#list").hidden = board;
  $("#bctl").hidden = !board;
  $("#boards").hidden = !board;
  if (board) {
    $("#gtabs").hidden = true; // 筛选条属于自选列表（renderTabs 里还有一道按视图的判断）
    renderBoards();
  } else {
    renderList(); // 里面会顺带按视图决定筛选条出不出现
  }
}

/**
 * 拉当前口径的全部板块，按设置里的数据源取（auto 时东财不通会自动退腾讯）。
 * 失败时保留上一份榜单：多一份旧数据也好过整块闪没（与分时一致）。
 * 只在板块视图打开时被调用 —— 不打开这个视图的用户，一次请求都不会多发。
 */
async function loadBoards(): Promise<void> {
  const kind = boardKind;
  if (boardsBusy === kind) return; // 同一口径还在路上：等它回来
  const seq = ++boardsSeq;
  boardsBusy = kind;
  boardsLoading = true;
  renderBoards();
  try {
    const got = await fetchBoards(kind, S.source, boardSubs);
    if (seq !== boardsSeq) return; // 拉的过程中换了口径：这份数据已经没用了
    boards = got;
    got.forEach((b) => boardNames.set(b.secid, b.name));
    // 换了数据源之后，屏上可能还开着一个属于上一家的板块：它的行马上会被重建掉，顺手收起
    if (isBoardSecid(trendOpen ?? "") && !got.some((b) => b.secid === trendOpen)) trendOpen = null;
    boardsErr = false;
  } catch {
    if (seq === boardsSeq) boardsErr = true;
  } finally {
    if (seq === boardsSeq) {
      boardsBusy = null;
      boardsLoading = false;
      renderBoards();
    }
  }
}
/** 控制条：口径胶囊只建一次，之后只改选中态与两个按钮的文案；count 是当前榜上显示的条数 */
function renderBoardCtl(count: number): void {
  const kindBox = $("#bkind");
  if (!kindBox.dataset.built) {
    kindBox.dataset.built = "1";
    kindBox.innerHTML = BOARD_KINDS.map(
      (k) => `<button class="gtab" data-kind="${k.kind}">${k.label}</button>`,
    ).join("");
  }
  kindBox
    .querySelectorAll<HTMLElement>(".gtab")
    .forEach((b) => b.classList.toggle("on", b.dataset.kind === boardKind));

  const order = $("#border");
  order.textContent = boardOrder === "up" ? "涨幅 ↓" : "跌幅 ↑";
  order.title = boardOrder === "up" ? "当前是涨幅榜，点一下看跌幅榜" : "当前是跌幅榜，点一下看涨幅榜";
  order.classList.add("on");
  $("#bsubs").classList.toggle("on", boardSubs);
  // 条数：两家的板块数量差得很远（行业东财 496 / 腾讯 155），摆出来才不会被当成 bug
  $("#bcount").textContent = count ? `${count} 个` : "";
}

/**
 * 榜单：成员（口径 / 含细分 / 有哪些板块）变了才重建 DOM，名次变化只搬 DOM、行情刷新只改文字 ——
 * 与自选列表同一套做法，展开中的分时图不被打断。
 */
function renderBoards(): void {
  const box = $("#boards");
  const rows = boardRows(boards, { showSubs: boardSubs, order: boardOrder, query: boardQuery });
  renderBoardCtl(rows.length);

  if (!rows.length) {
    const kw = boardQuery.trim();
    box.dataset.key = "";
    box.innerHTML =
      `<div class="empty list-empty">` +
      (kw
        ? `<div>没有匹配「${esc(kw)}」的板块</div>` +
          `<div class="list-tip">只搜当前口径（${boardKindLabel(boardKind)}），换一个口径再试</div>`
        : boardsLoading
          ? `<div>加载中…</div>`
          : boardsErr
            ? `<div>板块榜单加载失败</div><div class="list-tip">下一个刷新周期会自动重试</div>`
            : `<div>没有板块</div>`) +
      `</div>`;
    return;
  }

  const ids = rows.map((b) => b.secid);
  // key 只看「有哪些板块」，**不看名次**：涨跌幅每几秒就在动，把顺序算进 key 会让整块反复重建，
  // 而重建会把展开中的分时图一起丢掉。名次变化改用搬 DOM 处理（见 reorderBoards）。
  const key = `${boardKind}|${boardSubs}|${[...ids].sort().join(",")}`;
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = rows
      .map((b, i) => {
        // --i 只用来错开入场动画的延迟：不封顶的话第 500 行要等 20 秒才出现
        const delay = Math.min(i, 8);
        return (
          `<div class="row brow" data-id="${esc(b.secid)}" style="--i:${delay}">` +
          `<div class="row-main"><div class="row-name"></div><div class="row-meta"></div></div>` +
          `<div class="pill flat">--</div></div>` +
          `<div class="trend${trendOpen === b.secid ? " show" : ""}" data-id="${esc(b.secid)}">${trendInner()}</div>`
        );
      })
      .join("");
    // 重建出来的分时面板只有 .show、还没画过：这里补画一次（数据仍在 trendCache 里）
    renderTrendPanels();
  } else {
    reorderBoards(box, ids);
  }

  const byId = new Map(rows.map((b) => [b.secid, b]));
  box.querySelectorAll<HTMLElement>(".row").forEach((row) => {
    const b = byId.get(row.dataset.id!);
    if (!b) return;
    $(".row-name", row).textContent = b.name;
    // 领涨股告诉你「谁在带」，名字来自接口，必须转义
    $(".row-meta", row).innerHTML =
      b.leader == null
        ? ""
        : `<span>${leaderTag(b.leaderPct)}</span><span class="lead">${esc(b.leader)}</span>` +
          (b.leaderPct == null ? "" : `<b class="${dirOf(b.leaderPct)}">${fmtPct(b.leaderPct)}</b>`);
    const pill = $(".pill", row);
    pill.textContent = fmtPct(b.pct);
    pill.className = `pill ${dirOf(b.pct)}`;
    row.classList.toggle("open", row.dataset.id === trendOpen);
  });
}

/**
 * 把榜单的行按给定顺序搬到位（行后面那块分时面板跟着一起搬）。
 * 用「搬」而不是重写 innerHTML：展开中的分时图是一张画好的 canvas，
 * 重建会把它丢掉，而涨跌幅每几秒就会让名次换一换。
 */
function reorderBoards(box: HTMLElement, ids: string[]): void {
  const cur = [...box.querySelectorAll<HTMLElement>(".row")].map((r) => r.dataset.id!);
  if (cur.length === ids.length && cur.every((id, i) => id === ids[i])) return; // 名次没动
  // 先把「行 → 它后面那块分时面板」记下来：搬动过程中相邻关系会变
  const parts = new Map<string, { row: HTMLElement; trend: HTMLElement | null }>();
  box.querySelectorAll<HTMLElement>(".row").forEach((row) => {
    const next = row.nextElementSibling as HTMLElement | null;
    parts.set(row.dataset.id!, {
      row,
      trend: next && next.classList.contains("trend") ? next : null,
    });
  });
  // append 会把已有节点搬到末尾，所以按目标顺序逐个 append 出来的就是目标顺序
  for (const id of ids) {
    const part = parts.get(id);
    if (!part) continue;
    box.append(part.row);
    if (part.trend) box.append(part.trend);
  }
}

/**
 * 展开 / 收起某个板块的分时。
 * 与标的的分时（toggleTrend）有一处不同：**不动 S.selected** —— 板块不是标的，
 * 不该被写进设置里当「当前选中的标的」。
 */
async function toggleBoardTrend(id: string): Promise<void> {
  if (trendOpen === id) {
    trendOpen = null;
    syncOpenState();
    return;
  }
  trendOpen = id;
  syncOpenState();
  const had = trendCache.has(id);
  if (had) openHolders(id).forEach(animateTrend);
  await loadTrend(id, !had);
}

$("#vtabs").addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>(".vtab")?.dataset.view;
  if (v === "watch" || v === "board") setView(v);
});

$("#bkind").addEventListener("click", (e) => {
  const kind = (e.target as HTMLElement).closest<HTMLElement>("[data-kind]")?.dataset.kind as
    | BoardKind
    | undefined;
  if (!kind || kind === boardKind) return;
  boardKind = kind;
  // 换了口径，上一类的榜单已经不适用：先清掉，别让它们留在屏上
  boards = [];
  boardsErr = false;
  // 展开中的板块不在新口径里了：收起（它的行马上会被重建掉）
  if (isBoardSecid(trendOpen ?? "")) trendOpen = null;
  renderBoards();
  void loadBoards();
});

$("#border").addEventListener("click", () => {
  boardOrder = boardOrder === "up" ? "down" : "up";
  renderBoards();
});

$("#bsubs").addEventListener("click", () => {
  boardSubs = !boardSubs;
  renderBoards();
  // 东财一次就把一二级全拿回来了，开关只是本地过滤；腾讯的二级是另一段接口，得重新拉
  if (boards.some((b) => boardSourceOf(b.secid) === "tencent")) void loadBoards();
});

$("#boards").addEventListener("click", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>(".row")?.dataset.id;
  if (id) void toggleBoardTrend(id);
});

// ---------- 入场动效 ----------

let staggerTimer: number | undefined;
function playStagger(): void {
  if (reduceMotion()) return;
  app.classList.remove("stagger");
  void app.offsetWidth;
  app.classList.add("stagger");
  window.clearTimeout(staggerTimer);
  staggerTimer = window.setTimeout(() => app.classList.remove("stagger"), 1200);
}

// ---------- 搜索 ----------

let searchTimer: number | undefined;
let searchSeq = 0;
const searchInput = $<HTMLInputElement>("#search-input");
const searchBox = $("#search-results");

function closeSearch(): void {
  searchBox.classList.remove("show");
  searchBox.innerHTML = "";
}

function renderSearch(items: SearchItem[]): void {
  searchItems = items;
  if (!items.length) {
    searchBox.innerHTML = `<div class="sr-empty">没有找到相关股票</div>`;
  } else {
    searchBox.innerHTML = items
      .map((it) => {
        const added = S.watchlist.includes(it.secid);
        return (
          `<div class="sr" data-id="${esc(it.secid)}" data-name="${esc(it.name)}">` +
          `<div class="sr-main"><div class="sr-name">${esc(it.name)}</div>` +
          `<div class="sr-meta"><span class="tag">${marketTag(it.secid)}</span>${esc(it.code)} · ${esc(it.type)}</div></div>` +
          `<button class="sr-add ${added ? "added" : ""}" ${added ? "disabled" : ""}>${added ? "已添加" : "＋"}</button>` +
          `</div>`
        );
      })
      .join("");
  }
  searchBox.classList.add("show");
}

/** 最近一次搜索结果：右键操作后重画（加入过的那一行立刻变成「已添加」） */
let searchItems: SearchItem[] = [];
/**
 * 搜索结果右键菜单的标记类名：菜单里的点击不该把搜索结果收起来（「点别处收起」的监听据此放行）。
 * 只有搜索菜单挂这个标 —— 别的菜单（自选行、分组标题）被点掉时，搜索结果照旧收起。
 */
const SEARCH_MENU = "ctx-search";


/** 右键操作后重画结果列表（还开着才重画） */
function refreshSearch(): void {
  if (searchBox.classList.contains("show")) renderSearch(searchItems);
}

/**
 * 搜索结果行的右键菜单：与设置窗口同一份判断（settings.ts 的 searchActions），
 * 「加入」类动作和点结果一样会把它设为当前选中；正在看某个分组时，纯「加入自选」也直接进这个分组。
 */
function openSearchMenu(id: string, x: number, y: number): void {
  openMenu(
    x,
    y,
    searchActions(S.groups, S.groupOf, S.watchlist, S.pins, id).map((a) => ({
      label: a.label,
      // 置顶 / 取消置顶 与自选行的右键菜单用同一对图标，两处认得出来是同一件事
      icon: a.kind === "pin" ? ICON_PIN_ON : a.kind === "unpin" ? ICON_PIN_OFF : undefined,
      onPick: () => {
        const added = !S.watchlist.includes(id);
        const next = applySearchAction({ watchlist: S.watchlist, pins: S.pins, groupOf: S.groupOf }, S.groups, id, a);
        S.watchlist = next.watchlist;
        S.pins = next.pins;
        S.groupOf = next.groupOf;
        if (added && a.kind === "add" && groupFilter) S.groupOf = setGroup(S.groupOf, id, groupFilter);
        if (added && (a.kind === "add" || a.kind === "addToGroup")) S.selected = id;
        save();
        renderFromSettings(); // 清单、筛选条、菜单栏一起跟上
        refreshSearch(); // 结果列表留着：刚加入的那一行当场变成「已添加」
      },
    })),
    { className: SEARCH_MENU },
  );
}

searchInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  const kw = searchInput.value.trim();
  // 板块视图：就地过滤当前口径那份榜单，不发请求、也不用等防抖
  //（搜索接口 suggest 不返回板块，见 boards.ts 的 searchBoards）
  if (view === "board") {
    boardQuery = kw;
    renderBoards();
    return;
  }
  if (!kw) return closeSearch();
  searchTimer = window.setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const items = await searchStocks(kw);
      if (seq === searchSeq) renderSearch(items);
    } catch {
      if (seq === searchSeq) {
        searchBox.innerHTML = `<div class="sr-empty">搜索失败，请稍后重试</div>`;
        searchBox.classList.add("show");
      }
    }
  }, 300);
});

searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    searchInput.value = "";
    closeSearch();
    // 板块那边还得把过滤撤掉，榜单才回到全量
    if (view === "board") {
      boardQuery = "";
      renderBoards();
    }
  }
});

searchBox.addEventListener("click", (e) => {
  const sr = (e.target as HTMLElement).closest<HTMLElement>(".sr");
  const id = sr?.dataset.id;
  if (!id) return;
  // 内置的大盘指数一直显示在面板上，不能再加一份进自选（与 MCP、右键菜单同一条规则）
  if (!isIndex(id) && !S.watchlist.includes(id)) {
    S.watchlist.push(id);
    // 正在看某个分组时，新加的标的直接进这个分组（「未分组」则不加归属）
    if (groupFilter) S.groupOf = setGroup(S.groupOf, id, groupFilter);
    save();
  }
  searchInput.value = "";
  closeSearch();
  select(id);
  refresh();
});

// 搜索结果行右键：加入自选 / 加入并移入分组 / 移入分组 / 置顶（与自选行右键同一套 ctxmenu）
searchBox.addEventListener("contextmenu", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>(".sr")?.dataset.id;
  if (!id) return;
  e.preventDefault();
  openSearchMenu(id, e.clientX, e.clientY);
});

// 点别处收起搜索；但右键菜单里的点击不算「点别处」——
// 连着做两步（加入、再置顶）时结果列表要留着，刚加入的那一行才好当场变成「已添加」
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest(".search") && !t.closest(`.${SEARCH_MENU}`)) closeSearch();
});

// ---------- 设置 / 底栏 ----------

function applyColorMode(): void {
  applyAppearance(S);
  renderTrendPanels();
}
applyColorMode();

$("#btn-settings").addEventListener("click", () => {
  if (IN_TAURI) void call("open_settings");
  else window.open("/settings.html", "stockbar-settings", "width=860,height=600");
});

const intervalSel = $<HTMLSelectElement>("#interval");
intervalSel.value = String(S.interval);
intervalSel.addEventListener("change", () => {
  S.interval = Number(intervalSel.value) || 5;
  save();
  schedule();
});

$("#btn-refresh").addEventListener("click", () => {
  const btn = $("#btn-refresh");
  btn.classList.remove("spin");
  void btn.offsetWidth; // 重新触发动画
  btn.classList.add("spin");
  refresh();
});

$("#btn-quit").addEventListener("click", () => call("quit_app"));

// ---------- 菜单栏标题 ----------

let traySig = "";
async function updateTray(): Promise<void> {
  if (!IN_TAURI) return;
  const up = getComputedStyle(document.documentElement).getPropertyValue("--up").trim() || "#e0282e";
  const down = getComputedStyle(document.documentElement).getPropertyValue("--down").trim() || "#1a9f50";
  const text = barText(S, quotes);
  // Windows 托盘是正方形小图标，放不下宽图：行情走 tooltip 与悬浮行情条
  const img = IS_WIN ? null : barImage(S, quotes, { up, down, darkBar: isDark(S) });
  // 内容没变就不重复推送
  const sig = `${S.barStyle}|${img ? img.canvas.toDataURL() : text}`;
  if (sig === traySig) return;
  traySig = sig;
  if (img) {
    const png = await canvasPng(img.canvas);
    await call("set_tray_image", { png, template: img.template, tooltip: text || "StockBar" });
  } else {
    await call("set_tray_text", { title: text });
  }
}

/** Windows：悬浮行情条的显示/隐藏由主面板统一控制（与托盘一样只有一个推送方） */
let tickerShown: boolean | null = null;
function syncTicker(): void {
  if (!IN_TAURI || !IS_WIN) return;
  const show = S.ticker && S.barStyle !== "icon" && S.bar.length > 0;
  if (show === tickerShown) return;
  tickerShown = show;
  const pos = loadTickerPos();
  void call("set_ticker", { show, x: pos?.x ?? null, y: pos?.y ?? null });
}

/**
 * Windows：托盘右键菜单里「桌面悬浮行情条」的勾选状态跟着设置走。
 * 设置存在 localStorage 里、Rust 读不到，所以由本窗口把状态推过去（菜单项只建在 Windows 上）。
 */
function syncTrayTicker(): void {
  if (!IN_TAURI || !IS_WIN) return;
  void call("set_tray_ticker", { on: S.ticker });
}

/**
 * 托盘右键菜单里的项（Rust 侧）：只有悬浮行情条这一项要前端执行 ——
 * 它改的是用户设置，而设置存在 localStorage 里，所以 Rust 只发事件，
 * 改完由本窗口调 set_tray_ticker 把勾选状态推回去（见 lib.rs 的 tray_menu）。
 */
void (async () => {
  await listenAll<string>("tray-menu", (action) => {
    if (action !== "ticker" || !IS_WIN) return;
    S.ticker = !S.ticker;
    save(); // 广播给设置窗口：那边「桌面悬浮行情条」的开关与预览一起跟上
    syncTicker();
    syncTrayTicker();
  });
  // 监听确实挂上之后再推一次勾选状态：万一在这之前点了菜单里的那一项，
  // 菜单翻了勾、设置却没改，这里把状态重新对齐（与 MCP 的 mcp_ready 一个道理）
  syncTrayTicker();
})();

// ---------- 数据刷新 ----------

function select(id: string): void {
  if (S.selected === id) return;
  S.selected = id;
  save();
  renderAll();
}

async function refresh(): Promise<void> {
  if (refreshing) return;
  refreshing = true;
  // 板块榜单只在板块视图打开时拉：不打开这个视图的用户，一次请求都不会多发
  if (view === "board") void loadBoards();
  // 北证50 不在用户的指数列表里，但全市场成交额要用它，所以单独补进来
  const ids = [
    ...new Set([
      ...INDICES.map((i) => i.secid),
      MARKET_INDEX.bj,
      S.selected,
      ...S.watchlist,
      ...S.bar,
    ]),
  ];
  try {
    const got = await fetchQuotes(ids, S.source);
    got.forEach((q, k) => quotes.set(k, q));
    lastOk = Date.now();
    failCount = 0;
    if (trendOpen) {
      void loadTrend(trendOpen, false);
      // 指数面板展开着：底部那两行也要跟着刷新
      if (isIndex(trendOpen)) void loadMarket();
    }
  } catch (e) {
    failCount++;
    errorMsg = apiErrorText(e);
  } finally {
    refreshing = false;
  }
  loaded = loaded || lastOk > 0;
  renderAll();
  updateTray();
}
function renderAll(): void {
  app.classList.toggle("is-loading", !loaded);
  renderHeader();
  renderIndices();
  renderView();
  renderTrendPanels();
}

matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  renderTrendPanels();
  void updateTray();
});

/** 把一份新设置接到本窗口（只改内存里的 S）：保留本窗口的选中项，被删掉的标的退回列表首项 */
function assignSettings(next: Settings): void {
  const keep = S.selected;
  S = {
    ...next,
    selected: next.watchlist.includes(keep) || isIndex(keep) ? keep : (next.watchlist[0] ?? INDICES[0].secid),
  };
  // 展开中的分时图标的没了就收起
  if (trendOpen && !S.watchlist.includes(trendOpen) && !isIndex(trendOpen)) trendOpen = null;
}

/** 按当前 S 重画：外观、列表、菜单栏、行情条（含托盘菜单里的勾选状态） */
function renderFromSettings(): void {
  applyColorMode();
  renderAll();
  void updateTray();
  syncTicker();
  syncTrayTicker();
  void refresh();
}

/** 外部（设置窗口或 MCP）改完设置后，让本窗口接到新状态上 */
function adoptSettings(next: Settings): void {
  assignSettings(next);
  renderFromSettings();
}

// 设置窗口改了设置 → 主面板与菜单栏立即同步
onSettingsChange((next) => {
  const intervalChanged = next.interval !== S.interval;
  adoptSettings(next);
  if (intervalChanged) {
    intervalSel.value = String(S.interval);
    schedule();
  }
});
window.addEventListener("resize", () => {
  if (trendOpen) renderTrendPanels();
  syncTabMore(); // 面板宽度变了，筛选条可能要重新决定给不给 ☰
});

function schedule(): void {
  window.clearInterval(timer);
  timer = window.setInterval(() => refresh(), S.interval * 1000);
}

/**
 * 每次从菜单栏弹出：重播入场动画、回到自选视图、立即刷新。
 * 视图与板块口径都不持久化（见 docs/adr/0001）：主面板的身份是盯自选，
 * 记住了「上次在看板块」会让「点图标看一眼自选」变成要先切一下。
 */
void listenAll("panel-shown", () => {
  app.classList.remove("enter");
  void app.offsetWidth;
  app.classList.add("enter");
  playStagger();
  view = "watch";
  boardKind = "industry";
  boardOrder = "up";
  boardSubs = false;
  renderView();
  refresh();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !searchInput.value) call("hide_window");
});

// ---------- MCP 本地桥 ----------
// 外部 MCP 客户端要改自选与分组时，Rust 侧把命令转成 mcp-request 事件送到这个窗口；
// 这里用与界面完全同一套逻辑改完 S，再保存（saveSettings 会顺带通知设置窗口），最后回信。
const MCP_DEPS = {
  search: (keyword: string) => searchStocks(keyword),
  quotes: (secids: string[]) => fetchQuotes(secids, S.source),
};

/** 一条来自本地桥的命令：请求带 id（回信要带上）与 deadline（Rust 侧的等待上限，毫秒时间戳） */
interface McpRequest {
  id: number;
  op: string;
  args?: Record<string, unknown>;
  deadline?: number;
}

async function runMcpCommand(req: McpRequest): Promise<void> {
  const reply = (payload: unknown) => void call("mcp_reply", { id: req.id, payload: JSON.stringify(payload) });
  try {
    // 先做准备（要联网、要搜索），再在「此刻最新」的 S 上执行：准备期间设置窗口可能改过设置，
    // 拿准备时的旧快照整份覆盖会把那些改动弄丢
    const prepared = await prepareCommand(S, req.op, req.args ?? {}, MCP_DEPS);
    if (req.deadline && Date.now() > req.deadline) {
      // 已经等太久了：Rust 侧多半已经回了超时，就别再改设置了，免得「报错但生效」
      reply({ ok: false, error: "命令处理超时（应用可能正忙），这次没有改动设置，请重试" });
      return;
    }
    const result = prepared.apply(S);
    if (result.changed) {
      // 先落盘再重画：重画万一出错，改动已经存下来了，回执也不该说失败
      assignSettings(result.settings);
      save();
      try {
        renderFromSettings();
      } catch (e) {
        console.warn("[mcp] 设置已保存，但重画失败：", e);
      }
    }
    reply({ ok: true, text: result.text, data: result.data });
  } catch (e) {
    reply({ ok: false, error: e instanceof McpError ? e.message : `执行失败：${String(e)}` });
  }
}

// 串行执行：一条命令可能要联网好几秒，两条同时跑会各自基于同一份旧设置算出新设置，后写的会把先写的盖掉
let mcpQueue: Promise<void> = Promise.resolve();
void (async () => {
  await listenAll<McpRequest>("mcp-request", (req) => {
    mcpQueue = mcpQueue.then(() => runMcpCommand(req));
  });
  // 监听确实挂上之后再告诉 Rust 侧可以接命令（异常情况下也不至于让请求石沉大海）
  await call("mcp_ready");
  // 桥的开关是用户设置（存在 localStorage 里，Rust 读不到），按当前设置开 / 关：
  // 关着的时候连端口都不监听，连接信息文件也会删掉
  await call("mcp_set_enabled", { on: S.mcp });
})();


// ---------- 版本更新 ----------
// 启动时静默查一次（设置里的「启动时自动检查更新」关掉就不查）；查到新版本才在顶栏下挂提示条。
// 点提示条打开设置窗口的「关于」页：下载、安装与进度都在那里（见 prefs.ts 与 src-tauri/src/update.rs）。

async function checkUpdateOnce(): Promise<void> {
  if (!S.updateCheck || !IN_TAURI) return;
  // 用 call 而不是 callOrThrow：这是背景检查，失败不该打扰用户，静默跳过就行
  const info = await call<UpdateInfo>("update_check");
  if (!info?.available) return;
  updateInfo = info;
  renderHeader();
}

$("#update-bar").addEventListener("click", () => {
  // 直接落到「关于」页：看到提示条就是想更新
  if (IN_TAURI) void call("open_settings", { page: "about" });
});
renderAll();
playStagger();
refresh();
schedule();
syncTicker();
// 启动时静默查一次更新：先把行情与菜单栏点亮，别和它们抢带宽，查到新版本再挂提示条
window.setTimeout(() => void checkUpdateOnce(), 4000);
