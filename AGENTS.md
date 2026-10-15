# AGENTS.md — StockBar

菜单栏盯盘小工具。Tauri 2（Rust）+ 原生 TypeScript + Vite，**不用 UI 框架、不用图表库**。行情数据来自东方财富公开接口。主要面向 macOS（菜单栏应用、不显示 Dock 图标），Windows/Linux 也做了兼容处理。

## 常用命令

```bash
pnpm install
pnpm dev            # 只跑前端，浏览器打开 http://localhost:1420（Tauri 调用自动变成空操作）
pnpm build          # tsc --noEmit + vite build → dist/
pnpm app:dev        # tauri dev：启动完整的菜单栏应用
pnpm app:build      # tauri build → src-tauri/target/release/bundle/（要带 TAURI_SIGNING_PRIVATE_KEY，见「发布流程」）
pnpm test           # vitest 单元测试
pnpm test           # vitest 单元测试（src/ 与 mcp/ 与 scripts/）
pnpm mcp            # 用 stdio 跑 MCP 服务，供 MCP 客户端配置（见「MCP 本地桥」）
pnpm check          # tsc --noEmit + vitest
cd src-tauri && cargo check   # Rust 侧检查
```

- 包管理器用 **pnpm**（`packageManager` 字段已锁定版本），不要用 npm 或 yarn。
- 单元测试用 **vitest**：`src/*.test.ts` 跑在 happy-dom 环境，覆盖 api / bar / settings / ctxmenu / drag / tabs / mcp / update 里的纯逻辑，以及两处界面接线 —— 设置窗口搜索结果右键（`prefs.test.ts`）与主面板自选行置顶（`main.test.ts`），两者都用假搜索 / 报价真起一遍对应的窗口脚本（`main.ts` 起的是 `#app`，与 `index.html` 一致）；`mcp/*.test.mjs` 与 `scripts/*.test.mjs` 是脚本测试，文件头用 `// @vitest-environment node` 切到 node 环境（含一条真的起进程 + 假本地桥的端到端用例）。没有 lint 或格式化配置。
- 改完之后至少跑通 `pnpm check`（类型检查加单元测试）和 `pnpm build`；改了 Rust 就再跑一次 `cargo check`。改了纯逻辑要补对应测试。
- Vite 开发端口固定为 1420（`strictPort`），和 `tauri.conf.json` 里的 `devUrl` 一一对应，两边必须一起改。

## 目录结构

