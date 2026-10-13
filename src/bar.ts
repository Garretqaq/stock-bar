// 菜单栏（托盘）内容生成：单行文字 / 双行紧凑 PNG。主面板负责推送，设置窗口复用来做实时预览。

import type { Quote } from "./api";
import type { BarField, Settings } from "./settings";
import { UI_FONT } from "./tauri";

const CN = UI_FONT;

/** 菜单栏空间有限：指数用惯用简称，其余最多 4 个字 */
const INDEX_SHORT: Record<string, string> = { 上证指数: "上证", 深证成指: "深证", 创业板指: "创业板" };

export function shortName(name: string): string {
  if (INDEX_SHORT[name]) return INDEX_SHORT[name];
  return name.length > 4 ? name.slice(0, 4) : name;
}

export function barPrice(v: number | null | undefined): string {
  if (v == null) return "--";
  const a = Math.abs(v);
  return v.toFixed(a >= 10000 ? 1 : a < 1 ? 3 : 2);
}

export function barPct(q: Quote | undefined, arrow = true): string {
  if (q?.pct == null) return "--";
  const mark = !arrow || q.pct === 0 ? (q.pct > 0 ? "+" : "") : q.pct > 0 ? "▲" : "▼";
  return `${mark}${(arrow ? Math.abs(q.pct) : q.pct).toFixed(2)}%`;
}

function part(q: Quote | undefined, id: string, f: BarField): string {
  if (f === "name") return shortName(q?.name ?? id.split(".")[1] ?? id);
  if (f === "price") return barPrice(q?.price);
  return barPct(q);
}

/** 单行：各股票按字段拼接，多只之间用 │ 分隔 */
export function barText(s: Settings, quotes: Map<string, Quote>): string {
  if (s.barStyle === "icon") return "";
  return s.bar
    .map((id) => {
      const q = quotes.get(id);
      return s.barFields.map((f) => part(q, id, f)).join(" ");
    })
    .join("  │  ");
}

export interface BarImage {
  canvas: HTMLCanvasElement;
  /** template 图：只用 alpha，系统自动适配深/浅色菜单栏 */
  template: boolean;
}

/**
 * 双行紧凑：每只股票一列，上行名称、下行价格 + 涨跌幅。
 * 按 2x 绘制，高 36px（macOS 托盘图统一缩到 18pt）。
 * colored=true 时按涨跌着色（非 template，需根据菜单栏深浅选文字色）。
 */
export function barImage(
  s: Settings,
  quotes: Map<string, Quote>,
  opts: { up: string; down: string; darkBar: boolean },
): BarImage | null {
  if (s.barStyle !== "compact" || !s.bar.length) return null;
  const H = 36;
  const GAP = 16;
  const top = `600 15px ${CN}`;
  const bottom = `500 14px ${CN}`;
  const measure = document.createElement("canvas").getContext("2d")!;
  const cols = s.bar.map((id) => {
    const q = quotes.get(id);
    const showName = s.barFields.includes("name");
    const line1 = showName ? shortName(q?.name ?? id) : s.barFields.includes("price") ? barPrice(q?.price) : barPct(q);
    const rest = s.barFields.filter((f) => f !== "name");
    const line2parts = showName ? rest : rest.slice(1);
    const line2 = line2parts.map((f) => part(q, id, f)).join(" ");
    measure.font = top;
    const w1 = measure.measureText(line1).width;
    measure.font = bottom;
    const w2 = measure.measureText(line2).width;
    return { q, line1, line2, w: Math.ceil(Math.max(w1, w2)) };
  });
  const W = cols.reduce((a, c) => a + c.w, 0) + GAP * (cols.length - 1) + 4;
  const cv = document.createElement("canvas");
  cv.width = W;
  cv.height = H;
  const ctx = cv.getContext("2d")!;
  const base = s.barColor ? (opts.darkBar ? "#ffffff" : "#000000") : "#000000";
  let x = 2;
  for (const c of cols) {
    const dir = c.q?.pct == null || c.q.pct === 0 ? null : c.q.pct > 0 ? opts.up : opts.down;
    const cx = x + c.w / 2;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = base;
    ctx.font = top;
    ctx.fillText(c.line1, cx, 15);
    ctx.font = bottom;
    ctx.fillStyle = s.barColor && dir ? dir : base;
    if (c.line2) ctx.fillText(c.line2, cx, 33);
    x += c.w + GAP;
  }
  return { canvas: cv, template: !s.barColor };
}

export async function canvasPng(cv: HTMLCanvasElement): Promise<number[]> {
  const blob = await new Promise<Blob | null>((r) => cv.toBlob(r, "image/png"));
  if (!blob) return [];
  return [...new Uint8Array(await blob.arrayBuffer())];
}

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Windows 悬浮行情条内容（HTML，外部数据已转义）。
 * 悬浮条本身（ticker.ts）和设置页预览（prefs.ts）共用，保证两边一致。
 */
export function tickerHtml(s: Settings, quotes: Map<string, Quote>): string {
  if (!s.bar.length) return `<span class="it">StockBar</span>`;
  const compact = s.barStyle === "compact";
  return s.bar
    .map((id) => {
      const q = quotes.get(id);
      const d = q?.pct == null || q.pct === 0 ? "flat" : q.pct > 0 ? "up" : "down";
      const name = s.barFields.includes("name") ? `<b>${escHtml(part(q, id, "name"))}</b>` : "";
      const rest = s.barFields
        .filter((f) => f !== "name")
        .map((f) => `<span>${escHtml(part(q, id, f))}</span>`)
        .join(" ");
      const gap = !compact && name && rest ? " " : "";
      return `<span class="it ${d}">${name}${gap}<em>${rest}</em></span>`;
    })
    .join(`<i class="sep"></i>`);
}

/** 悬浮条容器的 class：样式 + 是否涨跌着色 */
export function tickerClass(s: Settings): string {
  return `${s.barStyle === "compact" ? "compact" : "text"}${s.barColor ? " colored" : ""}`;
}
