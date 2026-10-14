import {
  apiErrorText,
  getActiveSource,
  codeOf,
  fetchMarketAmount,
  fetchQuotes,
  fetchTrend,
  MARKET_INDEX,
  marketTag,
  regionOf,
  searchStocks,
  sessionStatus,
  type MarketAmount,
  type Quote,
  type SearchItem,
  type TrendData,
} from "./api";
import { barImage, barText, canvasPng } from "./bar";
import {
  INDICES,
  UNGROUPED,
  applyAppearance,
  dropGroupOf,
  groupIdOf,
  groupNameOf,
  groupTargets,
  isDark,
  isIndex,
  itemsOf,
  loadSettings,
  loadTickerPos,
  onSettingsChange,
  saveSettings,
  setGroup,
  type Settings,
} from "./settings";
import { IN_TAURI, IS_WIN, UI_FONT, call, listenAll } from "./tauri";
import { openMenu, type MenuItem } from "./ctxmenu";
import { McpError, prepareCommand } from "./mcp";

let S: Settings = loadSettings();
const save = () => saveSettings(S);

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
  return quotes.get(secid)?.name ?? codeOf(secid);
}

type Dir = "up" | "down" | "flat";
function dirOf(p: number | null | undefined): Dir {
  if (p == null || p === 0) return "flat";
  return p > 0 ? "up" : "down";
}

// ---------- 页面骨架 ----------

const app = $("#app");
app.innerHTML = `
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

  <main class="body" id="body">
    <section class="indices" id="indices"></section>
    <div class="trend trend-index" id="trend-index"><div class="trend-card"><div class="trend-head"><span class="trend-title"></span><span class="trend-meta"></span></div><canvas></canvas><div class="trend-foot"></div></div></div>

    <div class="search">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="search-input" placeholder="搜索代码 / 名称 / 拼音" autocomplete="off" spellcheck="false" />
      <div class="search-results" id="search-results"></div>
    </div>
    <div class="gtabs" id="gtabs" hidden></div>
    <section class="list" id="list"></section>
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
  document.querySelectorAll<HTMLElement>(".idx, #list .row").forEach((el) => {
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
    // 大盘指数多取一天：用来算「与上一日同期」的成交额对比
    const data = await fetchTrend(id, isIndex(id) ? 2 : 1, S.source);
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
  const panels = [idxPanel, ...document.querySelectorAll<HTMLElement>("#list .trend")];
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
  // 指数的"均价"字段不是真实均价，只给个股画均价线；纵轴范围同时容纳均价
  const showAvg = !INDICES.some((it) => it.secid === id);
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

// ---------- 自选分组 ----------
// 分组只决定自选列表怎么看：菜单栏（bar）与置顶（pins）都不受它影响。

/** 正在看的分组：null = 全部；未分组是空字符串，不能用假值判断 */
let groupFilter: string | null = null;

/** 当前视图里的自选（顺序仍与整表一致） */
function visibleIds(): string[] {
  return groupFilter === null ? S.watchlist : itemsOf(S.watchlist, S.groupOf, S.groups, groupFilter);
}

/**
 * 筛选条上的分组：没建过分组时整条不出现。
 * 成员数为 0 的分组也留着 —— 刚建好的空分组不该立刻消失。
 */
function groupTabs(): { gid: string | null; name: string; n: number }[] {
  const un = itemsOf(S.watchlist, S.groupOf, S.groups, UNGROUPED).length;
  return [
    { gid: null, name: "全部", n: S.watchlist.length },
    ...(un ? [{ gid: UNGROUPED as string | null, name: "未分组", n: un }] : []),
    ...S.groups.map((g) => ({
      gid: g.id as string | null,
      name: g.name,
      n: itemsOf(S.watchlist, S.groupOf, S.groups, g.id).length,
    })),
  ];
}

/** 筛选条内容没变就不重写 DOM，免得每次刷新都清掉滚动位置 */
function renderTabs(): void {
  const box = $("#gtabs");
  const tabs = groupTabs();
  // 正在看的分组已经不在筛选条上了（成员被移空、分组被删）：退回「全部」，
  // 否则会出现没有任何标签高亮、列表却还筛着的状态
  if (groupFilter !== null && !tabs.some((t) => t.gid === groupFilter)) groupFilter = null;
  const show = S.groups.length > 0;
  box.hidden = !show;
  if (!show) {
    box.dataset.key = "";
    if (box.innerHTML) box.innerHTML = "";
    return;
  }
  const key = `${groupFilter ?? "*"}|${tabs.map((t) => `${t.gid}:${t.name}:${t.n}`).join(",")}`;
  if (key === box.dataset.key) return;
  box.dataset.key = key;
  box.innerHTML = tabs
    .map((t) => {
      const on = t.gid === groupFilter;
      return (
        `<button class="gtab${on ? " on" : ""}" data-gid="${t.gid ?? "*"}" aria-pressed="${on}">` +
        `${esc(t.name)}<b>${t.n}</b></button>`
      );
    })
    .join("");
}

$("#gtabs").addEventListener("click", (e) => {
  const gid = (e.target as HTMLElement).closest<HTMLElement>(".gtab")?.dataset.gid;
  if (gid === undefined) return;
  const next = gid === "*" ? null : gid;
  if (next === groupFilter) return;
  groupFilter = next;
  renderList();
});

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
  const gids = ids.map((id) => groupIdOf(S.groupOf, S.groups, id));
  const key =
    `${groupFilter ?? "*"}|${ids.join(",")}|${S.bar.join(",")}|` +
    gids.map((g) => groupNameOf(S.groups, g)).join(",");
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = ids
      .map((id, i) => {
        const gid = gids[i];
        // 只在「全部」里标出分组：筛选到某个分组时这个标签是多余的
        const gtag =
          gid && groupFilter === null
            ? `<span class="tag gtag">${esc(groupNameOf(S.groups, gid))}</span>`
            : "";
        return (
          `<div class="row" data-id="${esc(id)}" style="--i:${i + INDICES.length}">` +
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

$("#list").addEventListener("click", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>(".row")?.dataset.id;
  if (id) toggleTrend(id);
});

// 右键菜单：删除自选，或把已置顶的标的移出菜单栏
$("#list").addEventListener("contextmenu", (e) => {
  e.preventDefault(); // 面板里不弹系统右键菜单
  const id = (e.target as HTMLElement).closest<HTMLElement>(".row")?.dataset.id;
  if (!id) return;
  openMenu(e.clientX, e.clientY, [
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

searchInput.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  const kw = searchInput.value.trim();
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
  }
});

searchBox.addEventListener("click", (e) => {
  const sr = (e.target as HTMLElement).closest<HTMLElement>(".sr");
  const id = sr?.dataset.id;
  if (!id) return;
  if (!S.watchlist.includes(id)) {
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

document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest(".search")) closeSearch();
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
  renderList();
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

/** 按当前 S 重画：外观、列表、菜单栏、行情条 */
function renderFromSettings(): void {
  applyColorMode();
  renderAll();
  void updateTray();
  syncTicker();
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
});

function schedule(): void {
  window.clearInterval(timer);
  timer = window.setInterval(() => refresh(), S.interval * 1000);
}

// 每次从菜单栏弹出：重播入场动画并立即刷新
void listenAll("panel-shown", () => {
  app.classList.remove("enter");
  void app.offsetWidth;
  app.classList.add("enter");
  playStagger();
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

renderAll();
playStagger();
refresh();
schedule();
syncTicker();
