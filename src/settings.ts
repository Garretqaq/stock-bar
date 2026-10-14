// 主面板与设置窗口共享的设置：同源 localStorage 存储；
// 跨窗口同步同时走 Tauri 事件与 `storage` 事件，任一生效即可（重复触发是幂等的）

import type { DataSource } from "./api";

import { IS_WIN, emitAll, listenAll } from "./tauri";

const EVENT = "settings-changed";
/** 本窗口标识，忽略自己发出的广播 */
const TOKEN = Math.random().toString(36).slice(2);

export type Theme = "system" | "light" | "dark";
/** 菜单栏样式：单行文字 / 双行紧凑 / 仅图标 */
export type BarStyle = "text" | "compact" | "icon";
/** 菜单栏每只股票显示的字段 */
export type BarField = "name" | "price" | "pct";

export interface Settings {
  watchlist: string[];
  /** 置顶的自选（id）：这些排在自选列表最前，拖动也不会被挤下去 */
  pins: string[];
  selected: string;
  /** 显示在菜单栏上的股票（有序） */
  bar: string[];
  barStyle: BarStyle;
  barFields: BarField[];
  /** 菜单栏文字是否按涨跌着色（仅双行紧凑样式生效） */
  barColor: boolean;
  interval: number; // 秒
  greenUp: boolean; // true = 绿涨红跌
  /** 行情数据源：自动降级 / 只用东方财富 / 只用腾讯 */
  source: DataSource;
  theme: Theme;
  /** Windows：显示桌面悬浮行情条（托盘无法显示文字时的替代） */
  ticker: boolean;
}

export const STORE_KEY = "stockbar.settings.v1";

/** 大盘指数：主面板卡片与菜单栏可选项共用 */
export const INDICES: { secid: string; name: string }[] = [
  { secid: "1.000001", name: "上证指数" },
  { secid: "0.399001", name: "深证成指" },
  { secid: "0.399006", name: "创业板指" },
];
export const isIndex = (id: string) => INDICES.some((it) => it.secid === id);
export const BAR_MAX = 3;

/**
 * 批量加入菜单栏：按传入顺序填满剩余名额。
 * 已在菜单栏里的标的直接跳过（不算放不下）；名额满了的记进 overflow。
 */
export function addToBar(
  bar: string[],
  ids: string[],
  max = BAR_MAX,
): { bar: string[]; added: string[]; overflow: string[] } {
  const next = [...bar];
  const added: string[] = [];
  const overflow: string[] = [];
  for (const id of ids) {
    if (next.includes(id)) continue;
    if (next.length >= max) overflow.push(id);
    else {
      next.push(id);
      added.push(id);
    }
  }
  return { bar: next, added, overflow };
}

/** 把 from 处的元素移到 to 处；越界或原地不动时返回原列表的副本 */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  const next = [...list];
  if (from === to || from < 0 || to < 0 || from >= next.length || to >= next.length) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

/** 置顶区长度：自选列表开头连续被置顶的只数（置顶的只会排在最前） */
export function pinCount(list: string[], pins: string[]): number {
  let n = 0;
  while (n < list.length && pins.includes(list[n])) n++;
  return n;
}

/** 把置顶的排到最前、其余按原顺序跟在后面；pins 里已不在自选中的 id 丢掉 */
export function normalizePins(list: string[], pins: string[]): { list: string[]; pins: string[] } {
  const keep = pins.filter((id) => list.includes(id));
  return {
    list: [...list.filter((id) => keep.includes(id)), ...list.filter((id) => !keep.includes(id))],
    pins: keep,
  };
}

/** 置顶：挪到自选最前 */
export function pinItem(list: string[], pins: string[], id: string): { list: string[]; pins: string[] } {
  if (!list.includes(id) || pins.includes(id)) return { list: [...list], pins: [...pins] };
  return { list: [id, ...list.filter((x) => x !== id)], pins: [...pins, id] };
}

