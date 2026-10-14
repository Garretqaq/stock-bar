// 分组筛选条（主面板搜索框下面那一行）的纯计算：指针、DOM 与滚动这些副作用留在 main.ts 里。
// 和 drag.ts 一个路子 —— 抽出来是为了能单测。

/** 横向拖动超过这个距离才算「真的在拖」：手指 / 鼠标抖一下不算 */
export const TAB_DRAG_SLOP = 4;

/** 拖动结束后这么久之内跟过来的 click 算拖动的一部分，要吞掉 */
export const TAB_DRAG_CLICK_MS = 500;

/** 这一次 pointermove 够不够格算拖动；已经开始拖了就一直是拖 */
export function isDragMove(dx: number, alreadyDragging: boolean): boolean {
  return alreadyDragging || Math.abs(dx) >= TAB_DRAG_SLOP;
}

/** 拖动过之后那一下 click 要不要吞掉（draggedAt 为 0 表示这次没拖过） */
export function isDragClick(draggedAt: number, now: number): boolean {
  return draggedAt > 0 && now - draggedAt < TAB_DRAG_CLICK_MS;
}

/**
 * 把选中的标签带进视野要滚多少：已经在视野里就返回 0。
 * margin 是标签与容器边缘之间要留的余量，别让标签贴着边。
 */
export function scrollDeltaFor(
  chip: { left: number; right: number },
  box: { left: number; right: number },
  margin = 6,
): number {
  if (chip.left < box.left) return chip.left - box.left - margin;
  if (chip.right > box.right) return chip.right - box.right + margin;
  return 0;
}
