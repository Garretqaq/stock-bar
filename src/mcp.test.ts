import { describe, expect, it } from "vitest";
import type { Quote, SearchItem } from "./api";
import { McpError, prepareCommand, runCommand, type McpDeps } from "./mcp";
import { BAR_MAX, DEFAULTS, UNGROUPED, isIndex, pinCount, type Settings } from "./settings";

/** 测试用的底子：只有两只自选，分组为空，菜单栏放一只 */
const base = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULTS,
  watchlist: ["1.600519", "0.300750"],
  pins: [],
  groups: [],
  groupOf: {},
  selected: "1.600519",
  bar: ["1.600519"],
  ...over,
});

const QUOTES: Record<string, [string, number, number]> = {
  "1.600519": ["贵州茅台", 1680.5, 1.23],
  "0.300750": ["宁德时代", 187.3, -0.51],
  "105.NVDA": ["英伟达", 120.1, 2.4],
  "116.00700": ["腾讯控股", 380.2, 0.8],
};

const SEARCH: Record<string, SearchItem[]> = {
  茅台: [{ secid: "1.600519", code: "600519", name: "贵州茅台", type: "沪A" }],
  NVDA: [
    { secid: "105.NVDA", code: "NVDA", name: "英伟达", type: "美股" },
    { secid: "106.NVDA", code: "NVDA", name: "英伟达(ADR)", type: "美股" },
  ],
  茅台酒: [
    { secid: "1.600519", code: "600519", name: "贵州茅台", type: "沪A" },
    { secid: "0.000858", code: "000858", name: "五粮液", type: "深A" },
  ],
  没有: [],
};

const quoteOf = (secid: string): Quote => {
  const [name, price, pct] = QUOTES[secid];
  return { secid, code: secid.split(".")[1], market: Number(secid.split(".")[0]), name, price, change: null, pct, time: null, amount: null };
};

const deps = (over: Partial<McpDeps> = {}): McpDeps => ({
  search: async (kw) => SEARCH[kw] ?? [],
  quotes: async (ids) => new Map(ids.filter((id) => QUOTES[id]).map((id) => [id, quoteOf(id)])),
  ...over,
});

const run = (s: Settings, op: string, args: Record<string, unknown> = {}, d?: McpDeps) =>
  runCommand(s, op, args, d ?? deps());

/** 报价接口整个挂掉（断网） */
const offline = deps({
  quotes: async () => {
    throw new Error("network down");
  },
});

/** 报价正常返回，但没有这只标的（代码是编的） */
const unknown = deps({ quotes: async () => new Map() });

describe("MCP 命令：查看自选", () => {
  it("按分组列出，带上名称、涨跌、置顶与菜单栏名额", async () => {
    const s = base({
      watchlist: ["0.300750", "1.600519", "105.NVDA"],
      pins: ["0.300750"],
      groups: [{ id: "g1", name: "持仓" }],
      groupOf: { "1.600519": "g1" },
    });
    const r = await run(s, "watchlist.list");
    expect(r.changed).toBe(false);
    expect(r.text).toContain("未分组（2 只）");
    expect(r.text).toContain("- 0.300750 宁德时代 · 187.30 -0.51% · 第 1 位 · 置顶");
    expect(r.text).toContain("持仓 (g1)（1 只）");
    expect(r.text).toContain("- 1.600519 贵州茅台 · 1680.50 +1.23%");
    expect(r.text).toContain("菜单栏显示（1/3）：1.600519 贵州茅台");
    expect(r.text).toContain("大盘指数（内置，不可增删）");
    const data = r.data as { groups: { id: string; items: { secid: string }[] }[] };
    expect(data.groups.map((g) => g.id)).toEqual([UNGROUPED, "g1"]);
    expect(data.groups[0].items.map((i) => i.secid)).toEqual(["0.300750", "105.NVDA"]);
  });

  it("报价拿不到时只给 secid，不影响列出", async () => {
    const r = await run(base(), "watchlist.list", {}, offline);
    expect(r.text).toContain("- 1.600519");
    expect(r.text).not.toContain("贵州茅台");
  });
});

