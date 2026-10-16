import { beforeEach, describe, expect, it } from "vitest";
import {
  BAR_MAX,
  DEFAULTS,
  GROUP_NAME_MAX,
  STORE_KEY,
  UNGROUPED,
  addToBar,
  applySearchAction,
  clampBlock,
  dropGroupOf,
  groupIdOf,
  groupNameOf,
  groupTargets,
  groupTargetsFor,
  itemsOf,
  loadSettings,
  loadTickerPos,
  moveInView,
  moveItem,
  newGroup,
  normalizeGroups,
  normalizePins,
  pinCount,
  pinItem,
  removeGroup,
  renameGroup,
  saveSettings,
  saveTickerPos,
  searchActions,
  setGroup,
  setGroupMany,
  trimGroupName,
  unpinItem,
} from "./settings";

const put = (v: unknown) => localStorage.setItem(STORE_KEY, typeof v === "string" ? v : JSON.stringify(v));

describe("loadSettings", () => {
  beforeEach(() => localStorage.clear());

  it("空存储返回默认值", () => {
    expect(loadSettings()).toEqual(DEFAULTS);
  });

  it("损坏的 JSON 按默认值处理", () => {
    put("{not json");
    expect(loadSettings()).toEqual(DEFAULTS);
  });

  it("旧版 pinned 迁移为 bar 列表", () => {
    put({ watchlist: ["0.300750"], pinned: "0.300750" });
    const s = loadSettings();
    expect(s.bar).toEqual(["0.300750"]);
    expect("pinned" in s).toBe(false);
  });

  it("旧版 pinned 为空时 bar 为空", () => {
    put({ watchlist: ["0.300750"], pinned: null });
    expect(loadSettings().bar).toEqual([]);
  });

  it("bar 只保留自选或大盘指数，且不超过 BAR_MAX", () => {
    put({ watchlist: ["1.600519", "0.300750"], bar: ["9.999", "1.000001", "1.600519", "0.300750", "0.399001"] });
    const s = loadSettings();
    expect(s.bar).toEqual(["1.000001", "1.600519", "0.300750", "0.399001"]);
    expect(s.bar.length).toBeLessThanOrEqual(BAR_MAX);
  });

  it("bar 超过 BAR_MAX 时只保留前 BAR_MAX 只", () => {
    const ids = Array.from({ length: BAR_MAX + 2 }, (_, i) => `1.${600000 + i}`);
    put({ watchlist: ids, bar: ids });
    expect(loadSettings().bar).toEqual(ids.slice(0, BAR_MAX));
  });

  it("barFields 为空时恢复默认字段", () => {
    put({ barFields: [] });
    expect(loadSettings().barFields).toEqual(DEFAULTS.barFields);
  });

  it("旧数据没有 mcp 字段时默认关闭", () => {
    put({ watchlist: ["0.300750"] });
    expect(loadSettings().mcp).toBe(false);
  });

  it("mcp 打开的状态会被保留，写坏的值回到默认", () => {
    put({ mcp: true });
    expect(loadSettings().mcp).toBe(true);
    put({ mcp: "no" });
    expect(loadSettings().mcp).toBe(DEFAULTS.mcp);
  });

  it("旧数据没有 updateCheck 字段时默认开启，写坏的值回到默认", () => {
    put({ watchlist: ["0.300750"] });
    expect(loadSettings().updateCheck).toBe(true);
    put({ updateCheck: false });
    expect(loadSettings().updateCheck).toBe(false);
    put({ updateCheck: "yes" });
    expect(loadSettings().updateCheck).toBe(DEFAULTS.updateCheck);
  });

  it("saveSettings 写入后能原样读回", () => {
    const s = { ...DEFAULTS, interval: 30, theme: "dark" as const };
    saveSettings(s);
    expect(loadSettings()).toEqual(s);
  });

  it("旧数据没有分组字段时按「没有分组」处理", () => {
    put({ watchlist: ["1.600519", "0.300750"] });
    const s = loadSettings();
    expect(s.groups).toEqual([]);
    expect(s.groupOf).toEqual({});
  });

  it("分组与归属原样读回，失效的归属丢掉", () => {
    put({
      watchlist: ["1.600519", "0.300750"],
      groups: [{ id: "g1", name: "工作" }],
      // 0.300750 指向已不存在的 g9，9.999 已不在自选里
      groupOf: { "1.600519": "g1", "0.300750": "g9", "9.999": "g1" },
    });
    const s = loadSettings();
    expect(s.groups).toEqual([{ id: "g1", name: "工作" }]);
    expect(s.groupOf).toEqual({ "1.600519": "g1" });
  });

  it("分组一起存下后能原样读回", () => {
    const s = { ...DEFAULTS, groups: [{ id: "g1", name: "工作" }], groupOf: { "1.600519": "g1" } };
    saveSettings(s);
    expect(loadSettings()).toEqual(s);
  });

  it("置顶重排只动顺序，分组归属与 bar 都不受影响", () => {
    put({
      watchlist: ["1.600519", "0.300750", "116.00700"],
      pins: ["116.00700"],
      bar: ["116.00700"],
      groups: [{ id: "g1", name: "工作" }],
      groupOf: { "1.600519": "g1" },
    });
    const s = loadSettings();
    expect(s.watchlist).toEqual(["116.00700", "1.600519", "0.300750"]);
    expect(s.groupOf).toEqual({ "1.600519": "g1" });
    expect(s.groups).toEqual([{ id: "g1", name: "工作" }]);
    expect(s.bar).toEqual(["116.00700"]);
  });
  it("置顶的排到最前，pins 里已不在自选的 id 丢掉", () => {
    put({ watchlist: ["a", "b", "c"], pins: ["c", "zzz"] });
    const s = loadSettings();
    expect(s.watchlist).toEqual(["c", "a", "b"]);
    expect(s.pins).toEqual(["c"]);
  });

  it("pins 不是数组时按空处理，自选顺序保持原样", () => {
    put({ watchlist: ["a", "b"], pins: "bad" });
    const s = loadSettings();
    expect(s.watchlist).toEqual(["a", "b"]);
    expect(s.pins).toEqual([]);
  });

});

