---
name: pdf
description: 用本地 office MCP 读取、创建和校验 PDF。用户提到 PDF、导出为 PDF、核对 PDF 结构时使用；不要改用云端渲染或 OpenAI 文件接口。
---

# PDF

处理 PDF 时只用 `office` MCP。

## 工具

- 创建：`office_create_pdf`（`path`、`title`、`body` 或 `paragraphs`）
- 读取：`office_read_pdf`（页数和可提取文本）
- 校验：`office_verify_pdf`（检查文件头、`%%EOF`、页面对象）
- 替换：`office_replace_text`（按提取文本重建）

扫描件或复杂版式可能提取不到文字；创建后应用 `office_verify_pdf` 再交给用户。
