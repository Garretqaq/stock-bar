# StockBar

<p align="center">
  <img src="docs/hero.webp" alt="StockBar 介绍图：应用图标与名称，实时行情 / 菜单栏常驻 / 灵活配置 / 轻量小巧四项特性，以及菜单栏行情条与设置窗口的仪表盘界面">
</p>

**把行情放在菜单栏，随时掌握市场动态。**

面向 macOS 的菜单栏盯盘小工具：抬眼看价格和涨跌幅，点一下看自选与分时图，不占 Dock。Windows 提供托盘与可拖动的悬浮行情条。

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey)

[从源码运行](#快速开始) · [使用指南](docs/usage.md) · [开发与贡献](#开发与贡献)

## 为什么做它

盘中只想知道那几只自选走到哪里，不一定需要一直开着完整的行情软件。StockBar 把常看的数字留在菜单栏，需要细看时再展开小窗，看完就收起，让行情留在视线里，而不是占着工作区。

主要面向想随手看一眼行情的用户，也可作为 **Tauri 2 + 原生 TypeScript + canvas** 的小型参考实现：不用 UI 框架，不用图表库。

## 界面预览

主面板：大盘指数、搜索、自选列表与分时图。

<p align="center">
  <img src="docs/panel.png" width="356" alt="StockBar 主面板：大盘指数卡片、股票搜索、自选列表与宁德时代分时图">
</p>

设置窗口：管理显示样式、标的顺序、主题与刷新间隔。

<p align="center">
  <img src="docs/settings.png" width="800" alt="StockBar 设置窗口：浅色、深色及跟随系统主题，涨跌配色与刷新间隔">
</p>

## 日常盯盘，少一步切换

- **常看的行情直接露出来**：最多显示 3 个标的，大盘指数与自选共用名额。单行文字、双行紧凑、仅图标三种样式，名称、价格、涨跌幅按需显示。
- **需要细看时再展开**：点托盘图标查看指数、自选和分时图，大盘指数的分时图还带当日成交额与较上一日同期的增减；支持代码、名称、拼音搜索，以及自选置顶与拖动排序。点窗口外或再点一次图标收起。
- **按桌面习惯调整**：macOS 使用菜单栏，Windows 使用悬浮行情条；支持跟随系统主题、红涨绿跌或绿涨红跌，以及 3 / 5 / 10 / 30 秒刷新间隔。

行情来自东方财富公开接口，**无需注册或 API Key**。刷新间隔可配置，但不保证交易所级实时性或接口持续可用。

## 快速开始

### 环境准备

- **Node.js 22+**，使用 pnpm（版本在 `package.json` 的 `packageManager` 字段锁定）。
- **Rust stable**，以及对应平台的 [Tauri 2 开发依赖](https://v2.tauri.app/start/prerequisites/)；Windows 需要 WebView2，Linux 需要 WebKitGTK 等系统库。
- 主要面向 macOS；Windows 有独立的托盘与悬浮行情条适配，Linux 包含兼容逻辑，表现取决于桌面环境。

### 从源码运行

```bash
git clone https://github.com/Garretqaq/stock-bar.git
cd stock-bar
pnpm install
pnpm app:dev
```

启动后点击菜单栏 / 托盘图标打开主面板，搜索并添加自选。在设置窗口的「行情」页选择要显示的标的，再到「仪表盘」调整样式与顺序。

### 打包安装

```bash
# 更新包要签名，本地打包也得带上私钥（生成方式见 AGENTS.md 的「发布流程」）
TAURI_SIGNING_PRIVATE_KEY=~/.tauri/stockbar.key pnpm app:build
```

产物位于 `src-tauri/target/release/bundle/`，其中 `.dmg` / `.msi` / `-setup.exe` 是给人装的安装包，`.app.tar.gz` 与 `-setup.exe` 的 `.sig` 是给应用内更新用的。

仓库维护者也可在 [GitHub Actions](https://github.com/Garretqaq/stock-bar/actions/workflows/build.yml) 手动运行 `build`，从该次运行的 Artifacts 下载安装包。推送 `v*` 标签会构建 macOS（通用二进制，Intel 与 Apple Silicon 通用）和 Windows 安装包，并创建 Release 草稿（需手动确认后公开）；Windows 缺少 WebView2 时安装器会自动下载。

### 只预览前端

```bash
pnpm dev
```

打开 `http://localhost:1420`。无需启动 Rust，Tauri 调用自动降级为空操作；这只能预览界面，不能验证真实托盘行为。设置窗口可通过 `/settings.html` 访问，Windows 布局可通过 `/settings.html?win` 预览。

## 平台与数据边界

| 平台 | 行情展示 | 说明 |
| --- | --- | --- |
| macOS | 菜单栏文字 / 双行紧凑图片 | 不显示 Dock 图标，支持系统 template 图标适配 |
| Windows | 托盘提示 + 桌面悬浮行情条 | 行情条可拖动，托盘图标随任务栏深浅色切换 |
| Linux | 托盘 | 无 Windows 悬浮行情条；文字、图片展示受桌面环境影响 |

接口包含 A 股、港股、美股及海外指数的市场标识，数据覆盖与可用性以东方财富返回结果为准。无数据时显示 `--`。

交易状态按市场时区与最后成交时间推断，**没有节假日日历**，开盘前无法提前判断当天是否休市。完整操作、设置说明和数据规则见 [使用指南](docs/usage.md)。

## 用 MCP 配置自选（可选）

仓库自带一个零依赖的 MCP 服务，可以让支持 MCP 的 AI 客户端（Claude Code、Claude Desktop 等）按你的话改自选与分组：

- 「把宁德时代加到自选，放进持仓分组」
- 「新建一个分组叫打新，把这三只挪进去」
- 「我自选里现在有哪些分组，各放了什么」

在客户端里配置（需要 Node 22+，路径换成你的脚本位置）：

```json
{
  "mcpServers": {
    "stockbar": {
      "command": "node",
      "args": ["/Users/you/code/stock-bar/mcp/stockbar-mcp.mjs"]
    }
  }
}
```

应用里也能拿到这段配置：**设置窗口左侧的「MCP」页**会显示本地桥状态（端口 / 是否就绪），点「复制配置」就能把上面这段 JSON 拷走。安装包已经带上 `mcp/stockbar-mcp.mjs`，页面给出的路径直接指向应用内的脚本，不用 clone 仓库；自己 clone 的版本（路径指向仓库里的 `mcp/stockbar-mcp.mjs`）同样能用。

同一页上还有开关，**默认是关的**，要用先在那一页打开：关着的时候本地桥不监听端口、连接信息文件也不存在（等于这个功能不存在），AI 客户端会收到「没找到运行信息」；打开后会换一个新端口，客户端不用改配置。开关状态存在应用设置里，重启后保持。

前提是 **StockBar 正在运行**（macOS 菜单栏 / Windows 托盘有图标）：MCP 服务不直接改存储，它把命令通过本机回环端口交给应用，由应用用与界面完全相同的规则执行 —— 校验、分组归属、置顶、菜单栏名额、跨窗口刷新全都一致，改完界面立刻跟着变。连接信息（随机端口 + 令牌）放在应用数据目录的 `mcp-endpoint.json`（macOS 为 `~/Library/Application Support/com.stockbar.eastmoney/`），退出应用时删除。

可用工具共 11 个：`list_watchlist`、`search_instrument`、`add_to_watchlist`、`remove_from_watchlist`、`move_in_watchlist`、`set_watchlist_group`、`set_watchlist_pin`、`create_group`、`rename_group`、`delete_group`、`move_group`。大盘指数是内置的，不能通过 MCP 增删。

## 应用内更新

应用会向 GitHub Release 上的 `latest.json` 检查新版本：发现新版本时，主面板顶栏下会出现一条提示，点它落到设置窗口的「关于」页，在那里一键下载安装，装完自动重启生效；「关于」页也可以手动检查，或关掉「启动时自动检查更新」。

更新包必须先通过发布者签名公钥的校验才会安装，下载地址与签名都来自 Release 里的 `latest.json`：

- macOS 用 `.app.tar.gz` 就地替换 `StockBar.app`，所以应用要放在可写的位置（拖进 `/Applications` 即可）；
- Windows 用 NSIS 安装包，安装时有一个小进度窗，安装器会让应用自己退出。

macOS 包未做签名与公证，更新后如果系统再次拦下，右键「打开」或执行 `xattr -dr com.apple.quarantine /Applications/StockBar.app`。

## 开发与贡献

```bash
pnpm check                  # TypeScript 类型检查 + Vitest 单元测试
pnpm build                  # 类型检查 + Vite 多页面打包 → dist/
pnpm test                   # 只运行单元测试
cd src-tauri && cargo check  # Rust 侧检查
```

前端入口是 `src/main.ts`（主面板）、`src/prefs.ts`（设置窗口）和 `src/ticker.ts`（Windows 行情条）；Rust 托盘与窗口逻辑位于 `src-tauri/src/lib.rs`。详细目录与架构约定见 [AGENTS.md](AGENTS.md)。

欢迎提交 [Issue](https://github.com/Garretqaq/stock-bar/issues) 或 PR。修改纯逻辑请补充对应测试；提交前运行 `pnpm check` 和 `pnpm build`，涉及 Rust 时再运行 `cargo check`。

## 许可证

[MIT](LICENSE) · 作者：[Garretqaq](https://github.com/Garretqaq)
