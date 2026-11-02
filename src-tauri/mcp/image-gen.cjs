'use strict';

/**
 * Image generation core adapted from https://github.com/shanliuling/dsh-image-gen
 * (Apache-2.0). Scorpio Agent exposes it as a local MCP server instead of a
 * DeepSeek Harness bundle. Subscription login and the tldraw canvas stay out:
 * this host uses API keys, ComfyUI, and workspace file paths.
 */

const fs = require('node:fs');
const path = require('node:path');

const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const ERROR_LIMIT = 4096;
const PROVIDERS = ['google', 'openai', 'openai-compat', 'seedream', 'dashscope', 'xai', 'zhipu', 'comfyui'];
const ASPECT_RATIOS = ['1:1', '3:2', '2:3', '4:3', '3:4', '4:5', '5:4', '16:9', '9:16', '21:9'];
const IMAGE_SIZES = ['1K', '2K', '4K'];
const XAI_RATIOS = new Set(['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2']);

const DEFAULTS = {
  provider: 'google',
  aspectRatio: '1:1',
  imageSize: '1K',
  size: '1024x1024',
  timeoutMs: 150000,
  workspaceFolder: 'image-gen',
  google: { model: 'gemini-3.1-flash-image', endpoint: 'https://generativelanguage.googleapis.com/v1beta/interactions', native: false },
  openai: { model: 'gpt-image-2', baseURL: 'https://api.openai.com/v1' },
  'openai-compat': { model: '', baseURL: '', editFormat: 'multipart' },
  seedream: { model: 'doubao-seedream-5-0-260128', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', watermark: true, outputFormat: 'jpeg' },
  dashscope: { model: 'qwen-image-3.0', endpoint: 'https://dashscope.aliyuncs.com/api/v1' },
  xai: { model: 'grok-imagine-image', baseURL: 'https://api.x.ai/v1' },
  zhipu: { model: 'glm-image', baseURL: 'https://open.bigmodel.cn/api/paas/v4' },
  comfyui: { baseURL: 'http://127.0.0.1:8188', timeoutMs: 300000, workflowName: 'API workflow', workflowJson: '' },
};

function loadConfig() {
  const file = process.env.LOCAL_CODEX_IMAGE_GEN_CONTEXT;
  if (!file) return { ...DEFAULTS, cwd: process.cwd() };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : { ...DEFAULTS, cwd: process.cwd() };
  } catch (error) {
    throw new Error(`无法读取图片生成配置：${error.message}`);
  }
}

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function providerConfig(config, provider) {
  const defaults = DEFAULTS[provider] || {};
  const saved = config[provider] && typeof config[provider] === 'object' ? config[provider] : {};
  return { ...defaults, ...saved };
}

function resolveCall(config, args = {}) {
  const requested = text(args.provider);
  if (requested && !PROVIDERS.includes(requested)) {
    throw new Error(`不支持的图片服务 ${requested}。可选：${PROVIDERS.join('、')}。订阅登录不可用，请改用 API Key。`);
  }
  if (['chatgpt-sub', 'grok-sub', 'google-sub'].includes(requested)) {
    throw new Error('当前版本使用 API Key 或本地 ComfyUI，不支持 ChatGPT / Grok / Google 订阅登录。');
  }
  const provider = requested || text(config.provider, DEFAULTS.provider);
  if (!PROVIDERS.includes(provider)) throw new Error(`不支持的图片服务 ${provider}`);
  const profile = providerConfig(config, provider);
  const model = text(args.model) || text(profile.model);
  return { provider, profile, model, config };
}

function requireKey(profile, provider) {
  if (provider === 'comfyui') return '';
  const apiKey = text(profile.apiKey);
  if (!apiKey) throw new Error(`还没有配置 ${provider} 的 API Key。请打开设置 → 图片生成填写后再试。`);
  return apiKey;
}

function redact(value, secret) {
  const textValue = String(value || '');
  if (!secret) return textValue;
  return textValue.split(secret).join('[redacted]');
}

