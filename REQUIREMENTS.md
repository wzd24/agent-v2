# 需求（第一期）

配套桌面壳：Local Codex。本文只约束 `agent-v2` 的 Tauri 2 切片，不沿用旧仓 Electron 决策。

## 产品约束

- 本地优先，无需 OpenAI 账号。
- 对话、工具、沙箱仍由 `codex-app-server` 完成；本仓库只做壳、桥、最小 UI。
- 默认模型 DeepSeek，`wire_api = "responses"`。
- 密钥进操作系统 keyring，不写明文 `config.toml`。
- 遥测关闭：`analytics.enabled=false`，并禁用 plugins / remote_plugin / apps / MCP apps。

## 技术栈

| 层 | 选型 |
|---|---|
| 应用壳 | Tauri 2，系统原生标题栏，WebView2 |
| 前端 | Vite + React + TypeScript |
| 桥 | Rust stdio JSON-RPC（行分隔） |
| 协议类型 | `codex app-server generate-ts --experimental` |
| 引擎 | 外部 `codex.exe`，不在本仓编译 |

## 第一期功能

1. 启动并握手 `initialize`（`experimentalApi: true`，`requestAttestation: false`）。
2. 线程：`thread/list`、`thread/start`（带 cwd）、`thread/read`。
3. 回合：`turn/start` 流式 `item/agentMessage/delta`，`turn/completed`，`turn/interrupt`。
4. 审批：命令执行、文件变更、权限请求；未识别的 server request 由桥拒绝。
5. 工作区：选目录、浅层树、只读文本。
6. 设置：base URL、模型名、API Key、重启引擎。

## 非目标

PTY、MCP、Playwright、电脑操控、Git 托管、Skills、托盘、自动化、Office、嵌入浏览器。
