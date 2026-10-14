import {
  codeOf,
  fetchQuotes,
  getActiveSource,
  marketTag,
  searchStocks,
  type DataSource,
  type Quote,
  type SearchItem,
} from "./api";
import { barImage, barPct, barPrice, barText, shortName, tickerClass, tickerHtml } from "./bar";
import { shiftIndex, slotAt, type RowRect } from "./drag";
import {
  BAR_MAX,
  INDICES,
  addToBar,
  applyAppearance,
  clampBlock,
  isDark,
  loadSettings,
  moveItem,
  onSettingsChange,
  pinCount,
  pinItem,
  saveSettings,
  unpinItem,
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

// ---------- 行情页：多选（临时状态，不写入设置） ----------
const picked = new Set<string>();
/** Shift 区间选择的锚点（页面顺序里的行号，-1 表示没有锚点） */
let lastPick = -1;

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
  market: `<svg viewBox="0 0 24 24"><path d="M8 2.5v3M8 19.5v2"/><rect x="5" y="6" width="6" height="13" rx="1.5"/><path d="M16 2.5v5M16 17.5v4"/><rect x="13" y="8" width="6" height="9" rx="1.5"/></svg>`,
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
  grip: `<svg class="fill" viewBox="0 0 24 24"><circle cx="9" cy="5" r="1.5"/><circle cx="15" cy="5" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="19" r="1.5"/><circle cx="15" cy="19" r="1.5"/></svg>`,
  pin: `<svg viewBox="0 0 24 24"><path d="M12 17v5M9 3h6l-1 7 4 3v2H6v-2l4-3z"/></svg>`,
  top: `<svg viewBox="0 0 24 24"><path d="M4.5 4.5h15M12 20V9M7.5 13L12 8.5l4.5 4.5"/></svg>`,
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

/** 行情数据源选项（顺序即界面顺序） */
const SOURCES: { v: DataSource; name: string }[] = [
  { v: "auto", name: "自动" },
  { v: "eastmoney", name: "东方财富" },
  { v: "tencent", name: "腾讯" },
];

/** 「当前使用」那行显示的来源名字 */
const SOURCE_NAME: Record<string, string> = {
  eastmoney: "东方财富",
  tencent: "腾讯",
};

/** 自动模式下实际在用的源，由 poll() 里 fetchQuotes/getActiveSource 回填 */
let activeSource: string | null = null;

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
        <p>选择${BAR}的展示样式与显示字段，并拖动调整标的顺序，改动会实时生效。</p>
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
      <h2 class="group-title">${BAR}显示 <span class="count" id="ord-count"></span><span class="title-hint">顺序即${BAR}上的显示顺序</span></h2>
      <div class="group ordgroup">
        <div class="ordlist" id="ord-list"></div>
      </div>
    </section>

    <section class="page" data-page="market">
      <header class="page-head">
        <h1>行情</h1>
        <p>管理${BAR}上要显示的标的：勾选可批量操作，拖动自选左侧把手可调整顺序，行尾按钮可置顶，右键某一行可加入${BAR}或删除自选。</p>
      </header>

      <h2 class="group-title">${BAR}显示 <span class="count" id="bar-count"></span><span class="title-hint">大盘与自选共用名额，${BAR}顺序在仪表盘调整</span></h2>
      <div class="mhint" id="mhint" role="status" aria-live="polite"></div>
      <div class="group stocks" id="stocks">
        <div class="stock-sec">
          <div class="sec-head">大盘指数</div>
          <div class="sec-cards" id="stocks-idx"></div>
        </div>
        <div class="stock-sec">
          <div class="sec-head">自选股票 <span class="sec-count" id="watch-count"></span><span class="title-hint" id="drag-hint" hidden>拖动左侧把手调整顺序</span></div>
          <div class="add-box">
            <div class="add-search">
              ${I.search}
              <input id="add-input" placeholder="搜索代码 / 名称 / 拼音，添加自选" autocomplete="off" spellcheck="false" />
            </div>
            <div class="add-results" id="add-results"></div>
          </div>
          <div class="sec-body" id="stocks-watch"></div>
        </div>
      </div>

      <div class="selbar" id="selbar">
        <span class="selbar-count">已选 <b id="sel-count">0</b> 项</span>
        <div class="selbar-acts">
          <button class="sel-act" data-act="add">加入${BAR}</button>
          <button class="sel-act" data-act="remove">移出${BAR}</button>
          <button class="sel-act danger" data-act="delete">删除自选</button>
          <button class="sel-act ghost" data-act="clear">取消选择</button>
        </div>
      </div>
    </section>

    <section class="page" data-page="settings">
      <header class="page-head">
        <h1>设置</h1>
        <p>外观主题、涨跌配色与数据刷新。</p>
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

      <h2 class="group-title">数据</h2>
      <div class="group">
        <div class="row">
          <div class="row-label">刷新间隔</div>
          <div class="seg" id="seg-interval" style="--n:${INTERVALS.length}">
            ${INTERVALS.map((n) => `<button data-v="${n}">${n} 秒</button>`).join("")}
          </div>
        </div>
        <div class="row">
          <div class="row-label">数据来源<small>源站故障时自动切换</small></div>
          <div class="seg" id="seg-source" style="--n:${SOURCES.length}">
            ${SOURCES.map((o) => `<button data-v="${o.v}">${o.name}</button>`).join("")}
          </div>
        </div>
        <div class="row" id="row-source-active">
          <div class="row-label">当前使用</div>
          <span class="row-value" id="source-active">--</span>
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
  renderMarket();
  renderOrder();
  renderPreview();

  // 设置
  $$(".theme-card").forEach((b) => b.classList.toggle("on", b.dataset.v === S.theme));
  setSeg("#seg-color", S.greenUp ? "green" : "red");
  setSeg("#seg-interval", String(S.interval));
  setSeg("#seg-source", S.source);
  $<HTMLElement>("#source-active").textContent = activeFor(S);
}

