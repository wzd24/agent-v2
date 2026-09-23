'use strict';

const fs = require('node:fs');
const path = require('node:path');
const office = require('./office.cjs');
const notebook = require('./notebook.cjs');

function readContext() {
  const file = process.env.LOCAL_CODEX_NOTEBOOK_CONTEXT || process.env.LOCAL_CODEX_OFFICE_CONTEXT || '';
  let saved = {};
  try { if (file && fs.existsSync(file)) saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { saved = {}; }
  return {
    workspaceRoot: String(saved.cwd || process.env.LOCAL_CODEX_OFFICE_ROOT || process.cwd()),
    codexHome: String(saved.codexHome || process.env.LOCAL_CODEX_HOME || process.env.CODEX_HOME || ''),
  };
}

function reply(id, result, error) {
  process.stdout.write(`${JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result })}\n`);
}

function textResult(value, extra = {}) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...extra };
}

function resolveWorkspace(filePath) {
  return office.safeJoin(readContext().workspaceRoot, filePath);
}

function writeNotebook(filePath, data) {
  const target = resolveWorkspace(filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(notebook.serializeNotebook(data), 'utf8');
  fs.writeFileSync(target, buffer);
  return { path: target, bytes: buffer.length };
}

function loadNotebook(filePath) {
  const target = resolveWorkspace(filePath);
  if (!fs.existsSync(target)) throw new Error(`文件不存在：${filePath}`);
  return { path: target, notebook: notebook.parseNotebook(fs.readFileSync(target)) };
}

const tools = [
  {
    name: 'notebook_create',
    description: '在工作区创建 .ipynb。cells 为 { cell_type: markdown|code, source }。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, title: { type: 'string' }, cells: { type: 'array' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'notebook_read',
    description: '读取 Jupyter Notebook 单元格。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'notebook_add_cell',
    description: '向已有 Notebook 追加或插入单元格。index 省略则追加到末尾。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, cell_type: { type: 'string' }, source: { type: 'string' }, index: { type: 'number' } }, required: ['path', 'source'], additionalProperties: false },
  },
  {
    name: 'notebook_update_cell',
    description: '更新 Notebook 中指定索引的单元格。',
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, index: { type: 'number' }, cell_type: { type: 'string' }, source: { type: 'string' } }, required: ['path', 'index'], additionalProperties: false },
  },
];

async function callTool(name, args = {}) {
  if (name === 'notebook_create') return textResult(writeNotebook(args.path, notebook.createNotebook(args)));
  if (name === 'notebook_read') return textResult({ path: args.path, ...notebook.previewNotebook(fs.readFileSync(resolveWorkspace(args.path))) });
  if (name === 'notebook_add_cell') {
    const current = loadNotebook(args.path);
    const next = notebook.addCell(current.notebook, { cell_type: args.cell_type, source: args.source }, args.index);
    return textResult({ ...writeNotebook(args.path, next), cells: next.cells.length });
  }
  if (name === 'notebook_update_cell') {
    const current = loadNotebook(args.path);
    const next = notebook.updateCell(current.notebook, args.index, { cell_type: args.cell_type, source: args.source });
    return textResult({ ...writeNotebook(args.path, next), index: args.index });
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
    if (message.method === 'initialize') reply(message.id, { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'local-codex-notebook', version: '0.1.0' } });
    else if (message.method === 'tools/list') reply(message.id, { tools });
    else if (message.method === 'resources/list') reply(message.id, { resources: [] });
    else if (message.method === 'resources/templates/list') reply(message.id, { resourceTemplates: [] });
    else if (message.method === 'ping') reply(message.id, {});
    else if (message.method === 'tools/call') callTool(String(message.params?.name || ''), message.params?.arguments || {}).then((result) => reply(message.id, result)).catch((error) => reply(message.id, textResult(error.message, { isError: true })));
    else reply(message.id, null, { code: -32601, message: `Method not found: ${message.method}` });
  }
});
