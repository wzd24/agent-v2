# 使用说明

Scorpio Agent 桌面壳。目标是与旧版 v1 功能、UI、交互一致；尚未对齐的项见 `TASKS.md`。

## 启动前

1. 安装 WebView2（Windows 11 一般已自带）。
2. 安装 Codex CLI，或把 `codex.exe` 放到 `vendor/app-server/`（`npm run stage-app-server`）。
3. 运行 `npm run tauri -- dev`（需 MSVC 构建环境）。

## 第一次使用

1. 打开 **设置**，填写 DeepSeek Base URL（默认 `https://api.deepseek.com/`）、模型名和 API Key。
2. 保存后引擎会重启。密钥进入 Windows 凭据管理器（并有加密本地备份），界面不会再回显。若顶栏仍显示「未配置密钥」，把 Key 再保存一次。
3. 回到会话，点工作区 **选择**，选一个本地文件夹。
4. **新建** 线程，输入一句话，Enter 发送（Shift+Enter 换行）。
5. 若 Agent 要跑命令或改文件，顶栏下方会出现审批条：允许或拒绝。

## 行为说明

- 数据在 `%APPDATA%\local-codex`（漫游目录），日志是该目录下的 `engine.log`。不是官方 `~/.codex`，也不是安装目录 `%LOCALAPPDATA%\Scorpio Agent`（旧安装可能仍在 `%LOCALAPPDATA%\Local Codex`，里面的 `app-server\codex.exe` 是随包引擎）。项目在 `projects.json`。
- 找不到 `codex.exe` 时，打包版只报错；开发态可用 `--mock` / `LOCAL_CODEX_MOCK`。
- 工作区可浏览、编辑、预览；Agent 改文件仍须你批准。
- 中断按钮调用 `turn/interrupt`，只在当前回合进行中有效。

## 环境变量

| 变量 | 作用 |
|---|---|
| `CODEX_APP_SERVER_CMD` | 引擎可执行文件 |
| `LOCAL_CODEX_HOME` | 覆盖应用数据目录 |
| `CODEX_HOME` | 不用于本应用；仅引擎子进程会被设成私有引擎目录 |
| `DEEPSEEK_API_KEY` | 若 keyring 为空，引擎进程仍可读这个环境变量 |