describe("MCP 命令：搜索", () => {
  it("列出候选与 secid", async () => {
    const r = await run(base(), "instrument.search", { keyword: "NVDA" });
    expect(r.changed).toBe(false);
    expect(r.text).toContain("105.NVDA 英伟达");
    expect(r.text).toContain("106.NVDA 英伟达(ADR)");
  });

  it("搜不到就给提示", async () => {
    const r = await run(base(), "instrument.search", { keyword: "没有" });
    expect(r.text).toContain("没搜到");
  });

  it("缺关键词报错", async () => {
    await expect(run(base(), "instrument.search", {})).rejects.toThrow(/缺少参数/);
  });
});

describe("MCP 命令：加入自选", () => {
  it("按 secid 加入末尾，默认未分组", async () => {
    const r = await run(base(), "watchlist.add", { target: "105.NVDA" });
    expect(r.changed).toBe(true);
    expect(r.settings.watchlist).toEqual(["1.600519", "0.300750", "105.NVDA"]);
    expect(r.settings.groupOf).toEqual({});
    expect(r.text).toContain("已加入自选：105.NVDA 英伟达");
    expect(r.text).toContain("自选第 3 位 / 共 3 只");
  });

  it("按关键词唯一命中", async () => {
    const r = await run(base(), "watchlist.add", { target: "茅台" });
    expect(r.settings.watchlist).toContain("1.600519");
    expect(r.text).toContain("已在自选里");
  });

  it("关键词命中多只时列出候选让对方用 secid 再问", async () => {
    await expect(run(base(), "watchlist.add", { target: "茅台酒" })).rejects.toThrow(
      /匹配到多只标的，请用 secid 指定其中一只：1.600519 贵州茅台、0.000858 五粮液/,
    );
  });

  it("搜不到报错", async () => {
    await expect(run(base(), "watchlist.add", { target: "没有" })).rejects.toThrow(/没搜到/);
  });

  it("内置大盘指数不能加入", async () => {
    await expect(run(base(), "watchlist.add", { target: "1.000001" })).rejects.toThrow(/内置的大盘指数/);
  });

  it("代码查不到行情时拒绝加入", async () => {
    await expect(run(base(), "watchlist.add", { target: "1.999999" }, unknown)).rejects.toThrow(/查不到 1.999999 的行情/);
  });

  it("报价接口不可用时仍然加入，并说明没校验", async () => {
    const r = await run(base(), "watchlist.add", { target: "105.NVDA" }, offline);
    expect(r.settings.watchlist).toContain("105.NVDA");
    expect(r.text).toContain("未能校验该代码");
  });

  it("可以边加边放进已存在的分组", async () => {
    const s = base({ groups: [{ id: "g1", name: "持仓" }] });
    const r = await run(s, "watchlist.add", { target: "105.NVDA", group: "持仓" });
    expect(r.settings.groupOf).toEqual({ "105.NVDA": "g1" });
    expect(r.text).toContain("分组「持仓」");
  });

  it("已在自选里且指定分组时只改分组", async () => {
    const s = base({ groups: [{ id: "g1", name: "持仓" }] });
    const r = await run(s, "watchlist.add", { target: "1.600519", group: "g1" });
    expect(r.settings.watchlist).toEqual(["1.600519", "0.300750"]);
    expect(r.settings.groupOf).toEqual({ "1.600519": "g1" });
    expect(r.text).toContain("已在自选里");
  });

  it("分组不存在时报错并列出可选分组", async () => {
    const s = base({ groups: [{ id: "g1", name: "持仓" }] });
    await expect(run(s, "watchlist.add", { target: "105.NVDA", group: "打新" })).rejects.toThrow(
      /没有「打新」这个分组。现有分组：「持仓」\(g1\)/,
    );
  });

  it("缺 target 报错", async () => {
    await expect(run(base(), "watchlist.add", {})).rejects.toThrow(/缺少参数/);
  });
});

