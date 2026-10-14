import { describe, expect, it } from "vitest";

import {
  canInstall,
  formatBytes,
  formatDate,
  hintText,
  progressPct,
  progressText,
  statusOf,
  versionLabel,
  type UpdateInfo,
} from "./update";

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  currentVersion: "0.0.4",
  version: "0.0.5",
  available: true,
  notes: null,
  date: null,
  ...over,
});

describe("versionLabel", () => {
  it("统一带上 v 前缀，重复的 v 不会叠起来", () => {
    expect(versionLabel("0.0.5")).toBe("v0.0.5");
    expect(versionLabel("v0.0.5")).toBe("v0.0.5");
    expect(versionLabel("V1.2.3")).toBe("v1.2.3");
  });
});

describe("formatDate", () => {
  it("把 RFC 3339 转成本地日期，取不到就不显示", () => {
    expect(formatDate("2026-01-02T03:04:05Z")).toMatch(/^2026-01-0[12]$/);
    expect(formatDate(null)).toBeNull();
    expect(formatDate("")).toBeNull();
    expect(formatDate("不是日期")).toBeNull();
  });
});

describe("statusOf", () => {
  it("没有检查结果时如实说还没查过", () => {
    expect(statusOf("idle", null)).toEqual({ tone: "muted", text: "还没有检查过更新" });
  });

  it("检查中、已是最新、有新版各说各的", () => {
    expect(statusOf("checking", null).text).toBe("正在检查更新…");
    expect(statusOf("latest", info({ available: false, version: "0.0.4" }))).toEqual({
      tone: "ok",
      text: "已是最新版本（v0.0.4）",
    });
    expect(statusOf("available", info())).toEqual({
      tone: "warn",
      text: "发现新版本 v0.0.5（当前 v0.0.4）",
    });
  });

  it("下载与安装阶段说的是正在做什么", () => {
    expect(statusOf("downloading", info()).text).toBe("正在下载更新…");
    expect(statusOf("installing", info()).text).toBe("正在安装更新…");
    expect(statusOf("done", info()).tone).toBe("ok");
  });

  it("出错时报出原因，没给原因也有兜底文案", () => {
    expect(statusOf("error", info(), "网络不通")).toEqual({ tone: "err", text: "网络不通" });
    expect(statusOf("error", info()).text).toBe("检查更新失败");
    expect(statusOf("error", info(), "   ").text).toBe("检查更新失败");
  });
});

describe("progressPct", () => {
  it("总大小已知时给出 0~100 的整数", () => {
    expect(progressPct(0, 1000)).toBe(0);
    expect(progressPct(250, 1000)).toBe(25);
    expect(progressPct(999.6, 1000)).toBe(100);
  });

  it("总大小未知或为 0 时不给百分比（界面改用不确定进度）", () => {
    expect(progressPct(500, null)).toBeNull();
    expect(progressPct(500, 0)).toBeNull();
    expect(progressPct(500, -1)).toBeNull();
  });

  it("下载量超出总大小时夹在 100，负数夹在 0", () => {
    expect(progressPct(2000, 1000)).toBe(100);
    expect(progressPct(-5, 1000)).toBe(0);
  });
});

describe("formatBytes", () => {
  it("按量级选单位，各留一位小数", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3.2 * 1024 * 1024)).toBe("3.2 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
  });
});

describe("progressText", () => {
  it("知道总大小时报百分比与已下载 / 总量", () => {
    expect(progressText(512, 1024)).toBe("下载中 50% · 512 B / 1.0 KB");
  });

  it("不知道总大小时只报已下载", () => {
    expect(progressText(1536, null)).toBe("已下载 1.5 KB");
  });
});

describe("hintText", () => {
  it("只有确实有新版时才给提示条文案", () => {
    expect(hintText(info())).toBe("发现新版本 v0.0.5");
    expect(hintText(info({ available: false }))).toBeNull();
    expect(hintText(null)).toBeNull();
  });

});
describe("canInstall", () => {
  it("有新版、且当前不忙时才给「立即更新」", () => {
    expect(canInstall("available", info())).toBe(true);
    expect(canInstall("available", info({ available: false }))).toBe(false);
    expect(canInstall("available", null)).toBe(false);
    expect(canInstall("checking", info())).toBe(false);
    expect(canInstall("downloading", info())).toBe(false);
    expect(canInstall("installing", info())).toBe(false);
    expect(canInstall("done", info())).toBe(false);
  });

  it("装失败后还能再点一次：Rust 侧把待装的更新放回去了", () => {
    expect(canInstall("error", info())).toBe(true);
  });
});