```
index.html      → src/main.ts   + src/style.css   主面板（托盘弹出的 360×560 无边框小窗，label="main"）
settings.html   → src/prefs.ts  + src/prefs.css   设置窗口（仪表盘 / 行情 / MCP / 关于 / 设置五页，label="settings"，由 Rust 动态创建）
ticker.html     → src/ticker.ts + src/ticker.css  Windows 悬浮行情条（label="ticker"，由 set_ticker 动态创建/关闭）
src/api.ts       东方财富接口：批量报价 ulist.np、分时 trends2、搜索 suggest（JSONP）、secid/市场/交易时段工具函数
src/settings.ts  Settings 类型、默认值、localStorage 读写和旧数据迁移、跨窗口同步、主题和涨跌配色、自选分组的纯函数（`itemsOf` / `moveInView` / `normalizeGroups` 等）
src/bar.ts       菜单栏内容生成：单行文字 barText / 双行紧凑 canvas PNG barImage
src/tauri.ts     Tauri 桥接层：call / emitAll / listenAll（非 Tauri 环境自动降级为空操作），平台判断 IS_WIN、canvas 字体栈 UI_FONT
src/ctxmenu.ts   通用右键菜单 openMenu / closeMenu（样式 ctxmenu.css，主面板与设置窗口共用；选项 className 用来给菜单打标，如搜索菜单的 ctx-search）
src/drag.ts      拖动排序的纯计算：slotAt（指针落在第几格）/ shiftIndex（拖动中其他行让开多少），设置窗口的仪表盘与行情页共用
src/tabs.ts      分组筛选条的纯计算：isDragMove / isDragClick（横滑拖动与「拖完那一下 click」的判定）/ scrollDeltaFor（把选中的标签带进视野要滚多少），主面板用
src/mcp.ts       MCP 命令处理：看 / 搜 / 增删自选、置顶、排序、分组增删改排序的纯逻辑（搜索与报价由调用方注入）；另含设置面板 MCP 卡片用的 clientConfig()（客户端配置 JSON）与 bridgeState()（状态文案）
src/update.ts    版本更新的纯逻辑：状态文案、下载进度、提示条文案（联网在 Rust 侧）
src-tauri/src/lib.rs   托盘、弹窗定位（按鼠标位置把面板夹进工作区，见「坑」）、失焦自动收起、单实例、所有 #[tauri::command]
src-tauri/src/bridge.rs    MCP 本地桥：回环地址上的 HTTP 入口、令牌与连接信息文件、命令转发与回信配对；info() 给设置面板报桥状态与脚本路径
src-tauri/src/update.rs    应用内更新：检查 / 下载 / 安装 / 重启，待装的更新存在模块级静态量里（命令壳在 lib.rs）
src-tauri/capabilities/default.json   三个窗口（main / settings / ticker）的权限
.github/workflows/build.yml   双端打包：推 v* 标签构建 macOS（通用二进制）+ Windows 安装包与更新包，合并出 latest.json 并创建 Release 草稿，或手动触发上传 Artifacts
mcp/lib.mjs + mcp/stockbar-mcp.mjs   零依赖 MCP 服务（stdio JSON-RPC）：工具表、端点发现、把命令转给本地桥（`pnpm mcp` 可直接跑）
scripts/latest-json.mjs   把各平台的更新包与签名整理成 latest.json 片段并合并成一份（CI 用；纯逻辑有单测）
```

Vite 是多页面打包，入口在 `vite.config.ts` 的 `rollupOptions.input` 里，新增页面要在这里登记。

## 架构要点

