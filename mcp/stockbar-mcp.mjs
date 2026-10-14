#!/usr/bin/env node
// StockBar MCP 服务（stdio）：零依赖、按行分隔的 JSON-RPC 2.0。
//
// 用法：在 MCP 客户端里配置
//   { "command": "node", "args": ["<仓库路径>/mcp/stockbar-mcp.mjs"] }
// 它需要 StockBar 正在运行：命令经本机回环端口交给应用执行，见 ./lib.mjs 与 src-tauri/src/bridge.rs。
//
// 注意：stdout 只能输出 JSON-RPC（客户端按行解析），日志一律走 stderr。

import { handleMessage } from "./lib.mjs";

let buffer = "";
/** 串行处理：命令可能会等应用联网，但响应要按顺序回 */
let queue = Promise.resolve();

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (let nl = buffer.indexOf("\n"); nl >= 0; nl = buffer.indexOf("\n")) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (line) queue = queue.then(() => onLine(line));
  }
});
process.stdin.on("end", () => {
  // stdin 关了不代表活干完了：等在排队的命令把响应写完再结束。
  // 不显式 process.exit()：那是同步终止，可能把 stdout 里还没冲出去的响应截断；
  // 事件循环空了进程自然退出。
  process.exitCode = 0;
  void queue.catch(() => {});
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(0));

async function onLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "JSON 解析失败" } });
    return;
  }
  try {
    const response = await handleMessage(msg);
    if (response) write(response);
  } catch (e) {
    // handleMessage 自己吞掉了预期内的错误，走到这里说明是服务端的 bug
    process.stderr.write(`[stockbar-mcp] ${e?.stack ?? e}\n`);
    if (msg?.id !== undefined && msg?.id !== null) {
      write({ jsonrpc: "2.0", id: msg.id, error: { code: -32603, message: `内部错误：${e?.message ?? e}` } });
    }
  }
}

function write(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}
