// MCP 本地桥的命令处理：外部 MCP 客户端（mcp/stockbar-mcp.mjs）发来的命令在这里落成对 Settings 的修改。
// 本文件只做纯逻辑，外加注入进来的「搜索 / 报价」两个依赖：网络与持久化由调用方（主面板）负责。
// 界面与 MCP 因此走的是同一套校验与规整规则，不存在两份实现。
//
// 一条命令分两段：
//   1. prepareCommand()：异步部分 —— 搜标的、拉报价、确认成员在不在自选里；
//   2. pending.apply(latest)：同步部分 —— 在「调用那一刻最新」的设置上算出新设置。
// 分开是因为第 1 段可能联网好几秒，其间设置窗口可能已经改过设置：拿旧快照整份覆盖会把这些改动弄丢。

import { SUPPORTED_MARKETS, type Quote, type SearchItem } from "./api";
import {
  BAR_MAX,
  INDICES,
  UNGROUPED,
  clampBlock,
  dropGroupOf,
  groupNameOf,
  isIndex,
  itemsOf,
  moveItem,
  newGroup,
  normalizePins,
  pinItem,
  removeGroup,
  renameGroup,
  setGroupMany,
  trimGroupName,
  unpinItem,
  type Group,
  type Settings,
} from "./settings";

/** MCP 客户端送进来的东西一律当作不可信：命令处理里拒绝的一切都用这个错误，消息原样回给客户端 */
export class McpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpError";
  }
}

/** 外部依赖：搜索标的、批量报价。由主面板注入 api.ts 的实现，测试里注入桩 */
export interface McpDeps {
  search(keyword: string): Promise<SearchItem[]>;
  quotes(secids: string[]): Promise<Map<string, Quote>>;
}

export interface McpResult {
  /** 命令跑完之后的设置（没改动时就是传进来的那份） */
  settings: Settings;
  /** 是否真的改了设置：没改就不用保存与重绘 */
  changed: boolean;
  /** 给模型看的中文摘要 */
  text: string;
  /** 结构化结果：列表、搜索候选、新建分组的 id 等 */
  data?: unknown;
}

/** 待执行的命令：异步解析已经做完，apply() 只做同步计算 */
export interface McpPending {
  apply(latest: Settings): McpResult;
}

/** secid = 市场.代码：1 沪、0 深、116 港股、105/106/107 美股、100 海外指数 */
const SECID_RE = /^\d{1,3}\.[A-Za-z0-9._-]{1,12}$/;
/** 候选太多时只把前几只列给模型，免得刷屏 */
const MAX_CANDIDATES = 5;
const MAX_SEARCH_ROWS = 10;
/** 分组名保留字：它们会被当成「未分组」 */
const RESERVED_GROUP_NAMES = ["未分组", "ungrouped"];

// ---------- 参数与文本小工具 ----------

const asArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : [];

/** 取一个必填字符串参数 */
function reqString(args: Record<string, unknown>, key: string, label: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new McpError(`缺少参数：${label}`);
  return v.trim();
}

/** 取一个必填整数参数（模型有时会把数字写成字符串） */
function reqInt(args: Record<string, unknown>, key: string, label: string): number {
  const v = args[key];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) throw new McpError(`缺少参数：${label}`);
  return Math.round(n);
}

/** 取一个布尔参数：模型可能写成字符串或 0/1；不认识的值报错，别猜 */
function reqBool(args: Record<string, unknown>, key: string, label: string, fallback: boolean): boolean {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  if (v === 0 || v === "0" || v === "false") return false;
  if (v === 1 || v === "1" || v === "true") return true;
  throw new McpError(`参数 ${label} 只能是 true 或 false`);
}

/** 报价里的关键字段（够写摘要就行） */
interface Brief {
  name: string;
  price: number | null;
  pct: number | null;
}

const briefOf = (q: Quote): Brief => ({ name: q.name, price: q.price, pct: q.pct });

/**
 * 批量取摘要。报价只是「锦上添花」：取不到就只显示 secid，
 * 不能因为行情源抽风就让一条本来能成立的命令失败。
 */
async function briefs(deps: McpDeps, secids: string[]): Promise<Map<string, Brief>> {
  const out = new Map<string, Brief>();
  if (!secids.length) return out;
  try {
    const got = await deps.quotes(secids);
    for (const [id, q] of got) out.set(id, briefOf(q));
  } catch {
    /* 忽略：下面按有就带、没有就省的方式渲染 */
  }
  return out;
}

