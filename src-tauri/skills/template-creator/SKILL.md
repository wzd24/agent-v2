---
name: template-creator
description: 用本地 office MCP 创建或套用可复用办公模板。用户提到模板、套模板、可复用文档/表格/演示时使用。
---

# 模板

模板存在用户 `%APPDATA%\local-codex\templates` 或项目 `.local-codex/templates`，占位符写成 `{{key}}`。

## 工具

- 列表：`office_list_templates`
- 保存：`office_save_template`（`name`、`kind`=`document|spreadsheet|presentation|pdf`、`scope`=`user|project`、`spec`）
- 套用：`office_apply_template`（`name`、输出 `path`、`values`）

`spec` 与对应创建工具参数相同：文档用 `title`/`body`，表格用 `sheets`，演示用 `slides`。套用后把生成文件路径告诉用户。
