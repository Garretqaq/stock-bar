# StockBar

> 把 A 股自选股盯在 macOS 菜单栏上：实时价格、涨跌幅、分时图抬眼就能看到，不占 Dock、不用切窗口。

<p align="center">
  <img src="src/assets/app-icon.png" width="96" height="96" alt="StockBar">
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Garretqaq/stock-bar?label=license" alt="License"></a>
  <img src="https://img.shields.io/github/package-json/v/Garretqaq/stock-bar?label=version" alt="Version">
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows-lightgrey" alt="Platform">
  <img src="https://img.shields.io/badge/Tauri-2-24C8DB?logo=tauri&logoColor=white" alt="Tauri 2">
  <img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript">
</p>

**适合谁用**：想盘中随手瞟一眼自选股、又不想常驻一个行情窗口的 A 股散户；也适合拿它当 Tauri 2 + 原生 TypeScript 的小型参考实现。

最短上手（macOS / Windows，需要 Node.js 22+、pnpm 和 Rust stable）：

```bash
git clone https://github.com/Garretqaq/stock-bar.git && cd stock-bar && pnpm install && pnpm app:dev
```

## ✨ 亮点

- **真正待在菜单栏里**：点图标弹出速览小窗，点窗口外或再点一次图标自动收起，不占 Dock、不打断当前工作
- **菜单栏内容自己定**：最多同时显示 3 只标的，单行文字 / 双行紧凑 / 仅图标三种样式，名称、价格、涨跌幅按需勾选；双行紧凑可按涨跌着色，不着色时按 template 图渲染，深浅色菜单栏自动适配
- **Windows 有对应方案**：Windows 托盘放不下文字，改用一条可拖动的桌面悬浮行情条，鼠标悬停托盘图标也能看到行情，托盘图标跟随任务栏深浅色自动换白 / 黑
- **依赖极简**：原生 TypeScript + canvas 手绘分时图，没有 UI 框架、没有图表库，运行时依赖只有 Tauri 一个
- **数据来自东方财富公开接口**：不需要注册、不需要 API Key

## 📸 截图

点开菜单栏图标弹出的主面板，以及独立的设置窗口：

<p align="center">
  <img src="docs/panel.png" width="336" alt="主面板：三只大盘指数、自选列表、分时图与搜索框">
</p>

<p align="center">
  <img src="docs/settings.png" width="760" alt="设置窗口：仪表盘、行情、设置三页">
</p>

## 🚀 安装

### 环境要求

| 项 | 要求 |
| --- | --- |
| Node.js | 22+，包管理器用 pnpm（版本已在 `packageManager` 字段锁定） |
| Rust | stable 工具链 |
| 系统 | macOS 11+ / Windows 10+；Linux 需先装好 Tauri 要求的 WebKitGTK 等系统库 |

### 从源码运行

```bash
git clone https://github.com/Garretqaq/stock-bar.git
cd stock-bar
pnpm install
pnpm app:dev      # 启动完整的菜单栏应用
```

打包（产物在 `src-tauri/target/release/bundle/`）：

```bash
pnpm app:build
```

> 目前还没有发布预编译安装包。想直接拿 Windows 的 MSI / NSIS 安装包，可以在 Actions 页面手动运行一次 `build-windows`，安装包在该次运行的 Artifacts 里（缺少 WebView2 时安装器会自动下载）。

### 只调前端

```bash
pnpm dev          # http://localhost:1420，Tauri 调用自动降级为空操作
```

## 🧭 怎么用

| 操作 | 结果 |
| --- | --- |
| 左键点菜单栏图标 | 弹出速览小窗：三只大盘指数、搜索框、自选列表、分时图 |
| 再点一次图标，或点窗口外 | 收起小窗 |
| `Esc` | 收起小窗（光标在搜索框里时只清空搜索） |
| 点大盘卡片或自选行 | 展开 / 收起该标的的分时图 |
| 自选行右键 | 删除自选，或从菜单栏移除 |
| 菜单栏图标右键 | 退出 StockBar |
| 小窗顶部 / 底部 | 刷新、打开设置、切换刷新间隔（3 / 5 / 10 / 30 秒）、退出 |

