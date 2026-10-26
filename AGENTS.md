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
- 改完之后至少跑通 `pnpm check`（类型检查加单元测试）和 `pnpm build`；改了 Rust 就再跑一次 `cargo check`。改了纯逻辑要补对应测试。
- 单元测试用 **vitest**：`src/*.test.ts` 跑在 happy-dom 环境，覆盖 api / bar / settings / ctxmenu / drag / tabs / search / mcp / update / alerts / backup 里的纯逻辑，以及五处界面接线 —— 设置窗口搜索结果右键与备份卡片（`prefs.test.ts`）、主面板自选行置顶与搜索结果点击去向（`main.test.ts`）、提醒的判定接线（`alerts-wiring.test.ts`）、备份 / 恢复的流程顺序（`backup-wiring.test.ts`：`vi.mock("./tauri")` 假装在应用里，验「先写安全副本再覆盖」与失败时本地不动；后两个各自单独一个文件：它们要一张干净的模块表），都用假搜索 / 报价真起一遍对应的窗口脚本（`main.ts` 起的是 `#app`，与 `index.html` 一致）；`mcp/*.test.mjs` 与 `scripts/*.test.mjs` 是脚本测试，文件头用 `// @vitest-environment node` 切到 node 环境（含一条真的起进程 + 假本地桥的端到端用例）。没有 lint 或格式化配置。
- Vite 开发端口固定为 1420（`strictPort`），和 `tauri.conf.json` 里的 `devUrl` 一一对应，两边必须一起改。

## 目录结构

```
index.html      → src/main.ts   + src/style.css   主面板（托盘弹出的 360×560 无边框小窗，label="main"）
settings.html   → src/prefs.ts  + src/prefs.css   设置窗口（仪表盘 / 行情 / 提醒 / MCP / 关于五页，label="settings"，由 Rust 动态创建）
ticker.html     → src/ticker.ts + src/ticker.css  Windows 悬浮行情条（label="ticker"，由 set_ticker 动态创建/关闭）
src/api.ts       东方财富接口：批量报价 ulist.np、分时 trends2、搜索 suggest（JSONP）、板块列表 clist（fetchBoards）、secid/市场/交易时段工具函数
src/settings.ts  Settings 类型、默认值、localStorage 读写和旧数据迁移、跨窗口同步、主题和涨跌配色、自选分组的纯函数（`itemsOf` / `moveInView` / `normalizeGroups` 等）
src/bar.ts       菜单栏内容生成：单行文字 barText / 双行紧凑 canvas PNG barImage
src/tauri.ts     Tauri 桥接层：call / emitAll / listenAll（非 Tauri 环境自动降级为空操作），平台判断 IS_WIN、canvas 字体栈 UI_FONT
src/ctxmenu.ts   通用右键菜单 openMenu / closeMenu（样式 ctxmenu.css，主面板与设置窗口共用；选项 className 用来给菜单打标，如搜索菜单的 ctx-search）
src/drag.ts      拖动排序的纯计算：slotAt（竖排落点）/ slotAtX（横排落点）/ slotAtGrid（换行摊开的落点，按两轴算）/ shiftIndex（拖动中其他行让开多少），设置窗口与主面板共用
src/tabs.ts      分组筛选条的纯计算：isDragMove / isDragClick（横滑拖动与「拖完那一下 click」的判定）/ scrollDeltaFor（把选中的标签带进视野要滚多少），主面板用
src/sortable.ts  拖动排序的 DOM 侧逻辑：指针 / 位移 / 落点（纯计算在 drag.ts）+ 键盘 Alt + ←→；设置窗口（自选行、分组胶囊）与主面板（自选行）共用，行选择器之外的行不参与拖动
src/boards.ts    板块榜单的纯逻辑：口径文案（行业 / 概念 / 地域）、Ⅱ / Ⅲ 细分识别与过滤、涨跌榜排序（联网在 api.ts 的 fetchBoards，DOM 在主面板）
src/search.ts    搜索结果的点击去向：点行本身（hitAction：预览 / 跳过去）与跳过去时该看哪个分组（filterToReveal），主面板用
src/mcp.ts       MCP 命令处理：看 / 搜 / 增删自选、置顶、排序、分组增删改排序的纯逻辑（搜索与报价由调用方注入）；另含设置面板 MCP 卡片用的 clientConfig()（客户端配置 JSON）与 bridgeState()（状态文案）
src/update.ts    版本更新的纯逻辑：状态文案、下载进度、提示条文案（联网在 Rust 侧）
src/alerts.ts    提醒的判定与通知文案：条件判定、边缘触发 + 重新武装、冷却、通知标题与正文、触发状态的存取（纯逻辑，联网与送达在调用方）
src/notify.ts    系统通知的薄封装：权限查询 / 请求、发一条、点通知的回调（浏览器预览里全部降级为空操作）
src/backup.ts    WebDAV 备份 / 恢复的纯逻辑：地址规整与校验、备份信封（makeBackup / parseBackup）、恢复时的字段取舍（restoreSettings）、状态文案（联网与加解密在 Rust 侧）
src-tauri/src/lib.rs   托盘、弹窗定位（按鼠标位置把面板夹进工作区，见「坑」）、失焦自动收起、单实例、所有 #[tauri::command]
src-tauri/src/bridge.rs    MCP 本地桥：回环地址上的 HTTP 入口、令牌与连接信息文件、命令转发与回信配对；info() 给设置面板报桥状态与脚本路径
src-tauri/src/update.rs    应用内更新：检查 / 下载 / 安装 / 重启，待装的更新存在模块级静态量里（命令壳在 lib.rs）
src-tauri/src/backup.rs    WebDAV 备份：PUT / GET / OPTIONS 走 Rust（绕开 CORS）、slot → 文件名、密码的 AES-256-GCM 加解密与 secret.key
src-tauri/src/notify.rs    系统通知：macOS 用 UNUserNotificationCenter 自己发（授权 / 投递 / 点击回调），Windows 交给插件
src-tauri/capabilities/default.json   三个窗口（main / settings / ticker）的权限
.github/workflows/build.yml   双端打包：推 v* 标签构建 macOS（通用二进制）+ Windows 安装包与更新包，合并出 latest.json 并创建 Release 草稿，或手动触发上传 Artifacts
mcp/lib.mjs + mcp/stockbar-mcp.mjs   零依赖 MCP 服务（stdio JSON-RPC）：工具表、端点发现、把命令转给本地桥（`pnpm mcp` 可直接跑）
scripts/latest-json.mjs   把各平台的更新包与签名整理成 latest.json 片段并合并成一份（CI 用；纯逻辑有单测）
docs/adr/0001-boards-are-read-only.md   架构决定：板块只做只读榜单，不进自选（为什么板块不是标的）
docs/adr/0002-alerts-fire-on-crossing.md   架构决定：提醒是「穿越那一刻通知一次」，含冷却与跨交易日重新武装
```

Vite 是多页面打包，入口在 `vite.config.ts` 的 `rollupOptions.input` 里，新增页面要在这里登记。

## 架构要点

