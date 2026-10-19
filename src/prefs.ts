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
import { cancelDrag, isDragging, sortable } from "./sortable";
import { isDragClick } from "./tabs";
import { bridgeState, clientConfig, type McpInfo } from "./mcp";
import { Channel } from "@tauri-apps/api/core";
import {
  canInstall,
  formatDate,
  progressPct,
  progressText,
  statusOf,
  versionLabel,
  type Phase,
  type UpdateInfo,
} from "./update";
import {
  BAR_MAX,
  GROUP_NAME_MAX,
  INDICES,
  UNGROUPED,
  addToBar,
  applyAppearance,
  applySearchAction,
  clampAlertValue,
  dropAlertsOf,
  dropGroupOf,
  groupNameOf,
  groupTargets,
  groupTargetsFor,
  isDark,
  isIndex,
  itemsOf,
  loadSettings,
  moveItem,
  moveRowInView,
  newAlert,
  newGroup,
  onSettingsChange,
  pinCount,
  pinItem,
  removeGroup,
  renameGroup,
  saveSettings,
  searchActions,
  setGroup,
  setGroupMany,
  unpinItem,
  type Alert,
  type AlertKind,
  type AlertOp,
  type BarField,
  type BarStyle,
  type SearchAction,
  type Settings,
  type Theme,
} from "./settings";
import { IN_TAURI, IS_WIN, call, callOrThrow, listenAll } from "./tauri";
import appIcon from "./assets/app-icon.png";
// 与 Rust 托盘共用同一张图标（src-tauri/icons/tray.png），避免两份图不一致
import trayIcon from "../src-tauri/icons/tray.png";
import { openMenu, type MenuItem } from "./ctxmenu";
import { alertLabel } from "./alerts";
import { notifyGranted, requestNotify, sendNotify } from "./notify";

// ---------- 状态 ----------