**状态与同步**
- 唯一的持久化存储是 `localStorage["stockbar.settings.v1"]`，两个窗口同源，共用这一份数据。
- 写设置只用 `saveSettings()`，它会同时广播 Tauri 事件 `settings-changed`。接收方通过 `onSettingsChange()` 收到通知，同时监听 `storage` 事件和 Tauri 事件，因此回调必须**幂等**。用 TOKEN 区分来源，自己发出的广播会被忽略。
- `Settings` 新增字段时：在 `DEFAULTS` 里补上默认值；字段形状变化时在 `loadSettings()` 里写迁移逻辑（可以参考已有的 `pinned → bar` 迁移）。不要轻易修改 `STORE_KEY`，否则用户已有的设置会全部丢失。
- 主面板收到同步时会保留自己的 `selected`，不会被设置窗口的值覆盖。
- `watchlist` 的顺序就是显示顺序，置顶的（`pins`）始终在最前，由 `normalizePins()` 在 `loadSettings()` 里保证。新增或删除自选时要同步 `pins`，拖动排序的落点用 `clampBlock()` 限制在各自区块内。
- 置顶在主面板里可以直接做：自选行的右键菜单第一项是置顶 / 取消置顶，走 `togglePin()`（`pinItem` / `unpinItem`），与设置窗口「行情」页的行尾按钮等效，两边都改同一份 `pins`。置顶行用 `.row.pinned` 的浅底色区分（与「当前选中」的 `.row.active` 靠浓度分开：置顶 5%、选中 10% 且带左侧竖条），分界画在**置顶区之后的第一行**（`.row.first-unpinned`）而不是置顶区最后一行 —— 置顶那行自己的分时图紧跟其后，画在它身上会在「行与自己的图之间」也多出一条线；全都置顶时没有分界。置顶区的长度按**当前视图**算（`pinCount(ids, S.pins)`），分组视图里置顶的也排在该分组最前。
- 自选分组是 `groups`（有序，`{id, name}`）+ `groupOf`（secid → 分组 id），只决定自选怎么分堆：`watchlist` 仍是唯一一份顺序，`bar` 与 `pins` 都不受分组影响。没有归属、或指向已删分组的都算「未分组」（`UNGROUPED`），`loadSettings()` 用 `normalizeGroups()` 规整（分组 id 必须是 `^[A-Za-z0-9_-]{1,24}$`，才能安全拼进选择器）。新建 / 改名 / 删除 / 排序都是 `settings.ts` 里的纯函数，删分组只把成员回落到未分组。
- 单个与批量「移入分组」共用同一套逻辑：单个用 `groupTargets()`，多选用 `groupTargetsFor()` + `setGroupMany()`（前者把「已经全在该分组」的目标标成 done，菜单里置灰、一个可用目标都没有时操作条上的入口直接禁用）。大盘指数不能分组，所以批量只把选中的自选交出去。
- 两个搜索框的结果行（主面板的搜索、设置「行情」页的新增自选）都支持右键：还不是自选的给「加入自选」和每个分组一项「加入并移入「X」」，已经是自选的给「移入「X」」（不含它当前所在的那个）与置顶 / 取消置顶。菜单项由 `settings.ts` 的 `searchActions()` 算，动作用 `applySearchAction()` 落到设置上，两个窗口只负责把新状态写回自己的 `S` 并重画。两者都**独立再挡一次**搜索接口能返回的边界情况：内置大盘指数（`isIndex()`）不给菜单、左键也加不进自选（与 MCP 的 add 同一条规则）；菜单是点开那一刻渲染的，所以点下去时目标分组已被删就按未分组处理、标的已不在自选里就不留归属。右键动作**不收起搜索结果**（点完这一行当场从 ＋ 变成「已添加」，好连着整理几只），因此两处「点别处收起搜索」的判断放过的是搜索菜单的标记类 `ctx-search`（由 `openMenu()` 的 `className` 选项挂上）—— 别写成放过整个 `.ctx-menu`，那样点自选行 / 分组标题的菜单时搜索结果会一直赖着不走，而它并不会被重画，行上的「已添加」就可能是过期的。
- 分组标题的操作菜单由 `#watch-groups` 一处委托：标题右侧的「⋯」按钮左键点开，右键标题也可以（未分组不给菜单）。删除分组必须先就地确认：点「删除分组…」只把 `groupConfirm` 置上、把标题行换成确认条（`groupHead()` 渲染，文案里报出成员会回到未分组），真正删除只发生在确认条的「删除」上。`groupConfirm` 进 `groupsKey`，确认态的变化才会重建 DOM；确认态下右键标题不再叠菜单，Esc 先取消确认、再清多选。危险按钮用固定的 `#ff453a`，不要跟随 `--up`（绿涨红跌下会变成绿色）。
- 分组视图里的拖动要用 `moveInView()` 把可见下标换算成整表下标，落点仍用 `clampBlock()` 按可见列表（也就是该分组内的置顶区）钳制。设置窗口的每个分组区块各注册一次 `sortable()`；区块会随分组增减重建，所以「拖完那一下 click」的标记放在外部 `marketSwallow` 里由各实例共用，不能退回成实例内的局部变量。

