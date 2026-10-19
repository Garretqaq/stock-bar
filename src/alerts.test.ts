import { beforeEach, describe, expect, it } from "vitest";
import {
  ALERT_COOLDOWN_MS,
  alertHit,
  alertLabel,
  alertText,
  evaluateAlerts,
  loadAlertStates,
  normalizeAlertStates,
  saveAlertStates,
  type AlertStates,
} from "./alerts";
import type { Quote } from "./api";
import {
  clampAlertValue,
  dropAlertsOf,
  loadSettings,
  newAlert,
  normalizeAlertValue,
  normalizeAlerts,
  STORE_KEY,
  type Alert,
} from "./settings";

const IDX = ["1.000001", "0.399001", "0.399006"];

/** 造一条规则：默认「跌破 10 元」 */
function alert(over: Partial<Alert> = {}): Alert {
  return { id: "a1", secid: "1.600519", kind: "price", op: "below", value: 10, enabled: true, ...over };
}

/** 造一份报价：time 用固定时刻（2026-10-13 02:00 UTC = 当天 A 股盘中） */
function quote(over: Partial<Quote> = {}): Quote {
  return {
    secid: "1.600519",
    code: "600519",
    market: 1,
    name: "贵州茅台",
    price: 10,
    change: 0,
    pct: 0,
    time: Date.UTC(2026, 9, 13, 2, 0) / 1000,
    amount: null,
    ...over,
  };
}

/** 某一轮：把报价塞进 Map 再评估 */
function round(
  alerts: Alert[],
  states: AlertStates,
  q: Quote | null,
  now: Date,
  opts: { on?: boolean; can?: (secid: string) => boolean } = {},
) {
  const quotes = new Map<string, Quote>();
  if (q) quotes.set(q.secid, q);
  return evaluateAlerts(alerts, states, quotes, now, { on: opts.on ?? true, can: opts.can });
}

/** 交易日当天的一个时刻（与 quote() 的 time 同一天） */
const NOW = new Date(Date.UTC(2026, 9, 13, 3, 0));

describe("alertHit：条件判定", () => {
  it("价格：跌破 / 上穿各判一侧，等号算成立", () => {
    expect(alertHit(alert({ op: "below", value: 10 }), quote({ price: 9.9 }))).toBe(true);
    expect(alertHit(alert({ op: "below", value: 10 }), quote({ price: 10 }))).toBe(true);
    expect(alertHit(alert({ op: "below", value: 10 }), quote({ price: 10.1 }))).toBe(false);
    expect(alertHit(alert({ op: "above", value: 10 }), quote({ price: 10.1 }))).toBe(true);
    expect(alertHit(alert({ op: "above", value: 10 }), quote({ price: 9.9 }))).toBe(false);
  });

  it("涨跌幅：阈值存正数，跌超按负的涨跌幅判", () => {
    expect(alertHit(alert({ kind: "pct", op: "above", value: 5 }), quote({ pct: 5.2 }))).toBe(true);
    expect(alertHit(alert({ kind: "pct", op: "above", value: 5 }), quote({ pct: 4.9 }))).toBe(false);
    expect(alertHit(alert({ kind: "pct", op: "below", value: 5 }), quote({ pct: -5.2 }))).toBe(true);
    expect(alertHit(alert({ kind: "pct", op: "below", value: 5 }), quote({ pct: -4.9 }))).toBe(false);
  });

  it("没有报价、价格为空、规则关掉都不算成立", () => {
    expect(alertHit(alert(), undefined)).toBe(false);
    expect(alertHit(alert(), quote({ price: null }))).toBe(false);
    expect(alertHit(alert({ kind: "pct" }), quote({ pct: null }))).toBe(false);
    expect(alertHit(alert({ enabled: false }), quote({ price: 1 }))).toBe(false);
  });
});