let S: Settings = loadSettings();
const quotes = new Map<string, Quote>();
type Page = "dashboard" | "market" | "alerts" | "mcp" | "about" | "settings";
/** 页名白名单：Rust 侧也会过滤（见 lib.rs 的 PAGES），这里再挡一次，免得切到空白页 */
const PAGES: Page[] = ["dashboard", "market", "alerts", "mcp", "about", "settings"];
const isPage = (p: unknown): p is Page => PAGES.includes(p as Page);
const HASH = location.hash.replace("#", "");
let page: Page = isPage(HASH) ? HASH : "dashboard";
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
  mcp: `<svg viewBox="0 0 24 24"><path d="M11 3.5l1.7 4.6 4.6 1.7-4.6 1.7L11 16.1 9.3 11.5 4.7 9.8l4.6-1.7z"/><path d="M18.5 14.5l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/></svg>`,
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
  about: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11.2v5.3"/><circle cx="12" cy="7.9" r="1" class="fill"/></svg>`,
  bell: `<svg viewBox="0 0 24 24"><path d="M18 8.6a6 6 0 0 0-12 0c0 4.4-2 5.6-2 5.6h16s-2-1.2-2-5.6z"/><path d="M10.3 18a2 2 0 0 0 3.4 0"/></svg>`,
  top: `<svg viewBox="0 0 24 24"><path d="M4.5 4.5h15M12 20V9M7.5 13L12 8.5l4.5 4.5"/></svg>`,
  /** 取消置顶：与 top 同一个顶部横线、箭头朝下（右键菜单里与「置顶」成对出现） */
  topOff: `<svg viewBox="0 0 24 24"><path d="M4.5 4.5h15M12 9v11M7.5 15l4.5 4.5 4.5-4.5"/></svg>`,
  more: `<svg class="fill" viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/></svg>`,
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
      <button class="nav-item" data-page="alerts"><span class="nav-ico red">${I.bell}</span>提醒</button>
      <button class="nav-item" data-page="mcp"><span class="nav-ico violet">${I.mcp}</span>MCP</button>
      <button class="nav-item" data-page="settings"><span class="nav-ico gray">${I.settings}</span>设置</button>
      <button class="nav-item" data-page="about"><span class="nav-ico orange">${I.about}</span>关于</button>
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
      <h2 class="group-title">${BAR}显示 <span class="count" id="ord-count"></span><span class="title-hint">顺序即${BAR}上的显示顺序${IS_WIN ? "" : "；标的太多会被系统截断甚至隐藏"}</span></h2>
      <div class="group ordgroup">
        <div class="ordlist" id="ord-list"></div>
      </div>
    </section>

    <section class="page" data-page="market">
      <header class="page-head">
        <h1>行情</h1>
        <p>管理${BAR}上要显示的标的：勾选可批量操作，拖动自选左侧把手可调整顺序，行尾按钮可置顶，右键某一行可加入${BAR}、移入分组或删除自选；拖动下面的分组胶囊可调整分组顺序，右键分组标题可重命名、上移下移或删除分组。</p>
      </header>

      <h2 class="group-title">${BAR}显示 <span class="count" id="bar-count"></span><span class="title-hint">大盘与自选共用名额，${BAR}顺序在仪表盘调整</span></h2>
      <div class="mhint" id="mhint" role="status" aria-live="polite"></div>
      <div class="group stocks" id="stocks">
        <div class="stock-sec">
          <div class="sec-head">大盘指数</div>
          <div class="sec-cards" id="stocks-idx"></div>
        </div>
        <div class="stock-sec">
          <div class="sec-head">自选股票 <span class="sec-count" id="watch-count"></span><span class="title-hint" id="drag-hint" hidden>拖动左侧把手调整顺序</span><button class="sec-btn" id="add-group">＋ 新建分组</button></div>
          <div class="add-box">
            <div class="add-search">
              ${I.search}
              <input id="add-input" placeholder="搜索代码 / 名称 / 拼音，添加自选" autocomplete="off" spellcheck="false" />
            </div>
            <div class="add-results" id="add-results"></div>
          </div>
          <div class="gchips" id="gchips" hidden>
            <button class="gchip fixed" data-gid="" title="未分组固定在最前，点一下跳到这个分组">未分组<b id="gchip-un">0</b></button>
            <div class="gchip-scroll" id="gchip-list" role="group" aria-label="分组顺序：拖动胶囊调整"></div>
          </div>
          <div class="sec-groups" id="watch-groups"></div>
        </div>
      </div>

      <div class="selbar" id="selbar">
        <span class="selbar-count">已选 <b id="sel-count">0</b> 项</span>
        <div class="selbar-acts">
          <button class="sel-act" data-act="add">加入${BAR}</button>
          <button class="sel-act" data-act="remove">移出${BAR}</button>
          <button class="sel-act" data-act="group">移入分组</button>
          <button class="sel-act danger" data-act="delete">删除自选</button>
          <button class="sel-act ghost" data-act="clear">取消选择</button>
        </div>
      </div>
    </section>

    <section class="page" data-page="alerts">
      <header class="page-head">
        <h1>提醒</h1>
        <p>按标的设条件：价格上穿或跌破某个价位，或当日涨跌幅涨超、跌超某个百分比。条件成立的那一刻用系统通知提醒一次，条件回落后再成立才会再提醒。</p>
      </header>

      <h2 class="group-title">通知<span class="title-hint">走系统通知，应用收在菜单栏里也会弹</span></h2>
      <div class="group">
        <div class="row">
          <div class="row-label">启用提醒<small>关掉后规则全部保留，但一条通知都不发</small></div>
          <label class="switch"><input type="checkbox" id="alerts-on" /><i></i></label>
        </div>
        <div class="row">
          <div class="row-label">系统通知权限<small>没授权时系统会直接丢掉通知</small></div>
          <div class="alert-acts">
            <span class="alert-perm" id="alerts-perm">检测中…</span>
            <button class="sec-btn" id="alerts-perm-btn">请求权限</button>
            <button class="sec-btn" id="alerts-test">测试通知</button>
          </div>
        </div>
      </div>

      <h2 class="group-title">新建规则</h2>
      <div class="group">
        <div class="alert-form">
          <select id="alert-target" class="alert-select" aria-label="标的"></select>
          <div class="seg" id="seg-alert-kind" style="--n:2">
            <button data-v="price">价格</button>
            <button data-v="pct">涨跌幅</button>
          </div>
          <div class="seg" id="seg-alert-op" style="--n:2">
            <button data-v="below" id="alert-op-below">跌破</button>
            <button data-v="above" id="alert-op-above">上穿</button>
          </div>
          <label class="alert-input-wrap">
            <input id="alert-value" type="number" inputmode="decimal" min="0" step="0.01" placeholder="阈值" autocomplete="off" spellcheck="false" />
            <b id="alert-unit">元</b>
          </label>
          <button class="sec-btn primary" id="alert-add">添加规则</button>
        </div>
        <div class="alert-hint" id="alert-form-hint"></div>
      </div>

      <h2 class="group-title">规则 <span class="count" id="alert-count"></span><span class="title-hint">一只标的可以有多条规则</span></h2>
      <div class="group">
        <div class="alert-list" id="alert-list"></div>
      </div>
    </section>

    <section class="page" data-page="mcp">
      <header class="page-head">
        <h1>MCP</h1>
        <p>让支持 MCP 的 AI 客户端（Claude Code、Claude Desktop 等）按你的话改自选与分组。命令由应用执行，校验、分组与置顶规则和手点完全一致，改完界面与菜单栏立即同步。</p>
      </header>

      <h2 class="group-title">本地桥<span class="title-hint">关掉后端口不再监听</span></h2>
      <div class="group">
        <div class="row">
          <div class="row-label">允许 AI 客户端改自选<small>需要 Node 22+，且应用正在运行</small></div>
          <div class="mcp-right">
            <span class="mcp-state" id="mcp-state"><i></i><b>检测中…</b></span>
            <label class="switch"><input type="checkbox" id="mcp-on" /><i></i></label>
          </div>
        </div>
        <div class="mcp-box" id="mcp-box">
          <div class="mcp-head">
            <div class="row-label">客户端配置<small>贴进客户端的 MCP 配置里；路径已指向应用自带的脚本</small></div>
            <button class="sec-btn" id="mcp-copy">复制配置</button>
          </div>
          <pre class="mcp-code" id="mcp-code" tabindex="0"></pre>
          <div class="mcp-hint" id="mcp-hint"></div>
        </div>
      </div>

      <h2 class="group-title">能做什么</h2>
      <div class="group">
        <div class="mcp-caps">
          <ul>
            <li>查看自选与分组，以及每组里放了什么</li>
            <li>按代码 / 名称 / 拼音搜索标的</li>
            <li>加入、移除自选，调整顺序与置顶</li>
            <li>新建 / 改名 / 删除 / 排序分组，把自选移进移出分组</li>
          </ul>
          <div class="mcp-hint">大盘指数是内置的，不能通过 MCP 增删。</div>
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

    <section class="page" data-page="about">
      <header class="page-head">
        <h1>关于</h1>
        <p>StockBar 会向 GitHub 发布页检查新版本，发现后可直接在应用内下载安装，装完重启即生效。</p>
      </header>

      <h2 class="group-title">版本</h2>
      <div class="group">
        <div class="row">
          <div class="row-label">当前版本</div>
          <span class="row-value" id="about-version">--</span>
        </div>
        <div class="row">
          <div class="row-label">启动时自动检查更新<small>只在发现新版本时提示，不会自己下载</small></div>
          <label class="switch"><input type="checkbox" id="about-auto" /><i></i></label>
        </div>
      </div>

      <h2 class="group-title">更新</h2>
      <div class="group">
        <div class="row">
          <div class="row-label">状态</div>
          <span class="up-state muted" id="up-state"><i></i><b>还没有检查过更新</b></span>
        </div>
        <div class="up-actions">
          <button class="sec-btn" id="up-check">检查更新</button>
          <button class="pri-btn" id="up-install" hidden>立即更新</button>
        </div>
        <div class="up-progress" id="up-progress" hidden>
          <div class="up-track"><i id="up-fill"></i></div>
          <span class="up-progress-text" id="up-progress-text"></span>
        </div>
        <div class="up-notes" id="up-notes" hidden>
          <div class="up-notes-head" id="up-notes-title"></div>
          <pre class="up-notes-body" id="up-notes-body"></pre>
        </div>
        <div class="up-foot">
          <span class="up-hint">自动更新走不通时（比如应用装在只读位置），可以到发布页手动下载。</span>
          <button class="sec-btn" id="up-page">打开发布页</button>
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
  renderMcp();
  renderAlerts();
  renderAbout();
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
  return [...INDICES.map((it) => it.secid), ...sections().flatMap((s) => s.items)];
}

// ---------- 行情页：自选分组 ----------
// 分组只决定自选怎么分堆：菜单栏（bar）名额与置顶（pins）都不受它影响。

/** 「拖完那一下 click」的标记：DOM 重建会换掉 sortable 实例，各分组区块因此共用一份状态 */
const marketSwallow = { take: false };

/** 正在等确认删除的分组 id：删除分组是不可逆的，先就地让用户按第二次，见 groupHead() */
let groupConfirm: string | null = null;