/** 「secid 名称」；没有名称时只给 secid */
const label = (secid: string, brief: Map<string, Brief>) => {
  const name = brief.get(secid)?.name;
  return name ? `${secid} ${name}` : secid;
};

/** 价格 + 涨跌幅，缺失的字段跳过 */
function quoteBits(secid: string, brief: Map<string, Brief>): string {
  const b = brief.get(secid);
  const bits: string[] = [];
  if (b?.price != null) bits.push(b.price.toFixed(2));
  if (b?.pct != null) bits.push(`${b.pct >= 0 ? "+" : ""}${b.pct.toFixed(2)}%`);
  return bits.join(" ");
}

const unchanged = (s: Settings, text: string, data?: unknown): McpResult => ({
  settings: s,
  changed: false,
  text,
  data,
});

const changed = (settings: Settings, text: string, data?: unknown): McpResult => ({
  settings,
  changed: true,
  text,
  data,
});

const pending = (apply: (latest: Settings) => McpResult): McpPending => ({ apply });
/** 「已不在自选里」的统一说法：命令等网线的这段时间里用户可能把它删了 */
/** 「已不在自选里」的统一说法：命令等网线的这段时间里用户可能把它删了 */

/** 分组在等待期间被删掉了：别把归属写到已经不存在的分组上（新建分组会复用 gN 序号，残留归属会串到新组） */
const groupGone = (latest: Settings, gid: string) =>
  gid !== UNGROUPED && !latest.groups.some((g) => g.id === gid);
const goneText = (ids: string[], labels: (id: string) => string) =>
  `这些标的已经不在自选里了，未做改动：${ids.map(labels).join("、")}`;

// ---------- 标的与分组的解析 ----------

/** 规范化 secid：代码统一大写（105.nvda 与 105.NVDA 是同一只），市场号必须在支持列表里 */
function normalizeSecid(raw: string): string | null {
  const t = raw.trim();
  if (!SECID_RE.test(t)) return null;
  const [market, code] = [t.slice(0, t.indexOf(".")), t.slice(t.indexOf(".") + 1)];
  if (!SUPPORTED_MARKETS.has(market)) return null;
  return `${market}.${code.toUpperCase()}`;
}

/** 关键词匹配到多只时，把候选列出来让模型用 secid 再问一次 */
function ambiguous(keyword: string, items: SearchItem[]): McpError {
  const list = items
    .slice(0, MAX_CANDIDATES)
    .map((i) => `${i.secid} ${i.name}`)
    .join("、");
  return new McpError(`「${keyword}」匹配到多只标的，请用 secid 指定其中一只：${list}`);
}

async function searchOrThrow(deps: McpDeps, keyword: string): Promise<SearchItem[]> {
  try {
    return await deps.search(keyword);
  } catch {
    throw new McpError(`搜索「${keyword}」失败（网络或行情源异常），也可以直接用 secid（形如 1.600519）`);
  }
}

/**
 * 把「secid 或关键词」解析成一只确定的标的。
 * `inWatchlist` 为真时只认自选里已有的：关键词先搜索、再过滤到自选内。
 */
async function resolveTarget(s: Settings, raw: string, deps: McpDeps, inWatchlist = false): Promise<string> {
  const t = raw.trim();
  if (!t) throw new McpError("标的不能为空");
  const secid = normalizeSecid(t);
  if (secid) {
    if (inWatchlist && !s.watchlist.includes(secid)) throw new McpError(`${secid} 不在自选里`);
    return secid;
  }
  // 形如「999.600519」是「像 secid 但市场号不认识」，直接报错；
  // 其余带点的字符串（BRK.B 这类）还是当关键词去搜
  if (/^\d{1,3}\./.test(t)) {
    throw new McpError(
      `${t} 不像一个能识别的 secid：市场号只支持 ${[...SUPPORTED_MARKETS].join(" / ")}，形如 1.600519、105.NVDA`,
    );
  }
  const items = await searchOrThrow(deps, t);
  if (inWatchlist) {
    const mine = items.filter((i) => s.watchlist.includes(i.secid));
    if (!mine.length) throw new McpError(`自选里没有「${t}」`);
    if (mine.length > 1) throw ambiguous(t, mine);
    return mine[0].secid;
  }
  if (!items.length) throw new McpError(`没搜到「${t}」，换个关键词或直接用 secid（形如 1.600519）`);
  if (items.length > 1) throw ambiguous(t, items);
  return items[0].secid;
}