describe("MCP 命令：移除自选", () => {
  it("置顶、分组归属、菜单栏显示一并清掉", async () => {
    const s = base({
      watchlist: ["0.300750", "1.600519"],
      pins: ["0.300750"],
      groups: [{ id: "g1", name: "持仓" }],
      groupOf: { "0.300750": "g1" },
      bar: ["0.300750", "1.600519"],
    });
    const r = await run(s, "watchlist.remove", { targets: ["0.300750"] });
    expect(r.settings.watchlist).toEqual(["1.600519"]);
    expect(r.settings.pins).toEqual([]);
    expect(r.settings.groupOf).toEqual({});
    expect(r.settings.bar).toEqual(["1.600519"]);
    expect(r.text).toContain("已从自选移除：0.300750 宁德时代");
    expect(r.text).toContain("同时移出菜单栏显示");
  });

  it("不在自选里就报错", async () => {
    await expect(run(base(), "watchlist.remove", { targets: ["105.NVDA"] })).rejects.toThrow(/105.NVDA 不在自选里/);
  });

  it("关键词只在自选里找", async () => {
    await expect(run(base(), "watchlist.remove", { targets: ["英伟达"] })).rejects.toThrow(/自选里没有「英伟达」/);
  });

  it("空数组报错", async () => {
    await expect(run(base(), "watchlist.remove", { targets: [] })).rejects.toThrow(/targets 是空的/);
  });
});

describe("MCP 命令：调整顺序与置顶", () => {
  const s = base({ watchlist: ["0.300750", "1.600519", "105.NVDA"], pins: ["0.300750"], bar: [] });

  it("非置顶标的可以往前挪", async () => {
    const r = await run(s, "watchlist.move", { target: "105.NVDA", position: 2 });
    expect(r.settings.watchlist).toEqual(["0.300750", "105.NVDA", "1.600519"]);
    expect(r.text).toContain("第 2 位");
  });

  it("置顶的标的挪不进非置顶区（落点被钳制）", async () => {
    const r = await run(s, "watchlist.move", { target: "0.300750", position: 3 });
    expect(r.settings.watchlist).toEqual(["0.300750", "1.600519", "105.NVDA"]);
    expect(r.text).toContain("第 1 位");
    expect(r.text).toContain("置顶的标的只能在置顶区内移动");
  });

  it("置顶与取消置顶", async () => {
    const on = await run(base(), "watchlist.setPin", { targets: ["0.300750"] });
    expect(on.settings.pins).toEqual(["0.300750"]);
    expect(on.settings.watchlist).toEqual(["0.300750", "1.600519"]);

    // 取消置顶：落到其余置顶项之后的第一位（与设置窗口里的行为一致）
    const off = await run(on.settings, "watchlist.setPin", { targets: ["0.300750"], pinned: false });
    expect(off.settings.pins).toEqual([]);
    expect(off.settings.watchlist).toEqual(["0.300750", "1.600519"]);
    expect(off.text).toContain("已取消置顶");

    const two = base({ watchlist: ["0.300750", "1.600519", "105.NVDA"], pins: ["0.300750", "1.600519"] });
    const off2 = await run(two, "watchlist.setPin", { targets: ["0.300750"], pinned: false });
    expect(off2.settings.watchlist).toEqual(["1.600519", "0.300750", "105.NVDA"]);
    expect(off2.settings.pins).toEqual(["1.600519"]);
  });
});