/** 分组区块：未分组永远在最前，其后是用户建的分组（顺序即主面板筛选条的顺序） */
function sections(): { gid: string; name: string; items: string[] }[] {
  return [
    { gid: UNGROUPED, name: "未分组", items: itemsOf(S.watchlist, S.groupOf, S.groups, UNGROUPED) },
    ...S.groups.map((g) => ({
      gid: g.id,
      name: g.name,
      items: itemsOf(S.watchlist, S.groupOf, S.groups, g.id),
    })),
  ];
}

/** 分组标题：正常态是「名字 + 只数 + ⋯」，确认态换成一条删除确认（把成员的去向先说清楚） */
function groupHead(sec: { gid: string; name: string; items: string[] }): string {
  if (sec.gid && sec.gid === groupConfirm) {
    const n = sec.items.length;
    return (
      `<div class="gsec-head confirm" data-gid="${sec.gid}">` +
      `<b class="gsec-name">删除「${esc(sec.name)}」？</b>` +
      `<span class="gsec-detail">${n ? `${n} 只标的会移到未分组` : "分组是空的"}</span>` +
      `<span class="gsec-acts">` +
      `<button class="gsec-btn danger" data-del data-gid="${sec.gid}">删除</button>` +
      `<button class="gsec-btn" data-cancel data-gid="${sec.gid}">取消</button>` +
      `</span></div>`
    );
  }
  return (
    `<div class="gsec-head" data-gid="${sec.gid}">` +
    `<b class="gsec-name">${esc(sec.name)}</b><span class="sec-count">${sec.items.length} 只</span>` +
    // 未分组不给菜单：它固定在最前，不能改名、不能排序、也不能删
    (sec.gid
      ? `<button class="gsec-more" data-more data-gid="${sec.gid}" ` +
        `title="重命名 / 上移下移 / 删除分组" aria-label="分组操作" aria-haspopup="menu">${I.more}</button>`
      : "") +
    `</div>`
  );
}

/** 一个分组区块：flat = 还没建过分组，这时只有这一个区块、不画标题（保持原来的样子） */
function groupSec(sec: { gid: string; name: string; items: string[] }, flat: boolean): string {
  const rows = sec.items.length
    ? sec.items.map((id) => stockRow(id)).join("")
    : `<div class="stocks-empty">${flat ? "还没有自选，用上面的搜索框添加" : "这个分组还没有标的"}</div>`;
  return (
    `<div class="gsec">` +
    (flat ? "" : groupHead(sec)) +
    `<div class="sec-body" data-gid="${sec.gid}">${rows}</div>` +
    `</div>`
  );
}

