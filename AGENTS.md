# AGENTS.md — StockBar

菜单栏盯盘小工具。Tauri 2（Rust）+ 原生 TypeScript + Vite，**不用 UI 框架、不用图表库**。行情数据来自东方财富公开接口。主要面向 macOS（菜单栏应用、不显示 Dock 图标），Windows/Linux 也做了兼容处理。

## 常用命令

```bash
pnpm install
pnpm dev            # 只跑前端，浏览器打开 http://localhost:1420（Tauri 调用自动变成空操作）
pnpm build          # tsc --noEmit + vite build → dist/
pnpm app:dev        # tauri dev：启动完整的菜单栏应用
pnpm app:build      # tauri build → src-tauri/target/release/bundle/
pnpm test           # vitest 单元测试
pnpm check          # tsc --noEmit + vitest
cd src-tauri && cargo check   # Rust 侧检查
```

- 包管理器用 **pnpm**（`packageManager` 字段已锁定版本），不要用 npm 或 yarn。
- 单元测试用 **vitest**（happy-dom 环境），测试文件为 `src/*.test.ts`，覆盖 api / bar / settings / ctxmenu / drag 里的纯逻辑。没有 lint 或格式化配置。
- 改完之后至少跑通 `pnpm check`（类型检查加单元测试）和 `pnpm build`；改了 Rust 就再跑一次 `cargo check`。改了纯逻辑要补对应测试。
- Vite 开发端口固定为 1420（`strictPort`），和 `tauri.conf.json` 里的 `devUrl` 一一对应，两边必须一起改。

## 目录结构

```
index.html      → src/main.ts   + src/style.css   主面板（托盘弹出的 360×560 无边框小窗，label="main"）
settings.html   → src/prefs.ts  + src/prefs.css   设置窗口（仪表盘 / 行情 / 设置三页，label="settings"，由 Rust 动态创建）
ticker.html     → src/ticker.ts + src/ticker.css  Windows 悬浮行情条（label="ticker"，由 set_ticker 动态创建/关闭）
src/api.ts       东方财富接口：批量报价 ulist.np、分时 trends2、搜索 suggest（JSONP）、secid/市场/交易时段工具函数
src/settings.ts  Settings 类型、默认值、localStorage 读写和旧数据迁移、跨窗口同步、主题和涨跌配色、自选分组的纯函数（`itemsOf` / `moveInView` / `normalizeGroups` 等）
src/bar.ts       菜单栏内容生成：单行文字 barText / 双行紧凑 canvas PNG barImage
src/tauri.ts     Tauri 桥接层：call / emitAll / listenAll（非 Tauri 环境自动降级为空操作），平台判断 IS_WIN、canvas 字体栈 UI_FONT
src/ctxmenu.ts   通用右键菜单 openMenu / closeMenu（样式 ctxmenu.css，主面板与设置窗口共用）
src/drag.ts      拖动排序的纯计算：slotAt（指针落在第几格）/ shiftIndex（拖动中其他行让开多少），设置窗口的仪表盘与行情页共用
src-tauri/src/lib.rs   托盘、弹窗定位（macOS 用 positioner，Windows/Linux 按托盘位置 + 屏幕工作区自己算）、失焦自动收起、单实例、所有 #[tauri::command]
src-tauri/capabilities/default.json   三个窗口（main / settings / ticker）的权限
.github/workflows/build.yml   双端打包：推 v* 标签构建 macOS（通用二进制）+ Windows 安装包并创建 Release 草稿，或手动触发上传 Artifacts
```

Vite 是多页面打包，入口在 `vite.config.ts` 的 `rollupOptions.input` 里，新增页面要在这里登记。

## 架构要点

**状态与同步**
- 唯一的持久化存储是 `localStorage["stockbar.settings.v1"]`，两个窗口同源，共用这一份数据。
- 写设置只用 `saveSettings()`，它会同时广播 Tauri 事件 `settings-changed`。接收方通过 `onSettingsChange()` 收到通知，同时监听 `storage` 事件和 Tauri 事件，因此回调必须**幂等**。用 TOKEN 区分来源，自己发出的广播会被忽略。
- `Settings` 新增字段时：在 `DEFAULTS` 里补上默认值；字段形状变化时在 `loadSettings()` 里写迁移逻辑（可以参考已有的 `pinned → bar` 迁移）。不要轻易修改 `STORE_KEY`，否则用户已有的设置会全部丢失。
- 主面板收到同步时会保留自己的 `selected`，不会被设置窗口的值覆盖。
- `watchlist` 的顺序就是显示顺序，置顶的（`pins`）始终在最前，由 `normalizePins()` 在 `loadSettings()` 里保证。新增或删除自选时要同步 `pins`，拖动排序的落点用 `clampBlock()` 限制在各自区块内。
- 自选分组是 `groups`（有序，`{id, name}`）+ `groupOf`（secid → 分组 id），只决定自选怎么分堆：`watchlist` 仍是唯一一份顺序，`bar` 与 `pins` 都不受分组影响。没有归属、或指向已删分组的都算「未分组」（`UNGROUPED`），`loadSettings()` 用 `normalizeGroups()` 规整（分组 id 必须是 `^[A-Za-z0-9_-]{1,24}$`，才能安全拼进选择器）。新建 / 改名 / 删除 / 排序都是 `settings.ts` 里的纯函数，删分组只把成员回落到未分组。
- 单个与批量「移入分组」共用同一套逻辑：单个用 `groupTargets()`，多选用 `groupTargetsFor()` + `setGroupMany()`（前者把「已经全在该分组」的目标标成 done，菜单里置灰、一个可用目标都没有时操作条上的入口直接禁用）。大盘指数不能分组，所以批量只把选中的自选交出去。
- 分组视图里的拖动要用 `moveInView()` 把可见下标换算成整表下标，落点仍用 `clampBlock()` 按可见列表（也就是该分组内的置顶区）钳制。设置窗口的每个分组区块各注册一次 `sortable()`；区块会随分组增减重建，所以「拖完那一下 click」的标记放在外部 `marketSwallow` 里由各实例共用，不能退回成实例内的局部变量。

