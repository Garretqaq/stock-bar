// 通用右键菜单：主面板与设置窗口共用（样式见 ctxmenu.css，两个入口各 import 一次）
// 用法：openMenu(e.clientX, e.clientY, [{ label: "删除", danger: true, onPick: () => {} }])

export interface MenuItem {
  label: string;
  /**
   * 菜单项左侧的图标（内联 SVG 字符串）。只传本仓库自己的常量，不做转义 —— 别塞外部数据。
   * 同一份菜单里只要有一项带图标，其余项也会占一个等宽的空位，文字才不会参差不齐。
   */
  icon?: string;
  /** 危险操作（删除等）显示为红色 */
  danger?: boolean;
  /** 置灰且不可点击，用于「名额已满」这类提示 */
  disabled?: boolean;
  /** 只有 chips 排法用：标签右侧的数量角标（分组里的自选只数） */
  count?: number;
  /** 只有 chips 排法用：当前选中的那一个（浅底 + 强调色文字，不用 ✓ 前缀） */
  on?: boolean;
  /**
   * 只有 chips 排法用：这一项的标记（渲染成 `data-key`），拖动排序时用来认行 ——
   * 「全部 / 未分组」这类固定项不给 key，也就拖不走。
   */
  key?: string;
  onPick?: () => void;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

let menu: HTMLElement | null = null;
/** 关闭时要摘掉的全局监听 */
let cleanup: (() => void) | null = null;

export function closeMenu(): void {
  if (!menu) return;
  menu.remove();
  menu = null;
  cleanup?.();
  cleanup = null;
}

/** openMenu 的可选行为 */
export interface MenuOpts {
  /** 菜单锚点所在容器：它自己的滚动不挪动锚点，所以那种滚动不该把菜单收起来 */
  ignoreScrollFrom?: Element;
  /**
   * 内容怎么排：
   * - rows（默认）：一行一项的菜单
   * - chips：摊成一排标签（和主面板筛选条上的分组标签同款），放不下自动换行，
   *   比一长条菜单矮得多 —— 筛选条末尾的 ☰ 用它
   */
  layout?: "rows" | "chips";
  /**
   * 额外挂到菜单根节点上的类名（空格分隔）。搜索结果右键菜单用它给自己打标 `ctx-search`：
   * 「点别处收起搜索结果」的监听据此认出「这次点击来自搜索菜单，别收」——
   * 菜单是先移除再执行回调的，`closest()` 在摘下来的子树里仍然有效。
   */
  className?: string;

  /**
   * 菜单挂好之后回调（拿到菜单根节点）。主面板用它在 ☰ 的分组弹层里挂拖动排序，
   * 以及拦掉「拖动尾巴那一下 click」—— 那一下不该顺手切分组。
   */
  onOpen?: (el: HTMLElement) => void;
}

/**
 * 在 (x, y) 处弹出菜单；重复调用会先关掉上一个。
 * ignoreScrollFrom：这个容器里自己的滚动不会挪动菜单的位置（比如菜单挂在筛选条末尾的 ☰ 上，
 * 筛选条横着滚，☰ 是不动的），所以那种滚动不该把菜单收起来；页面 / 列表滚动照旧收起菜单。
 */
export function openMenu(x: number, y: number, items: MenuItem[], opts: MenuOpts = {}): void {
  closeMenu();
  if (!items.length) return;
  const { ignoreScrollFrom, layout = "rows", className } = opts;
  const chips = layout === "chips";

  const el = document.createElement("div");
  el.className = ["ctx-menu", chips ? "chips" : "", className ?? ""].filter(Boolean).join(" ");
  el.setAttribute("role", "menu");
  // 只要有一项带图标，整份菜单就都留出图标位：否则带图标的项文字会往右缩，跟其余项对不齐
  const iconSlot = !chips && items.some((it) => it.icon);
  el.innerHTML = items
    .map((it, i) => {
      const off = it.disabled ? " disabled" : "";
      if (chips) {
        // 直接复用筛选条上 .gtab 的样式：这里要的就是「和那排标签长得一模一样」
        const key = it.key == null ? "" : ` data-key="${esc(it.key)}"`;
        return (
          `<button class="gtab ctx-chip${it.on ? " on" : ""}" role="menuitem" data-i="${i}"${key}${off}` +
          `${it.on ? ' aria-current="true"' : ""}>${esc(it.label)}` +
          `${it.count == null ? "" : `<b>${it.count}</b>`}</button>`
        );
      }
      const ico = iconSlot ? `<span class="ctx-ico" aria-hidden="true">${it.icon ?? ""}</span>` : "";
      return (
        `<button class="ctx-item${it.danger ? " danger" : ""}"` +
        ` role="menuitem" data-i="${i}"${off}>${ico}${esc(it.label)}</button>`
      );
    })
    .join("");
  document.body.append(el);
  menu = el;

  // 靠近窗口边缘时向内收，避免被裁掉。
  // 用 offsetWidth / offsetHeight（布局尺寸）而不是 getBoundingClientRect：
  // 入场动画带着 scale，量出来会偏小，菜单就会有一部分留在窗口外面点不到。
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  const px = Math.min(Math.max(6, x), Math.max(6, window.innerWidth - w - 6));
  const py = Math.min(Math.max(6, y), Math.max(6, window.innerHeight - h - 6));
  el.style.left = `${Math.round(px)}px`;
  el.style.top = `${Math.round(py)}px`;
  opts.onOpen?.(el);

  const pick = (i: number) => {
    const it = items[i];
    if (!it || it.disabled) return;
    closeMenu();
    it.onPick?.();
  };

  el.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
    if (btn?.dataset.i) pick(Number(btn.dataset.i));
  });

  // 键盘操作：↑↓ 切换、Enter 确认（Esc 在全局监听里处理）
  el.addEventListener("keydown", (e) => {
    const btns = [...el.querySelectorAll<HTMLElement>("[data-i]:not([disabled])")];
    const cur = btns.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      btns[(cur + step + btns.length) % btns.length]?.focus();
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (cur >= 0) pick(Number(btns[cur].dataset.i));
    }
  });

  const onPointerDown = (e: PointerEvent) => {
    if (!el.contains(e.target as Node)) closeMenu();
  };
  // 捕获阶段拦下 Esc：菜单打开时不应该再触发窗口自己的 Esc 行为（收起面板）
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.stopPropagation();
    closeMenu();
  };
  // 页面滚动时菜单要收起（它挂在页面坐标上，跟着动就对不上了）；
  // 但菜单自己滚动、以及 ignoreScrollFrom 里那种「菜单锚点不会动」的滚动，不该把菜单关掉
  const onScroll = (e: Event) => {
    const t = e.target as Node;
    if (el.contains(t) || ignoreScrollFrom?.contains(t)) return;
    closeMenu();
  };

  document.addEventListener("pointerdown", onPointerDown, true);
  document.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("blur", closeMenu);
  window.addEventListener("resize", closeMenu);
  window.addEventListener("scroll", onScroll, true);
  cleanup = () => {
    document.removeEventListener("pointerdown", onPointerDown, true);
    document.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("blur", closeMenu);
    window.removeEventListener("resize", closeMenu);
    window.removeEventListener("scroll", onScroll, true);
  };
}
