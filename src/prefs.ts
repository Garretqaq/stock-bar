import { codeOf, fetchQuotes, marketTag, type Quote } from "./api";
import { barImage, barPct, barPrice, barText, shortName, tickerClass, tickerHtml } from "./bar";
import {
  BAR_MAX,
  INDICES,
  applyAppearance,
  isDark,
  loadSettings,
  onSettingsChange,
  saveSettings,
  type BarField,
  type BarStyle,
  type Settings,
  type Theme,
} from "./settings";
import { IN_TAURI, IS_WIN, call } from "./tauri";
import appIcon from "./assets/app-icon.png";
// 与 Rust 托盘共用同一张图标（src-tauri/icons/tray.png），避免两份图不一致
import trayIcon from "../src-tauri/icons/tray.png";
import { openMenu } from "./ctxmenu";

// ---------- 状态 ----------

let S: Settings = loadSettings();
const quotes = new Map<string, Quote>();
type Page = "dashboard" | "market" | "settings";
const HASH = location.hash.replace("#", "");
let page: Page = HASH === "settings" || HASH === "market" ? HASH : "dashboard";
let pollTimer: number | undefined;

const $ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string, root: ParentNode = document) => [
  ...root.querySelectorAll<T>(sel),
];
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
type Dir = "up" | "down" | "flat";
const dirOf = (p: number | null | undefined): Dir => (p == null || p === 0 ? "flat" : p > 0 ? "up" : "down");
const cssVar = (n: string) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function commit(): void {
  saveSettings(S);
  render();
}

// ---------- 图标 ----------