**状态与同步**
- 唯一的持久化存储是 `localStorage["stockbar.settings.v1"]`，两个窗口同源，共用这一份数据。
- 写设置只用 `saveSettings()`，它会同时广播 Tauri 事件 `settings-changed`。接收方通过 `onSettingsChange()` 收到通知，同时监听 `storage` 事件和 Tauri 事件，因此回调必须**幂等**。用 TOKEN 区分来源，自己发出的广播会被忽略。
- `Settings` 新增字段时：在 `DEFAULTS` 里补上默认值；字段形状变化时在 `loadSettings()` 里写迁移逻辑（可以参考已有的 `pinned → bar` 迁移）。不要轻易修改 `STORE_KEY`，否则用户已有的设置会全部丢失。
- 主面板收到同步时会保留自己的 `selected`，不会被设置窗口的值覆盖。
- `watchlist` 的顺序就是显示顺序，置顶的（`pins`）始终在最前，由 `normalizePins()` 在 `loadSettings()` 里保证。新增或删除自选时要同步 `pins`；拖动排序的落点不设限 —— 跨过置顶分界那一下对 `pins` 的改动由 `moveRowInView()`（`settings.ts`）处理，两条命令（手拖 / MCP）走的是同一份。
- 置顶在主面板里可以直接做：自选行的右键菜单第一项是置顶 / 取消置顶，走 `togglePin()`（`pinItem` / `unpinItem`），与设置窗口「行情」页的行尾按钮等效，两边都改同一份 `pins`。置顶行用 `.row.pinned` 的浅底色区分（与「当前选中」的 `.row.active` 靠浓度分开：置顶 5%、选中 10% 且带左侧竖条），分界画在**置顶区之后的第一行**（`.row.first-unpinned`）而不是置顶区最后一行 —— 置顶那行自己的分时图紧跟其后，画在它身上会在「行与自己的图之间」也多出一条线；全都置顶时没有分界。置顶区的长度按**当前视图**算（`pinCount(ids, S.pins)`），分组视图里置顶的也排在该分组最前。
- 自选行也能直接拖动排序（主面板与设置 › 行情的行都能拖）：主面板里鼠标从行的任意处按下后**要按住 `HOLD_MS`（200ms）才进入拖动**（见 `src/sortable.ts`；按下即进入拖动的话「点行展开分时」和「拖行排序」分不开，手抖几像素顺序就变了），触屏只从名称起拖（行其他地方留给列表滚动，见 `.row-name` 的 `touch-action`）。按住期间指针晃超过 `HOLD_SLOP`（8px）就当成别的手势作废；进入拖动后要让开 `MOVE_SLOP`（4px）才换落点。把手（设置页的 `.stock-handle` / `.ord-handle`、分组胶囊）是明确的拖动意图，按下即拖、不等。**落点不设限**（`sortable()` 里已经没有「落点钳制」这个选项）：跨过置顶分界的那一下由 `moveRowInView()` 连着改置顶 —— 落点那一格在置顶区里就顺手置顶、落到置顶区之下就顺手取消置顶，于是「置顶区始终是自选最前的一段」一直成立，拖不出要靠 `normalizePins()` 救回来的顺序；分组视图里它用 `moveInView()` 把可见下标换算成整表下标，最后把 `watchlist` 与 `pins` 一起写回。松手跟来的那一下 click 由 `isDragClick()` 吞掉（`rowDraggedAt`），不会顺手把分时图展开了。拖动中用 `.row.dragging` / `.list.dragging`（设置窗口那套是 `.stock.dragging` / `.sec-body.dragging`）。
- 自选分组是 `groups`（有序，`{id, name}`）+ `groupOf`（secid → 分组 id），只决定自选怎么分堆：`watchlist` 仍是唯一一份顺序，`bar` 与 `pins` 都不受分组影响。没有归属、或指向已删分组的都算「未分组」（`UNGROUPED`），`loadSettings()` 用 `normalizeGroups()` 规整（分组 id 必须是 `^[A-Za-z0-9_-]{1,24}$`，才能安全拼进选择器）。新建 / 改名 / 删除 / 排序都是 `settings.ts` 里的纯函数，删分组只把成员回落到未分组。
- 分组胶囊的拖动排序有两处：设置 › 行情 那排胶囊（`#gchip-list .gchip`，横排 `axis: "x"`）与主面板末尾 ☰ 的弹层（`.ctx-menu.chips` 里带 `data-key` 的胶囊，会换行所以用 `axis: "grid"`）—— 两者顺序都是 `groups` 的顺序（`moveItem`）。**主面板筛选条上不做排序**：那里「横滑看后面的分组」和「拖胶囊排序」都是横向手势，放一起会撞（筛选条的按住拖动一直只做横滑，见 `#gtab-scroll`）；☰ 弹层把全部分组一次摊开、不需要横滑，所以放它那儿。**主面板筛选条与 ☰ 弹层里只有「全部」与用户建的分组**：没有归属的股票本来就在「全部」里，不单列「未分组」（`groupTabs()` 不再产出它）；「全部」不给 `key`（`MenuItem.key` → `data-key`）也就不在拖动行选择器里，拖不走（弹层末尾那颗「＋ 新建分组」同样不给 `key`，见下一条）。设置 › 行情 那边保留「未分组」—— 那里没有「全部」，未分组的股票只能在那一段里看到和整理，胶囊行最前面那颗固定胶囊就是跳过去的入口。弹层里的拖动落点用 `slotAtGrid()`（换行后按两轴取最近一格）。**换位要就地重排那排胶囊的 DOM，别关掉重开**：重开整层重建，弹层的入场动画会再播一次，看着就是「拖完闪一下」（同理，清位移前先把 `transition` 关掉、回流后再放开，否则清位移本身也会被动画化）。拖动松手跟来的那一下 click 由 `isDragClick()` 的时间窗吞掉（`moreDraggedAt`，在弹层上以捕获阶段拦），不会顺手切分组、也不会把弹层收起来。
- 主面板上也能管分组：**筛选条上不放常驻按钮**（那一格一直占着 26px，值不值当另说，先按「不占位置」来），新建有两处入口、同一件事 —— ☰ 弹层末尾那颗「＋ 新建分组」胶囊（`groupChips()` 末尾补的一项，不给 `key` 所以拖不走），以及**右键分组标签 / 弹层胶囊的菜单第一项**「＋ 新建分组」（`openGroupMenu()`）。后者是必需的：☰ 只在筛选条溢出时才出现，分组少的人点不开弹层，就只剩这一个入口了。菜单里另两项是「重命名」与「删除分组…」。改名是**就地**把那一格换成输入框（`renderTabs()` 按 `tabRename` 渲染，`mountRename()` 在重建后把光标交出去；`tabRename` 进筛选条的 key，改名期间不会被「内容没变」的重画顶掉），回车 / 失焦提交、Esc 放弃（要 `stopPropagation`，否则连带收起面板），**输入法还在拼字时的回车 / Esc 不算**（`isComposing` / `keyCode 229`，`prefs.ts` 那处同理）—— 重画是 `innerHTML` 换掉整条，会把聚焦中的输入框一起换掉，所以重画前先把手上那份草稿读出来、重画后填回去（别处改了设置、整条因此重画时不会把用户打了一半的名字冲掉）；「带进视野」要在 `syncTabMore()` 之后算（☰ 出不出现会改变能滚的空间，否则新建的那一格会被 ☰ 挡掉半截）。删除分组不可逆，所以菜单里点「删除分组…」只是把菜单换成一条「确认删除（N 只移入未分组）」，第二次点才真的删（`confirmRemoveGroup()`）—— 筛选条只有 26px 高，摊一条确认条放不下（对比设置 › 行情的就地确认条）。两个入口都要求「已经有分组」（筛选条没分组时整条藏起来，也就没有标签可右键），所以第一只分组仍然要在设置 › 行情 里建。顺序调整不进这个菜单（筛选条上「横滑」与「拖胶囊」都是横向手势），仍只在 ☰ 弹层里拖。
- 筛选条在列表滚动时**吸顶**：滚到下面就随时能切分组，不用先滚回最上面。这条规则与板块的控制条（`.bctl`）**共用**（`.gtabs, .bctl { position: sticky; … }`，滚动容器是 `.body`），别拆成两份。三处细节别改坏 —— ① **面板的毛玻璃必须待在独立底层**（`.frost`，`z-index:-1`，面板自己只留边框与圆角）：吸顶条的 `backdrop-filter` 一旦**嵌在一个带 `backdrop-filter` 的祖先里**，浏览器给条算的「底」不是祖先的合成结果，而是祖先那层底色（`--bg` 那层半透明白），于是条比周围的面板表面白出一截 —— 就是「一块白的」（macOS 的 WKWebView 与 WebView2 都这样，实测 `--bg` 挂在面板上时条比表面亮 17 档，挪成兄弟层之后只差 1 档）；② **条不叠底色**，只靠 `backdrop-filter` 把滚过去的行糊掉（糊过去时留一点淡影是有意取的舍：要彻底盖住就得压一层不透明的底，那就又变回白块了）；③ **胶囊的描边常驻**（`.gtab` / `.gtab-more` 的 `border`），因为条不再压白底、胶囊要靠这一圈描边从面板表面上立起来。Windows 反过来 —— 那边模糊透不到桌面、`.win .frost` 关掉、`.win .panel` 自己画不透明底（`.win .panel`），条压一层 `--bg` 不会有色差，所以 `.win .gtabs` 保留底色、不靠模糊。间距走 `padding` **不走 `margin`**（margin 那块没被盖住，行会从缝里透出来），`z-index` 要低于搜索结果的弹层（10）、高于列表里的行（拖动中的行是 3，会浮在它上面）。可见性由 `renderTabs()` 的 `box.hidden = !show` 一处决定：没建分组、或在板块视图里，整条收起（差了这一行就会「胶囊渲染了但整条永远藏着」）。
- 单个与批量「移入分组」共用同一套逻辑：单个用 `groupTargets()`，多选用 `groupTargetsFor()` + `setGroupMany()`（前者把「已经全在该分组」的目标标成 done，菜单里置灰、一个可用目标都没有时操作条上的入口直接禁用）。大盘指数不能分组，所以批量只把选中的自选交出去。
- **主面板搜索结果的左键分两件事**（`src/search.ts` 的 `hitAction()`）：点右边那颗 ＋ 才是**加入自选**（正在看某个分组时直接进这个分组，加完收起结果、选中它、滚到那一行）；点行本身是「先看看」—— 还没加的**就地预览**（`.sr-preview`：一行实时价格 + 一张 `.trend` 分时图，不进自选），已经在自选里的**跳过去**（`filterToReveal()` 决定先切到哪个分组：当前视图里有它就不动，否则切到它所在的分组、没有归属回「全部」，然后滚过去并用 `openTrend()` 展开，注意它是「只展开不收起」—— 已经展开的那一下不该被收回去）。预览与列表里展开的分时图**共用同一个 `.trend` 面板与同一份 `trendCache`**：`previewOpen` 与 `trendOpen` 是两个独立的状态，`isTrendOpen()` 是唯一的判断口，`renderTrendPanels()` 的选择器里也要带上 `#search-results .trend`；分时请求序号因此从「一个全局计数器」改成了**每个标的各一份**（`trendSeq` 是 Map），否则两边同时在拉时后发的那份会把先发的判成过期。预览着的标的也要进 `refresh()` 的报价与分时刷新名单。展开预览时其余结果行先收起（`.search-results.preview .sr:not(.open)`）—— 360px 的小窗里塞不下「一列结果 + 一张图」，再点同一行 / 按 Esc / 改关键词都回到列表。这个点击处理里要 `stopPropagation()`（命中范围是 `.sr, .sr-preview`）：行会被就地重画，等冒泡到 document 时它已经不在 `.search` 里，会被当成「点别处」把刚展开的预览收掉；预览块是那一行的**兄弟**节点（`.sr` 是 flex 行，塞进去会破版），所以点价格行 / 分时图也一样要放过，否则点一下图预览就没了（`main.test.ts` 有一条用例钉住）。
- 两个搜索框的结果行（主面板的搜索、设置「行情」页的新增自选）都支持右键：还不是自选的给「加入自选」和每个分组一项「加入并移入「X」」，已经是自选的给「移入「X」」（不含它当前所在的那个）与置顶 / 取消置顶。菜单项由 `settings.ts` 的 `searchActions()` 算，动作用 `applySearchAction()` 落到设置上，两个窗口只负责把新状态写回自己的 `S` 并重画。两者都**独立再挡一次**搜索接口能返回的边界情况：内置大盘指数（`isIndex()`）不给菜单、左键也加不进自选（与 MCP 的 add 同一条规则）；菜单是点开那一刻渲染的，所以点下去时目标分组已被删就按未分组处理、标的已不在自选里就不留归属。右键动作**不收起搜索结果**（点完这一行当场从 ＋ 变成「已添加」，好连着整理几只），因此两处「点别处收起搜索」的判断放过的是搜索菜单的标记类 `ctx-search`（由 `openMenu()` 的 `className` 选项挂上）—— 别写成放过整个 `.ctx-menu`，那样点自选行 / 分组标题的菜单时搜索结果会一直赖着不走，而它并不会被重画，行上的「已添加」就可能是过期的。
- 分组标题的操作菜单由 `#watch-groups` 一处委托：标题右侧的「⋯」按钮左键点开，右键标题也可以（未分组不给菜单）。删除分组必须先就地确认：点「删除分组…」只把 `groupConfirm` 置上、把标题行换成确认条（`groupHead()` 渲染，文案里报出成员会回到未分组），真正删除只发生在确认条的「删除」上。`groupConfirm` 进 `groupsKey`，确认态的变化才会重建 DOM；确认态下右键标题不再叠菜单，Esc 先取消确认、再清多选。危险按钮用固定的 `#ff453a`，不要跟随 `--up`（绿涨红跌下会变成绿色）。
- 分组视图里的拖动要用 `moveInView()` 把可见下标换算成整表下标（`moveRowInView()` 内部做），落点不设限 —— 该不该置顶按**可见列表**（也就是该分组内那一段置顶区）判定，看到的和落下去的一致。设置窗口的每个分组区块各注册一次 `src/sortable.ts` 的 `sortable()`；区块会随分组增减重建，所以「拖完那一下 click」的标记放在外部 `marketSwallow` 里由各实例共用，不能退回成实例内的局部变量。