describe("MCP 命令：分组", () => {
  const grouped = base({
    groups: [
      { id: "g1", name: "持仓" },
      { id: "g2", name: "观察" },
    ],
  });

  it("批量移入分组", async () => {
    const r = await run(grouped, "watchlist.assignGroup", { targets: ["1.600519", "0.300750"], group: "持仓" });
    expect(r.settings.groupOf).toEqual({ "1.600519": "g1", "0.300750": "g1" });
    expect(r.text).toContain("移入「持仓」");
  });

  it("未分组即移出分组", async () => {
    const r = await run({ ...grouped, groupOf: { "1.600519": "g1" } }, "watchlist.assignGroup", {
      targets: ["1.600519"],
      group: "未分组",
    });
    expect(r.settings.groupOf).toEqual({});
  });

  it("新建分组：id 递增、可截断超长名字", async () => {
    const r = await run(grouped, "groups.create", { name: "打新" });
    expect(r.settings.groups.map((g) => g.id)).toEqual(["g1", "g2", "g3"]);
    expect((r.data as { groupId: string }).groupId).toBe("g3");

    const long = await run(grouped, "groups.create", { name: "非常非常非常非常长的分组名" });
    expect(long.settings.groups[2].name).toBe("非常非常非常非常长的分组名".slice(0, 12));
    expect(long.text).toContain("截断");
  });

  it("重名分组拒绝新建", async () => {
    await expect(run(grouped, "groups.create", { name: "持仓" })).rejects.toThrow(/已经有同名的分组「持仓」\(g1\)/);
  });

  it("改名：可以按名字或 id 指定分组", async () => {
    const r = await run(grouped, "groups.rename", { group: "g2", name: "长线" });
    expect(r.settings.groups.map((g) => g.name)).toEqual(["持仓", "长线"]);
    expect(r.text).toContain("已改名为「长线」");
  });

  it("改名不能撞上别的分组", async () => {
    await expect(run(grouped, "groups.rename", { group: "g2", name: "持仓" })).rejects.toThrow(/已经有同名的分组/);
  });

  it("未分组是内置的，不能改名、排序或删除", async () => {
    await expect(run(grouped, "groups.rename", { group: "未分组", name: "X" })).rejects.toThrow(/内置的/);
    await expect(run(grouped, "groups.delete", { group: "未分组" })).rejects.toThrow(/内置的/);
    await expect(run(grouped, "groups.move", { group: "未分组", position: 1 })).rejects.toThrow(/内置的/);
  });

  it("删除分组时成员回到未分组，自选一只不少", async () => {
    const r = await run({ ...grouped, groupOf: { "1.600519": "g1" } }, "groups.delete", { group: "持仓" });
    expect(r.settings.groups.map((g) => g.id)).toEqual(["g2"]);
    expect(r.settings.groupOf).toEqual({});
    expect(r.settings.watchlist).toEqual(["1.600519", "0.300750"]);
    expect(r.text).toContain("它的 1 只自选回到未分组");
  });

  it("调整分组顺序", async () => {
    const r = await run(grouped, "groups.move", { group: "观察", position: 1 });
    expect(r.settings.groups.map((g) => g.name)).toEqual(["观察", "持仓"]);
  });

  it("找不到分组时列出可选分组", async () => {
    await expect(run(grouped, "watchlist.assignGroup", { targets: ["1.600519"], group: "打新" })).rejects.toThrow(
      /现有分组：「持仓」\(g1\)、「观察」\(g2\)/,
    );
  });
});

describe("MCP 命令：未知操作", () => {
  it("不认识的 op 直接报错", async () => {
    await expect(run(base(), "watchlist.explode")).rejects.toThrow(McpError);
    await expect(run(base(), "watchlist.explode")).rejects.toThrow(/不认识的操作：watchlist.explode/);
  });
});