describe("悬浮行情条位置", () => {
  beforeEach(() => localStorage.clear());

  it("旧数据没有 ticker 字段时默认开启", () => {
    put({ watchlist: ["1.600519"] });
    expect(loadSettings().ticker).toBe(true);
  });

  it("未保存时返回 null", () => {
    expect(loadTickerPos()).toBeNull();
  });

  it("保存后读回取整坐标，支持副屏负坐标", () => {
    saveTickerPos(-1200.4, 860.6);
    expect(loadTickerPos()).toEqual({ x: -1200, y: 861 });
  });

  it("损坏或缺字段的数据按 null 处理", () => {
    localStorage.setItem("stockbar.ticker.pos", "{bad");
    expect(loadTickerPos()).toBeNull();
    localStorage.setItem("stockbar.ticker.pos", JSON.stringify({ x: 1 }));
    expect(loadTickerPos()).toBeNull();
  });

  it("位置不写入设置存储（拖动不触发设置同步）", () => {
    saveTickerPos(10, 20);
    expect(localStorage.getItem(STORE_KEY)).toBeNull();
  });
});

describe("addToBar", () => {
  it("按传入顺序填满剩余名额，放不下的进 overflow", () => {
    const r = addToBar(["1.600519"], ["0.300750", "116.00700", "105.NVDA"], 3);
    expect(r.bar).toEqual(["1.600519", "0.300750", "116.00700"]);
    expect(r.added).toEqual(["0.300750", "116.00700"]);
    expect(r.overflow).toEqual(["105.NVDA"]);
  });

  it("已在菜单栏里的标的跳过，且不算放不下", () => {
    const r = addToBar(["1.600519"], ["1.600519", "0.300750"], 3);
    expect(r.added).toEqual(["0.300750"]);
    expect(r.overflow).toEqual([]);
  });

  it("名额已满时全部进 overflow", () => {
    const r = addToBar(["a", "b", "c"], ["d"], 3);
    expect(r.bar).toEqual(["a", "b", "c"]);
    expect(r.added).toEqual([]);
    expect(r.overflow).toEqual(["d"]);
  });

  it("不改动传入的原列表", () => {
    const bar = ["a"];
    addToBar(bar, ["b"]);
    expect(bar).toEqual(["a"]);
  });
});

describe("moveItem", () => {
  it("向后移动", () => {
    expect(moveItem(["a", "b", "c"], 0, 2)).toEqual(["b", "c", "a"]);
  });

  it("向前移动", () => {
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
  });

  it("原地不动或越界时原样返回副本", () => {
    const list = ["a", "b"];
    expect(moveItem(list, 1, 1)).toEqual(list);
    expect(moveItem(list, 0, 5)).toEqual(list);
    expect(moveItem(list, -1, 0)).toEqual(list);
    expect(moveItem(list, 0, 1)).not.toBe(list);
  });
});

