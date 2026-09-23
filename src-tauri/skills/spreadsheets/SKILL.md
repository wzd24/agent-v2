---
name: spreadsheets
description: 用本地 office MCP 创建和编辑电子表格（.xlsx / .csv）。用户提到表格、Excel、xlsx、csv、数据表时使用；不要手写 xlsx ZIP，也不要用云端 Sheets。
---

# 表格

读写本地表格只用 `office` MCP。

## 工具

- 创建：`office_create_spreadsheet`（`sheets: [{ name, rows: string[][] }]`，第一行通常是表头）
- 读取：`office_read_spreadsheet`（支持 `.xlsx` 和 `.csv`）
- 替换：`office_replace_text`

数字和日期先当文本写入；复杂公式可先落成值，再在说明里写出公式意图。
