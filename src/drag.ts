// 拖动排序里与 DOM 无关的那部分：指针落在第几格、其他行该让开多少。
// 指针事件与布局留在 sortable.ts，这里只做纯计算，方便直接测。

/** 某一行在拖动开始时的位置（视口坐标） */
export interface RowRect {
  top: number;
  height: number;
}

/** 横排里某一项在拖动开始时的位置（视口坐标）：竖排看 top/height，横排看 left/width */
export interface ColRect {
  left: number;
  width: number;
}

/** 换行摊开的列表（☰「更多分组」弹层）里每一项的位置：横竖都要 */
export interface GridRect extends RowRect, ColRect {}

/**
 * 指针落在第几个槽位（0 起）：过了某行的中线就算进入该槽；
 * 一行都没过（拖到列表上方）落在第一格，全都过了落在最后一格。空列表返回 -1。
 */
export function slotAt(rects: RowRect[], y: number): number {
  if (!rects.length) return -1;
  for (let i = 0; i < rects.length; i++) {
    if (y < rects[i].top + rects[i].height / 2) return i;
  }
  return rects.length - 1;
}

/** 横排列表（分组胶囊）：判定与 slotAt 完全一致，只是换成 x 轴 */
export function slotAtX(rects: ColRect[], x: number): number {
  if (!rects.length) return -1;
  for (let i = 0; i < rects.length; i++) {
    if (x < rects[i].left + rects[i].width / 2) return i;
  }
  return rects.length - 1;
}

/**
 * 换行摊开的列表：落点取指针最近的那一格。格子排成几行都行，
 * 所以不能只看某一根轴（☰「更多分组」弹层里那排胶囊用它）。
 * 距离一样时取靠后的那一格 —— 与 slotAt / slotAtX「全都过了就落在最后一格」一致
 * （量不出布局时所有格子重叠，正好退化成「落在最后一格」）。空列表返回 -1。
 */
export function slotAtGrid(rects: GridRect[], x: number, y: number): number {
  let best = -1;
  let bestD = Infinity;
  rects.forEach((r, i) => {
    const dx = x - (r.left + r.width / 2);
    const dy = y - (r.top + r.height / 2);
    const d = dx * dx + dy * dy;
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  });
  return best;
}

/**
 * 被拖的行要从 from 挪到 to 时，原本在第 i 位的行拖动中该落在哪：
 * from 与 to 之间（不含 from 自己）的行整体让开一格，区间外的行原地不动。
 */
export function shiftIndex(i: number, from: number, to: number): number {
  if (from < to && i > from && i <= to) return i - 1;
  if (from > to && i >= to && i < from) return i + 1;
  return i;
}