describe("置顶", () => {
  it("pinCount 只数开头连续被置顶的", () => {
    expect(pinCount(["a", "b", "c"], ["a", "b"])).toBe(2);
    expect(pinCount(["a", "b", "c"], ["b"])).toBe(0);
    expect(pinCount([], ["a"])).toBe(0);
  });

  it("pinItem 把标的挪到最前并记进 pins", () => {
    const r = pinItem(["a", "b", "c"], [], "c");
    expect(r.list).toEqual(["c", "a", "b"]);
    expect(r.pins).toEqual(["c"]);
  });

  it("pinItem 对已置顶或不在自选里的 id 原样返回副本", () => {
    const list = ["a", "b"];
    const pins = ["a"];
    expect(pinItem(list, pins, "a")).toEqual({ list, pins });
    expect(pinItem(list, pins, "zzz")).toEqual({ list, pins });
    expect(pinItem(list, pins, "a").list).not.toBe(list);
  });

  it("unpinItem 落到置顶区之后的第一位", () => {
    // a、b 置顶；取消 a 后 a 落在还置顶着的 b 后面
    const r = unpinItem(["a", "b", "c"], ["a", "b"], "a");
    expect(r.list).toEqual(["b", "a", "c"]);
    expect(r.pins).toEqual(["b"]);
  });

  it("unpinItem 对没置顶的 id 原样返回副本", () => {
    const list = ["a", "b"];
    const r = unpinItem(list, [], "a");
    expect(r.list).toEqual(list);
    expect(r.list).not.toBe(list);
  });

  it("normalizePins 把置顶的排到最前并清掉失效 id", () => {
    const r = normalizePins(["a", "b", "c"], ["c", "zzz"]);
    expect(r.list).toEqual(["c", "a", "b"]);
    expect(r.pins).toEqual(["c"]);
  });

  it("clampBlock：置顶的只能在置顶区里挪", () => {
    const list = ["a", "b", "c", "d"];
    const pins = ["a", "b"];
    expect(clampBlock(list, pins, 0, 3)).toBe(1); // 置顶的往下最多到置顶区末尾
    expect(clampBlock(list, pins, 1, 0)).toBe(0);
    expect(clampBlock(list, pins, 3, 0)).toBe(2); // 非置顶的往上最多到置顶区之后
    expect(clampBlock(list, pins, 2, 3)).toBe(3);
  });

  it("clampBlock：没有置顶时只受列表边界限制", () => {
    const list = ["a", "b", "c"];
    expect(clampBlock(list, [], 2, 0)).toBe(0);
    expect(clampBlock(list, [], 0, 2)).toBe(2);
  });

  it("clampBlock：全都置顶时可以在整列里挪", () => {
    const list = ["a", "b", "c"];
    const pins = ["a", "b", "c"];
    expect(clampBlock(list, pins, 0, 2)).toBe(2);
    expect(clampBlock(list, pins, 2, 0)).toBe(0);
  });
});

