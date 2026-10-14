// StockBar MCP 服务的核心：端点发现、命令转发、JSON-RPC 组装。
// 入口是 ./stockbar-mcp.mjs；这里拆出来是为了能单独测（测试里指向假的本地桥）。
//
// 它不直接改设置：命令通过 127.0.0.1 上的本地桥交给正在运行的 StockBar，
// 由应用里的前端用与界面同一套逻辑执行 —— 见 src-tauri/src/bridge.rs 与 src/mcp.ts。

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** 与 src-tauri/tauri.conf.json 的 identifier、bridge.rs 的 ENDPOINT_FILE 对应 */
const IDENTIFIER = "com.stockbar.eastmoney";
const ENDPOINT_FILE = "mcp-endpoint.json";
/** 认识（并会照着回）的协议版本，按新到旧 */
const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "stockbar", title: "StockBar", version: "1.0.0" };
/** 应用侧最长等 32 秒（要联网搜索/报价），这里比它再宽一点，别抢在应用前面报错 */
const REQUEST_TIMEOUT_MS = 40000;

/** 交给模型的简短说明：怎么用这些工具、有什么前提 */
const INSTRUCTIONS =
  "这是用户本机菜单栏行情应用 StockBar 的自选配置接口（自选股票与分组）。" +
  "用户报的是股票名或代码时，先用 search_instrument 拿到 secid 再操作。" +
  "改动立即生效，无需用户再确认；分组要先存在（用 create_group 新建），" +
  "「未分组」是内置分组，不能改名、排序或删除。" +
  "应用必须正在运行（macOS 菜单栏 / Windows 托盘有图标），且设置窗口「MCP」页的开关是打开的，" +
  "否则会报找不到运行信息。";

/** 连不上、令牌过期、应用没运行等「环境问题」；这类错误原样交给模型看 */
export class BridgeError extends Error {
  constructor(message) {
    super(message);
    this.name = "BridgeError";
  }
}

/**
 * 连接信息文件的位置，与 Tauri 的 `app_data_dir()` 规则一致。
 * `STOCKBAR_ENDPOINT` 可以覆盖（调试或应用不装在默认位置时用）。
 */
export function endpointPath(env = process.env, platform = process.platform, home = homedir()) {
  if (env.STOCKBAR_ENDPOINT) return env.STOCKBAR_ENDPOINT;
  if (platform === "darwin") return join(home, "Library", "Application Support", IDENTIFIER, ENDPOINT_FILE);
  if (platform === "win32") {
    return join(env.APPDATA || join(home, "AppData", "Roaming"), IDENTIFIER, ENDPOINT_FILE);
  }
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), IDENTIFIER, ENDPOINT_FILE);
}

