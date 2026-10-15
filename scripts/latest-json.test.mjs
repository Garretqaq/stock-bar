// @vitest-environment node
// latest.json 的纯逻辑：挑产物、拼片段、合并；外加一条真的跑 CLI 的端到端用例。node 环境（不碰 DOM）。

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { baseName, buildFragment, cargoVersion, mergeFragments, pickAssets } from "./latest-json.mjs";

const MAC = [
  "dist/StockBar-macos/dmg/StockBar_0.0.5_universal.dmg",
  "dist/StockBar-macos/macos/StockBar.app.tar.gz",
  "dist/StockBar-macos/macos/StockBar.app.tar.gz.sig",
];
const WIN = [
  "dist/StockBar-windows/msi/StockBar_0.0.5_x64_zh-CN.msi",
  "dist/StockBar-windows/msi/StockBar_0.0.5_x64_zh-CN.msi.sig",
  "dist/StockBar-windows/nsis/StockBar_0.0.5_x64-setup.exe",
  "dist/StockBar-windows/nsis/StockBar_0.0.5_x64-setup.exe.sig",
];

describe("pickAssets", () => {
  it("macOS 挑 .app.tar.gz 与它的签名，不挑 dmg", () => {
    const picked = pickAssets("darwin", MAC);
    expect(baseName(picked.bundle)).toBe("StockBar.app.tar.gz");
    expect(baseName(picked.signature)).toBe("StockBar.app.tar.gz.sig");
  });

  it("Windows 挑 NSIS 的 setup.exe 与它的签名，不挑 msi", () => {
    const picked = pickAssets("windows", WIN);
    expect(baseName(picked.bundle)).toBe("StockBar_0.0.5_x64-setup.exe");
    expect(baseName(picked.signature)).toBe("StockBar_0.0.5_x64-setup.exe.sig");
  });

  it("缺包或缺签名时返回 null：宁可报错，也别产出一份装不了的 latest.json", () => {
    expect(pickAssets("darwin", MAC.filter((p) => !p.endsWith(".sig")))).toBeNull();
    expect(pickAssets("windows", WIN.filter((p) => !p.endsWith(".sig")))).toBeNull();
    expect(pickAssets("windows", WIN.filter((p) => p.endsWith(".msi") || p.endsWith(".msi.sig")))).toBeNull();
  });

  it("不认识的平台直接报错", () => {
    expect(() => pickAssets("linux", MAC)).toThrow(/未知平台/);
  });
});

describe("buildFragment", () => {
  it("macOS 两种架构指同一个包，地址指到具体标签", () => {
    const f = buildFragment({
      platform: "darwin",
      version: "0.0.5",
      repo: "me/app",
      tag: "v0.0.5",
      bundleName: "StockBar.app.tar.gz",
      signature: "sig",
    });
    expect(f.version).toBe("0.0.5");
    expect(Object.keys(f.platforms).sort()).toEqual(["darwin-aarch64", "darwin-x86_64"]);
    expect(f.platforms["darwin-aarch64"]).toEqual({
      url: "https://github.com/me/app/releases/download/v0.0.5/StockBar.app.tar.gz",
      signature: "sig",
    });
    expect(f.platforms["darwin-x86_64"]).toEqual(f.platforms["darwin-aarch64"]);
  });

  it("Windows 只有一个键；文件名里的特殊字符要转义", () => {
    const f = buildFragment({
      platform: "windows",
      version: "0.0.5",
      repo: "me/app",
      tag: "v0.0.5",
      bundleName: "My App_0.0.5_x64-setup.exe",
      signature: "sig",
    });
    expect(Object.keys(f.platforms)).toEqual(["windows-x86_64"]);
    expect(f.platforms["windows-x86_64"].url).toBe(
      "https://github.com/me/app/releases/download/v0.0.5/My%20App_0.0.5_x64-setup.exe",
    );
  });

  it("缺 repo / tag / version 时报错", () => {
    const base = { platform: "darwin", version: "0.0.5", repo: "me/app", tag: "v0.0.5", bundleName: "a", signature: "s" };
    expect(() => buildFragment({ ...base, tag: "" })).toThrow(/tag/);
    expect(() => buildFragment({ ...base, version: "" })).toThrow(/version/);
    expect(() => buildFragment({ ...base, platform: "linux" })).toThrow(/未知平台/);
  });
});

