// WebDAV 备份 / 恢复的纯逻辑：地址规整与校验、备份文件（信封 + 整份设置）的读写、
// 恢复时保住本机的通道配置、状态文案。
// 联网在 Rust 侧（src-tauri/src/backup.rs），界面在 src/prefs.ts（仪表盘页的「备份」卡片）。
// 纯逻辑放这里，是为了把「什么算一份备份」「恢复要保哪些字段」用单测钉住。

import { PASS_PREFIX, type BackupSettings, type Settings } from "./settings";
import type { Tone } from "./update";

/** 备份文件的外壳：认得出这是 StockBar 的备份，并带上时间与来源版本 */
export interface BackupFile {
  app: "stockbar";
  /** 格式版本：将来改结构时递增，解析端按它报「版本太新」 */
  format: number;
  /** 备份时间（毫秒） */
  savedAt: number;
  /** 生成备份的应用版本，只作展示 */
  appVersion: string;
  settings: Settings;
}

/** 当前备份格式 */
export const BACKUP_FORMAT = 1;

/** 远端两个坑位：常规备份（恢复源）/ 恢复前的安全副本（只写不读，留给手工取回） */
export const SLOTS = ["backup", "safety"] as const;
export type Slot = (typeof SLOTS)[number];

/** 解析备份失败：消息直接给用户看 */
export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

// ---------- 地址 ----------

/** 地址规整：去掉首尾空白与末尾斜杠（用户从别处复制来的多半带着斜杠） */
export function normalizeUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

/** 校验地址：返回问题文案，null = 可以用 */
export function urlProblem(raw: string): string | null {
  const url = normalizeUrl(raw);
  if (!url) return "先填 WebDAV 地址";
  if (!/^https?:\/\//i.test(url)) return "地址要以 http:// 或 https:// 开头";
  return null;
}

/** 地址与账号都填好了才算配过（密码可以空：有些内网 WebDAV 不开认证） */
export function configured(b: BackupSettings): boolean {
  return urlProblem(b.url) == null;
}

// ---------- 备份文件 ----------

/**
 * 生成一份备份：整份设置（自选、置顶、分组、菜单栏、主题、提醒规则都在里面）。
 * **密码密文换成空串** —— 密文只有在本机的密钥上才解得开，带过去只会让人以为还能用。
 * 提醒的触发状态不在设置里（另存一个 key），所以本来就不会进备份。
 */
export function makeBackup(s: Settings, savedAt = Date.now(), appVersion = ""): BackupFile {
  return {
    app: "stockbar",
    format: BACKUP_FORMAT,
    savedAt,
    appVersion,
    settings: { ...s, backup: { ...s.backup, pass: "" } },
  };
}

export function backupJson(file: BackupFile): string {
  return JSON.stringify(file);
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);

/**
 * 解析云端文件。认两种形状：
 * 1. 带信封的（makeBackup 写出来的）；
 * 2. 直接一份设置（别的工具 / 手工导出的），这时按「没有时间」处理。
 * 形状不对（不是 JSON、没有自选）一律抛 BackupError —— 恢复是覆盖本地数据，宁可不做。
 */
export function parseBackup(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupError("云端文件不是 JSON（地址指对了吗？）");
  }
  if (!isObject(raw)) throw new BackupError("云端文件不是 StockBar 的备份");
  // 带信封的：app 标记不对就是别人的备份（或页面本身，比如登录页的 HTML 被当成 JSON 存）
  if (raw.app != null && raw.app !== "stockbar") {
    throw new BackupError("云端文件不是 StockBar 的备份");
  }
  const format = typeof raw.format === "number" ? raw.format : BACKUP_FORMAT;
  if (format > BACKUP_FORMAT) {
    throw new BackupError("云端备份来自更新版本的 StockBar，这个版本恢复不了");
  }
  const settings = isObject(raw.settings) ? raw.settings : raw;
  if (!Array.isArray(settings.watchlist)) {
    throw new BackupError("备份里没有自选数据");
  }
  return {
    app: "stockbar",
    format,
    savedAt: typeof raw.savedAt === "number" && Number.isFinite(raw.savedAt) ? raw.savedAt : 0,
    appVersion: typeof raw.appVersion === "string" ? raw.appVersion : "",
    settings: settings as unknown as Settings,
  };
}

