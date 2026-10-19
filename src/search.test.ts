// 搜索结果的点击去向：纯逻辑，界面（main.ts）只负责照着做。
// 「点行 = 加入自选」已经拆成两件事：点右边那颗 ＋ 才是加入，点行本身是「先看看」。
import { describe, expect, it } from "vitest";
import { filterToReveal, hitAction } from "./search";
import { INDICES, type Group } from "./settings";

const WATCH = ["1.600519", "0.300750"];
const GROUPS: Group[] = [
  { id: "ai", name: "AI" },
  { id: "hk", name: "港股" },
];
/** 内置的大盘指数（上证 / 深证 / 创业板） */
const IDX = INDICES[0].secid;

describe("搜索结果：点行与点 ＋ 各去哪", () => {
  it("点右边的 ＋ 才是加入自选", () => {
    expect(hitAction("0.000001", WATCH, true)).toBe("add");
  });

  it("点 ＋ 但已经加过：什么都不做（别被当成点行去预览）", () => {
    expect(hitAction("1.600519", WATCH, true)).toBe("none");
  });

  it("点 ＋ 但是大盘指数：加不进去（与 MCP 的 add 同一条规则）", () => {
    expect(hitAction(IDX, WATCH, true)).toBe("none");
  });

  it("点行本身：还没加的只预览，不加进自选", () => {
    expect(hitAction("0.000001", WATCH, false)).toBe("preview");
  });

  it("点行本身：已经在自选里就跳过去", () => {
    expect(hitAction("1.600519", WATCH, false)).toBe("jump");
  });

  it("大盘指数点行也只是预览：它不在自选里，但分时照样能看", () => {
    expect(hitAction(IDX, WATCH, false)).toBe("preview");
  });
});

describe("搜索结果：跳过去时该看哪个分组", () => {
  it("在「全部」里：哪儿都不去", () => {
    expect(filterToReveal("1.600519", {}, GROUPS, null)).toBeNull();
  });

  it("正在看的分组里就有它：不切", () => {
    expect(filterToReveal("0.300750", { "0.300750": "ai" }, GROUPS, "ai")).toBe("ai");
  });

  it("它落在别的分组里：切到那个分组", () => {
    expect(filterToReveal("0.300750", { "0.300750": "ai" }, GROUPS, "hk")).toBe("ai");
  });

  it("它没有归属（或指向已删的分组）：回「全部」", () => {
    expect(filterToReveal("1.600519", {}, GROUPS, "ai")).toBeNull();
    expect(filterToReveal("1.600519", { "1.600519": "gone" }, GROUPS, "ai")).toBeNull();
  });
});
