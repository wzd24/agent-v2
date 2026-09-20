# 使用说明（第一期）

这是可演示的最小壳，不是完整 Codex 桌面端。

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

- 数据在 `%APPDATA%\local-codex\codex-home`，不是官方 `~/.codex`。
- 找不到 `codex.exe` 时只会报错，没有内置假引擎。
- 工作区树只读；真正改文件仍由引擎在你批准后完成。
- 中断按钮调用 `turn/interrupt`，只在当前回合进行中有效。

## 环境变量

| 变量 | 作用 |
|---|---|
| `CODEX_APP_SERVER_CMD` | 引擎可执行文件 |
| `CODEX_HOME` | 覆盖默认数据目录 |
| `DEEPSEEK_API_KEY` | 若 keyring 为空，引擎进程仍可读这个环境变量 |