/** 工具表：MCP 侧的入参形状 → 本地桥的 op 与参数（参数默认原样转发） */
export const TOOLS = [
  {
    name: "list_watchlist",
    description:
      "查看 StockBar 的自选与分组：按分组列出标的（secid、名称、现价、涨跌幅）、置顶标记、菜单栏显示的名额。只读，不会改动任何设置。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    op: "watchlist.list",
  },
  {
    name: "search_instrument",
    description: "按代码 / 名称 / 拼音搜索标的，返回 secid 候选。用户只说了股票名时，先用它解析成 secid。",
    inputSchema: {
      type: "object",
      properties: { keyword: { type: "string", description: "代码、名称或拼音，例如 600519、茅台、mt" } },
      required: ["keyword"],
      additionalProperties: false,
    },
    op: "instrument.search",
  },
  {
    name: "add_to_watchlist",
    description:
      "把一只标的加入自选（排在末尾），可选同时放进某个分组。target 给 secid（形如 1.600519、105.NVDA）或关键词；" +
      "关键词命中多只时会返回候选，请再用 secid 调一次。已在自选里的只做分组归属。内置大盘指数不能加入。",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "secid 或关键词" },
        group: {
          type: "string",
          description: "分组名字或 id；不填就是未分组。分组必须已存在（用 create_group 新建）",
        },
      },
      required: ["target"],
      additionalProperties: false,
    },
    op: "watchlist.add",
  },
  {
    name: "remove_from_watchlist",
    description: "把一只或多只自选移出列表；它们的置顶、分组归属与菜单栏显示会一并清掉。",
    inputSchema: {
      type: "object",
      properties: {
        targets: { type: "array", items: { type: "string" }, description: "secid 或名称的数组" },
      },
      required: ["targets"],
      additionalProperties: false,
    },
    op: "watchlist.remove",
  },
  {
    name: "move_in_watchlist",
    description:
      "调整某只自选在列表里的位置。position 用 list_watchlist 给出的「第 N 位」（整张自选表的位置，含置顶区，从 1 开始）。" +
      "置顶的标的只能在置顶区内移动，落点会被钳制，结果里会回报最终位置。",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "secid 或名称，必须在自选里" },
        position: { type: "integer", minimum: 1, description: "目标位置，从 1 开始（与 list_watchlist 的「第 N 位」一致）" },
      },
      required: ["target", "position"],
      additionalProperties: false,
    },
    op: "watchlist.move",
  },
  {
    name: "set_watchlist_group",
    description: "把一只或多只自选移入某个分组；group 传「未分组」表示移出分组。分组必须已存在（用 create_group 新建）。",
    inputSchema: {
      type: "object",
      properties: {
        targets: { type: "array", items: { type: "string" }, description: "secid 或名称的数组" },
        group: { type: "string", description: "分组名字或 id；传「未分组」即移出分组" },
      },
      required: ["targets", "group"],
      additionalProperties: false,
    },
    op: "watchlist.assignGroup",
  },
  {
    name: "set_watchlist_pin",
    description: "置顶（固定在自选最前，多个标的按传入顺序排列）或取消置顶。",
    inputSchema: {
      type: "object",
      properties: {
        targets: { type: "array", items: { type: "string" }, description: "secid 或名称的数组" },
        pinned: { type: "boolean", description: "true 置顶（默认），false 取消置顶" },
      },
      required: ["targets"],
      additionalProperties: false,
    },
    op: "watchlist.setPin",
  },
  {
    name: "create_group",
    description: "新建一个自选分组。名字最多 12 个字符，不能与现有分组重名；返回新分组的 id。",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "分组名，例如 持仓、打新" } },
      required: ["name"],
      additionalProperties: false,
    },
    op: "groups.create",
  },
  {
    name: "rename_group",
    description: "给分组改名。group 传分组名字或 id；新名字不能与别的分组重名。",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "现有分组的名字或 id" },
        name: { type: "string", description: "新名字，最多 12 个字符" },
      },
      required: ["group", "name"],
      additionalProperties: false,
    },
    op: "groups.rename",
  },
  {
    name: "delete_group",
    description: "删除分组。组里的自选不会丢，会回到「未分组」；「未分组」本身不能删。",
    inputSchema: {
      type: "object",
      properties: { group: { type: "string", description: "现有分组的名字或 id" } },
      required: ["group"],
      additionalProperties: false,
    },
    op: "groups.delete",
  },
  {
    name: "move_group",
    description: "调整分组顺序（position 从 1 开始）。「未分组」固定在最前，不参与排序。",
    inputSchema: {
      type: "object",
      properties: {
        group: { type: "string", description: "现有分组的名字或 id" },
        position: { type: "integer", minimum: 1, description: "目标位置，从 1 开始" },
      },
      required: ["group", "position"],
      additionalProperties: false,
    },
    op: "groups.move",
  },
];

export const toolByName = (name) => TOOLS.find((t) => t.name === name);

/** 读连接信息（端口 + 令牌） */
async function loadEndpoint(opts) {
  const path = opts.endpointPath ?? endpointPath(opts.env, opts.platform, opts.home);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    throw new BridgeError(
      `没找到 StockBar 的运行信息（${path}）。请先启动 StockBar（菜单栏或托盘出现图标）；` +
        `如果已经在运行，检查设置窗口「MCP」页的开关是不是被关掉了。`,
    );
  }
  let info;
  try {
    info = JSON.parse(raw);
  } catch {
    throw new BridgeError(`StockBar 的运行信息读不出来（${path}）。重启 StockBar 会重新生成。`);
  }
  if (!info?.port || !info?.token) {
    throw new BridgeError(`StockBar 的运行信息不完整（${path}）：缺少端口或令牌。重启 StockBar 再试。`);
  }
  return { port: info.port, token: info.token, path };
}

