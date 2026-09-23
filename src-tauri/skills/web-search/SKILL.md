---
name: web-search
description: 用本地 web-search MCP 搜索公开网页并读取页面文本。用户提到搜索、查资料、打开链接摘要时使用；不要改用 OpenAI / ChatGPT 联网或浏览器云端。
---

# 网页搜索

查公开网页时只用 `web-search` MCP，不要自己猜搜索结果，也不要接 OpenAI 的 web_search。

## 工具

- 搜索：`web_search`（`query`，可选 `limit`）
- 读取：`web_fetch`（`url`，只接受 http/https，返回截断后的可见文本）

先搜索再按需读取 1–3 个链接。把来源 URL 一并告诉用户。