搜索支持代码、名称和拼音，选中结果即加入自选。

## ⚙️ 设置窗口

独立窗口，分三页：

- **仪表盘**：菜单栏（Windows 是悬浮行情条）的样式、显示字段、涨跌着色，以及标的顺序 —— 拖动即可排序，上方是实时预览
- **行情**：管理自选和菜单栏显示。搜索添加自选、拖动左侧把手排序、行尾按钮置顶、勾选批量加入菜单栏、右键增删
- **设置**：主题（跟随系统 / 浅色 / 深色）、红涨绿跌 / 绿涨红跌、刷新间隔

大盘指数和自选共用菜单栏的 3 个名额；置顶只影响自选列表顺序，与菜单栏名额无关。

## 📊 数据

来自东方财富公开接口：批量报价 `ulist.np`、分时 `trends2`、搜索 `suggest`（搜索接口没有 CORS 头，只能走 JSONP）。接口返回 `"-"` 表示无数据，界面上统一显示 `--`。

### secid

`市场代码.证券代码`：

| 前缀 | 市场 | 例子 |
| --- | --- | --- |
| `1` | 上交所 | `1.600519` |
| `0` | 深交所（代码以 8 / 4 / 92 开头算北交所） | `0.000001` |
| `116` | 港股 | `116.00700` |
| `105` / `106` / `107` | 美股 | `105.NVDA` |
| `100` | 海外指数 | `100.NDX` |

### 交易状态

按各市场时区判断交易时段。没有节假日日历，改用行情接口返回的最后成交时间推断：工作日开盘 10 分钟后仍没有当日成交，就显示「休市」。开盘前无法提前得知当天是否休市。

## 🖥️ 平台差异

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 行情显示位置 | 菜单栏：图标 + 文字，或双行紧凑图片 | 托盘 tooltip + 桌面悬浮行情条 | 同 macOS（无悬浮行情条） |
| 图标适配深浅色 | 自动（按 template 图渲染） | 托盘图标按任务栏深浅色换白 / 黑 | — |
| 设置窗口 | 无边框，自绘红绿灯与拖动区 | 原生标题栏，Windows 11 设置风格 | 同 macOS |
| 打包 | 本地 `pnpm app:build` | GitHub Actions（`.github/workflows/build-windows.yml`） | — |

## 📁 项目结构

```
index.html      → src/main.ts   + src/style.css   主面板小窗（label="main"）
settings.html   → src/prefs.ts  + src/prefs.css   设置窗口（label="settings"）
ticker.html     → src/ticker.ts + src/ticker.css  Windows 悬浮行情条（label="ticker"）
```

- `src/api.ts`：东方财富接口，secid、市场与交易时段工具函数
- `src/settings.ts`：设置类型与默认值、localStorage 持久化与旧数据迁移、跨窗口同步、主题
- `src/bar.ts`：菜单栏内容生成（单行文字 / 双行紧凑 canvas 图）
- `src/ctxmenu.ts`：主面板与设置窗口共用的右键菜单
- `src/drag.ts`：拖动排序的纯计算
- `src/tauri.ts`：Tauri 桥接层，非 Tauri 环境自动降级为空操作
- `src-tauri/src/lib.rs`：托盘、弹窗定位、失焦收起、全部 `#[tauri::command]`
- `src-tauri/icons/tray.png`：菜单栏图标（Rust 嵌入，设置页预览引用同一张）

## 🛠️ 开发

```bash
pnpm check                  # 类型检查 + 单元测试
pnpm test                   # 只跑单元测试（vitest）
pnpm build                  # 类型检查 + vite build → dist/
cd src-tauri && cargo check  # Rust 侧检查
```

单元测试用 vitest（happy-dom 环境），覆盖 `src/*.test.ts` 里的纯逻辑：接口解析、菜单栏内容生成、设置读写与迁移、右键菜单、拖动计算。改纯逻辑请一并补测试。

Vite 开发端口固定为 1420（`strictPort`），和 `tauri.conf.json` 里的 `devUrl` 必须一起改。

## 🤝 贡献

欢迎提 Issue 和 PR。提交前请确保 `pnpm check` 通过。

## 📝 License

[MIT](LICENSE)