**MCP 本地桥（外部配置）**
- 外部 MCP 客户端（`mcp/stockbar-mcp.mjs`，stdio JSON-RPC）改自选与分组走这条链路：HTTP 桥（`bridge.rs`，只监听 `127.0.0.1` 的随机端口）→ Tauri 事件 `mcp-request` → 主面板 → `src/mcp.ts` 的 `prepareCommand()` / `apply()` → `saveSettings()` → 前端再调 `mcp_reply` 回信。**命令永远由前端执行**，所以 MCP 改动的校验、规整、广播与手点界面完全一致（设置窗口、菜单栏都会跟着刷新）。
- 桥只在应用运行时、且设置里的 MCP 开关打开时才存在：连接信息（随机端口 + 令牌）写在 app data 目录的 `mcp-endpoint.json`（macOS 为 `~/Library/Application Support/com.stockbar.eastmoney/`，权限 0600），退出或关掉开关时删掉；令牌只用来挡本机其他进程。
- 前端注册好监听后才调 `mcp_ready` 置位 READY，之前到达的命令会被明确拒绝（「还在启动」），而不是静默超时。等前端回信的上限是 32 秒，请求里带一个早 4 秒的 `deadline`：命令来不及了就不改设置、直接回「超时」，免得出现「客户端收到失败、设置其实改了」。
- 设置窗口左侧导航里有一页独立的「MCP」（`prefs.ts`，`data-page="mcp"`；切到它时 `go()` 会重新问一次状态）：状态来自 `mcp_info` 命令（`bridge.rs` 的 `info()`：端口 / 是否就绪 / 脚本路径），配置片段由 `src/mcp.ts` 的 `clientConfig()` 生成、一键复制。`mcp/stockbar-mcp.mjs` 与 `mcp/lib.mjs` 由 `tauri.conf.json` 的 `bundle.resources` 打进 `resource_dir()/mcp/`（macOS 是 `StockBar.app/Contents/Resources/mcp/`），页面给出的路径安装后直接可用；debug 构建里退回仓库的 `mcp/`，两者都找不到就给占位符让用户自己填。改 resources 的落点要连带改 `bridge.rs` 里按 `SCRIPT_FILE` 拼的查找路径。
- **「仪表盘」一页曾经是两页**：原来的「设置」页（主题 / 涨跌配色 / 刷新间隔 / 数据来源）已经并进「仪表盘」，导航因此是五页（仪表盘 / 行情 / 提醒 / MCP / 关于）。两页说的都是「这台机器上怎么显示」，来回切没意义。合并时注意：
  - `Page` 联合类型、`prefs.ts` 的 `PAGES`、`lib.rs` 的 `PAGES`（含它的单测）是**三处对齐**的，加 / 删页要一起改。旧的 `#settings` 链接会被 `isPage()` 挡下、回落到第一页（`dashboard`），不会白屏 —— 别为了「兼容」把 `settings` 留在白名单里，那样只会切到空白页。
  - 每个 `<section class="page">` 与 `</section>` 必须成对：删旧页时格外的容易把下一段的 `<section ...>` 起始标签一起切掉，症状是那一页的内容**渲染进上一页**（截图里表现为「仪表盘」底部莫名其妙出现「关于」）。改完用 `grep -n '<section class="page"\\|</section>'` 数一遍。