function setSeg(sel: string, v: string): void {
  const seg = $(sel);
  const btns = $$("button", seg);
  const i = Math.max(0, btns.findIndex((b) => b.dataset.v === v));
  seg.style.setProperty("--i", String(i));
  btns.forEach((b, j) => b.classList.toggle("on", j === i));
}

/** 「当前使用」的文案：手动选源就直接显示，自动模式显示实际命中的那家 */
function activeFor(s: Settings): string {
  if (s.source !== "auto") return SOURCE_NAME[s.source] ?? "--";
  return activeSource ? `${SOURCE_NAME[activeSource] ?? activeSource}（自动）` : "自动选择中…";
}

/** 大盘指数卡片：点卡片即勾选（多选）；右上角图钉是「已在菜单栏」的只读标识 */
/** 大盘指数卡片：点卡片即勾选（多选）；名称行右端的图钉是「已在菜单栏」的只读标识 */
function idxCard(it: { secid: string; name: string }): string {
  return `
    <div class="idx" data-id="${esc(it.secid)}">
      <div class="idx-head">
        <span class="pick"><input type="checkbox" data-id="${esc(it.secid)}" aria-label="选择 ${esc(it.name)}" /><i></i></span>
        <b class="idx-name">${esc(it.name)}</b>
        <span class="bar-mark" hidden>${I.pin}<b></b></span>
      </div>
      <b class="idx-price">--</b>
      <span class="idx-chg flat"><i class="idx-change">--</i><i class="idx-pct">--</i></span>
    </div>`;
}

function stockRow(id: string): string {
  return `
    <div class="stock" data-id="${esc(id)}" tabindex="0">
      <span class="stock-handle" title="拖动调整顺序" aria-hidden="true">${I.grip}</span>
      <span class="pick"><input type="checkbox" data-id="${esc(id)}" aria-label="选择 ${esc(codeOf(id))}" /><i></i></span>
      <div class="stock-main">
        <b class="stock-name"></b>
        <small><span class="tag">${marketTag(id)}</span>${esc(codeOf(id))}<span class="bar-mark" hidden>${I.pin}<b></b></span></small>
      </div>
      <div class="stock-price">--</div>
      <div class="pill stock-pct flat">--</div>
      <button class="stock-pin" aria-pressed="false" title="置顶" aria-label="置顶">${I.top}</button>
    </div>`;
}

/** 页面上可勾选的标的（大盘在前）：顺序决定 Shift 区间与批量加入菜单栏的先后 */
function marketIds(): string[] {
  return [...INDICES.map((it) => it.secid), ...S.watchlist];
}

function setPick(id: string, on: boolean): void {
  if (on) picked.add(id);
  else picked.delete(id);
}

