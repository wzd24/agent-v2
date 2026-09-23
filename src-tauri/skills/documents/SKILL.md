---
name: documents
description: 用本地 office MCP 创建和编辑 Word 文档（.docx）。用户提到文档、Word、docx、报告、备忘录时使用；不要手写 OOXML 或改用云端文档服务。
---

# 文档

创建、读取或改本地 `.docx` 时，必须调用 `office` MCP，不要自己拼 XML，也不要用 Google Docs / Microsoft Graph。

## 工具

- 创建：`office_create_document`（`path` 相对工作区，`title`，`body` 可用 Markdown 标题和列表）
- 读取：`office_read_document`
- 替换：`office_replace_text`（`replacements: [{ from, to }]`）

先写到工作区，再告诉用户完整路径。需要固定版式时先看 `template-creator` 技能。