**MCP 本地桥（外部配置）**
- 外部 MCP 客户端（`mcp/stockbar-mcp.mjs`，stdio JSON-RPC）改自选与分组走这条链路：HTTP 桥（`bridge.rs`，只监听 `127.0.0.1` 的随机端口）→ Tauri 事件 `mcp-request` → 主面板 → `src/mcp.ts` 的 `prepareCommand()` / `apply()` → `saveSettings()` → 前端再调 `mcp_reply` 回信。**命令永远由前端执行**，所以 MCP 改动的校验、规整、广播与手点界面完全一致（设置窗口、菜单栏都会跟着刷新）。
- 桥只在应用运行时、且设置里的 MCP 开关打开时才存在：连接信息（随机端口 + 令牌）写在 app data 目录的 `mcp-endpoint.json`（macOS 为 `~/Library/Application Support/com.stockbar.eastmoney/`，权限 0600），退出或关掉开关时删掉；令牌只用来挡本机其他进程。
- 前端注册好监听后才调 `mcp_ready` 置位 READY，之前到达的命令会被明确拒绝（「还在启动」），而不是静默超时。等前端回信的上限是 32 秒，请求里带一个早 4 秒的 `deadline`：命令来不及了就不改设置、直接回「超时」，免得出现「客户端收到失败、设置其实改了」。
- 设置窗口左侧导航里有一页独立的「MCP」（`prefs.ts`，排在「设置」上面，`data-page="mcp"`；切到它时 `go()` 会重新问一次状态）：状态来自 `mcp_info` 命令（`bridge.rs` 的 `info()`：端口 / 是否就绪 / 脚本路径），配置片段由 `src/mcp.ts` 的 `clientConfig()` 生成、一键复制。`mcp/stockbar-mcp.mjs` 与 `mcp/lib.mjs` 由 `tauri.conf.json` 的 `bundle.resources` 打进 `resource_dir()/mcp/`（macOS 是 `StockBar.app/Contents/Resources/mcp/`），页面给出的路径安装后直接可用；debug 构建里退回仓库的 `mcp/`，两者都找不到就给占位符让用户自己填。改 resources 的落点要连带改 `bridge.rs` 里按 `SCRIPT_FILE` 拼的查找路径。
- **开关**（设置里的 `mcp`，默认关）决定桥起不起：Rust 读不到 localStorage，所以桥不在 `setup()` 里起 —— 主面板注册好监听后调 `mcp_set_enabled` 按设置开 / 关，MCP 页拨开关时也调它（命令返回开关后的状态，页面一次往返就刷新）。`bridge.rs` 的 `enable()` 绑端口 + 写连接信息文件，`disable()` 用 `tiny_http` 的 `unblock()` 让服务线程退出、丢掉 `SERVER` 里的最后一份 `Server` 释放端口，再删掉连接信息文件；因此关掉时是「端口根本不存在」，外部客户端拿到的是与「应用没在运行」相同的提示。
- 命令分两段：`prepareCommand()` 先做要联网的部分（搜索 / 报价 / 确认成员还在），返回一个 `apply(latest)` 闭包，由主面板在**当时最新**的 `S` 上执行 —— 命令等网线的这几秒里设置窗口改过的东西（主题、刷新间隔、自选本身）不会被打回旧快照；`runCommand()` 是「准备完立刻执行」的便捷入口，只有测试与简单调用用。
- op 名是 `watchlist.*` / `groups.*` / `instrument.*`（见 `src/mcp.ts` 的 `prepareCommand` switch），MCP 工具名、描述与入参 schema 在 `mcp/lib.mjs` 的 `TOOLS` 里：**新增能力要两边一起加**。参数校验在命令处理里做，不信 schema 的「required」。
- 标的用「secid 或关键词」指代：`resolveTarget()` 先认 secid 正则，否则走搜索；命中多只就报错并把候选列出来，让模型用 secid 再问一次。加入自选前会用一次报价确认代码不是编的（报价接口本身挂了就放行，并在结果里说明「未能校验」）。
- 分组用「名字或 id」指代，找不到就报错并列出可选分组；「未分组」是内置的，不能改名 / 排序 / 删除。删除分组只把成员回落到未分组，自选一只都不少。

