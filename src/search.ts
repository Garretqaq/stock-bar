// 搜索结果的点击去向：纯逻辑（界面在 main.ts，只照着这个结论做事）。
//
// 点行本身不再等于「加入自选」—— 那是右边那颗 ＋ 的事：
// - 还没加的标的：就地展开预览（实时价格 + 分时图），一路点下去也不会把自选塞满；
// - 已经在自选里的：跳到列表里那一行并展开它的分时图。
// 大盘指数本来就在面板顶上，加不进自选（与 MCP 的 add 同一条规则），点行照样能预览。

import { UNGROUPED, groupIdOf, isIndex, type Group } from "./settings";

export type HitAction = "add" | "preview" | "jump" | "none";

/**
 * 搜索结果的一行被点时该做什么。`onAddButton` 为真表示点的是右边那颗 ＋。
 * 返回 "none" 的两种情况都是「点了也没意义」：已经加过、或它是加不进去的大盘指数。
 */
export function hitAction(secid: string, watchlist: string[], onAddButton: boolean): HitAction {
  const added = watchlist.includes(secid);
  if (onAddButton) return added || isIndex(secid) ? "none" : "add";
  return added ? "jump" : "preview";
}

/**
 * 跳到某只自选时该看哪个分组：当前视图里就有它（「全部」，或它正属于当前分组）就不动，
 * 否则切到它所在的分组；没有归属（或分组已被删）就回「全部」（null）。
 */
export function filterToReveal(
  id: string,
  groupOf: Record<string, string>,
  groups: Group[],
  current: string | null,
): string | null {
  const gid = groupIdOf(groupOf, groups, id);
  if (current === null || gid === current) return current;
  return gid === UNGROUPED ? null : gid;
}
