// 通用右键菜单：主面板与设置窗口共用（样式见 ctxmenu.css，两个入口各 import 一次）
// 用法：openMenu(e.clientX, e.clientY, [{ label: "删除", danger: true, onPick: () => {} }])

export interface MenuItem {
  label: string;
  /** 危险操作（删除等）显示为红色 */
  danger?: boolean;
  /** 置灰且不可点击，用于「名额已满」这类提示 */
  disabled?: boolean;
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

/**
 * 在 (x, y) 处弹出菜单；重复调用会先关掉上一个。
 * ignoreScrollFrom：这个容器里自己的滚动不会挪动菜单的位置（比如菜单挂在筛选条末尾的 ☰ 上，
 * 筛选条横着滚，☰ 是不动的），所以那种滚动不该把菜单收起来；页面 / 列表滚动照旧收起菜单。
 */
export function openMenu(x: number, y: number, items: MenuItem[], ignoreScrollFrom?: Element): void {
  closeMenu();
  if (!items.length) return;

  const el = document.createElement("div");
  el.className = "ctx-menu";
  el.setAttribute("role", "menu");
  el.innerHTML = items
    .map(
      (it, i) =>
        `<button class="ctx-item${it.danger ? " danger" : ""}" role="menuitem" data-i="${i}"` +
        `${it.disabled ? " disabled" : ""}>${esc(it.label)}</button>`,
    )
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

  const pick = (i: number) => {
    const it = items[i];
    if (!it || it.disabled) return;
    closeMenu();
    it.onPick?.();
  };

  el.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(".ctx-item");
    if (btn?.dataset.i) pick(Number(btn.dataset.i));
  });

  // 键盘操作：↑↓ 切换、Enter 确认（Esc 在全局监听里处理）
  el.addEventListener("keydown", (e) => {
    const btns = [...el.querySelectorAll<HTMLElement>(".ctx-item:not([disabled])")];
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
