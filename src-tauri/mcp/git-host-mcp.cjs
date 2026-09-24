'use strict';

const fs = require('node:fs');
const gitlab = require('./gitlab.cjs');
const github = require('./github.cjs');

const hosts = { gitlab, github };
const MAX_TEXT = 60000;

function reply(id, result, error) {
  process.stdout.write(`${JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result })}\n`);
}

function textResult(value, extra = {}) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...extra };
}

function readContext() {
  const file = process.env.LOCAL_CODEX_GIT_HOST_CONTEXT || '';
  let saved = {};
  try { if (file && fs.existsSync(file)) saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { saved = {}; }
  return {
    cwd: String(saved.cwd || process.cwd()),
    gitlab: {
      enabled: saved.gitlab?.enabled === true,
      baseUrl: String(saved.gitlab?.baseUrl || '').trim(),
      token: String(saved.gitlab?.token || '').trim(),
    },
    github: {
      enabled: saved.github?.enabled === true,
      baseUrl: String(saved.github?.baseUrl || '').trim(),
      token: String(saved.github?.token || '').trim(),
    },
  };
}

function clip(value) {
  if (typeof value !== 'string') return value;
  if (value.length <= MAX_TEXT) return value;
  return `${value.slice(0, MAX_TEXT)}\n…[truncated ${value.length - MAX_TEXT} chars]`;
}

function publicStatus(status, provider = '') {
  if (!status) return null;
  return {
    provider: provider || (status.baseUrl && /github/i.test(status.baseUrl) ? 'github' : 'gitlab'),
    enabled: status.enabled === true,
    available: status.available === true,
    tokenConfigured: status.tokenConfigured === true,
    baseUrl: status.baseUrl || '',
    workspaceRoot: status.workspaceRoot || '',
    remoteUrl: status.remoteUrl || '',
    projectPath: status.projectPath || '',
    currentBranch: status.currentBranch || '',
    project: status.project ? {
      name: status.project.name,
      pathWithNamespace: status.project.pathWithNamespace,
      webUrl: status.project.webUrl,
      defaultBranch: status.project.defaultBranch,
    } : null,
    reason: status.reason || '',
  };
}

function compactPayload(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const next = { ...payload };
  if (next.status) next.status = publicStatus(next.status, next.provider);
  if (typeof next.diff === 'string') next.diff = clip(next.diff);
  if (next.file?.content) next.file = { ...next.file, content: clip(next.file.content) };
  if (Array.isArray(next.items) && next.items.length > 200) {
    next.truncated = true;
    next.total = next.total || next.items.length;
    next.items = next.items.slice(0, 200);
  }
  return next;
}

async function inspectProvider(provider) {
  const context = readContext();
  const host = hosts[provider];
  if (!host) throw new Error(`未知托管平台：${provider}`);
  return host.inspectWorkspace({ cwd: context.cwd, ...context[provider] });
}

async function resolveProvider(requested) {
  const wanted = String(requested || '').trim().toLowerCase();
  if (wanted === 'gitlab' || wanted === 'github') return wanted;
  const gitlabStatus = await inspectProvider('gitlab');
  if (gitlabStatus.available) return 'gitlab';
  const githubStatus = await inspectProvider('github');
  if (githubStatus.available) return 'github';
  throw new Error(gitlabStatus.reason || githubStatus.reason || '当前工作区未启用 GitLab 或 GitHub');
}

async function resolveAccountProvider(requested) {
  const wanted = String(requested || '').trim().toLowerCase();
  if (wanted === 'gitlab' || wanted === 'github') return wanted;
  const context = readContext();
  if (context.github.token) return 'github';
  if (context.gitlab.token) return 'gitlab';
  return resolveProvider(requested);
}

async function load(provider, resource, query = {}) {
  const context = readContext();
  const host = hosts[provider];
  const result = await host.loadResource({ cwd: context.cwd, ...context[provider], resource, query });
  return compactPayload({ provider, ...result });
}

const providerProp = { type: 'string', enum: ['gitlab', 'github'], description: '省略时按当前工作区远程自动选择' };
const iidProp = { type: 'integer', minimum: 1, description: 'GitLab 合并请求 IID 或 GitHub Pull Request 编号' };

const resources = [
  { uri: 'git-host://status', name: 'git_status', description: '当前工作区 GitLab/GitHub 集成状态。也可用工具 git_status。', mimeType: 'application/json' },
  { uri: 'git-host://merge-requests', name: 'git_merge_requests', description: '当前仓库的合并请求/PR 列表。也可用工具 git_merge_requests。', mimeType: 'application/json' },
  { uri: 'git-host://graph', name: 'git_graph', description: '本地仓库图。也可用工具 git_graph。', mimeType: 'application/json' },
  { uri: 'git-host://branches', name: 'git_branches', description: '远程分支列表。也可用工具 git_branches。', mimeType: 'application/json' },
  { uri: 'git-host://commits', name: 'git_commits', description: '提交列表。也可用工具 git_commits。', mimeType: 'application/json' },
  { uri: 'git-host://tools', name: 'git_host_tools', description: 'git-host 可用工具名。查询合并请求请直接调用 git_merge_requests，不要改走 REST。', mimeType: 'application/json' },
];

const resourceTemplates = [
  { uriTemplate: 'git-host://merge-request/{iid}', name: 'git_merge_request', description: '单个合并请求/PR 详情。也可用工具 git_merge_request。', mimeType: 'application/json' },
  { uriTemplate: 'git-host://commit/{sha}', name: 'git_commit_diff', description: '单个提交 diff。也可用工具 git_commit_diff。', mimeType: 'application/json' },
];

async function statusPayload() {
  const context = readContext();
  const [gitlabStatus, githubStatus] = await Promise.all([inspectProvider('gitlab'), inspectProvider('github')]);
  return {
    cwd: context.cwd,
    tools: tools.map((item) => item.name),
    gitlab: publicStatus(gitlabStatus, 'gitlab'),
    github: publicStatus(githubStatus, 'github'),
  };
}

async function readResource(uri) {
  const raw = String(uri || '').trim();
  const value = raw.replace(/^git-host:\/\//i, '');
  if (value === 'tools') return { tools: tools.map((item) => item.name), resources: resources.map((item) => item.uri) };
  if (value === 'status') return statusPayload();
  if (value === 'merge-requests' || value.startsWith('merge-requests?')) {
    const state = new URL(`git-host://${value}`).searchParams.get('state') || undefined;
    return load(await resolveProvider(), 'mergeRequests', { state });
  }
  const mergeRequest = value.match(/^merge-request\/(\d+)/);
  if (mergeRequest) {
    const iid = Number(mergeRequest[1]);
    const result = await load(await resolveProvider(), 'mergeRequest', { iid });
    Object.assign(result, await load(result.provider, 'mergeRequestNotes', { iid }).then((item) => ({ notes: item.items })).catch((error) => ({ notesError: error.message })));
    Object.assign(result, await load(result.provider, 'mergeRequestCommits', { iid }).then((item) => ({ commits: item.items })).catch((error) => ({ commitsError: error.message })));
    Object.assign(result, await load(result.provider, 'mergeRequestPipelines', { iid }).then((item) => ({ pipelines: item.items })).catch((error) => ({ pipelinesError: error.message })));
    return result;
  }
  if (value === 'graph') return load(await resolveProvider(), 'graph', { limit: 200 });
  if (value === 'branches') return load(await resolveProvider(), 'branches', {});
  if (value === 'commits' || value.startsWith('commits?')) {
    const ref = new URL(`git-host://${value}`).searchParams.get('ref') || undefined;
    return load(await resolveProvider(), 'commits', { ref });
  }
  const commit = value.match(/^commit\/([0-9a-fA-F]+)/);
  if (commit) return load(await resolveProvider(), 'commitDiff', { sha: commit[1] });
  throw new Error(`未知资源：${raw}`);
}

function resourceResult(uri, payload) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  return { contents: [{ uri, mimeType: 'application/json', text }] };
}

const tools = [
  {
    name: 'git_status',
    description: '查看当前工作区的 GitLab/GitHub 集成状态，包括是否可用、当前分支、项目路径和未配置原因。对话应先调用此工具再访问合并请求或仓库数据。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'git_merge_requests',
    description: '列出当前仓库的 GitLab 合并请求或 GitHub Pull Request。',
    inputSchema: { type: 'object', properties: { provider: providerProp, state: { type: 'string', description: '例如 opened、closed、merged、all' }, perPage: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
  },
  {
    name: 'git_merge_request',
    description: '读取单个合并请求/PR 的详情，可附带讨论、提交、流水线和文件变更。',
    inputSchema: {
      type: 'object',
      properties: {
        provider: providerProp,
        iid: iidProp,
        include: { type: 'array', items: { type: 'string', enum: ['notes', 'commits', 'pipelines', 'diffs'] }, description: '默认包含 notes、commits、pipelines；diffs 较大需显式请求' },
      },
      required: ['iid'],
      additionalProperties: false,
    },
  },
  {
    name: 'git_branches',
    description: '列出当前仓库的远程分支。',
    inputSchema: { type: 'object', properties: { provider: providerProp, perPage: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
  },
  {
    name: 'git_commits',
    description: '列出指定引用上的提交。',
    inputSchema: { type: 'object', properties: { provider: providerProp, ref: { type: 'string' }, perPage: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
  },
  {
    name: 'git_commit_diff',
    description: '读取某个提交的说明和 unified diff。',
    inputSchema: { type: 'object', properties: { provider: providerProp, sha: { type: 'string' } }, required: ['sha'], additionalProperties: false },
  },
  {
    name: 'git_graph',
    description: '读取本地仓库图（全部分支拓扑），无需 Token。',
    inputSchema: { type: 'object', properties: { provider: providerProp, limit: { type: 'integer', minimum: 20, maximum: 1000 } }, additionalProperties: false },
  },
  {
    name: 'git_tags',
    description: '列出当前仓库的标签。',
    inputSchema: { type: 'object', properties: { provider: providerProp, perPage: { type: 'integer', minimum: 1, maximum: 100 } }, additionalProperties: false },
  },
  {
    name: 'git_tree',
    description: '列出仓库某个路径下的文件和目录。',
    inputSchema: { type: 'object', properties: { provider: providerProp, path: { type: 'string' }, ref: { type: 'string' } }, additionalProperties: false },
  },
  {
    name: 'git_file',
    description: '读取仓库中某个文件的内容。大文件会被截断。',
    inputSchema: { type: 'object', properties: { provider: providerProp, path: { type: 'string' }, ref: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'git_blame',
    description: '读取某个文件的 Blame。',
    inputSchema: { type: 'object', properties: { provider: providerProp, path: { type: 'string' }, ref: { type: 'string' } }, required: ['path'], additionalProperties: false },
  },
  {
    name: 'git_create_merge_request',
    description: '创建 GitLab 合并请求或 GitHub Pull Request。',
    inputSchema: {
      type: 'object',
      properties: {
        provider: providerProp,
        title: { type: 'string' },
        sourceBranch: { type: 'string' },
        targetBranch: { type: 'string' },
        description: { type: 'string' },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'git_create_note',
    description: '在合并请求或 PR 上发表评论。',
    inputSchema: {
      type: 'object',
      properties: {
        provider: providerProp,
        iid: iidProp,
        body: { type: 'string' },
      },
      required: ['iid', 'body'],
      additionalProperties: false,
    },
  },
  {
    name: 'git_create_review_comment',
    description: '在合并请求或 PR 的 diff 行上发表审查评论。',
    inputSchema: {
      type: 'object',
      properties: {
        provider: providerProp,
        iid: iidProp,
        body: { type: 'string' },
        path: { type: 'string' },
        oldPath: { type: 'string' },
        newLine: { type: 'integer' },
        oldLine: { type: 'integer' },
        sha: { type: 'string' },
        baseSha: { type: 'string' },
        startSha: { type: 'string' },
        headSha: { type: 'string' },
      },
      required: ['iid', 'body', 'path'],
      additionalProperties: false,
    },
  },
  {
    name: 'git_approve_merge_request',
    description: '批准 GitLab 合并请求或 GitHub Pull Request。',
    inputSchema: {
      type: 'object',
      properties: { provider: providerProp, iid: iidProp, body: { type: 'string' } },
      required: ['iid'],
      additionalProperties: false,
    },
  },
  {
    name: 'git_create_branch',
    description: '在托管平台创建远程分支。',
    inputSchema: {
      type: 'object',
      properties: { provider: providerProp, name: { type: 'string' }, ref: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'git_check_repository',
    description: '只读检查托管平台上的仓库是否已存在，以及当前 Token 能否创建它。不创建仓库。建仓前必须先调用此工具。',
    inputSchema: {
      type: 'object',
      properties: {
        provider: providerProp,
        name: { type: 'string', description: '仓库名，或 owner/name' },
        owner: { type: 'string', description: '用户或组织；省略则用当前登录用户' },
        private: { type: 'boolean' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'git_create_repository',
    description: '通过 GitHub/GitLab REST API 创建仓库。会先做只读检查；仓库已存在时不会重复创建。',
    inputSchema: {
      type: 'object',
      properties: {
        provider: providerProp,
        name: { type: 'string', description: '仓库名，或 owner/name' },
        owner: { type: 'string' },
        description: { type: 'string' },
        private: { type: 'boolean' },
        autoInit: { type: 'boolean', description: '是否用 README 初始化' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
];

async function callTool(name, args = {}) {
  if (name === 'git_status') return textResult(await statusPayload());
  if (name === 'git_check_repository' || name === 'git_create_repository') {
    const provider = await resolveAccountProvider(args.provider);
    const context = readContext();
    const host = hosts[provider];
    const result = name === 'git_check_repository'
      ? await host.checkRepository({ ...context[provider], query: args })
      : await host.createRepository({ ...context[provider], query: args });
    return textResult(compactPayload({ provider, ...result }));
  }

  const provider = await resolveProvider(args.provider);
  if (name === 'git_merge_requests') return textResult(await load(provider, 'mergeRequests', { state: args.state, perPage: args.perPage }));
  if (name === 'git_merge_request') {
    const include = Array.isArray(args.include) && args.include.length ? args.include : ['notes', 'commits', 'pipelines'];
    const wanted = new Set(include);
    const result = await load(provider, 'mergeRequest', { iid: args.iid });
    if (wanted.has('notes')) Object.assign(result, await load(provider, 'mergeRequestNotes', { iid: args.iid }).then((item) => ({ notes: item.items })).catch((error) => ({ notesError: error.message })));
    if (wanted.has('commits')) Object.assign(result, await load(provider, 'mergeRequestCommits', { iid: args.iid }).then((item) => ({ commits: item.items })).catch((error) => ({ commitsError: error.message })));
    if (wanted.has('pipelines')) Object.assign(result, await load(provider, 'mergeRequestPipelines', { iid: args.iid }).then((item) => ({ pipelines: item.items })).catch((error) => ({ pipelinesError: error.message })));
    if (wanted.has('diffs')) Object.assign(result, await load(provider, 'mergeRequestDiffs', { iid: args.iid }).then((item) => ({ diff: clip(item.diff || '') })).catch((error) => ({ diffsError: error.message })));
    return textResult(result);
  }
  if (name === 'git_branches') return textResult(await load(provider, 'branches', { perPage: args.perPage }));
  if (name === 'git_commits') return textResult(await load(provider, 'commits', { ref: args.ref, perPage: args.perPage }));
  if (name === 'git_commit_diff') return textResult(await load(provider, 'commitDiff', { sha: args.sha }));
  if (name === 'git_graph') return textResult(await load(provider, 'graph', { limit: args.limit || 200 }));
  if (name === 'git_tags') return textResult(await load(provider, 'tags', { perPage: args.perPage }));
  if (name === 'git_tree') return textResult(await load(provider, 'tree', { path: args.path, ref: args.ref }));
  if (name === 'git_file') return textResult(await load(provider, 'file', { path: args.path, ref: args.ref }));
  if (name === 'git_blame') return textResult(await load(provider, 'blame', { path: args.path, ref: args.ref }));
  if (name === 'git_create_merge_request' || name === 'git_create_note' || name === 'git_create_review_comment' || name === 'git_approve_merge_request' || name === 'git_create_branch') {
    const context = readContext();
    const host = hosts[provider];
    const action = name === 'git_create_merge_request' ? 'createMergeRequest'
      : name === 'git_create_review_comment' ? 'createReviewComment'
      : name === 'git_approve_merge_request' ? 'approveMergeRequest'
      : name === 'git_create_branch' ? 'createBranch'
      : 'createNote';
    const result = await host.writeResource({
      cwd: context.cwd,
      ...context[provider],
      action,
      query: {
        ...args,
        diffRefs: args.diffRefs || { baseSha: args.baseSha, startSha: args.startSha, headSha: args.headSha || args.sha },
      },
    });
    return textResult(compactPayload({ provider, ...result }));
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
    if (message.method === 'initialize') reply(message.id, { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: { listChanged: false }, resources: { listChanged: false } }, serverInfo: { name: 'local-codex-git-host', version: '0.1.0' }, instructions: '查询合并请求或 PR 时调用工具 git_status、git_merge_requests，或读取资源 git-host://merge-requests。不要用 GitHub/GitLab REST、curl、git、gh、glab 代替。' });
    else if (message.method === 'tools/list') reply(message.id, { tools });
    else if (message.method === 'resources/list') reply(message.id, { resources });
    else if (message.method === 'resources/templates/list') reply(message.id, { resourceTemplates });
    else if (message.method === 'resources/read') readResource(message.params?.uri).then((payload) => reply(message.id, resourceResult(String(message.params?.uri || ''), payload))).catch((error) => reply(message.id, null, { code: -32000, message: error.message }));
    else if (message.method === 'ping') reply(message.id, {});
    else if (message.method === 'tools/call') callTool(String(message.params?.name || ''), message.params?.arguments || {}).then((result) => reply(message.id, result)).catch((error) => reply(message.id, textResult(error.message, { isError: true })));
    else reply(message.id, null, { code: -32601, message: `Method not found: ${message.method}` });
  }
});
