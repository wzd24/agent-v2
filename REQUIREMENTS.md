# 需求

配套桌面壳：Local Codex（`agent-v2`，Tauri 2）。旧仓 `../agent` 只作只读对照，不沿用 Electron 实现。

## 产品约束

- 本地优先，无需 OpenAI 账号。
- 对话、工具、沙箱仍由 `codex-app-server` 完成；本仓库做壳、桥、以及与 v1 对等的桌面 UI。
- UI 与交互必须与 v1 完全一致（下一节「刻意差异」除外）。
- 默认模型 DeepSeek，`wire_api = "responses"`。
- 密钥进操作系统 keyring，不写明文 `config.toml`。
- 配置、项目、线程归属由 Local Codex 自己维护，**不读写**官方 `~/.codex`，也**不继承**环境变量 `CODEX_HOME`。
- 遥测关闭：`analytics.enabled=false`。禁用官方 plugins marketplace / remote_plugin / MCP apps，**本地** Skills、MCP 脚本、插件目录仍要做（与 v1 一致）。

## 刻意差异（相对 v1，不要回退）

- 无边框自定义标题栏（不是系统原生标题栏）。
- 审批默认 `on-request`（`untrusted` 映射为 `on-request`）。
- 语音：Web Speech 失败时 Windows SAPI 回落。
- 应用数据默认 `%APPDATA%\local-codex`（可用 `LOCAL_CODEX_HOME` 覆盖）。引擎运行时在其下的 `engine\`（若已有旧的 `codex-home\` 则继续用它），只作为 `codex.exe` 的私有 `CODEX_HOME`，不是产品数据源。
- 背景图 / 附件大图走资源协议直读，不经主进程压缩 base64。

## 技术栈

| 层 | 选型 |
|---|---|
| 应用壳 | Tauri 2，无边框窗口 + 自定义标题栏，WebView2 |
| 前端 | Vite + React + TypeScript |
| 桥 | Rust stdio JSON-RPC（行分隔） |
| 协议类型 | `codex app-server generate-ts --experimental` |
| 引擎 | 外部 `codex.exe`，不在本仓编译 |

## 功能范围

与 v1 对等，包括：

1. 启动并握手 `initialize`（`experimentalApi: true`，`requestAttestation: false`）。
2. 线程与回合：列表、开始、读取、流式 delta、中断、归档、审批。
3. 工作区：选目录、树、搜索、读写、外部打开。
4. 设置：Provider、模型、API Key、沙箱、审批、外观、快捷键、集成。
5. **桌面集成（曾被误标为「第一期非目标」，现均为目标）**：PTY 终端、本地 MCP、Playwright 浏览器、电脑操控、GitLab/GitHub 托管、Skills、托盘、自动化、Office/PDF/Notebook 预览、内置浏览器。

剩余缺口与验收清单见 `TASKS.md`。

## 数据目录

产品源文件在 `%APPDATA%\local-codex\`（或 `LOCAL_CODEX_HOME`）：

| 文件 / 目录 | 用途 |
|---|---|
| `projects.json` | 项目登记（id、名称、路径、多 root） |
| `threads.json` | 线程归属项目 / 无项目线程 |
| `preferences.json` | UI 偏好（外观、快捷键、语音等） |
| `ui-state.json` | 上次工作区 |
| `automations.json` | 自动化任务 |
| `hooks.json` | 用户级 hooks |
| `plugins\` | 已安装本地插件 |
| `secrets.json` | 密钥加密回退 |
| `engine.log` | 引擎日志 |
| `engine\` 或旧 `codex-home\` | **仅**给 `codex.exe`：生成的 `config.toml`、会话/rollout。启动引擎时才设置子进程的 `CODEX_HOME` |

仓库内项目 hooks 写到 `.local-codex/hooks.json`（若只有旧的 `.codex/hooks.json` 会复制一次，之后不再与 Codex CLI 共用）。

无项目线程的默认工作区是「文档\Local Codex」，不是「文档\Codex」。

## 真正的非目标

- OpenAI / ChatGPT 登录、官方 marketplace、远程插件商店。
- 修改或提交旧仓 `../agent`。
- 把密钥写回明文 `config.toml`。
- 把背景图改回主进程压缩传输。
- 真正的多窗口（v1 的「新建窗口」也只是唤起已有窗口）。
- 与官方 Codex CLI 共用 `~/.codex` 配置或项目列表。