- **开关**（设置里的 `mcp`，默认关）决定桥起不起：Rust 读不到 localStorage，所以桥不在 `setup()` 里起 —— 主面板注册好监听后调 `mcp_set_enabled` 按设置开 / 关，MCP 页拨开关时也调它（命令返回开关后的状态，页面一次往返就刷新）。`bridge.rs` 的 `enable()` 绑端口 + 写连接信息文件，`disable()` 用 `tiny_http` 的 `unblock()` 让服务线程退出、丢掉 `SERVER` 里的最后一份 `Server` 释放端口，再删掉连接信息文件；因此关掉时是「端口根本不存在」，外部客户端拿到的是与「应用没在运行」相同的提示。
- 命令分两段：`prepareCommand()` 先做要联网的部分（搜索 / 报价 / 确认成员还在），返回一个 `apply(latest)` 闭包，由主面板在**当时最新**的 `S` 上执行 —— 命令等网线的这几秒里设置窗口改过的东西（主题、刷新间隔、自选本身）不会被打回旧快照；`runCommand()` 是「准备完立刻执行」的便捷入口，只有测试与简单调用用。
- op 名是 `watchlist.*` / `groups.*` / `instrument.*`（见 `src/mcp.ts` 的 `prepareCommand` switch），MCP 工具名、描述与入参 schema 在 `mcp/lib.mjs` 的 `TOOLS` 里：**新增能力要两边一起加**。参数校验在命令处理里做，不信 schema 的「required」。
- 标的用「secid 或关键词」指代：`resolveTarget()` 先认 secid 正则，否则走搜索；命中多只就报错并把候选列出来，让模型用 secid 再问一次。加入自选前会用一次报价确认代码不是编的（报价接口本身挂了就放行，并在结果里说明「未能校验」）。
- 分组用「名字或 id」指代，找不到就报错并列出可选分组；「未分组」是内置的，不能改名 / 排序 / 删除。删除分组只把成员回落到未分组，自选一只都不少。

**WebDAV 备份（整份设置）**
- 备份的是**整份 `Settings`**（自选、置顶、分组、菜单栏、主题、配色、提醒规则都在里面），恢复后统一走 `loadSettings()` 的迁移与规整（`normalize*`），所以老备份恢复到新版本也能用。提醒的**触发状态**不在设置里（它另存 `stockbar.alerts.state.v1`），因此不进备份 —— 恢复后第一轮 `refresh()` 会重新武装。
- 联网在 Rust 侧（`src-tauri/src/backup.rs`，命令壳在 `lib.rs`）：WebDAV 服务器基本不回 CORS 头，webview 里 fetch 过不了预检，与腾讯板块排行同一条路子。三个入口 `backup_test`（OPTIONS，服务器回 405/501 时退一步用 PROPFIND `Depth: 0`）/ `backup_upload`（PUT）/ `backup_download`（GET），账号走 Basic Auth。
- 远端只有两个固定坑位（命令参数 `slot` 只认这两个，值来自 webview，别让任意字符串拼进 URL）：`settings.json`（常规备份，每次「立即备份」直接覆盖，**不弹确认**）与 `restore-safety.json`（**只在恢复前**写一份本地当前快照，不当恢复源，留给手工取回）。目录不存在时（PUT 回 409）用 **MKCOL 建一次再重试**：用户填的地址就是「想存到哪儿」，让他先去别处手工建目录纯属折腾；建不成（父目录也没有、服务器不认 MKCOL）才报错，并把实际要写的地址一起报出来。`backup_test` 见 404 不算失败 —— 账号与地址是通的，备份时会建出来。
- 密码**只存密文**：`Settings.backup.pass` 是 `v1:` 开头的 AES-256-GCM 密文（命令 `secret_encrypt` / `secret_decrypt`，算法用 ring 的 AEAD —— 本来就在依赖树里），密钥是 app data 目录下的 32 字节随机文件 `secret.key`（Unix 上 0600，`create_new` 建的：文件在但读不了 / 长度不对就报错，**绝不覆盖** —— 覆盖一次等于把所有已存的密文变成解不开的）。明文只活在设置窗口的内存里（`davPassPlain`）；`normalizeBackup()` 载入时把不是 `v1:` 的东西全清掉，**别为了「兼容」让明文进 localStorage**。换机器或删了 `secret.key` 就解不开，界面提示重输，不会静默失败。
- 恢复完要接着做的两件事常被漏掉：① 写进存储后走 `loadSettings()` + `adopt()`（`prefs.ts` 里跨窗口同步用的同一个函数）—— 迁移与规整、收掉拖动、摘掉已删标的的多选、按需重排轮询都在那儿；② 恢复可能改掉 `mcp`，那是「让 Rust 开 / 关本地桥」的指令，得跟着调一次 `mcp_set_enabled`，否则 MCP 页显示开着、端口其实没监听（或反之桥还占着端口）。
- 恢复分两段：先把云端那份读回来、解析成 `BackupFile`、在卡片里摊出摘要（时间 / 自选数 / 分组数 / 提醒数）等确认；确认后才「写安全副本 → 覆盖本地」。`restoreSettings()` 只换自选 / 分组 / 主题 / 提醒这些内容，**备份通道的地址与密码保持本机这份** —— 远端那份密文是别的机器加出来的，搬过来就再也备份不了。安全副本没写成时中止恢复（别做成「不可逆」）。
- 纯逻辑在 `src/backup.ts`（地址校验、`makeBackup` / `parseBackup` 的信封、`restoreSettings`、状态文案 `phaseText`），界面与流程在 `prefs.ts` 的仪表盘页；`makeBackup()` 会把密码密文清成空串（带过去也没用）。备份格式有 `format` 版本号，解析端遇到更高版本直接拒绝，不硬套。