function detectImageMediaType(data) {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (ascii(data, 0, 6) === 'GIF87a' || ascii(data, 0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(data, 0, 4) === 'RIFF' && ascii(data, 8, 4) === 'WEBP') return 'image/webp';
  return undefined;
}

function startsWith(data, signature) {
  return signature.every((byte, index) => data[index] === byte);
}

function ascii(data, offset, length) {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

function extensionOf(mediaType) {
  if (mediaType === 'image/jpeg') return 'jpg';
  if (mediaType === 'image/webp') return 'webp';
  if (mediaType === 'image/gif') return 'gif';
  return 'png';
}

function mediaTypeOf(value) {
  const mediaType = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType) ? mediaType : undefined;
}

function decodeBase64(value, label) {
  const clean = String(value || '').replace(/\s+/g, '');
  if (!clean) throw new Error(`${label} 返回了空的图片数据`);
  const decoded = Buffer.from(clean, 'base64');
  if (!decoded.length) throw new Error(`${label} 返回了无效的 base64 图片`);
  return decoded;
}

async function readBounded(response, maxBytes) {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) throw new Error(`图片响应超过 ${maxBytes} 字节`);
      chunks.push(Buffer.from(next.value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function endpointUrl(base, suffix) {
  try {
    return new URL(suffix, base.endsWith('/') ? base : `${base}/`).toString();
  } catch {
    throw new Error('图片服务地址必须是完整的 URL');
  }
}

function xaiParameters(options = {}) {
  let ratio = text(options.aspectRatio);
  if (options.size) {
    const match = /^(\d+)x(\d+)$/.exec(String(options.size).trim());
    if (!match) throw new Error('xAI 的 size 请使用 WIDTHxHEIGHT，或直接传 aspect_ratio');
    const width = Number(match[1]);
    const height = Number(match[2]);
    let divisor = width;
    let remainder = height;
    while (remainder !== 0) {
      const next = divisor % remainder;
      divisor = remainder;
      remainder = next;
    }
    const fromSize = `${width / divisor}:${height / divisor}`;
    if (ratio && ratio !== fromSize) throw new Error('xAI 的 size 与 aspect_ratio 不一致');
    ratio = fromSize;
  }
  if (ratio && !XAI_RATIOS.has(ratio)) throw new Error(`xAI 不支持比例 ${ratio}`);
  const resolution = text(options.imageSize).toLowerCase();
  if (resolution && resolution !== '1k' && resolution !== '2k') throw new Error(`xAI 不支持清晰度 ${options.imageSize}`);
  return {
    ...(ratio && ratio !== 'auto' ? { aspect_ratio: ratio } : {}),
    ...(resolution ? { resolution } : {}),
  };
}

function formatDashScopeSize(size) {
  const value = text(size);
  return value ? value.replace(/x/gi, '*') : undefined;
}

async function generateImage(args = {}) {
  const config = loadConfig();
  const call = resolveCall(config, args);
  const prompt = text(args.prompt);
  if (!prompt) throw new Error('generate_image 需要 prompt');
  const signal = AbortSignal.timeout(Number(call.profile.timeoutMs || config.timeoutMs || DEFAULTS.timeoutMs));
  const generated = await dispatchGenerate(call, prompt, args, signal);
  return persistImage(config, generated, { ...call, prompt, output: describeOutput(call, args) });
}

async function editImage(args = {}) {
  const config = loadConfig();
  if (args.source === 'canvas_selection') throw new Error('当前没有画布。请把参考图保存成文件，并用 source_path 传入。');
  const call = resolveCall(config, args);
  const prompt = text(args.prompt);
  if (!prompt) throw new Error('edit_image 需要 prompt');
  const sources = await readSourceImages(config, args);
  const signal = AbortSignal.timeout(Number(call.profile.timeoutMs || config.timeoutMs || DEFAULTS.timeoutMs));
  const generated = await dispatchEdit(call, prompt, sources, args, signal);
  return persistImage(config, generated, { ...call, prompt, output: describeOutput(call, args) });
}

async function generateImages(args = {}) {
  const prompts = Array.isArray(args.prompts) ? args.prompts.map((item) => text(item)).filter(Boolean) : [];
  if (!prompts.length) throw new Error('generate_images 至少需要一条 prompt');
  if (prompts.length > 10) throw new Error(`generate_images 一次最多 10 条，当前 ${prompts.length} 条`);
  const images = [];
  const failures = [];
  for (const [index, prompt] of prompts.entries()) {
    try {
      const value = await generateImage({ ...args, prompt });
      images.push({ ...publicImage(value), prompt });
    } catch (error) {
      failures.push({ index, prompt, error: error.message || String(error) });
    }
  }
  return { images, failures };
}

function describeOutput(call, args) {
  if (call.provider === 'google' || call.provider === 'xai') return `${text(args.aspect_ratio, call.config.aspectRatio || DEFAULTS.aspectRatio)}, ${text(args.image_size, call.config.imageSize || DEFAULTS.imageSize)}`;
  if (call.provider === 'comfyui') return text(call.profile.workflowName, 'API workflow');
  const size = text(args.size, call.config.size || DEFAULTS.size);
  return text(args.quality) ? `${size}, quality=${text(args.quality)}` : size;
}

async function dispatchGenerate(call, prompt, args, signal) {
  const { provider, profile } = call;
  if (provider === 'comfyui') return generateComfy(profile, prompt, undefined, signal);
  if (provider === 'google') return generateGoogle(profile, prompt, args, call.config, signal);
  if (provider === 'dashscope') return generateDashScope(profile, prompt, args, call.config, signal);
  return generateCompatible(provider, profile, prompt, args, call.config, signal);
}

async function dispatchEdit(call, prompt, sources, args, signal) {
  const { provider, profile } = call;
  if (provider === 'comfyui') {
    if (sources.length !== 1) throw new Error(`ComfyUI 修图一次只接受 1 张参考图，当前 ${sources.length} 张`);
    return generateComfy(profile, prompt, sources[0], signal);
  }
  if (provider === 'google') return editGoogle(profile, prompt, sources, args, call.config, signal);
  if (provider === 'dashscope') return editDashScope(profile, prompt, sources, args, call.config, signal);
  if (provider === 'seedream') return editSeedream(profile, prompt, sources, args, call.config, signal);
  return editCompatible(provider, profile, prompt, sources, args, call.config, signal);
}

async function generateGoogle(profile, prompt, args, config, signal) {
  return requestGoogle({ profile, prompt, sources: [], args, config, signal, operation: 'generation' });
}

async function editGoogle(profile, prompt, sources, args, config, signal) {
  return requestGoogle({ profile, prompt, sources, args, config, signal, operation: 'editing' });
}

async function requestGoogle({ profile, prompt, sources, args, config, signal, operation }) {
  const apiKey = requireKey(profile, 'google');
  const native = profile.native === true;
  const aspectRatio = text(args.aspect_ratio, config.aspectRatio || DEFAULTS.aspectRatio);
  const imageSize = text(args.image_size, config.imageSize || DEFAULTS.imageSize);
  if (!ASPECT_RATIOS.includes(aspectRatio)) throw new Error(`不支持的宽高比 ${aspectRatio}`);
  if (!IMAGE_SIZES.includes(imageSize)) throw new Error(`不支持的清晰度 ${imageSize}`);
  const endpoint = native ? nativeGoogleUrl(profile.endpoint, profile.model) : profile.endpoint;
  const nativeParts = [
    ...sources.map((image) => ({ inlineData: { mimeType: image.mediaType, data: image.data.toString('base64') } })),
    { text: prompt },
  ];
  const interactionInput = sources.length === 0
    ? prompt
    : [
        ...sources.flatMap((image, index) => [
          { type: 'text', text: `图 ${index + 1} (Image ${index + 1}):` },
          { type: 'image', mime_type: image.mediaType, data: image.data.toString('base64') },
        ]),
        { type: 'text', text: prompt },
      ];
  const body = native
    ? { contents: [{ role: 'user', parts: nativeParts }], generationConfig: { candidateCount: 1, responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio, imageSize } } }
    : { model: profile.model, input: interactionInput, response_format: { type: 'image', mime_type: 'image/jpeg', aspect_ratio: aspectRatio, image_size: imageSize } };
  const response = await fetch(endpoint, {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
  });
  const raw = await readBounded(response, Math.ceil(MAX_IMAGE_BYTES * 1.4) + ERROR_LIMIT);
  const textBody = raw.toString('utf8');
  if (!response.ok) throw new Error(`Google 图片${operation === 'editing' ? '编辑' : '生成'}失败 (${response.status})：${redact(textBody, apiKey).slice(0, ERROR_LIMIT)}`);
  let payload;
  try { payload = JSON.parse(textBody); } catch { throw new Error('Google 返回的不是 JSON'); }
  const image = native ? nativeOutputImage(payload) : interactionOutputImage(payload);
  if (!image) throw new Error(`Google 没有返回图片：${redact(textBody, apiKey).slice(0, ERROR_LIMIT)}`);
  const data = decodeBase64(image.data, 'Google');
  if (data.length > MAX_IMAGE_BYTES) throw new Error('Google 返回的图片过大');
  return { data, mediaType: detectImageMediaType(data) || mediaTypeOf(image.mime_type) || 'image/jpeg' };
}

function nativeGoogleUrl(endpoint, model) {
  let url;
  try { url = new URL(endpoint); } catch { throw new Error('Google 地址必须是完整 URL'); }
  const base = url.pathname.replace(/\/+$/, '').replace(/\/(?:interactions|models(?:\/[^/]+:generateContent)?)$/, '');
  url.pathname = `${base}/models/${encodeURIComponent(String(model || '').replace(/^models\//, ''))}:generateContent`;
  return url.toString();
}

function nativeOutputImage(value) {
  const candidates = value && value.candidates;
  if (!Array.isArray(candidates)) return undefined;
  for (const candidate of candidates) {
    const parts = candidate && candidate.content && candidate.content.parts;
    if (!Array.isArray(parts)) continue;
    for (const part of parts) {
      if (!part || part.thought === true) continue;
      const image = part.inlineData || part.inline_data;
      if (image && typeof image.data === 'string') return { data: image.data, mime_type: image.mimeType || image.mime_type };
    }
  }
  return undefined;
}

function interactionOutputImage(value) {
  if (!value || typeof value !== 'object') return undefined;
  const direct = imageContent(value.output_image, false);
  if (direct) return direct;
  if (!Array.isArray(value.steps)) return undefined;
  for (const step of value.steps) {
    if (!step || step.type !== 'model_output' || !Array.isArray(step.content)) continue;
    for (const content of step.content) {
      const image = imageContent(content, true);
      if (image) return image;
    }
  }
  return undefined;
}

function imageContent(value, requiresImageType) {
  if (!value || typeof value !== 'object') return undefined;
  if (requiresImageType && value.type !== 'image') return undefined;
  if (typeof value.data !== 'string') return undefined;
  return { data: value.data, mime_type: value.mime_type };
}

async function generateCompatible(provider, profile, prompt, args, config, signal) {
  const apiKey = requireKey(profile, provider);
  const extra = provider === 'xai' ? xaiParameters({ aspectRatio: args.aspect_ratio, imageSize: args.image_size, size: args.size }) : {};
  const size = provider === 'xai' ? undefined : text(args.size, config.size || DEFAULTS.size);
  const quality = text(args.quality, config.quality || '');
  const body = {
    model: profile.model,
    prompt,
    ...(size ? { size } : {}),
    ...(quality ? { quality } : {}),
    ...(provider === 'seedream' ? { response_format: 'url', watermark: profile.watermark !== false, ...(profile.outputFormat ? { output_format: profile.outputFormat } : {}) } : {}),
    ...extra,
  };
  const response = await fetch(endpointUrl(profile.baseURL, 'images/generations'), {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return parseImageResponse(response, provider, apiKey, signal);
}

async function editCompatible(provider, profile, prompt, sources, args, config, signal) {
  const apiKey = requireKey(profile, provider);
  const format = provider === 'xai' ? 'xaiJson' : text(profile.editFormat, 'multipart');
  if (format === 'xaiJson') {
    const references = sources.map((image) => ({ type: 'image_url', url: toDataUrl(image) }));
    const response = await fetch(endpointUrl(profile.baseURL, 'images/edits'), {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: profile.model,
        prompt,
        ...(references.length === 1 ? { image: references[0] } : { images: references }),
        ...xaiParameters({ aspectRatio: args.aspect_ratio, imageSize: args.image_size, size: args.size }),
      }),
    });
    return parseImageResponse(response, provider, apiKey, signal);
  }
  if (format === 'json' || format === 'qwenJson') {
    const response = await fetch(endpointUrl(profile.baseURL, 'images/generations'), {
      method: 'POST',
      redirect: 'error',
      signal,
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: profile.model,
        prompt,
        image: sources.map(toDataUrl),
        ...(text(args.size, config.size) ? { size: text(args.size, config.size) } : {}),
      }),
    });
    return parseImageResponse(response, provider, apiKey, signal);
  }
  const form = new FormData();
  const field = sources.length > 1 ? 'image[]' : 'image';
  sources.forEach((image, index) => {
    form.append(field, new Blob([image.data], { type: image.mediaType }), `reference-${index + 1}.${extensionOf(image.mediaType)}`);
  });
  form.append('prompt', prompt);
  form.append('model', profile.model || profile.editModel || '');
  const size = text(args.size, config.size || '');
  const quality = text(args.quality, config.quality || '');
  if (size) form.append('size', size);
  if (quality) form.append('quality', quality);
  const response = await fetch(endpointUrl(profile.baseURL, 'images/edits'), {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { authorization: `Bearer ${apiKey}` },
    body: form,
  });
  return parseImageResponse(response, provider, apiKey, signal);
}

