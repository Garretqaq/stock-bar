// 提醒的判定与通知文案：纯逻辑，联网、交易时段与送达都在调用方（主面板）。
//
// 语义（见 CONTEXT.md 的「提醒」与 docs/adr/0002-*.md）：
// - 条件**从「不成立」变成「成立」的那一刻**通知一次，持续成立期间不重复；
// - 回到不成立之后重新武装，下次成立会再通知；
// - 同一条规则两次通知至少隔 ALERT_COOLDOWN_MS —— 价格在阈值附近来回晃时不该叮个不停；
// - 跨交易日重新武装：昨天触发过，不该把今天的跳空压住。

import type { Quote } from "./api";

import { ALERT_ID_RE, type Alert } from "./settings";

/** 同一条规则两次通知的最小间隔 */
export const ALERT_COOLDOWN_MS = 10 * 60 * 1000;

/** 一条规则的触发状态 */
export interface AlertState {
  /** 这一轮（这一交易日）已经成立过：条件得先回到不成立才会再通知 */
  fired: boolean;
  /** 上次发出通知的时刻（毫秒时间戳）：冷却按它算 */
  at: number;
  /** 上次判定所在的交易日 "YYYY-MM-DD"：跨天重新武装 */
  day: string;
}
export type AlertStates = Record<string, AlertState>;

/** 条件是否成立。规则被关掉、或这轮没拿到它的报价，都不算成立 */
export function alertHit(a: Alert, q: Quote | undefined): boolean {
  if (!a.enabled || !q) return false;
  if (a.kind === "price") {
    if (q.price == null) return false;
    return a.op === "above" ? q.price >= a.value : q.price <= a.value;
  }
  if (q.pct == null) return false;
  // 阈值存的是正数：涨超 5% 是 pct ≥ 5，「跌超 5%」是 pct ≤ -5
  return a.op === "above" ? q.pct >= a.value : q.pct <= -a.value;
}

/**
 * 交易日键：优先用报价自带的最后成交时间（那是市场自己的日期），没有报价时间才退回当前时刻。
 * 用 UTC 取日期而不是本地时区 —— 港股、美股在本地时区里可能跨到第二天，判定要跟着市场走。
 */
function tradeDay(q: Quote, now: Date): string {
  const t = q.time != null ? new Date(q.time * 1000) : now;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${t.getUTCFullYear()}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

export interface AlertFire {
  alert: Alert;
  quote: Quote;
}

export interface EvaluateOptions {
  /** 提醒总开关：关掉时一条都不发，状态也一份都不动（再打开不会补发） */
  on: boolean;
  /** 这只标的现在能不能判定（主面板按交易时段判断）；不能就跳过，状态原样留着 */
  can?: (secid: string) => boolean;
}

export interface EvaluateResult {
  /** 这轮要发的通知 */
  fires: AlertFire[];
  states: AlertStates;
  /** 状态有没有变：没变就不必写 localStorage（每几秒一轮，别白写） */
  changed: boolean;
}

/**
 * 评估一轮：拿这一轮的报价（`quotes` 是累积的报价表，不是只有这轮新到的）逐条判规则。
 * 返回要发的通知与更新后的状态 —— 发通知、写存储都交给调用方。
 */
export function evaluateAlerts(
  alerts: Alert[],
  states: AlertStates,
  quotes: Map<string, Quote>,
  now: Date,
  opts: EvaluateOptions,
): EvaluateResult {
  if (!opts.on) return { fires: [], states, changed: false };
  const fires: AlertFire[] = [];
  const next: AlertStates = { ...states };
  let changed = false;
  for (const a of alerts) {
    if (!a.enabled) continue;
    const q = quotes.get(a.secid);
    // 这轮没拿到它的报价（接口漏了 / 还没加载）：当它没被判定过，状态原样留着
    if (!q) continue;
    if (opts.can && !opts.can(a.secid)) continue;
    const day = tradeDay(q, now);
    const st = states[a.id];
    // 跨天的那份状态视为「没触发过」：新的一天重新武装
    const firedToday = st != null && st.day === day && st.fired;
    const at = st?.at ?? 0;
    if (!alertHit(a, q)) {
      // 条件不成立：重新武装。上次通知的时刻留着，冷却接着算
      if (st == null) continue;
      if (st.fired || st.day !== day) {
        next[a.id] = { fired: false, at, day };
        changed = true;
      }
      continue;
    }
    if (firedToday) continue; // 持续成立：不重复
    // 条件刚成立：先记「已触发」，冷却期内只是不发通知
    const cool = now.getTime() - at < ALERT_COOLDOWN_MS;
    next[a.id] = { fired: true, at: cool ? at : now.getTime(), day };
    changed = true;
    if (!cool) fires.push({ alert: a, quote: q });
  }
  return { fires, states: next, changed };
}

/** 价格文案：A 股习惯两位小数，有更多小数位（基金净值）就留着 */
export function fmtAlertPrice(v: number): string {
  const r = Math.round(v * 1e4) / 1e4;
  return Number.isInteger(r * 100) ? r.toFixed(2) : String(r);
}

/** 涨跌幅阈值文案：一位小数够用 */
export function fmtAlertPct(v: number): string {
  return String(Math.round(v * 10) / 10);
}

/** 规则的条件文案：「跌破 1500.00」「涨超 5%」 */
export function alertLabel(a: Alert): string {
  if (a.kind === "price") return `${a.op === "above" ? "上穿" : "跌破"} ${fmtAlertPrice(a.value)}`;
  return `${a.op === "above" ? "涨超" : "跌超"} ${fmtAlertPct(a.value)}%`;
}

/** 通知的标题与正文：标题给「标的名 + 条件」，正文给现价与当日涨跌幅 */
export function alertText(name: string, a: Alert, q: Quote): { title: string; body: string } {
  const price = q.price == null ? "--" : fmtAlertPrice(q.price);
  const pct = q.pct == null ? "--" : `${q.pct > 0 ? "+" : ""}${q.pct.toFixed(2)}%`;
  return { title: `${name} ${alertLabel(a)}`, body: `现价 ${price} · ${pct}` };
}

/** 触发状态单独存一个 key：每轮判定都可能写，不该触发设置同步广播（与「悬浮行情条位置」同一套理由） */
const STATE_KEY = "stockbar.alerts.state.v1";
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 载入 / 外部写入后的规整：形状不对的条目一律丢掉，规则被删掉的状态也一并清掉 */
export function normalizeAlertStates(raw: unknown, alerts: Alert[]): AlertStates {
  const out: AlertStates = {};
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const ids = new Set(alerts.map((a) => a.id));
  for (const [id, v] of Object.entries(src)) {
    if (!ALERT_ID_RE.test(id) || !ids.has(id)) continue;
    const st = v as Partial<AlertState> | null | undefined;
    if (typeof st?.fired !== "boolean") continue;
    const at = typeof st.at === "number" && Number.isFinite(st.at) && st.at >= 0 ? st.at : 0;
    const day = typeof st.day === "string" && DAY_RE.test(st.day) ? st.day : "";
    out[id] = { fired: st.fired, at, day };
  }
  return out;
}

export function loadAlertStates(alerts: Alert[]): AlertStates {
  try {
    return normalizeAlertStates(JSON.parse(localStorage.getItem(STATE_KEY) ?? "{}"), alerts);
  } catch {
    return {};
  }
}

/** 写入：顺手丢掉已不存在规则的状态，别让存储越攒越长 */
export function saveAlertStates(states: AlertStates, alerts: Alert[]): void {
  localStorage.setItem(STATE_KEY, JSON.stringify(normalizeAlertStates(states, alerts)));
}