**版本更新（应用内）**
- 检查与安装都在 Rust 侧（`src-tauri/src/update.rs`，命令壳在 `lib.rs`）：`tauri-plugin-updater` 请求 `tauri.conf.json` 里配的端点（GitHub Release 上的 `latest.json`），按公钥校验签名、下载、替换安装包。前端只管文案与进度，纯逻辑在 `src/update.ts`，两个窗口共用。
- 端点与公钥写在 `tauri.conf.json` 的 `plugins.updater`：端点是 `releases/latest/download/latest.json`，所以「最新那份已发布的 Release」就是所有用户拿到的东西。Windows 用 `installMode: passive`（安装时有个小进度窗，不需要交互）。
- 进度走 Tauri 的 `Channel`（不是事件）：`update_install` 的 `on_event` 依次推 `{event:"started",data:{contentLength}}`、`{event:"progress",data:{chunkLength}}`、`{event:"finished"}`。这个形状由 `update.rs` 的单测钉住 —— `DownloadEvent` 上那行 `rename_all_fields` 不能删，删了字段名会变回 snake_case，前端读不到字节数（`rename_all` 只管变体名）。
- 启动检查一次：主面板起来 4 秒后调 `update_check`（设置里的 `updateCheck` 关掉就不查），有新版才在顶栏下面挂提示条；点提示条调 `open_settings({ page: "about" })` 落到「关于」页。
- 设置窗口的「关于」页：当前版本来自 `app_version`（不联网），三个入口是检查更新 / 立即更新 / 打开发布页；装完自动调 `update_restart` 重启（Windows 上安装器会让应用自己退出，走不到这一步）。检查与安装用 `callOrThrow()` 而不是 `call()`：失败原因要显示给用户，不能被静默吞掉。
- 待装的更新存在 `update.rs` 的 `PENDING` 静态量里：检查到的那份 `Update` 带着下载地址与签名，装的时候必须用同一个，所以别把它丢掉；安装失败会放回去，重试不必重新检查。
- 「该打开哪一页」有两套路径：设置窗口已经开着就直接发 `goto-page` 事件；窗口是新建的就先把页名存进 `PENDING_PAGE`，等前端挂好监听调 `settings_ready` 来取（建窗那一刻发事件会早于前端注册监听）。