async function editSeedream(profile, prompt, sources, args, config, signal) {
  const apiKey = requireKey(profile, 'seedream');
  const size = text(args.size, config.size || '');
  const response = await fetch(endpointUrl(profile.baseURL, 'images/generations'), {
    method: 'POST',
    redirect: 'error',
    signal,
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: profile.model,
      prompt,
      image: sources.map(toDataUrl),
      ...(size ? { size } : {}),
      watermark: profile.watermark !== false,
      ...(profile.outputFormat ? { output_format: profile.outputFormat } : {}),
      response_format: 'b64_json',
    }),
  });
  return parseImageResponse(response, 'seedream', apiKey, signal);
}

async function generateDashScope(profile, prompt, args, config, signal) {
  return requestDashScope(profile, prompt, [], args, config, signal, 'generation');
}

async function editDashScope(profile, prompt, sources, args, config, signal) {
  if (sources.length > 3) throw new Error(`通义万相最多接受 3 张参考图，当前 ${sources.length} 张`);
  return requestDashScope(profile, prompt, sources, args, config, signal, 'editing');
}

async function requestDashScope(profile, prompt, sources, args, config, signal, operation) {
  const apiKey = requireKey(profile, 'dashscope');
  const model = profile.model;
  if (!String(model || '').toLowerCase().startsWith('qwen-image')) throw new Error(`通义万相需要 qwen-image 模型，当前是 ${model || '空'}`);
  const size = formatDashScopeSize(text(args.size, config.size || ''));
  const response = await fetch(`${String(profile.endpoint).replace(/\/+$/, '')}/services/aigc/multimodal-generation/generation`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      input: {
        messages: [{
          role: 'user',
          content: [...sources.map((image) => ({ image: toDataUrl(image) })), { text: prompt }],
        }],
      },
      parameters: { prompt_extend: operation === 'editing', ...(size ? { size } : {}) },
    }),
  });
  const raw = await readBounded(response, ERROR_LIMIT + 1024 * 1024);
  const textBody = raw.toString('utf8');
  if (!response.ok) throw new Error(`通义万相失败 (${response.status})：${redact(textBody, apiKey).slice(0, ERROR_LIMIT)}`);
  let payload;
  try { payload = JSON.parse(textBody); } catch { throw new Error('通义万相返回的不是 JSON'); }
  const contents = payload.output && payload.output.choices && payload.output.choices[0] && payload.output.choices[0].message && payload.output.choices[0].message.content;
  const imageUrl = Array.isArray(contents) ? contents.map((item) => item && (item.image || item.image_url || item.url)).find(Boolean) : '';
  if (!imageUrl) throw new Error(`通义万相没有返回图片：${redact(payload.message || textBody, apiKey).slice(0, ERROR_LIMIT)}`);
  return downloadImage(imageUrl, 'dashscope', apiKey, signal);
}