describe("evaluateAlerts：边缘触发与重新武装", () => {
  it("条件刚成立时通知一次，持续成立不再重复", () => {
    const a = alert();
    const first = round([a], {}, quote({ price: 9 }), NOW);
    expect(first.fires).toHaveLength(1);
    expect(first.states.a1).toMatchObject({ fired: true });
    // 下一轮还是 9 元：不发、状态也不再变
    const second = round([a], first.states, quote({ price: 9 }), new Date(NOW.getTime() + 5000));
    expect(second.fires).toHaveLength(0);
    expect(second.changed).toBe(false);
  });

  it("回到不成立之后重新武装，下次成立再通知", () => {
    const a = alert();
    const t0 = NOW.getTime();
    const fired = round([a], {}, quote({ price: 9 }), new Date(t0));
    // 价格回到阈值之上：重新武装（冷却早已过去）
    const cleared = round([a], fired.states, quote({ price: 11 }), new Date(t0 + ALERT_COOLDOWN_MS + 60_000));
    expect(cleared.fires).toHaveLength(0);
    expect(cleared.changed).toBe(true);
    expect(cleared.states.a1?.fired).toBe(false);
    // 再跌破：又通知一次
    const again = round([a], cleared.states, quote({ price: 9.5 }), new Date(t0 + ALERT_COOLDOWN_MS + 120_000));
    expect(again.fires).toHaveLength(1);
  });

  it("冷却期内再次穿越不通知，冷却过去后再通知", () => {
    const a = alert();
    const t0 = NOW.getTime();
    const fired = round([a], {}, quote({ price: 9 }), new Date(t0));
    expect(fired.fires).toHaveLength(1);
    const cleared = round([a], fired.states, quote({ price: 11 }), new Date(t0 + 60_000));
    // 冷却还没过：穿越了但不通知，同时标记成已触发（免得冷却一过就补发）
    const hot = round([a], cleared.states, quote({ price: 9 }), new Date(t0 + 120_000));
    expect(hot.fires).toHaveLength(0);
    expect(hot.states.a1?.fired).toBe(true);
    // 冷却过了、价格又穿越（先回上再跌破）：这次通知
    const cleared2 = round([a], hot.states, quote({ price: 11 }), new Date(t0 + ALERT_COOLDOWN_MS + 60_000));
    const cool = round([a], cleared2.states, quote({ price: 9 }), new Date(t0 + ALERT_COOLDOWN_MS + 120_000));
    expect(cool.fires).toHaveLength(1);
  });

  it("跨交易日重新武装：昨天的「已触发」不压今天的跳空", () => {
    const a = alert();
    const fired = round([a], {}, quote({ price: 9 }), NOW);
    expect(fired.fires).toHaveLength(1);
    // 第二天开盘，价格仍在阈值之下（`time` 走到第二天）
    const nextDay = new Date(NOW.getTime() + 24 * 3600 * 1000);
    const q2 = quote({ price: 8, time: Date.UTC(2026, 9, 14, 2, 0) / 1000 });
    const again = round([a], fired.states, q2, nextDay);
    expect(again.fires).toHaveLength(1);
  });

  it("总开关关掉：一条都不发，状态一份都不动", () => {
    const a = alert();
    const res = round([a], {}, quote({ price: 9 }), NOW, { on: false });
    expect(res.fires).toHaveLength(0);
    expect(res.changed).toBe(false);
    expect(res.states).toEqual({});
  });

  it("关掉的规则不评估，状态原样留着", () => {
    const a = alert({ enabled: false });
    const res = round([a], {}, quote({ price: 9 }), NOW);
    expect(res.fires).toHaveLength(0);
    expect(res.states).toEqual({});
  });

  it("这轮没拿到报价：跳过，已有状态不清（免得数据一断就重新武装）", () => {
    const a = alert();
    const fired = round([a], {}, quote({ price: 9 }), NOW);
    const res = round([a], fired.states, null, new Date(NOW.getTime() + 60_000));
    expect(res.fires).toHaveLength(0);
    expect(res.changed).toBe(false);
    expect(res.states.a1?.fired).toBe(true);
  });

  it("can() 说不该判定时（非交易时段）跳过", () => {
    const a = alert();
    const res = round([a], {}, quote({ price: 9 }), NOW, { can: () => false });
    expect(res.fires).toHaveLength(0);
    expect(res.states).toEqual({});
  });

  it("同一只标的多条规则各判各的", () => {
    const a = alert({ id: "a1", op: "below", value: 10 });
    const b = alert({ id: "a2", kind: "pct", op: "above", value: 5 });
    const res = round([a, b], {}, quote({ price: 9, pct: 6 }), NOW);
    expect(res.fires.map((f) => f.alert.id)).toEqual(["a1", "a2"]);
  });
});

describe("文案", () => {
  it("条件文案：价格保留两位小数，涨跌幅一位", () => {
    expect(alertLabel(alert({ op: "below", value: 1500 }))).toBe("跌破 1500.00");
    expect(alertLabel(alert({ op: "above", value: 3.4567 }))).toBe("上穿 3.4567");
    expect(alertLabel(alert({ kind: "pct", op: "above", value: 5 }))).toBe("涨超 5%");
    expect(alertLabel(alert({ kind: "pct", op: "below", value: 2.5 }))).toBe("跌超 2.5%");
  });

  it("通知标题带标的名与条件，正文给现价与涨跌幅", () => {
    const t = alertText("贵州茅台", alert({ value: 1500 }), quote({ price: 1498.5, pct: -2.31 }));
    expect(t.title).toBe("贵州茅台 跌破 1500.00");
    expect(t.body).toBe("现价 1498.50 · -2.31%");
  });
});