/** 转发一条命令给本地桥，返回 { ok, text, data }；失败抛 BridgeError */
export async function callBridge(op, args = {}, opts = {}) {
  const ep = await loadEndpoint(opts);
  const doFetch = opts.fetch ?? globalThis.fetch;
  let resp;
  try {
    resp = await doFetch(`http://127.0.0.1:${ep.port}/command`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-StockBar-Token": ep.token },
      body: JSON.stringify({ op, args: args ?? {} }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    const why = e?.name === "TimeoutError" ? "等待超时" : (e?.message ?? String(e));
    throw new BridgeError(`连不上 StockBar 的本地桥（${why}）。确认 StockBar 还在运行，然后重试。`);
  }
  if (resp.status === 401) {
    throw new BridgeError("StockBar 的运行信息已过期（令牌对不上）。它可能刚重启过，重试一次即可。");
  }
  if (!resp.ok) {
    // 400/404 这类错误的正文里带着可读原因（比如「缺少 op」），别丢掉
    let reason;
    try {
      reason = (await resp.json())?.error;
    } catch {
      /* 正文不是 JSON：退回状态码 */
    }
    throw new BridgeError(reason ?? `StockBar 的本地桥返回 HTTP ${resp.status}。`);
  }
  let body;
  try {
    body = await resp.json();
  } catch {
    throw new BridgeError("StockBar 的本地桥返回的内容不是 JSON。");
  }
  if (!body?.ok) throw new BridgeError(body?.error ?? "StockBar 执行失败，且没有给出原因。");
  return { ok: true, text: body.text, data: body.data };
}

/** 调一次工具：查表 → 转发 → 给模型的内容 */
async function callTool(name, args, opts) {
  const tool = toolByName(name);
  if (!tool) throw new BridgeError(`没有这个工具：${name}`);
  const out = await callBridge(tool.op, args ?? {}, opts);
  return { text: out.text ?? "（StockBar 没有返回内容）", data: out.data };
}

/** 结构化结果只接受对象：数组等形状塞不进 structuredContent */
const structured = (data) => (data && typeof data === "object" && !Array.isArray(data) ? data : undefined);

const result = (id, value) => ({ jsonrpc: "2.0", id: id ?? null, result: value });
const errorResponse = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

/**
 * 处理一条 JSON-RPC 消息，返回要写回 stdio 的响应；通知（没有 id）返回 null。
 * `opts` 透传给 callBridge（测试里用它注入假 fetch 与端点文件）。
 */
export async function handleMessage(msg, opts = {}) {
  const id = msg?.id ?? null;
  const method = msg?.method;
  if (typeof method !== "string") return errorResponse(id, -32600, "不是合法的 JSON-RPC 请求");

  switch (method) {
    case "initialize": {
      const want = msg.params?.protocolVersion;
      return result(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(want) ? want : PROTOCOL_VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return result(id, {});
    case "tools/list":
      return result(id, {
        tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const name = msg.params?.name;
      if (typeof name !== "string" || !toolByName(name)) {
        return errorResponse(id, -32602, `没有这个工具：${name}`);
      }
      try {
        const out = await callTool(name, msg.params?.arguments, opts);
        const data = structured(out.data);
        return result(id, { content: [{ type: "text", text: out.text }], ...(data ? { structuredContent: data } : {}) });
      } catch (e) {
        const text = e instanceof BridgeError ? e.message : `调用 ${name} 失败：${e?.message ?? String(e)}`;
        return result(id, { content: [{ type: "text", text }], isError: true });
      }
    }
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    default:
      // 通知（无 id）不回；请求才回「不支持」
      return id === null ? null : errorResponse(id, -32601, `不支持的方法：${method}`);
  }
}