function clearPick(): void {
  picked.clear();
  lastPick = -1;
  renderMarket();
}

/** 行的状态：picked（多选）与 on（已在菜单栏，只读标识：图钉 + 顺序号） */
function paintMark(row: HTMLElement, id: string): void {
  const at = S.bar.indexOf(id);
  row.classList.toggle("on", at >= 0);
  row.classList.toggle("picked", picked.has(id));
  const mark = $(".bar-mark", row);
  mark.hidden = at < 0;
  if (at >= 0) {
    mark.title = `已显示在${BAR}（第 ${at + 1} 位）`;
    $("b", mark).textContent = String(at + 1);
  }
  $<HTMLInputElement>(".pick input", row).checked = picked.has(id);
}

let stocksKey = "";
function renderMarket(): void {
  const box = $("#stocks");
  const pinnedCount = pinCount(S.watchlist, S.pins); // 置顶区长度（loadSettings 保证置顶的都在最前）
  $("#bar-count").textContent = `${S.bar.length} / ${BAR_MAX}`;
  $("#watch-count").textContent = S.watchlist.length ? `${S.watchlist.length} 只` : "";
  $("#drag-hint").hidden = S.watchlist.length < 2; // 只有一行时没什么可拖的
  const idxBox = $("#stocks-idx");
  if (!idxBox.childElementCount) idxBox.innerHTML = INDICES.map((it) => idxCard(it)).join("");
  const key = `${S.watchlist.join(",")}|${S.pins.join(",")}`;
  if (key !== stocksKey) {
    stocksKey = key;
    $("#stocks-watch").innerHTML = S.watchlist.length
      ? S.watchlist.map((id) => stockRow(id)).join("")
      : `<div class="stocks-empty">还没有自选，用上面的搜索框添加</div>`;
  }
  for (const it of INDICES) {
    const card = $(`.idx[data-id="${it.secid}"]`, idxBox);
    const q = quotes.get(it.secid);
    const d = dirOf(q?.pct);
    $(".idx-name", card).textContent = it.name;
    const price = $(".idx-price", card);
    price.textContent = barPrice(q?.price);
    price.className = `idx-price ${d}`;
    $(".idx-change", card).textContent = q?.change == null ? "--" : `${q.change > 0 ? "+" : ""}${q.change.toFixed(2)}`;
    $(".idx-pct", card).textContent = barPct(q, false);
    $(".idx-chg", card).className = `idx-chg ${d}`;
    card.dataset.dir = d;
    paintMark(card, it.secid);
  }
  $$(".stock", box).forEach((row, i) => {
    const id = row.dataset.id!;
    const q = quotes.get(id);
    $(".stock-name", row).textContent = q?.name ?? codeOf(id);
    $(".stock-price", row).textContent = barPrice(q?.price);
    const pinned = S.pins.includes(id);
    row.classList.toggle("pinned", pinned);
    // 置顶区的最后一行画一道分界，和下面的普通自选分开
    row.classList.toggle("last-pinned", pinned && i === pinnedCount - 1);
    const pct = $(".stock-pct", row);
    pct.textContent = barPct(q, false);
    pct.className = `pill stock-pct ${dirOf(q?.pct)}`;
    const pin = $(".stock-pin", row);
    const label = pinned ? "取消置顶" : "置顶";
    pin.classList.toggle("on", pinned);
    pin.setAttribute("aria-pressed", String(pinned));
    pin.title = label;
    pin.setAttribute("aria-label", label);
    paintMark(row, id);
  });
  syncSelbar();
}

function syncSelbar(): void {
  const ids = [...picked];
  const inBar = ids.filter((id) => S.bar.includes(id)).length;
  $("#selbar").classList.toggle("on", ids.length > 0);
  $("#sel-count").textContent = String(ids.length);
  $('[data-act="add"]').toggleAttribute("disabled", inBar === ids.length || S.bar.length >= BAR_MAX);
  $('[data-act="remove"]').toggleAttribute("disabled", inBar === 0);
  $('[data-act="delete"]').toggleAttribute("disabled", !ids.some((id) => S.watchlist.includes(id)));
}

let hintTimer: number | undefined;
/** 批量操作后的短提示（不打断操作，几秒后自己消失） */
function hint(text: string): void {
  const el = $("#mhint");
  el.textContent = text;
  el.classList.add("on");
  window.clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => el.classList.remove("on"), 3600);
}