describe("mergeFragments", () => {
  const mac = {
    version: "0.0.5",
    platforms: {
      "darwin-aarch64": { url: "u1", signature: "s1" },
      "darwin-x86_64": { url: "u1", signature: "s1" },
    },
  };
  const win = { version: "0.0.5", platforms: { "windows-x86_64": { url: "u2", signature: "s2" } } };

  it("把各平台合成一份，说明去掉首尾空白", () => {
    const merged = mergeFragments([mac, win], "  修了个 bug\n");
    expect(merged.version).toBe("0.0.5");
    expect(Object.keys(merged.platforms).sort()).toEqual(["darwin-aarch64", "darwin-x86_64", "windows-x86_64"]);
    expect(merged.notes).toBe("修了个 bug");
  });

  it("没有说明就不写 notes 字段（它是可选的）", () => {
    expect(mergeFragments([mac, win])).not.toHaveProperty("notes");
    expect(mergeFragments([mac, win], "   ")).not.toHaveProperty("notes");
  });

  it("版本号不一致、平台键重复、片段为空都要报错", () => {
    expect(() => mergeFragments([mac, { version: "0.0.6", platforms: {} }])).toThrow(/版本号不一致/);
    expect(() => mergeFragments([mac, mac])).toThrow(/重复/);
    expect(() => mergeFragments([])).toThrow(/没有可合并/);
    expect(() => mergeFragments([{ version: "0.0.5", platforms: {} }])).toThrow(/没有任何平台/);
  });
});

describe("baseName", () => {
  it("反斜杠路径也取得到文件名（Windows runner 上拼出来就是这种）", () => {
    expect(baseName("src-tauri\\target\\release\\bundle\\nsis\\StockBar_0.0.5_x64-setup.exe")).toBe(
      "StockBar_0.0.5_x64-setup.exe",
    );
    expect(baseName("dist/macos/StockBar.app.tar.gz")).toBe("StockBar.app.tar.gz");
  });
});

// 端到端跑一次 CLI：CI 里就是这么调的，别再让「少传一个参数」这种事留到推标签才发现
describe("命令行（fragment）", () => {
  it("不传 --version 也能跑：版本号取自 Cargo.toml，地址与签名进片段", () => {
    const dir = mkdtempSync(join(tmpdir(), "latest-json-"));
    const nsis = join(dir, "nsis");
    mkdirSync(nsis);
    writeFileSync(join(nsis, "StockBar_0.0.5_x64-setup.exe"), "x");
    writeFileSync(join(nsis, "StockBar_0.0.5_x64-setup.exe.sig"), "SIG\n");
    const out = join(dir, "latest-windows.json");
    const script = fileURLToPath(new URL("./latest-json.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [script, "fragment", "--platform", "windows", "--dir", dir, "--out", out], {
      // repo 与 tag 在 Actions 里由环境变量给，本地调试才显式传
      env: { ...process.env, GITHUB_REPOSITORY: "me/app", GITHUB_REF_NAME: "v0.0.5" },
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    const fragment = JSON.parse(readFileSync(out, "utf8"));
    expect(fragment.version).toBe(cargoVersion());
    expect(fragment.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(fragment.platforms["windows-x86_64"]).toEqual({
      url: "https://github.com/me/app/releases/download/v0.0.5/StockBar_0.0.5_x64-setup.exe",
      signature: "SIG",
    });
  });
});

// 版本号只有一个来源，别让它再散开：这两个文件一旦重新写上 version，两边就会悄悄分叉
describe("版本号只有一个来源", () => {
  const read = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

  it("cargoVersion() 取的是 Cargo.toml 的 [package] version", () => {
    const section = read("../src-tauri/Cargo.toml").split(/^\[/m).find((s) => s.startsWith("package]"));
    expect(cargoVersion()).toBe(section.match(/^\s*version\s*=\s*"([^"]+)"/m)[1]);
  });

  it("tauri.conf.json 不写 version（留空才会回退到 Cargo.toml）", () => {
    expect(JSON.parse(read("../src-tauri/tauri.conf.json"))).not.toHaveProperty("version");
  });

  it("package.json 不写 version", () => {
    expect(JSON.parse(read("../package.json"))).not.toHaveProperty("version");
  });

  it("Cargo.lock 里 stock-bar 的版本与 Cargo.toml 一致", () => {
    const lock = read("../src-tauri/Cargo.lock");
    const block = lock.split("[[package]]").find((s) => /^\s*name\s*=\s*"stock-bar"\s*$/m.test(s));
    expect(block, "Cargo.lock 里没有 stock-bar").toBeTruthy();
    expect(block.match(/^\s*version\s*=\s*"([^"]+)"/m)[1]).toBe(cargoVersion());
  });
});
