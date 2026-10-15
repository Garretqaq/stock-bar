// 拖动排序的 DOM 侧逻辑：指针、位移、落点。与 DOM 无关的那部分在 drag.ts（slotAt / slotAtX / shiftIndex）。
// 设置窗口「行情」页的自选行与分组胶囊、主面板筛选条的分组胶囊共用这一套。
import { shiftIndex, slotAt, slotAtX, type ColRect, type RowRect } from "./drag";

export interface DragCfg {
  /** 行容器 */
  list: HTMLElement;
  /** 行选择器（行要带身份字段：键盘移动后靠它找回焦点） */
  row: string;
  /** 行身份字段（dataset 的后半段）：默认 id；分组胶囊的身份是分组 id，用 gid */
  ident?: string;
  /** 把手选择器 */
  handle: string;
  /** true = 鼠标可从行任意处起拖；false = 一律从把手起拖（行情页点行是勾选） */
  rowDrag: boolean;
  /** 横排列表（分组胶囊）按 x 轴算落点与位移；不写就是竖排 */
  axis?: "x";
  /** 现在能不能拖（行数不足时不动） */
  movable: () => boolean;
  /** 落点钳制：置顶区里的只能在置顶区里挪，其余只能在置顶区之后挪 */
  clamp: (from: number, to: number) => number;
  /** 松手后把 from→to 写回设置，commit 由调用方自己来 */
  apply: (from: number, to: number) => void;
  render: () => void;
}

/** 拖动开始时每一项的矩形：竖排看 top/height，横排看 left/width，两套都存着按轴取用 */
type Rect = RowRect & ColRect;

/** 拖动中的状态；rects 是拖动开始时各行的位置，用于算其他行要让开多少 */
interface DragState {
  cfg: DragCfg;
  from: number;
  to: number;
  /** 按下时指针在拖动轴上的坐标 */
  start: number;
  rects: Rect[];
  el: HTMLElement;
}

let drag: DragState | null = null;

const dragRows = (cfg: DragCfg) => [...cfg.list.querySelectorAll<HTMLElement>(cfg.row)];

/** 现在有没有正在进行的拖动：渲染函数据此别去动行上的位移（拖动中的行是跟手的） */
export const isDragging = () => drag !== null;

/**
 * 让一个列表支持拖动排序：鼠标 / 触屏拖行，键盘 Alt + ↑/↓（横排是 ←/→）移动。
 * 返回「取走这一下 click」的判断：从把手按下、或真的拖动过的那一次点击不该当成点行
 * —— 指针捕获会把 click 的目标换成整行，光看 e.target 认不出把手。
 * state 可以不传：传进来就由调用方持有，DOM 重建（换掉本实例）时那一下 click 的标记不会丢
 * —— 行情页每个分组区块各注册一次，共用同一份。
 */
export function sortable(cfg: DragCfg, state: { take: boolean } = { take: false }): () => boolean {
  const { list } = cfg;
  const axisX = cfg.axis === "x"; // 横排（分组胶囊）：落点与位移都按 x 算
  const ident = cfg.ident ?? "id"; // 行的身份字段：apply 之后靠它找回焦点

  list.addEventListener("pointerdown", (e) => {
    const t = e.target as HTMLElement;
    const row = t.closest<HTMLElement>(cfg.row);
    if (!row || !cfg.movable() || e.button !== 0) return; // 右键 / 中键不拖动
    // 行上的按钮自己处理点击；行本身就是按钮的（分组胶囊）照旧可拖
    const btn = t.closest("button");
    if (btn && btn !== row) return;
    const fromHandle = !!t.closest(cfg.handle);
    // 触屏拖动容易和滚动打架：非鼠标一律只允许从把手起拖
    if (!fromHandle && (!cfg.rowDrag || e.pointerType !== "mouse")) return;
    cancelDrag(); // 上一轮没收拾干净的拖动先复位
    const rows = dragRows(cfg);
    const from = rows.indexOf(row);
    if (from < 0) return;
    state.take = fromHandle;
    drag = {
      cfg,
      from,
      to: from,
      start: axisX ? e.clientX : e.clientY,
      rects: rows.map((r) => {
        const b = r.getBoundingClientRect();
        return { top: b.top, height: b.height, left: b.left, width: b.width };
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
    const pos = axisX ? e.clientX : e.clientY;
    drag.el.style.transform = `${axisX ? "translateX" : "translateY"}(${pos - drag.start}px)`;
    const to = cfg.clamp(drag.from, axisX ? slotAtX(drag.rects, pos) : slotAt(drag.rects, pos));
    if (to === drag.to) return;
    drag.to = to;
    layoutDrag();
    layoutDrag();
  });

  list.addEventListener("pointerup", () => endDrag(true));
  list.addEventListener("pointercancel", () => endDrag(false));
  // 指针被系统抢走（触屏滚动、右键菜单）时捕获会静默丢失，别把半途的顺序写回去
  list.addEventListener("lostpointercapture", cancelDrag);

  // 键盘：Alt + ↑/↓（横排是 ←/→）移动（鼠标之外的第二条路）
  list.addEventListener("keydown", (e) => {
    const back = axisX ? "ArrowLeft" : "ArrowUp";
    const fwd = axisX ? "ArrowRight" : "ArrowDown";
    const row = (e.target as HTMLElement).closest<HTMLElement>(cfg.row);
    if (!row || !e.altKey || (e.key !== back && e.key !== fwd)) return;
    const rows = dragRows(cfg);
    const from = rows.indexOf(row);
    const to = cfg.clamp(from, e.key === back ? from - 1 : from + 1);
    if (from < 0 || to < 0 || to >= rows.length) return;
    e.preventDefault();
    const id = row.dataset[ident];
    cfg.apply(from, to);
    // apply 之后列表可能已被重建（分组胶囊会整个换掉）：list 断了就按身份字段去当前 DOM 里找回焦点
    const home = list.isConnected ? list : document;
    [...home.querySelectorAll<HTMLElement>(cfg.row)].find((r) => r.dataset[ident] === id)?.focus();
  });

  return () => {
    const take = state.take;
    state.take = false;
    return take;
  };
}

/** 拖动中让其他行让开：按目标顺序给每行一个位移，被拖的那行跟手 */
function layoutDrag(): void {
  const d = drag;
  if (!d) return;
  const axisX = d.cfg.axis === "x";
  const at = (r: Rect) => (axisX ? r.left : r.top);
  dragRows(d.cfg).forEach((row, i) => {
    if (row === d.el) return;
    const next = shiftIndex(i, d.from, d.to);
    row.style.transform =
      next === i ? "" : `${axisX ? "translateX" : "translateY"}(${at(d.rects[next]) - at(d.rects[i])}px)`;
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
export function cancelDrag(): void {
  if (drag) endDrag(false);
}
