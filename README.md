# Local Codex（agent-v2）

Tauri 2 + Rust 桥 + Vite/React 的绿场桌面壳。引擎仍是本机 `codex.exe app-server --stdio`，不经过 OpenAI 账号。

旧仓 `../agent` 只作只读参考，本仓库不复制 Electron/React 实现。

## 第一期范围

窗口、线程、流式回合、工作区浅层树、命令/文件/权限审批、最小设置。不做 PTY、MCP、Playwright、托盘、Git 托管页。

## 准备

- Node 20+
- Rust stable（Windows 为 `x86_64-pc-windows-msvc`）
- WebView2
- 本机 Codex CLI（`%LOCALAPPDATA%\OpenAI\Codex\bin\<版本>\codex.exe`）或 `CODEX_APP_SERVER_CMD`

```powershell
npm install
npm --prefix ui install
npm run stage-app-server
```

协议 TypeScript 已生成在 `ui/src/generated/app-server`。引擎升级后重新生成：

```powershell
npm run generate-protocol
```

## 开发

在已加载 MSVC 环境的终端里：

```powershell
npm start
```

这会同时拉起 Vite 和窗口。默认 debug 构建带 `custom-protocol`，会加载 `ui/dist`；请先 `npm run build`。

若要离线打开当前 UI：

```powershell
npm run build
cd src-tauri
cargo build
.\target\debug\local-codex.exe
```

找不到二进制时只提示，不提供 mock 引擎。

## 测试

```powershell
cd src-tauri
cargo test
node ../scripts/smoke-initialize.mjs
```

`cargo test` 用假进程覆盖 JSON-RPC。`smoke-initialize.mjs` 对本机 `codex.exe` 做 `initialize` + `thread/list`。完整流式回合需要在设置里填入 API Key 后 `npm run tauri -- dev`。

## 打包（Windows debug）

```powershell
npm run tauri -- build --debug
```

产物：

- 可执行文件：`src-tauri/target/debug/local-codex.exe`
- 引擎资源：`src-tauri/target/debug/app-server/codex.exe`
- NSIS：`src-tauri/target/debug/bundle/nsis/Local Codex_0.1.0_x64-setup.exe`

`codex.exe` 体积很大，不要提交到 git。

## 数据目录

默认 `CODEX_HOME` 为 `%APPDATA%\local-codex\codex-home`，不绑定官方 `~/.codex`。可用环境变量覆盖。API Key 走系统凭据管理器。
