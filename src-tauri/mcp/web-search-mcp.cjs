'use strict';

const search = require('./web-search.cjs');

function reply(id, result, error) {
  process.stdout.write(`${JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result })}\n`);
}

function textResult(value, extra = {}) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...extra };
}

const tools = [
  {
    name: 'web_search',
    description: '用 DuckDuckGo HTML 搜索公开网页，返回标题和链接。不要改用 OpenAI / ChatGPT 搜索。',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'web_fetch',
    description: '读取一个 HTTP/HTTPS 页面的可见文本（截断）。',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false },
  },
];

async function callTool(name, args = {}) {
  if (name === 'web_search') {
    const results = await search.searchWeb(args.query, args.limit);
    return textResult({ query: args.query, results });
  }
  if (name === 'web_fetch') return textResult({ url: args.url, text: await search.fetchPage(args.url) });
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
    if (message.method === 'initialize') reply(message.id, { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'local-codex-web-search', version: '0.1.0' } });
    else if (message.method === 'tools/list') reply(message.id, { tools });
    else if (message.method === 'resources/list') reply(message.id, { resources: [] });
    else if (message.method === 'resources/templates/list') reply(message.id, { resourceTemplates: [] });
    else if (message.method === 'ping') reply(message.id, {});
    else if (message.method === 'tools/call') callTool(String(message.params?.name || ''), message.params?.arguments || {}).then((result) => reply(message.id, result)).catch((error) => reply(message.id, textResult(error.message, { isError: true })));
    else reply(message.id, null, { code: -32601, message: `Method not found: ${message.method}` });
  }
});
