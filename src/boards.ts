// 板块榜单的纯逻辑：口径文案、细分过滤、涨跌排序。
// 联网（拉板块列表）在 api.ts 的 fetchBoards()，DOM 在主面板的 renderBoards()，这里只有计算。
import type { Board, BoardKind } from "./api";

/** 榜单的排序口径：up = 涨幅榜（降序），down = 跌幅榜（升序） */
export type BoardOrder = "up" | "down";

/** 控制条上那排口径按钮：顺序就是显示顺序 */
export const BOARD_KINDS: { kind: BoardKind; label: string }[] = [
  { kind: "industry", label: "行业" },
  { kind: "concept", label: "概念" },
  { kind: "region", label: "地域" },
];

export const boardKindLabel = (kind: BoardKind): string =>
  BOARD_KINDS.find((k) => k.kind === kind)?.label ?? kind;

/**
 * 是不是行业板块里的二级 / 三级细分。
 * 东方财富给细分的名字加了罗马数字后缀（「地面兵装Ⅱ」「地面兵装Ⅲ」），
 * 而实测同一个细分在 Ⅱ / Ⅲ 两个代码下给出完全一样的点位与涨跌幅 ——
 * 全列出来就是同一个涨跌幅刷两行，所以默认藏起来（控制条上有「细分」开关放它出来）。
 */
export const isSubBoard = (name: string): boolean => /[ⅡⅢ]$/.test(name);

/** 按「含细分」开关过滤；开着就原样返回 */
export function filterSubs(list: Board[], showSubs: boolean): Board[] {
  return showSubs ? list : list.filter((b) => !isSubBoard(b.name));
}

/**
 * 按涨跌幅排：涨幅榜降序、跌幅榜升序。
 * 拿不到涨跌幅的排在最后（不管是哪个方向）—— 它们既不是涨得最好的也不是跌得最狠的，
 * 顶在榜首或榜尾都会挤掉真正有数据的那几只。
 */
export function sortBoards(list: Board[], order: BoardOrder): Board[] {
  const dir = order === "down" ? 1 : -1;
  return [...list].sort((a, b) => {
    if (a.pct == null) return b.pct == null ? 0 : 1;
    if (b.pct == null) return -1;
    return dir * (a.pct - b.pct);
  });
}

/** 榜单要显示的那一串：先按「含细分」过滤，再按涨跌排序 */
export function boardRows(list: Board[], opts: { showSubs: boolean; order: BoardOrder }): Board[] {
  return sortBoards(filterSubs(list, opts.showSubs), opts.order);
}

/**
 * 领涨股那一行的前缀。
 * 东方财富的字段名一律叫「领涨股」，可跌的板块里它给的那只**也在跌**（板块里跌得最少的），
 * 写成「领涨」就成了反话 —— 所以按涨跌幅的正负说：负的说「领跌」。
 * 判断看数字的正负，**不看颜色**：设置里可以换成绿涨红跌，颜色说明不了涨跌。
 * 拿不到涨跌幅（接口给 "-"）时按数据源自己的叫法说「领涨」。
 */
export const leaderTag = (pct: number | null | undefined): string =>
  pct != null && pct < 0 ? "领跌" : "领涨";
