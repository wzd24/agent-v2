'use strict';

import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

let threadSeq = 1;
let turnSeq = 1;
let sectionSeq = 1;
const threads = new Map();
const turnTimers = new Map();
const threadQueues = new Map();
const sections = [];
const statePath = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, 'mock-state.json') : null;
const config = {
  model: process.env.LOCAL_CODEX_MODEL || 'deepseek-chat',
  model_provider: 'deepseek',
  approval_policy: 'untrusted',
  sandbox_mode: 'workspace-write',
  analytics: { enabled: false },
  model_providers: {
    deepseek: {
      name: 'deepseek',
      base_url: 'https://api.deepseek.com/',
      env_key: 'DEEPSEEK_API_KEY',
      wire_api: 'responses',
      requires_openai_auth: false,
    },
  },
};

function setConfigPath(keyPath, value) {
  const keys = String(keyPath || '').split('.').filter(Boolean);
  if (keys.length === 0) return;
  let target = config;
  for (const key of keys.slice(0, -1)) {
    if (!target[key] || typeof target[key] !== 'object' || Array.isArray(target[key])) target[key] = {};
    target = target[key];
  }
  target[keys[keys.length - 1]] = value;
}

function loadState() {
  if (!statePath || !fs.existsSync(statePath)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    for (const thread of saved.threads || []) threads.set(thread.id, thread);
    sections.push(...(saved.sections || []));
    Object.assign(config, saved.config || {});
    const ids = [...threads.keys()].map((id) => Number(String(id).replace(/\D/g, ''))).filter(Number.isFinite);
    if (ids.length > 0) threadSeq = Math.max(...ids) + 1;
  } catch {
    // Corrupt mock state should not block startup.
  }
}

function saveState() {
  if (!statePath) return;
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify({ threads: [...threads.values()], sections, config }, null, 2));
  } catch {
    // Persistence is best effort for the mock.
  }
}

loadState();

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  if (id != null) send({ id, result });
}

function replyError(id, message) {
  if (id != null) send({ id, error: { code: -32000, message } });
}

function notify(method, params) {
  send({ method, params });
}

function now() {
  return Math.floor(Date.now() / 1000);
}

function createThread() {
  const id = `mock-thread-${threadSeq++}`;
  const thread = {
    id,
    title: `新线程 ${threadSeq - 1}`,
    preview: '',
    status: 'idle',
    archived: false,
    createdAt: now(),
    updatedAt: now(),
    section: null,
    turns: [],
  };
  threads.set(id, thread);
  saveState();
  return thread;
}

function streamAgentMessage(thread, turn, text) {
  const parts = text.split(' ');
  let i = 0;
  const startedAt = Date.now();
  const agentItem = {
    id: `mock-item-${turn.id}`,
    type: 'agentMessage',
    text: '',
    status: 'inProgress',
  };
  turn.items.push(agentItem);
  notify('item/started', { threadId: thread.id, turnId: turn.id, item: agentItem });

  const timer = setInterval(() => {
    if (i >= parts.length) {
      clearInterval(timer);
      turnTimers.delete(turn.id);
      agentItem.status = 'completed';
      turn.status = 'completed';
      turn.durationMs = Date.now() - startedAt;
      thread.status = 'idle';
      thread.updatedAt = now();
      thread.preview = agentItem.text;
      saveState();
      notify('item/completed', { threadId: thread.id, turnId: turn.id, item: agentItem });
      notify('turn/completed', {
        threadId: thread.id,
        turnId: turn.id,
        turn: { id: turn.id, status: 'completed', durationMs: turn.durationMs, model: turn.model || null, items: turn.items },
      });
      return;
    }
    const delta = (i === 0 ? '' : ' ') + parts[i];
    agentItem.text += delta;
    notify('item/agentMessage/delta', {
      threadId: thread.id,
      turnId: turn.id,
      itemId: agentItem.id,
      delta,
    });
    i += 1;
  }, 25);
  turnTimers.set(turn.id, { timer, thread });
}

function listResult(data) {
  return { data };
}

function collectSearchText(thread) {
  return (Array.isArray(thread?.turns) ? thread.turns : []).flatMap((turn) => Array.isArray(turn.items) ? turn.items : [])
    .map((item) => String(item.text || '')).join(' ');
}