/** 分组清单，用在报错里提示有哪些可用分组 */
const groupListText = (groups: Group[]) =>
  groups.length ? groups.map((g) => `「${g.name}」(${g.id})`).join("、") : "（还没有分组）";

/**
 * 把「未分组 / 分组名 / 分组 id」解析成分组 id。
 * 先认 id 再认名字（id 是稳定的，名字可能被改）。
 * 解析不到时报错并列出可选分组，让模型决定是改用现有分组还是先新建。
 */
function resolveGroup(s: Settings, raw: string): string {
  const t = raw.trim();
  if (!t || RESERVED_GROUP_NAMES.includes(t.toLowerCase())) return UNGROUPED;
  const hit = s.groups.find((g) => g.id === t) ?? s.groups.find((g) => g.name === t);
  if (!hit) {
    throw new McpError(
      `没有「${t}」这个分组。现有分组：${groupListText(s.groups)}。可以先新建分组，或用「未分组」把它移出分组`,
    );
  }
  return hit.id;
}

/** 只认用户建的分组：改名、排序、删除都不能落到内置的「未分组」上 */
function requireRealGroup(s: Settings, raw: string): string {
  const gid = resolveGroup(s, raw);
  if (gid === UNGROUPED) throw new McpError("「未分组」是内置的，不能改名、排序或删除");
  return gid;
}

/** 分组名规整 + 保留字检查 */
function checkedGroupName(raw: string, what: "新建" | "改名"): string {
  const name = trimGroupName(raw);
  if (!name) throw new McpError("分组名不能为空");
  if (RESERVED_GROUP_NAMES.includes(name.toLowerCase())) {
    throw new McpError(`「${name}」是内置分组的名字，不能${what}`);
  }
  return name;
}

/** 标的真实存在的校验结果；ok 时顺带把摘要带回来，省一次报价 */
type Verify = { ok: true; brief: Brief } | { ok: false; reason: "notFound" | "offline" };

/** 用一次报价确认代码不是编的；报价请求本身失败时按 offline 放行，别把断网当成代码错误 */
async function verifyInstrument(deps: McpDeps, secid: string): Promise<Verify> {
  try {
    const q = (await deps.quotes([secid])).get(secid);
    return q?.name ? { ok: true, brief: briefOf(q) } : { ok: false, reason: "notFound" };
  } catch {
    return { ok: false, reason: "offline" };
  }
}

// ---------- 各个命令 ----------

/** 看：自选按分组列出来，带上全表位次、分组归属、置顶与菜单栏名额 */
async function prepareList(s: Settings, deps: McpDeps): Promise<McpPending> {
  // 菜单栏里可能有指数，也要取名字，否则那一行只剩 secid
  const brief = await briefs(deps, [...s.watchlist, ...s.bar]);
  return pending((latest) => {
    const row = (id: string) => {
      const bits = [label(id, brief), quoteBits(id, brief), `第 ${latest.watchlist.indexOf(id) + 1} 位`];
      if (latest.pins.includes(id)) bits.push("置顶");
      return `  - ${bits.join(" · ")}`;
    };
    const at = (gid: string) => itemsOf(latest.watchlist, latest.groupOf, latest.groups, gid);
    const blocks: { id: string; name: string; items: string[] }[] = [
      { id: UNGROUPED, name: "未分组", items: at(UNGROUPED) },
      ...latest.groups.map((g) => ({ id: g.id, name: g.name, items: at(g.id) })),
    ];
    const lines = blocks.map((b) => {
      const rows = b.items.map(row).join("\n") || "  （空）";
      return `${b.name}${b.id ? ` (${b.id})` : ""}（${b.items.length} 只）\n${rows}`;
    });
    const bar = latest.bar.map((id) => label(id, brief));
    lines.push(`菜单栏显示（${latest.bar.length}/${BAR_MAX}）：${bar.join("、") || "（空）"}`);
    lines.push(`大盘指数（内置，不可增删）：${INDICES.map((i) => `${i.secid} ${i.name}`).join("、")}`);

    return unchanged(latest, lines.join("\n"), {
      groups: blocks.map((b) => ({
        id: b.id,
        name: b.name,
        items: b.items.map((id) => {
          const q = brief.get(id);
          return {
            secid: id,
            name: q?.name ?? null,
            price: q?.price ?? null,
            pct: q?.pct ?? null,
            position: latest.watchlist.indexOf(id) + 1,
            pinned: latest.pins.includes(id),
          };
        }),
      })),
      bar: latest.bar,
      barMax: BAR_MAX,
      indices: INDICES.map((i) => i.secid),
    });
  });
}

