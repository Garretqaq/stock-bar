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

/** 未分组：它也是一个「分组」，但不占 groups 里的位置，用空 id 表示 */
export const UNGROUPED = "";
/** 分组名长度上限（新建、改名与载入都按这个截断） */
export const GROUP_NAME_MAX = 12;

/** 自选分组：只负责把自选列表分堆，不影响菜单栏显示 */
export interface Group {
  /** 稳定短 id（新建时生成，与名字无关：改名不丢归属） */
  id: string;
  name: string;
}

export interface Settings {
  watchlist: string[];
  /** 自选分组（有序）；未分组不在其中，见 UNGROUPED */
  groups: Group[];
  /** 每只自选所在的分组：secid → 分组 id；没有条目的就是未分组 */
  groupOf: Record<string, string>;
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
  /** 允许外部 MCP 客户端（AI 客户端）改自选与分组：关掉后本地桥不监听，端口与连接信息文件都不在 */
  mcp: boolean;
  /** 启动时自动检查更新（只在发现新版本时提示，不会自己下载安装） */
  updateCheck: boolean;
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

// ---------- 自选分组 ----------
// 分组只是自选列表的分堆方式：整表顺序（watchlist）仍是一份，
// 菜单栏（bar）与置顶（pins）都不受分组影响。

/** 分组 id 的合法形状：合法才能安全地拼进选择器与存储 */
const GROUP_ID_RE = /^[A-Za-z0-9_-]{1,24}$/;

/** 标的当前在哪个分组：没归属、分组已被删都算未分组 */
export function groupIdOf(groupOf: Record<string, string>, groups: Group[], id: string): string {
  const gid = groupOf[id];
  return gid && groups.some((g) => g.id === gid) ? gid : UNGROUPED;
}

/** 某个分组里的自选，顺序仍按整表顺序；未分组传 UNGROUPED */
export function itemsOf(list: string[], groupOf: Record<string, string>, groups: Group[], gid: string): string[] {
  return list.filter((id) => groupIdOf(groupOf, groups, id) === gid);
}

/** 分组显示名：未分组与分组已被删的情况都回落到「未分组」 */
export function groupNameOf(groups: Group[], gid: string): string {
  return groups.find((g) => g.id === gid)?.name ?? "未分组";
}

/**
 * 在分组视图里拖动：可见列表里的 from→to 换算成整表下标再移动。
 * 整表顺序是一份，所以分组视图内的先后就体现在整表里的相对先后。
 */
export function moveInView(list: string[], view: string[], from: number, to: number): string[] {
  return moveItem(list, list.indexOf(view[from] ?? ""), list.indexOf(view[to] ?? ""));
}

/** 把标的移入某个分组；目标是未分组时删掉它的归属 */
export function setGroup(groupOf: Record<string, string>, id: string, gid: string): Record<string, string> {
  const next = { ...groupOf };
  if (gid) next[id] = gid;
  else delete next[id];
  return next;
}

/** 批量移入分组；目标是未分组时删掉这些标的的归属 */
export function setGroupMany(
  groupOf: Record<string, string>,
  ids: string[],
  gid: string,
): Record<string, string> {
  const next = { ...groupOf };
  for (const id of ids) {
    if (gid) next[id] = gid;
    else delete next[id];
  }
  return next;
}

/** 清掉一批标的的分组归属（删除自选时用） */
export function dropGroupOf(groupOf: Record<string, string>, ids: string[]): Record<string, string> {
  const next = { ...groupOf };
  ids.forEach((id) => delete next[id]);
  return next;
}

/** 可以把标的移入哪些分组（不含它当前所在的那个，含未分组） */
export function groupTargets(
  groups: Group[],
  groupOf: Record<string, string>,
  id: string,
): { gid: string; name: string }[] {
  const cur = groupIdOf(groupOf, groups, id);
  return [
    { gid: UNGROUPED, name: "未分组" },
    ...groups.map((g) => ({ gid: g.id, name: g.name })),
  ].filter((t) => t.gid !== cur);
}

/** 分组名规整：去掉首尾空白，按「字符」截断（按码点切，免得把 emoji 劈成半个） */
export function trimGroupName(name: string): string {
  return [...name.trim()].slice(0, GROUP_NAME_MAX).join("");
}

/**
 * 一批标的能移入哪些分组：已经全在该分组的记 done（界面上置灰）。
 * 一个可用目标都没有时（没建过分组、选的又都是未分组）就不该给入口。
 */
export function groupTargetsFor(
  groups: Group[],
  groupOf: Record<string, string>,
  ids: string[],
): { gid: string; name: string; done: boolean }[] {
  if (!ids.length) return [];
  return [
    { gid: UNGROUPED, name: "未分组" },
    ...groups.map((g) => ({ gid: g.id, name: g.name })),
  ].map((t) => ({ ...t, done: ids.every((id) => groupIdOf(groupOf, groups, id) === t.gid) }));
}

// ---------- 搜索结果：右键能做什么 ----------

/** 搜索结果行右键的动作：加入自选 / 加入并移入分组 / 移入分组 / 置顶 */
export type SearchActionKind = "add" | "addToGroup" | "moveToGroup" | "pin" | "unpin";

export interface SearchAction {
  kind: SearchActionKind;
  /** 菜单文案 */
  label: string;
  /** addToGroup / moveToGroup 的目标分组（未分组是 UNGROUPED） */
  gid?: string;
}

/**
 * 搜索结果行的右键菜单项（按顺序），主面板与设置窗口共用：
 * - 结果还不是自选：先给「加入自选」；建过分组时再给每个分组一项「加入并移入「X」」，
 *   省掉「先加入、再右键一次移入」的两步（「未分组」就是「加入自选」，不重复出现）。
 * - 结果已经是自选：它当前所在分组之外的每个分组一项「移入「X」」，外加置顶 / 取消置顶。
 * - 内置的大盘指数没有菜单：它们一直显示在主面板与「行情」页的指数区，不接受增删
 *   （与 MCP 的 add 同一条规则），也就谈不上分组与置顶。
 *
 * 只算「有哪些项」，执行交给调用方 —— 两个窗口改设置的方式不同。
 */
export function searchActions(
  groups: Group[],
  groupOf: Record<string, string>,
  watchlist: string[],
  pins: string[],
  id: string,
): SearchAction[] {
  if (isIndex(id)) return [];
  if (!watchlist.includes(id)) {
    return [
      { kind: "add", label: "加入自选" },
      ...groups.map((g) => ({ kind: "addToGroup" as const, gid: g.id, label: `加入并移入「${g.name}」` })),
    ];
  }
  return [
    ...groupTargets(groups, groupOf, id).map((t) => ({
      kind: "moveToGroup" as const,
      gid: t.gid,
      label: `移入「${t.name}」`,
    })),
    pins.includes(id)
      ? { kind: "unpin" as const, label: "取消置顶" }
      : { kind: "pin" as const, label: "置顶" },
  ];
}

/**
 * 执行一条搜索结果动作，返回改动后的 watchlist / pins / groupOf（不改入参）。
 * 加入自选与既有路径一致：追加到自选末尾。
 * 菜单是点开那一刻渲染的，点下去之前设置可能已经变了，所以这里再挡一次：
 * 指数不加（与 MCP 同一条规则）；「移入分组」只作用于还在自选里的标的（否则会留下一条
 * 指向已删自选的归属，那东西 `normalizeGroups()` 只在载入时清）；目标分组已被删就按未分组处理。
 */
export function applySearchAction(
  state: { watchlist: string[]; pins: string[]; groupOf: Record<string, string> },
  groups: Group[],
  id: string,
  action: SearchAction,
): { watchlist: string[]; pins: string[]; groupOf: Record<string, string> } {
  const next = {
    watchlist: [...state.watchlist],
    pins: [...state.pins],
    groupOf: { ...state.groupOf },
  };
  if (isIndex(id)) return next;
  /** 目标分组：只有还存在的分组才认得，其余（未分组 / 已删的分组）都当未分组 */
  const gid = action.gid && groups.some((g) => g.id === action.gid) ? action.gid : UNGROUPED;
  switch (action.kind) {
    case "add":
    case "addToGroup":
      if (!next.watchlist.includes(id)) next.watchlist.push(id);
      if (action.kind === "addToGroup") next.groupOf = setGroup(next.groupOf, id, gid);
      break;
    case "moveToGroup":
      if (next.watchlist.includes(id)) next.groupOf = setGroup(next.groupOf, id, gid);
      break;
    case "pin": {
      const r = pinItem(next.watchlist, next.pins, id);
      next.watchlist = r.list;
      next.pins = r.pins;
      break;
    }
    case "unpin": {
      const r = unpinItem(next.watchlist, next.pins, id);
      next.watchlist = r.list;
      next.pins = r.pins;
      break;
    }
  }
  return next;
}

/**
 * 新建分组：id 取已有 gN 里最大的 N +1。
 * 删掉最大的那个序号后会被再次用到，所以删除分组必须同时清掉归属（`removeGroup` 会做）。
 */
export function newGroup(groups: Group[], base = "新分组"): Group {
  let n = 1;
  for (const g of groups) {
    const m = /^g(\d+)$/.exec(g.id);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  const used = new Set(groups.map((g) => g.name));
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base} ${i}`;
  return { id: `g${n}`, name: trimGroupName(name) };
}

/** 改名：去掉首尾空白并按上限截断；空名字视为放弃，原样返回副本 */
export function renameGroup(groups: Group[], gid: string, name: string): Group[] {
  const next = trimGroupName(name);
  if (!next) return [...groups];
  return groups.map((g) => (g.id === gid ? { ...g, name: next } : g));
}

/** 删除分组：成员回落到未分组（自选一只都不少） */
export function removeGroup(
  groups: Group[],
  groupOf: Record<string, string>,
  gid: string,
): { groups: Group[]; groupOf: Record<string, string> } {
  const next: Record<string, string> = {};
  for (const [id, g] of Object.entries(groupOf)) if (g !== gid) next[id] = g;
  return { groups: groups.filter((g) => g.id !== gid), groupOf: next };
}

/** 载入 / 外部写入后的规整：丢掉形状不对的分组、指向不存在分组的归属 */
export function normalizeGroups(
  list: string[],
  groups: unknown,
  groupOf: unknown,
): { groups: Group[]; groupOf: Record<string, string> } {
  const out: Group[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(groups) ? groups : []) {
    const g = raw as Partial<Group> | null | undefined;
    const id = typeof g?.id === "string" ? g.id : "";
    const name = typeof g?.name === "string" ? trimGroupName(g.name) : "";
    if (!GROUP_ID_RE.test(id) || !name || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name });
  }
  const map: Record<string, string> = {};
  const raw2 = groupOf && typeof groupOf === "object" && !Array.isArray(groupOf) ? groupOf : {};
  for (const [id, gid] of Object.entries(raw2 as Record<string, unknown>)) {
    if (typeof gid === "string" && seen.has(gid) && list.includes(id)) map[id] = gid;
  }
  return { groups: out, groupOf: map };
}

export const DEFAULTS: Settings = {
  groups: [],
  groupOf: {},
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
  mcp: false,
  updateCheck: true,
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
  // 自选分组：旧数据没有这两个字段（或写坏了）时规整成「没有分组」
  const grouped = normalizeGroups(s.watchlist, raw.groups, raw.groupOf);
  s.groups = grouped.groups;
  s.groupOf = grouped.groupOf;
  if (!s.barFields?.length) s.barFields = [...DEFAULTS.barFields];
  // 旧数据没有 source（或值写坏了）时回到「自动」，别让界面出现空档
  if (s.source !== "auto" && s.source !== "eastmoney" && s.source !== "tencent") {
    s.source = DEFAULTS.source;
  }
  // MCP 开关：旧数据没有这个字段（或写坏了）时按默认「关闭」—— 本地桥是可选功能，
  // 默认不开；要用的人去设置窗口的 MCP 页打开一次，开关状态之后就存在设置里了
  if (typeof raw.mcp !== "boolean") s.mcp = DEFAULTS.mcp;
  // 更新检查开关：旧数据没有这个字段（或写坏了）时按默认「开启」，别让用户收不到新版本
  if (typeof raw.updateCheck !== "boolean") s.updateCheck = DEFAULTS.updateCheck;
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