function getThread(threadId) {
  return threads.get(threadId);
}

function getQueue(threadId) {
  if (!threadQueues.has(threadId)) threadQueues.set(threadId, []);
  return threadQueues.get(threadId);
}

rl.on('line', (line) => {
  const raw = line.trim();
  if (!raw) return;

  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  const { id, method, params = {} } = msg;

  switch (method) {
    case 'initialize':
      reply(id, {
        codexHome: process.env.CODEX_HOME || null,
        platformFamily: 'mock',
        platformOs: 'mock',
      });
      break;
    case 'initialized':
      break;
    case 'thread/start': {
      const thread = createThread();
      reply(id, { thread });
      notify('thread/started', { thread });
      break;
    }
    case 'thread/list': {
      const searchTerm = String(params.searchTerm || '').toLowerCase();
      const data = [...threads.values()].filter((thread) =>
        (params.archived === true ? thread.archived === true : thread.archived !== true)
        && (!searchTerm || `${thread.title} ${thread.preview}`.toLowerCase().includes(searchTerm)));
      reply(id, listResult(data));
      break;
    }
    case 'thread/resume': {
      const thread = getThread(params.threadId);
      if (!thread) { replyError(id, `线程不存在: ${params.threadId}`); break; }
      reply(id, { thread, model: config.model, modelProvider: config.model_provider, cwd: process.cwd() });
      break;
    }
    case 'thread/read': {
      const thread = getThread(params.threadId);
      if (!thread) { replyError(id, `线程不存在: ${params.threadId}`); break; }
      reply(id, { thread });
      break;
    }
    case 'thread/name/set': {
      const thread = getThread(params.threadId);
      if (!thread) { replyError(id, `线程不存在: ${params.threadId}`); break; }
      thread.title = String(params.name || thread.title);
      thread.updatedAt = now();
      saveState();
      reply(id, { thread });
      break;
    }
    case 'thread/fork': {
      const source = getThread(params.threadId);
      if (!source) { replyError(id, `线程不存在: ${params.threadId}`); break; }
      const thread = createThread();
      thread.title = `${source.title} (fork)`;
      thread.turns = structuredClone(source.turns);
      saveState();
      reply(id, { thread });
      notify('thread/started', { thread });
      break;
    }
    case 'thread/archive': {
      const thread = getThread(params.threadId);
      if (!thread) { replyError(id, `线程不存在: ${params.threadId}`); break; }
      thread.archived = true;
      thread.status = 'archived';
      saveState();
      reply(id, { thread });
      break;
    }
    case 'thread/delete':
      threads.delete(params.threadId);
      saveState();
      reply(id, { ok: true });
      break;
    case 'thread/unarchive': {
      const thread = getThread(params.threadId);
      if (!thread) { replyError(id, `线程不存在: ${params.threadId}`); break; }
      thread.archived = false;
      thread.status = 'idle';
      saveState();
      reply(id, { thread });
      break;
    }
    case 'thread/revert': {
      const thread = getThread(params.threadId);
      if (!thread) { replyError(id, `线程不存在: ${params.threadId}`); break; }
      const index = params.beforeTurnId ? thread.turns.findIndex((turn) => turn.id === params.beforeTurnId) : Number(params.toTurnIndex ?? params.toTurnId);
      if (Number.isInteger(index) && index >= 0) thread.turns = thread.turns.slice(0, index);
      thread.status = 'idle';
      saveState();
      reply(id, { thread: { ...thread, turns: [] }, turnsBackwardsCursor: null, itemsBackwardsCursor: null });
      break;
    }
    case 'thread/inject_items': {
      const thread = getThread(params.threadId);
      if (!thread) { replyError(id, `线程不存在: ${params.threadId}`); break; }
      const items = Array.isArray(params.items) ? params.items : [];
      for (const item of items) {
        const role = item.role === 'assistant' || item.role === 'agent' ? 'agent' : 'user';
        const text = (item.content || []).map((part) => part.text || '').join('\n') || String(item.text || '');
        if (!text.trim()) continue;
        thread.turns.push({
          id: `mock-turn-${turnSeq++}`,
          status: 'completed',
          items: [{
            id: `mock-item-${turnSeq}`,
            type: role === 'user' ? 'userMessage' : 'agentMessage',
            text,
            content: [{ type: 'text', text }],
            status: 'completed',
          }],
        });
        thread.preview = text;
      }
      thread.updatedAt = now();
      saveState();
      reply(id, {});
      break;
    }
    case 'thread/search': {
      const searchTerm = String(params.searchTerm || '').toLowerCase();
      const data = [...threads.values()]
        .filter((thread) => (params.archived === true ? thread.archived === true : thread.archived !== true)
          && (!searchTerm || `${thread.title} ${thread.preview} ${collectSearchText(thread)}`.toLowerCase().includes(searchTerm)))
        .map((thread) => ({ thread, snippet: thread.preview || thread.title || '' }));
      reply(id, listResult(data));
      break;
    }
    case 'thread/compact/start': {
      const thread = getThread(params.threadId);
      if (!thread) { replyError(id, `线程不存在: ${params.threadId}`); break; }
      thread.preview = '[compacted]';
      thread.updatedAt = now();
      saveState();
      reply(id, { ok: true });
      break;
    }
    case 'thread/goal/set': {
      const thread = getThread(params.threadId);
      if (!thread) { replyError(id, `线程不存在: ${params.threadId}`); break; }
      thread.goal = { objective: String(params.objective || ''), status: params.status || 'active' };
      saveState();
      reply(id, { goal: thread.goal });
      break;
    }
    case 'thread/goal/clear': {
      const thread = getThread(params.threadId);
      if (!thread) { replyError(id, `线程不存在: ${params.threadId}`); break; }
      thread.goal = null;
      saveState();
      reply(id, {});
      break;
    }
    case 'thread/rollback': {
      const thread = getThread(params.threadId);
      if (!thread) { replyError(id, `线程不存在: ${params.threadId}`); break; }
      const count = Math.max(0, Number(params.numTurns) || 0);
      if (count > 0) thread.turns = thread.turns.slice(0, Math.max(0, thread.turns.length - count));
      thread.status = 'idle';
      saveState();
      reply(id, { thread });
      break;
    }
    case 'threadSection/list':
      reply(id, listResult(sections));
      break;
    case 'threadSection/create': {
      const section = { id: `mock-section-${sectionSeq++}`, name: String(params.name || '未命名分区') };
      sections.push(section);
      saveState();
      reply(id, { section });
      break;
    }
    case 'thread/section/move': {
      const thread = getThread(params.threadId);
      if (!thread) { replyError(id, `线程不存在: ${params.threadId}`); break; }
      thread.section = sections.find((section) => section.id === params.sectionId) || null;
      saveState();
      reply(id, { thread });
      break;
    }
    case 'turn/start': {
      const thread = getThread(params.threadId) || createThread();
      const turn = {
        id: `mock-turn-${turnSeq++}`,
        status: 'inProgress',
        startedAt: now(),
        items: [],
      };
      const text = params.text || (params.input || [])
        .filter((item) => item.type === 'text')
        .map((item) => item.text || '')
        .join(' ');
      turn.items.push({
        id: `mock-user-${turn.id}`,
        type: 'userMessage',
        content: [{ type: 'text', text }],
        status: 'completed',
      });
      if (params.model) {
        turn.model = String(params.model);
        thread.model = String(params.model);
      }
      thread.turns.push(turn);
      thread.status = 'running';
      thread.updatedAt = now();
      saveState();
      reply(id, { turn });
      notify('turn/started', { threadId: thread.id, turn: { id: turn.id, status: 'inProgress', model: turn.model || null } });
      if (/修改|文件|diff|test/i.test(text)) {
        const fileItem = { id: `mock-file-${turn.id}`, type: 'fileChange', status: 'completed', changes: [{ path: 'src/example.ts', diff: '+export const ready = true;' }] };
        turn.items.push(fileItem);
        notify('item/started', { threadId: thread.id, turnId: turn.id, item: fileItem });
        notify('item/completed', { threadId: thread.id, turnId: turn.id, item: fileItem });
      }
      const replyText = turn.model
        ? `收到：「${text}」。模型 ${turn.model}。这是 mock 回复，用于验证线程、配置和流式链路。`
        : `收到：「${text}」。这是 mock 回复，用于验证线程、配置和流式链路。`;
      streamAgentMessage(thread, turn, replyText);
      break;
    }
    case 'turn/steer':
      reply(id, { ok: true, turnId: params.expectedTurnId || null });
      break;
    case 'turn/interrupt': {
      const active = turnTimers.get(params.turnId);
      if (active) {
        clearInterval(active.timer);
        turnTimers.delete(params.turnId);
        const turn = active.thread.turns.find((entry) => entry.id === params.turnId);
        if (turn) turn.status = 'interrupted';
        active.thread.status = 'idle';
        saveState();
        notify('turn/completed', { threadId: params.threadId, turnId: params.turnId, turn: { id: params.turnId, status: 'interrupted' } });
      }
      reply(id, { ok: true });
      break;
    }
    case 'model/list':
      reply(id, listResult([
        { id: 'deepseek-chat', model: 'deepseek-chat', displayName: 'DeepSeek Chat', description: 'Mock Responses provider' },
        { id: 'deepseek-reasoner', model: 'deepseek-reasoner', displayName: 'DeepSeek Reasoner', description: 'Mock reasoning provider' },
      ]));
      break;
    case 'modelProvider/capabilities/read':
      reply(id, { responses: true, tools: true, images: true });
      break;
    case 'config/read':
      reply(id, { config: { ...config } });
      break;
    case 'config/value/write':
      setConfigPath(params.keyPath, params.value);
      saveState();
      reply(id, { ok: true, config: { ...config } });
      break;
    case 'config/batchWrite':
      for (const edit of params.edits || []) setConfigPath(edit.keyPath, edit.value);
      saveState();
      reply(id, { ok: true, config: { ...config } });
      break;
    case 'skills/extraRoots/set':
      config.skills_extra_roots = Array.isArray(params.extraRoots) ? params.extraRoots : [];
      saveState();
      reply(id, { ok: true, extraRoots: config.skills_extra_roots });
      break;
    case 'experimentalFeature/list':
      reply(id, listResult([
        { name: 'hooks', enabled: config.hooks_enabled !== false },
        { name: 'browser_use', enabled: config.mcp_servers?.browser?.enabled !== false },
        { name: 'computer_use', enabled: config.mcp_servers?.computer?.enabled !== false },
      ]));
      break;
    case 'experimentalFeature/enablement/set':
      for (const [name, enabled] of Object.entries(params.enablement || {})) {
        if (name === 'hooks') setConfigPath('hooks_enabled', Boolean(enabled));
        else if (name === 'browser_use') setConfigPath('mcp_servers.browser.enabled', Boolean(enabled));
        else if (name === 'computer_use') setConfigPath('mcp_servers.computer.enabled', Boolean(enabled));
      }
      saveState();
      reply(id, { ok: true });
      break;
    case 'windowsSandbox/readiness':
      reply(id, { ready: false, supported: false, mode: 'mock', error: 'Mock 引擎不提供 Windows 沙箱' });
      break;
    case 'windowsSandbox/setupStart':
      reply(id, { ok: false, started: false, mode: 'mock', error: 'Mock 引擎不提供 Windows 沙箱' });
      break;
    case 'skills/list':
      reply(id, listResult([{ cwd: process.cwd(), skills: [
        { name: 'local-coding', description: 'Mock 本地编码技能' },
      ] }]));
      break;
    case 'mcpServerStatus/list':
      reply(id, listResult([
        { name: 'mock-tools', runtimeStatus: 'connected', tools: {} },
        ...(config.mcp_servers?.browser?.enabled !== false ? [{ name: 'browser', runtimeStatus: 'connected', tools: { browser_open: { title: '打开网页', description: '打开指定 URL' } }, resources: [] }] : []),
        ...(config.mcp_servers?.computer?.enabled !== false ? [{ name: 'computer', runtimeStatus: 'connected', tools: { computer_action: { title: '电脑操作', description: '执行本机桌面操作' } }, resources: [] }] : []),
      ]));
      break;
    case 'config/mcpServer/reload':
      reply(id, {});
      break;
    case 'mcpServer/tool/call':
      reply(id, { content: [{ type: 'text', text: `mock ${params.server}/${params.tool}` }], structuredContent: { arguments: params.arguments || {} } });
      break;
    case 'mcpServer/resource/read':
      reply(id, { contents: [{ uri: params.uri, mimeType: 'text/plain', text: 'mock resource' }], originCallId: null });
      break;
    case 'permissionProfile/list':
      reply(id, listResult([
        { id: ':read-only', description: '只读' },
        { id: ':workspace', description: '工作区写' },
      ]));
      break;
    case 'hooks/list':
      reply(id, listResult([{ cwd: process.cwd(), hooks: [], warnings: [], errors: [] }]));
      break;
    case 'collaborationMode/list':
      reply(id, listResult([{ id: 'default', name: '默认协作模式' }]));
      break;
    case 'thread/settings/update': {
      const thread = getThread(params.threadId);
      if (!thread) { replyError(id, `线程不存在: ${params.threadId}`); break; }
      thread.settings = { ...(thread.settings || {}), ...params };
      reply(id, { thread });
      break;
    }
    case 'thread/timeline/list': {
      const thread = getThread(params.threadId);
      reply(id, listResult((thread?.turns || []).map((turn) => ({
        tag: 'turn',
        preview: turn.items?.find((item) => item.type === 'userMessage')?.content?.[0]?.text || turn.id,
      }))));
      break;
    }
    case 'thread/memoryMode/set':
      reply(id, { ok: true, mode: params.mode });
      break;
    case 'memory/reset':
      reply(id, { ok: true });
      break;
    case 'externalAgentConfig/detect':
      reply(id, { items: [] });
      break;
    case 'externalAgentConfig/import':
      reply(id, { imported: 0 });
      break;
    case 'thread/queue/add': {
      const queue = getQueue(params.threadId);
      const queuedSubmission = { id: `mock-queue-${Date.now()}-${queue.length}`, input: params.input || [], clientUserMessageId: params.clientUserMessageId };
      queue.push(queuedSubmission);
      reply(id, { queuedSubmission });
      notify('thread/queue/changed', { threadId: params.threadId });
      break;
    }
    case 'thread/queue/list':
      reply(id, { data: getQueue(params.threadId), nextCursor: null });
      break;
    case 'thread/queue/update': {
      const queue = getQueue(params.threadId);
      const item = queue.find((entry) => entry.id === params.queuedSubmissionId);
      if (item) item.input = params.input || [];
      reply(id, { queuedSubmission: item || null });
      notify('thread/queue/changed', { threadId: params.threadId });
      break;
    }
    case 'thread/queue/delete': {
      const queue = getQueue(params.threadId);
      const index = queue.findIndex((entry) => entry.id === params.queuedSubmissionId);
      if (index >= 0) queue.splice(index, 1);
      reply(id, { ok: true });
      notify('thread/queue/changed', { threadId: params.threadId });
      break;
    }
    case 'thread/queue/start': {
      const queue = getQueue(params.threadId);
      const index = params.queuedSubmissionId ? queue.findIndex((entry) => entry.id === params.queuedSubmissionId) : 0;
      const queuedSubmission = index >= 0 ? queue.splice(index, 1)[0] : null;
      reply(id, { queuedSubmission });
      notify('thread/queue/changed', { threadId: params.threadId });
      break;
    }
    case 'fs/readDirectory':
      reply(id, { entries: [{ name: 'renderer', type: 'directory' }, { name: 'package.json', type: 'file' }, { name: 'README-dev.md', type: 'file' }] });
      break;
    case 'fuzzyFileSearch':
      reply(id, { files: [{ root: process.cwd(), path: path.join(process.cwd(), 'package.json'), match_type: 'fileName', file_name: 'package.json', score: 1, indices: [0] }] });
      break;
    case 'command/exec':
      reply(id, { processId: params.processId || `mock-process-${Date.now()}`, output: `mock 执行完成: ${(params.command || []).join(' ')}`, exitCode: 0 });
      break;
    case 'review/start':
      reply(id, { review: { id: `mock-review-${Date.now()}`, status: 'completed' } });
      break;
    default:
      replyError(id, `未实现的方法: ${method}`);
  }
});

rl.on('close', () => process.exit(0));
