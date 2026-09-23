---
name: notebooks
description: 创建和编辑本地 Jupyter Notebook（.ipynb）。用户提到 notebook、ipynb、单元格、数据集分析草稿时使用；不要手写 Notebook JSON，也不要改用云端 Colab。
---

# Notebooks

处理本地 `.ipynb` 时，必须调用 `notebook` MCP，不要自己拼 nbformat JSON。

## 工具

- 创建：`notebook_create`（`path` 相对工作区，`title`，`cells: [{ cell_type, source }]`）
- 读取：`notebook_read`
- 追加/插入：`notebook_add_cell`（`cell_type` 为 `markdown` 或 `code`）
- 更新：`notebook_update_cell`（按 `index`）

先写到工作区，再告诉用户完整路径。需要表格数据时配合 `spreadsheets` 技能。