describe("自选分组", () => {
  const groups = [
    { id: "g1", name: "工作" },
    { id: "g2", name: "长线" },
  ];
  const list = ["a", "b", "c", "d"];
  /** a、c 在 g1，d 在 g2，b 没归属 */
  const groupOf = { a: "g1", c: "g1", d: "g2" };

  it("itemsOf 按整表顺序取某个分组，未分组传 UNGROUPED", () => {
    expect(itemsOf(list, groupOf, groups, "g1")).toEqual(["a", "c"]);
    expect(itemsOf(list, groupOf, groups, "g2")).toEqual(["d"]);
    expect(itemsOf(list, groupOf, groups, UNGROUPED)).toEqual(["b"]);
    expect(itemsOf(list, groupOf, groups, "zz")).toEqual([]);
  });

  it("groupIdOf 对已删除的分组回落到未分组", () => {
    expect(groupIdOf(groupOf, groups, "a")).toBe("g1");
    expect(groupIdOf(groupOf, [groups[1]], "a")).toBe(UNGROUPED);
    expect(groupIdOf(groupOf, groups, "b")).toBe(UNGROUPED);
  });

  it("groupNameOf 认得未分组，分组已被删也回落到未分组", () => {
    expect(groupNameOf(groups, "g2")).toBe("长线");
    expect(groupNameOf(groups, UNGROUPED)).toBe("未分组");
    expect(groupNameOf(groups, "zz")).toBe("未分组");
  });

  it("moveInView 把分组视图里的先后写回整表，其他分组的相对顺序不动", () => {
    // 视图 g1 = [a, c] 对应整表第 0、2 位：往后挪 a，b 就被挤到前面
    expect(moveInView(list, ["a", "c"], 0, 1)).toEqual(["b", "c", "a", "d"]);
    expect(moveInView(list, ["a", "c"], 1, 0)).toEqual(["c", "a", "b", "d"]);
    const moved = moveInView(list, ["b", "d"], 1, 0);
    expect(moved).toEqual(["a", "d", "b", "c"]);
    expect(itemsOf(moved, groupOf, groups, "g1")).toEqual(["a", "c"]);
    expect(itemsOf(moved, groupOf, groups, UNGROUPED)).toEqual(["b"]);
  });

  it("moveInView 越界或视图对不上时原样返回副本", () => {
    expect(moveInView(list, ["a", "c"], 0, 5)).toEqual(list);
    expect(moveInView(list, [], 0, 1)).toEqual(list);
    expect(moveInView(list, ["a"], 0, 1)).toEqual(list);
    expect(moveInView(list, ["a"], 0, 1)).not.toBe(list);
  });

  it("分组视图里的置顶区：置顶的挪不出去，下标换算回整表也不影响别的分组", () => {
    const list2 = ["b", "a", "d", "c"]; // b 置顶且在 g1，d 在 g2
    const pins = ["b"];
    const of = { b: "g1", a: "g1", c: "g1", d: "g2" };
    const view = itemsOf(list2, of, groups, "g1");
    expect(view).toEqual(["b", "a", "c"]);
    expect(clampBlock(view, pins, 0, 2)).toBe(0); // 置顶的往下只能到置顶区末尾（原地）
    expect(clampBlock(view, pins, 2, 0)).toBe(1); // 没置顶的往上只能到置顶区之后
    const moved = moveInView(list2, view, 2, clampBlock(view, pins, 2, 0));
    expect(moved).toEqual(["b", "c", "a", "d"]);
    expect(itemsOf(moved, of, groups, "g2")).toEqual(["d"]);
  });

  it("setGroup 移入分组 / 移回未分组，都不改原对象", () => {
    const of = { a: "g1" };
    expect(setGroup(of, "b", "g2")).toEqual({ a: "g1", b: "g2" });
    expect(setGroup(of, "a", UNGROUPED)).toEqual({});
    expect(of).toEqual({ a: "g1" });
  });

  it("dropGroupOf 只清指定标的的归属", () => {
    expect(dropGroupOf({ a: "g1", b: "g2" }, ["a"])).toEqual({ b: "g2" });
    expect(dropGroupOf({ a: "g1" }, ["zzz"])).toEqual({ a: "g1" });
  });

  it("groupTargets 去掉标的当前所在的分组", () => {
    expect(groupTargets(groups, groupOf, "a").map((t) => t.gid)).toEqual([UNGROUPED, "g2"]);
    expect(groupTargets(groups, groupOf, "b").map((t) => t.gid)).toEqual(["g1", "g2"]);
  });

  it("setGroupMany 批量移入 / 批量移回未分组，都不改原对象", () => {
    const of = { a: "g1" };
    expect(setGroupMany(of, ["b", "c"], "g2")).toEqual({ a: "g1", b: "g2", c: "g2" });
    expect(setGroupMany(of, ["a", "zzz"], UNGROUPED)).toEqual({});
    expect(of).toEqual({ a: "g1" });
  });

  it("groupTargetsFor 标出已经全在那个分组的目标", () => {
    // a、c 都在 g1：整批移入的话 g1 是「已全在」，未分组不是
    expect(groupTargetsFor(groups, groupOf, ["a", "c"]).map((t) => [t.gid, t.done])).toEqual([
      [UNGROUPED, false],
      ["g1", true],
      ["g2", false],
    ]);
    // 只选没归属的 b：未分组成「已全在」
    expect(groupTargetsFor(groups, groupOf, ["b"]).map((t) => [t.gid, t.done])).toEqual([
      [UNGROUPED, true],
      ["g1", false],
      ["g2", false],
    ]);
  });

  it("groupTargetsFor 没有可用目标时全是 done（界面据此禁用入口）", () => {
    expect(groupTargetsFor([], {}, ["a"]).map((t) => t.done)).toEqual([true]);
    expect(groupTargetsFor(groups, groupOf, [])).toEqual([]);
  });

  it("newGroup 的 id 取已用过的最大序号 +1，名字不撞已有分组", () => {
    expect(newGroup([])).toEqual({ id: "g1", name: "新分组" });
    expect(newGroup([{ id: "g1", name: "新分组" }, { id: "g3", name: "工作" }])).toEqual({
      id: "g4",
      name: "新分组 2",
    });
  });

  it("删掉最大序号后新分组会再用这个序号，但归属已随删除清掉", () => {
    const two = [{ id: "g1", name: "工作" }, { id: "g2", name: "长线" }];
    const after = removeGroup(two, { a: "g2" }, "g2");
    expect(after.groupOf).toEqual({});
    expect(newGroup(after.groups).id).toBe("g2");
  });

  it("renameGroup 去空白并按上限截断，空名字视为放弃", () => {
    expect(renameGroup(groups, "g1", "  短线  ")).toEqual([{ id: "g1", name: "短线" }, groups[1]]);
    expect(renameGroup(groups, "g1", "一二三四五六七八九十十一十二十三")[0].name.length).toBe(GROUP_NAME_MAX);
    expect(renameGroup(groups, "g1", "   ")).toEqual(groups); // 空名字放弃
    expect(renameGroup(groups, "zz", "短线")).toEqual(groups); // 分组不存在：原样
  });

  it("trimGroupName 按字符（码点）截断，不会把 emoji 劈成半个", () => {
    expect(trimGroupName("  短线 ")).toBe("短线");
    expect(trimGroupName("   ")).toBe("");
    const cut = trimGroupName("🌱".repeat(20));
    expect(cut).toBe("🌱".repeat(GROUP_NAME_MAX)); // 按 UTF-16 长度切会只剩 6 个
    expect([...cut].length).toBe(GROUP_NAME_MAX);
  });

  it("removeGroup 只删分组，成员回落到未分组", () => {
    const r = removeGroup(groups, groupOf, "g1");
    expect(r.groups).toEqual([groups[1]]);
    expect(r.groupOf).toEqual({ d: "g2" });
    expect(itemsOf(list, r.groupOf, r.groups, UNGROUPED)).toEqual(["a", "b", "c"]);
  });

  it("normalizeGroups 丢掉形状不对的分组与失效归属", () => {
    const r = normalizeGroups(
      ["a", "b"],
      [
        { id: "g1", name: " 工作 " },
        { id: "g1", name: "重复 id" },
        { id: "bad id", name: "非法 id" },
        { id: "g2", name: "   " },
        { id: 3, name: "id 不是字符串" },
        "不是对象",
      ],
      { a: "g1", b: "g2", nope: "g1", c: "zzz" },
    );
    expect(r.groups).toEqual([{ id: "g1", name: "工作" }]);
    expect(r.groupOf).toEqual({ a: "g1" });
  });

  it("normalizeGroups 对非数组 / 非对象的入参按空处理", () => {
    expect(normalizeGroups(["a"], "bad", 7)).toEqual({ groups: [], groupOf: {} });
    expect(normalizeGroups(["a"], null, null)).toEqual({ groups: [], groupOf: {} });
  });
});