**版本更新（应用内）**
- 检查与安装都在 Rust 侧（`src-tauri/src/update.rs`，命令壳在 `lib.rs`）：`tauri-plugin-updater` 请求 `tauri.conf.json` 里配的端点（GitHub Release 上的 `latest.json`），按公钥校验签名、下载、替换安装包。前端只管文案与进度，纯逻辑在 `src/update.ts`，两个窗口共用。
- 端点与公钥写在 `tauri.conf.json` 的 `plugins.updater`：端点是 `releases/latest/download/latest.json`，所以「最新那份已发布的 Release」就是所有用户拿到的东西。Windows 用 `installMode: passive`（安装时有个小进度窗，不需要交互）。
- 进度走 Tauri 的 `Channel`（不是事件）：`update_install` 的 `on_event` 依次推 `{event:"started",data:{contentLength}}`、`{event:"progress",data:{chunkLength}}`、`{event:"finished"}`。这个形状由 `update.rs` 的单测钉住 —— `DownloadEvent` 上那行 `rename_all_fields` 不能删，删了字段名会变回 snake_case，前端读不到字节数（`rename_all` 只管变体名）。
- 启动检查一次：主面板起来 4 秒后调 `update_check`（设置里的 `updateCheck` 关掉就不查），有新版才在顶栏下面挂提示条；点提示条调 `open_settings({ page: "about" })` 落到「关于」页。
- 设置窗口的「关于」页：当前版本来自 `app_version`（不联网），三个入口是检查更新 / 立即更新 / 打开发布页；装完自动调 `update_restart` 重启（Windows 上安装器会让应用自己退出，走不到这一步）。检查与安装用 `callOrThrow()` 而不是 `call()`：失败原因要显示给用户，不能被静默吞掉。
- 待装的更新存在 `update.rs` 的 `PENDING` 静态量里：检查到的那份 `Update` 带着下载地址与签名，装的时候必须用同一个，所以别把它丢掉；安装失败会放回去，重试不必重新检查。
- 「该打开哪一页」有两套路径：设置窗口已经开着就直接发 `goto-page` 事件；窗口是新建的就先把页名存进 `PENDING_PAGE`，等前端挂好监听调 `settings_ready` 来取（建窗那一刻发事件会早于前端注册监听）。

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
- 前端可以调用的命令：`set_tray_text`、`set_tray_image`、`open_settings`（可带 `page` 指定打开哪一页）、`set_ticker`、`fit_ticker`、`ticker_click`、`hide_window`、`quit_app`、`mcp_ready`、`mcp_reply`、`mcp_info`、`mcp_set_enabled`、`app_version`、`update_check`、`update_install`、`update_restart`、`open_release_page`、`settings_ready`。新增命令要同时改两处：在 `generate_handler![]` 里注册，前端通过 `call()` 调用。MCP 与更新的命令壳写在 `lib.rs`、实现放在 `bridge.rs` / `update.rs`（原因见「坑」）。
- **建窗口的命令必须是 `async fn`**：Windows 上 WebView2 不会在事件回调里重入，同步命令跑在 IPC 回调里，`WebviewWindowBuilder::build()` 会让 `create_controller` 永远等不到完成回调，整个应用卡死（tauri 文档的 Known issues / wry#583）。`open_settings`（建设置窗口）与 `set_ticker`（建行情条）因此都是 async，真正的建窗逻辑放在同步的 `open_settings_window()` / `set_ticker_window()` 里，由 async 命令（跑在 tokio 线程池上）调用；单实例回调里也是另起线程调 `open_settings_window()`，不在窗口过程里建窗。
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
- 列表里的破坏性操作统一走右键：`src/ctxmenu.ts` 的 `openMenu()`（主面板删自选、设置「行情」页增删菜单栏标的）。菜单样式由两个窗口各自的 CSS 用 `@import "./ctxmenu.css"` 引入；菜单打开时 Esc 只关菜单，不会连带收起主面板。菜单项可以带 `icon`（内联 SVG，只传本仓库自己的常量，不做转义）；同一份菜单里只要有一项带图标，其余项也占一个等宽的空位（`.ctx-ico`），文字才不会参差不齐 —— 置顶 / 取消置顶用的就是这一对图标。

## 注意事项（坑）

