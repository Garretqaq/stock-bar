import {
  codeOf,
  fetchQuotes,
  fetchTrend,
  marketTag,
  regionOf,
  searchStocks,
  sessionStatus,
  type Quote,
  type SearchItem,
  type TrendData,
} from "./api";
import { barImage, barText, canvasPng } from "./bar";
import {
  INDICES,
  applyAppearance,
  isDark,
  loadSettings,
  loadTickerPos,
  onSettingsChange,
  saveSettings,
  type Settings,
} from "./settings";
import { IN_TAURI, IS_WIN, UI_FONT, call, listenAll } from "./tauri";
import { openMenu } from "./ctxmenu";

let S: Settings = loadSettings();
const save = () => saveSettings(S);

// ---------- 运行时状态 ----------

const quotes = new Map<string, Quote>();
let lastOk = 0;
let failCount = 0;
let loaded = false;
let timer: number | undefined;
// ---------- 分时图展开 ----------
/** 当前展开分时图的 secid，null 表示收起 */
let trendOpen: string | null = null;
const trendCache = new Map<string, TrendData>();
let trendSeq = 0;
let refreshing = false;

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
    <div class="trend trend-index" id="trend-index"><div class="trend-card"><div class="trend-head"><span class="trend-title"></span><span class="trend-meta"></span></div><canvas></canvas></div></div>

    <div class="search">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <input id="search-input" placeholder="搜索代码 / 名称 / 拼音" autocomplete="off" spellcheck="false" />
      <div class="search-results" id="search-results"></div>
    </div>
    <section class="list" id="list"></section>
  </main>

  <footer class="bottom">
    <select id="interval" title="刷新间隔">
      <option value="3">3 秒</option><option value="5">5 秒</option>
      <option value="10">10 秒</option><option value="30">30 秒</option>
    </select>
    <span class="src">数据来源：东方财富</span>
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
  await loadTrend(id, !had);
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
    const data = await fetchTrend(id);
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

  $("#error-bar").classList.toggle("show", failCount > 0);
}

// ---------- 自选列表 ----------

const prevPrice = new Map<string, number>();

const ICON_PIN = `<svg viewBox="0 0 24 24"><path d="M12 17v5M9 3h6l-1 7 4 3v2H6v-2l4-3z"/></svg>`;

/** 结构（自选 / 置顶）变化才重建 DOM；行情刷新只原地改文字，动效与展开状态不被打断 */
function renderList(): void {
  const box = $("#list");
  if (!S.watchlist.length) {
    box.dataset.key = "";
    box.innerHTML =
      `<div class="empty list-empty"><svg viewBox="0 0 24 24"><path d="M3 17l6-6 4 4 8-8M15 7h6v6"/></svg>` +
      `<div>搜索并添加你的第一只股票</div></div>`;
    return;
  }
  const key = `${S.watchlist.join(",")}|${S.bar.join(",")}`;
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.innerHTML = S.watchlist
      .map(
        (id, i) =>
          `<div class="row" data-id="${esc(id)}" style="--i:${i + INDICES.length}">` +
          `<div class="row-main"><div class="row-name"></div>` +
          `<div class="row-meta"><span class="tag">${marketTag(id)}</span>${esc(codeOf(id))}` +
          `${S.bar.includes(id) ? `<span class="pin-mark" title="已显示在菜单栏（在设置 › 行情中调整）">${ICON_PIN}</span>` : ""}</div></div>` +
          `<div class="row-price"></div>` +
          `<div class="pill flat">--</div>` +
          `</div>` +
          `<div class="trend${trendOpen === id ? " show" : ""}" data-id="${esc(id)}">${trendInner()}</div>`,
      )
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
  S.bar = S.bar.filter((x) => x !== id);
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
  const ids = [...new Set([...INDICES.map((i) => i.secid), S.selected, ...S.watchlist, ...S.bar])];
  try {
    const got = await fetchQuotes(ids);
    got.forEach((q, k) => quotes.set(k, q));
    lastOk = Date.now();
    failCount = 0;
    if (trendOpen) void loadTrend(trendOpen, false);
  } catch {
    failCount++;
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

// 设置窗口改了设置 → 主面板与菜单栏立即同步
onSettingsChange((next) => {
  const intervalChanged = next.interval !== S.interval;
  // 保留本窗口的选中项，避免被对方覆盖
  S = { ...next, selected: S.selected };
  applyColorMode();
  renderAll();
  void updateTray();
  if (intervalChanged) {
    intervalSel.value = String(S.interval);
    schedule();
  }
  syncTicker();
  void refresh();
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

renderAll();
playStagger();
refresh();
schedule();
syncTicker();
