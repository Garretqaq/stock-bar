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
});