- 菜单栏图标只有一份：`src-tauri/icons/tray.png`。Rust 用 `include_bytes!` 嵌入，`prefs.ts` 也直接 import 这个文件做预览，替换时只改这一处。
- 已启用 CSP（`tauri.conf.json` 的 `csp` / `devCsp`）。新增外部域名时必须同步放行：fetch 走 `connect-src`，JSONP 走 `script-src`，图片走 `img-src`。`devCsp` 额外放行了 Vite 的 `localhost:1420`。`macOSPrivateApi: true` 是透明窗口需要的，不要关。
- `dist/`、`src-tauri/target/`、`src-tauri/gen/` 都是生成产物，不要手动修改。
- 项目是 git 仓库，生成产物已在 `.gitignore` 中排除。
- MCP 的名字是三处对齐的：事件名 `mcp-request`、命令 `mcp_reply`、回信的载荷形状散在 `bridge.rs` / `main.ts` / `mcp/lib.mjs` 里，改一处要三处一起改；新增一条 op 同理（`src/mcp.ts` 的 switch + `mcp/lib.mjs` 的工具表）。
- `#[tauri::command]` 定义在子模块里时 `generate_handler!` 的宏路径很难伺候（命令宏落在 crate 根，`bridge::mcp_ready` 这类路径解析不到），所以命令壳统一写在 `lib.rs`，实现函数放 `bridge.rs`。
- MCP 相关改动不碰 CSP：那些请求由 Rust 侧处理，不经过 webview。`mcp-endpoint.json` 里是端口与令牌，不要提交进仓库或日志。
- 面板定位不要交回 `tauri-plugin-positioner`：它在多显示器 / 缩放不一致的机器上会把窗口丢到屏幕外（实测主屏 2304 点宽，窗口被放到 x=2795，点菜单栏图标看着就是「点了没反应」）。macOS 现在按鼠标位置（点图标时鼠标就在图标上）自己算 `panel_position()`，并夹进工作区；positioner 只在连屏幕都问不出来时兜底。
- 命令里建 webview 窗口在 Windows 上必卡死，症状是「托盘图标在、点它没反应」，或第二个实例弹出的设置窗口标题栏写着「未响应」且永不恢复，只能强杀。原因是 WebView2 不允许在事件回调里重入创建 webview：同步命令跑在 IPC 回调里，`WebviewWindowBuilder::build()` 的 `create_controller` 永远等不到完成回调（tauri 文档的 Known issues、wry#583）。所以建窗的同步命令一律改成 `async fn`，回调 / 窗口过程里建窗一律另起线程 —— 现在的 `open_settings` 与 `set_ticker` 都按这个来，新增建窗能力照做。`set_ticker` 尤其要留意：默认设置里 `ticker: true`，Windows 每次启动都会走这条路。
- 界面里「不许选中文字」只用无前缀 `user-select: none` 是不够的：macOS 的 WKWebView 不认这个属性（实测 `CSS.supports('user-select','none')` 为 false，规则被整条丢弃），于是自选行、标题这些文字能被拖选出来。三份样式表（`style.css`、`prefs.css`、`ticker.css`）里的 `user-select` 都要**同时写 `-webkit-user-select`**，需要能复制的地方（搜索框、MCP 配置块、更新说明）保留 `text` 值。`-webkit-user-select` 在 WebKit 里会继承，所以写在 `html, body` 上就够了；输入框不受影响（WebKit 给表单控件算的是 `text`）。

## 发布流程

发布由 `.github/workflows/build.yml` 承担，不要在本地 `pnpm app:build` 之后手动传安装包。