describe("规则本身：阈值、编号与清理", () => {
  it("阈值按种类取精度并取绝对值：涨跌幅一步 0.1，价格四位小数", () => {
    expect(normalizeAlertValue("pct", 5.24)).toBe(5.2);
    expect(normalizeAlertValue("pct", -5)).toBe(5);
    expect(normalizeAlertValue("price", 10.123456)).toBe(10.1235);
    expect(normalizeAlertValue("price", 999999)).toBe(100000);
    expect(normalizeAlertValue("pct", 999)).toBe(50);
  });

  it("阈值太小 / 非数都算不可用", () => {
    expect(clampAlertValue("pct", 0)).toBeNull();
    expect(clampAlertValue("price", 0)).toBeNull();
    expect(clampAlertValue("pct", Number.NaN)).toBeNull();
    expect(clampAlertValue("pct", 0.04)).toBeNull();
    expect(clampAlertValue("pct", 0.1)).toBe(0.1);
    expect(clampAlertValue("price", 0.001)).toBe(0.001);
  });

  it("新规则的 id 取已有 aN 的最大值 +1", () => {
    expect(newAlert([], "1.600519").id).toBe("a1");
    expect(newAlert([alert({ id: "a1" }), alert({ id: "a7" })], "1.600519").id).toBe("a8");
    // 编号只看已有的 aN，别的形状不影响
    expect(newAlert([alert({ id: "x9" })], "1.600519").id).toBe("a1");
  });

  it("删自选连带删掉它的规则", () => {
    const list = [alert({ id: "a1", secid: "1.600519" }), alert({ id: "a2", secid: "0.300750" })];
    expect(dropAlertsOf(list, ["1.600519"]).map((a) => a.id)).toEqual(["a2"]);
  });

  it("规整：挡住写坏的规则与「没人可盯」的标的，保留顺序与启用状态", () => {
    const out = normalizeAlerts(
      ["1.600519"],
      IDX,
      [
        { id: "a1", secid: "1.600519", kind: "price", op: "below", value: 1500, enabled: false },
        { id: "a2", secid: "1.000001", kind: "pct", op: "above", value: 1 },
        // 标的不在自选、也不是大盘指数（板块 / 已删的自选）
        { id: "a3", secid: "90.BK0480", kind: "price", op: "below", value: 1 },
        // 形状不对的几条
        { id: "a4", secid: "1.600519", kind: "volume", op: "below", value: 1 },
        { id: "a5", secid: "1.600519", kind: "price", op: "sideways", value: 1 },
        { id: "a6", secid: "1.600519", kind: "price", op: "below", value: 0 },
        { id: "a1", secid: "1.600519", kind: "price", op: "below", value: 9 },
        { id: "bad id!", secid: "1.600519", kind: "price", op: "below", value: 9 },
      ],
    );
    expect(out.map((a) => a.id)).toEqual(["a1", "a2"]);
    expect(out[0]).toMatchObject({ enabled: false, value: 1500 });
    expect(out[1]).toMatchObject({ secid: "1.000001", kind: "pct" });
  });
});

describe("触发状态存储", () => {
  beforeEach(() => localStorage.clear());

  it("存取往返：只留还在的规则，形状不对的条目丢掉", () => {
    const list = [alert({ id: "a1" })];
    saveAlertStates({ a1: { fired: true, at: 123, day: "2026-10-13" } }, list);
    expect(loadAlertStates(list)).toEqual({ a1: { fired: true, at: 123, day: "2026-10-13" } });
    expect(normalizeAlertStates({ a9: { fired: true, at: 1, day: "2026-10-13" } }, list)).toEqual({});
    expect(normalizeAlertStates({ a1: { fired: "yes", at: 1, day: "2026-10-13" } }, list)).toEqual({});
    expect(normalizeAlertStates({ a1: { fired: true, at: Number.NaN, day: "x" } }, list)).toEqual({
      a1: { fired: true, at: 0, day: "" },
    });
  });

  it("存储坏了按「没有状态」处理", () => {
    const list = [alert({ id: "a1" })];
    localStorage.setItem("stockbar.alerts.state.v1", "{oops");
    expect(loadAlertStates(list)).toEqual({});
  });
});

describe("loadSettings：提醒的载入与迁移", () => {
  beforeEach(() => localStorage.clear());

  it("旧数据没有提醒字段：默认没有规则、总开关开", () => {
    localStorage.setItem(STORE_KEY, JSON.stringify({ watchlist: ["1.600519"] }));
    const s = loadSettings();
    expect(s.alerts).toEqual([]);
    expect(s.alertsOn).toBe(true);
  });

  it("存着的规则按自选规整，写坏的总开关回到默认", () => {
    localStorage.setItem(
      STORE_KEY,
      JSON.stringify({
        watchlist: ["1.600519"],
        alerts: [{ id: "a1", secid: "1.600519", kind: "pct", op: "above", value: 5, enabled: true }],
        alertsOn: "nope",
      }),
    );
    const s = loadSettings();
    expect(s.alerts).toHaveLength(1);
    expect(s.alertsOn).toBe(true);
  });
});