const I = {
  logo: `<svg viewBox="0 0 24 24"><path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/></svg>`,
  market: `<svg viewBox="0 0 24 24"><path d="M5 20V10"/><path d="M12 20V4"/><path d="M19 20v-6"/></svg>`,
  dashboard: `<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>`,
  settings: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>`,
  sun: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  moon: `<svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>`,
  laptop: `<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/></svg>`,
  apple: `<svg viewBox="0 0 24 24" class="fill"><path d="M16.4 12.6c0-2.4 2-3.6 2.1-3.7-1.1-1.7-2.9-1.9-3.5-1.9-1.5-.2-2.9.9-3.7.9-.8 0-1.9-.9-3.2-.8-1.6 0-3.1 1-4 2.4-1.7 3-.4 7.4 1.2 9.8.8 1.2 1.8 2.5 3 2.4 1.2 0 1.7-.8 3.1-.8 1.5 0 1.9.8 3.2.8 1.3 0 2.1-1.2 2.9-2.4.9-1.4 1.3-2.7 1.3-2.8-.1 0-2.4-.9-2.4-3.9zM14 5.5c.7-.8 1.1-1.9 1-3-1 0-2.1.7-2.8 1.5-.6.7-1.2 1.8-1 2.9 1 .1 2.1-.6 2.8-1.4z"/></svg>`,
  wifi: `<svg viewBox="0 0 24 24"><path d="M2 8.5a15 15 0 0 1 20 0M5 12a10.5 10.5 0 0 1 14 0M8.5 15.5a5.5 5.5 0 0 1 7 0"/><circle cx="12" cy="19" r="1" class="fill"/></svg>`,
  battery: `<svg viewBox="0 0 28 24"><rect x="2" y="7" width="21" height="10" rx="3"/><rect x="4.5" y="9.5" width="13" height="5" rx="1.2" class="fill"/><path d="M25.5 10.5v3"/></svg>`,
  power: `<svg viewBox="0 0 24 24"><path d="M12 3v9M6.4 6.4a8 8 0 1 0 11.2 0"/></svg>`,
  win: `<svg viewBox="0 0 24 24" class="fill"><path d="M3 3h8.5v8.5H3zM12.5 3H21v8.5h-8.5zM3 12.5h8.5V21H3zM12.5 12.5H21V21h-8.5z"/></svg>`,
  search: `<svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/></svg>`,
};

// ---------- 骨架 ----------

/** 菜单栏（macOS）/ 悬浮行情条（Windows）的叫法 */
const BAR = IS_WIN ? "行情条" : "菜单栏";
const STYLES: { v: BarStyle; name: string; desc: string }[] = [
  { v: "text", name: "单行文字", desc: IS_WIN ? "行情条显示一行行情" : "图标 + 一行行情" },
  { v: "compact", name: "双行紧凑", desc: "名称在上、行情在下" },
  { v: "icon", name: "仅图标", desc: IS_WIN ? "不显示行情条，只留托盘图标" : "最省空间" },
];
const FIELDS: { v: BarField; name: string }[] = [
  { v: "name", name: "名称" },
  { v: "price", name: "价格" },
  { v: "pct", name: "涨跌幅" },
];
const THEMES: { v: Theme; name: string; icon: string }[] = [
  { v: "light", name: "浅色", icon: I.sun },
  { v: "dark", name: "深色", icon: I.moon },
  { v: "system", name: "跟随系统", icon: I.laptop },
];
const INTERVALS = [3, 5, 10, 30];

/** 实时预览：macOS 仿菜单栏；Windows 仿桌面 + 任务栏，悬浮行情条浮在任务栏右上方 */
const MAC_DESK = `
        <div class="desk" id="desk">
          <div class="menubar">
            <div class="mb-left">${I.apple}<b>StockBar</b><span>文件</span><span>编辑</span><span>显示</span></div>
            <div class="mb-right">
              <span class="mb-item" id="mb-item"></span>
              ${I.wifi}${I.battery}<span id="mb-clock"></span>
            </div>
          </div>
          <div class="desk-hint">实时预览</div>
        </div>`;
const WIN_DESK = `
        <div class="desk win-desk" id="desk">
          <div class="desk-hint" id="desk-hint">实时预览</div>
          <div class="tk" id="tk-preview"></div>
          <div class="taskbar">
            <div class="tb-apps"><span class="tb-start">${I.win}</span><span class="tb-search">${I.search}搜索</span><i></i><i></i><i></i></div>
            <div class="tb-tray"><span class="mb-logo" title="StockBar 托盘图标"></span>${I.wifi}<span class="tb-clock" id="mb-clock"></span></div>
          </div>
        </div>`;

const root = $("#prefs");
root.classList.toggle("in-tauri", IN_TAURI);
document.documentElement.style.setProperty("--tray-icon", `url("${trayIcon}")`);
root.innerHTML = `
  <aside class="side">
    ${
      IS_WIN
        ? "" // Windows 用原生标题栏：不需要仿红绿灯和自绘拖动区
        : `<div class="drag" data-tauri-drag-region></div>
    <div class="fake-lights" aria-hidden="true"><i></i><i></i><i></i></div>`
    }
    <div class="brand">
      <img class="brand-logo" src="${appIcon}" alt="" />
      <div class="brand-text"><b>StockBar</b><span>${IS_WIN ? "桌面盯盘" : "菜单栏盯盘"}</span></div>
    </div>
    <nav class="nav">
      <button class="nav-item" data-page="dashboard"><span class="nav-ico blue">${I.dashboard}</span>仪表盘</button>
      <button class="nav-item" data-page="market"><span class="nav-ico green">${I.market}</span>行情</button>
      <button class="nav-item" data-page="settings"><span class="nav-ico gray">${I.settings}</span>设置</button>
    </nav>
    <div class="side-foot">
      <button class="quit-btn" id="quit">${I.power}退出 StockBar</button>
    </div>
  </aside>

  <main class="content">
    ${IS_WIN ? "" : `<div class="drag" data-tauri-drag-region></div>`}

    <section class="page" data-page="dashboard">
      <header class="page-head">
        <h1>仪表盘</h1>
        <p>选择${BAR}的展示样式与显示字段，改动会实时生效。</p>
      </header>

      <div class="group">
        ${IS_WIN ? WIN_DESK : MAC_DESK}
        <div class="styles" id="styles">
          ${STYLES.map(
            (s) => `
            <button class="style-card" data-v="${s.v}">
              <div class="style-thumb">${
                IS_WIN
                  ? `<div class="thumb-tk"><span class="thumb-item" data-thumb="${s.v}"></span></div><div class="thumb-taskbar"><span class="mb-logo"></span></div>`
                  : `<div class="thumb-bar"><span class="thumb-item" data-thumb="${s.v}"></span></div>`
              }</div>
              <div class="style-name">${s.name}</div>
              <div class="style-desc">${s.desc}</div>
            </button>`,
          ).join("")}
        </div>
        <div class="row">
          <div class="row-label">显示字段<small>至少保留一项</small></div>
          <div class="chips" id="fields">
            ${FIELDS.map((f) => `<button class="chip" data-v="${f.v}"><span class="chip-check"></span>${f.name}</button>`).join("")}
          </div>
        </div>
        <div class="row" id="row-color">
          <div class="row-label">涨跌着色<small>${IS_WIN ? "悬浮行情条按涨跌显示红绿" : "双行紧凑样式下按涨跌显示红绿"}</small></div>
          <label class="switch"><input type="checkbox" id="bar-color" /><i></i></label>
        </div>
        ${
          IS_WIN
            ? `<div class="row" id="row-ticker">
          <div class="row-label">桌面悬浮行情条<small>Windows 托盘无法显示文字，用置顶小条代替；可拖动，单击打开面板</small></div>
          <label class="switch"><input type="checkbox" id="ticker" /><i></i></label>
        </div>`
            : ""
        }
      </div>
    </section>

    <section class="page" data-page="market">
      <header class="page-head">
        <h1>行情</h1>
        <p>${BAR}上要显示的标的；右键某一行可从${BAR}移除。</p>
      </header>

      <h2 class="group-title">${BAR}显示 <span class="count" id="bar-count"></span><span class="title-hint">大盘与自选共用名额，按开启顺序排列</span></h2>
      <div class="group stocks" id="stocks">
        <div class="stock-sec"><div class="sec-head">大盘指数</div><div class="sec-body" id="stocks-idx"></div></div>
        <div class="stock-sec"><div class="sec-head">自选股票</div><div class="sec-body" id="stocks-watch"></div></div>
      </div>
    </section>

    <section class="page" data-page="settings">
      <header class="page-head">
        <h1>设置</h1>
        <p>外观主题、涨跌配色与行情刷新。</p>
      </header>

      <h2 class="group-title">主题</h2>
      <div class="group">
        <div class="themes" id="themes">
          ${THEMES.map(
            (t) => `
            <button class="theme-card" data-v="${t.v}">
              <div class="theme-thumb ${t.v}">
                <div class="tw"><div class="tw-bar"><i></i><i></i><i></i></div><div class="tw-body"><span></span><span></span><span></span></div></div>
              </div>
              <div class="theme-name">${t.icon}${t.name}</div>
            </button>`,
          ).join("")}
        </div>
      </div>

      <h2 class="group-title">涨跌配色</h2>
      <div class="group">
        <div class="row">
          <div class="row-label">配色方案<small>同时作用于面板、分时图与${BAR}</small></div>
          <div class="seg" id="seg-color" style="--n:2">
            <button data-v="red"><span class="dots"><i class="r"></i><i class="g"></i></span>红涨绿跌</button>
            <button data-v="green"><span class="dots"><i class="g"></i><i class="r"></i></span>绿涨红跌</button>
          </div>
        </div>
        <div class="row">
          <div class="row-label">预览</div>
          <div class="color-demo">
            <span class="demo-item"><b class="up">3800.86</b><em class="pill up">+1.23%</em></span>
            <span class="demo-item"><b class="down">2958.34</b><em class="pill down">-0.86%</em></span>
          </div>
        </div>
      </div>

      <h2 class="group-title">行情</h2>
      <div class="group">
        <div class="row">
          <div class="row-label">刷新间隔</div>
          <div class="seg" id="seg-interval" style="--n:${INTERVALS.length}">
            ${INTERVALS.map((n) => `<button data-v="${n}">${n} 秒</button>`).join("")}
          </div>
        </div>
        <div class="row">
          <div class="row-label">数据来源</div>
          <span class="row-value">东方财富</span>
        </div>
      </div>
    </section>
  </main>
`;

// ---------- 渲染 ----------

function render(): void {
  applyAppearance(S);
  syncTitleBar();
  $$(".nav-item").forEach((b) => b.classList.toggle("on", b.dataset.page === page));
  $$(".page").forEach((p) => p.classList.toggle("on", p.dataset.page === page));

  // 仪表盘
  $$(".style-card").forEach((b) => b.classList.toggle("on", b.dataset.v === S.barStyle));
  $$("#fields .chip").forEach((b) => b.classList.toggle("on", S.barFields.includes(b.dataset.v as BarField)));
  $<HTMLInputElement>("#bar-color").checked = S.barColor;
  // Windows 悬浮条里单行文字也能着色；macOS 托盘文字不能着色
  $("#row-color").classList.toggle("dim", IS_WIN ? S.barStyle === "icon" : S.barStyle !== "compact");
  if (IS_WIN) {
    $<HTMLInputElement>("#ticker").checked = S.ticker;
    $("#row-ticker").classList.toggle("dim", S.barStyle === "icon");
  }
  $("#fields").closest(".row")!.classList.toggle("dim", S.barStyle === "icon");
  renderStocks();
  renderPreview();

  // 设置
  $$(".theme-card").forEach((b) => b.classList.toggle("on", b.dataset.v === S.theme));
  setSeg("#seg-color", S.greenUp ? "green" : "red");
  setSeg("#seg-interval", String(S.interval));
}

function setSeg(sel: string, v: string): void {
  const seg = $(sel);
  const btns = $$("button", seg);
  const i = Math.max(0, btns.findIndex((b) => b.dataset.v === v));
  seg.style.setProperty("--i", String(i));
  btns.forEach((b, j) => b.classList.toggle("on", j === i));
}

function stockRow(id: string, idx: boolean): string {
  return `
    <div class="stock${idx ? " is-index" : ""}" data-id="${esc(id)}">
      <span class="stock-order"></span>
      <div class="stock-main"><b class="stock-name"></b><small><span class="tag">${idx ? "指数" : marketTag(id)}</span>${esc(codeOf(id))}</small></div>
      <div class="stock-price"></div>
      <div class="pill stock-pct"></div>
      <label class="switch"><input type="checkbox" data-id="${esc(id)}" /><i></i></label>
    </div>`;
}

let stocksKey = "";
function renderStocks(): void {
  const box = $("#stocks");
  $("#bar-count").textContent = `${S.bar.length} / ${BAR_MAX}`;
  const idxBox = $("#stocks-idx");
  if (!idxBox.childElementCount) idxBox.innerHTML = INDICES.map((it) => stockRow(it.secid, true)).join("");
  const key = S.watchlist.join(",");
  if (key !== stocksKey) {
    stocksKey = key;
    $("#stocks-watch").innerHTML = S.watchlist.length
      ? S.watchlist.map((id) => stockRow(id, false)).join("")
      : `<div class="stocks-empty">自选列表为空，先在面板中搜索并添加股票</div>`;
  }
  const full = S.bar.length >= BAR_MAX;
  $$(".stock", box).forEach((row) => {
    const id = row.dataset.id!;
    const q = quotes.get(id);
    const at = S.bar.indexOf(id);
    const on = at >= 0;
    row.classList.toggle("on", on);
    row.classList.toggle("locked", !on && full);
    $(".stock-order", row).textContent = on ? String(at + 1) : "";
    $(".stock-name", row).textContent = q?.name ?? INDICES.find((it) => it.secid === id)?.name ?? codeOf(id);
    $(".stock-price", row).textContent = barPrice(q?.price);
    const pct = $(".stock-pct", row);
    pct.textContent = barPct(q, false);
    pct.className = `pill stock-pct ${dirOf(q?.pct)}`;
    const input = $<HTMLInputElement>("input", row);
    input.checked = on;
    input.disabled = !on && full;
    row.title = !on && full ? `最多显示 ${BAR_MAX} 只，先移除一只` : `右键：${on ? `从${BAR}移除` : `显示在${BAR}`}`;
  });
}

function renderPreview(): void {
  const dark = isDark(S);
  $("#desk").classList.toggle("dark", dark);
  if (IS_WIN) return renderWinPreview();
  const item = $("#mb-item");
  const up = cssVar("--up") || "#e0282e";
  const down = cssVar("--down") || "#1a9f50";
  item.className = `mb-item ${S.barStyle}`;
  if (S.barStyle === "compact" && S.bar.length) {
    const img = barImage(S, quotes, { up, down, darkBar: dark });
    item.innerHTML = img
      ? `<img src="${img.canvas.toDataURL()}" class="${img.template ? "template" : ""}" alt="" />`
      : "";
  } else {
    const text = barText(S, quotes);
    item.innerHTML = `<span class="mb-logo"></span>${text ? `<span class="mb-text">${esc(text)}</span>` : ""}`;
  }
  // 样式卡片缩略图：用菜单栏（不足则用自选）里的前两只股票真实行情示意
  const ids = [...new Set([...S.bar, ...S.watchlist])].slice(0, 2);
  const sample = (id: string | undefined) => {
    const q = id ? quotes.get(id) : undefined;
    return {
      name: esc(shortName(q?.name ?? (id ? codeOf(id) : "--"))),
      price: barPrice(q?.price),
      pct: barPct(q),
      d: dirOf(q?.pct),
    };
  };
  const [a0, a1] = ids.map(sample);
  $('[data-thumb="text"]').innerHTML = a0
    ? `<span class="mb-logo"></span>${a0.name} ${a0.price} ${a0.pct}`
    : `<span class="mb-logo"></span>`;
  $('[data-thumb="compact"]').innerHTML = [a0, a1]
    .filter(Boolean)
    .map((x) => `<span class="two"><b>${x!.name}</b><em class="${x!.d}">${x!.price} ${x!.pct}</em></span>`)
    .join("");
  $('[data-thumb="icon"]').innerHTML = `<span class="mb-logo"></span>`;
}

function tickClock(): void {
  const d = new Date();
  const hm = d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (IS_WIN) {
    // Windows 任务栏：时间在上、日期在下
    $("#mb-clock").innerHTML = `<span>${hm}</span><span>${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}</span>`;
    return;
  }
  const wd = "日一二三四五六"[d.getDay()];
  $("#mb-clock").textContent = `周${wd} ${hm}`;
}

/** Windows：悬浮行情条 + 任务栏预览（行情条内容与真实窗口共用 tickerHtml） */
function renderWinPreview(): void {
  const show = S.ticker && S.barStyle !== "icon" && S.bar.length > 0;
  const tk = $("#tk-preview");
  tk.hidden = !show;
  tk.className = `tk ${tickerClass(S)}`;
  tk.innerHTML = show ? tickerHtml(S, quotes) : "";
  $("#desk-hint").textContent = show ? "实时预览" : S.barStyle === "icon" ? "仅托盘图标" : "行情条已关闭";
  // 样式卡片缩略图
  const id = S.bar[0] ?? S.watchlist[0];
  const q = id ? quotes.get(id) : undefined;
  const name = esc(shortName(q?.name ?? (id ? codeOf(id) : "--")));
  const d = dirOf(q?.pct);
  $('[data-thumb="text"]').innerHTML = `<b>${name}</b> <em class="${d}">${barPrice(q?.price)} ${barPct(q)}</em>`;
  $('[data-thumb="compact"]').innerHTML = `<span class="two"><b>${name}</b><em class="${d}">${barPrice(q?.price)} ${barPct(q)}</em></span>`;
  $('[data-thumb="icon"]').innerHTML = "";
}

/** Windows 原生标题栏跟随应用内主题（否则选了深色、系统是浅色时标题栏还是白的） */
let titleTheme: string | undefined;
function syncTitleBar(): void {
  if (!IS_WIN || !IN_TAURI) return;
  const t = S.theme;
  if (t === titleTheme) return;
  titleTheme = t;
  void import("@tauri-apps/api/window").then(({ getCurrentWindow }) =>
    getCurrentWindow()
      .setTheme(t === "system" ? null : t)
      .catch(() => {}),
  );
}

// ---------- 交互 ----------

function go(p: Page): void {
  if (page === p) return;
  page = p;
  history.replaceState(null, "", `#${p}`);
  render();
}