**菜单栏（托盘）**
- 托盘只由主面板 `main.ts` 的 `updateTray()` 负责更新。它用签名 `traySig` 去重，内容没变就不推送。设置窗口只用 `bar.ts` 做本地预览，不调用托盘命令。
- 三种样式：`text` 调 `set_tray_text`（默认图标加文字）；`compact` 用 canvas 按 2x、高 36px 绘制 PNG，再调 `set_tray_image`；`icon` 只显示图标。
- `barColor=false` 时图片按 template 图处理（只用 alpha 通道，系统会自动适配深色和浅色菜单栏）。
- 菜单栏最多显示 `BAR_MAX = 3` 只股票。

**Windows 适配**
- 前端用 `IS_WIN`（UA 判断）区分平台，`applyAppearance` 会给 `<html>` 加 `.win` 类，平台样式差异都挂在 `.win` 下。
- Windows 托盘不能显示文字、图标是正方形：`updateTray()` 在 Windows 只调 `set_tray_text`（tooltip 显示行情，Rust 侧截断到 127 个 UTF-16 字符），行情文字交给**悬浮行情条**。
- 悬浮行情条：主面板 `syncTicker()` 是唯一调用 `set_ticker` 的地方（`ticker` 开启、样式不是 `icon`、`bar` 非空时显示）。行情条自己拉数据和渲染，尺寸用 `fit_ticker` 跟随内容；单击调 `ticker_click` 在其旁边弹出主面板；窗口 `focusable(false)`，点击它不会让主面板失焦。位置存在 `localStorage["stockbar.ticker.pos"]`（不走 `saveSettings`，拖动不广播）。
- 托盘图标：`tray.png` 是黑色剪影，Windows 不支持 template，深色任务栏（注册表 `SystemUsesLightTheme=0`）下由 `default_tray_icon()` 染成白色，系统切换主题时重新着色。
- 主面板在 Windows 关闭系统阴影、窗口放大到 376×576，由 CSS 留 8px 边距自己画圆角阴影；WebView2 的 `backdrop-filter` 透不到桌面，所以 `.win .panel` 用不透明底。设置窗口在 Windows 用原生标题栏（不渲染仿红绿灯和拖动区，标题栏深浅随应用主题 `setTheme`），整体是 Windows 11「设置」风格：`prefs.css` 末尾的 `.win` 区块（导航强调色竖条、每项一张 4px 圆角卡片、带「开/关」文字的开关、方形复选框），预览是桌面 + 任务栏 + 悬浮行情条（内容与真实行情条共用 `bar.ts` 的 `tickerHtml`）。开发时 `pnpm dev` 打开 `settings.html?win` 可在浏览器预览 Windows 布局。

**Rust 侧**
- 前端可以调用的命令：`set_tray_text`、`set_tray_image`、`open_settings`、`set_ticker`、`fit_ticker`、`ticker_click`、`hide_window`、`quit_app`。新增命令要同时改两处：在 `generate_handler![]` 里注册，前端通过 `call()` 调用。
- 用 `LAST_HIDDEN_MS` 做防抖（macOS 250ms，Windows/Linux 400ms，见 `TOGGLE_DEBOUNCE_MS`），实现"再点一次图标收起小窗"（点击时窗口会先失焦、自动隐藏）。改托盘点击逻辑时不要破坏这个行为。
- 主面板每次弹出都会收到 `panel-shown` 事件，触发入场动画并立即刷新数据。
- 新建窗口或使用新的插件 API 时，记得在 `capabilities/default.json` 里加上对应的 window label 和 permission。

