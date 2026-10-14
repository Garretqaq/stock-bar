import { describe, expect, it } from "vitest";
import { isDragClick, isDragMove, scrollDeltaFor, TAB_DRAG_SLOP } from "./tabs";

describe("isDragMove", () => {
  it("没超过阈值不算拖动（手抖）", () => {
    expect(isDragMove(0, false)).toBe(false);
    expect(isDragMove(TAB_DRAG_SLOP - 1, false)).toBe(false);
    expect(isDragMove(-(TAB_DRAG_SLOP - 1), false)).toBe(false);
  });

  it("往任一方向超过阈值都算拖动", () => {
    expect(isDragMove(TAB_DRAG_SLOP, false)).toBe(true);
    expect(isDragMove(-TAB_DRAG_SLOP, false)).toBe(true);
  });

  it("已经在拖了就一直算拖，哪怕指针又回到按下点", () => {
    expect(isDragMove(0, true)).toBe(true);
  });
});

describe("isDragClick", () => {
  it("拖动刚结束就跟过来的 click 要吞掉", () => {
    expect(isDragClick(1000, 1000)).toBe(true);
    expect(isDragClick(1000, 1200)).toBe(true);
  });

  it("隔得够久的 click 是真点击", () => {
    expect(isDragClick(1000, 1600)).toBe(false);
  });

  it("这次没拖过（0）就都是真点击", () => {
    expect(isDragClick(0, 1000)).toBe(false);
  });
});

describe("scrollDeltaFor", () => {
  // 视野是 [100, 400]
  const box = { left: 100, right: 400 };

  it("标签已经在视野里就不滚", () => {
    expect(scrollDeltaFor({ left: 150, right: 220 }, box)).toBe(0);
  });

  it("标签藏在右边：往右滚，并留出余量", () => {
    // 右边超出 60，再留 6 点余量
    expect(scrollDeltaFor({ left: 380, right: 460 }, box)).toBe(66);
  });

  it("标签藏在左边：往左滚（负值），并留出余量", () => {
    expect(scrollDeltaFor({ left: 40, right: 120 }, box)).toBe(-66);
  });

  it("余量可以调", () => {
    expect(scrollDeltaFor({ left: 380, right: 460 }, box, 0)).toBe(60);
  });

  it("正好贴着边不算越界", () => {
    expect(scrollDeltaFor({ left: 100, right: 400 }, box)).toBe(0);
  });
});
