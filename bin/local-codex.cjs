#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { AppServerBridge } = require('../cli/bridge.cjs');
const { collectAgentText, collectThreadText, findAppServer, helpText, parseArgs, serializeThreadExport, parseThreadImport, injectItemsFromMessages } = require('../cli/cli.cjs');
const { listStoredProjects, engineHome } = require('../cli/codex-projects.cjs');
const { cloneRepository } = require('../cli/git-clone.cjs');

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));

function print(value, asJson) {
  if (asJson) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
}

function resolveHome() {
  return engineHome();
}

function readProviderSecrets(codexHome) {
  const configPath = path.join(codexHome, 'config.toml');
  const names = new Set(['DEEPSEEK_API_KEY']);
  if (fs.existsSync(configPath)) {
    for (const match of fs.readFileSync(configPath, 'utf8').matchAll(/^env_key\s*=\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/gm)) {
      names.add(match[1]);
    }
  }
  const values = {};
  for (const name of names) {
    if (process.env[name]) values[name] = process.env[name];
  }
  return values;
}

async function withBridge(options, work) {
  const repoRoot = path.join(__dirname, '..');
  const mock = options.mock || process.argv.includes('--mock');
  let command;
  let args;
  if (mock) {
    const script = path.join(repoRoot, 'mock', 'mock-app-server.mjs');
    if (!fs.existsSync(script)) {
      throw new Error('缺少 mock/mock-app-server.mjs');
    }
    command = process.execPath;
    args = [script];
  } else {
    const found = findAppServer(repoRoot);
    if (!found) {
      throw new Error('找不到 app-server。请安装完整包，或设置 CODEX_APP_SERVER_CMD。');
    }
    command = found.command;
    args = found.args;
  }
  const env = { CODEX_HOME: resolveHome(), ...readProviderSecrets(resolveHome()) };
  const bridge = new AppServerBridge({ command, args, env });
  const pendingApprovals = [];
  bridge.on('request', (message) => {
    if (String(message.method || '').endsWith('requestApproval')) {
      if (options.yes) bridge.respond(message.id, { decision: 'acceptForSession' });
      else pendingApprovals.push(message);
    } else {
      bridge.respond(message.id, { decision: 'decline' });
    }
  });
  bridge.start();
  try {
    await bridge.initialize({ name: 'local-codex-cli', title: 'Local Codex CLI', version: pkg.version }, { capabilities: { experimentalApi: true, requestAttestation: false } });
    return await work(bridge, pendingApprovals);
  } finally {
    bridge.stop();
  }
}

function waitForTurn(bridge, threadId, pendingApprovals, yes) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('等待回合完成超时')), 5 * 60 * 1000);
    const onNotification = (message) => {
      if (message.method === 'turn/completed' && (!threadId || message.params?.threadId === threadId)) {
        cleanup();
        resolve(message.params || {});
      }
      if (message.method === 'error') {
        cleanup();
        reject(new Error(message.params?.message || 'app-server 错误'));
      }
    };
    const poll = setInterval(() => {
      if (pendingApprovals.length && !yes) {
        cleanup();
        reject(new Error(`需要审批：${pendingApprovals[0].method}。加上 --yes 可自动允许。`));
      }
    }, 200);
    const cleanup = () => {
      clearTimeout(timer);
      clearInterval(poll);
      bridge.off('notification', onNotification);
    };
    bridge.on('notification', onNotification);
  });
}