/** 搜：关键词 → secid 候选 */
async function prepareSearch(_s: Settings, args: Record<string, unknown>, deps: McpDeps): Promise<McpPending> {
  const kw = reqString(args, "keyword", "搜索关键词");
  const items = await searchOrThrow(deps, kw);
  return pending((latest) => {
    if (!items.length) return unchanged(latest, `没搜到「${kw}」，换个关键词（代码 / 名称 / 拼音）再试`);
    const rows = items
      .slice(0, MAX_SEARCH_ROWS)
      .map((i, n) => `${n + 1}. ${i.secid} ${i.name}${i.type ? ` · ${i.type}` : ""}`);
    return unchanged(latest, `「${kw}」找到 ${items.length} 只：\n${rows.join("\n")}`, {
      candidates: items.slice(0, MAX_SEARCH_ROWS),
    });
  });
}

/** 加：加入自选，可同时指定分组；已在自选里时只做分组归属 */
async function prepareAdd(s: Settings, args: Record<string, unknown>, deps: McpDeps): Promise<McpPending> {
  const target = reqString(args, "target", "标的（secid 或关键词）");
  const secid = await resolveTarget(s, target, deps);
  if (isIndex(secid)) throw new McpError(`${secid} 是内置的大盘指数，不能加入自选，它一直显示在主面板上`);
  const gid = args.group === undefined || args.group === null ? undefined : resolveGroup(s, String(args.group));
  const check = await verifyInstrument(deps, secid);
  if (!check.ok && check.reason === "notFound") {
    throw new McpError(`查不到 ${secid} 的行情，请确认代码与市场（secid 形如 1.600519、105.NVDA）`);
  }
  const brief = new Map<string, Brief>(check.ok ? [[secid, check.brief]] : []);

  return pending((latest) => {
    if (gid !== undefined && groupGone(latest, gid)) {
      return unchanged(latest, "分组已经不在了，未做改动（先用 create_group 新建，或换一个分组）");
    }
    const inList = latest.watchlist.includes(secid);
    if (inList && gid === undefined) return unchanged(latest, `${label(secid, brief)} 已在自选里（未做改动）`);
    const pinned = normalizePins(inList ? [...latest.watchlist] : [...latest.watchlist, secid], latest.pins);
    const next: Settings = {
      ...latest,
      watchlist: pinned.list,
      pins: pinned.pins,
      groupOf: gid === undefined ? latest.groupOf : setGroupMany(latest.groupOf, [secid], gid),
    };
    const parts = [`${inList ? "已在自选里" : "已加入自选"}：${label(secid, brief)}`];
    if (gid !== undefined) parts.push(`分组「${groupNameOf(next.groups, gid)}」`);
    parts.push(`自选第 ${next.watchlist.indexOf(secid) + 1} 位 / 共 ${next.watchlist.length} 只`);
    if (!check.ok) parts.push("行情接口暂时不可用，未能校验该代码");
    return changed(next, parts.join(" · "));
  });
}

/** 删：移出自选，它的置顶、分组归属、菜单栏显示一并清掉 */
async function prepareRemove(s: Settings, args: Record<string, unknown>, deps: McpDeps): Promise<McpPending> {
  const targets = asArray(args.targets);
  if (!targets.length) throw new McpError("targets 是空的，要传 secid 或名称的数组");
  const ids = [...new Set(await Promise.all(targets.map((t) => resolveTarget(s, t, deps, true))))];
  const brief = await briefs(deps, ids);
  const lab = (id: string) => label(id, brief);

  return pending((latest) => {
    const present = ids.filter((id) => latest.watchlist.includes(id));
    if (!present.length) return unchanged(latest, goneText(ids, lab));
    const rest = (list: string[]) => list.filter((id) => !present.includes(id));
    const next: Settings = {
      ...latest,
      watchlist: rest(latest.watchlist),
      pins: rest(latest.pins),
      groupOf: dropGroupOf(latest.groupOf, present),
      bar: rest(latest.bar),
    };
    const fromBar = present.filter((id) => latest.bar.includes(id));
    const parts = [`已从自选移除：${present.map(lab).join("、")}`];
    if (fromBar.length) parts.push(`同时移出菜单栏显示：${fromBar.map(lab).join("、")}`);
    if (present.length < ids.length) parts.push(`已不在自选里，跳过：${ids.filter((id) => !present.includes(id)).map(lab).join("、")}`);
    return changed(next, parts.join(" · "));
  });
}