function batchAdd(ids: string[]): void {
  const res = addToBar(S.bar, ids, BAR_MAX);
  if (!res.added.length) return hint(`${BAR}已满（最多 ${BAR_MAX} 只）`);
  S.bar = res.bar;
  clearPick();
  commit();
  hint(
    res.overflow.length
      ? `已加入 ${res.added.length} 只，其余 ${res.overflow.length} 只因${BAR}已满未加入`
      : `已加入 ${res.added.length} 只`,
  );
}

function batchRemove(ids: string[]): void {
  const on = ids.filter((id) => S.bar.includes(id));
  if (!on.length) return hint(`选中的标的都不在${BAR}上`);
  S.bar = S.bar.filter((id) => !on.includes(id));
  clearPick();
  commit();
  hint(`已移出 ${on.length} 只`);
}

/** 置顶 / 取消置顶：置顶的固定在自选最前，拖动也不会被挤下去 */
function togglePin(id: string): void {
  if (!S.watchlist.includes(id)) return;
  const on = S.pins.includes(id);
  const next = on ? unpinItem(S.watchlist, S.pins, id) : pinItem(S.watchlist, S.pins, id);
  S.watchlist = next.list;
  S.pins = next.pins;
  lastPick = -1; // 顺序变了，Shift 区间选择的锚点作废
  commit();
  hint(on ? "已取消置顶" : "已置顶");
}

/** 删除自选：一并从菜单栏与置顶里移除（与主面板右键删除一致） */
function deleteStocks(ids: string[]): void {
  const del = ids.filter((id) => S.watchlist.includes(id));
  if (!del.length) return hint("大盘指数不能删除");
  S.watchlist = S.watchlist.filter((id) => !del.includes(id));
  S.pins = S.pins.filter((id) => !del.includes(id));
  S.bar = S.bar.filter((id) => !del.includes(id));
  if (del.includes(S.selected)) S.selected = S.watchlist[0] ?? INDICES[0].secid;
  del.forEach((id) => picked.delete(id));
  lastPick = -1;
  commit();
  hint(`已删除 ${del.length} 只自选`);
}

// ---------- 行情页：新增自选搜索 ----------

function closeAdd(): void {
  window.clearTimeout(addTimer); // 还在防抖里的、已经发出没回来的搜索都作废
  addSeq++;
  addResults.classList.remove("show");
  addResults.innerHTML = "";
}

function renderAddResults(items: SearchItem[]): void {
  addResults.innerHTML = items.length
    ? items
        .map((it) => {
          const added = S.watchlist.includes(it.secid);
          return (
            `<div class="sr" data-id="${esc(it.secid)}">` +
            `<div class="sr-main"><div class="sr-name">${esc(it.name)}</div>` +
            `<div class="sr-meta"><span class="tag">${marketTag(it.secid)}</span>${esc(it.code)} · ${esc(it.type)}</div></div>` +
            `<button class="sr-add ${added ? "added" : ""}" ${added ? "disabled" : ""}>${added ? "已添加" : "＋"}</button>` +
            `</div>`
          );
        })
        .join("")
    : `<div class="sr-empty">没有找到相关股票</div>`;
  addResults.classList.add("show");
}

// ---------- 仪表盘：菜单栏顺序列表 ----------

function ordRow(id: string): string {
  return `
    <div class="ord" data-id="${esc(id)}" tabindex="0">
      <span class="ord-handle" title="拖动调整顺序">${I.grip}</span>
      <span class="ord-order"></span>
      <b class="ord-name"></b>
      <span class="ord-price"></span>
      <span class="pill ord-pct flat">--</span>
      <button class="ord-del" title="从${BAR}移除" aria-label="从${BAR}移除">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>`;
}

