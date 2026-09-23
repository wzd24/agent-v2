---
name: computer-use
description: 用本地 computer MCP 控制本机桌面应用。用户提到操作窗口、点击、输入、截屏、电脑操控时使用；不要改用云端 Computer Use。
---

# 电脑操控

控制本机桌面时只用 `computer` MCP。Windows 走系统 API；macOS 用 osascript；Linux 需要 xdotool 或 wmctrl。

## 常用工具

- `computer_list_windows` / `computer_focus_window`
- `computer_screenshot` / `computer_get_screen_size` / `computer_get_cursor_position`
- `computer_mouse_move` / `computer_click` / `computer_scroll`
- `computer_type` / `computer_key` / `computer_wait`

先确认设置里电脑操控已开启，并只操作已授权应用。截图和输入会受策略开关限制。
