---
name: presentations
description: 用本地 office MCP 创建和编辑演示文稿（.pptx）。用户提到幻灯片、PPT、pptx、演示时使用；不要手写 PPTX XML 或改用云端 Slides。
---

# 演示文稿

生成或修改本地 `.pptx` 时调用 `office` MCP。

## 工具

- 创建：`office_create_presentation`（`slides: [{ title, bullets: string[] }]`）
- 读取：`office_read_presentation`
- 替换：`office_replace_text`

一页一个主题，标题短、要点少。需要统一封面或议程时先用 `template-creator`。
