---
name: image-gen
description: 用本地 image-gen MCP 生成、修改和检索图片。用户要求画图、生图、修图、换风格、批量出图或找绘画提示词时使用。不要改用模型自带的 image_generation，也不要自己拼图像 API。
---

# 图片生成

查图、画图、改图只用 `image-gen` MCP。这是由 [dsh-image-gen](https://github.com/shanliuling/dsh-image-gen) 改造的本地插件，支持 Gemini、OpenAI、OpenAI 兼容接口、Seedream、通义万相、Grok、智谱 GLM 和本地 ComfyUI。

不要调用模型供应商自带的图片生成工具。没有配好 API Key 时，告诉用户去「设置 → 图片生成」填写，不要改用别的生图通道。

## 工具

- `generate_image`：文生图。`prompt` 要写全主体、构图、风格、光线，以及画面上必须出现的文字。
- `edit_image`：按参考图修改。用 `source_path` 或 `source_paths` 指向用户附件或工作区里的图片文件。
- `generate_images`：一组 prompt 各出一张，最多 10 条。
- `find_inspiration`：用户要特定画风、版式、配色或示例提示词时，先检索再生成。手绘风格里的「主题」换成用户的题目。

只有用户点名服务或模型时才传 `provider` / `model`。生成成功后直接把保存路径告诉用户，不要再搜索或打开这张图，除非对方要求继续改。
