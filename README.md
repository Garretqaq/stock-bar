# StockBar

菜单栏盯盘小工具：Tauri 2 + 原生 TypeScript（无 UI 框架、无图表库），行情来自东方财富公开接口。主要面向 macOS（只在菜单栏显示，不占 Dock），Windows/Linux 也可运行。

## 功能

- 左键点菜单栏图标弹出小窗：大盘指数、自选股、分时图、股票搜索；点窗口外或再点一次图标收起
- 右键菜单退出
- 菜单栏最多同时显示 3 只股票，三种样式：单行文字 / 双行紧凑 / 仅图标
- 独立设置窗口（仪表盘 / 行情 / 设置）：菜单栏样式预览、菜单栏要显示的标的（右键增删）、主题、红涨绿跌 / 绿涨红跌、刷新间隔
- 列表支持右键操作：主面板自选行右键可删除自选或移出菜单栏，设置「行情」页行右键可增删菜单栏标的

## 运行

```bash
pnpm install
pnpm app:dev     # 开发：启动完整的菜单栏应用
pnpm app:build   # 打包：src-tauri/target/release/bundle/
pnpm dev         # 仅在浏览器预览前端（http://localhost:1420），Tauri 调用自动变成空操作
pnpm test        # 单元测试（vitest）
pnpm check       # 类型检查 + 单元测试
```

## Windows

- 托盘图标不能显示文字，菜单栏行情改为显示在**桌面悬浮行情条**上：置顶小条，可拖动，单击弹出面板，可在「仪表盘」里关闭；鼠标悬停托盘图标也能看到行情
- 托盘图标会跟随任务栏深浅色自动换成白色或黑色
- 打包使用 GitHub Actions（`.github/workflows/build-windows.yml`）：推送 `v*` 标签会生成 MSI 和 NSIS 安装包并创建 Release 草稿；也可以在 Actions 页面手动运行，安装包在本次运行的 Artifacts 里。安装时如果缺少 WebView2 会自动下载

## 结构

- `index.html` → `src/main.ts` + `src/style.css`：主面板小窗（状态、定时刷新、渲染；分时图由 `drawTrend` 用 canvas 绘制）
- `settings.html` → `src/prefs.ts` + `src/prefs.css`：设置窗口
- `ticker.html` → `src/ticker.ts` + `src/ticker.css`：Windows 悬浮行情条
- `src/api.ts`：东方财富接口（批量报价 `ulist.np`、分时 `trends2`、搜索 `suggest`，搜索走 JSONP）、secid 与交易时段工具
- `src/settings.ts`：设置的默认值、localStorage 持久化与迁移、跨窗口同步、主题
- `src/bar.ts`：菜单栏文字 / 双行紧凑图片的生成
- `src/ctxmenu.ts`：主面板与设置窗口共用的右键菜单（样式在 `src/ctxmenu.css`）
- `src/tauri.ts`：Tauri 调用封装，浏览器环境下降级为空操作
- `src-tauri/src/lib.rs`：托盘图标、弹窗定位、失焦自动收起、供前端调用的命令（`set_tray_text`、`set_tray_image`、`open_settings`、`set_ticker`、`fit_ticker`、`ticker_click`、`hide_window`、`quit_app`）
- `src-tauri/icons/tray.png`：菜单栏图标（Rust 嵌入，设置页预览也引用同一张）
- `src/*.test.ts`：单元测试

## secid

`市场代码.证券代码`：`1` 沪、`0` 深（8/4/92 开头为北交所）、`116` 港股、`105/106/107` 美股、`100` 海外指数，例如 `1.600519`、`116.00700`、`105.NVDA`、`100.NDX`。

## 交易状态

按各市场时区的交易时段判断，并用行情接口返回的最后成交时间识别节假日：工作日开盘 10 分钟后若仍没有当日成交，显示「休市」。开盘前无法提前知道当天是否休市。