/** 分组胶囊：未分组固定在最前（不能拖），其后是用户建的分组 —— 拖动出来的顺序就是分组顺序 */
function renderChips(): void {
  const box = $("#gchips");
  const flat = S.groups.length === 0; // 没建过分组：没有可排序的胶囊，整行不出现
  box.hidden = flat;
  if (flat) return;
  $("#gchip-un").textContent = String(itemsOf(S.watchlist, S.groupOf, S.groups, UNGROUPED).length);
  $("#gchip-list").innerHTML = S.groups
    .map(
      (g) =>
        `<button class="gchip" data-gid="${g.id}" title="拖动调整分组顺序（Alt + ← / → 也能挪）">` +
        `${esc(g.name)}<b>${itemsOf(S.watchlist, S.groupOf, S.groups, g.id).length}</b></button>`,
    )
    .join("");
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

let groupsKey = "";
/** 分组结构（分组、名称、成员、置顶）或删除确认态变化才重建 DOM；行情刷新只原地改文字 */
function renderGroups(): void {
  // 别的窗口把这个分组删了：确认态跟着作废，免得确认条挂在一个不存在的分组上
  if (groupConfirm && !S.groups.some((g) => g.id === groupConfirm)) groupConfirm = null;
  const box = $("#watch-groups");
  const secs = sections();
  const flat = S.groups.length === 0; // 没建过分组：只有一个区块，不画标题
  const key =
    `${flat}|${groupConfirm ?? ""}|` +
    `${secs.map((s) => `${s.gid}:${s.name}:${s.items.join(",")}`).join("|")}|${S.pins.join(",")}`;
  if (key === groupsKey) return;
  groupsKey = key;
  box.innerHTML = secs.map((s) => groupSec(s, flat)).join("");
  renderChips(); // 胶囊与区块共用同一个 key：分组、名字、成员变了才重建
  // 每个区块各自拖动排序：顺序写回整表，其他分组的相对先后不动。
  // 区块里跨过置顶分界的那一下同样改置顶状态（见 settings.ts 的 moveRowInView）
  for (const body of $$(".sec-body", box)) {
    const live = () => $$(".stock", body).map((r) => r.dataset.id!);
    sortable(
      {
        list: body,
        row: ".stock",
        handle: ".stock-handle",
        rowDrag: false,
        movable: () => live().length > 1,
        apply: (from, to) => {
          const next = moveRowInView(S.watchlist, S.pins, live(), from, to);
          S.watchlist = next.list;
          S.pins = next.pins;
          lastPick = -1; // 顺序变了，Shift 区间选择的锚点作废
          commit();
        },
        render: renderMarket,
      },
      marketSwallow,
    );
  }
}

function renderMarket(): void {
  const box = $("#stocks");
  $("#bar-count").textContent = `${S.bar.length} / ${BAR_MAX}`;
  $("#watch-count").textContent = S.watchlist.length ? `${S.watchlist.length} 只` : "";
  $("#drag-hint").hidden = S.watchlist.length < 2; // 只有一行时没什么可拖的
  const idxBox = $("#stocks-idx");
  if (!idxBox.childElementCount) idxBox.innerHTML = INDICES.map((it) => idxCard(it)).join("");
  renderGroups();
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
  // 每行的行情与状态：按区块走，置顶分界线要按区块内的位置算
  for (const sec of sections()) {
    const body = $(`.sec-body[data-gid="${sec.gid}"]`, box);
    const pinnedCount = pinCount(sec.items, S.pins); // 该区块的置顶区长度
    $$(".stock", body).forEach((row, i) => {
      const id = row.dataset.id!;
      const q = quotes.get(id);
      $(".stock-name", row).textContent = q?.name ?? codeOf(id);
      $(".stock-price", row).textContent = barPrice(q?.price);
      const pinned = S.pins.includes(id);
      row.classList.toggle("pinned", pinned);
      // 置顶区的最后一行画一道分界，和下面没置顶的分开
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
  }
  syncSelbar();
}

function syncSelbar(): void {
  const ids = [...picked];
  const inBar = ids.filter((id) => S.bar.includes(id)).length;
  $("#selbar").classList.toggle("on", ids.length > 0);
  $("#sel-count").textContent = String(ids.length);
  // 批量移入分组：只对自选有效（大盘指数不分堆），且一个可用目标都没有时不给入口
  const stocks = ids.filter((id) => S.watchlist.includes(id));
  $('[data-act="group"]').toggleAttribute(
    "disabled",
    !groupTargetsFor(S.groups, S.groupOf, stocks).some((t) => !t.done),
  );
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
  S.groupOf = dropGroupOf(S.groupOf, del);
  S.alerts = dropAlertsOf(S.alerts, del);
  if (del.includes(S.selected)) S.selected = S.watchlist[0] ?? INDICES[0].secid;
  del.forEach((id) => picked.delete(id));
  lastPick = -1;
  commit();
  hint(`已删除 ${del.length} 只自选`);
}

// ---------- 行情页：分组操作 ----------
/** 行右键菜单里的「移入分组」项：菜单没有子菜单，一个目标一项；没建过分组或不是自选就整组不出现 */
function groupMenuItems(id: string): MenuItem[] {
  if (!S.groups.length || !S.watchlist.includes(id)) return [];
  return groupTargets(S.groups, S.groupOf, id).map((t) => ({
    label: `移入「${t.name}」`,
    onPick: () => {
      S.groupOf = setGroup(S.groupOf, id, t.gid);
      lastPick = -1; // 行要换区块，Shift 区间选择的锚点作废
      commit();
      hint(`已移入「${t.name}」`);
    },
  }));
}

/** 批量移入分组：菜单一个目标一项（没有子菜单），已经全在那个分组里的置灰 */
function batchGroup(ids: string[], x: number, y: number): void {
  openMenu(
    x,
    y,
    groupTargetsFor(S.groups, S.groupOf, ids).map((t) => ({
      label: `移入「${t.name}」`,
      disabled: t.done,
      onPick: () => {
        S.groupOf = setGroupMany(S.groupOf, ids, t.gid);
        lastPick = -1; // 标的换了区块，Shift 区间选择的锚点作废
        clearPick();
        commit();
        hint(`已把 ${ids.length} 只移入「${t.name}」`);
      },
    })),
  );
}

/** 新建分组：默认名字只是占位，建好立刻进入改名 */
function addGroup(): void {
  const g = newGroup(S.groups);
  S.groups = [...S.groups, g];
  commit();
  startRename(g.id);
}

/** 分组改名：就地换成输入框，回车 / 失焦提交，Esc 放弃 */
function startRename(gid: string): void {
  const head = $(`.gsec-head[data-gid="${gid}"]`);
  if (!head) return;
  head.innerHTML = `<input class="gsec-input" maxlength="${GROUP_NAME_MAX}" aria-label="分组名称" />`;
  const input = $<HTMLInputElement>(".gsec-input", head);
  input.value = groupNameOf(S.groups, gid);
  input.focus();
  input.select();
  let done = false;
  const finish = (save: boolean) => {
    if (done) return;
    done = true;
    if (save) S.groups = renameGroup(S.groups, gid, input.value);
    groupsKey = ""; // 输入框要换回文字：内容没变时 key 不变，这里手动作废一次
    if (save) commit();
    else renderMarket();
  };
  input.addEventListener("keydown", (e) => {
    // 输入法还在拼字（拼音候选没定下来）时敲的回车 / Esc 是给输入法的，不是给这一格的：
    // 不管它就会把拼音字母当成名字提交（WebKit 这边 isComposing 不一定给，229 是通用兜底）
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.stopPropagation(); // 别让「Esc 清空多选」跟着触发
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

/** 分组顺序 = 区块顺序 = 主面板筛选条的顺序 */
function moveGroupTo(gid: string, to: number): void {
  const from = S.groups.findIndex((g) => g.id === gid);
  if (from < 0 || to < 0 || to >= S.groups.length) return;
  S.groups = moveItem(S.groups, from, to);
  lastPick = -1; // 区块顺序变了，Shift 区间选择的锚点作废
  commit();
}

/** 删除分组：成员回落到未分组（自选一只都不少）；真正删之前先走一次就地确认 */
function removeGroupAt(gid: string): void {
  const n = itemsOf(S.watchlist, S.groupOf, S.groups, gid).length;
  const next = removeGroup(S.groups, S.groupOf, gid);
  S.groups = next.groups;
  S.groupOf = next.groupOf;
  groupConfirm = null; // 别让确认态留到下一个（可能复用同一个 id 的）分组上
  lastPick = -1; // 成员换了区块，Shift 区间选择的锚点作废
  commit();
  hint(n ? `已删除分组，${n} 只标的移入未分组` : "已删除分组");
}

/** 分组标题的操作菜单：⋯ 按钮与右键共用（重命名 / 上移下移 / 删除分组） */
function openGroupMenu(gid: string, x: number, y: number): void {
  const at = S.groups.findIndex((g) => g.id === gid);
  if (at < 0) return;
  openMenu(x, y, [
    { label: "重命名", onPick: () => startRename(gid) },
    { label: "上移", disabled: at <= 0, onPick: () => moveGroupTo(gid, at - 1) },
    { label: "下移", disabled: at >= S.groups.length - 1, onPick: () => moveGroupTo(gid, at + 1) },
    { label: "删除分组…", danger: true, onPick: () => startDeleteConfirm(gid) },
  ]);
}

/** 删除分组前就地确认：标题行换成确认条，把「成员会去哪」先说清楚，再等第二次确认 */
function startDeleteConfirm(gid: string): void {
  if (!S.groups.some((g) => g.id === gid)) return;
  groupConfirm = gid;
  groupsKey = ""; // 确认态不参与内容比较，这里手动作废一次
  renderMarket();
}

function cancelDeleteConfirm(): void {
  if (!groupConfirm) return;
  groupConfirm = null;
  groupsKey = "";
  renderMarket();
}

$("#add-group").addEventListener("click", () => addGroup());

// 分组标题的操作菜单：⋯ 按钮点开、右键同样可以（未分组固定在最前，没有菜单）
$("#watch-groups").addEventListener("contextmenu", (e) => {
  const head = (e.target as HTMLElement).closest<HTMLElement>(".gsec-head");
  if (!head) return;
  e.preventDefault(); // 分组标题上不弹系统右键菜单（未分组没有菜单，也一样）
  const gid = head.dataset.gid;
  // 确认条上不再叠一层菜单：两个「删除」入口打架只会更危险
  if (!gid || groupConfirm === gid) return;
  openGroupMenu(gid, e.clientX, e.clientY);
});

// 标题上的 ⋯ 按钮与确认条上的两个按钮（确认条是重建出来的，所以走事件委托）
$("#watch-groups").addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const more = t.closest<HTMLElement>("[data-more]");
  if (more?.dataset.gid) {
    const r = more.getBoundingClientRect();
    openGroupMenu(more.dataset.gid, r.right, r.bottom + 4);
    return;
  }
  const btn = t.closest<HTMLElement>("[data-del], [data-cancel]");
  const gid = btn?.dataset.gid;
  if (!btn || !gid) return;
  if (btn.hasAttribute("data-del")) removeGroupAt(gid);
  else cancelDeleteConfirm();
});

// ---------- 行情页：新增自选搜索 ----------

function closeAdd(): void {
  window.clearTimeout(addTimer); // 还在防抖里的、已经发出没回来的搜索都作废
  addSeq++;
  addResults.classList.remove("show");
  addResults.innerHTML = "";
}

/** 最近一次搜索结果：右键操作后要按新设置重画（加入过的那一行立刻变成「已添加」） */
let addItems: SearchItem[] = [];

function renderAddResults(items: SearchItem[]): void {
  addItems = items;
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

/** 右键操作后重画结果列表（还开着才重画，已经收起就别又弹出来） */
function refreshAddResults(): void {
  if (addResults.classList.contains("show")) renderAddResults(addItems);
}

/** 执行一条搜索结果动作，提示文案按动作来说 */
function applyResultAction(id: string, action: SearchAction): void {
  const was = S.watchlist.includes(id);
  const next = applySearchAction({ watchlist: S.watchlist, pins: S.pins, groupOf: S.groupOf }, S.groups, id, action);
  S.watchlist = next.watchlist;
  S.pins = next.pins;
  S.groupOf = next.groupOf;
  lastPick = -1; // 顺序或归属变了，Shift 区间选择的锚点作废
  commit();
  refreshAddResults();
  const name = groupNameOf(S.groups, action.gid ?? UNGROUPED);
  hint(
    action.kind === "add"
      ? "已加入自选"
      : action.kind === "addToGroup"
        ? was
          ? `已移入「${name}」`
          : `已加入自选并移入「${name}」`
        : action.kind === "moveToGroup"
          ? `已移入「${name}」`
          : action.kind === "pin"
            ? "已置顶"
            : "已取消置顶",
  );
  if (!was) void poll(); // 新加的标的还没有行情，补一次
}

/**
 * 搜索结果右键菜单的标记类名：菜单里的点击不该把搜索结果收起来（「点别处收起」的监听据此放行）。
 * 只有搜索菜单挂这个标 —— 别的菜单（自选行、分组标题）被点掉时，搜索结果照旧收起。
 */
const SEARCH_MENU = "ctx-search";

function openResultMenu(id: string, x: number, y: number): void {
  openMenu(
    x,
    y,
    searchActions(S.groups, S.groupOf, S.watchlist, S.pins, id).map((a) => ({
      label: a.label,
      // 置顶 / 取消置顶 与自选行的右键菜单用同一对图标
      icon: a.kind === "pin" ? I.top : a.kind === "unpin" ? I.topOff : undefined,
      onPick: () => applyResultAction(id, a),
    })),
    { className: SEARCH_MENU },
  );
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
    if (!isDragging()) row.style.transform = ""; // 拖动中别动位移，否则被拖的那行会跳
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

// ---------- 设置页：MCP 卡片 ----------
// 状态与配置都来自 Rust 的 mcp_info 命令：桥只在应用运行时存在，拿不到就按「未运行 + 占位符」显示。

let mcpInfo: McpInfo | null = null;
let mcpCopyTimer: number | undefined;

function renderMcp(): void {
  const state = $("#mcp-state");
  const st = bridgeState(mcpInfo, S.mcp);
  state.classList.toggle("on", st.on);
  $("b", state).textContent = st.text;
  $<HTMLInputElement>("#mcp-on").checked = S.mcp;
  // 关掉时整块置灰：配置还能看、还能复制，只是不再是「生效中」的样子
  $("#mcp-box").classList.toggle("dim", !S.mcp);
  const script = mcpInfo?.script ?? null;
  $<HTMLElement>("#mcp-code").textContent = clientConfig(script);
  $<HTMLElement>("#mcp-hint").textContent = !S.mcp
    ? "MCP 已关闭：打开上面的开关后，AI 客户端才能改自选与分组。"
    : script
      ? "路径已指向应用自带的 mcp 服务脚本；StockBar 运行中才能改自选，改完界面与菜单栏立即同步。"
      : "把上面的路径换成你 clone 的仓库里的 mcp/stockbar-mcp.mjs；StockBar 运行中才能改自选，改完界面与菜单栏立即同步。";
}

async function loadMcp(): Promise<void> {
  mcpInfo = (await call<McpInfo>("mcp_info")) ?? null;
  renderMcp();
}

/**
 * 按设置开 / 关本地桥。命令直接返回开关之后的状态，一次往返就能刷新卡片。
 * 期间用户又拨了开关就以最新那次为准（结果回来时发现设置变了就丢掉）。
 */
async function applyMcp(): Promise<void> {
  const on = S.mcp;
  const info = await call<McpInfo>("mcp_set_enabled", { on });
  if (S.mcp !== on) return;
  mcpInfo = info ?? null;
  renderMcp();
}

/** 复制配置：WebView 里 clipboard API 可能被拒，退回「选中 + execCommand」 */
async function copyMcpConfig(): Promise<boolean> {
  const text = clientConfig(mcpInfo?.script ?? null);
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* 走下面的老办法 */
  }
  const pre = $("#mcp-code");
  const range = document.createRange();
  range.selectNodeContents(pre);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  }
}

// ---------- 关于页：版本与更新 ----------
// 检查、下载、安装都在 Rust 侧（src-tauri/src/update.rs）；这里只管文案、进度与按钮状态。

/** Rust 侧 DownloadEvent 的形状（见 update.rs；Channel 推过来的是驼峰字段） */
interface DownloadEvent {
  event: "started" | "progress" | "finished";
  data?: { contentLength?: number | null; chunkLength?: number };
}

let upVersion = "";
let upInfo: UpdateInfo | null = null;
let upPhase: Phase = "idle";
let upError = "";
let upDownloaded = 0;
let upTotal: number | null = null;
/** 检查 / 下载 / 安装期间置位：按钮全禁，免得点两次下两份 */
let upBusy = false;

function renderAbout(): void {
  const state = $("#up-state");
  const st = statusOf(upPhase, upInfo, upError);
  state.className = `up-state ${st.tone}`;
  $("b", state).textContent = st.text;
  $<HTMLInputElement>("#about-auto").checked = S.updateCheck;

  const version = upVersion || upInfo?.currentVersion;
  $<HTMLElement>("#about-version").textContent = version ? versionLabel(version) : "--";

  $<HTMLButtonElement>("#up-check").disabled = upBusy;
  // 有新版就露出「立即更新」；装失败后仍然露出 —— 待装的更新还在 Rust 那边，不必重新检查
  const install = $<HTMLButtonElement>("#up-install");
  install.hidden = !canInstall(upPhase, upInfo);
  install.disabled = upBusy;
  install.disabled = upBusy;

  // 进度条只在下载与安装阶段出现；总大小未知（服务器没给 Content-Length）时用不确定样式
  const running = upPhase === "downloading" || upPhase === "installing";
  $("#up-progress").hidden = !running;
  if (running) {
    const pct = progressPct(upDownloaded, upTotal);
    const fill = $("#up-fill");
    fill.classList.toggle("unknown", pct == null);
    // 总大小未知时清掉行内宽度，交给 .unknown 的动画样式
    fill.style.width = pct == null ? "" : `${pct}%`;
    $<HTMLElement>("#up-progress-text").textContent =
      upPhase === "installing" ? "下载完成，正在安装…" : progressText(upDownloaded, upTotal);
  }

  // 更新说明：有才显示，顺带报一句发布时间
  const notes = upInfo?.notes ?? "";
  $("#up-notes").hidden = !notes;
  if (notes) {
    const date = formatDate(upInfo?.date ?? null);
    const title = `${versionLabel(upInfo?.version ?? "")} 更新说明`;
    $<HTMLElement>("#up-notes-title").textContent = date ? `${title} · ${date}` : title;
    $<HTMLElement>("#up-notes-body").textContent = notes;
  }
}

/** 检查更新：失败原因要如实显示，所以用会抛错的 callOrThrow（call 会把错误吞掉） */
async function checkUpdate(): Promise<void> {
  if (upBusy) return;
  upBusy = true;
  upError = "";
  upPhase = "checking";
  renderAbout();
  try {
    upInfo = await callOrThrow<UpdateInfo>("update_check");
    upPhase = upInfo.available ? "available" : "latest";
  } catch (e) {
    upPhase = "error";
    upError = e instanceof Error ? e.message : String(e);
  } finally {
    upBusy = false;
    renderAbout();
  }
}

/** 下载并安装：进度走 Channel 推过来，装完直接重启（macOS 上不重启跑的还是旧版本） */
async function installUpdate(): Promise<void> {
  if (upBusy || !upInfo?.available) return;
  upBusy = true;
  upError = "";
  upDownloaded = 0;
  upTotal = null;
  upPhase = "downloading";
  renderAbout();
  const progress = new Channel<DownloadEvent>();
  progress.onmessage = (msg) => {
    if (msg.event === "started") {
      upTotal = msg.data?.contentLength ?? null;
    } else if (msg.event === "progress") {
      upDownloaded += msg.data?.chunkLength ?? 0;
    } else {
      upPhase = "installing";
    }
    renderAbout();
  };
  try {
    await callOrThrow<void>("update_install", { onEvent: progress });
    upPhase = "done";
    upBusy = false;
    renderAbout();
    await call("update_restart");
  } catch (e) {
    upBusy = false;
    upPhase = "error";
    upError = e instanceof Error ? e.message : String(e);
    renderAbout();
  }
}

/** 显示当前版本：不联网，窗口一打开就能看到（「启动时自动检查更新」关掉时也只做这一步） */
async function initAbout(): Promise<void> {
  if (upVersion) return;
  upVersion = (await call<string>("app_version")) ?? "";
  renderAbout();
}

/** 进「关于」页：先把版本号显示出来，再顺手查一次有没有新版 */
async function openAbout(): Promise<void> {
  await initAbout();
  if (!upBusy && (upPhase === "idle" || upPhase === "error")) void checkUpdate();
}
// ---------- 提醒页 ----------
// 规则的判定在 alerts.ts（纯逻辑），由主面板按刷新循环判定并弹通知；
// 这一页只管把规则写进设置、以及把「系统通知到底能不能发」说清楚。

/** 新建表单里正在填的那条：条件种类与方向（不写进设置，点「添加规则」才落） */
let alertDraftKind: AlertKind = "price";
let alertDraftOp: AlertOp = "below";
let alertPermOk = false;
let alertPermBusy = false;
/** 两处列表的重建键：内容没变就不重画（每几秒一轮轮询都会走到 render()） */
let alertListKey = "";
let alertTargetsKey = "";

/** 条件与方向的文案：价格说上穿 / 跌破，涨跌幅说涨超 / 跌超 */
const OP_NAME: Record<AlertKind, Record<AlertOp, string>> = {
  price: { above: "上穿", below: "跌破" },
  pct: { above: "涨超", below: "跌超" },
};

/** 标的名：报价里认得出就用它，否则退回内置指数名 / 代码 */
function alertName(secid: string): string {
  return quotes.get(secid)?.name ?? INDICES.find((it) => it.secid === secid)?.name ?? codeOf(secid);
}

/** 能设提醒的标的：大盘指数 + 自选（板块不是标的，见 docs/adr/0001） */
function alertTargetIds(): string[] {
  return [...INDICES.map((it) => it.secid), ...S.watchlist];
}

function renderAlertTargets(): void {
  const sel = $<HTMLSelectElement>("#alert-target");
  const keep = sel.value;
  sel.innerHTML =
    `<optgroup label="大盘指数">` +
    INDICES.map((it) => `<option value="${esc(it.secid)}">${esc(it.name)}</option>`).join("") +
    `</optgroup>` +
    (S.watchlist.length
      ? `<optgroup label="自选">` +
        S.watchlist
          .map((id) => `<option value="${esc(id)}">${esc(alertName(id))}（${esc(codeOf(id))}）</option>`)
          .join("") +
        `</optgroup>`
      : "");
  // 刚才选的那只还在就留住，否则回落到第一项（别让表单指着一只已经删掉的标的）
  const ids = alertTargetIds();
  sel.value = ids.includes(keep) ? keep : (ids[0] ?? "");
}

function alertRow(a: Alert): string {
  return `
    <div class="alert-item${a.enabled ? "" : " off"}" data-id="${esc(a.id)}">
      <div class="alert-main">
        <b>${esc(alertName(a.secid))}</b>
        <small><span class="tag">${marketTag(a.secid)}</span>${esc(codeOf(a.secid))}</small>
      </div>
      <span class="alert-cond">${esc(alertLabel(a))}</span>
      <label class="switch"><input type="checkbox" data-on="${esc(a.id)}"${a.enabled ? " checked" : ""} aria-label="启用 ${esc(alertLabel(a))}" /><i></i></label>
      <button class="alert-del" data-del="${esc(a.id)}" title="删除规则" aria-label="删除规则">
        <svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>`;
}

function renderAlertList(): void {
  $("#alert-count").textContent = S.alerts.length ? `${S.alerts.length} 条` : "";
  $("#alert-list").innerHTML = S.alerts.length
    ? S.alerts.map((a) => alertRow(a)).join("")
    : `<div class="alert-empty">还没有规则。选一只标的、填个阈值，触及条件时会收到一条系统通知。</div>`;
}

function renderAlertPerm(): void {
  const el = $("#alerts-perm");
  el.textContent = alertPermOk ? "已授权" : "未授权";
  el.classList.toggle("on", alertPermOk);
  $<HTMLButtonElement>("#alerts-perm-btn").disabled = alertPermOk || alertPermBusy;
  $<HTMLButtonElement>("#alerts-test").disabled = !alertPermOk;
}

/** 问一次权限状态：进页面、刚发过通知时都可能需要重问（用户也可能刚去系统设置里改过） */
async function syncAlertPerm(): Promise<void> {
  alertPermOk = await notifyGranted();
  renderAlertPerm();
}

/** 请求授权：第一次会弹系统窗；之后系统不再问，只能去系统设置里改 */
async function askAlertPerm(): Promise<void> {
  if (alertPermBusy) return;
  alertPermBusy = true;
  renderAlertPerm();
  alertPermOk = await requestNotify();
  alertPermBusy = false;
  renderAlertPerm();
  if (!alertPermOk) alertFormHint("系统没有给出权限：去「系统设置 › 通知 › StockBar」里打开");
}

function alertFormHint(text: string): void {
  $("#alert-form-hint").textContent = text;
}

function addAlert(): void {
  const secid = $<HTMLSelectElement>("#alert-target").value;
  if (!secid) return alertFormHint("先选一只标的");
  const raw = Number($<HTMLInputElement>("#alert-value").value);
  const value = clampAlertValue(alertDraftKind, raw);
  if (value == null) {
    return alertFormHint(
      alertDraftKind === "pct" ? "填 0.1 到 50 之间的百分比" : "填一个大于 0 的价格",
    );
  }
  const a = newAlert(S.alerts, secid, alertDraftKind, alertDraftOp, value);
  S.alerts = [...S.alerts, a];
  $<HTMLInputElement>("#alert-value").value = "";
  commit();
  alertFormHint(`已添加：${alertName(secid)} ${alertLabel(a)}`);
}

function renderAlerts(): void {
  $<HTMLInputElement>("#alerts-on").checked = S.alertsOn;
  // 条件种类与方向的按钮文案跟着种类走；单价 / 百分比只差一个单位与步进
  setSeg("#seg-alert-kind", alertDraftKind);
  setSeg("#seg-alert-op", alertDraftOp);
  $("#alert-op-below").textContent = OP_NAME[alertDraftKind].below;
  $("#alert-op-above").textContent = OP_NAME[alertDraftKind].above;
  $("#alert-unit").textContent = alertDraftKind === "pct" ? "%" : "元";
  $<HTMLInputElement>("#alert-value").step = alertDraftKind === "pct" ? "0.1" : "0.01";
  renderAlertPerm();

  // 标的名来自报价，报价还没到之前是代码 —— 名字进了键，所以名字到了会重画一次
  const targetsKey = alertTargetIds()
    .map((id) => `${id}:${alertName(id)}`)
    .join("|");
  if (targetsKey !== alertTargetsKey) {
    alertTargetsKey = targetsKey;
    renderAlertTargets();
  }
  const listKey = `${S.alerts.map((a) => `${a.id}:${a.kind}:${a.op}:${a.value}:${a.enabled ? 1 : 0}:${alertName(a.secid)}`).join(",")}|${targetsKey}`;
  if (listKey !== alertListKey) {
    alertListKey = listKey;
    renderAlertList();
  }
}
// 提醒页的交互：总开关、权限、测试通知、新建表单、规则列表
$("#alerts-on").addEventListener("change", (e) => {
  S.alertsOn = (e.target as HTMLInputElement).checked;
  commit();
  // 刚打开提醒却还没授权，通知会一条都发不出去：顺手问一次
  if (S.alertsOn && !alertPermOk) void askAlertPerm();
});

$("#alerts-perm-btn").addEventListener("click", () => void askAlertPerm());

$("#alerts-test").addEventListener("click", async () => {
  const ok = await sendNotify("StockBar 测试通知", "能看到这条，就说明提醒能送到你面前。");
  alertFormHint(ok ? "已发出一条测试通知" : "没发出去：系统通知权限没给");
  void syncAlertPerm();
});

$("#seg-alert-kind").addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.v as AlertKind | undefined;
  if (!v || v === alertDraftKind) return;
  alertDraftKind = v;
  $<HTMLInputElement>("#alert-value").value = "";
  alertFormHint("");
  renderAlerts();
});

$("#seg-alert-op").addEventListener("click", (e) => {
  const v = (e.target as HTMLElement).closest<HTMLElement>("button")?.dataset.v as AlertOp | undefined;
  if (!v || v === alertDraftOp) return;
  alertDraftOp = v;
  renderAlerts();
});

$("#alert-add").addEventListener("click", addAlert);
$<HTMLInputElement>("#alert-value").addEventListener("keydown", (e) => {
  if (e.key === "Enter") addAlert();
});

// 规则列表：勾选即启用 / 停用，× 删除（两条都改同一份 S.alerts，存完广播给主面板）
$("#alert-list").addEventListener("change", (e) => {
  const input = e.target as HTMLInputElement;
  const id = input.dataset.on;
  if (!id) return;
  S.alerts = S.alerts.map((a) => (a.id === id ? { ...a, enabled: input.checked } : a));
  commit();
});

$("#alert-list").addEventListener("click", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>(".alert-del")?.dataset.del;
  if (!id) return;
  const gone = S.alerts.find((a) => a.id === id);
  S.alerts = S.alerts.filter((a) => a.id !== id);
  commit();
  if (gone) alertFormHint(`已删除：${alertName(gone.secid)} ${alertLabel(gone)}`);
});
// ---------- 交互 ----------

function go(p: Page): void {
  if (page === p) return;
  page = p;
  history.replaceState(null, "", `#${p}`);
  render();
  // 切到 MCP 页时顺手问一次桥状态：应用刚起来那会儿可能还没就绪
  // 切到 MCP 页时顺手问一次桥状态：应用刚起来那会儿可能还没就绪
  if (p === "mcp") void loadMcp();
  // 切到「提醒」页时问一次通知权限：用户可能刚在系统设置里改过，界面上的状态要跟着走
  if (p === "alerts") void syncAlertPerm();
  // 切到「关于」页时顺手查一次更新，用户点进来多半就是想看有没有新版
  // 切到「关于」页时顺手查一次更新，用户点进来多半就是想看有没有新版
  if (p === "about") void openAbout();
}

$(".nav").addEventListener("click", (e) => {
  const p = (e.target as HTMLElement).closest<HTMLElement>(".nav-item")?.dataset.page as Page | undefined;
  if (p) go(p);
});

$("#mcp-copy").addEventListener("click", async (e) => {
  const btn = e.currentTarget as HTMLButtonElement;
  const ok = await copyMcpConfig();
  btn.textContent = ok ? "已复制" : "复制失败，请手动选中";
  window.clearTimeout(mcpCopyTimer);
  mcpCopyTimer = window.setTimeout(() => (btn.textContent = "复制配置"), 1800);
});

// MCP 开关：先落设置（卡片立刻变成「已关闭 / 检测中」），再让 Rust 开 / 关桥
$("#mcp-on").addEventListener("change", (e) => {
  S.mcp = (e.target as HTMLInputElement).checked;
  commit();
  void applyMcp();
});

// 关于页：检查更新 / 立即更新 / 打开发布页，以及「启动时自动检查更新」开关
$("#up-check").addEventListener("click", () => void checkUpdate());
$("#up-install").addEventListener("click", () => void installUpdate());
$("#up-page").addEventListener("click", () => void call("open_release_page"));
$("#about-auto").addEventListener("change", (e) => {
  S.updateCheck = (e.target as HTMLInputElement).checked;
  commit();
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
  const dragged = marketSwallow.take;
  marketSwallow.take = false;
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
    ...groupMenuItems(id),
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
          {
            label: S.pins.includes(id) ? "取消置顶" : "置顶",
            icon: S.pins.includes(id) ? I.topOff : I.top,
            onPick: () => togglePin(id),
          },
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
  // 批量移入分组：大盘指数不分堆，只把选中的自选交出去
  if (act === "group") return batchGroup(ids.filter((id) => S.watchlist.includes(id)), e.clientX, e.clientY);
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
  // 内置的大盘指数一直显示在「行情」页的指数区，不能再加一份进自选（与 MCP、右键菜单同一条规则）
  if (isIndex(id)) return hint("大盘指数不能加入自选");
  S.watchlist = [...S.watchlist, id];
  addInput.value = "";
  closeAdd();
  commit();
  hint("已加入自选");
  void poll();
});

// 搜索结果行右键：加入自选 / 加入并移入分组 / 移入分组 / 置顶（与自选行的右键菜单同一套 ctxmenu）
addResults.addEventListener("contextmenu", (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>(".sr")?.dataset.id;
  if (!id) return;
  e.preventDefault();
  openResultMenu(id, e.clientX, e.clientY);
});

// 点别处收起结果；但搜索菜单里的点击不算「点别处」—— 右键连着做几步（加入、再置顶）时
// 结果列表要留着，刚加入的那一行才好当场变成「已添加」。别的菜单不属于搜索，点它就照旧收起。
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  if (t.closest(".add-box") || t.closest(`.${SEARCH_MENU}`)) return;
  closeAdd();
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
  } else if (e.key === "Escape") {
    // 先收拾删除确认，再管多选
    if (groupConfirm) cancelDeleteConfirm();
    else if (picked.size) clearPick();
  }
});