/** 排：把某只自选挪到指定位置（整张自选表的位次；置顶区与其余自选互不跨越，落点会被钳制） */
async function prepareMove(s: Settings, args: Record<string, unknown>, deps: McpDeps): Promise<McpPending> {
  const secid = await resolveTarget(s, reqString(args, "target", "标的（secid 或名称）"), deps, true);
  const pos = reqInt(args, "position", "目标位置（从 1 开始）");
  const brief = await briefs(deps, [secid]);

  return pending((latest) => {
    if (!latest.watchlist.includes(secid)) return unchanged(latest, goneText([secid], (id) => label(id, brief)));
    const from = latest.watchlist.indexOf(secid);
    const to = clampBlock(latest.watchlist, latest.pins, from, Math.min(Math.max(pos - 1, 0), latest.watchlist.length - 1));
    const list = moveItem(latest.watchlist, from, to);
    const note = latest.pins.includes(secid) ? "（置顶的标的只能在置顶区内移动，它就是置顶区的第 1 位）" : "";
    return changed(
      { ...latest, watchlist: list },
      `${label(secid, brief)} 现在排在自选第 ${list.indexOf(secid) + 1} 位 / 共 ${list.length} 只${note}`,
    );
  });
}

/** 归组：批量移入某个分组，「未分组」表示移出分组 */
async function prepareAssignGroup(s: Settings, args: Record<string, unknown>, deps: McpDeps): Promise<McpPending> {
  const targets = asArray(args.targets);
  if (!targets.length) throw new McpError("targets 是空的，要传 secid 或名称的数组");
  const gid = resolveGroup(s, reqString(args, "group", "分组（名字或 id；用「未分组」移出分组）"));
  const ids = [...new Set(await Promise.all(targets.map((t) => resolveTarget(s, t, deps, true))))];
  const brief = await briefs(deps, ids);
  const lab = (id: string) => label(id, brief);

  return pending((latest) => {
    if (groupGone(latest, gid)) return unchanged(latest, "分组已经不在了，未做改动（先用 create_group 新建，或换一个分组）");
    const present = ids.filter((id) => latest.watchlist.includes(id));
    if (!present.length) return unchanged(latest, goneText(ids, lab));
    const next: Settings = { ...latest, groupOf: setGroupMany(latest.groupOf, present, gid) };
    return changed(next, `已把 ${present.map(lab).join("、")} 移入「${groupNameOf(next.groups, gid)}」`);
  });
}

/** 置顶 / 取消置顶 */
async function prepareSetPin(s: Settings, args: Record<string, unknown>, deps: McpDeps): Promise<McpPending> {
  const targets = asArray(args.targets);
  if (!targets.length) throw new McpError("targets 是空的，要传 secid 或名称的数组");
  const want = reqBool(args, "pinned", "pinned", true);
  const ids = [...new Set(await Promise.all(targets.map((t) => resolveTarget(s, t, deps, true))))];
  const brief = await briefs(deps, ids);
  const lab = (id: string) => label(id, brief);

  return pending((latest) => {
    const present = ids.filter((id) => latest.watchlist.includes(id));
    if (!present.length) return unchanged(latest, goneText(ids, lab));
    let list = [...latest.watchlist];
    let pins = [...latest.pins];
    // pinItem 每次都插到最前：倒着置顶，置顶区里的先后才和传入顺序一致
    for (const id of want ? [...present].reverse() : present) {
      const r = want ? pinItem(list, pins, id) : unpinItem(list, pins, id);
      list = r.list;
      pins = r.pins;
    }
    // 置顶区按列表顺序报（pins 数组的顺序只是「先后被置顶」，界面不认它）
    const zoneList = list.filter((id) => pins.includes(id));
    const zone = zoneList.length ? `置顶区：${zoneList.map(lab).join("、")}` : "置顶区现在是空的";
    return changed({ ...latest, watchlist: list, pins }, `已${want ? "置顶" : "取消置顶"}：${present.map(lab).join("、")}（${zone}）`);
  });
}

/** 新建分组 */
function prepareCreateGroup(_s: Settings, args: Record<string, unknown>): McpPending {
  const raw = reqString(args, "name", "分组名");
  const name = checkedGroupName(raw, "新建");
  return pending((latest) => {
    const dup = latest.groups.find((g) => g.name === name);
    if (dup) throw new McpError(`已经有同名的分组「${name}」(${dup.id})，换一个名字，或直接用它`);
    const g = newGroup(latest.groups, name);
    const next: Settings = { ...latest, groups: [...latest.groups, g] };
    const cut = name === raw ? "" : `（分组名超过 12 个字符，截断成「${name}」）`;
    return changed(next, `已新建分组「${g.name}」(${g.id})，现在共 ${next.groups.length} 个分组${cut}`, {
      groupId: g.id,
      name: g.name,
    });
  });
}