let ordKey = "";
/** 列表顺序就是 S.bar 的顺序；拖动排序见「仪表盘：拖动调整菜单栏顺序」 */
function renderOrder(): void {
  const box = $("#ord-list");
  $("#ord-count").textContent = `${S.bar.length} / ${BAR_MAX}`;
  const key = S.bar.join(",");
  if (key !== ordKey) {
    ordKey = key;
    box.innerHTML = S.bar.length
      ? S.bar.map((id) => ordRow(id)).join("")
      : `<div class="ord-empty">还没有选择标的，去「行情」页勾选后回来拖动排序</div>`;
  }
  $$(".ord", box).forEach((row, i) => {
    const id = row.dataset.id!;
    const q = quotes.get(id);
    if (!drag) row.style.transform = ""; // 拖动中别动位移，否则被拖的那行会跳
    $(".ord-order", row).textContent = String(i + 1);
    $(".ord-name", row).textContent = q?.name ?? INDICES.find((it) => it.secid === id)?.name ?? codeOf(id);
    $(".ord-price", row).textContent = barPrice(q?.price);
    const pct = $(".ord-pct", row);
    pct.textContent = barPct(q, false);
    pct.className = `pill ord-pct ${dirOf(q?.pct)}`;
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

// ---------- 行情页：多选、批量操作、新增自选 ----------

const addInput = $<HTMLInputElement>("#add-input");
const addResults = $("#add-results");
let addTimer: number | undefined;
let addSeq = 0;

// 键盘操作复选框时走 change（鼠标点击在下面的 click 里统一处理）
$("#stocks").addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const id = input.dataset.id;
  if (!id) return;
  setPick(id, input.checked);
  lastPick = marketIds().indexOf(id);
  renderMarket();
});

// 点行任意处 = 切换复选框；Shift 区间选择、Cmd/Ctrl+A 全选、Esc 清空
$("#stocks").addEventListener("click", (e) => {
  // 键盘（空格）触发的是输入框自己的 click：交给原生切换 + change 处理，
  // 在这里拦下来会让浏览器把勾选状态回滚，勾了却看不到勾
  if (e.target instanceof HTMLInputElement) return;
  const t = e.target as HTMLElement;
  // 从把手按下、或刚拖完的那一下 click 不算「点行勾选」；无条件取走，别留到下一次点击
  const dragged = takeMarketClick();
  const row = t.closest<HTMLElement>(".stock, .idx");
  const id = row?.dataset.id;
  // 把手与行尾的置顶按钮只做自己的事：拖动留下的那一下 click 也不该挡住它们
  if (t.closest(".stock-handle")) return;
  if (t.closest(".stock-pin")) {
    if (id) togglePin(id);
    return;
  }
  if (dragged || !row || !id) return;
  e.preventDefault(); // 鼠标点击统一走这里：原生切换不支持 Shift 区间
  const ids = marketIds();
  const at = ids.indexOf(id);
  if (e.shiftKey && lastPick >= 0 && at >= 0) {
    const on = !picked.has(id);
    for (let i = Math.min(lastPick, at); i <= Math.max(lastPick, at); i++) setPick(ids[i], on);
  } else {
    setPick(id, !picked.has(id));
  }
  lastPick = at;
  renderMarket();
});

// 右键只作用于该行：加入 / 移出菜单栏、删除自选（批量走顶部操作条）
$("#stocks").addEventListener("contextmenu", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".stock, .idx");
  const id = row?.dataset.id;
  if (!row || !id) return;
  e.preventDefault();
  const on = S.bar.includes(id);
  const full = S.bar.length >= BAR_MAX;
  openMenu(e.clientX, e.clientY, [
    on
      ? {
          label: `从${BAR}移除`,
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
    ...(S.watchlist.includes(id)
      ? [
          { label: S.pins.includes(id) ? "取消置顶" : "置顶", onPick: () => togglePin(id) },
          { label: "删除自选", danger: true, onPick: () => deleteStocks([id]) },
        ]
      : []),
  ]);
});

$("#selbar").addEventListener("click", (e) => {
  const act = (e.target as HTMLElement).closest<HTMLElement>(".sel-act")?.dataset.act;
  if (!act) return;
  if (act === "clear") return clearPick();
  // 按页面顺序取出选中的标的：决定批量加入菜单栏的先后
  const ids = marketIds().filter((id) => picked.has(id));
  if (!ids.length) return clearPick(); // 选中的标的已经不在列表里了
  if (act === "add") batchAdd(ids);
  else if (act === "remove") batchRemove(ids);
  else if (act === "delete") deleteStocks(ids);
});

// 新增自选：内联搜索，与主面板共用同一套接口与防抖
addInput.addEventListener("input", () => {
  window.clearTimeout(addTimer);
  const kw = addInput.value.trim();
  if (!kw) return closeAdd();
  addTimer = window.setTimeout(async () => {
    const seq = ++addSeq;
    try {
      const items = await searchStocks(kw);
      if (seq === addSeq) renderAddResults(items);
    } catch {
      if (seq !== addSeq) return;
      addResults.innerHTML = `<div class="sr-empty">搜索失败，请稍后重试</div>`;
      addResults.classList.add("show");
    }
  }, 300);
});

