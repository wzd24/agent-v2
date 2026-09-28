'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SECRET_NAME = 'GITHUB_PERSONAL_TOKEN';
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_MIME = new Map([
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
]);

function trimText(value) {
  return String(value || '').trim();
}

function normalizeHost(value) {
  const raw = trimText(value);
  if (!raw) return '';
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    let host = url.host.toLowerCase();
    if (url.protocol === 'http:' && host.endsWith(':80')) host = host.slice(0, -3);
    if (url.protocol === 'https:' && host.endsWith(':443')) host = host.slice(0, -4);
    if (host === 'www.github.com' || host === 'api.github.com') return 'github.com';
    return host;
  } catch {
    return raw.replace(/^git@/i, '').replace(/\/.*$/, '').replace(/:\d+$/, '').toLowerCase();
  }
}

function parseGitRemote(remote) {
  const value = trimText(remote);
  if (!value) return null;
  let match = value.match(/^git@([^:]+):(.+)$/i);
  if (match) {
    return {
      url: value,
      host: match[1].toLowerCase(),
      projectPath: match[2].replace(/\.git$/i, '').replace(/^\/+/, '').replace(/\/+$/, ''),
    };
  }
  match = value.match(/^ssh:\/\/(?:git@)?([^/]+)\/(.+)$/i);
  if (match) {
    return {
      url: value,
      host: match[1].replace(/:\d+$/, '').toLowerCase(),
      projectPath: match[2].replace(/\.git$/i, '').replace(/^\/+/, '').replace(/\/+$/, ''),
    };
  }
  try {
    const url = new URL(value);
    return {
      url: value,
      host: url.host.toLowerCase(),
      projectPath: url.pathname.replace(/\.git$/i, '').replace(/^\/+/, '').replace(/\/+$/, ''),
    };
  } catch {
    return null;
  }
}

function runGit(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }).trim();
  } catch {
    return '';
  }
}

function readRemotes(cwd) {
  const output = runGit(cwd, ['remote', '-v']);
  if (!output) return [];
  const seen = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!match) continue;
    const parsed = parseGitRemote(match[2]);
    if (!parsed || !parsed.projectPath) continue;
    const key = `${match[1]}:${parsed.url}`;
    if (seen.has(key)) continue;
    seen.set(key, { name: match[1], ...parsed });
  }
  return [...seen.values()].sort((a, b) => Number(b.name === 'origin') - Number(a.name === 'origin'));
}

function currentBranch(cwd) {
  const branch = runGit(cwd, ['branch', '--show-current']) || runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']) || '';
  return branch === 'HEAD' ? '' : branch;
}

function apiRoot(baseUrl) {
  const host = normalizeHost(baseUrl);
  if (!host) throw new Error('GitHub 服务器地址不能为空');
  if (host === 'github.com') return 'https://api.github.com';
  return `${trimText(baseUrl).replace(/\/+$/, '')}/api/v3`;
}