async function parseImageResponse(response, provider, apiKey, signal) {
  const raw = await readBounded(response, Math.ceil(MAX_IMAGE_BYTES * 1.4) + ERROR_LIMIT);
  const textBody = raw.toString('utf8');
  if (!response.ok) throw new Error(`${provider} 图片请求失败 (${response.status})：${redact(textBody, apiKey).slice(0, ERROR_LIMIT)}`);
  let payload;
  try { payload = JSON.parse(textBody); } catch { throw new Error(`${provider} 返回的不是 JSON`); }
  const image = firstImage(payload);
  if (!image) throw new Error(`${provider} 没有返回图片：${redact(textBody, apiKey).slice(0, ERROR_LIMIT)}`);
  if (image.b64_json) {
    const data = decodeBase64(image.b64_json, provider);
    if (data.length > MAX_IMAGE_BYTES) throw new Error(`${provider} 返回的图片过大`);
    return { data, mediaType: detectImageMediaType(data) || mediaTypeOf(image.mime_type) || 'image/png' };
  }
  return downloadImage(image.url, provider, apiKey, signal);
}

function firstImage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const list = Array.isArray(value.data) ? value.data : Array.isArray(value.images) ? value.images : Array.isArray(value.output) ? value.output : undefined;
  const item = list && list[0];
  if (!item || typeof item !== 'object') return undefined;
  const mime = item.mime_type || item.mime;
  if (typeof item.b64_json === 'string' && item.b64_json.length > 0) return { b64_json: item.b64_json, mime_type: mime };
  if (typeof item.url === 'string' && item.url.length > 0) return { url: item.url, mime_type: mime };
  return undefined;
}

