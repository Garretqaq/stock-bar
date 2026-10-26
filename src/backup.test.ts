// WebDAV 备份的纯逻辑测试：地址校验、备份文件的读写、恢复时的字段取舍、状态文案。
// 联网与加解密在 Rust 侧（src-tauri/src/backup.rs，那边有自己的单测），这里不碰网络。
import { describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT,
  BackupError,
  backupJson,
  backupSummary,
  configured,
  isSealed,
  lastText,
  makeBackup,
  normalizeUrl,
  parseBackup,
  phaseText,
  restoreSettings,
  timeText,
  urlProblem,
} from "./backup";
import { DEFAULTS, PASS_PREFIX, type Settings } from "./settings";

const settings = (patch: Partial<Settings> = {}): Settings => ({
  ...DEFAULTS,
  groups: [{ id: "g1", name: "持仓" }],
  groupOf: { "1.600519": "g1" },
  watchlist: ["1.600519", "105.NVDA"],
  pins: ["105.NVDA"],
  alerts: [{ id: "a1", secid: "1.600519", kind: "price", op: "below", value: 1500, enabled: true }],
  backup: { url: "https://dav.example.com/stockbar", user: "me", pass: `${PASS_PREFIX}aabb`, at: 111, kind: "backup" },
  ...patch,
});

describe("地址", () => {
  it("规整掉空白与末尾斜杠", () => {
    expect(normalizeUrl("  https://dav.example.com/stockbar/  ")).toBe("https://dav.example.com/stockbar");
    expect(normalizeUrl("https://dav.example.com///")).toBe("https://dav.example.com");
  });

  it("只认 http / https，空地址直接报问题", () => {
    expect(urlProblem("https://dav.example.com/dav")).toBeNull();
    expect(urlProblem("http://192.168.1.9:5005")).toBeNull();
    expect(urlProblem("   ")).toBe("先填 WebDAV 地址");
    expect(urlProblem("ftp://dav.example.com")).toContain("http://");
    expect(urlProblem("dav.example.com/dav")).toContain("http://");
  });

  it("地址可用就算配过（密码可以空）", () => {
    expect(configured({ url: "https://dav.example.com", user: "", pass: "", at: 0, kind: "" })).toBe(true);
    expect(configured({ url: "", user: "me", pass: "", at: 0, kind: "" })).toBe(false);
  });
});

describe("备份文件", () => {
  it("整份设置都在，但密码密文不进备份", () => {
    const file = makeBackup(settings(), 1700000000000, "0.0.17");
    expect(file.app).toBe("stockbar");
    expect(file.format).toBe(BACKUP_FORMAT);
    expect(file.savedAt).toBe(1700000000000);
    expect(file.appVersion).toBe("0.0.17");
    // 自选 / 置顶 / 分组 / 提醒都跟着走
    expect(file.settings.watchlist).toEqual(["1.600519", "105.NVDA"]);
    expect(file.settings.pins).toEqual(["105.NVDA"]);
    expect(file.settings.groups).toEqual([{ id: "g1", name: "持仓" }]);
    expect(file.settings.groupOf).toEqual({ "1.600519": "g1" });
    expect(file.settings.alerts).toHaveLength(1);
    // 密文是别的机器上加密的，带过去只会让人以为还能用
    expect(file.settings.backup.pass).toBe("");
    expect(file.settings.backup.url).toBe("https://dav.example.com/stockbar");
    // 不改调用方的对象
    expect(settings().backup.pass).toBe(`${PASS_PREFIX}aabb`);
  });

  it("写出来再读回来是同一份", () => {
    const file = makeBackup(settings(), 1700000000000, "0.0.17");
    const back = parseBackup(backupJson(file));
    expect(back.savedAt).toBe(1700000000000);
    expect(back.appVersion).toBe("0.0.17");
    expect(back.settings.watchlist).toEqual(file.settings.watchlist);
    expect(back.settings.groups).toEqual(file.settings.groups);
  });

  it("也认「直接一份设置」的老形状", () => {
    const back = parseBackup(JSON.stringify({ watchlist: ["1.600519"], pins: [] }));
    expect(back.settings.watchlist).toEqual(["1.600519"]);
    expect(back.savedAt).toBe(0);
  });

  it("形状不对就报错，绝不返回半份数据", () => {
    expect(() => parseBackup("<html>登录</html>")).toThrow(BackupError);
    expect(() => parseBackup("[]")).toThrow(BackupError);
    expect(() => parseBackup(JSON.stringify({ app: "other", settings: { watchlist: [] } }))).toThrow(/不是 StockBar/);
    expect(() => parseBackup(JSON.stringify({ app: "stockbar", settings: { theme: "dark" } }))).toThrow(/没有自选/);
    // 来自更新版本的备份：结构可能看不懂，别硬套
    expect(() => parseBackup(JSON.stringify({ app: "stockbar", format: BACKUP_FORMAT + 1, settings: { watchlist: [] } }))).toThrow(
      /更新版本/,
    );
  });
});