签名密钥（每个仓库做一次）：`pnpm tauri signer generate -w ~/.tauri/stockbar.key` 会生成 `stockbar.key`（私钥）与 `stockbar.key.pub`（公钥）。公钥内容填进 `tauri.conf.json` 的 `plugins.updater.pubkey`，私钥内容填进仓库 Secret；私钥别进仓库、也别丢 —— 丢了之后已经装过老版本的用户再也收不到更新。

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/stockbar.key
```

1. **定版本**：四处版本号必须一致 —— `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock` 里的 `stock-bar`。安装包文件名取自 `tauri.conf.json` 的 `version`。
2. **提交并推 main**：`git commit` 后 `git push origin main`。CI 会先跑 `pnpm check`，不通过就不构建。
3. **打标签推送**：`git tag -a vX.Y.Z -m "StockBar vX.Y.Z" && git push origin vX.Y.Z`。标签必须匹配 `v*` 才会触发。
4. **等构建**：`build` 矩阵跑 macOS（`--target universal-apple-darwin`，Intel + Apple Silicon 通用）和 Windows（MSI + NSIS）；各平台除安装包外还产出**更新包**（`.app.tar.gz` / `-setup.exe` 与它们的 `.sig`）和一份 `latest-<平台>.json` 片段，先上传到本次运行的 Artifacts，再由 `release` 作业合并成 `latest.json` 并创建 **Release 草稿**。
5. **写发布描述（必做）**：草稿初始 body 只有 `--generate-notes` 生成的一行 Full Changelog，发布前必须补成正式发布说明，按固定结构写：
   - 开头一句话：这个版本是什么、给谁用；
   - `## 功能`：本版新增或变化的能力，用面向用户的话术；
   - `## 下载`：表格列出 `StockBar_<版本>_universal.dmg`、`_x64-setup.exe`、`_x64_zh-CN.msi`，并保留 macOS 未签名、首次打开需右键「打开」或 `xattr -dr com.apple.quarantine` 的提示；
   - `## 已知限制`：无节假日日历、不保证交易所级实时性等；
   - 结尾保留 Full Changelog 链接。
   - 注意：`latest.json` 里的 `notes` 取自草稿创建那一刻的正文（也就是 `--generate-notes` 生成的那份）。要让应用「关于」页显示改写后的正式说明，就在改完正文后重跑一次这个工作流：`gh workflow run build.yml --ref vX.Y.Z`（会重新构建并覆盖 Release 上的资产与 latest.json）。
6. **发布**：在 GitHub 上把草稿 Publish。草稿期间 URL 显示成 `untagged-...` 属正常，发布后即 `releases/tag/vX.Y.Z`。应用内更新读的是 `/releases/latest/download/latest.json`，所以**公开之后**新版本才对所有人生效。
7. **不发版的验证**：在 Actions 页面手动运行 `build`（`workflow_dispatch`），只构建并上传 Artifacts，不建 Release。

坑：

- `main` 要先推上去，标签指向的提交才在远端默认分支上。
- 不要让多个平台作业各自调 `tauri-action` 建 Release，会并发撞车；现在的分工是各平台只上传 Artifacts，单独一个作业汇总。
- `gh release upload` 不能喂目录：`upload-artifact` 会保留匹配路径的公共父目录（Windows 的 `msi/`、`nsis/`），所以 release 作业里那步 `find dist -type f` 展平不能删；展平时要排掉 `latest-*.json`（那是各平台片段，合并完就不该再当资产传上去）。
- 更新包必须签名：仓库 Secret `TAURI_SIGNING_PRIVATE_KEY` 存 `~/.tauri/stockbar.key` 的内容（私钥没设密码时 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` 留空即可）。**缺这个 secret 会直接构建失败** —— `bundle.createUpdaterArtifacts` 要私钥签名；本地 `pnpm app:build` 同理，要带上 `TAURI_SIGNING_PRIVATE_KEY=~/.tauri/stockbar.key`（该变量可以给路径，也可以给内容）。
- `plugins.updater.pubkey` 必须与那把私钥配对：不配对时签名照出、安装时才校验失败，构建期只有一条 warning。换密钥要连公钥一起换，否则老用户再也收不到更新。
- `latest.json` 里的下载地址指向本次标签，而应用读的是 `releases/latest/download/latest.json`：草稿期间更新不生效，公开之后才对用户生效。
- macOS 包未签名与公证是已知状态，不是回归。