async function downloadImage(url, provider, apiKey, signal) {
  if (!url) throw new Error(`${provider} 没有返回图片地址`);
  if (url.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(url.trim());
    if (!match) throw new Error(`${provider} 返回了无效的 data URL`);
    const data = decodeBase64(match[2], provider);
    return { data, mediaType: detectImageMediaType(data) || mediaTypeOf(match[1]) || 'image/png' };
  }
  let response = await fetch(url, { redirect: 'follow', signal, headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {} });
  if (!response.ok && apiKey) response = await fetch(url, { redirect: 'follow', signal });
  if (!response.ok) throw new Error(`${provider} 图片下载失败 (${response.status})`);
  const data = await readBounded(response, MAX_IMAGE_BYTES);
  const mediaType = detectImageMediaType(data) || mediaTypeOf(response.headers.get('content-type'));
  if (!mediaType) throw new Error(`${provider} 下载到的不是受支持的图片`);
  return { data, mediaType };
}

function toDataUrl(image) {
  return `data:${image.mediaType};base64,${image.data.toString('base64')}`;
}

function prepareComfyWorkflow(workflowJson, prompt, seed, imageName) {
  if (!String(workflowJson || '').trim()) throw new Error('请先在设置 → 图片生成中粘贴 ComfyUI 的 API Format Workflow JSON');
  let workflow;
  try { workflow = JSON.parse(workflowJson); } catch { throw new Error('ComfyUI workflow 不是合法 JSON'); }
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) throw new Error('ComfyUI workflow 必须是 API 格式对象');
  let promptHits = 0;
  const inject = (value) => {
    if (typeof value === 'string') {
      let next = value;
      if (next.includes('{{prompt}}') || next.includes('%prompt%')) {
        promptHits += 1;
        next = next.replaceAll('{{prompt}}', prompt).replaceAll('%prompt%', prompt);
      }
      if (next === '{{seed}}' || next === '%seed%') return seed;
      return next.replaceAll('{{seed}}', String(seed)).replaceAll('%seed%', String(seed));
    }
    if (Array.isArray(value)) return value.map(inject);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, inject(child)]));
  };
  let imageInputs = 0;
  const prepared = {};
  for (const [nodeId, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object' || !node.inputs || typeof node.inputs !== 'object') {
      prepared[nodeId] = node;
      continue;
    }
    const inputs = inject(node.inputs);
    if (inputs.image === '{{image}}' || inputs.image === '%image%') {
      imageInputs += 1;
      if (imageName) inputs.image = imageName;
    }
    prepared[nodeId] = { ...node, inputs };
  }
  if (promptHits === 0) throw new Error('ComfyUI workflow 需要包含 {{prompt}}');
  if (!imageName && imageInputs > 0) throw new Error('这个 workflow 含有 {{image}}，请改用 edit_image 并提供参考图');
  if (imageName && imageInputs !== 1) throw new Error('修图 workflow 需要恰好一个 {{image}} 输入');
  return prepared;
}

