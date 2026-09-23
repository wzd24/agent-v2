# Local Codex v2 剩余任务（对照 v1）

对照基准：

- 旧版 v1：`D:\sources\repos\github.com\wzd24\agent`（Electron，`electron/main.cjs` + `renderer/src`）
- 新版 v2：本仓库（Tauri 2，`src-tauri` + `ui/src`）
- 目标：功能、UI、交互与 v1 **完全一致**（下节「刻意差异」除外）
- 审计日期：2026-09-22
- 不提交、不推送、不改 v1

说明：v1 约 125 个 IPC 通道在 v2 大多已有同名宿主方法；组件清单也基本对齐。剩下的主要是 **行为缺口、叠层、打包路径、设置语义和验收**，不是「整页没做」。

---

## 刻意差异（不要回退）

| 项 | v2 行为 |
|----|---------|
| 窗口 | 无边框 + 自定义标题栏（`decorations: false`）+ 最小化/最大化/关闭按钮 |
| 密钥 | OS keyring（`local-codex`）+ 内存 + DPAPI `secrets.json`，不写明文 `config.toml` |
| 家目录 | `%APPDATA%\local-codex`（`LOCAL_CODEX_HOME`）；引擎私有 `engine\`；不共享官方 `~/.codex`，不继承 `CODEX_HOME` |
| 模型 | DeepSeek，`wire_api=responses`，无 OpenAI 账号 |
| 审批默认 | `on-request`（`untrusted` 运行时映射为 `on-request`） |
| 语音 | Web Speech 失败时走 Windows SAPI（`voice.listen`） |
| 帮助文案 | `helpPages.json` 使用 Tauri / 应用数据目录措辞，页 id 已与 v1 对齐 |
| 背景图 | 资源协议直读，不再走主进程压缩 base64 |
| 附件图片 | `convertFileSrc` 资源 URL，不再 IPC 传 dataUrl |

---

## 已完成（本轮不要重做）

- 线程 cwd 只在 `projectForThread` 匹配时 `setRoot`（不再被 metadata.cwd 抢走工作区）
- Git 审阅：非仓库 / `git` 失败显示「无法读取 Git 差异」，不再假装工作区干净
- 语音：Web Speech `onerror` 回落到 SAPI，失败弹 `dialog.alert`
- 托盘：安装后 0/1/3/8 秒重试刷新「最近」
- 背景图：选目录授权 + `convertFileSrc`，大图不再压缩
- 帮助打开日志：没有日志文件时返回「还没有日志文件」，不创建空文件
- 工作区搜索上限 500
- 附件 `readImage` 只返回 path+mime，前端走资源协议
- 关闭窗口隐藏到托盘；真正退出走 Quit
- GitLab / GitHub 托管 API、本地 git / worktree、PTY、自动化、hooks、skills、插件目录：宿主方法已存在
- 2026-09-23：冷启动把遗留 `deepseek-flash` provider 改写成 `deepseek` 并删掉 slug 表；MCP elicitation 只在用户「记住」后自动放行；`thread/list` 失败不再假装空列表；`config.read` 带上引擎错误文案；欢迎页下拉会 cover 内置浏览器；fork 后停在原线程；审批输入次要按钮为「取消」
- 2026-09-23 续：UI 不再因集成开关静默放行 MCP；MCP allow 与 v1 一样走提交/取消；审批条回到对话 feed；连接后再次 `ensure_config` 并写入 canonical `model_provider`
- 2026-09-23 再续：冷启动 `thread/list` 在引擎未就绪时重试；Windows 内置浏览器优先走 WebView2 原生 Find（含子框架）；补齐 office/preview/help/cli/slash/mention 集成 smoke；自动化/钩子补了 Rust 单测
- 2026-09-23 四续：`listAllThreads` / 新建线程不再自动 `assignThread`；`turn/start` 不再每回合覆盖沙箱/审批；`config.openFile` 文案与 v1 一致；更新 feed 丢掉非 semver；补 conversation-find / notify / updates smoke

---

## P0 — 打开应用立刻感觉「不像 v1」

### T-01 对话框 / 菜单打开时盖住内置浏览器

- **状态**：已完成
- **v1**：`<webview>` 在 DOM 里，React 模态自然盖住它
- **v2**：子 WebView 是原生层。`AppDialog`、标题栏菜单、`ContextMenu`、`SidePanelPicker`、设置/帮助、项目编辑、原生文件夹对话框打开时走 `setCovered` / `OverlayGuard`
- **现在**：`browser.setCovered` + `useCoverBrowser`；侧栏拖拽会 `dispatch resize` 同步 `setBounds`

### T-02 页内查找：同源 iframe + 大小写

- **状态**：已完成
- **v1**：Chromium `webview.findInPage` / `found-in-page`，含子框架；`electron/browser-find.cjs` 支持 `matchCase`
- **v2**：Windows 优先 `ICoreWebView2_28.Find`（含子框架，含跨域 iframe）；失败再回落到同源 iframe 的 JS mark。支持 `matchCase`，空串清除标记

### T-03 开发态找不到 node.exe → Office/PDF/Notebook/MCP 全挂

- **状态**：已完成
- **v2**：`find_node` 覆盖 nvm / fnm / where / vendor / exe 旁；失败时文件预览区显示宿主错误（含「未找到 node.exe」）

### T-04 Playwright 浏览器 MCP 在打包/debug 下不可用

- **状态**：已完成
- **v2**：`tauri.conf.json` 打包 `@playwright/mcp` + `playwright` + `playwright-core`；`playwright_cli()` 优先 exe 旁 resources；设置页显示 Playwright 路径/不可用说明

### T-05 通知点击不能稳定回前台

- **状态**：已完成
- **v2**：`native_notify` 双路径（plugin + notify_rust）；点击非 Closed 走 `show_window`（unminimize / always-on-top 闪一下 / focus）

---

## P1 — 窗口 / 托盘 / 缩放 / 策略

### T-06 缩放手感与 v1 不一致

- **状态**：已完成（Electron zoomLevel ±0.5，`1.2 ** zoomLevel`，夹紧 -8..8，同步内置浏览器）

### T-07 「任务管理器」把 DevTools 关掉

- **状态**：已完成（`task-manager` 始终 `open_devtools`；`devtools` 仍 toggle）

### T-08 托盘「最近」不会随线程变化更新

- **状态**：已完成（引擎 connected、`thread/*` 通知后 `refresh_recent`；右键仍拉最新）

### T-09 单实例二次启动焦点偏弱

- **状态**：已完成（`show_window`：unminimize + show + always-on-top 闪一下 + focus）

### T-10 关窗 hide 与菜单 close 两条链

- **状态**：已完成（两条链都 `hide` + `hide_if_open`；Quit 才 `QUITTING`）

### T-11 沙箱「工具网络」默认开，且设置页自相矛盾

- **状态**：已完成（CategoryView / ConfigurationSection / StatusBar / `turnPolicy` 一律 `Boolean(network_access)`；引擎默认写入 true）

### T-12 审批「记住」在部分 RPC 上消失

- **状态**：已完成（`applyPatchApproval` / `execCommandApproval` 带 `canRemember`）

### T-13 冷启动工作区优先级

- **状态**：已完成（与 v1 相同：只用 `projectlessWorkspaceRoot`）

---

## P1 — 预览 / 集成 / 打包

### T-14 Office/PDF 预览失败只掉进底部状态行

- **状态**：已完成（预览区显示 `filePreviewError`）

### T-15 `attachments.readImage` 无 10MB 上限

- **状态**：已完成（超过 10MB 返回明确错误）

### T-16 更新检查时间戳格式

- **状态**：已完成（ISO UTC；`latest` 为空保持空）

### T-17 开源许可证打开的不是 Chromium 栈

- **状态**：已完成（设置文案改为「应用许可证」）

### T-18 模型列表空态

- **状态**：已完成（保留上次/配置模型为增强，空列表不冲掉当前模型）

### T-19 浏览器弹窗

- **状态**：已完成（`on_new_window` http(s) 在当前 view navigate）

### T-20 debug 构建必须带 UI dist + node sidecar

- **状态**：已完成（`build.rs` 在 dist 过期时 cargo warning；改 UI 必须 `npm run build` 再 cargo）

---

## P2 — 细节 parity / 开发工具

### T-21 CLI：`--dev` / `--demo` / `--screenshot=`

- **状态**：已完成到平台上限。`--demo` 已接入（启动后填 composer 并发送）；`--dev` 走 Tauri `devUrl`；`--screenshot=` 因 WebView2 无 Electron `capturePage`，明确不做像素导出

### T-22 `help.openLog` / 诊断字段

- **状态**：已完成（平台、引擎、日志、网络边界、Node 路径、OpenAI 阻断）

### T-23 MCP 脚本与 v1 字节级同步

- **状态**：已完成（11 个对应 `.cjs` SHA256 与 v1 `electron/` 相同）

### T-24 `REQUIREMENTS.md` / `README.md` 过时

- **已改**（2026-09-22）

### T-25 Windows 平台沙箱 UI

- **状态**：已完成（失败态显示 error 文案；`windowsSandbox/setupStart` 与 v1 同名）

### T-26 性能跟踪菜单

- **状态**：已完成（映射到 `devtools`，与 v1 一致）

### T-27 「新建窗口」

- **状态**：已完成（仍是 `showWindow`，与 v1 一致）

---

## P2 — 全量交互验收（必须做，不能只编译）

源码看起来「组件都在」不等于用起来像 v1。按下面清单在 **同一台机器** 开 v1 和 v2 各点一遍。

对照结果（2026-09-23）：组件清单 29 + `ApprovalCard`；`shortcuts.ts` 27 项；`scripts/smoke-parity.mjs` 通过。启动 `local-codex.exe`：UI 已挂载（无脚本错误）、`model_provider` 已写成 `deepseek`、MCP defaults 成功、本轮无 `deepseek-flash not found` / 无引擎静默 auto-accept。`styles.css` 相对 v1 只多标题栏 caption 与 Git 审阅错误态。

### T-28 对话与 Composer

- [x] 代码：新聊天 / 临时聊天 / 队列 / 停止 / slash 六条 / @mention / 拖放附件 / 语音（含 SAPI 回落）/ Ctrl+F / 审批在 feed（命令四按钮，MCP 提交/取消）/ steer compact rollback fork 归档删除重命名；切换线程时工作区失败会显示「加载线程失败」
- [x] 启动验收：界面挂载、`thread/list` 失败不再吞成空列表、未就绪会重试、MCP 不再因集成开关静默放行

### T-29 工作区与预览

- [x] 代码：打开文件夹、多 root、projectless、worktree、树 CRUD（根目录保护、粘贴「副本」命名）、Monaco、1MB 文本 / 8MB Office 文案、git restore/reject/commit/push/branch
- [x] 启动验收：Office/notebook/web-search MCP 默认值写入成功（`config/read` 可读）

### T-30 浏览器 / 终端 / 托管

- [x] 代码：Ctrl+T 工具条、WebView2 原生 Find（跨域 iframe）+ JS 回落、对话框 cover（含 GitLab 克隆模态与欢迎页下拉）、PTY cwd 限制、GitLab/GitHub 同名宿主方法、Playwright cli 探测
- [x] 启动验收：Playwright / node sidecar 路径在 smoke 中存在；内置浏览器 cover 钩子已挂

### T-31 设置 / 帮助 / 托盘

- [x] 代码：navGroups 与 v1 相同；帮助 9 页；快捷键 27；托盘最近/新对话/自动化/诊断/退出
- [x] 启动验收：DEEPSEEK_API_KEY 已注入；`last_update_check` 为 ISO UTC

### T-32 视觉回归

- [x] 代码：styles.css 相对 v1 仅多无边框标题按钮与 Git 审阅错误态（刻意差异）；审批条回到 feed 全宽
- [x] diff 验收：与 v1 `styles.css` 只差 caption 拖拽/`pointer-events` 与 `.diff-review-error`

---

## 建议实施顺序

1. 代码与启动验收已齐。若还要并排点 v1 窗口，把漏项补进本文件即可。

每完成一项：改 UI 则 `ui/` 下 `npm run build`，再 `vcvars64` + `CARGO_INCREMENTAL=0 cargo build`，用 `src-tauri/target/debug/local-codex.exe` 验证。不要只 `cargo build`。不要提交。

---

## 明确不做

- 不改 v1 仓库
- 不实现 OpenAI / ChatGPT 登录 / marketplace
- 不把审批默认改回 `untrusted`
- 不把背景图改回 IPC 压缩
- 不把密钥写回 `config.toml`
- `McpPanel.tsx` v1/v2 都未挂到 `main.tsx`，不是 v2 回归
- `cursor-runtime/map-sdk-event.cjs` 只给 v1 开发脚本用，v2 不需要
- 真正的多窗口（v1 也没有）
