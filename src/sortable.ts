// 拖动排序的 DOM 侧逻辑：指针、位移、落点。与 DOM 无关的那部分在 drag.ts（slotAt / slotAtX / shiftIndex）。
// 设置窗口「行情」页的自选行与分组胶囊、主面板筛选条的分组胶囊共用这一套。
import { shiftIndex, slotAt, slotAtGrid, slotAtX, type ColRect, type RowRect } from "./drag";

/**
 * 从行上任意处起拖时要先按住多久（毫秒）。
 * 从把手起拖是明确的拖动意图，立刻开始；行本身既能点（选中 / 展开分时）又能拖，
 * 按下就进入拖动的话，手抖几像素顺序就变了，点行也变得很别扭 —— 所以先按住再算数。
 */
export const HOLD_MS = 200;
/** 按住期间指针允许晃动的范围（像素）：超了就当成滚动 / 别的滑动手势，不再进入拖动 */
const HOLD_SLOP = 8;
/** 进入拖动后要让开多少像素才算换了落点：手抖几像素不该把行挪走一格 */
const MOVE_SLOP = 4;

export interface DragCfg {
  /** 行容器 */
  list: HTMLElement;
  /** 行选择器（行要带身份字段：键盘移动后靠它找回焦点） */
  row: string;
  /** 行身份字段（dataset 的后半段）：默认 id；分组胶囊的身份是分组 id，用 gid */
  ident?: string;
  /** 把手选择器 */
  handle: string;
  /** true = 鼠标可从行任意处起拖（要按住 HOLD_MS）；false = 一律从把手起拖（行情页点行是勾选） */
  rowDrag: boolean;
  /**
   * 排法：不写是竖排列表（自选行 / 分组区块），"x" 是横排一行（行情页那排胶囊），
   * "grid" 是换行摊开的（☰「更多分组」弹层）—— 落点按两轴算
   */
  axis?: "x" | "y" | "grid";
  /** 现在能不能拖（行数不足时不动） */
  movable: () => boolean;
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
  /** 按下时指针的位置（换行摊开时两轴都要用） */
  startX: number;
  startY: number;
  rects: Rect[];
  el: HTMLElement;
}

/** 从行上任意处按下、还在等「按住」的那一段：时间到了才变成拖动（见 HOLD_MS） */
interface HoldState {
  cfg: DragCfg;
  row: HTMLElement;
  pointerId: number;
  /** 最近一次指针位置：进入拖动时当起点用，免得行在那一刻跳一下 */
  x: number;
  y: number;
  timer: number;
}

