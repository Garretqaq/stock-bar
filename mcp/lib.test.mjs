// @vitest-environment node
// MCP 服务端的单元测试：端点路径、工具表、JSON-RPC 组装与错误文案。
// 转发用注入的假 fetch，不碰真实端口。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TOOLS, endpointPath, handleMessage } from "./lib.mjs";

let dir = "";
let endpointFile = "";

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "stockbar-mcp-"));
  endpointFile = join(dir, "mcp-endpoint.json");
  await writeFile(endpointFile, JSON.stringify({ port: 43210, token: "t0ken", pid: 1 }), "utf8");
});
afterAll(async () => rm(dir, { recursive: true, force: true }));

/** 假的本地桥响应 */
const fakeFetch = (responder, seen = []) =>
  vi.fn(async (url, init) => {
    seen.push({ url, init, body: JSON.parse(init.body) });
    return responder(url, init);
  });

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const call = (name, args) =>
  handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { endpointPath: endpointFile, fetch: fakeFetch(async () => jsonResponse(200, { ok: true, text: "好的", data: { a: 1 } })) });

describe("端点路径", () => {
  it("跟着各平台的应用数据目录规则走", () => {
    expect(endpointPath({}, "darwin", "/Users/me")).toBe(
      // 期望值同样用 join 拼：Windows 上 path.join 给的是反斜杠，硬写 POSIX 路径会必失败
      join("/Users/me", "Library", "Application Support", "com.stockbar.eastmoney", "mcp-endpoint.json"),
    );
    expect(endpointPath({ APPDATA: "C:\\Users\\me\\AppData\\Roaming" }, "win32", "C:\\Users\\me")).toBe(
      join("C:\\Users\\me\\AppData\\Roaming", "com.stockbar.eastmoney", "mcp-endpoint.json"),
    );
    expect(endpointPath({ XDG_DATA_HOME: "/data" }, "linux", "/home/me")).toBe(
      join("/data", "com.stockbar.eastmoney", "mcp-endpoint.json"),
    );
  });

  it("STOCKBAR_ENDPOINT 可以覆盖", () => {
    expect(endpointPath({ STOCKBAR_ENDPOINT: "/tmp/whatever.json" }, "darwin", "/Users/me")).toBe("/tmp/whatever.json");
  });
});

describe("工具表", () => {
  it("名字唯一，都有描述、入参 schema 与对应的 op", () => {
    const names = TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(10);
      expect(t.inputSchema.type).toBe("object");
      expect(t.op).toMatch(/^(watchlist|groups|instrument)\./);
    }
    expect(names).toContain("list_watchlist");
    expect(names).toContain("add_to_watchlist");
    expect(names).toContain("create_group");
  });
});

describe("JSON-RPC 组装", () => {
  it("initialize 回客户端要的协议版本，不认识就用最新的", async () => {
    const old = await handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
    expect(old.result.protocolVersion).toBe("2024-11-05");
    expect(old.result.serverInfo.name).toBe("stockbar");
    expect(old.result.instructions).toContain("StockBar");

    const unknown = await handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
    expect(unknown.result.protocolVersion).toBe("2025-06-18");
  });

  it("tools/list 列出全部工具", async () => {
    const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.result.tools.map((t) => t.name)).toEqual(TOOLS.map((t) => t.name));
  });

  it("ping 与通知", async () => {
    expect((await handleMessage({ jsonrpc: "2.0", id: 1, method: "ping" })).result).toEqual({});
    expect(await handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("不认识的方法：请求回错，通知不回", async () => {
    const res = await handleMessage({ jsonrpc: "2.0", id: 7, method: "resources/list" });
    expect(res.error.code).toBe(-32601);
    expect(await handleMessage({ jsonrpc: "2.0", method: "resources/list" })).toBeNull();
  });

  it("不是 JSON-RPC 消息就回 -32600", async () => {
    const res = await handleMessage({ hello: "world" });
    expect(res.error.code).toBe(-32600);
  });

  it("调用不存在的工具回 -32602", async () => {
    const res = await handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "nope" } });
    expect(res.error.code).toBe(-32602);
  });
});

describe("tools/call 转发", () => {
  it("把 op 与参数原样送进本地桥，带上令牌", async () => {
    const seen = [];
    const f = fakeFetch(async () => jsonResponse(200, { ok: true, text: "已加入自选", data: { groups: [] } }), seen);
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "add_to_watchlist", arguments: { target: "600519" } } },
      { endpointPath: endpointFile, fetch: f },
    );
    expect(seen[0].url).toBe("http://127.0.0.1:43210/command");
    expect(seen[0].init.headers["X-StockBar-Token"]).toBe("t0ken");
    expect(seen[0].body).toEqual({ op: "watchlist.add", args: { target: "600519" } });
    expect(res.result.content[0]).toEqual({ type: "text", text: "已加入自选" });
    expect(res.result.structuredContent).toEqual({ groups: [] });
    expect(res.result.isError).toBeUndefined();
  });

  it("应用没运行：给出可读原因而不是抛协议错", async () => {
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_watchlist" } },
      { endpointPath: join(tmpdir(), "根本不存在的端点.json") },
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toContain("没找到 StockBar 的运行信息");
  });

  it("应用报错：原因原样转给模型", async () => {
    const f = fakeFetch(async () => jsonResponse(200, { ok: false, error: "自选里没有「英伟达」" }));
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "remove_from_watchlist", arguments: { targets: ["英伟达"] } } },
      { endpointPath: endpointFile, fetch: f },
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe("自选里没有「英伟达」");
  });

  it("令牌过期（401）给出可操作的提示", async () => {
    const f = fakeFetch(async () => jsonResponse(401, { ok: false }));
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_watchlist" } },
      { endpointPath: endpointFile, fetch: f },
    );
    expect(res.result.content[0].text).toContain("已过期");
  });

  it("连不上端口时说明应用可能已经退出", async () => {
    const f = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:43210");
    });
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_watchlist" } },
      { endpointPath: endpointFile, fetch: f },
    );
    expect(res.result.content[0].text).toContain("连不上 StockBar 的本地桥");
  });

  it("结构化结果只带对象：数组不进 structuredContent", async () => {
    const f = fakeFetch(async () => jsonResponse(200, { ok: true, text: "哦", data: [1, 2] }));
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_watchlist" } },
      { endpointPath: endpointFile, fetch: f },
    );
    expect(res.result.structuredContent).toBeUndefined();
  });

  it("本地桥回 400 时把正文里的原因带出来，而不是只说状态码", async () => {
    const f = fakeFetch(async () => jsonResponse(400, { ok: false, error: "缺少 op" }));
    const res = await handleMessage(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_watchlist" } },
      { endpointPath: endpointFile, fetch: f },
    );
    expect(res.result.isError).toBe(true);
    expect(res.result.content[0].text).toBe("缺少 op");
  });
});

describe("入参形状", () => {
  it("每个工具都能用空参数或最简参数调下去（不缺 schema 里的必填项）", async () => {
    for (const tool of TOOLS) {
      const args = Object.fromEntries(
        (tool.inputSchema.required ?? []).map((key) => [key, tool.inputSchema.properties[key].type === "array" ? [] : tool.inputSchema.properties[key].type === "integer" ? 1 : "x"]),
      );
      const res = await call(tool.name, args);
      expect(res.error).toBeUndefined();
      expect(res.result.content[0].text).toBe("好的");
    }
  });
});
