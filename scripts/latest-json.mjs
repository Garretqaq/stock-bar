// 生成 / 合并 latest.json：Tauri 的 updater 靠它知道「这个平台该下哪个包、签名是什么」。
//
// 各平台作业只看得见自己那份产物，所以分两步走：
//   fragment：把某个平台（macOS / Windows）的更新包与签名整理成一份片段，随 Artifacts 上传；
//   merge   ：在 release 作业里把各平台片段合成一份 latest.json，连同安装包一起传上去。
// 端点固定指向 releases/latest/download/latest.json（见 src-tauri/tauri.conf.json 的 plugins.updater），
// 所以最新那份（且已发布、非草稿）Release 里的 latest.json 就是所有人检查更新时拿到的东西。
//
// 用法：
//   node scripts/latest-json.mjs fragment --platform darwin  --dir dist --version 0.0.5 --tag v0.0.5 --out dist/latest-macos.json
//   node scripts/latest-json.mjs merge    --in dist --notes-file notes.txt --out release/latest.json

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** 平台 → latest.json 里的 platforms 键。macOS 是通用二进制，两种架构指同一个包 */
export const PLATFORM_KEYS = {
  darwin: ["darwin-aarch64", "darwin-x86_64"],
  windows: ["windows-x86_64"],
};

/**
 * 只取文件名：Release 里的资产是平铺存放的（见 .github/workflows/build.yml）。
 * 同时认 `/` 与 `\`：Windows runner 上拼出来的是反斜杠路径，只按 `/` 切会把整串当文件名。
 */
export const baseName = (path) => path.split(/[\\/]/).pop();

/**
 * 从一堆文件路径里挑出这个平台的更新包与它的签名。
 * macOS 用 .app.tar.gz（不是 .dmg），Windows 用 NSIS 的 -setup.exe（不是 .msi）：
 * 这两个才是 updater 能直接装的那份。缺任何一半都返回 null，让调用方明确报错。
 */
export function pickAssets(platform, paths) {
  if (platform === "darwin") {
    const bundle = paths.find((p) => p.endsWith(".app.tar.gz"));
    const signature = paths.find((p) => p.endsWith(".app.tar.gz.sig"));
    return bundle && signature ? { bundle, signature } : null;
  }
  if (platform === "windows") {
    const bundle = paths.find((p) => /-setup\.exe$/.test(p));
    const signature = paths.find((p) => /-setup\.exe\.sig$/.test(p));
    return bundle && signature ? { bundle, signature } : null;
  }
  throw new Error(`未知平台：${platform}`);
}

/**
 * 组装一份片段。下载地址指到具体标签（而不是 latest）：草稿期间 latest 还指向上一个版本，
 * 而 latest.json 里写的地址要能跟着这一版一起生效。
 */
export function buildFragment({ platform, version, repo, tag, bundleName, signature }) {
  const keys = PLATFORM_KEYS[platform];
  if (!keys) throw new Error(`未知平台：${platform}`);
  if (!version) throw new Error("缺少 version");
  if (!repo || !tag) throw new Error("缺少 repo 或 tag");
  const url = `https://github.com/${repo}/releases/download/${tag}/${encodeURIComponent(bundleName)}`;
  const platforms = {};
  for (const key of keys) platforms[key] = { url, signature };
  return { version, platforms };
}

/** 合并各平台片段：版本号必须一致，平台键不能重复（重复说明两个作业抢同一个键） */
export function mergeFragments(fragments, notes = "") {
  if (!fragments.length) throw new Error("没有可合并的片段");
  const versions = [...new Set(fragments.map((f) => f.version))];
  if (versions.length > 1) throw new Error(`各平台版本号不一致：${versions.join(" / ")}`);
  const platforms = {};
  for (const fragment of fragments) {
    for (const [key, value] of Object.entries(fragment.platforms ?? {})) {
      if (platforms[key]) throw new Error(`平台键重复：${key}`);
      platforms[key] = value;
    }
  }
  if (!Object.keys(platforms).length) throw new Error("片段里没有任何平台");
  const merged = { version: versions[0], platforms };
  // notes 是可选的：没有就干脆不写这个字段
  const text = notes.trim();
  return text ? { ...merged, notes: text } : merged;
}

// ---------- CLI ----------

function listFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

/**
 * 版本号只有一个来源：`src-tauri/Cargo.toml` 的 `[package] version`（见 AGENTS.md 的「发布流程」）。
 * `tauri.conf.json` 不写 `version` —— 留空时 Tauri 会回退到 Cargo.toml；`Cargo.lock` 里 `stock-bar`
 * 那行由 cargo 自己同步，不用手改。CI 里不传 `--version` 就靠这里兜底。
 */
export function cargoVersion() {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const toml = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
  // 只认 [package] 那一段：`[package.metadata]` 之类不会以 "package]" 开头，不会误命中
  const section = toml.split(/^\[/m).find((s) => s.startsWith("package]")) ?? "";
  const found = section.match(/^\s*version\s*=\s*"([^"]+)"/m)?.[1];
  if (!found) throw new Error("读不到 src-tauri/Cargo.toml 的 [package] version");
  return found;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const next = argv[i + 1];
    args[argv[i].slice(2)] = next === undefined || next.startsWith("--") ? true : argv[++i];
  }
  return args;
}

function main(argv) {
  const [mode, ...rest] = argv;
  const args = parseArgs(rest);
  // 在 Actions 里跑时这两个值直接取自环境变量，本地调试才需要显式传
  const repo = args.repo ?? process.env.GITHUB_REPOSITORY;
  const tag = args.tag ?? process.env.GITHUB_REF_NAME;

  if (mode === "fragment") {
    const { platform, dir, out } = args;
    // 版本号优先用命令行给的；CI 里不传也能跑（从 Cargo.toml 读，免得依赖 shell 差异）
    const version = typeof args.version === "string" ? args.version : cargoVersion();
    if (!platform || !dir || !out) {
      throw new Error("fragment 需要 --platform --dir --out");
    }
    const picked = pickAssets(platform, listFiles(dir));
    if (!picked) {
      throw new Error(`没找到 ${platform} 的更新包与签名（bundle.createUpdaterArtifacts 开了吗？）`);
    }
    const fragment = buildFragment({
      platform,
      version,
      repo,
      tag,
      bundleName: baseName(picked.bundle),
      signature: readFileSync(picked.signature, "utf8").trim(),
    });
    writeFileSync(out, `${JSON.stringify(fragment, null, 2)}\n`);
    console.log(`${platform} 片段已写入 ${out}：${baseName(picked.bundle)}`);
    return;
  }

  if (mode === "merge") {
    const { in: dir, out } = args;
    if (!dir || !out) throw new Error("merge 需要 --in --out");
    const names = readdirSync(dir).filter((n) => /^latest-.*\.json$/.test(n));
    if (!names.length) throw new Error(`${dir} 里没有 latest-*.json 片段`);
    const fragments = names.map((n) => JSON.parse(readFileSync(join(dir, n), "utf8")));
    const notes = typeof args["notes-file"] === "string" ? readFileSync(args["notes-file"], "utf8") : "";
    const merged = mergeFragments(fragments, notes);
    writeFileSync(out, `${JSON.stringify(merged, null, 2)}\n`);
    console.log(`latest.json 已写入 ${out}：${names.join(" + ")}`);
    return;
  }

  throw new Error(`用法：latest-json.mjs fragment|merge …（收到的是 ${mode ?? "空"}）`);
}

// 只有直接跑这个文件时才执行 CLI（测试里 import 它不会触发）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(`[latest-json] ${e.message}`);
    process.exit(1);
  }
}