$(".nav").addEventListener("click", (e) => {
  const p = (e.target as HTMLElement).closest<HTMLElement>(".nav-item")?.dataset.page as Page | undefined;
  if (p) go(p);
});

$("#styles").addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>(".style-card")?.dataset.v as BarStyle | undefined;
  if (!v || v === S.barStyle) return;
  S.barStyle = v;
  commit();
});

$("#fields").addEventListener("click", (e) => {
  const chip = (e.target as HTMLElement).closest<HTMLElement>(".chip");
  const v = chip?.dataset.v as BarField | undefined;
  if (!chip || !v) return;
  if (S.barFields.includes(v)) {
    if (S.barFields.length === 1) return shake(chip);
    S.barFields = S.barFields.filter((f) => f !== v);
  } else {
    // 保持 名称 → 价格 → 涨跌幅 的固定顺序
    S.barFields = FIELDS.map((f) => f.v).filter((f) => f === v || S.barFields.includes(f));
  }
  commit();
});

$("#bar-color").addEventListener("change", (e) => {
  S.barColor = (e.target as HTMLInputElement).checked;
  commit();
});

if (IS_WIN) {
  $("#ticker").addEventListener("change", (e) => {
    S.ticker = (e.target as HTMLInputElement).checked;
    commit();
  });
}

