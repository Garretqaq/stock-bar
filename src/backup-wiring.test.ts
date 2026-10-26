// WebDAV 备份的流程接线：真起一遍 prefs.ts，把 Tauri 命令换成假的。
// prefs.test.ts 跑的是「浏览器预览」（IN_TAURI = false，按钮全禁），这里模拟应用内：
// 用假的 callOrThrow / call 走一遍「测试连接 → 备份」与「恢复（先写安全副本、再覆盖本地）」，
// 把顺序与失败时的取舍钉住 —— 这是这个功能唯一会动到用户数据的地方。
// 纯逻辑（信封、字段取舍、文案）在 backup.test.ts 里测，这里只管接线。
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, STORE_KEY, type Settings } from "./settings";
import { backupJson, makeBackup } from "./backup";

// vi.mock 是提升的：共享状态要先 hoisted 出来
const h = vi.hoisted(() => ({
  /** 依次记录命令与参数（call 与 callOrThrow 都记） */
  calls: [] as { cmd: string; args?: Record<string, unknown> }[],
  /** 云端 settings.json 的内容（backup_download 回它） */
  remote: "",
  /** 让「写安全副本」失败，验「失败就中止、本地不动」 */
  failSafety: false,
  /** 让 secret_decrypt 失败，验密码解不开时的提示 */
  failDecrypt: false,
}));

vi.mock("./tauri", () => ({
  IN_TAURI: true,
  IS_WIN: false,
  UI_FONT: "system-ui",
  emitAll: async () => {},
  listenAll: async () => {},
  call: async (cmd: string, args?: Record<string, unknown>) => {
    h.calls.push({ cmd, args });
    if (cmd === "app_version") return "0.0.17";
    if (cmd === "mcp_info") return null;
    return undefined;
  },
  callOrThrow: async (cmd: string, args?: Record<string, unknown>) => {
    h.calls.push({ cmd, args });
    switch (cmd) {
      case "secret_encrypt":
        return "v1:aabb";
      case "secret_decrypt":
        if (h.failDecrypt) throw "密码在本机解不开（可能是别的机器上的密钥），请重新输入";
        return "s3cret";
      case "backup_test":
        return "连接成功（HTTP 200）";
      case "backup_upload":
        if (h.failSafety && args?.slot === "safety") throw "备份失败：云端空间不足（HTTP 507）";
        return null;
      case "backup_download":
        return h.remote;
      default:
        throw `未预期的命令：${cmd}`;
    }
  },
}));

// 行情 / 搜索走网络（搜索还是 JSONP），happy-dom 里跑不了，换成固定结果
vi.mock("./api", async (orig) => {
  const actual = await orig<typeof import("./api")>();
  return { ...actual, searchStocks: vi.fn(async () => []), fetchQuotes: vi.fn(async () => new Map()) };
});

const local: Settings = {
  ...DEFAULTS,
  watchlist: ["1.600519"],
  selected: "1.600519",
  bar: ["1.600519"],
  backup: { url: "https://dav.example.com/stockbar", user: "me", pass: "v1:aabb", at: 0, kind: "" },
};

/** 云端那份：自选与这机不一样，备份通道也是另一台机器的写法 */
const remoteSettings = (patch: Partial<Settings> = {}): Settings => ({
  ...DEFAULTS,
  watchlist: ["0.300750"],
  selected: "0.300750",
  bar: ["0.300750"],
  groups: [{ id: "g1", name: "观察" }],
  backup: { url: "https://other.example.com/dav", user: "someone", pass: "", at: 1, kind: "backup" },
  ...patch,
});

/** 冲掉几轮微任务：被测代码里的 await 链没有定时器，只是排队 */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
}

async function boot(): Promise<void> {
  vi.resetModules();
  h.calls.length = 0;
  h.remote = backupJson(makeBackup(remoteSettings(), 1700000000000, "0.0.17"));
  h.failSafety = false;
  h.failDecrypt = false;
  localStorage.clear();
  localStorage.setItem(STORE_KEY, JSON.stringify(local));
  document.body.innerHTML = '<div id="prefs" class="prefs"></div>';
  await import("./prefs");
  await flush();
}

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const click = (sel: string) => $(sel).click();
const saved = (): Settings => JSON.parse(localStorage.getItem(STORE_KEY)!);
const cmds = () => h.calls.map((c) => c.cmd);
const uploadOf = (slot: string) => h.calls.find((c) => c.cmd === "backup_upload" && c.args?.slot === slot);
const payloadOf = (slot: string) => JSON.parse(uploadOf(slot)!.args!.content as string);