async function resolveThreadId(bridge, options, needed) {
  let threadId = String(options.resume || '').trim();
  if (options.last && !threadId) {
    const listed = await bridge.request('thread/list', { limit: 1, sortKey: 'recency_at', sortDirection: 'desc' });
    const recent = Array.isArray(listed?.data) ? listed.data[0] : null;
    threadId = String(recent?.id || '');
  }
  if (!threadId) throw new Error(needed);
  return threadId;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.version) {
    print(pkg.version);
    return;
  }
  if (options.help || !options.command) {
    print(helpText(pkg.version));
    return;
  }

  if (options.command === 'exec') {
    if (!options.prompt.trim()) throw new Error('exec 需要提示词');
    const result = await withBridge(options, async (bridge, pendingApprovals) => {
      let threadId = String(options.resume || '').trim();
      if (options.last && !threadId) {
        const listed = await bridge.request('thread/list', { limit: 1, sortKey: 'recency_at', sortDirection: 'desc' });
        const recent = Array.isArray(listed?.data) ? listed.data[0] : null;
        threadId = String(recent?.id || '');
        if (!threadId) throw new Error('没有可继续的线程');
      }
      if (threadId) {
        const resumed = await bridge.request('thread/resume', { threadId });
        threadId = resumed?.thread?.id || threadId;
      } else {
        const started = await bridge.request('thread/start', { cwd: options.cwd });
        threadId = started?.thread?.id || started?.id;
      }
      if (!threadId) throw new Error(options.resume || options.last ? '无法继续线程' : '无法创建线程');
      const turnParams = {
        threadId,
        input: [{ type: 'text', text: options.prompt, text_elements: [] }],
        cwd: options.cwd,
        approvalPolicy: options.yes ? 'never' : 'on-request',
      };
      if (options.model) turnParams.model = options.model;
      await bridge.request('turn/start', turnParams);
      const completed = await waitForTurn(bridge, threadId, pendingApprovals, options.yes);
      const items = completed.turn?.items || completed.items || [];
      return {
        threadId,
        text: collectAgentText(items) || String(completed.turn?.status || 'completed'),
        status: completed.turn?.status || 'completed',
        model: completed.turn?.model || options.model || null,
      };
    });
    print(options.json ? result : result.text, options.json);
    return;
  }

  if (options.command === 'show') {
    const result = await withBridge(options, async (bridge) => {
      let threadId = String(options.resume || '').trim();
      if (options.last && !threadId) {
        const listed = await bridge.request('thread/list', { limit: 1, sortKey: 'recency_at', sortDirection: 'desc' });
        const recent = Array.isArray(listed?.data) ? listed.data[0] : null;
        threadId = String(recent?.id || '');
      }
      if (!threadId) throw new Error('show 需要线程 id 或 --last');
      await bridge.request('thread/resume', { threadId });
      const read = await bridge.request('thread/read', { threadId, includeTurns: true });
      const thread = read?.thread || {};
      return {
        threadId,
        title: thread.title || thread.name || '',
        text: collectThreadText(thread),
        status: thread.status || 'idle',
      };
    });
    print(options.json ? result : (result.text || '（没有回复）'), options.json);
    return;
  }

  if (options.command === 'export') {
    const result = await withBridge(options, async (bridge) => {
      let threadId = String(options.resume || '').trim();
      if (options.last && !threadId) {
        const listed = await bridge.request('thread/list', { limit: 1, sortKey: 'recency_at', sortDirection: 'desc' });
        const recent = Array.isArray(listed?.data) ? listed.data[0] : null;
        threadId = String(recent?.id || '');
      }
      if (!threadId) throw new Error('export 需要线程 id 或 --last');
      await bridge.request('thread/resume', { threadId });
      const read = await bridge.request('thread/read', { threadId, includeTurns: true });
      return serializeThreadExport(read?.thread || {}, threadId);
    });
    const encoded = `${JSON.stringify(result, null, 2)}\n`;
    if (options.out) {
      fs.mkdirSync(path.dirname(options.out), { recursive: true });
      fs.writeFileSync(options.out, encoded, 'utf8');
      print(options.json ? { ...result, path: options.out } : `已导出到 ${options.out}`, options.json);
      return;
    }
    print(result, true);
    return;
  }

  if (options.command === 'import') {
    const file = String(options.prompt || '').trim();
    if (!file) throw new Error('import 需要文件路径');
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved)) throw new Error(`找不到文件：${resolved}`);
    const fallbackTitle = path.basename(resolved).replace(/\.(json|txt|md)$/i, '') || '导入的线程';
    const parsed = parseThreadImport(fs.readFileSync(resolved, 'utf8'), fallbackTitle);
    if (!parsed.messages.length) throw new Error('导入文件中没有可恢复的消息');
    const result = await withBridge(options, async (bridge) => {
      const started = await bridge.request('thread/start', { cwd: options.cwd });
      const threadId = started?.thread?.id || started?.id;
      if (!threadId) throw new Error('新线程创建失败');
      await bridge.request('thread/inject_items', { threadId, items: injectItemsFromMessages(parsed.messages) });
      await bridge.request('thread/name/set', { threadId, name: parsed.title });
      return { threadId, title: parsed.title, count: parsed.messages.length };
    });
    print(options.json ? result : `已导入 ${result.count} 条消息（${result.threadId}）`, options.json);
    return;
  }

  if (options.command === 'search') {
    const term = String(options.prompt || '').trim();
    if (!term) throw new Error('search 需要关键词');
    const result = await withBridge(options, async (bridge) => {
      try {
        const listed = await bridge.request('thread/search', { searchTerm: term, limit: 50, archived: false });
        const data = Array.isArray(listed?.data) ? listed.data : [];
        if (data.length) return data.map((item) => item.thread ? item : { thread: item, snippet: item.preview || '' });
      } catch {
        /* older mock/app-server may only expose list */
      }
      const listed = await bridge.request('thread/list', { limit: 50, sortKey: 'recency_at', sortDirection: 'desc', searchTerm: term });
      return (Array.isArray(listed?.data) ? listed.data : []).map((thread) => ({ thread, snippet: thread.preview || thread.title || '' }));
    });
    if (options.json) print(result, true);
    else if (!result.length) print('没有匹配的线程');
    else print(result.map((item) => `${item.thread?.id || item.id}\t${item.thread?.title || item.thread?.name || item.snippet || '未命名'}`).join('\n'));
    return;
  }

  if (options.command === 'compact') {
    const result = await withBridge(options, async (bridge) => {
      const threadId = await resolveThreadId(bridge, options, 'compact 需要线程 id 或 --last');
      await bridge.request('thread/resume', { threadId });
      await bridge.request('thread/compact/start', { threadId });
      return { threadId, status: 'compacted' };
    });
    print(options.json ? result : `已开始压缩 ${result.threadId}`, options.json);
    return;
  }

  if (options.command === 'archive' || options.command === 'unarchive') {
    const method = options.command === 'archive' ? 'thread/archive' : 'thread/unarchive';
    const result = await withBridge(options, async (bridge) => {
      const threadId = await resolveThreadId(bridge, options, `${options.command} 需要线程 id 或 --last`);
      const response = await bridge.request(method, { threadId });
      return { threadId, status: options.command === 'archive' ? 'archived' : 'active', title: response?.thread?.title || '' };
    });
    print(options.json ? result : `${options.command === 'archive' ? '已归档' : '已取消归档'} ${result.threadId}`, options.json);
    return;
  }

  if (options.command === 'rename') {
    const name = String(options.prompt || options.folderName || '').trim();
    if (!name) throw new Error('rename 需要新名称');
    const result = await withBridge(options, async (bridge) => {
      const threadId = await resolveThreadId(bridge, options, 'rename 需要线程 id 或 --last');
      await bridge.request('thread/name/set', { threadId, name });
      return { threadId, title: name };
    });
    print(options.json ? result : `已重命名为 ${result.title}`, options.json);
    return;
  }

  if (options.command === 'delete') {
    if (!options.yes) throw new Error('delete 需要 --yes 确认');
    const result = await withBridge(options, async (bridge) => {
      const threadId = await resolveThreadId(bridge, options, 'delete 需要线程 id 或 --last');
      await bridge.request('thread/delete', { threadId });
      return { threadId, status: 'deleted' };
    });
    print(options.json ? result : `已删除 ${result.threadId}`, options.json);
    return;
  }

  if (options.command === 'projects') {
    const result = listStoredProjects(resolveHome());
    if (options.json) print(result, true);
    else if (!result.length) print('没有项目');
    else print(result.map((project) => `${project.id || '-'}\t${project.name}\t${project.path}`).join('\n'));
    return;
  }

  if (options.command === 'clone') {
    const url = String(options.prompt || '').trim();
    if (!url) throw new Error('clone 需要仓库地址');
    const result = await cloneRepository({
      url,
      parentDir: options.parent || process.cwd(),
      folderName: options.folderName,
      protocol: options.protocol,
      shallow: options.shallow,
    });
    print(options.json ? result : result.path, options.json);
    return;
  }

  if (options.command === 'threads') {
    const result = await withBridge(options, async (bridge) => {
      const listed = await bridge.request('thread/list', { limit: 50, sortKey: 'recency_at', sortDirection: 'desc' });
      return Array.isArray(listed?.data) ? listed.data : [];
    });
    if (options.json) print(result, true);
    else if (!result.length) print('没有线程');
    else print(result.map((thread) => `${thread.id}\t${thread.title || thread.name || thread.preview || '未命名'}`).join('\n'));
    return;
  }

  if (options.command === 'models') {
    const result = await withBridge(options, async (bridge) => {
      const listed = await bridge.request('model/list', {});
      return Array.isArray(listed?.data) ? listed.data : (listed?.models || []);
    });
    if (options.json) print(result, true);
    else if (!result.length) print('没有模型');
    else print(result.map((model) => model.model || model.id || model.name || JSON.stringify(model)).join('\n'));
    return;
  }

  throw new Error(`未知命令：${options.command}`);
}

main().catch((error) => {
  process.stderr.write(`${error.message || error}\n`);
  process.exitCode = 1;
});