$("#stocks").addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const id = input.dataset.id;
  if (!id) return;
  if (input.checked) {
    if (S.bar.length >= BAR_MAX) {
      input.checked = false;
      return shake(input.closest(".stock")!);
    }
    S.bar = [...S.bar, id];
  } else {
    S.bar = S.bar.filter((x) => x !== id);
  }
  commit();
});
$("#stocks").addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".stock.locked");
  if (row && !(e.target as HTMLElement).closest(".switch")) shake(row);
});

// 右键：快捷加入 / 移出菜单栏（比开关更直接）
$("#stocks").addEventListener("contextmenu", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".stock");
  const id = row?.dataset.id;
  if (!row || !id) return;
  e.preventDefault();
  const on = S.bar.includes(id);
  const full = S.bar.length >= BAR_MAX;
  openMenu(e.clientX, e.clientY, [
    on
      ? {
          label: `从${BAR}移除`,
          danger: true,
          onPick: () => {
            S.bar = S.bar.filter((x) => x !== id);
            commit();
          },
        }
      : {
          label: full ? `${BAR}已满（最多 ${BAR_MAX} 只）` : `显示在${BAR}`,
          disabled: full,
          onPick: () => {
            S.bar = [...S.bar, id];
            commit();
          },
        },
  ]);
});

