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
});