describe("恢复", () => {
  it("自选 / 分组 / 主题按远端，备份通道按本机", () => {
    const local = settings({
      watchlist: ["1.600519"],
      theme: "light",
      backup: { url: "https://mine.example.com/dav", user: "me", pass: `${PASS_PREFIX}9999`, at: 5, kind: "backup" },
    });
    const remote = makeBackup(
      settings({ watchlist: ["0.300750", "105.AAPL"], theme: "dark", groups: [{ id: "g9", name: "观察" }] }),
      1700000000000,
    );
    const next = restoreSettings(remote, local, 1700000001000);
    expect(next.watchlist).toEqual(["0.300750", "105.AAPL"]);
    expect(next.theme).toBe("dark");
    expect(next.groups).toEqual([{ id: "g9", name: "观察" }]);
    // 远端那份的地址与密文不能用：密文是别的机器加出来的，恢复完还得能继续备份
    expect(next.backup.url).toBe("https://mine.example.com/dav");
    expect(next.backup.pass).toBe(`${PASS_PREFIX}9999`);
    expect(next.backup.at).toBe(1700000001000);
    expect(next.backup.kind).toBe("restore");
  });

  it("摘要里报出自选 / 分组 / 提醒与时间", () => {
    const text = backupSummary(makeBackup(settings(), 1700000000000, "0.0.17"));
    expect(text).toContain("2 只自选");
    expect(text).toContain("1 个分组");
    expect(text).toContain("1 条提醒");
    expect(text).toContain("来自 v0.0.17");
    expect(text).toMatch(/备份时间 \d{4}-\d\d-\d\d \d\d:\d\d/);
    // 没有时间就直说，别显示 1970
    expect(backupSummary(parseBackup(JSON.stringify({ watchlist: [] })))).toContain("备份时间未知");
  });
});

describe("文案", () => {
  it("时间与上次记录", () => {
    expect(timeText(0)).toBe("没有记录");
    expect(timeText(1700000000000)).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    expect(lastText({ url: "", user: "", pass: "", at: 0, kind: "" })).toBe("还没成功备份过");
    expect(lastText({ url: "", user: "", pass: "", at: 1700000000000, kind: "backup" })).toContain("上次备份");
    expect(lastText({ url: "", user: "", pass: "", at: 1700000000000, kind: "restore" })).toContain("上次恢复");
  });

  it("状态：出错时只说错，不拼上一次的成功文案", () => {
    expect(phaseText("idle").tone).toBe("muted");
    expect(phaseText("testing").text).toContain("测试");
    expect(phaseText("ok", "连接成功").text).toBe("连接成功");
    expect(phaseText("backed", "已备份到云端").tone).toBe("ok");
    expect(phaseText("confirm").tone).toBe("warn");
    const err = phaseText("error", "已备份到云端", "HTTP 401");
    expect(err).toEqual({ tone: "err", text: "HTTP 401" });
    expect(phaseText("error", "", "  ").text).toBeTruthy();
  });

  it("密码密文的形态检查", () => {
    expect(isSealed(`${PASS_PREFIX}abcd`)).toBe(true);
    expect(isSealed(PASS_PREFIX)).toBe(false);
    expect(isSealed("plain-password")).toBe(false);
  });
});