**行情接口（api.ts）**
- secid 格式是 `市场.代码`：`1` 沪、`0` 深（代码以 8/4/92 开头的算北交所）、`116` 港股、`105/106/107` 美股、`100` 海外指数。
- 东方财富在没有数据时返回 `"-"`，要统一用 `num()` 转成 `null`。界面上所有数值都要处理 `null` 的情况（显示 `--`）。
- 搜索接口不返回 CORS 头，只能走 JSONP。报价和分时接口用 `fetch`，超时 8 秒。
- 分时 `trends2` 只有大盘指数取两天（`fetchTrend(id, isIndex(id) ? 2 : 1)`），个股仍是单日、行为不变。`pickTrendDay()` 只把最新一天交给图表，另一天用来算「与上一日同期」的成交额（`TrendData.amount` / `prevAmount` / `prevDate`，按分钟成交额 `f57` 累加，按条数对齐同一时长）。横轴全天分钟数由 `trendsTotal` 减上一日点数得到。主面板里只有大盘指数的分时面板有 `.trend-foot` 节点，个股行内面板没有。
- `ut` 和 `token` 是接口自带的公开常量，不是密钥。
- `sessionStatus(region, now, lastTrade)` 按时区判断交易时段；没有节假日日历，而是用报价里的最后成交时间 `Quote.time`（接口字段 `f124`）推断：工作日开盘 10 分钟后最后成交仍不在当天，就显示「休市」。开盘前无法提前得知当天是否休市。

**前端约定**
- 原生 DOM 加模板字符串渲染。插入 HTML 时，所有外部数据（股票名等）都必须先过 `esc()` 转义。
- 颜色全部来自 CSS 变量（`--up`、`--down`、`--bg` 等）。主题通过 `<html data-theme>` 加 `.green-up` 类切换（`applyAppearance`），默认红涨绿跌。canvas 和图表要用颜色时，通过 `getComputedStyle` 读取 CSS 变量，不要写死色值。
- 动画要照顾 `prefers-reduced-motion`。
- 代码注释和界面文案用中文。
- 列表里的破坏性操作统一走右键：`src/ctxmenu.ts` 的 `openMenu()`（主面板删自选、设置「行情」页增删菜单栏标的）。菜单样式由两个窗口各自的 CSS 用 `@import "./ctxmenu.css"` 引入；菜单打开时 Esc 只关菜单，不会连带收起主面板。

## 注意事项（坑）

- 菜单栏图标只有一份：`src-tauri/icons/tray.png`。Rust 用 `include_bytes!` 嵌入，`prefs.ts` 也直接 import 这个文件做预览，替换时只改这一处。
- 已启用 CSP（`tauri.conf.json` 的 `csp` / `devCsp`）。新增外部域名时必须同步放行：fetch 走 `connect-src`，JSONP 走 `script-src`，图片走 `img-src`。`devCsp` 额外放行了 Vite 的 `localhost:1420`。`macOSPrivateApi: true` 是透明窗口需要的，不要关。
- `dist/`、`src-tauri/target/`、`src-tauri/gen/` 都是生成产物，不要手动修改。
- 项目是 git 仓库，生成产物已在 `.gitignore` 中排除。

## 发布流程

发布由 `.github/workflows/build.yml` 承担，不要在本地 `pnpm app:build` 之后手动传安装包。

1. **定版本**：四处版本号必须一致 —— `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 里的 `stock-bar`。安装包文件名取自 `tauri.conf.json` 的 `version`。
2. **提交并推 main**：`git commit` 后 `git push origin main`。CI 会先跑 `pnpm check`，不通过就不构建。
3. **打标签推送**：`git tag -a vX.Y.Z -m "StockBar vX.Y.Z" && git push origin vX.Y.Z`。标签必须匹配 `v*` 才会触发。
4. **等构建**：`build` 矩阵跑 macOS（`--target universal-apple-darwin`，Intel + Apple Silicon 通用）和 Windows（MSI + NSIS）；各平台产物先上传到本次运行的 Artifacts，再由 `release` 作业汇总创建 **Release 草稿**。
5. **写发布描述（必做）**：草稿初始 body 只有 `--generate-notes` 生成的一行 Full Changelog，发布前必须补成正式发布说明，按固定结构写：
   - 开头一句话：这个版本是什么、给谁用；
   - `## 功能`：本版新增或变化的能力，用面向用户的话术；
   - `## 下载`：表格列出 `StockBar_<版本>_universal.dmg`、`_x64-setup.exe`、`_x64_zh-CN.msi`，并保留 macOS 未签名、首次打开需右键「打开」或 `xattr -dr com.apple.quarantine` 的提示；
   - `## 已知限制`：无节假日日历、不保证交易所级实时性等；
   - 结尾保留 Full Changelog 链接。
6. **发布**：在 GitHub 上把草稿 Publish。草稿期间 URL 显示成 `untagged-...` 属正常，发布后即 `releases/tag/vX.Y.Z`。
7. **不发版的验证**：在 Actions 页面手动运行 `build`（`workflow_dispatch`），只构建并上传 Artifacts，不建 Release。

坑：

- `main` 要先推上去，标签指向的提交才在远端默认分支上。
- 不要让多个平台作业各自调 `tauri-action` 建 Release，会并发撞车；现在的分工是各平台只上传 Artifacts，单独一个作业汇总。
- `gh release upload` 不能喂目录：`upload-artifact` 会保留匹配路径的公共父目录（Windows 的 `msi/`、`nsis/`），所以 release 作业里那步 `find dist -type f` 展平不能删。
- macOS 包未签名与公证是已知状态，不是回归。
