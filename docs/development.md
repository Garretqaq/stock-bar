# StockBar 开发指南

[返回 README](../README.md) · [使用指南](usage.md) · [架构约定](../AGENTS.md)

## 环境与启动

- Node.js 22+ 与 pnpm，pnpm 版本由 `package.json` 固定。
- Rust stable 与对应平台的 [Tauri 2 开发依赖](https://v2.tauri.app/start/prerequisites/)。
- Windows 需要 WebView2；Linux 需要 WebKitGTK 等系统库。

```bash
pnpm install
pnpm app:dev
```

仅运行前端：

```bash
pnpm dev
```

| 地址 | 用途 |
| --- | --- |
| `http://localhost:1420` | 主面板 |
| `http://localhost:1420/settings.html` | 设置窗口 |
| `http://localhost:1420/settings.html?win` | Windows 设置布局预览 |
| `http://localhost:1420/ticker.html` | 行情条页面；浏览器预览不代表真实桌面行为 |

浏览器中 Tauri 调用自动降级为空操作。托盘、窗口定位、MCP 本地桥与应用内更新需要通过 `pnpm app:dev` 验证。

## 检查与测试

```bash
pnpm check                  # 类型检查 + 单元测试
pnpm build                  # 类型检查 + Vite 打包，输出 dist/
pnpm test                   # 单独运行 Vitest
cd src-tauri && cargo check  # Rust 检查
```

`src/` 下的测试运行于 happy-dom；`mcp/` 与 `scripts/` 下的脚本测试使用 node 环境。修改纯逻辑请补充对应测试，提交前跑通 `pnpm check` 与 `pnpm build`，涉及 Rust 时再运行 `cargo check`。

Vite 端口固定为 1420，修改时必须同步修改 `src-tauri/tauri.conf.json` 中的 `devUrl`。不要手动修改 `dist/`、`src-tauri/target/` 或 `src-tauri/gen/` 等生成产物。

## 本地打包

项目启用了更新包签名，因此本地打包也需要签名私钥：

```bash
TAURI_SIGNING_PRIVATE_KEY=~/.tauri/stockbar.key pnpm app:build
```

私钥生成、公钥配置与仓库 Secret 设置见 [AGENTS.md 的发布流程](../AGENTS.md#发布流程)。私钥不得提交到仓库，公钥必须与私钥配对。

产物位于 `src-tauri/target/release/bundle/`：

| 文件 | 用途 |
| --- | --- |
| `.dmg` / `.msi` / `-setup.exe` | 用户下载安装 |
| `.app.tar.gz` / `-setup.exe` 与对应 `.sig` | 应用内更新 |

macOS 通用二进制由 CI 使用 `--target universal-apple-darwin` 构建；普通本地构建的目标取决于当前机器与构建参数。

## CI 与发布

[build 工作流](https://github.com/Garretqaq/stock-bar/actions/workflows/build.yml) 会先运行 `pnpm check`，再构建 macOS 通用安装包与 Windows 安装包。

- **手动运行**：上传 Artifacts，可用于下载安装包与验证，不创建 Release。
- **推送 `v*` 标签**：汇总各平台安装包、更新包与 `latest.json`，创建 Release 草稿。
- **正式发布**：补齐发布说明后公开草稿，应用才能通过最新 Release 获取更新。

发布时四处版本号必须一致，需配置 `TAURI_SIGNING_PRIVATE_KEY`。正式发版遵循 [AGENTS.md](../AGENTS.md#发布流程)，不要手工上传本地安装包替代流程。

## MCP 本地调试

完整应用运行且 MCP 开关打开后，可在 MCP 客户端配置仓库内的 `mcp/stockbar-mcp.mjs`，也可直接启动 stdio 服务：

```bash
pnpm mcp
```

该命令使用 stdio JSON-RPC，需要 MCP 客户端发送协议请求。工具定义在 `mcp/lib.mjs`，命令处理在 `src/mcp.ts`；新增能力时两处都要更新。本地桥实现与窗口生命周期约定见 [AGENTS.md](../AGENTS.md)。