// ---------- 拖动排序（仪表盘「菜单栏显示」、行情页「自选 / 分组胶囊」共用 ./sortable） ----------
// 仪表盘：拖动调整菜单栏显示的顺序
const ordList = $("#ord-list");
sortable({
  list: ordList,
  row: ".ord",
  handle: ".ord-handle",
  rowDrag: true,
  movable: () => S.bar.length > 1,
  apply: (from, to) => {
    S.bar = moveItem(S.bar, from, to);
    commit();
  },
  render: renderOrder,
});

/** 刚拖完胶囊的时间：松手后跟来的那一下 click 不该当成「点胶囊跳分组」（判定见 tabs.ts） */
let chipDraggedAt = 0;

// 行情页：分组胶囊横排拖动即可调整分组顺序（顺序 = 区块顺序 = 主面板筛选条的顺序）。
// 胶囊容器是静态的，模块初始化时注册一次就够 —— 胶囊内容随分组重建（见 renderChips），
// 拖动实例挂在容器上，重建不影响它。
sortable({
  list: $("#gchip-list"),
  row: ".gchip",
  ident: "gid",
  handle: ".gchip", // 整颗胶囊就是把手：横排里没地方再放一个把手
  rowDrag: true,
  axis: "x",
  movable: () => S.groups.length > 1,
  apply: (from, to) => {
    chipDraggedAt = Date.now(); // 真的换了位：接下来那一下 click 算拖动的尾巴
    const g = S.groups[from];
    if (g) moveGroupTo(g.id, to);
  },
  render: renderMarket,
});

