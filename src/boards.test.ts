// 板块榜单的纯逻辑：细分过滤与涨跌排序（界面接线在 main.test.ts 里测）。
import { describe, expect, it } from "vitest";
import type { Board } from "./api";
import {
  BOARD_KINDS,
  boardKindLabel,
  boardRows,
  filterSubs,
  isSubBoard,
  leaderTag,
  searchBoards,
  sortBoards,
} from "./boards";
const b = (name: string, pct: number | null, secid = `90.BK${name.length}`): Board => ({
  secid,
  code: secid.slice(3),
  name,
  pct,
  price: 1000,
  leader: null,
  leaderPct: null,
});

const names = (list: Board[]) => list.map((x) => x.name);

/** 排序结果里最后一名（用来钉住「拿不到涨跌幅的排在最后」） */
const last = (list: Board[]) => list[list.length - 1].name;

describe("板块：细分识别", () => {
  it("名字带 Ⅱ / Ⅲ 后缀的算细分", () => {
    expect(isSubBoard("地面兵装Ⅱ")).toBe(true);
    expect(isSubBoard("航海装备Ⅲ")).toBe(true);
    expect(isSubBoard("国防军工")).toBe(false);
    expect(isSubBoard("航天航空")).toBe(false);
    // 罗马数字只在结尾才算（「Ⅲ」出现在中间是名字的一部分，不是细分标记）
    expect(isSubBoard("Ⅲ号板块")).toBe(false);
  });

  it("默认藏起细分，开关打开才放出来", () => {
    const list = [b("航天航空", 5.4), b("航海装备Ⅲ", 6.9), b("航海装备Ⅱ", 6.9)];

    expect(names(filterSubs(list, false))).toEqual(["航天航空"]);
    expect(names(filterSubs(list, true))).toEqual(["航天航空", "航海装备Ⅲ", "航海装备Ⅱ"]);
  });
});

describe("板块：涨跌排序", () => {
  const list = [b("甲", 1.5), b("乙", -3.2), b("丙", 7.8), b("丁", null), b("戊", 0)];

  it("涨幅榜：降序", () => {
    expect(names(sortBoards(list, "up"))).toEqual(["丙", "甲", "戊", "乙", "丁"]);
  });

  it("跌幅榜：升序", () => {
    expect(names(sortBoards(list, "down"))).toEqual(["乙", "戊", "甲", "丙", "丁"]);
  });

  it("拿不到涨跌幅的排在最后（哪个方向都是）", () => {
    expect(last(sortBoards(list, "up"))).toBe("丁");
    expect(last(sortBoards(list, "down"))).toBe("丁");
  });

  it("不改动传进来的那份", () => {
    const input = [b("甲", 1), b("乙", 9)];
    sortBoards(input, "up");
    expect(names(input)).toEqual(["甲", "乙"]);
  });

  it("boardRows：先按细分过滤，再排序", () => {
    const rows = [b("航天航空", 5.4), b("地面兵装Ⅲ", 7.3), b("燃料电池", -2.2), b("白银", 1.1)];

    expect(names(boardRows(rows, { showSubs: false, order: "up" }))).toEqual([
      "航天航空",
      "白银",
      "燃料电池",
    ]);
    expect(names(boardRows(rows, { showSubs: true, order: "up" }))).toEqual([
      "地面兵装Ⅲ",
      "航天航空",
      "白银",
      "燃料电池",
    ]);
    expect(names(boardRows(rows, { showSubs: true, order: "down" }))).toEqual([
      "燃料电池",
      "白银",
      "航天航空",
      "地面兵装Ⅲ",
    ]);
  });
});

describe("板块：口径文案", () => {
  it("控制条上按行业 / 概念 / 地域排", () => {
    expect(BOARD_KINDS.map((k) => k.kind)).toEqual(["industry", "concept", "region"]);
    expect(BOARD_KINDS.map((k) => k.label)).toEqual(["行业", "概念", "地域"]);
  });

  it("口径取显示名，认不出来就退回原值", () => {
    expect(boardKindLabel("industry")).toBe("行业");
    expect(boardKindLabel("concept")).toBe("概念");
    expect(boardKindLabel("region")).toBe("地域");
  });
});

describe("板块：领涨 / 领跌", () => {
  it("领涨股自己在跌时说「领跌」", () => {
    expect(leaderTag(-1.46)).toBe("领跌");
    expect(leaderTag(-0.01)).toBe("领跌");
  });

  it("涨的、平的说「领涨」", () => {
    expect(leaderTag(6.42)).toBe("领涨");
    expect(leaderTag(0)).toBe("领涨");
  });

  it("拿不到涨跌幅（接口给 \"-\"）时按数据源自己的叫法说「领涨」", () => {
    expect(leaderTag(null)).toBe("领涨");
    expect(leaderTag(undefined)).toBe("领涨");
  });
});

describe("板块：搜索", () => {
  const full = (name: string, code: string, pct = 1): Board => ({
    secid: `90.${code}`,
    code,
    name,
    pct,
    price: 1,
    leader: null,
    leaderPct: null,
  });

  it("按名字包含匹配，空关键词原样返回", () => {
    const list = [b("航天航空", 5.4), b("空间站概念", 4.7), b("食品饮料", 0.6)];

    expect(names(searchBoards(list, ""))).toEqual(names(list));
    expect(names(searchBoards(list, "   "))).toEqual(names(list));
    expect(names(searchBoards(list, "航天"))).toEqual(["航天航空"]);
    expect(names(searchBoards(list, "站"))).toEqual(["空间站概念"]);
    expect(names(searchBoards(list, "饮料"))).toEqual(["食品饮料"]);
    expect(names(searchBoards(list, "宁德时代"))).toEqual([]);
  });

  it("代码也能搜，不区分大小写", () => {
    const list = [full("航天航空", "BK0480"), full("食品饮料", "BK0437")];

    expect(names(searchBoards(list, "bk0480"))).toEqual(["航天航空"]);
    expect(names(searchBoards(list, "BK04"))).toEqual(["航天航空", "食品饮料"]);
    expect(names(searchBoards(list, "pt018"))).toEqual([]);
  });

  it("boardRows：先按关键词筛、再过滤细分、最后排序", () => {
    const list = [full("白酒", "BK0001", 1.1), full("白酒Ⅱ", "BK0002", 3.3), full("啤酒", "BK0003", 2.2)];

    expect(names(boardRows(list, { showSubs: false, order: "up", query: "酒" }))).toEqual(["啤酒", "白酒"]);
    expect(names(boardRows(list, { showSubs: true, order: "up", query: "酒" }))).toEqual([
      "白酒Ⅱ",
      "啤酒",
      "白酒",
    ]);
    // 不传 query 时行为与以前一样（全量）
    expect(names(boardRows(list, { showSubs: true, order: "up" }))).toEqual(["白酒Ⅱ", "啤酒", "白酒"]);
  });
});