describe("searchActions", () => {
  const groups = [
    { id: "g1", name: "工作" },
    { id: "g2", name: "长线" },
  ];
  /** a 在 g1，b 没归属 */
  const groupOf = { a: "g1" };
  const list = ["a", "b"];

  it("结果还不是自选：给「加入自选」，建过分组时再给每个分组一项「加入并移入」", () => {
    expect(searchActions(groups, groupOf, list, [], "116.00700")).toEqual([
      { kind: "add", label: "加入自选" },
      { kind: "addToGroup", gid: "g1", label: "加入并移入「工作」" },
      { kind: "addToGroup", gid: "g2", label: "加入并移入「长线」" },
    ]);
  });

  it("还没建过分组时只给「加入自选」，不出现分组项", () => {
    expect(searchActions([], {}, list, [], "116.00700")).toEqual([{ kind: "add", label: "加入自选" }]);
  });

  it("已经是自选：给当前分组之外的目标 + 置顶（未置顶时）", () => {
    expect(searchActions(groups, groupOf, list, [], "a")).toEqual([
      { kind: "moveToGroup", gid: UNGROUPED, label: "移入「未分组」" },
      { kind: "moveToGroup", gid: "g2", label: "移入「长线」" },
      { kind: "pin", label: "置顶" },
    ]);
    // b 没归属，所以「未分组」不出现，改出现「工作」
    expect(searchActions(groups, groupOf, list, [], "b").map((a) => a.gid ?? a.kind)).toEqual([
      "g1",
      "g2",
      "pin",
    ]);
  });

  it("已经置顶的自选给「取消置顶」", () => {
    const acts = searchActions(groups, groupOf, list, ["b"], "b");
    expect(acts[acts.length - 1]).toEqual({ kind: "unpin", label: "取消置顶" });
  });

  it("内置的大盘指数没有菜单：不加自选、也不分组与置顶（与 MCP 同一条规则）", () => {
    expect(searchActions(groups, groupOf, list, [], "1.000001")).toEqual([]);
    // 万一被塞进自选了，也不该给它分组 / 置顶的入口
    expect(searchActions(groups, groupOf, ["1.000001"], [], "1.000001")).toEqual([]);
  });
});