$("#themes").addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>(".theme-card")?.dataset.v as Theme | undefined;
  if (!v || v === S.theme) return;
  S.theme = v;
  commit();
});

$("#seg-color").addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.v;
  if (!v) return;
  S.greenUp = v === "green";
  commit();
});

$("#seg-interval").addEventListener("click", (e) => {
  const v = Number((e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.v);
  if (!v || v === S.interval) return;
  S.interval = v;
  commit();
  schedulePoll();
});

$("#quit").addEventListener("click", () => call("quit_app"));

function shake(el: Element): void {
  el.classList.remove("shake");
  void (el as HTMLElement).offsetWidth;
  el.classList.add("shake");
}

// ---------- 行情 ----------

async function poll(): Promise<void> {
  try {
    const got = await fetchQuotes([...INDICES.map((it) => it.secid), ...S.watchlist]);
    got.forEach((q, k) => quotes.set(k, q));
    renderStocks();
    renderPreview();
  } catch {
    /* 预览数据失败不影响设置 */
  }
}

function schedulePoll(): void {
  window.clearInterval(pollTimer);
  pollTimer = window.setInterval(poll, S.interval * 1000);
}

onSettingsChange((next) => {
  const intervalChanged = next.interval !== S.interval;
  const listChanged = next.watchlist.join() !== S.watchlist.join();
  S = next;
  render();
  if (intervalChanged) schedulePoll();
  if (listChanged) void poll();
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => renderPreview());

render();
tickClock();
window.setInterval(tickClock, 15_000);
void poll();
schedulePoll();