let drag: DragState | null = null;
let hold: HoldState | null = null;

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
  const axis = cfg.axis ?? "y";
  const ident = cfg.ident ?? "id"; // 行的身份字段：apply 之后靠它找回焦点
  /** 指针落在第几格：三种排法各用各的纯函数（见 drag.ts） */
  const slotIn = (rects: Rect[], x: number, y: number) =>
    axis === "x" ? slotAtX(rects, x) : axis === "y" ? slotAt(rects, y) : slotAtGrid(rects, x, y);

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
    clearHold();
    state.take = fromHandle;
    // 从把手按下：立刻开始拖。从行上任意处按下：先按住 HOLD_MS 再算数（见 HOLD_MS 的说明）
    if (fromHandle) return beginDrag(cfg, row, e.clientX, e.clientY, e.pointerId);
    hold = {
      cfg,
      row,
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      timer: window.setTimeout(() => {
        const h = hold;
        hold = null;
        if (h) beginDrag(h.cfg, h.row, h.x, h.y, h.pointerId);
      }, HOLD_MS),
    };
  });

  list.addEventListener("pointermove", (e) => {
    const x = e.clientX;
    const y = e.clientY;
    // 还在等「按住」：晃太多就当成别的手势（滚动、滑开），不再进入拖动；
    // 小幅移动则把起点跟着挪 —— 等按住的这段时间里指针本来就可能挪几像素
    if (hold) {
      if (hold.cfg !== cfg) return;
      if (Math.abs(x - hold.x) > HOLD_SLOP || Math.abs(y - hold.y) > HOLD_SLOP) return clearHold();
      hold.x = x;
      hold.y = y;
      return;
    }
    if (drag?.cfg !== cfg) return;
    // 行已被重建（别的窗口改了顺序）或按键已松开：立刻中止，别拿旧下标去动新列表
    if (!drag.el.isConnected || !e.buttons) return cancelDrag();
    // 竖排只跟纵向、横排只跟横向：另一根轴上的手抖不该让行歪出去
    const dx = x - drag.startX;
    const dy = y - drag.startY;
    drag.el.style.transform =
      axis === "x"
        ? `translateX(${dx}px)`
        : axis === "y"
          ? `translateY(${dy}px)`
          : `translate(${dx}px, ${dy}px)`;
    // 还没让开够远：行跟着手走，顺序先不动（不然刚按住就手抖一下，行会平白挪走一格）
    const moved = axis === "x" ? Math.abs(dx) : axis === "y" ? Math.abs(dy) : Math.max(Math.abs(dx), Math.abs(dy));
    if (moved < MOVE_SLOP) return;
    const to = slotIn(drag.rects, x, y);
    if (to === drag.to) return;
    drag.to = to;
    layoutDrag();
    layoutDrag();
  });

  list.addEventListener("pointerup", () => {
    clearHold(); // 按住还没到时间就松手：这一下只是点行
    endDrag(true);
  });
  list.addEventListener("pointercancel", () => {
    clearHold();
    endDrag(false);
  });
  // 指针被系统抢走（触屏滚动、右键菜单）时捕获会静默丢失，别把半途的顺序写回去
  list.addEventListener("lostpointercapture", () => {
    clearHold();
    cancelDrag();
  });

  // 键盘：Alt + ↑/↓（横排是 ←/→）移动（鼠标之外的第二条路）
  list.addEventListener("keydown", (e) => {
    const back = axis === "x" ? "ArrowLeft" : axis === "y" ? "ArrowUp" : "ArrowLeft";
    const fwd = axis === "x" ? "ArrowRight" : axis === "y" ? "ArrowDown" : "ArrowRight";
    const row = (e.target as HTMLElement).closest<HTMLElement>(cfg.row);
    if (!row || !e.altKey || (e.key !== back && e.key !== fwd)) return;
    const rows = dragRows(cfg);
    const from = rows.indexOf(row);
    const to = e.key === back ? from - 1 : from + 1;
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

/**
 * 真的进入拖动：记下起点与各行当时的位置，把行挂到指针上。
 * 起点用「当前」指针位置而不是按下的位置 —— 等按住的这段时间里指针可能挪了几像素，
 * 拿按下的位置当起点，行会在开始拖动的那一刻跳一下。
 */
function beginDrag(cfg: DragCfg, row: HTMLElement, x: number, y: number, pointerId: number): void {
  const rows = dragRows(cfg);
  const from = rows.indexOf(row);
  if (from < 0) return;
  drag = {
    cfg,
    from,
    to: from,
    startX: x,
    startY: y,
    rects: rows.map((r) => {
      const b = r.getBoundingClientRect();
      return { top: b.top, height: b.height, left: b.left, width: b.width };
    }),
    el: row,
  };
  row.classList.add("dragging");
  cfg.list.classList.add("dragging");
  row.setPointerCapture(pointerId);
}

/** 作废还没进入拖动的那一段「按住」（松手、晃太多、又按下了别处） */
function clearHold(): void {
  if (hold) window.clearTimeout(hold.timer);
  hold = null;
}

/** 拖动中让其他行让开：按目标顺序给每行一个位移，被拖的那行跟手 */
function layoutDrag(): void {
  const d = drag;
  if (!d) return;
  const axis = d.cfg.axis ?? "y";
  dragRows(d.cfg).forEach((row, i) => {
    if (row === d.el) return;
    const next = shiftIndex(i, d.from, d.to);
    if (next === i) return void (row.style.transform = "");
    // 位移 = 「目标那一格」与「我这一格」的差：竖排 / 横排是单轴，换行摊开的两轴都要
    const dx = d.rects[next].left - d.rects[i].left;
    const dy = d.rects[next].top - d.rects[i].top;
    row.style.transform =
      axis === "x"
        ? `translateX(${dx}px)`
        : axis === "y"
          ? `translateY(${dy}px)`
          : `translate(${dx}px, ${dy}px)`;
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
