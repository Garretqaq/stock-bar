// 版本更新：检查结果与界面文案的纯逻辑。
// 主面板（启动时静默检查后的提示条）与设置窗口（「关于」页）共用同一套说法，
// 联网、下载、安装都在 Rust 侧（见 src-tauri/src/update.rs），这里只管怎么说。

/** 一次检查的结果：Rust 的 update_check 命令返回的形状 */
export interface UpdateInfo {
  /** 当前运行的版本 */
  currentVersion: string;
  /** 有没有更新可用 */
  available: boolean;
  /** 可用版本；没有更新时与 currentVersion 相同 */
  version: string;
  /** 更新说明（Release 正文），可能没有 */
  notes: string | null;
  /** 发布时间（RFC 3339），可能没有 */
  date: string | null;
}

/** 界面所处阶段：检查 / 下载 / 安装各自的说法不同 */
export type Phase = "idle" | "checking" | "latest" | "available" | "downloading" | "installing" | "done" | "error";

/** 状态文案的语气，界面据此上色（muted = 灰、info = 常规、warn = 提示、err = 危险） */
export type Tone = "muted" | "info" | "warn" | "ok" | "err";

export interface Status {
  tone: Tone;
  text: string;
}

/** 版本号统一带 v 前缀；Rust 侧可能给 0.0.5，也可能给 v0.0.5 */
export function versionLabel(version: string): string {
  return `v${version.replace(/^v/i, "")}`;
}

/** RFC 3339 转本地日期（YYYY-MM-DD）；拿不到或解析不出来就不显示 */
export function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 当前该显示什么状态。
 * info 只用来报版本号，phase 才是「此刻在干什么」——检查失败时 info 可能还是上一次的结果，
 * 所以失败一律以 error 为准，不去拼旧版本号。
 */
export function statusOf(phase: Phase, info: UpdateInfo | null, error?: string): Status {
  switch (phase) {
    case "idle":
      return { tone: "muted", text: "还没有检查过更新" };
    case "checking":
      return { tone: "info", text: "正在检查更新…" };
    case "latest":
      return { tone: "ok", text: `已是最新版本（${versionLabel(info?.version ?? info?.currentVersion ?? "")}）` };
    case "available":
      return {
        tone: "warn",
        text: `发现新版本 ${versionLabel(info?.version ?? "")}（当前 ${versionLabel(info?.currentVersion ?? "")}）`,
      };
    case "downloading":
      return { tone: "info", text: "正在下载更新…" };
    case "installing":
      return { tone: "info", text: "正在安装更新…" };
    case "done":
      return { tone: "ok", text: "更新已安装，重启后生效" };
    case "error":
      return { tone: "err", text: error?.trim() || "检查更新失败" };
  }
}

/** 下载进度百分比；总大小未知（服务器没给 Content-Length）时返回 null，界面改用不确定进度 */
export function progressPct(downloaded: number, total: number | null): number | null {
  if (total == null || !(total > 0)) return null;
  const pct = Math.round((downloaded / total) * 100);
  return Math.min(100, Math.max(0, pct));
}

/** 字节数按量级选单位，各留一位小数 */
export function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let v = Math.max(0, n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return i === 0 ? `${Math.round(v)} B` : `${v.toFixed(1)} ${units[i]}`;
}

/** 下载进度文案：知道总大小就报百分比，不知道就只报已下载 */
export function progressText(downloaded: number, total: number | null): string {
  const pct = progressPct(downloaded, total);
  if (pct == null) return `已下载 ${formatBytes(downloaded)}`;
  return `下载中 ${pct}% · ${formatBytes(downloaded)} / ${formatBytes(total as number)}`;
}

/** 主面板提示条的文案；没有新版就没有提示条 */
export function hintText(info: UpdateInfo | null): string | null {
  return info?.available ? `发现新版本 ${versionLabel(info.version)}` : null;
}

/**
 * 「立即更新」该不该出现：有新版，且当前不忙（没在检查 / 下载 / 安装，也不是刚装完）。
 * 安装失败（phase = error）时照样给出来 —— Rust 侧会把待装的更新放回去，重试不必重新检查。
 */
export function canInstall(phase: Phase, info: UpdateInfo | null): boolean {
  if (!info?.available) return false;
  return phase !== "checking" && phase !== "downloading" && phase !== "installing" && phase !== "done";
}