/** 分组改名 */
function prepareRenameGroup(s: Settings, args: Record<string, unknown>): McpPending {
  const gid = requireRealGroup(s, reqString(args, "group", "分组（名字或 id）"));
  const name = checkedGroupName(reqString(args, "name", "新名字"), "改名");
  const old = groupNameOf(s.groups, gid);
  return pending((latest) => {
    if (!latest.groups.some((g) => g.id === gid)) {
      return unchanged(latest, `分组「${old}」已经不在了，未做改动`);
    }
    if (latest.groups.some((g) => g.name === name && g.id !== gid)) {
      throw new McpError(`已经有同名的分组「${name}」，换一个名字`);
    }
    const next: Settings = { ...latest, groups: renameGroup(latest.groups, gid, name) };
    return changed(next, `分组「${old}」(${gid}) 已改名为「${name}」`);
  });
}

/** 删分组：成员回落到未分组，自选一只都不少 */
function prepareDeleteGroup(s: Settings, args: Record<string, unknown>): McpPending {
  const gid = requireRealGroup(s, reqString(args, "group", "分组（名字或 id）"));
  const name = groupNameOf(s.groups, gid);
  return pending((latest) => {
    if (!latest.groups.some((g) => g.id === gid)) return unchanged(latest, `分组「${name}」已经不在了，未做改动`);
    const members = itemsOf(latest.watchlist, latest.groupOf, latest.groups, gid);
    const r = removeGroup(latest.groups, latest.groupOf, gid);
    const next: Settings = { ...latest, groups: r.groups, groupOf: r.groupOf };
    return changed(next, `已删除分组「${name}」(${gid})，它的 ${members.length} 只自选回到未分组`);
  });
}

/** 分组排序（未分组固定在最前，不参与排序） */
function prepareMoveGroup(s: Settings, args: Record<string, unknown>): McpPending {
  const gid = requireRealGroup(s, reqString(args, "group", "分组（名字或 id）"));
  const pos = reqInt(args, "position", "目标位置（从 1 开始）");
  return pending((latest) => {
    const from = latest.groups.findIndex((g) => g.id === gid);
    if (from < 0) return unchanged(latest, "这个分组已经不在了，未做改动");
    const to = Math.min(Math.max(pos - 1, 0), latest.groups.length - 1);
    const groups = moveItem(latest.groups, from, to);
    const next: Settings = { ...latest, groups };
    return changed(next, `分组顺序：${groups.map((g) => `「${g.name}」(${g.id})`).join("、")}（未分组固定在最前）`);
  });
}

// ---------- 入口 ----------

/**
 * 准备一条来自 MCP 的命令：把要联网、要搜索的部分做完，返回一个「在最新设置上执行」的闭包。
 * 参数不对、找不到标的等情况在准备阶段就抛 McpError，消息可以直接给模型看。
 */
export async function prepareCommand(
  s: Settings,
  op: string,
  args: Record<string, unknown> = {},
  deps: McpDeps,
): Promise<McpPending> {
  switch (op) {
    case "watchlist.list":
      return prepareList(s, deps);
    case "instrument.search":
      return prepareSearch(s, args, deps);
    case "watchlist.add":
      return prepareAdd(s, args, deps);
    case "watchlist.remove":
      return prepareRemove(s, args, deps);
    case "watchlist.move":
      return prepareMove(s, args, deps);
    case "watchlist.assignGroup":
      return prepareAssignGroup(s, args, deps);
    case "watchlist.setPin":
      return prepareSetPin(s, args, deps);
    case "groups.create":
      return prepareCreateGroup(s, args);
    case "groups.rename":
      return prepareRenameGroup(s, args);
    case "groups.delete":
      return prepareDeleteGroup(s, args);
    case "groups.move":
      return prepareMoveGroup(s, args);
    default:
      throw new McpError(`不认识的操作：${op}`);
  }
}

/** 一步到位的便捷入口：准备完立刻在同一个设置上执行（测试与简单调用用；主面板请走两段式） */
export async function runCommand(
  s: Settings,
  op: string,
  args: Record<string, unknown> = {},
  deps: McpDeps,
): Promise<McpResult> {
  return (await prepareCommand(s, op, args, deps)).apply(s);
}