**提醒与通知（价格 / 涨跌幅规则）**
- 一条提醒 = 一只标的 + 一个条件 + 一个阈值（`Alert`：`kind` 是 `price` / `pct`，`op` 是 `above` / `below`，`value` 一律存正数，方向由 `op` 表达）。规则存在 `Settings.alerts` 里（走 `saveSettings()` 广播，两个窗口同源一份），**触发状态不存在设置里**：那是每轮判定都会动的东西，单独放在 `localStorage["stockbar.alerts.state.v1"]`（与「悬浮行情条位置」同一个理由），由 `src/alerts.ts` 的 `loadAlertStates()` / `saveAlertStates()` 读写。
- 标的范围是「自选 + 大盘指数」（都是标的）。板块**不给提醒**（ADR 0001：板块不是标的）；界面上能选的只有 `INDICES` 与 `watchlist`，`normalizeAlerts()` 在载入时把指向别处的规则一起丢掉。删自选要连带删它的规则（`dropAlertsOf()`，界面、MCP 的 `watchlist.remove` 两处都调），否则会留下「没人可盯」的孤儿规则。
- 判定挂在主面板 `refresh()` 里（拿到这一轮报价之后、`renderAll()` 之前）：应用在跑就一直在判，与面板是否弹出无关。**只在交易时段判** —— `can` 回调按 `sessionStatus(regionOf(secid), now, quote.time)` 逐只判断（港股、美股各按自己的时段与节假日推断），收盘后价格不再动、凭残留的最后一笔成交触发没有意义。
- 语义是**穿越那一刻通知一次**（见 `docs/adr/0002-alerts-fire-on-crossing.md`）：`evaluateAlerts()` 返回这一轮要发的通知与更新后的状态，`fired` 为真的规则持续成立期间不再重复；条件回到不成立才重新武装。另有两条防轰炸：同一规则两次通知至少隔 `ALERT_COOLDOWN_MS`（10 分钟，冷却期内穿越只标记不发），以及按**交易日键**重新武装（键取报价自带的最后成交时间，用 UTC 取日期 —— 港股、美股在本地时区里会跨到第二天）。这轮没拿到某只标的的报价时**跳过它、状态不动**，别把数据断档当成「条件解除了」。
- 送达是系统通知（macOS 走 `src-tauri/src/notify.rs` 的 UNUserNotificationCenter，Windows 走插件的 Toast），前端封装在 `src/notify.ts`。通知标题是「标的名 + 条件」，正文给现价与当日涨跌幅（`alertText()`）。浏览器预览（`pnpm dev`）里全部是空操作，所以 `alerts-wiring.test.ts` 验的是状态存储而不是通知。
- 点通知要把主面板叫出来并定位：主面板起床就挂 `onNotifyTap()`（它监听 Rust 发的 `notify-tapped` 事件，标题在 payload 里），回调里把 `pendingReveal` 记成那只标的、再调 Rust 的 `open_panel`（`lib.rs`，与点托盘图标同一套 `show_panel()` 定位），真正滚动发生在 `panel-shown` 之后 —— 那个事件会先把视图切回自选并刷新，早一步滚就白滚。自选走 `jumpToRow()`（切分组、滚过去、展开分时），大盘指数只滚到顶部卡片。标题映射只在这次运行里有效（`notifyTarget` 是「标题 → secid」，最多留 64 条），重启后点旧通知只是把面板叫出来。
- 设置窗口的「提醒」页（`prefs.ts`，`data-page="alerts"`，排在「行情」之后）只管把规则写进设置：总开关（`alertsOn`）、系统通知那两行（「打开通知设置」+「发一条试试」）、规则表单（标的 / 条件 / 方向 / 阈值）、规则列表（逐条启停、修改与删除）。规则列表按「内容键」重建（`alertListKey`，键里带标的名 —— 报价到了名字才会从代码变成名称，也带 `alertEditId` —— 正在改那一行的高亮要跟着变），别每轮 `render()` 都整段重画。
- **修改已有规则用的是同一份表单，不另开一份**：`alertEditId` 为 null 是「新建」（标题「新建规则」、按钮「添加规则」、没有取消），非 null 就是「修改」（标题「修改规则」、按钮「保存修改」、出现「取消」）。点行尾那支笔（`.alert-edit`，`data-edit`）走 `editAlert()`：把那条的标的 / 条件 / 方向 / 阈值装进表单、滚过去并聚焦阈值框（表单在列表上面）；`submitAlert()` 看到 `alertEditId` 还在就**就地改那一条**（`id`、`enabled`、在列表里的位置都不动 —— 关掉的规则改完还是关着的），否则才 `newAlert()` 追加一条。退出修改有三条路：保存、取消（`cancelAlertEdit()`，一个字段都不写进设置）、那一行被删掉（点删除处与 `renderAlerts()` 各挡一次，后者管另开的窗口把它删了的情况）。改「价格 / 涨跌幅」时阈值不再无条件清空：还在新单位范围内就留着（按 `ALERT_PCT_MAX` / `ALERT_PRICE_MAX` 判断），超出才清。
- 标的选择框是**自己画的**（`.alert-pick` + `#alert-pick-list`），不是原生 `<select>`：原生下拉打不了字，自选攒到几十只时得按名字 / 代码筛。候选只有大盘指数与自选（板块不是标的），名称 / 代码 / secid 都参与匹配；聚焦时把搜索词清空、列出全部 —— 输入框里显示的那只是「当前选中」，不该把自己筛没，所以搜索词单独记在 `alertPickQuery` 里。↑↓ 选、回车落、Esc 收起，点别处也收起。**候选行必须单行**（行上 `white-space: nowrap`、名称 `text-overflow: ellipsis`、右侧标签 `flex: none`），**弹层要用菜单那套不透明底色**（`--menu-bg` / `--menu-line` / `--menu-shadow`，见 ctxmenu.css）：用卡片底色的话它跟下面的「规则」卡片同色、「名称（代码）+ 大盘指数」还会折成两行，看着像卡片内容漏出来了。
- **通知投递走 Rust 的 `notify_send`，不要用插件的 JS `sendNotification`**：它在桌面端的实现就是 `new window.Notification(...)`，而 WKWebView 不实现 Web 通知 —— 发出去毫无反应，`window.Notification.permission` 还恒为 granted（界面会显示「已授权」却一条都收不到），`requestPermission` 同理不可信。
- **macOS 上别退回插件那条路**（实现见 `src-tauri/src/notify.rs`）：tauri-plugin-notification 在 macOS 侧是 notify-rust → mac-notification-sys → `NSUserNotificationCenter`（macOS 11 起废弃）。macOS 26 上它只剩「静默入历史」—— usernoted 日志里 `Delivering ... to [.alert ...]` 有、`Presenting ... as alert` 一次都没有，应用也不出现在「系统设置 › 通知」的列表里（`defaults read com.apple.ncprefs` 里没有 `com.stockbar.eastmoney`），用户一条也看不到，插件却照样报成功。所以 macOS 自己用 `UNUserNotificationCenter`：
  - 投递前读 `getNotificationSettings`：`Denied` 把原因直接回给界面；`NotDetermined` 先 `requestAuthorization`（系统弹窗，用户点了「允许」再发）。因此 `notify_send` 是 async + `spawn_blocking`，别写成同步命令 —— 会卡住主线程。
  - delegate 的 `willPresent` 里明确要横幅 + 列表 + 声音：**应用在最前面时系统默认什么都不弹**，而「发一条试试」恰恰是用户开着设置窗口点的。
  - 点通知靠 `didReceiveNotificationResponse` 把标题丢成 Tauri 事件 `notify-tapped`（前端 `src/notify.ts` 的 `onNotifyTap` 监听）；通知没有编号，所以按**标题**认标的（`notifyTarget` 是「标题 → secid」的映射）。
  - **只在 `.app` 里碰这些 API**：`tauri dev` 跑的是没打包的裸二进制，那种进程没有通知身份，`currentNotificationCenter` 会抛 objc 异常直接崩 —— `notify::init` / `notify::send` 先用 `bundled()`（可执行文件路径里有没有 `.app/Contents/MacOS/`）挡一道，dev 下「发一条试试」只回一句说明。
  - **`.app` 必须带 ad-hoc 签名**（`tauri.conf.json` 的 `bundle.macOS.signingIdentity: "-"`）：`usernotificationsd` 认进程身份看的是**代码签名标识**，不是 Info.plist。不签的话标识是链接器按文件名生成的 `stock_bar-<hash>`，与 `com.stockbar.eastmoney` 对不上，`getNotificationSettings` / `requestAuthorization` 一律被拒（系统日志原话：`[stock_bar-e7076af1f93b727e] Entitlement 'com.apple.private.usernotifications.bundle-identifiers' required to request user notifications` + `requestAuthorization not allowed`）—— 而「系统设置 › 通知」里那条看起来明明允许着，界面上就会莫名其妙说「你还没允许」。ad-hoc 签名后 `codesign -dvv` 的 `Identifier` 才等于 bundle id（`Info.plist entries=15`、`Sealed Resources` 也有了），授权读写才正常。
    - 顺带：**未签名**的 `.app` 连 `open` 都起不来（`launchd` 报 `Launchd job spawn failed`），所以「签名只为通知」这个印象是错的。
    - 前端别在失败原因后面再补一句「去打开通知设置」：Rust 侧给的原因已经带了下一步（`send` 的文案），两边各说一遍就成了「去「打开通知设置」里打开 —— 去「打开通知设置」里允许 StockBar 通知」。`authorize()` 里系统直接拒绝（didGrant 0 + 带 NSError）要把 `localizedDescription` 原样带出去，只有用户自己点了「不允许」（无 error）才算「还没允许」。
  - Windows / Linux 继续用插件的 Toast / DBus，那边一直是好的。

**菜单栏（托盘）**
- 托盘只由主面板 `main.ts` 的 `updateTray()` 负责更新。它用签名 `traySig` 去重，内容没变就不推送。设置窗口只用 `bar.ts` 做本地预览，不调用托盘命令。
- 三种样式：`text` 调 `set_tray_text`（默认图标加文字）；`compact` 用 canvas 按 2x、高 36px 绘制 PNG，再调 `set_tray_image`；`icon` 只显示图标。
- `barColor=false` 时图片按 template 图处理（只用 alpha 通道，系统会自动适配深色和浅色菜单栏）。
- 菜单栏最多显示 `BAR_MAX = 10` 只股票。**macOS 菜单栏不会为它腾地方**：放不下时系统会把标题截断，挤得厉害时干脆把整项藏起来（应用没有 Dock 图标，藏了只能再启动一次、走单实例回调打开设置窗口去减数量），所以别把这个上限当成「一定显示得下」。Windows 的 tooltip 有 128 个 UTF-16 字符上限，`tray_tooltip()` 用 `clip_tooltip()` **按整只**裁剪并在末尾补一行省略号（别按字符硬切，会留下半只的残缺数字）；设置窗口的预览按真实菜单栏的样子截断（`prefs.css` 的 `.mb-item` / `.mb-text`），悬浮条在窄屏上由 `fit_ticker()` 夹到工作区宽度以内。
- 托盘右键菜单（`tray_menu()`）三项：打开设置…（另起线程调 `open_settings_window()`，理由见「建窗口的命令必须是 async」）、桌面悬浮行情条（**只有 Windows 建这一项**，`CheckMenuItem`）、退出 StockBar；左键仍然只弹小窗（`show_menu_on_left_click(false)`）。
- 悬浮行情条那一项改的是用户设置，而设置存在 localStorage 里、Rust 读不到：菜单点击只 `emit_to` 一个 `tray-menu` 事件给主面板，主面板翻转 `S.ticker`（`save()` + `syncTicker()`）后再调 `set_tray_ticker` 把勾选状态推回来（句柄留在 `TRAY_TICKER_ITEM` 里，其他平台一直是 `None`，命令就是空操作）。改这条链路要三处对齐：菜单 id（`lib.rs`）、`main.ts` 的 `listenAll("tray-menu")`、命令 `set_tray_ticker`。