async function generateComfy(profile, prompt, source, signal) {
  const base = String(profile.baseURL || DEFAULTS.comfyui.baseURL).replace(/\/+$/, '');
  const seed = Math.floor(Math.random() * 0x100000000);
  let imageName;
  if (source) {
    const filename = `source-${Date.now()}.${extensionOf(source.mediaType)}`;
    const form = new FormData();
    form.append('image', new Blob([source.data], { type: source.mediaType }), filename);
    const uploaded = await fetch(`${base}/upload/image`, { method: 'POST', signal, body: form });
    const uploadedText = await uploaded.text();
    if (!uploaded.ok) throw new Error(`ComfyUI 上传失败 (${uploaded.status})：${uploadedText.slice(0, ERROR_LIMIT)}`);
    const uploadedJson = JSON.parse(uploadedText);
    imageName = uploadedJson.name || filename;
  }
  const workflow = prepareComfyWorkflow(profile.workflowJson, prompt, seed, imageName);
  const queued = await fetch(`${base}/prompt`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  });
  const queuedText = await queued.text();
  if (!queued.ok) throw new Error(`ComfyUI 提交失败 (${queued.status})：${queuedText.slice(0, ERROR_LIMIT)}`);
  const promptId = JSON.parse(queuedText).prompt_id;
  if (!promptId) throw new Error('ComfyUI 没有返回 prompt_id');
  const started = Date.now();
  const timeoutMs = Number(profile.timeoutMs || DEFAULTS.comfyui.timeoutMs);
  let output;
  while (Date.now() - started < timeoutMs) {
    if (signal.aborted) throw new Error('ComfyUI 生成已取消');
    const history = await fetch(`${base}/history/${promptId}`, { signal });
    if (history.ok) {
      const payload = await history.json();
      const entry = payload[promptId];
      const images = [];
      const outputs = entry && entry.outputs;
      if (outputs) {
        for (const node of Object.values(outputs)) {
          for (const image of (node && node.images) || []) {
            if (image && image.filename) images.push(image);
          }
        }
      }
      if (images.length) {
        output = images[0];
        break;
      }
      if (entry && entry.status && entry.status.status_str === 'error') throw new Error('ComfyUI 工作流执行失败');
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!output) throw new Error('ComfyUI 在超时前没有产出图片');
  const view = new URL(`${base}/view`);
  view.searchParams.set('filename', output.filename);
  if (output.subfolder) view.searchParams.set('subfolder', output.subfolder);
  if (output.type) view.searchParams.set('type', output.type);
  const downloaded = await downloadImage(view.toString(), 'comfyui', '', signal);
  return { ...downloaded, seed };
}