/** 跳转后的高亮计时器 */
let flashTimer: number | undefined;
/** 点胶囊把对应分组带进视野并闪一下：分组多了以后，这排胶囊就是分组的目录 */
function scrollToGroup(gid: string): void {
  const head = document.querySelector<HTMLElement>(`.gsec-head[data-gid="${gid}"]`);
  if (!head) return;
  head.scrollIntoView({
    block: "center",
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
  });
  head.classList.remove("flash");
  void head.offsetWidth; // 动画要重播，先强制一次重排
  head.classList.add("flash");
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => head.classList.remove("flash"), 1200);
}

// 点胶囊跳到对应分组；拖动松手后跟来的那一下 click 不算（判定与主面板筛选条同一套，见 tabs.ts）
$("#gchips").addEventListener("click", (e) => {
  const dragged = isDragClick(chipDraggedAt, Date.now());
  chipDraggedAt = 0;
  if (dragged) return;
  const gid = (e.target as HTMLElement).closest<HTMLElement>(".gchip")?.dataset.gid;
  if (gid === undefined) return;
  scrollToGroup(gid);
});

// 行情页：每个分组区块各自注册拖动（见 renderGroups）—— 区块随分组增减重建，
// 所以不能像仪表盘这样在模块初始化时注册一次。
//
// 分组本身的操作（新建 / 改名 / 排序 / 删除）走右键菜单，见下面的「行情页：分组操作」。

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
// 提醒页要靠系统通知的权限状态：启动就问一次（浏览器预览里它恒为未授权，正好看见提示）
void syncAlertPerm();
tickClock();
window.setInterval(tickClock, 15_000);
void poll();
schedulePoll();
void loadMcp();
void initAbout();
// 主面板发现新版本时会要求直接打开「关于」页：窗口已经开着就走事件，刚建好的走 settings_ready
void listenAll<unknown>("goto-page", (p) => {
  if (isPage(p)) go(p);
});
void call<unknown>("settings_ready").then((p) => {
  if (isPage(p)) go(p);
});