describe("MCP 命令：参数校验与不变量", () => {
  /** 每条改动类命令跑完都该满足的设置不变量（见 AGENTS.md 与 CONTEXT.md） */
  function assertInvariants(s: Settings): void {
    expect(new Set(s.watchlist).size).toBe(s.watchlist.length);
    expect(new Set(s.groups.map((g) => g.id)).size).toBe(s.groups.length);
    expect(new Set(s.groups.map((g) => g.name)).size).toBe(s.groups.length);
    // 置顶是自选列表的前缀；pins 的顺序无所谓（loadSettings 只认成员），只比较集合
    const n = pinCount(s.watchlist, s.pins);
    expect(n).toBe(s.pins.length);
    expect(new Set(s.watchlist.slice(0, n))).toEqual(new Set(s.pins));
    // 菜单栏只放指数与自选，且有名额上限
    for (const id of s.bar) expect(isIndex(id) || s.watchlist.includes(id)).toBe(true);
    expect(s.bar.length).toBeLessThanOrEqual(BAR_MAX);
    // 分组归属：键必须在自选里，值必须是还没删的分组
    for (const [id, gid] of Object.entries(s.groupOf)) {
      expect(s.watchlist).toContain(id);
      expect(s.groups.map((g) => g.id)).toContain(gid);
    }
  }

  it("assignGroup 漏传 group 时报错，而不是悄悄移出分组", async () => {
    const s = base({ groups: [{ id: "g1", name: "持仓" }], groupOf: { "1.600519": "g1" } });
    await expect(run(s, "watchlist.assignGroup", { targets: ["1.600519"] })).rejects.toThrow(/缺少参数/);
    await expect(run(s, "watchlist.assignGroup", { targets: ["1.600519"], group: 7 })).rejects.toThrow(/缺少参数/);
  });

  it("pinned 接受字符串与 0/1，不认识的值报错", async () => {
    const s = base({ watchlist: ["0.300750", "1.600519"], pins: ["0.300750"] });
    const off = await run(s, "watchlist.setPin", { targets: ["0.300750"], pinned: "false" });
    expect(off.settings.pins).toEqual([]);
    const again = await run(off.settings, "watchlist.setPin", { targets: ["0.300750"], pinned: "1" });
    expect(again.settings.pins).toEqual(["0.300750"]);
    await expect(run(s, "watchlist.setPin", { targets: ["0.300750"], pinned: "yes" })).rejects.toThrow(/只能是 true 或 false/);
  });

  it("secid 大小写归一：不会加出重复标的", async () => {
    const s = base({ watchlist: ["105.NVDA"] });
    const r = await run(s, "watchlist.add", { target: "105.nvda" });
    expect(r.changed).toBe(false);
    expect(r.settings.watchlist).toEqual(["105.NVDA"]);
    expect(r.text).toContain("已在自选里");
    const removed = await run(s, "watchlist.remove", { targets: ["105.nvda"] });
    expect(removed.settings.watchlist).toEqual([]);
  });

  it("市场号不认识就报错，别写进自选", async () => {
    await expect(run(base(), "watchlist.add", { target: "999.600519" })).rejects.toThrow(/不像一个能识别的 secid/);
    await expect(run(base(), "watchlist.remove", { targets: ["90.BK0475"] })).rejects.toThrow(/不像一个能识别的 secid/);
  });

  it("「未分组」不能拿来当分组名", async () => {
    await expect(run(base(), "groups.create", { name: "未分组" })).rejects.toThrow(/内置分组/);
    await expect(run(base(), "groups.create", { name: "ungrouped" })).rejects.toThrow(/内置分组/);
    const s = base({ groups: [{ id: "g1", name: "持仓" }] });
    await expect(run(s, "groups.rename", { group: "g1", name: "未分组" })).rejects.toThrow(/内置分组/);
  });

  it("分组先按 id 认：名字撞上别人的 id 时不会认错", async () => {
    const s = base({
      groups: [
        { id: "g1", name: "g2" },
        { id: "g2", name: "持仓" },
      ],
    });
    const r = await run(s, "groups.rename", { group: "g1", name: "长线" });
    expect(r.settings.groups).toEqual([
      { id: "g1", name: "长线" },
      { id: "g2", name: "持仓" },
    ]);
  });

  it("批量置顶按传入顺序排在置顶区最前", async () => {
    const s = base({ watchlist: ["1.600519", "0.300750", "105.NVDA"], bar: [] });
    const r = await run(s, "watchlist.setPin", { targets: ["105.NVDA", "0.300750"] });
    expect(r.settings.watchlist).toEqual(["105.NVDA", "0.300750", "1.600519"]);
    expect(r.text).toContain("置顶区：105.NVDA 英伟达、0.300750 宁德时代");
    assertInvariants(r.settings);
  });

  it("改动之后设置仍然自洽", async () => {
    const s = base({
      watchlist: ["0.300750", "1.600519", "105.NVDA"],
      pins: ["0.300750"],
      bar: ["0.300750", "1.600519"],
      groups: [{ id: "g1", name: "持仓" }],
      groupOf: { "1.600519": "g1" },
    });
    for (const [op, args] of [
      ["watchlist.add", { target: "116.00700", group: "持仓" }],
      ["watchlist.assignGroup", { targets: ["105.NVDA"], group: "持仓" }],
      ["watchlist.move", { target: "1.600519", position: 1 }],
      ["watchlist.setPin", { targets: ["1.600519"] }],
      ["watchlist.setPin", { targets: ["0.300750"], pinned: false }],
    ] as [string, Record<string, unknown>][]) {
      assertInvariants((await run(s, op, args)).settings);
    }
    assertInvariants((await run(s, "watchlist.remove", { targets: ["0.300750"] })).settings);
    assertInvariants((await run(s, "groups.delete", { group: "持仓" })).settings);
  });
});