async function readSourceImages(config, args) {
  const paths = [];
  if (typeof args.source_path === 'string' && args.source_path.trim()) paths.push(args.source_path.trim());
  if (Array.isArray(args.source_paths)) paths.push(...args.source_paths.map((item) => text(item)).filter(Boolean));
  if (args.source_attachment_id || args.source_attachment_ids) {
    throw new Error('请使用 source_path 指向工作区或附件里的图片文件，不要传 attachment id。');
  }
  if (!paths.length) throw new Error('edit_image 需要 source_path 或 source_paths，指向要修改的图片文件。');
  if (paths.length > 4) throw new Error('一次最多 4 张参考图');
  const cwd = text(config.cwd, process.cwd());
  const images = [];
  for (const item of paths) {
    const resolved = path.isAbsolute(item) ? item : path.resolve(cwd, item);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`找不到参考图：${item}`);
    const data = fs.readFileSync(resolved);
    if (data.length > MAX_IMAGE_BYTES) throw new Error(`参考图超过 ${MAX_IMAGE_BYTES} 字节：${item}`);
    const mediaType = detectImageMediaType(data) || mediaTypeOf(mediaTypeFromName(resolved));
    if (!mediaType) throw new Error(`不是受支持的图片：${item}`);
    images.push({ data, mediaType });
  }
  return images;
}

function mediaTypeFromName(file) {
  const extension = path.extname(file).toLowerCase();
  if (extension === '.png') return 'image/png';
  if (extension === '.jpg' || extension === '.jpeg') return 'image/jpeg';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.gif') return 'image/gif';
  return '';
}

function persistImage(config, generated, meta) {
  const savedTo = config.saveToWorkspace === false ? '' : writeWorkspaceImage(config, generated);
  return {
    provider: meta.provider,
    model: meta.provider === 'comfyui' ? text(meta.profile.workflowName, 'ComfyUI') : meta.model,
    output: meta.output,
    prompt: meta.prompt,
    savedTo,
    mediaType: generated.mediaType,
    bytes: generated.data.length,
    ...(typeof generated.seed === 'number' ? { seed: generated.seed } : {}),
    data: generated.data,
  };
}