function repoApiPath(projectPath) {
  const parts = String(projectPath || '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('GitHub 仓库路径无效');
  return `repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

function apiUrl(root, apiPath, query = {}) {
  const base = trimText(root).replace(/\/+$/, '');
  const pathname = `/${String(apiPath || '').replace(/^\/+/, '')}`;
  const url = new URL(base + pathname);
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function nextPageFromLink(header) {
  const match = String(header || '').match(/<([^>]+)>;\s*rel="next"/i);
  if (!match) return '';
  try {
    return new URL(match[1]).searchParams.get('page') || '';
  } catch {
    return '';
  }
}

function errorMessage(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  if (error.message) return String(error.message);
  return String(error);
}

async function request({
  baseUrl,
  token,
  method = 'GET',
  apiPath,
  query,
  body,
  accept = 'application/vnd.github+json',
  timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
  if (!trimText(token)) throw new Error('未配置 GitHub 个人 Token');
  const url = apiUrl(apiRoot(baseUrl), apiPath, query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        'User-Agent': 'Local-Codex',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = text;
    const wantsJson = /json/i.test(accept);
    if (wantsJson && text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    const headers = {
      scopes: response.headers.get('x-oauth-scopes') || '',
      acceptedScopes: response.headers.get('x-accepted-oauth-scopes') || '',
    };
    if (!response.ok) {
      const message = data && typeof data === 'object'
        ? (data.message || data.error || JSON.stringify(data))
        : (text || `HTTP ${response.status}`);
      const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
      error.status = response.status;
      error.headers = headers;
      throw error;
    }
    return {
      data,
      headers,
      page: Number(url.searchParams.get('page') || 1) || 1,
      nextPage: nextPageFromLink(response.headers.get('link')),
    };
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('GitHub 请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function asList(data) {
  return Array.isArray(data) ? data : [];
}

function mapProject(repo, fallbackPath) {
  return {
    id: repo.id,
    name: repo.full_name || repo.name || fallbackPath,
    description: repo.description || '',
    webUrl: repo.html_url || '',
    defaultBranch: repo.default_branch || '',
    visibility: repo.private ? 'private' : (repo.visibility || 'public'),
    pathWithNamespace: repo.full_name || fallbackPath,
    lastActivityAt: repo.pushed_at || repo.updated_at || '',
    httpUrl: repo.clone_url || '',
    sshUrl: repo.ssh_url || '',
  };
}

function isManagedGithubRepo(repo) {
  const permissions = repo?.permissions || {};
  return Boolean(permissions.admin || permissions.maintain);
}

function mapPullRequest(item) {
  const merged = Boolean(item.merged_at || item.merged);
  const state = merged ? 'merged' : (item.state === 'open' ? 'opened' : (item.state || ''));
  return {
    iid: item.number,
    title: item.title || '',
    description: item.body || '',
    state,
    draft: Boolean(item.draft),
    sourceBranch: item.head?.ref || '',
    targetBranch: item.base?.ref || '',
    author: item.user?.login || item.user?.name || '',
    createdAt: item.created_at || '',
    updatedAt: item.updated_at || '',
    mergedAt: item.merged_at || '',
    mergedBy: item.merged_by?.login || item.merged_by?.name || '',
    mergeCommitSha: item.merge_commit_sha || '',
    sha: item.head?.sha || '',
    webUrl: item.html_url || '',
    labels: asList(item.labels).map((label) => (typeof label === 'string' ? label : label.name)).filter(Boolean),
    assignees: asList(item.assignees).map((user) => user.login || user.name).filter(Boolean),
    reviewers: asList(item.requested_reviewers).map((user) => user.login || user.name).filter(Boolean),
    changesCount: Number(item.changed_files || 0) || 0,
    userNotesCount: (Number(item.comments || 0) || 0) + (Number(item.review_comments || 0) || 0),
    mergeStatus: item.mergeable_state || '',
    diffRefs: {
      baseSha: item.base?.sha || '',
      startSha: item.base?.sha || '',
      headSha: item.head?.sha || item.merge_commit_sha || '',
    },
  };
}

function filesToUnified(files) {
  return asList(files).map((item) => {
    const oldPath = item.previous_filename || item.filename || 'file';
    const newPath = item.filename || oldPath;
    const body = String(item.patch || '');
    if (body.startsWith('diff --git ')) return body;
    const header = `diff --git a/${oldPath} b/${newPath}`;
    if (!body) {
      if (item.status === 'removed') return `${header}\ndeleted file mode 100644\n--- a/${oldPath}\n+++ /dev/null\n`;
      if (item.status === 'added') return `${header}\nnew file mode 100644\n--- /dev/null\n+++ b/${newPath}\n`;
      return `${header}\n--- a/${oldPath}\n+++ b/${newPath}\n`;
    }
    return `${header}\n--- a/${oldPath}\n+++ b/${newPath}\n${body}`;
  }).join('\n');
}

function localMergeDiff(cwd, source, target) {
  if (!source || !target) return '';
  const buffer = readGitBuffer(cwd, ['diff', `${target}...${source}`]);
  return buffer ? buffer.toString('utf8') : '';
}

function localMergeCommits(cwd, source, target) {
  if (!source || !target) return [];
  const output = runGit(cwd, ['log', '--format=%H%x09%h%x09%s%x09%an%x09%aI', `${target}..${source}`]);
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, shortId, title, authorName, authoredDate] = line.split('\t');
    return { id, shortId, title, authorName, authoredDate, createdAt: authoredDate, webUrl: '' };
  });
}

function localCommitDiff(cwd, sha) {
  const spec = trimText(sha) || 'HEAD';
  const meta = runGit(cwd, ['log', '-1', '--format=%H%x09%h%x09%s%x09%an%x09%aI%x09%P', spec]);
  if (!meta) return { commit: null, diff: '' };
  const [id, shortId, title, authorName, authoredDate, parents] = meta.split('\t');
  const buffer = readGitBuffer(cwd, ['show', '--format=', '--find-renames', id || spec]);
  return {
    commit: {
      id,
      shortId,
      title,
      message: title,
      authorName,
      authoredDate,
      createdAt: authoredDate,
      parentIds: String(parents || '').trim().split(/\s+/).filter(Boolean),
      webUrl: '',
      stats: { additions: 0, deletions: 0 },
    },
    diff: buffer ? buffer.toString('utf8') : '',
  };
}

function parseGraphRefs(raw) {
  const refs = String(raw || '').split(',').map((part) => part.trim()).filter(Boolean).flatMap((part) => {
    if (part.startsWith('HEAD -> ')) return [part.slice(8)];
    if (part === 'HEAD' || part.startsWith('refs/')) return [];
    if (part.startsWith('tag: ')) return [`tag:${part.slice(5)}`];
    return [part];
  });
  return [...new Set(refs)];
}

function localGraph(cwd, limit = 1000) {
  const count = Math.min(5000, Math.max(50, Number(limit) || 1000));
  let output = '';
  try {
    output = execFileSync('git', ['log', '--all', '--topo-order', `-n${count}`, '--pretty=format:%H%x09%P%x09%h%x09%s%x09%an%x09%aI%x09%D'], {
      cwd,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }).trim();
  } catch (error) {
    const detail = String((error && (error.stderr || error.message)) || error).trim();
    throw new Error(detail ? `无法读取仓库图：${detail}` : '无法读取仓库图');
  }
  const items = output ? output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, parents, shortId, title, authorName, authoredDate, deco] = line.split('\t');
    return {
      id,
      shortId,
      title,
      authorName,
      authoredDate,
      createdAt: authoredDate,
      parentIds: String(parents || '').trim().split(/\s+/).filter(Boolean),
      refs: parseGraphRefs(deco),
      webUrl: '',
    };
  }) : [];
  const total = Number(runGit(cwd, ['rev-list', '--count', '--all'])) || items.length;
  const shallow = runGit(cwd, ['rev-parse', '--is-shallow-repository']) === 'true';
  return { items, total, hasMore: total > items.length, shallow };
}

async function inspectWorkspace(options = {}) {
  if (Array.isArray(options.connections) && options.connections.length) {
    return inspectWithConnections(options);
  }
  return inspectSingleWorkspace(options);
}

async function inspectWithConnections({ cwd, connections, enabled }) {
  const remotes = readRemotes(cwd);
  const listed = connections.map((item) => ({
    id: String(item.id || ''),
    name: String(item.name || item.baseUrl || 'GitHub'),
    baseUrl: trimText(item.baseUrl),
    enabled: item.enabled !== false,
    tokenConfigured: Boolean(trimText(item.token)),
  }));
  const usable = connections.filter((item) => item.enabled !== false && trimText(item.baseUrl));
  const matched = usable.find((item) => remotes.some((remote) => normalizeHost(remote.host) === normalizeHost(item.baseUrl)));
  const chosen = matched || usable[0];
  const featureOn = enabled !== false && usable.length > 0;
  if (!chosen) {
    return {
      enabled: false,
      available: false,
      configured: false,
      tokenConfigured: false,
      baseUrl: '',
      workspaceRoot: cwd,
      remoteUrl: remotes[0]?.url || '',
      remoteName: remotes[0]?.name || '',
      projectPath: remotes[0]?.projectPath || '',
      currentBranch: currentBranch(cwd),
      project: null,
      reason: 'GitHub 全局开关未开启',
      connections: listed,
      connectionId: '',
    };
  }
  const status = await inspectSingleWorkspace({
    cwd,
    enabled: featureOn,
    baseUrl: chosen.baseUrl,
    token: chosen.token,
  });
  status.connections = listed;
  status.connectionId = chosen.id || '';
  status.configured = usable.some((item) => trimText(item.baseUrl) && trimText(item.token));
  return status;
}

async function inspectSingleWorkspace({ cwd, enabled, baseUrl, token }) {
  const remotes = readRemotes(cwd);
  const host = normalizeHost(baseUrl);
  const matched = host ? remotes.find((remote) => normalizeHost(remote.host) === host) : null;
  const status = {
    enabled: enabled === true,
    available: false,
    configured: Boolean(trimText(baseUrl) && trimText(token)),
    tokenConfigured: Boolean(trimText(token)),
    baseUrl: trimText(baseUrl),
    workspaceRoot: cwd,
    remoteUrl: matched?.url || remotes[0]?.url || '',
    remoteName: matched?.name || remotes[0]?.name || '',
    projectPath: matched?.projectPath || '',
    currentBranch: currentBranch(cwd),
    project: null,
    reason: '',
  };
  if (!status.enabled) {
    status.reason = 'GitHub 全局开关未开启';
    return status;
  }
  if (!status.baseUrl) {
    status.reason = '未配置 GitHub 服务器地址';
    return status;
  }
  if (!matched) {
    status.reason = remotes.length
      ? `当前工作区未托管在 ${host}`
      : '当前工作区没有 Git 远程仓库';
    return status;
  }
  status.available = true;
  if (!status.tokenConfigured) {
    status.reason = '未配置 GitHub 个人 Token';
    return status;
  }
  try {
    const result = await request({
      baseUrl,
      token,
      apiPath: repoApiPath(matched.projectPath),
    });
    status.project = mapProject(result.data || {}, matched.projectPath);
    status.reason = '';
  } catch (error) {
    status.reason = `已识别 GitHub 仓库，但读取项目失败：${errorMessage(error)}`;
  }
  return status;
}

async function loadPaged({ baseUrl, token, apiPath, query = {}, limit = 400 }) {
  let page = 1;
  let items = [];
  while (page && items.length < limit) {
    const result = await request({
      baseUrl,
      token,
      apiPath,
      query: { ...query, page, per_page: 100 },
    });
    items = items.concat(asList(result.data));
    page = result.nextPage ? Number(result.nextPage) : 0;
  }
  return items;
}

async function listManagedProjects({ baseUrl, token, search = '', limit = 200 } = {}) {
  if (!trimText(baseUrl)) throw new Error('未配置 GitHub 服务器地址');
  if (!trimText(token)) throw new Error('未配置 GitHub 个人 Token');
  const items = await loadPaged({
    baseUrl,
    token,
    apiPath: 'user/repos',
    query: {
      affiliation: 'owner,collaborator,organization_member',
      sort: 'updated',
      direction: 'desc',
    },
    limit: Math.max(Number(limit) || 200, 300),
  });
  const needle = trimText(search).toLowerCase();
  return items.filter((repo) => isManagedGithubRepo(repo)).filter((repo) => {
    if (!needle) return true;
    return `${repo.full_name || ''} ${repo.description || ''}`.toLowerCase().includes(needle);
  }).slice(0, Math.max(1, Number(limit) || 200)).map((repo) => mapProject(repo, repo.full_name));
}

function candidateRefs(status, query = {}) {
  const requested = trimText(query.ref);
  const defaultBranch = trimText(status.project && status.project.defaultBranch);
  const current = trimText(status.currentBranch);
  const refs = [];
  const add = (value) => {
    if (value && !refs.includes(value)) refs.push(value);
  };
  add(requested);
  add(defaultBranch);
  add(current);
  add('main');
  add('master');
  return refs;
}

async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = index;
      index += 1;
      out[current] = await mapper(items[current], current);
    }
  }
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, () => worker());
  await Promise.all(workers);
  return out;
}

async function requestWithRefs({ baseUrl, token, apiPath, query, refs, refKey, acceptEmpty = false }) {
  let lastError = null;
  const refList = refs.length ? refs : [''];
  for (const ref of refList) {
    try {
      const result = await request({
        baseUrl,
        token,
        apiPath,
        query: { ...query, ...(ref ? { [refKey]: ref } : {}) },
      });
      const items = asList(result.data);
      if (items.length > 0 || !ref || acceptEmpty) {
        return { result, ref: ref || '', items };
      }
    } catch (error) {
      lastError = error;
      if (Number(error.status) !== 404) throw error;
    }
  }
  if (lastError) throw lastError;
  return { result: { data: [] }, ref: refList[0] || '', items: [] };
}

function posixFilePath(value) {
  return trimText(value).replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+$/, '');
}

function fileExtension(filePath) {
  return path.extname(String(filePath || '')).toLowerCase();
}

function isBinaryBuffer(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
  return sample.includes(0);
}

function mapCommit(item) {
  if (!item) return null;
  const message = item.commit?.message || item.message || item.title || '';
  const sha = item.sha || item.id || '';
  return {
    id: sha,
    shortId: sha.slice(0, 8),
    title: String(message).split('\n')[0],
    message,
    authorName: item.commit?.author?.name || item.author?.login || item.authorName || '',
    authoredDate: item.commit?.author?.date || item.authoredDate || item.commit?.committer?.date || '',
    createdAt: item.commit?.author?.date || item.created_at || '',
    parentIds: asList(item.parents).map((parent) => parent.sha).filter(Boolean),
    webUrl: item.html_url || item.webUrl || '',
  };
}

function filePayload({ filePath, ref, buffer, commit, source }) {
  const size = buffer.length;
  const extension = fileExtension(filePath);
  const image = IMAGE_MIME.has(extension);
  const binary = !image && isBinaryBuffer(buffer);
  const tooLarge = image ? size > MAX_IMAGE_BYTES : size > MAX_PREVIEW_BYTES;
  const payload = {
    path: filePath,
    name: filePath.split('/').pop() || filePath,
    ref: ref || '',
    size,
    binary,
    image,
    tooLarge,
    content: '',
    dataUrl: '',
    source,
    commit: commit || null,
  };
  if (tooLarge || (binary && !image)) return payload;
  if (image) {
    payload.dataUrl = `data:${IMAGE_MIME.get(extension)};base64,${buffer.toString('base64')}`;
    return payload;
  }
  payload.content = buffer.toString('utf8');
  return payload;
}

function readGitBuffer(cwd, args) {
  try {
    return execFileSync('git', args, {
      cwd,
      windowsHide: true,
      timeout: 20000,
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_IMAGE_BYTES + 64 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    });
  } catch {
    return null;
  }
}

function readLocalGitFile(cwd, ref, filePath) {
  const relative = posixFilePath(filePath);
  if (!relative) return null;
  const spec = `${trimText(ref) || 'HEAD'}:${relative}`;
  const buffer = readGitBuffer(cwd, ['show', spec]);
  if (buffer) return buffer;
  const localPath = path.resolve(cwd, relative);
  const root = path.resolve(cwd);
  const relativeToRoot = path.relative(root, localPath);
  if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) return null;
  try {
    if (fs.existsSync(localPath) && fs.statSync(localPath).isFile()) return fs.readFileSync(localPath);
  } catch {
    return null;
  }
  return null;
}

function readLocalGitCommit(cwd, ref, filePath) {
  const relative = posixFilePath(filePath);
  const output = runGit(cwd, ['log', '-1', '--format=%H%x09%s%x09%an%x09%aI', trimText(ref) || 'HEAD', '--', relative]);
  if (!output) return null;
  const [id, title, authorName, authoredDate] = output.split('\t');
  if (!id) return null;
  return mapCommit({ sha: id, message: title, authorName, authoredDate });
}

function decodeGitHubContent(data) {
  const encoding = String(data.encoding || 'base64').toLowerCase();
  const content = String(data.content || '').replace(/\s+/g, '');
  if (!content) return null;
  if (encoding === 'base64') return Buffer.from(content, 'base64');
  return Buffer.from(String(data.content || ''), 'utf8');
}

function parseBlamePorcelain(text) {
  const groups = [];
  let current = null;
  for (const line of String(text || '').split('\n')) {
    if (line.startsWith('\t')) {
      if (current) current.lines.push(line.slice(1));
      continue;
    }
    const header = line.match(/^([0-9a-f]{8,40}) \d+ \d+/i);
    if (header) {
      const commitId = header[1];
      if (current && current.commitId === commitId) continue;
      current = {
        commitId,
        shortId: commitId.slice(0, 8),
        authorName: '',
        authoredDate: '',
        lines: [],
      };
      groups.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith('author ') && !line.startsWith('author-')) current.authorName = line.slice(7);
    if (line.startsWith('author-time ')) {
      const seconds = Number(line.slice(12));
      if (Number.isFinite(seconds)) current.authoredDate = new Date(seconds * 1000).toISOString();
    }
  }
  return groups.filter((group) => group.lines.length);
}

function contentsPath(filePath) {
  const relative = posixFilePath(filePath);
  if (!relative) return 'contents';
  return `contents/${relative.split('/').map(encodeURIComponent).join('/')}`;
}

function mapCheckStatus(item) {
  const conclusion = String(item.conclusion || '').toLowerCase();
  const status = String(item.status || '').toLowerCase();
  if (conclusion === 'success' || conclusion === 'neutral' || conclusion === 'skipped') return 'success';
  if (conclusion === 'failure' || conclusion === 'timed_out' || conclusion === 'action_required' || conclusion === 'stale') return 'failed';
  if (conclusion === 'cancelled' || conclusion === 'canceled') return 'canceled';
  if (status === 'in_progress' || status === 'queued' || status === 'pending' || status === 'waiting') return 'running';
  return conclusion || status || '';
}

async function loadFileRecord({ cwd, status, baseUrl, token, query }) {
  const filePath = posixFilePath(query.path);
  if (!filePath) throw new Error('文件路径不能为空');
  const refs = candidateRefs(status, query);
  const repoApi = repoApiPath(status.projectPath);
  let buffer = null;
  let usedRef = refs[0] || status.currentBranch || 'HEAD';
  let source = 'git';
  for (const ref of refs.length ? refs : ['HEAD']) {
    const local = readLocalGitFile(cwd, ref, filePath);
    if (local) {
      buffer = local;
      usedRef = ref || 'HEAD';
      source = 'git';
      break;
    }
  }
  if (!buffer && status.tokenConfigured) {
    let lastError = null;
    for (const ref of refs.length ? refs : ['']) {
      try {
        const result = await request({
          baseUrl,
          token,
          apiPath: `${repoApi}/${contentsPath(filePath)}`,
          query: ref ? { ref } : {},
        });
        const data = result.data || {};
        buffer = decodeGitHubContent(data);
        if (!buffer && data.sha) {
          const blob = await request({
            baseUrl,
            token,
            apiPath: `${repoApi}/git/blobs/${data.sha}`,
          });
          buffer = decodeGitHubContent(blob.data || {});
        }
        usedRef = ref || usedRef;
        source = 'github';
        lastError = null;
        if (buffer) break;
      } catch (error) {
        lastError = error;
        if (Number(error.status) !== 404) throw error;
      }
    }
    if (!buffer && lastError) throw lastError;
  }
  if (!buffer) throw new Error(status.tokenConfigured ? '无法读取该文件' : '本地仓库没有该文件，且未配置 GitHub 个人 Token');
  let commit = readLocalGitCommit(cwd, usedRef, filePath);
  if (!commit && status.tokenConfigured) {
    try {
      const result = await request({
        baseUrl,
        token,
        apiPath: `${repoApi}/commits`,
        query: { path: filePath, per_page: 1, ...(usedRef ? { sha: usedRef } : {}) },
      });
      commit = mapCommit(asList(result.data)[0]);
    } catch {
      commit = null;
    }
  }
  return filePayload({ filePath, ref: usedRef, buffer, commit, source });
}

async function loadBlameRecord({ cwd, status, query }) {
  const filePath = posixFilePath(query.path);
  if (!filePath) throw new Error('文件路径不能为空');
  const refs = candidateRefs(status, query);
  for (const ref of refs.length ? refs : ['HEAD']) {
    const output = readGitBuffer(cwd, ['blame', '--line-porcelain', trimText(ref) || 'HEAD', '--', filePath]);
    if (output) return parseBlamePorcelain(output.toString('utf8'));
  }
  throw new Error('无法读取该文件的 Blame');
}

function webUrl(status, suffix) {
  const root = String(status.project?.webUrl || '').replace(/\/+$/, '');
  if (!root) return '';
  return suffix ? `${root}/${String(suffix).replace(/^\/+/, '')}` : root;
}

async function loadResource({ cwd, enabled, baseUrl, token, connections, resource, query = {} }) {
  const status = await inspectWorkspace({ cwd, enabled, baseUrl, token, connections });
  if (!status.available) throw new Error(status.reason || '当前工作区未启用 GitHub 管理');
  const localReadable = resource === 'file' || resource === 'blame' || resource === 'commitDiff' || resource === 'graph';
  if (!localReadable && !status.tokenConfigured) throw new Error('未配置 GitHub 个人 Token');
  const repoApi = repoApiPath(status.projectPath);
  const perPage = Number(query.perPage || 50);
  const refs = candidateRefs(status, query);
  if (resource === 'project') {
    const result = await request({ baseUrl, token, apiPath: repoApi });
    return { status, project: mapProject(result.data || {}, status.projectPath) };
  }
  if (resource === 'mergeRequests') {
    const state = query.state === 'opened' ? 'open' : (query.state || 'all');
    const result = await request({
      baseUrl,
      token,
      apiPath: `${repoApi}/pulls`,
      query: { state, per_page: perPage, sort: 'updated', direction: 'desc' },
    });
    return { status, items: asList(result.data).map(mapPullRequest) };
  }
  if (resource === 'mergeRequest') {
    const iid = Number(query.iid);
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('拉取请求编号无效');
    const result = await request({ baseUrl, token, apiPath: `${repoApi}/pulls/${iid}` });
    return { status, mergeRequest: mapPullRequest(result.data || {}) };
  }
  if (resource === 'mergeRequestCommits') {
    const iid = Number(query.iid);
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('拉取请求编号无效');
    let items = [];
    try {
      items = (await loadPaged({
        baseUrl,
        token,
        apiPath: `${repoApi}/pulls/${iid}/commits`,
        limit: 200,
      })).map((item) => mapCommit(item));
    } catch {
      items = [];
    }
    if (items.length === 0) {
      items = localMergeCommits(cwd, query.sourceBranch, query.targetBranch);
    }
    return { status, items };
  }
  if (resource === 'mergeRequestDiffs') {
    const iid = Number(query.iid);
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('拉取请求编号无效');
    let unified = '';
    try {
      const diff = await request({
        baseUrl,
        token,
        apiPath: `${repoApi}/pulls/${iid}`,
        accept: 'application/vnd.github.diff',
      });
      unified = typeof diff.data === 'string' ? diff.data : '';
    } catch {
      unified = '';
    }
    if (!unified) {
      try {
        const files = await loadPaged({
          baseUrl,
          token,
          apiPath: `${repoApi}/pulls/${iid}/files`,
          limit: 400,
        });
        unified = filesToUnified(files);
      } catch {
        unified = '';
      }
    }
    if (!unified) unified = localMergeDiff(cwd, query.sourceBranch, query.targetBranch);
    return { status, diff: unified };
  }
  if (resource === 'mergeRequestNotes') {
    const iid = Number(query.iid);
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('拉取请求编号无效');
    const [issueComments, reviewComments, reviews] = await Promise.all([
      loadPaged({ baseUrl, token, apiPath: `${repoApi}/issues/${iid}/comments`, query: { sort: 'created', direction: 'asc' }, limit: 200 }).catch(() => []),
      loadPaged({ baseUrl, token, apiPath: `${repoApi}/pulls/${iid}/comments`, query: { sort: 'created', direction: 'asc' }, limit: 200 }).catch(() => []),
      loadPaged({ baseUrl, token, apiPath: `${repoApi}/pulls/${iid}/reviews`, limit: 100 }).catch(() => []),
    ]);
    const items = [
      ...issueComments.map((item) => ({
        id: `issue-${item.id}`,
        body: item.body || '',
        system: false,
        author: item.user?.login || item.user?.name || '',
        createdAt: item.created_at || '',
      })),
      ...reviewComments.map((item) => ({
        id: `review-comment-${item.id}`,
        body: item.path ? `${item.path}${item.original_line || item.line ? `:${item.original_line || item.line}` : ''}\n${item.body || ''}` : (item.body || ''),
        system: false,
        author: item.user?.login || item.user?.name || '',
        createdAt: item.created_at || '',
      })),
      ...reviews.filter((item) => item.body).map((item) => ({
        id: `review-${item.id}`,
        body: item.body || '',
        system: Boolean(item.state && item.state !== 'COMMENTED'),
        author: item.user?.login || item.user?.name || '',
        createdAt: item.submitted_at || item.created_at || '',
      })),
    ].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
    return { status, items };
  }
  if (resource === 'mergeRequestPipelines') {
    const iid = Number(query.iid);
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('拉取请求编号无效');
    let sha = trimText(query.sha);
    if (!sha) {
      try {
        const pull = await request({ baseUrl, token, apiPath: `${repoApi}/pulls/${iid}` });
        sha = pull.data?.head?.sha || '';
      } catch {
        sha = '';
      }
    }
    let items = [];
    if (sha) {
      try {
        const checks = await request({
          baseUrl,
          token,
          apiPath: `${repoApi}/commits/${encodeURIComponent(sha)}/check-runs`,
          query: { per_page: 50 },
        });
        items = asList(checks.data?.check_runs).map((item) => ({
          id: item.id,
          status: mapCheckStatus(item),
          ref: item.name || '',
          sha: item.head_sha || sha,
          webUrl: item.html_url || item.details_url || '',
          createdAt: item.started_at || item.completed_at || '',
        }));
      } catch {
        items = [];
      }
      if (items.length === 0) {
        try {
          const combined = await request({
            baseUrl,
            token,
            apiPath: `${repoApi}/commits/${encodeURIComponent(sha)}/status`,
          });
          items = asList(combined.data?.statuses).map((item) => ({
            id: item.id,
            status: mapCheckStatus({ conclusion: item.state, status: item.state }),
            ref: item.context || '',
            sha,
            webUrl: item.target_url || '',
            createdAt: item.created_at || '',
          }));
        } catch {
          items = [];
        }
      }
    }
    return { status, items };
  }
  if (resource === 'branches') {
    const result = await request({
      baseUrl,
      token,
      apiPath: `${repoApi}/branches`,
      query: { per_page: Math.max(perPage, 100) },
    });
    const defaultBranch = status.project?.defaultBranch || '';
    return {
      status,
      items: asList(result.data).map((item) => ({
        name: item.name,
        default: item.name === defaultBranch,
        protected: Boolean(item.protected),
        merged: false,
        commitId: item.commit?.sha || '',
        commitTitle: item.commit?.commit?.message?.split('\n')[0] || '',
        commitDate: item.commit?.commit?.author?.date || item.commit?.commit?.committer?.date || '',
        webUrl: webUrl(status, `tree/${item.name}`),
      })),
    };
  }
  if (resource === 'commits') {
    const { result } = await requestWithRefs({
      baseUrl,
      token,
      apiPath: `${repoApi}/commits`,
      query: { per_page: perPage },
      refs,
      refKey: 'sha',
    });
    return {
      status,
      items: asList(result.data).map((item) => mapCommit(item)),
    };
  }
  if (resource === 'commitDiff') {
    const sha = trimText(query.sha || query.ref);
    if (!sha) throw new Error('提交为空');
    let commit = null;
    let unified = '';
    if (status.tokenConfigured) {
      try {
        const result = await request({
          baseUrl,
          token,
          apiPath: `${repoApi}/commits/${encodeURIComponent(sha)}`,
        });
        const data = result.data || {};
        commit = {
          ...mapCommit(data),
          stats: {
            additions: Number(data.stats?.additions || 0) || 0,
            deletions: Number(data.stats?.deletions || 0) || 0,
          },
        };
        unified = filesToUnified(data.files);
      } catch {
        commit = null;
        unified = '';
      }
    }
    const local = (!commit || !unified) ? localCommitDiff(cwd, sha) : { commit: null, diff: '' };
    commit = commit || local.commit;
    unified = unified || local.diff;
    if (!commit) throw new Error('无法读取该提交');
    return { status, commit, diff: unified };
  }
  if (resource === 'graph') {
    return { status, ...localGraph(cwd, query.limit || query.perPage) };
  }
  if (resource === 'tags') {
    const result = await request({
      baseUrl,
      token,
      apiPath: `${repoApi}/tags`,
      query: { per_page: perPage },
    });
    return {
      status,
      items: asList(result.data).map((item) => ({
        name: item.name,
        message: item.message || item.commit?.commit?.message || '',
        commitId: item.commit?.sha || '',
        commitTitle: item.commit?.commit?.message?.split('\n')[0] || item.name,
        commitDate: item.commit?.commit?.author?.date || item.commit?.commit?.committer?.date || '',
        webUrl: webUrl(status, `releases/tag/${encodeURIComponent(item.name)}`),
      })),
    };
  }
  if (resource === 'tree') {
    const recursive = Boolean(query.recursive);
    const dirPath = posixFilePath(query.path);
    let ref = refs[0] || '';
    let items = [];
    if (recursive) {
      const commitResult = await requestWithRefs({
        baseUrl,
        token,
        apiPath: `${repoApi}/commits`,
        query: { per_page: 1 },
        refs,
        refKey: 'sha',
      });
      ref = commitResult.ref || ref;
      const commit = asList(commitResult.result.data)[0];
      const treeSha = commit?.commit?.tree?.sha || commit?.sha || ref;
      if (treeSha) {
        const tree = await request({
          baseUrl,
          token,
          apiPath: `${repoApi}/git/trees/${encodeURIComponent(treeSha)}`,
          query: { recursive: 1 },
        });
        items = asList(tree.data?.tree).map((item) => ({
          id: item.sha,
          name: String(item.path || '').split('/').pop() || item.path,
          path: item.path,
          type: item.type === 'tree' ? 'tree' : 'blob',
          mode: item.mode,
        }));
        if (dirPath) items = items.filter((item) => item.path === dirPath || item.path.startsWith(`${dirPath}/`));
      }
    } else {
      const { result, ref: usedRef, items: listed } = await requestWithRefs({
        baseUrl,
        token,
        apiPath: `${repoApi}/${contentsPath(dirPath)}`,
        query: {},
        refs,
        refKey: 'ref',
        acceptEmpty: Boolean(dirPath),
      });
      ref = usedRef;
      const entries = listed.length ? listed : asList(result.data);
      items = entries.map((item) => ({
        id: item.sha,
        name: item.name,
        path: item.path,
        type: item.type === 'dir' || item.type === 'tree' ? 'tree' : 'blob',
        mode: item.mode,
      }));
    }
    if (query.withLastCommit) {
      items = await mapLimit(items, 5, async (item) => {
        try {
          const commitResult = await request({
            baseUrl,
            token,
            apiPath: `${repoApi}/commits`,
            query: {
              path: item.path,
              per_page: 1,
              ...(ref ? { sha: ref } : {}),
            },
          });
          const commit = mapCommit(asList(commitResult.data)[0]);
          if (!commit) return item;
          return {
            ...item,
            lastCommitId: commit.id,
            lastCommitTitle: commit.title,
            lastCommitAuthor: commit.authorName,
            lastCommitDate: commit.authoredDate,
            lastCommitUrl: commit.webUrl,
          };
        } catch {
          return item;
        }
      });
    }
    return { status, ref, items };
  }
  if (resource === 'file') {
    const file = await loadFileRecord({ cwd, status, baseUrl, token, query });
    return { status, file };
  }
  if (resource === 'blame') {
    const items = await loadBlameRecord({ cwd, status, query });
    return { status, items };
  }
  throw new Error(`未知 GitHub 资源：${resource}`);
}

function parseRepoIdentity(name, owner = '') {
  const raw = trimText(name).replace(/^\/+|\/+$/g, '');
  if (!raw) return { owner: trimText(owner), name: '' };
  if (raw.includes('/')) {
    const [left, ...rest] = raw.split('/');
    return { owner: trimText(left || owner), name: trimText(rest.join('/')) };
  }
  return { owner: trimText(owner), name: raw };
}

function scopesAllowCreate(scopes, isPrivate) {
  const items = String(scopes || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (items.length === 0) return true;
  return items.includes('repo') || (!isPrivate && items.includes('public_repo'));
}

async function getMaybe(options) {
  try {
    const result = await request(options);
    return { ...result, status: 200 };
  } catch (error) {
    if (error && error.status === 404) return { data: null, status: 404, headers: error.headers || {} };
    throw error;
  }
}

async function checkRepository({ enabled, baseUrl, token, query = {} }) {
  if (enabled === false) throw new Error('GitHub 集成已关闭');
  const user = await request({ baseUrl, token, apiPath: 'user' });
  const login = trimText(user.data?.login);
  if (!login) throw new Error('无法读取 GitHub 登录名');
  const scopes = user.headers?.scopes || '';
  const isPrivate = query.private === true || query.visibility === 'private';
  const parsed = parseRepoIdentity(query.name, query.owner);
  const owner = parsed.owner || login;
  const name = parsed.name;
  if (name && /[^\w.-]/.test(name)) throw new Error('仓库名只能包含字母、数字、点、下划线和连字符');
  const orgs = asList((await request({ baseUrl, token, apiPath: 'user/orgs', query: { per_page: 100 } }).catch(() => ({ data: [] }))).data)
    .map((item) => trimText(item.login))
    .filter(Boolean);
  let exists = false;
  let project = null;
  let reason = '';
  if (name) {
    const existing = await getMaybe({ baseUrl, token, apiPath: `repos/${owner}/${name}` });
    if (existing.data) {
      exists = true;
      project = mapProject(existing.data, `${owner}/${name}`);
      reason = '仓库已存在';
    }
  }
  let canCreate = !exists && scopesAllowCreate(scopes, isPrivate);
  if (canCreate && name && owner.toLowerCase() !== login.toLowerCase()) {
    const org = await getMaybe({ baseUrl, token, apiPath: `orgs/${owner}` });
    if (!org.data) {
      canCreate = false;
      reason = `找不到组织 ${owner}，或 Token 无权访问`;
    }
  }
  if (!canCreate && !reason) {
    reason = exists ? '仓库已存在' : '当前 Token 缺少 repo / public_repo 权限';
  }
  return {
    ok: true,
    exists,
    canCreate,
    login,
    owner,
    name,
    fullName: name ? `${owner}/${name}` : '',
    ownerType: owner.toLowerCase() === login.toLowerCase() ? 'user' : 'org',
    private: isPrivate,
    scopes: scopes.split(',').map((item) => item.trim()).filter(Boolean),
    orgs,
    reason,
    project,
  };
}

async function createRepository({ enabled, baseUrl, token, query = {} }) {
  const check = await checkRepository({ enabled, baseUrl, token, query });
  if (check.exists) {
    return {
      ok: false,
      exists: true,
      created: false,
      reason: '仓库已存在，只读检查通过，未再次创建',
      ...check,
    };
  }
  if (!check.canCreate) throw new Error(check.reason || '当前 Token 不能创建该仓库');
  if (!check.name) throw new Error('仓库名不能为空');
  const path = check.owner.toLowerCase() === check.login.toLowerCase()
    ? 'user/repos'
    : `orgs/${check.owner}/repos`;
  const result = await request({
    baseUrl,
    token,
    method: 'POST',
    apiPath: path,
    body: {
      name: check.name,
      description: trimText(query.description),
      private: check.private === true,
      auto_init: query.autoInit === true,
    },
  });
  return {
    ok: true,
    exists: false,
    created: true,
    login: check.login,
    owner: check.owner,
    name: check.name,
    fullName: `${check.owner}/${check.name}`,
    project: mapProject(result.data || {}, `${check.owner}/${check.name}`),
  };
}

async function writeResource({ cwd, enabled, baseUrl, token, action, query = {} }) {
  const status = await inspectWorkspace({ cwd, enabled, baseUrl, token });
  if (!status.available) throw new Error(status.reason || '当前工作区未启用 GitHub 管理');
  if (!status.tokenConfigured) throw new Error('未配置 GitHub 个人 Token');
  const repoApi = repoApiPath(status.projectPath);
  if (action === 'createMergeRequest') {
    const title = trimText(query.title);
    const sourceBranch = trimText(query.sourceBranch) || status.currentBranch;
    const targetBranch = trimText(query.targetBranch) || status.project?.defaultBranch;
    if (!title) throw new Error('标题不能为空');
    if (!sourceBranch || !targetBranch) throw new Error('源分支和目标分支不能为空');
    const result = await request({
      baseUrl,
      token,
      method: 'POST',
      apiPath: `${repoApi}/pulls`,
      body: {
        title,
        head: sourceBranch,
        base: targetBranch,
        body: trimText(query.description),
      },
    });
    return { status, mergeRequest: mapPullRequest(result.data || {}) };
  }
  if (action === 'createNote') {
    const iid = Number(query.iid);
    const body = trimText(query.body);
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('拉取请求编号无效');
    if (!body) throw new Error('评论不能为空');
    const result = await request({
      baseUrl,
      token,
      method: 'POST',
      apiPath: `${repoApi}/issues/${iid}/comments`,
      body: { body },
    });
    return {
      status,
      note: {
        id: result.data?.id,
        body: result.data?.body || body,
        system: false,
        author: result.data?.user?.login || result.data?.user?.name || '',
        createdAt: result.data?.created_at || '',
      },
    };
  }
  if (action === 'createReviewComment') {
    const iid = Number(query.iid);
    const body = trimText(query.body);
    const filePath = trimText(query.path || query.newPath);
    const newLine = Number(query.newLine);
    const oldLine = Number(query.oldLine);
    const commitId = trimText(query.diffRefs?.headSha || query.headSha || query.sha);
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('拉取请求编号无效');
    if (!body) throw new Error('评论不能为空');
    if (!filePath) throw new Error('文件路径不能为空');
    if (!commitId) throw new Error('缺少 head SHA，无法发表行评论');
    const side = Number.isFinite(newLine) && newLine > 0 ? 'RIGHT' : 'LEFT';
    const line = side === 'RIGHT' ? newLine : oldLine;
    if (!Number.isFinite(line) || line <= 0) throw new Error('需要指定行号');
    const result = await request({
      baseUrl,
      token,
      method: 'POST',
      apiPath: `${repoApi}/pulls/${iid}/comments`,
      body: { body, commit_id: commitId, path: filePath, line, side },
    });
    return {
      status,
      note: {
        id: result.data?.id,
        body: result.data?.body || body,
        system: false,
        author: result.data?.user?.login || result.data?.user?.name || '',
        createdAt: result.data?.created_at || '',
      },
    };
  }
  if (action === 'mergeMergeRequest' || action === 'updateMergeRequestState') {
    const iid = Number(query.iid);
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('拉取请求编号无效');
    if (action === 'mergeMergeRequest') {
      await request({
        baseUrl,
        token,
        method: 'PUT',
        apiPath: `${repoApi}/pulls/${iid}/merge`,
        body: { merge_method: trimText(query.mergeMethod) || 'merge' },
      });
    } else {
      const stateEvent = trimText(query.stateEvent);
      if (stateEvent !== 'close' && stateEvent !== 'reopen') throw new Error('状态操作无效');
      await request({
        baseUrl,
        token,
        method: 'PATCH',
        apiPath: `${repoApi}/pulls/${iid}`,
        body: { state: stateEvent === 'reopen' ? 'open' : 'closed' },
      });
    }
    const result = await request({ baseUrl, token, apiPath: `${repoApi}/pulls/${iid}` });
    return { status, mergeRequest: mapPullRequest(result.data || {}) };
  }
  if (action === 'approveMergeRequest') {
    const iid = Number(query.iid);
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('拉取请求编号无效');
    await request({
      baseUrl,
      token,
      method: 'POST',
      apiPath: `${repoApi}/pulls/${iid}/reviews`,
      body: { event: 'APPROVE', body: trimText(query.body) || undefined },
    });
    const result = await request({ baseUrl, token, apiPath: `${repoApi}/pulls/${iid}` });
    return { status, mergeRequest: mapPullRequest(result.data || {}) };
  }
  if (action === 'createBranch') {
    const name = trimText(query.name || query.branch);
    const ref = trimText(query.ref) || status.currentBranch || 'HEAD';
    if (!name || name === '.' || name === '..' || /[\s~^:?*\[\\]/.test(name) || name.includes('..')) throw new Error('分支名无效');
    let sha = trimText(query.sha);
    if (!sha) {
      const refPath = /^[0-9a-f]{7,40}$/i.test(ref) ? ref : `heads/${ref}`;
      const resolved = /^[0-9a-f]{7,40}$/i.test(ref)
        ? { data: { object: { sha: ref } } }
        : await request({ baseUrl, token, apiPath: `${repoApi}/git/ref/${refPath}` });
      sha = trimText(resolved.data?.object?.sha || resolved.data?.sha);
    }
    if (!sha) throw new Error('找不到起始提交');
    const result = await request({
      baseUrl,
      token,
      method: 'POST',
      apiPath: `${repoApi}/git/refs`,
      body: { ref: `refs/heads/${name}`, sha },
    });
    return {
      status,
      branch: {
        name,
        commitId: result.data?.object?.sha || sha,
      },
    };
  }
  throw new Error(`未知 GitHub 写入操作：${action}`);
}

module.exports = {
  SECRET_NAME,
  inspectWorkspace,
  listManagedProjects,
  isManagedGithubRepo,
  loadResource,
  writeResource,
  checkRepository,
  createRepository,
  readLocalGitFile,
  request,
  errorMessage,
  normalizeHost,
};