addInput.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  addInput.value = "";
  closeAdd();
});

addResults.addEventListener("click", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>(".sr")?.dataset.id;
  if (!id || S.watchlist.includes(id)) return;
  S.watchlist = [...S.watchlist, id];
  addInput.value = "";
  closeAdd();
  commit();
  hint("已加入自选");
  void poll();
});

document.addEventListener("click", (e) => {
  if (!(e.target as HTMLElement).closest(".add-box")) closeAdd();
});

// Cmd/Ctrl+A 全选、Esc 清空选择（在输入框里输入时不做拦截）
document.addEventListener("keydown", (e) => {
  if (page !== "market") return;
  const t = e.target as HTMLElement;
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return;
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
    e.preventDefault();
    marketIds().forEach((id) => picked.add(id));
    lastPick = -1;
    renderMarket();
  } else if (e.key === "Escape" && picked.size) {
    clearPick();
  }
});

// ---------- 拖动排序（仪表盘「菜单栏显示」与行情页「自选」共用同一套指针逻辑） ----------

interface DragCfg {
  /** 行容器 */
  list: HTMLElement;
  /** 行选择器（行要带 data-id：键盘移动后靠它找回焦点） */
  row: string;
  /** 把手选择器 */
  handle: string;
  /** true = 鼠标可从行任意处起拖；false = 一律从把手起拖（行情页点行是勾选） */
  rowDrag: boolean;
  /** 现在能不能拖（行数不足时不动） */
  movable: () => boolean;
  /** 落点钳制：置顶区里的只能在置顶区里挪，其余只能在置顶区之后挪 */
  clamp: (from: number, to: number) => number;
  /** 松手后把 from→to 写回设置，commit 由调用方自己来 */
  apply: (from: number, to: number) => void;
  render: () => void;
}

/** 拖动中的状态；rects 是拖动开始时各行的位置，用于算其他行要让开多少 */
interface DragState {
  cfg: DragCfg;
  from: number;
  to: number;
  startY: number;
  rects: RowRect[];
  el: HTMLElement;
}

let drag: DragState | null = null;

const dragRows = (cfg: DragCfg) => $$(cfg.row, cfg.list);

/**
 * 让一个列表支持拖动排序：鼠标 / 触屏拖行，键盘 Alt + ↑/↓ 移动。
 * 返回「取走这一下 click」的判断：从把手按下、或真的拖动过的那一次点击不该当成点行
 * —— 指针捕获会把 click 的目标换成整行，光看 e.target 认不出把手。
 */
function sortable(cfg: DragCfg): () => boolean {
  const { list } = cfg;
  /** 这一次 click 不要交给行的点击逻辑 */
  let swallow = false;

  list.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>(cfg.row);
    if (!row || !cfg.movable() || e.button !== 0) return; // 右键 / 中键不拖动
    if (t.closest("button")) return; // 行上的按钮自己处理点击
    const fromHandle = !!t.closest(cfg.handle);
    // 触屏拖动容易和滚动打架：非鼠标一律只允许从把手起拖
    if (!fromHandle && (!cfg.rowDrag || e.pointerType !== "mouse")) return;
    cancelDrag(); // 上一轮没收拾干净的拖动先复位
    const rows = dragRows(cfg);
    const from = rows.indexOf(row);
    if (from < 0) return;
    swallow = fromHandle;
    drag = {
      cfg,
      from,
      to: from,
      startY: e.clientY,
      rects: rows.map((r) => {
        const b = r.getBoundingClientRect();
        return { top: b.top, height: b.height };
      }),
      el: row,
    };
    row.classList.add("dragging");
    list.classList.add("dragging");
    row.setPointerCapture(e.pointerId);
  });

  list.addEventListener("pointermove", (e) => {
    if (drag?.cfg !== cfg) return;
    // 行已被重建（别的窗口改了顺序）或按键已松开：立刻中止，别拿旧下标去动新列表
    if (!drag.el.isConnected || !e.buttons) return cancelDrag();
    drag.el.style.transform = `translateY(${e.clientY - drag.startY}px)`;
    const to = cfg.clamp(drag.from, slotAt(drag.rects, e.clientY));
    if (to === drag.to) return;
    drag.to = to;
    layoutDrag();
    layoutDrag();
  });

  list.addEventListener("pointerup", () => endDrag(true));
  list.addEventListener("pointercancel", () => endDrag(false));
  // 指针被系统抢走（触屏滚动、右键菜单）时捕获会静默丢失，别把半途的顺序写回去
  list.addEventListener("lostpointercapture", cancelDrag);

  // 键盘：Alt + ↑/↓ 移动（鼠标之外的第二条路）
  list.addEventListener("keydown", (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>(cfg.row);
    if (!row || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
    const rows = dragRows(cfg);
    const from = rows.indexOf(row);
    const to = cfg.clamp(from, e.key === "ArrowUp" ? from - 1 : from + 1);
    if (from < 0 || to < 0 || to >= rows.length) return;
    e.preventDefault();
    const id = row.dataset.id;
    cfg.apply(from, to);
    dragRows(cfg)
      .find((r) => r.dataset.id === id)
      ?.focus();
  });

  return () => {
    const take = swallow;
    swallow = false;
    return take;
  };
}

