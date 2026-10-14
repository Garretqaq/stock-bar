import { describe, expect, it } from "vitest";
import { shiftIndex, slotAt, type RowRect } from "./drag";

// 三行、每行 50px、行间无缝隙
const rects: RowRect[] = [
  { top: 0, height: 50 },
  { top: 50, height: 50 },
  { top: 100, height: 50 },
];

describe("slotAt", () => {
  it("没过中线留在本行", () => {
    expect(slotAt(rects, 24)).toBe(0);
    expect(slotAt(rects, 74)).toBe(1);
  });

  it("过了中线就算进入下一行", () => {
    expect(slotAt(rects, 26)).toBe(1);
    expect(slotAt(rects, 76)).toBe(2);
  });

  it("拖到列表上方落在第一格，拖到下方落在最后一格", () => {
    expect(slotAt(rects, -40)).toBe(0);
    expect(slotAt(rects, 999)).toBe(2);
  });

  it("空列表返回 -1（空列表上不会开始拖动）", () => {
    expect(slotAt([], 10)).toBe(-1);
  });
});

describe("shiftIndex", () => {
  it("往后拖：区间内的行上移一格", () => {
    // 第 0 行拖到第 2 位 → 原来的 1、2 位各上移一格
    expect(shiftIndex(1, 0, 2)).toBe(0);
    expect(shiftIndex(2, 0, 2)).toBe(1);
  });

  it("往前拖：区间内的行下移一格", () => {
    // 第 2 行拖到第 0 位 → 原来的 0、1 位各下移一格
    expect(shiftIndex(0, 2, 0)).toBe(1);
    expect(shiftIndex(1, 2, 0)).toBe(2);
  });

  it("区间外的行不动", () => {
    expect(shiftIndex(0, 1, 2)).toBe(0);
    expect(shiftIndex(2, 0, 1)).toBe(2);
  });

  it("原地不动时所有行都保持原位", () => {
    expect([0, 1, 2].map((i) => shiftIndex(i, 1, 1))).toEqual([0, 1, 2]);
  });
});