describe("applySearchAction", () => {
  const groups = [{ id: "g1", name: "工作" }];
  const state = () => ({ watchlist: ["a", "b"], pins: ["a"], groupOf: { a: "g1" } as Record<string, string> });

  it("加入自选：追加到末尾，不动原对象", () => {
    const s = state();
    expect(applySearchAction(s, groups, "c", { kind: "add", label: "加入自选" })).toEqual({
      watchlist: ["a", "b", "c"],
      pins: ["a"],
      groupOf: { a: "g1" },
    });
    expect(s.watchlist).toEqual(["a", "b"]); // 入参没被改
  });

  it("加入并移入分组：一次把加入与归属都做完", () => {
    expect(applySearchAction(state(), groups, "c", { kind: "addToGroup", gid: "g1", label: "" }).groupOf).toEqual({
      a: "g1",
      c: "g1",
    });
  });

  it("加入自选重复执行不会加两遍", () => {
    const once = applySearchAction(state(), groups, "b", { kind: "add", label: "" });
    expect(once.watchlist).toEqual(["a", "b"]);
  });

  it("移入分组：改归属，未分组就清掉归属", () => {
    expect(applySearchAction(state(), groups, "b", { kind: "moveToGroup", gid: "g1", label: "" }).groupOf).toEqual({
      a: "g1",
      b: "g1",
    });
    expect(applySearchAction(state(), groups, "a", { kind: "moveToGroup", gid: UNGROUPED, label: "" }).groupOf).toEqual(
      {},
    );
  });

  it("目标分组已经不存在时按未分组处理", () => {
    expect(applySearchAction(state(), groups, "b", { kind: "moveToGroup", gid: "gone", label: "" }).groupOf).toEqual({
      a: "g1",
    });
  });

  it("置顶把标的挪到最前并记进 pins，取消置顶再挪出来", () => {
    const pinned = applySearchAction(state(), groups, "b", { kind: "pin", label: "" });
    expect(pinned.watchlist).toEqual(["b", "a"]);
    expect(pinned.pins).toEqual(["a", "b"]);
    const off = applySearchAction(pinned, groups, "b", { kind: "unpin", label: "" });
    expect(off.pins).toEqual(["a"]);
    expect(off.watchlist).toEqual(["a", "b"]);
  });

  it("指数不加：任何动作都原样返回", () => {
    const s = { watchlist: ["a"], pins: [] as string[], groupOf: {} as Record<string, string> };
    expect(applySearchAction(s, groups, "1.000001", { kind: "add", label: "" })).toEqual(s);
    expect(applySearchAction(s, groups, "1.000001", { kind: "addToGroup", gid: "g1", label: "" })).toEqual(s);
  });

  it("菜单点下去时标的已不在自选里：不留下指向它的分组归属", () => {
    // 菜单是点开那一刻渲染的，点之前标的可能已经在别的窗口 / MCP 里被删掉了
    expect(applySearchAction(state(), groups, "gone", { kind: "moveToGroup", gid: "g1", label: "" }).groupOf).toEqual({
      a: "g1",
    });
  });
});