/** 拖动中让其他行让开：按目标顺序给每行一个位移，被拖的那行跟手 */
function layoutDrag(): void {
  const d = drag;
  if (!d) return;
  dragRows(d.cfg).forEach((row, i) => {
    if (row === d.el) return;
    const next = shiftIndex(i, d.from, d.to);
    row.style.transform = next === i ? "" : `translateY(${d.rects[next].top - d.rects[i].top}px)`;
  });
}

/** 结束拖动；apply=false 表示中止（指针被系统抢走、列表被重建），只复位不写回顺序 */
function endDrag(apply: boolean): void {
  const d = drag;
  if (!d) return;
  drag = null;
  d.el.classList.remove("dragging");
  d.cfg.list.classList.remove("dragging");
  if (apply && d.from !== d.to) return d.cfg.apply(d.from, d.to);
  // 没换位置 / 中止：拖动中写下的位移由这里收回（渲染函数只管内容，不一定清 transform）
  dragRows(d.cfg).forEach((row) => (row.style.transform = ""));
  d.cfg.render();
}

/** 中止拖动：只把位移复位 */
function cancelDrag(): void {
  if (drag) endDrag(false);
}

// 仪表盘：拖动调整菜单栏显示的顺序
const ordList = $("#ord-list");
sortable({
  list: ordList,
  row: ".ord",
  handle: ".ord-handle",
  rowDrag: true,
  movable: () => S.bar.length > 1,
  clamp: (_from, to) => to,
  apply: (from, to) => {
    S.bar = moveItem(S.bar, from, to);
    commit();
  },
  render: renderOrder,
});

// 行情页：拖动调整自选顺序（这个顺序同时也是主面板列表的顺序）
const takeMarketClick = sortable({
  list: $("#stocks-watch"),
  row: ".stock",
  handle: ".stock-handle",
  rowDrag: false,
  movable: () => S.watchlist.length > 1,
  clamp: (from, to) => clampBlock(S.watchlist, S.pins, from, to),
  apply: (from, to) => {
    S.watchlist = moveItem(S.watchlist, from, to);
    lastPick = -1; // 顺序变了，Shift 区间选择的锚点作废
    commit();
  },
  render: renderMarket,
});

ordList.addEventListener("click", (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>(".ord");
  if (!row || !(e.target as HTMLElement).closest(".ord-del")) return;
  S.bar = S.bar.filter((x) => x !== row.dataset.id);
  commit();
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

$("#seg-source").addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.v as DataSource | undefined;
  if (!v || v === S.source) return;
  S.source = v;
  commit();
  void poll();
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
    const got = await fetchQuotes([...INDICES.map((it) => it.secid), ...S.watchlist], S.source);
    got.forEach((q, k) => quotes.set(k, q));
    activeSource = getActiveSource();
    renderMarket();
    renderOrder();
    renderPreview();
    $<HTMLElement>("#source-active").textContent = activeFor(S);
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
  cancelDrag(); // 列表马上要重建，先收掉进行中的拖动
  // 别处删掉的标的要从多选里摘掉：否则会拿它去加菜单栏，Shift 锚点也会错位
  for (const id of [...picked]) if (!marketIds().includes(id)) picked.delete(id);
  lastPick = -1;
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