/** 取消置顶：落到置顶区之后的第一位（尽量少挪） */
export function unpinItem(list: string[], pins: string[], id: string): { list: string[]; pins: string[] } {
  if (!pins.includes(id)) return { list: [...list], pins: [...pins] };
  const next = list.filter((x) => x !== id);
  next.splice(pinCount(next, pins), 0, id);
  return { list: next, pins: pins.filter((x) => x !== id) };
}

/** 拖动落点：置顶的只能在置顶区里挪，其余只能在置顶区之后挪 */
export function clampBlock(list: string[], pins: string[], from: number, to: number): number {
  const n = pinCount(list, pins);
  const pinned = from < n;
  return Math.min(Math.max(to, pinned ? 0 : n), pinned ? Math.max(n - 1, 0) : Math.max(list.length - 1, 0));
}

export const DEFAULTS: Settings = {
  watchlist: ["1.600519", "0.300750", "116.00700", "105.NVDA", "105.AAPL"],
  pins: [],
  selected: "1.600519",
  bar: ["1.600519"],
  barStyle: "text",
  barFields: ["name", "price", "pct"],
  barColor: true,
  interval: 5,
  greenUp: false,
  source: "auto",
  theme: "system",
  ticker: true,
};

export function loadSettings(): Settings {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}") ?? {};
  } catch {
    /* 损坏的存储按默认值处理 */
  }
  const s = { ...DEFAULTS, ...raw } as Settings & { pinned?: string | null };
  // 迁移旧版单只 pinned → bar 列表（只在旧数据里确实有 pinned 时迁移，新用户保留默认值）
  if (!Array.isArray(raw.bar)) s.bar = "pinned" in raw ? (s.pinned ? [s.pinned] : []) : [...DEFAULTS.bar];
  delete s.pinned;
  s.bar = s.bar.filter((id) => isIndex(id) || s.watchlist.includes(id)).slice(0, BAR_MAX);

  // 置顶的排到最前（旧数据或别处写入可能乱序）；pins 里已不在自选的 id 丢掉
  const pinned = normalizePins(s.watchlist, Array.isArray(s.pins) ? s.pins : []);
  s.watchlist = pinned.list;
  s.pins = pinned.pins;
  if (!s.barFields?.length) s.barFields = [...DEFAULTS.barFields];
  // 旧数据没有 source（或值写坏了）时回到「自动」，别让界面出现空档
  if (s.source !== "auto" && s.source !== "eastmoney" && s.source !== "tencent") {
    s.source = DEFAULTS.source;
  }
  return s;
}

export function saveSettings(s: Settings): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(s));
  void emitAll(EVENT, { from: TOKEN });
}

/** 另一个窗口改了设置时回调（本窗口自己的写入不会触发） */
export function onSettingsChange(fn: (s: Settings) => void): void {
  window.addEventListener("storage", (e) => {
    if (e.key === STORE_KEY) fn(loadSettings());
  });
  void listenAll<{ from?: string }>(EVENT, (p) => {
    if (p?.from !== TOKEN) fn(loadSettings());
  });
}

/** 主题 + 涨跌配色写到 <html> 上，CSS 变量据此切换 */
export function applyAppearance(s: Settings): void {
  const root = document.documentElement;
  root.classList.toggle("green-up", s.greenUp);
  root.classList.toggle("win", IS_WIN);
  root.dataset.theme = s.theme;
  root.style.colorScheme = s.theme === "system" ? "light dark" : s.theme;
}

export function isDark(s: Settings): boolean {
  return s.theme === "dark" || (s.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
}

/** 悬浮行情条位置（物理像素）。单独存一个 key：拖动时频繁写入，不应触发设置同步广播 */
const TICKER_POS_KEY = "stockbar.ticker.pos";
export function loadTickerPos(): { x: number; y: number } | null {
  try {
    const p = JSON.parse(localStorage.getItem(TICKER_POS_KEY) ?? "null");
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: Math.round(p.x), y: Math.round(p.y) } : null;
  } catch {
    return null;
  }
}
export function saveTickerPos(x: number, y: number): void {
  localStorage.setItem(TICKER_POS_KEY, JSON.stringify({ x, y }));
}
