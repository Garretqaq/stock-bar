import { afterEach, describe, expect, it, vi } from "vitest";
import { closeMenu, openMenu } from "./ctxmenu";

const menu = () => document.querySelector<HTMLElement>(".ctx-menu");
const items = () => [...document.querySelectorAll<HTMLButtonElement>(".ctx-item")];

afterEach(() => closeMenu());

describe("右键菜单", () => {
  it("渲染菜单项，并定位到鼠标位置", () => {
    openMenu(12, 34, [{ label: "删除" }, { label: "移除" }]);
    expect(items().map((b) => b.textContent)).toEqual(["删除", "移除"]);
    expect(menu()!.style.left).toBe("12px");
    expect(menu()!.style.top).toBe("34px");
  });

  it("点击菜单项执行回调并关闭菜单", () => {
    const onPick = vi.fn();
    openMenu(0, 0, [{ label: "删除", danger: true, onPick }]);
    items()[0].click();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();
  });

  it("置灰的菜单项不可点击", () => {
    const onPick = vi.fn();
    openMenu(0, 0, [{ label: "菜单栏已满", disabled: true, onPick }]);
    expect(items()[0].disabled).toBe(true);
    items()[0].click();
    expect(onPick).not.toHaveBeenCalled();
    expect(menu()).not.toBeNull();
  });

  it("Esc 关闭菜单，且不再把 Esc 冒泡给窗口", () => {
    const outer = vi.fn();
    document.addEventListener("keydown", outer);
    openMenu(0, 0, [{ label: "删除" }]);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    document.removeEventListener("keydown", outer);
    expect(menu()).toBeNull();
    expect(outer).not.toHaveBeenCalled();
  });

  it("点击菜单外部关闭", () => {
    openMenu(0, 0, [{ label: "删除" }]);
    document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(menu()).toBeNull();
  });

  it("重复打开只保留一个菜单", () => {
    openMenu(0, 0, [{ label: "删除" }]);
    openMenu(0, 0, [{ label: "移除" }]);
    expect(document.querySelectorAll(".ctx-menu").length).toBe(1);
    expect(items().map((b) => b.textContent)).toEqual(["移除"]);
  });

  it("没有菜单项时不弹菜单", () => {
    openMenu(0, 0, []);
    expect(menu()).toBeNull();
  });

  it("页面滚动收起菜单，菜单自己滚动不收起", () => {
    openMenu(0, 0, [{ label: "删除" }]);
    // 菜单太高时自己要能滚（分组很多），这时不该把自己关掉
    menu()!.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(menu()).not.toBeNull();
    document.body.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(menu()).toBeNull();
  });

  it("ignoreScrollFrom 里的滚动不收起菜单（锚点不跟着动）", () => {
    const strip = document.createElement("div");
    document.body.append(strip);
    openMenu(0, 0, [{ label: "删除" }], { ignoreScrollFrom: strip });
    strip.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(menu()).not.toBeNull();
    document.body.dispatchEvent(new Event("scroll", { bubbles: true }));
    expect(menu()).toBeNull();
    strip.remove();
  });

  it("chips：把项摊成筛选条那种标签（带数量、选中态），不再有菜单行", () => {
    openMenu(
      0,
      0,
      [
        { label: "科技", count: 5, on: true },
        { label: "金融", count: 2 },
      ],
      { layout: "chips" },
    );
    expect(menu()!.classList.contains("chips")).toBe(true);
    expect(document.querySelectorAll(".ctx-item").length).toBe(0);
    const chips = [...document.querySelectorAll<HTMLElement>(".ctx-chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["科技5", "金融2"]);
    // 标签样式复用主面板的 .gtab：当前这个就是筛选条上的选中态
    expect(chips[0].className).toContain("gtab");
    expect(chips[0].classList.contains("on")).toBe(true);
    expect(chips[1].classList.contains("on")).toBe(false);
  });

  it("chips 里点标签执行回调并收起弹层；不传 layout 还是普通菜单", () => {
    const onPick = vi.fn();
    openMenu(0, 0, [{ label: "科技", count: 5, onPick }], { layout: "chips" });
    document.querySelector<HTMLElement>(".ctx-chip")!.click();
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(menu()).toBeNull();

    openMenu(0, 0, [{ label: "删除" }]);
    expect(menu()!.classList.contains("chips")).toBe(false);
    expect(document.querySelectorAll(".ctx-item").length).toBe(1);
  });

  // 搜索结果与搜索框都靠「这次点击是不是搜索菜单里的」来决定要不要收起自己，
  // 而菜单是先移除再执行回调的：那条判断必须仍然认得出菜单里的点击
  it("菜单项的 click 冒到 document 时仍认得出它来自菜单（弹层此时已移除）", () => {
    const seen: (boolean | undefined)[] = [];
    const onDoc = (e: Event) => seen.push(!!(e.target as HTMLElement).closest?.(".ctx-menu"));
    document.addEventListener("click", onDoc);
    openMenu(0, 0, [{ label: "删除" }]);
    items()[0].click();
    document.removeEventListener("click", onDoc);
    expect(seen).toEqual([true]);
  });

  it("className 挂到菜单根节点上，用来区分是哪个菜单（其余菜单不挂）", () => {
    const seen: string[] = [];
    const onDoc = (e: Event) => {
      // ctx-search 只该出现在搜索菜单上：别的菜单点掉时，搜索框要照旧收起自己
      const marked = (e.target as HTMLElement).closest?.(".ctx-search");
      seen.push(marked ? "search" : "other");
    };
    document.addEventListener("click", onDoc);
    openMenu(0, 0, [{ label: "加入自选" }], { className: "ctx-search" });
    expect(menu()!.classList.contains("ctx-search")).toBe(true);
    items()[0].click();

    openMenu(0, 0, [{ label: "删除自选" }]);
    expect(menu()!.classList.contains("ctx-search")).toBe(false);
    items()[0].click();
    document.removeEventListener("click", onDoc);
    expect(seen).toEqual(["search", "other"]);
  });

  it("菜单项可以带图标；只要有一项带图标，其余项也留出等宽图标位", () => {
    const ICON = `<svg viewBox="0 0 24 24"><path d="M4.5 4.5h15"/></svg>`;
    openMenu(0, 0, [{ label: "置顶", icon: ICON }, { label: "删除自选" }]);

    // 有图标的项：图标进了 .ctx-ico，标签文字不受影响
    const [pin, del] = items();
    expect(pin.querySelector(".ctx-ico svg")).not.toBeNull();
    expect(pin.textContent).toBe("置顶");
    // 没图标的项也占同一个位（空 span），文字才不会跟上面错开
    expect(del.querySelector(".ctx-ico")).not.toBeNull();
    expect(del.querySelector(".ctx-ico svg")).toBeNull();
    expect(del.textContent).toBe("删除自选");
  });

  it("一项带图标都没有时不留图标位（菜单宽度不变）", () => {
    openMenu(0, 0, [{ label: "删除自选" }]);
    expect(items()[0].querySelector(".ctx-ico")).toBeNull();
  });
});