describe("设置窗口：WebDAV 备份流程", () => {
  beforeEach(boot);

  it("测试连接：把地址、账号与解密出来的密码交给 Rust", async () => {
    click("#dav-test");
    await flush();
    const call = h.calls.find((c) => c.cmd === "backup_test");
    expect(call?.args).toEqual({ url: "https://dav.example.com/stockbar", user: "me", pass: "s3cret" });
    expect($("#dav-state").textContent).toContain("连接成功");
  });

  it("立即备份：上传 settings.json（不含密码密文），再把时间写进设置", async () => {
    click("#dav-backup");
    await flush();
    expect(uploadOf("backup")?.args).toMatchObject({
      url: "https://dav.example.com/stockbar",
      user: "me",
      pass: "s3cret",
    });
    const file = payloadOf("backup");
    expect(file.app).toBe("stockbar");
    expect(file.appVersion).toBe("0.0.17");
    expect(file.settings.watchlist).toEqual(["1.600519"]);
    // 密文是别的机器上加的，带过去也没用，还会让人以为还能用
    expect(file.settings.backup.pass).toBe("");
    expect(saved().backup.kind).toBe("backup");
    expect(saved().backup.at).toBeGreaterThan(0);
  });

  it("密码解不开：不上传、不记时间，状态行说的是失败原因", async () => {
    h.failDecrypt = true;
    click("#dav-backup");
    await flush();
    expect(cmds()).not.toContain("backup_upload");
    expect(saved().backup.at).toBe(0);
    expect(saved().backup.kind).toBe("");
    // 原因放在下面那行通栏的说明里（状态那一格只有一行宽，只写「出错了」）
    expect($("#dav-hint").textContent).toContain("解不开");
    expect($("#dav-state").textContent).toContain("出错了");
  });

  it("恢复：先写安全副本（本机当前数据）再覆盖本地；地址与密码保留本机这份", async () => {
    click("#dav-restore");
    await flush();
    // 读回来先摊摘要等确认，不直接动手
    expect($<HTMLElement>("#dav-confirm").hidden).toBe(false);
    expect($("#dav-confirm-text").textContent).toContain("1 只自选");
    expect(saved().watchlist).toEqual(["1.600519"]);

    click("#dav-confirm-ok");
    await flush();
    // 顺序：先 download，再 safety，最后才覆盖本地
    expect(cmds().filter((c) => c === "backup_download" || c === "backup_upload")).toEqual([
      "backup_download",
      "backup_upload",
    ]);
    // 安全副本里是「恢复之前」的本机数据
    expect(uploadOf("safety")).toBeTruthy();
    expect(payloadOf("safety").settings.watchlist).toEqual(["1.600519"]);

    const now = saved();
    expect(now.watchlist).toEqual(["0.300750"]);
    expect(now.groups).toEqual([{ id: "g1", name: "观察" }]);
    // 备份通道保持本机这份：远端那份的地址与密文搬过来就再也备份不了
    expect(now.backup.url).toBe("https://dav.example.com/stockbar");
    expect(now.backup.kind).toBe("restore");
    expect($<HTMLElement>("#dav-confirm").hidden).toBe(true);
  });

  it("安全副本写不成：中止恢复，本地一个字段都不动", async () => {
    h.failSafety = true;
    click("#dav-restore");
    await flush();
    click("#dav-confirm-ok");
    await flush();
    expect(saved().watchlist).toEqual(["1.600519"]);
    expect(saved().backup.kind).toBe("");
    expect($("#dav-hint").textContent).toContain("507");
  });

  it("云端文件不是备份：报错，不覆盖本地", async () => {
    h.remote = "<html>登录页</html>";
    click("#dav-restore");
    await flush();
    expect($<HTMLElement>("#dav-confirm").hidden).toBe(true);
    expect(saved().watchlist).toEqual(["1.600519"]);
    expect($("#dav-hint").textContent).toContain("JSON");
  });

  it("恢复把 MCP 开关改掉时要通知 Rust 开 / 关本地桥", async () => {
    h.remote = backupJson(makeBackup(remoteSettings({ mcp: true }), 1700000000000, "0.0.17"));
    click("#dav-restore");
    await flush();
    click("#dav-confirm-ok");
    await flush();
    // 光改设置没用：桥起不起是 Rust 那边听这条命令
    const mcp = h.calls.find((c) => c.cmd === "mcp_set_enabled");
    expect(mcp?.args).toEqual({ on: true });
  });

  it("读到备份后换了服务器地址：待确认的那份作废，点确认也不动手", async () => {
    click("#dav-restore");
    await flush();
    expect($<HTMLElement>("#dav-confirm").hidden).toBe(false);
    // 安全副本要写到「读到备份的那台」上：换了地址就不该再拿旧摘要去覆盖本地
    const url = $<HTMLInputElement>("#dav-url");
    url.value = "https://another.example.com/dav";
    url.dispatchEvent(new Event("change"));
    await flush();
    expect($<HTMLElement>("#dav-confirm").hidden).toBe(true);
    click("#dav-confirm-ok");
    await flush();
    expect(saved().watchlist).toEqual(["1.600519"]);
  });
});