/**
 * 恢复：远端那份设置 + **本地这份**通道配置（地址 / 账号 / 密码密文）。
 * 不这么做的话，恢复会把备份里那份地址与密文搬过来 —— 密文是别的机器上加密的，本机解不开，
 * 恢复完连「再备份一次」都做不了。
 * 其余字段（自选、置顶、分组、主题、提醒……）一律按远端的来；规整交给 loadSettings()。
 */
export function restoreSettings(remote: BackupFile, local: Settings, at = Date.now()): Settings {
  return {
    ...remote.settings,
    backup: { ...local.backup, at, kind: "restore" },
  };
}

/** 时间：本地 YYYY-MM-DD HH:mm；0 表示没有 */
export function timeText(ms: number): string {
  if (!ms) return "没有记录";
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "没有记录";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 一份备份里都有什么：恢复前的确认框里说清楚，别让人盲点 */
export function backupSummary(file: BackupFile): string {
  const s = file.settings;
  const stocks = Array.isArray(s.watchlist) ? s.watchlist.length : 0;
  const groups = Array.isArray(s.groups) ? s.groups.length : 0;
  const alerts = Array.isArray(s.alerts) ? s.alerts.length : 0;
  const parts = [`${stocks} 只自选`];
  if (groups) parts.push(`${groups} 个分组`);
  if (alerts) parts.push(`${alerts} 条提醒`);
  const when = file.savedAt ? `备份时间 ${timeText(file.savedAt)}` : "备份时间未知";
  const from = file.appVersion ? ` · 来自 v${file.appVersion.replace(/^v/i, "")}` : "";
  return `${when} · ${parts.join(" · ")}${from}`;
}

/** 「上次备份」那行小字：没成功过就说没成功过 */
export function lastText(b: BackupSettings): string {
  if (!b.at) return "还没成功备份过";
  const what = b.kind === "restore" ? "上次恢复" : "上次备份";
  return `${what}：${timeText(b.at)}`;
}

// ---------- 状态文案 ----------

/** 卡片此刻在干什么 */
export type BackupPhase =
  | "idle"
  | "testing"
  | "ok"
  | "backing"
  | "backed"
  | "fetching"
  | "confirm"
  | "restoring"
  | "restored"
  | "error";

/**
 * 状态行的文案与语气。error 时一律以错误为准（别拼上一次的成功文案，那会让人以为这次成了）。
 * detail 放「连上了哪个地址」「写到哪个文件」这类补充说明。
 */
export function phaseText(phase: BackupPhase, detail = "", error = ""): { tone: Tone; text: string } {
  switch (phase) {
    case "idle":
      return { tone: "muted", text: "还没连过" };
    case "testing":
      return { tone: "info", text: "正在测试连接…" };
    case "ok":
      return { tone: "ok", text: detail || "连接正常" };
    case "backing":
      return { tone: "info", text: "正在备份…" };
    case "backed":
      return { tone: "ok", text: detail || "已备份到云端" };
    case "fetching":
      return { tone: "info", text: "正在读取云端备份…" };
    case "confirm":
      return { tone: "warn", text: detail || "已读到云端备份，等确认" };
    case "restoring":
      return { tone: "info", text: "正在恢复…" };
    case "restored":
      return { tone: "ok", text: detail || "已恢复" };
    case "error":
      return { tone: "err", text: error.trim() || "备份操作失败" };
  }
}

/** 密码密文是不是本机能解开的形态（解不解得开只有 Rust 知道，这里只挡明显不是密文的东西） */
export function isSealed(pass: string): boolean {
  return pass.startsWith(PASS_PREFIX) && pass.length > PASS_PREFIX.length;
}