**Windows 适配**
- 前端用 `IS_WIN`（UA 判断）区分平台，`applyAppearance` 会给 `<html>` 加 `.win` 类，平台样式差异都挂在 `.win` 下。
- Windows 托盘不能显示文字、图标是正方形：`updateTray()` 在 Windows 只调 `set_tray_text`（tooltip 显示行情，Rust 侧按整只截断到 127 个 UTF-16 字符以内），行情文字交给**悬浮行情条**。
- 悬浮行情条：主面板 `syncTicker()` 是唯一调用 `set_ticker` 的地方（`ticker` 开启、样式不是 `icon`、`bar` 非空时显示）。行情条自己拉数据和渲染，尺寸用 `fit_ticker` 跟随内容；单击调 `ticker_click` 在其旁边弹出主面板；窗口 `focusable(false)`，点击它不会让主面板失焦。位置存在 `localStorage["stockbar.ticker.pos"]`（不走 `saveSettings`，拖动不广播）。开关有两条入口，改的都是同一份 `S.ticker`：设置窗口「仪表盘」页的开关（只有 Windows 渲染这一行），以及托盘右键菜单里的那一项（见「菜单栏（托盘）」）；菜单里的勾选状态由主面板 `syncTrayTicker()` 推给 Rust（`renderFromSettings()` 与启动时各推一次）。
- 托盘图标：`tray.png` 是黑色剪影，Windows 不支持 template，深色任务栏（注册表 `SystemUsesLightTheme=0`）下由 `default_tray_icon()` 染成白色，系统切换主题时重新着色。
- 主面板在 Windows 关闭系统阴影、窗口放大到 376×576，由 CSS 留 8px 边距自己画圆角阴影；WebView2 的 `backdrop-filter` 透不到桌面，所以 `.win .panel` 用不透明底。设置窗口在 Windows 用原生标题栏（不渲染仿红绿灯和拖动区，标题栏深浅随应用主题 `setTheme`），整体是 Windows 11「设置」风格：`prefs.css` 末尾的 `.win` 区块（导航强调色竖条、每项一张 4px 圆角卡片、带「开/关」文字的开关、方形复选框），预览是桌面 + 任务栏 + 悬浮行情条（内容与真实行情条共用 `bar.ts` 的 `tickerHtml`）。开发时 `pnpm dev` 打开 `settings.html?win` 可在浏览器预览 Windows 布局。

**Rust 侧**
- 前端可以调用的命令：`set_tray_text`、`set_tray_image`、`set_tray_ticker`、`open_settings`（可带 `page` 指定打开哪一页）、`set_ticker`、`fit_ticker`、`ticker_click`、`hide_window`、`open_panel`（点提醒通知后把主面板叫出来）、`quit_app`、`mcp_ready`、`mcp_reply`、`mcp_info`、`mcp_set_enabled`、`qq_board_rank`（腾讯板块排行，见「板块榜单」）、`app_version`、`update_check`、`update_install`、`update_restart`、`open_release_page`、`settings_ready`。新增命令要同时改两处：在 `generate_handler![]` 里注册，前端通过 `call()` 调用（要拿到失败原因就用 `callOrThrow()`）。MCP、更新与板块排行的命令壳写在 `lib.rs`、实现放在 `bridge.rs` / `update.rs` / `qqrank.rs`（原因见「坑」）。
- **建窗口的命令必须是 `async fn`**：Windows 上 WebView2 不会在事件回调里重入，同步命令跑在 IPC 回调里，`WebviewWindowBuilder::build()` 会让 `create_controller` 永远等不到完成回调，整个应用卡死（tauri 文档的 Known issues / wry#583）。`open_settings`（建设置窗口）与 `set_ticker`（建行情条）因此都是 async，真正的建窗逻辑放在同步的 `open_settings_window()` / `set_ticker_window()` 里，由 async 命令（跑在 tokio 线程池上）调用；单实例回调里也是另起线程调 `open_settings_window()`，不在窗口过程里建窗。
- 用 `LAST_HIDDEN_MS` 做防抖（macOS 250ms，Windows/Linux 400ms，见 `TOGGLE_DEBOUNCE_MS`），实现"再点一次图标收起小窗"（点击时窗口会先失焦、自动隐藏）。改托盘点击逻辑时不要破坏这个行为。
- 主面板每次弹出都会收到 `panel-shown` 事件，触发入场动画并立即刷新数据。
- 新建窗口或使用新的插件 API 时，记得在 `capabilities/default.json` 里加上对应的 window label 和 permission。

**板块榜单（主面板的第二块视图）**
- 顶栏下面有一排「自选 / 板块」切换（`#vtabs` 与 `setView()`）：板块视图是**只读榜单**，把某一口径下的全部板块按涨跌幅排开。板块**不是标的**（见 `CONTEXT.md` 与 `docs/adr/0001-boards-are-read-only.md`）：不能加入自选、不参与分组与置顶、不进「菜单栏显示」，MCP 也不暴露。
- **两套数据源**（`fetchBoards(kind, source, subs)`，跟着设置里的「数据源」走，`auto` 时东财不通自动退腾讯 —— 断网 / 被墙的网络下板块功能才不至于整个瞎掉）。两家是**两套东西**，所以板块 secid 自带来源：`90.BK0480` 是东财的、`91.pt01801120` 是腾讯的（`boardSourceOf()`；`tencentCode()` 把 91 原样透传）。哪一家都不许拿对方的名字去硬拼代码 —— 拼错了画出来的是**另一个板块**。
  - 东财 `clist`（`fs=m:90+t:2/3/1`）：行业 496（含二三级细分）、概念 508、地域 31；**每页最多 100 条**，第一页拿总数、其余页并发拉。
  - 腾讯 `proxy.finance.qq.com` 的 `rank/pt/getRank`（`board_type=hy/hy2/gn/dy`）：一级行业 31、二级行业 124、概念 805、地域 31；**每页最多 200 条**，`offset` 翻页，`sort_type` 只认 `price`（排序无所谓，榜单在本地重排）。**这条接口没有 CORS 头，webview 里读不到**（`cb=` / `callback=` 也不给 JSONP），所以应用里由 Rust 侧代取（`qq_board_rank`，见 `src-tauri/src/qqrank.rs`）；只有浏览器预览（`pnpm dev`）还退回直连 fetch，那边会被 CORS 拦掉 —— 预览里看不到腾讯那一份榜单是已知的。
  - 任何一页失败都整体抛出 —— 调用方保留上一份榜单，宁可旧也不要一份缺了一半的排序。
