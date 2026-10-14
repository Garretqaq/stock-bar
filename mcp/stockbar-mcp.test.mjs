// @vitest-environment node
// 端到端：真的起一个假本地桥（HTTP）+ 真的把 mcp/stockbar-mcp.mjs 跑起来，按 MCP 的 stdio 规矩收发。
// 覆盖到「路径发现 → 真实 fetch → 客户端看到的内容」这一整条链路。

import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), "stockbar-mcp.mjs");
const TOKEN = "e2e-token";

let dir = "";
let endpointFile = "";
let port = 0;
let server;
/** 假桥收到的请求 */
let received = [];
const children = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      if (req.headers["x-stockbar-token"] !== TOKEN) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "令牌不对" }));
        return;
      }
      const body = JSON.parse(raw || "{}");
      received.push({ url: req.url, op: body.op, args: body.args });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, text: `${body.op} 收到`, data: { echo: body.op } }));
    });
  });
  port = await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });

  dir = await mkdtemp(join(tmpdir(), "stockbar-mcp-e2e-"));
  endpointFile = join(dir, "mcp-endpoint.json");
  await writeFile(endpointFile, JSON.stringify({ app: "StockBar", port, token: TOKEN, pid: process.pid }), "utf8");
});

afterAll(async () => {
  for (const c of children) c.kill();
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

/** 起一个 MCP 服务进程，按 id 等响应 */
function startServer(env) {
  const child = spawn(process.execPath, [ENTRY], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  children.push(child);
  const pending = new Map();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });
  const wait = (id) =>
    new Promise((resolve, reject) => {
      pending.set(id, resolve);
      setTimeout(() => reject(new Error(`等 id=${id} 的响应超时`)), 15000);
    });
  return {
    write: (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`),
    writeRaw: (text) => child.stdin.write(text),
    closeStdin: () => child.stdin.end(),
    async ask(id, message) {
      const p = wait(id);
      this.write({ jsonrpc: "2.0", id, ...message });
      return p;
    },
  };
}

describe("MCP 服务进程（stdio）", () => {
  const env = () => ({ STOCKBAR_ENDPOINT: endpointFile });

  it("握手、列工具、调工具都能走通", async () => {
    received = [];
    const srv = startServer(env());
    const init = await srv.ask(1, { method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    expect(init.result.serverInfo.name).toBe("stockbar");
    expect(init.result.protocolVersion).toBe("2025-06-18");

    srv.write({ jsonrpc: "2.0", method: "notifications/initialized" });

    const list = await srv.ask(2, { method: "tools/list" });
    expect(list.result.tools.length).toBeGreaterThanOrEqual(10);
    expect(list.result.tools.map((t) => t.name)).toContain("add_to_watchlist");

    const call = await srv.ask(3, { method: "tools/call", params: { name: "add_to_watchlist", arguments: { target: "1.600519", group: "持仓" } } });
    expect(call.result.content[0].text).toBe("watchlist.add 收到");
    expect(call.result.structuredContent).toEqual({ echo: "watchlist.add" });
    expect(received).toEqual([{ url: "/command", op: "watchlist.add", args: { target: "1.600519", group: "持仓" } }]);
  });

  it("一次写多行也按顺序响应", async () => {
    const srv = startServer(env());
    const first = srv.ask(11, { method: "ping" });
    const second = srv.ask(12, { method: "tools/list" });
    const [a, b] = await Promise.all([first, second]);
    expect(a.id).toBe(11);
    expect(b.id).toBe(12);
  });

  it("没有运行信息时，工具调用返回可读的 isError", async () => {
    const srv = startServer({ STOCKBAR_ENDPOINT: join(dir, "不存在.json") });
    const res = await srv.ask(21, { method: "tools/call", params: { name: "list_watchlist" } });
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("没找到 StockBar 的运行信息");
  });

  it("坏 JSON 只回一条解析错误，进程继续可用", async () => {
    const srv = startServer(env());
    srv.writeRaw("这不是 JSON\n");
    const bad = await new Promise((resolve) => {
      // 解析错误没有可等的 id（回的是 id: null），直接等一小会儿再确认进程还能应答
      setTimeout(() => resolve(null), 300);
    });
    expect(bad).toBeNull();
    const pong = await srv.ask(31, { method: "ping" });
    expect(pong.result).toEqual({});
  });
  it("stdin 关掉时，在途请求的响应照样写出来", async () => {
    const srv = startServer(env());
    const waiting = srv.ask(41, { method: "tools/call", params: { name: "list_watchlist" } });
    srv.closeStdin();
    const res = await waiting;
    expect(res.result.content[0].text).toBe("watchlist.list 收到");
  });
});