function writeWorkspaceImage(config, generated) {
  const cwd = text(config.cwd);
  if (!cwd) return '';
  const folder = text(config.workspaceFolder, DEFAULTS.workspaceFolder);
  const directory = path.resolve(cwd, folder);
  const relative = path.relative(cwd, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('保存目录必须在当前工作区内');
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(directory, `${stamp}-${Math.random().toString(36).slice(2, 8)}.${extensionOf(generated.mediaType)}`);
  fs.writeFileSync(file, generated.data);
  return file;
}

function publicImage(value) {
  return {
    provider: value.provider,
    model: value.model,
    output: value.output,
    savedTo: value.savedTo,
    mediaType: value.mediaType,
    bytes: value.bytes,
    ...(value.seed == null ? {} : { seed: value.seed }),
    ...(value.prompt ? { prompt: value.prompt } : {}),
  };
}

let inspirationCache;
function loadInspiration() {
  if (inspirationCache) return inspirationCache;
  const root = path.join(__dirname, 'image-gen-data');
  const sources = [
    ['awesome-gpt-image-2', 'Awesome GPT Image', 'awesome-gpt-image-2.json'],
    ['handraw-style', '手绘风格图鉴', 'handraw-style.json'],
  ];
  inspirationCache = sources.map(([id, label, file]) => {
    const document = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    const cases = Array.isArray(document.cases) ? document.cases : [];
    return {
      id,
      label,
      cases: cases.map((item) => ({
        id: String(item.id || ''),
        title: String(item.title || ''),
        category: String(item.category || ''),
        prompt: String(item.prompt || ''),
        styles: Array.isArray(item.styles) ? item.styles.map(String) : [],
        scenes: Array.isArray(item.scenes) ? item.scenes.map(String) : [],
      })).filter((item) => item.id && item.title && item.prompt),
    };
  });
  return inspirationCache;
}

function searchInspiration(request = {}) {
  const limit = Math.min(Math.max(Number(request.limit) || 8, 1), 20);
  const query = text(request.query).toLowerCase();
  const sourceId = text(request.source || request.sourceId);
  const category = text(request.category);
  const matches = [];
  for (const source of loadInspiration()) {
    if (sourceId && source.id !== sourceId) continue;
    for (const item of source.cases) {
      if (category && item.category !== category) continue;
      const haystack = [item.title, item.prompt, item.category, ...item.styles, ...item.scenes];
      if (query && !haystack.some((value) => value.toLowerCase().includes(query))) continue;
      matches.push({ sourceId: source.id, id: item.id, title: item.title, category: item.category, prompt: item.prompt });
    }
  }
  return { total: matches.length, hits: matches.slice(0, limit) };
}

async function testConnection() {
  const config = loadConfig();
  const call = resolveCall(config, {});
  const { provider, profile } = call;
  if (provider === 'comfyui') {
    const base = String(profile.baseURL || DEFAULTS.comfyui.baseURL).replace(/\/+$/, '');
    const response = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`ComfyUI 无响应 (${response.status})`);
    return { ok: true, provider, detail: `已连接 ${base}` };
  }
  const apiKey = requireKey(profile, provider);
  let url;
  let headers;
  if (provider === 'google') {
    const endpoint = new URL(profile.native ? nativeGoogleUrl(profile.endpoint, profile.model) : profile.endpoint);
    endpoint.pathname = endpoint.pathname.replace(/\/(?:interactions|models(?:\/[^/]+:generateContent)?)$/, '/models');
    endpoint.search = '';
    url = endpoint.toString();
    headers = { 'x-goog-api-key': apiKey };
  } else if (provider === 'dashscope') {
    url = `${String(profile.endpoint).replace(/\/+$/, '')}/models`;
    headers = { authorization: `Bearer ${apiKey}` };
  } else {
    url = endpointUrl(profile.baseURL, 'models');
    headers = { authorization: `Bearer ${apiKey}` };
  }
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`${provider} 连接失败 (${response.status})：${redact(body, apiKey).slice(0, 300)}`);
  return { ok: true, provider, model: profile.model || '', detail: '连接成功' };
}

module.exports = {
  ASPECT_RATIOS,
  DEFAULTS,
  IMAGE_SIZES,
  PROVIDERS,
  detectImageMediaType,
  editImage,
  formatDashScopeSize,
  generateImage,
  generateImages,
  loadConfig,
  prepareComfyWorkflow,
  publicImage,
  redact,
  searchInspiration,
  testConnection,
  xaiParameters,
};

if (require.main === module) {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  if (detectImageMediaType(png) !== 'image/png') throw new Error('png sniff failed');
  if (xaiParameters({ size: '1024x1024' }).aspect_ratio !== '1:1') throw new Error('xai ratio failed');
  if (formatDashScopeSize('1024x1024') !== '1024*1024') throw new Error('dashscope size failed');
  if (!redact('key sk-test leaked', 'sk-test').includes('[redacted]')) throw new Error('redact failed');
  const workflow = prepareComfyWorkflow(JSON.stringify({ '1': { inputs: { text: 'draw {{prompt}}', seed: '{{seed}}' } } }), 'cat', 7);
  if (workflow['1'].inputs.text !== 'draw cat' || workflow['1'].inputs.seed !== 7) throw new Error('comfy inject failed');
  const found = searchInspiration({ query: 'Playful', source: 'handraw-style', limit: 3 });
  if (!found.total || !found.hits[0].prompt) throw new Error('inspiration search failed');
  const sample = searchInspiration({ query: 'vocabulary', source: 'awesome-gpt-image-2', limit: 2 });
  if (!sample.total) throw new Error('awesome catalog search failed');
  console.log(`image-gen self-test ok (${found.total} handraw hits, ${sample.total} awesome hits)`);
}