describe("MCP 命令：两段式（在最新设置上执行）", () => {
  it("等待期间的其它改动不会丢", async () => {
    const before = base();
    const p = await prepareCommand(before, "watchlist.add", { target: "105.NVDA" }, deps());
    // 命令还等着报价的这段时间里，设置窗口改了主题与刷新间隔，还删了一只自选
    const meanwhile = base({ theme: "dark", interval: 30, watchlist: ["1.600519"], bar: [] });
    const r = p.apply(meanwhile);
    expect(r.settings.theme).toBe("dark");
    expect(r.settings.interval).toBe(30);
    expect(r.settings.watchlist).toEqual(["1.600519", "105.NVDA"]);
  });

  it("目标在等待期间被删掉时不再动手，并说明原因", async () => {
    const before = base({ watchlist: ["1.600519", "0.300750"] });
    const p = await prepareCommand(before, "watchlist.remove", { targets: ["0.300750"] }, deps());
    const r = p.apply(base({ watchlist: ["1.600519"], bar: [], pins: [] }));
    expect(r.changed).toBe(false);
    expect(r.text).toContain("已经不在自选里");
  });

  it("分组在等待期间被删掉时不动手", async () => {
    const before = base({ groups: [{ id: "g1", name: "持仓" }] });
    const p = await prepareCommand(before, "groups.rename", { group: "持仓", name: "长线" }, deps());
    const r = p.apply(base({ groups: [] }));
    expect(r.changed).toBe(false);
    expect(r.text).toContain("已经不在了");
  });

  it("assignGroup 的分组在等待期间被删掉时不动手", async () => {
    const before = base({ groups: [{ id: "g1", name: "持仓" }] });
    const p = await prepareCommand(before, "watchlist.assignGroup", { targets: ["0.300750"], group: "持仓" }, deps());
    const r = p.apply(base({ groups: [] }));
    expect(r.changed).toBe(false);
    expect(r.text).toContain("分组已经不在了");
    expect(r.settings.groupOf).toEqual({});
  });

  it("add 带的分组在等待期间被删掉时不动手", async () => {
    const before = base({ groups: [{ id: "g1", name: "持仓" }] });
    const p = await prepareCommand(before, "watchlist.add", { target: "105.NVDA", group: "持仓" }, deps());
    const r = p.apply(base({ groups: [] }));
    expect(r.changed).toBe(false);
    expect(r.text).toContain("分组已经不在了");
    expect(r.settings.watchlist).toEqual(["1.600519", "0.300750"]);
  });

  it("带点的关键词还是会去搜索（不是一律当 secid）", async () => {
    await expect(run(base(), "watchlist.add", { target: "BRK.B" })).rejects.toThrow(/没搜到/);
    await expect(run(base(), "watchlist.add", { target: "600519" })).rejects.toThrow(/没搜到/);
  });
});
