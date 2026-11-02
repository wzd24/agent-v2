'use strict';

const imageGen = require('./image-gen.cjs');

function reply(id, result, error) {
  process.stdout.write(`${JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result })}\n`);
}

function textResult(value, extra = {}) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...extra };
}

function imageContent(value) {
  const summary = imageGen.publicImage(value);
  const saved = summary.savedTo ? `已保存到 ${summary.savedTo}` : '未写入工作区文件';
  const text = `已用 ${summary.provider}/${summary.model} 生成图片（${summary.output}）。${saved}。这张图已经可以展示给用户，不要再去搜索或读取它，除非用户要求继续修改。`;
  const content = [{ type: 'text', text }];
  if (value.data && value.data.length > 0 && value.data.length <= 6 * 1024 * 1024) {
    content.push({ type: 'image', data: Buffer.from(value.data).toString('base64'), mimeType: value.mediaType });
  }
  return { content, structuredContent: { ...summary, prompt: value.prompt } };
}

const providerEnum = imageGen.PROVIDERS;
const tools = [
  {
    name: 'generate_image',
    description: '用已配置的图片服务生成一张新图。用户要求画图、出图、文生图时使用。不要使用模型自带的 image_generation。需要完整画面描述：主体、构图、风格、光线，以及必须出现的文字。只有用户点名时才传 provider 或 model。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '完整的画面描述。' },
        provider: { type: 'string', enum: providerEnum, description: '仅当用户指定服务时填写。' },
        model: { type: 'string', description: '仅当用户指定模型时填写。' },
        aspect_ratio: { type: 'string', enum: imageGen.ASPECT_RATIOS, description: 'Gemini / Grok 的宽高比。' },
        image_size: { type: 'string', enum: imageGen.IMAGE_SIZES, description: 'Gemini 用 1K/2K/4K，Grok 用 1K/2K。' },
        size: { type: 'string', description: 'OpenAI、Seedream、通义的尺寸，例如 1024x1024。' },
        quality: { type: 'string', description: 'OpenAI 质量，例如 low、medium、high。' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'generate_images',
    description: '按顺序为一组 prompt 各生成一张图，适合批量或一组变体。单张图用 generate_image。失败的条目记在 failures 里，不会中断其余条目。',
    inputSchema: {
      type: 'object',
      properties: {
        prompts: { type: 'array', items: { type: 'string' }, description: '1 到 10 条完整 prompt。' },
        provider: { type: 'string', enum: providerEnum },
        model: { type: 'string' },
        aspect_ratio: { type: 'string', enum: imageGen.ASPECT_RATIOS },
        image_size: { type: 'string', enum: imageGen.IMAGE_SIZES },
        size: { type: 'string' },
        quality: { type: 'string' },
      },
      required: ['prompts'],
      additionalProperties: false,
    },
  },
  {
    name: 'edit_image',
    description: '按参考图修改、拼接或换风格。必须用 source_path 或 source_paths 指向已有图片文件（用户附件或工作区文件）。不要发明 attachment id，也不要先用 shell 找图。希望保留人物或物体身份时，写明保持同一主体，只改场景、服装、姿势、光线或风格。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '要做的修改，并说明哪些部分保持不变。' },
        source_path: { type: 'string', description: '一张参考图的绝对路径或相对工作区的路径。' },
        source_paths: { type: 'array', items: { type: 'string' }, description: '多张参考图，顺序即图 1、图 2。' },
        provider: { type: 'string', enum: providerEnum },
        model: { type: 'string' },
        aspect_ratio: { type: 'string', enum: imageGen.ASPECT_RATIOS },
        image_size: { type: 'string', enum: imageGen.IMAGE_SIZES },
        size: { type: 'string' },
        quality: { type: 'string' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_inspiration',
    description: '在内置灵感库里检索可复用的绘画 prompt：手绘风格图鉴和 awesome-gpt-image-2。用户要特定画风、版式、主题色、风格编号，或索要示例 prompt 时，先检索再调用 generate_image。手绘风格 prompt 里的「主题」应换成用户的题目。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '匹配标题、prompt、分类和标签的关键词。' },
        category: { type: 'string', description: '精确分类名。' },
        source: { type: 'string', enum: ['handraw-style', 'awesome-gpt-image-2'] },
        limit: { type: 'integer', description: '返回条数，1-20，默认 8。' },
      },
      additionalProperties: false,
    },
  },
];

async function callTool(name, args = {}) {
  if (name === 'generate_image') return imageContent(await imageGen.generateImage(args));
  if (name === 'edit_image') return imageContent(await imageGen.editImage(args));
  if (name === 'generate_images') {
    const value = await imageGen.generateImages(args);
    const lines = [`生成了 ${value.images.length}/${value.images.length + value.failures.length} 张图片。`];
    for (const image of value.images) lines.push(`${image.prompt}\n${image.savedTo || '未保存'}`);
    for (const failure of value.failures) lines.push(`失败：${failure.prompt.slice(0, 80)} — ${failure.error}`);
    return { content: [{ type: 'text', text: lines.join('\n\n') }], structuredContent: value };
  }
  if (name === 'find_inspiration') return textResult(imageGen.searchInspiration(args));
  throw new Error(`未知工具：${name}`);
}

async function runTest() {
  try {
    const result = await imageGen.testConnection();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exit(0);
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: error.message || String(error) })}\n`);
    process.exit(1);
  }
}

if (process.argv.includes('--test')) {
  void runTest();
} else {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id == null) continue;
      if (message.method === 'initialize') {
        reply(message.id, { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'local-codex-image-gen', version: '0.10.1' } });
      } else if (message.method === 'tools/list') reply(message.id, { tools });
      else if (message.method === 'resources/list') reply(message.id, { resources: [] });
      else if (message.method === 'resources/templates/list') reply(message.id, { resourceTemplates: [] });
      else if (message.method === 'ping') reply(message.id, {});
      else if (message.method === 'tools/call') {
        callTool(String(message.params?.name || ''), message.params?.arguments || {})
          .then((result) => reply(message.id, result))
          .catch((error) => reply(message.id, textResult(error.message || String(error), { isError: true })));
      } else reply(message.id, null, { code: -32601, message: `Method not found: ${message.method}` });
    }
  });
}
