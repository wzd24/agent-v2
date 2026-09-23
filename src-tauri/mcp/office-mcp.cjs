'use strict';

const fs = require('node:fs');
const path = require('node:path');
const office = require('./office.cjs');

function readContext() {
  const file = process.env.LOCAL_CODEX_OFFICE_CONTEXT || '';
  let saved = {};
  try { if (file && fs.existsSync(file)) saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { saved = {}; }
  return {
    workspaceRoot: String(saved.cwd || process.env.LOCAL_CODEX_OFFICE_ROOT || process.cwd()),
    codexHome: String(saved.codexHome || process.env.LOCAL_CODEX_HOME || process.env.CODEX_HOME || ''),
  };
}

function context() {
  return readContext();
}

function workspaceRoot() { return context().workspaceRoot; }
function codexHome() { return context().codexHome; }

function reply(id, result, error) {
  process.stdout.write(`${JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result })}\n`);
}

function textResult(value, extra = {}) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...extra };
}

function roots() {
  return office.templateRoots({ codexHome: codexHome(), workspaceRoot: workspaceRoot() });
}

function resolveWorkspace(filePath) {
  return office.safeJoin(workspaceRoot(), filePath);
}

function writeFile(filePath, buffer) {
  const target = resolveWorkspace(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, buffer);
  return { path: target, bytes: buffer.length };
}

function readFile(filePath) {
  const target = resolveWorkspace(filePath);
  if (!fs.existsSync(target)) throw new Error(`文件不存在：${filePath}`);
  return { path: target, buffer: fs.readFileSync(target) };
}

const tools = [
  {
    name: 'office_create_document',
    description: '在工作区创建 .docx 文档。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'office_read_document',
    description: '读取 .docx 文档文本。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'office_create_spreadsheet',
    description: '在工作区创建 .xlsx 表格。sheets 为 { name, rows: string[][] }。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, title: { type: 'string' }, sheets: { type: 'array' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'office_read_spreadsheet',
    description: '读取 .xlsx 或 .csv 表格。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'office_create_presentation',
    description: '在工作区创建 .pptx 演示文稿。slides 为 { title, bullets: string[] }。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, title: { type: 'string' }, slides: { type: 'array' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'office_read_presentation',
    description: '读取 .pptx 演示文稿文本。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'office_create_pdf',
    description: '在工作区创建 PDF。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'office_read_pdf',
    description: '读取 PDF 文本和页数。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'office_verify_pdf',
    description: '校验 PDF 文件头、结束标记和页面对象。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'office_replace_text',
    description: '在已有文档/表格/演示/PDF 中替换文本。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, replacements: { type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'] } } }, required: ['path', 'replacements'], additionalProperties: false },
  },
  {
    name: 'office_list_templates',
    description: '列出用户和项目模板。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'office_save_template',
    description: '保存可复用办公模板。kind 为 document、spreadsheet、presentation 或 pdf。',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, kind: { type: 'string' }, scope: { type: 'string', enum: ['user', 'project'] }, title: { type: 'string' }, description: { type: 'string' }, spec: { type: 'object' } }, required: ['name', 'kind'], additionalProperties: false },
  },
  {
    name: 'office_apply_template',
    description: '用模板生成文件，可用 values 替换 {{key}}。',
    inputSchema: { type: 'object', properties: { name: { type: 'string' }, path: { type: 'string' }, values: { type: 'object' } }, required: ['name', 'path'], additionalProperties: false },
  },
];

async function callTool(name, args = {}) {
  if (name === 'office_create_document') return textResult(writeFile(args.path, office.createDocument(args)));
  if (name === 'office_read_document') return textResult({ path: args.path, ...office.readDocument(readFile(args.path).buffer) });
  if (name === 'office_create_spreadsheet') return textResult(writeFile(args.path, office.createSpreadsheet(args)));
  if (name === 'office_read_spreadsheet') return textResult({ path: args.path, ...office.readAny(args.path, readFile(args.path).buffer) });
  if (name === 'office_create_presentation') return textResult(writeFile(args.path, office.createPresentation(args)));
  if (name === 'office_read_presentation') return textResult({ path: args.path, ...office.readPresentation(readFile(args.path).buffer) });
  if (name === 'office_create_pdf') return textResult(writeFile(args.path, office.createPdf(args)));
  if (name === 'office_read_pdf') return textResult({ path: args.path, ...office.readPdf(readFile(args.path).buffer) });
  if (name === 'office_verify_pdf') return textResult({ path: args.path, ...office.verifyPdf(readFile(args.path).buffer) });
  if (name === 'office_replace_text') {
    const current = readFile(args.path);
    const kind = office.detectKind(args.path, current.buffer);
    return textResult(writeFile(args.path, office.replaceText(current.buffer, kind, args.replacements || [])));
  }
  if (name === 'office_list_templates') return textResult({ templates: office.listTemplates(roots()) });
  if (name === 'office_save_template') {
    return textResult(office.saveTemplate(roots(), {
      scope: args.scope || 'user',
      name: args.name,
      kind: args.kind,
      spec: { ...(args.spec || {}), title: args.title, description: args.description, kind: args.kind },
    }));
  }
  if (name === 'office_apply_template') {
    const loaded = office.loadTemplate(roots(), args.name);
    const spec = office.applyValues(loaded.spec, args.values || {});
    const buffer = office.createAny(loaded.kind || spec.kind, spec);
    return textResult({ template: loaded.name, kind: spec.kind || loaded.kind, ...writeFile(args.path, buffer) });
  }
  throw new Error(`未知工具：${name}`);
}

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
    if (message.method === 'initialize') reply(message.id, { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'local-codex-office', version: '0.1.0' } });
    else if (message.method === 'tools/list') reply(message.id, { tools });
    else if (message.method === 'resources/list') reply(message.id, { resources: [] });
    else if (message.method === 'resources/templates/list') reply(message.id, { resourceTemplates: [] });
    else if (message.method === 'ping') reply(message.id, {});
    else if (message.method === 'tools/call') callTool(String(message.params?.name || ''), message.params?.arguments || {}).then((result) => reply(message.id, result)).catch((error) => reply(message.id, textResult(error.message, { isError: true })));
    else reply(message.id, null, { code: -32601, message: `Method not found: ${message.method}` });
  }
});