- 控制条（`#bctl`）上三个开关都只在内存里、**不持久化**：口径（`boardKind`）、涨跌榜（`boardOrder`，涨幅降序 ⇄ 跌幅升序）、是否含细分（`boardSubs`）。主面板每次弹出都回到「自选 / 行业 / 涨幅榜」（见 `panel-shown` 那段）。右端的小字（`#bcount`）报出当前榜上有多少个板块 —— 两家的数量差得远（行业 496 vs 31），摆出来才不会被当成 bug；搜索时它报的是匹配数。这条控制条与自选的筛选条**共用同一条吸顶规则**（见「状态与同步」里的那条）。
- 榜单行是「板块名 + 领涨股 + 涨跌幅」。领涨股那一行的前缀按**数字的正负**说：负的说「领跌」（东方财富的字段名一律叫「领涨股」，可跌的板块里它给的那只也在跌，写成「领涨」就是反话）。判断看正负、**不看颜色** —— 设置里可以换成绿涨红跌，颜色说明不了涨跌（`src/boards.ts` 的 `leaderTag`）。
- 两家的细分口径不一样，别混为一谈：东财是**一次拿全再按名字过滤**（二级 / 三级细分带 Ⅱ / Ⅲ 后缀，实测同一细分在 Ⅱ 与 Ⅲ 两个代码下点位、涨跌幅一模一样，所以默认藏起来）；腾讯的二级是**另一段接口**，而且 124 个里只有 36 个名字带 Ⅱ，靠名字滤不干净 —— 所以腾讯那边由「细分」开关**直接决定拉不拉 hy2**（关着只给一级 31 个），开关翻转时 `loadBoards()` 要重拉一次（判断依据是当前榜里有没有 `91.` 的条目）。过滤规则本身在 `src/boards.ts` 的 `isSubBoard` / `filterSubs`。
- **榜单行的 key 只看「有哪些板块」，绝不看名次**：涨跌幅每几秒就在动，把顺序算进 key 会让整块反复重建，而重建会把展开中的分时图（一张画好的 canvas）一起丢掉。名次变化用 `reorderBoards()` 搬 DOM，成员真的变了（换口径 / 开关细分 / 板块增减）才重建，并在重建后补画一次（`renderTrendPanels()`）。
- 点一行展开该板块的分时（`toggleBoardTrend()`）：**不动 `S.selected`** —— 选中项仍然只表示「标的」，不会被板块 secid 污染。分时**跟着这一行自己的来源**走（`boardSourceOf(id) ?? S.source`）：`90.BK…` 找东财的 `trends2`，`91.pt…` 找腾讯的 `day/query`（板块是 3 列、没有累计额，所以成交额与均价线都是 null —— 见 `trendFromTencent` 里放宽的那处）。两类板块都不画均价线（`isBoardSecid()`，与大盘指数同理）。
- 只在板块视图打开时才拉榜单（`refresh()` 里的 `if (view === "board")`）：不打开这个视图的用户，一次请求都不会多发。搜索框两个视图都留着，但**两边是两回事**：自选那边走远程 suggest，板块这边是在 `boards` 那份内存列表上**就地过滤**（`src/boards.ts` 的 `searchBoards`，按名字或代码、不发请求）—— 所以它只搜当前口径，搜不到别的口径里的板块，空结果里会写明这一点（想跨口径搜得把另外两类也拉下来，东财 1035 个 = 11 次请求，先没做）。换视图会把搜索词清掉（两边语义不同）。大盘指数卡片两个视图都留着 —— 看板块也要对着大盘看。
**行情接口（api.ts）**
- secid 格式是 `市场.代码`：`1` 沪、`0` 深（代码以 8/4/92 开头的算北交所）、`116` 港股、`105/106/107` 美股、`100` 海外指数；`90` 是板块（如 `90.BK0480`），它**不是标的**，见「板块榜单」。
- `90` 是东财的板块、`91` 是腾讯的板块（都用各自的原生代码），两者都**不是标的**，见「板块榜单」。腾讯的板块列表**走 Rust 侧**（命令 `qq_board_rank` → `src-tauri/src/qqrank.rs`），不在 webview 里 fetch，所以 `connect-src` 里**不需要**放行 `proxy.finance.qq.com` —— 那条接口不返回 CORS 头（实测只对自家站点回 `Access-Control-Allow-Origin`），也不支持 JSONP，前端 fetch 一定被拦，之前板块榜单落到腾讯就加载失败就是这个原因。
- 东方财富在没有数据时返回 `"-"`，要统一用 `num()` 转成 `null`。界面上所有数值都要处理 `null` 的情况（显示 `--`）。
- 搜索接口不返回 CORS 头，只能走 JSONP；腾讯的板块排行同样没有 CORS 头、又不给 JSONP，所以那条由 Rust 侧取（见「板块榜单」）。其余报价与分时接口用 `fetch`，超时 8 秒。判断一个接口能不能在前端直接 fetch，先看它回不回 `Access-Control-Allow-Origin`（用 `-H "Origin: tauri://localhost"` 试）—— 应用 webview 是照 CORS 规则办的。
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
- `backdrop-filter` 不能嵌在另一个带 `backdrop-filter` 的元素里：子元素拿到的「底」不是父元素**合成后**的样子，而是父元素那层**底色**（半透明的 `--bg` 被当成不透明），叠出来比周围白一截。主面板那块「白」就是这么来的 —— 所以面板的毛玻璃放在独立底层 `.frost`（兄弟层），吸顶条才拿得到真实像素（见「状态与同步」里吸顶那条）。

## 发布流程

发布由 `.github/workflows/build.yml` 承担，不要在本地 `pnpm app:build` 之后手动传安装包。

签名密钥（每个仓库做一次）：`pnpm tauri signer generate -w ~/.tauri/stockbar.key` 会生成 `stockbar.key`（私钥）与 `stockbar.key.pub`（公钥）。公钥内容填进 `tauri.conf.json` 的 `plugins.updater.pubkey`，私钥内容填进仓库 Secret；私钥别进仓库、也别丢 —— 丢了之后已经装过老版本的用户再也收不到更新。

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/stockbar.key
```

1. **定版本**：版本号只有一个来源 —— `src-tauri/Cargo.toml` 的 `[package] version`。`tauri.conf.json` 不写 `version`（留空时 Tauri 回退到 Cargo.toml），`package.json` 也不写；`Cargo.lock` 里 `stock-bar` 那行由 cargo 自己同步，不用手改。安装包文件名、macOS 的 `CFBundleShortVersionString`、MSI 的版本号、「关于」页显示的当前版本、`latest.json` 的 `version` 都取自这一处。改完跑一次 `cargo check`（或任意 cargo 命令）让 `Cargo.lock` 跟上。
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
- macOS 包做的是 **ad-hoc 签名**（`bundle.macOS.signingIdentity: "-"`，构建日志里会有两行 `Signing with identity "-"`），不是 Apple 开发者签名、也没有公证：Gatekeeper 该拦还是拦，首次打开仍需右键「打开」或 `xattr -dr com.apple.quarantine`。但这道 ad-hoc 签名是**必需**的 —— 通知授权要靠它把进程身份认成 `com.stockbar.eastmoney`（见上文「系统通知」那条）。
