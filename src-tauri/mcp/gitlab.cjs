'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SECRET_NAME = 'GITLAB_PERSONAL_TOKEN';
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
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 8 * 1024 * 1024,
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

function encodeProjectPath(projectPath) {
  return encodeURIComponent(String(projectPath || '').replace(/^\/+|\/+$/g, ''));
}

function apiUrl(baseUrl, apiPath, query = {}) {
  const root = trimText(baseUrl).replace(/\/+$/, '');
  if (!root) throw new Error('GitLab 服务器地址不能为空');
  const pathname = `/api/v4/${String(apiPath || '').replace(/^\/+/, '')}`;
  const url = new URL(root + pathname);
  for (const [key, value] of Object.entries(query || {})) {
    if (value == null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function errorMessage(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  if (error.message) return String(error.message);
  return String(error);
}

async function request({ baseUrl, token, method = 'GET', apiPath, query, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!trimText(token)) throw new Error('未配置 GitLab 个人 Token');
  const url = apiUrl(baseUrl, apiPath, query);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      headers: {
        Accept: 'application/json',
        'PRIVATE-TOKEN': token,
        ...(body != null ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body == null ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch { data = text; }
    }
    if (!response.ok) {
      const message = data && typeof data === 'object'
        ? (data.message || data.error || data.error_description || JSON.stringify(data))
        : (text || `HTTP ${response.status}`);
      const error = new Error(typeof message === 'string' ? message : JSON.stringify(message));
      error.status = response.status;
      throw error;
    }
    return {
      data,
      page: Number(response.headers.get('x-page') || 1) || 1,
      nextPage: trimText(response.headers.get('x-next-page')),
      total: trimText(response.headers.get('x-total')),
    };
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('GitLab 请求超时');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function mapProject(project, fallbackPath) {
  return {
    id: project.id,
    name: project.name_with_namespace || project.name || fallbackPath,
    description: project.description || '',
    webUrl: project.web_url || '',
    defaultBranch: project.default_branch || '',
    visibility: project.visibility || '',
    pathWithNamespace: project.path_with_namespace || fallbackPath,
    lastActivityAt: project.last_activity_at || '',
    httpUrl: project.http_url_to_repo || '',
    sshUrl: project.ssh_url_to_repo || '',
  };
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
    name: String(item.name || item.baseUrl || 'GitLab'),
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
      reason: 'GitLab 全局开关未开启',
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
    status.reason = 'GitLab 全局开关未开启';
    return status;
  }
  if (!status.baseUrl) {
    status.reason = '未配置 GitLab 服务器地址';
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
    status.reason = '未配置 GitLab 个人 Token';
    return status;
  }
  try {
    const result = await request({
      baseUrl,
      token,
      apiPath: `projects/${encodeProjectPath(matched.projectPath)}`,
    });
    const project = result.data || {};
    status.project = mapProject(project, matched.projectPath);
    status.reason = '';
  } catch (error) {
    status.reason = `已识别 GitLab 仓库，但读取项目失败：${errorMessage(error)}`;
  }
  return status;
}

function asList(data) {
  return Array.isArray(data) ? data : [];
}

function mapMergeRequest(item) {
  return {
    iid: item.iid,
    title: item.title || '',
    description: item.description || '',
    state: item.state || '',
    draft: Boolean(item.draft || item.work_in_progress),
    sourceBranch: item.source_branch || '',
    targetBranch: item.target_branch || '',
    author: item.author?.name || item.author?.username || '',
    createdAt: item.created_at || '',
    updatedAt: item.updated_at || '',
    mergedAt: item.merged_at || '',
    mergedBy: item.merged_by?.name || item.merge_user?.name || '',
    mergeCommitSha: item.merge_commit_sha || '',
    sha: item.sha || '',
    webUrl: item.web_url || '',
    labels: Array.isArray(item.labels) ? item.labels : [],
    assignees: asList(item.assignees).map((user) => user.name || user.username).filter(Boolean),
    reviewers: asList(item.reviewers).map((user) => user.name || user.username).filter(Boolean),
    changesCount: Number(item.changes_count || 0) || 0,
    userNotesCount: Number(item.user_notes_count || 0) || 0,
    mergeStatus: item.detailed_merge_status || item.merge_status || '',
    diffRefs: {
      baseSha: item.diff_refs?.base_sha || '',
      startSha: item.diff_refs?.start_sha || '',
      headSha: item.diff_refs?.head_sha || item.sha || '',
    },
  };
}

function diffsToUnified(diffs) {
  return asList(diffs).map((item) => {
    const oldPath = item.old_path || item.new_path || 'file';
    const newPath = item.new_path || item.old_path || 'file';
    const body = String(item.diff || '');
    if (body.startsWith('diff --git ')) return body;
    return `diff --git a/${oldPath} b/${newPath}\n--- a/${oldPath}\n+++ b/${newPath}\n${body}`;
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

function mapCommitDetail(item) {
  return {
    id: item.id || '',
    shortId: item.short_id || String(item.id || '').slice(0, 8),
    title: item.title || String(item.message || '').split('\n')[0] || '',
    message: item.message || item.title || '',
    authorName: item.author_name || '',
    authoredDate: item.authored_date || item.committed_date || item.created_at || '',
    createdAt: item.created_at || item.authored_date || '',
    parentIds: Array.isArray(item.parent_ids) ? item.parent_ids : [],
    webUrl: item.web_url || '',
    stats: {
      additions: Number(item.stats?.additions || 0) || 0,
      deletions: Number(item.stats?.deletions || 0) || 0,
    },
  };
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
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
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
  if (!trimText(baseUrl)) throw new Error('未配置 GitLab 服务器地址');
  if (!trimText(token)) throw new Error('未配置 GitLab 个人 Token');
  const items = await loadPaged({
    baseUrl,
    token,
    apiPath: 'projects',
    query: {
      membership: 'true',
      min_access_level: 40,
      archived: 'false',
      order_by: 'last_activity_at',
      sort: 'desc',
      search: trimText(search),
    },
    limit,
  });
  return items.map((project) => mapProject(project, project.path_with_namespace));
}

function projectApiPath(status) {
  if (status.project && status.project.id != null && status.project.id !== '') {
    return `projects/${status.project.id}`;
  }
  return `projects/${encodeProjectPath(status.projectPath)}`;
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
  const tried = [];
  const refList = refs.length ? refs : [''];
  for (const ref of refList) {
    tried.push(ref || '(default)');
    try {
      const result = await request({
        baseUrl,
        token,
        apiPath,
        query: { ...query, ...(ref ? { [refKey]: ref } : {}) },
      });
      const items = asList(result.data);
      if (items.length > 0 || !ref || acceptEmpty) {
        return { result, ref: ref || '', tried };
      }
    } catch (error) {
      lastError = error;
      if (Number(error.status) !== 404) throw error;
    }
  }
  if (lastError) throw lastError;
  return { result: { data: [] }, ref: refList[0] || '', tried };
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
  return {
    id: item.id || item.commitId || '',
    shortId: item.short_id || item.shortId || String(item.id || '').slice(0, 8),
    title: item.title || item.message || '',
    authorName: item.author_name || item.authorName || '',
    authoredDate: item.authored_date || item.authoredDate || item.committed_date || item.created_at || '',
    webUrl: item.web_url || item.webUrl || '',
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
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: MAX_IMAGE_BYTES + 64 * 1024,
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
  return mapCommit({ id, short_id: id.slice(0, 8), title, author_name: authorName, authored_date: authoredDate });
}

function decodeGitLabFileContent(data) {
  const encoding = String(data.encoding || 'base64').toLowerCase();
  if (encoding === 'base64') return Buffer.from(String(data.content || ''), 'base64');
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

async function loadFileRecord({ cwd, status, baseUrl, token, query }) {
  const filePath = posixFilePath(query.path);
  if (!filePath) throw new Error('文件路径不能为空');
  const refs = candidateRefs(status, query);
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
          apiPath: `${projectApiPath(status)}/repository/files/${encodeURIComponent(filePath)}`,
          query: ref ? { ref } : {},
        });
        buffer = decodeGitLabFileContent(result.data || {});
        usedRef = result.data?.ref || ref || usedRef;
        source = 'gitlab';
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (Number(error.status) !== 404) throw error;
      }
    }
    if (!buffer && lastError) throw lastError;
  }
  if (!buffer) throw new Error(status.tokenConfigured ? '无法读取该文件' : '本地仓库没有该文件，且未配置 GitLab 个人 Token');
  let commit = readLocalGitCommit(cwd, usedRef, filePath);
  if (!commit && status.tokenConfigured) {
    try {
      const result = await request({
        baseUrl,
        token,
        apiPath: `${projectApiPath(status)}/repository/commits`,
        query: { path: filePath, per_page: 1, ...(usedRef ? { ref_name: usedRef } : {}) },
      });
      commit = mapCommit(asList(result.data)[0]);
    } catch {
      commit = null;
    }
  }
  return filePayload({ filePath, ref: usedRef, buffer, commit, source });
}

async function loadBlameRecord({ cwd, status, baseUrl, token, query }) {
  const filePath = posixFilePath(query.path);
  if (!filePath) throw new Error('文件路径不能为空');
  const refs = candidateRefs(status, query);
  if (status.tokenConfigured) {
    let lastError = null;
    for (const ref of refs.length ? refs : ['']) {
      try {
        const result = await request({
          baseUrl,
          token,
          apiPath: `${projectApiPath(status)}/repository/files/${encodeURIComponent(filePath)}/blame`,
          query: ref ? { ref } : {},
        });
        return asList(result.data).map((item) => ({
          commitId: item.commit?.id || '',
          shortId: item.commit?.short_id || String(item.commit?.id || '').slice(0, 8),
          authorName: item.commit?.author_name || '',
          authoredDate: item.commit?.authored_date || item.commit?.committed_date || '',
          lines: Array.isArray(item.lines) ? item.lines : [],
        }));
      } catch (error) {
        lastError = error;
        if (Number(error.status) !== 404) throw error;
      }
    }
    if (lastError && Number(lastError.status) !== 404) throw lastError;
  }
  for (const ref of refs.length ? refs : ['HEAD']) {
    const output = readGitBuffer(cwd, ['blame', '--line-porcelain', trimText(ref) || 'HEAD', '--', filePath]);
    if (output) return parseBlamePorcelain(output.toString('utf8'));
  }
  throw new Error('无法读取该文件的 Blame');
}

async function loadResource({ cwd, enabled, baseUrl, token, connections, resource, query = {} }) {
  const status = await inspectWorkspace({ cwd, enabled, baseUrl, token, connections });
  if (!status.available) throw new Error(status.reason || '当前工作区未启用 GitLab 管理');
  const localReadable = resource === 'file' || resource === 'blame' || resource === 'commitDiff' || resource === 'graph';
  if (!localReadable && !status.tokenConfigured) throw new Error('未配置 GitLab 个人 Token');
  const projectApi = projectApiPath(status);
  const perPage = Number(query.perPage || 50);
  const refs = candidateRefs(status, query);
  if (resource === 'project') {
    const result = await request({ baseUrl, token, apiPath: projectApi });
    return { status, project: mapProject(result.data || {}, status.projectPath) };
  }
  if (resource === 'mergeRequests') {
    const result = await request({
      baseUrl,
      token,
      apiPath: `${projectApi}/merge_requests`,
      query: { state: query.state || 'all', per_page: perPage, order_by: 'updated_at', sort: 'desc' },
    });
    return { status, items: asList(result.data).map(mapMergeRequest) };
  }
  if (resource === 'mergeRequest') {
    const iid = Number(query.iid);
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('合并请求编号无效');
    const result = await request({ baseUrl, token, apiPath: `${projectApi}/merge_requests/${iid}` });
    return { status, mergeRequest: mapMergeRequest(result.data || {}) };
  }
  if (resource === 'mergeRequestCommits') {
    const iid = Number(query.iid);
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('合并请求编号无效');
    let items = [];
    try {
      items = (await loadPaged({
        baseUrl,
        token,
        apiPath: `${projectApi}/merge_requests/${iid}/commits`,
        limit: 200,
      })).map((item) => ({
        id: item.id,
        shortId: item.short_id,
        title: item.title,
        message: item.message,
        authorName: item.author_name,
        authoredDate: item.authored_date,
        createdAt: item.created_at,
        webUrl: item.web_url,
      }));
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
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('合并请求编号无效');
    let unified = '';
    try {
      const diffs = await loadPaged({
        baseUrl,
        token,
        apiPath: `${projectApi}/merge_requests/${iid}/diffs`,
        limit: 400,
      });
      unified = diffsToUnified(diffs);
    } catch {
      unified = '';
    }
    if (!unified) unified = localMergeDiff(cwd, query.sourceBranch, query.targetBranch);
    return { status, diff: unified };
  }
  if (resource === 'mergeRequestNotes') {
    const iid = Number(query.iid);
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('合并请求编号无效');
    const notes = await loadPaged({
      baseUrl,
      token,
      apiPath: `${projectApi}/merge_requests/${iid}/notes`,
      query: { sort: 'asc', order_by: 'created_at' },
      limit: 200,
    });
    return {
      status,
      items: notes.map((item) => ({
        id: item.id,
        body: item.body || '',
        system: Boolean(item.system),
        author: item.author?.name || item.author?.username || '',
        createdAt: item.created_at || '',
      })),
    };
  }
  if (resource === 'mergeRequestPipelines') {
    const iid = Number(query.iid);
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('合并请求编号无效');
    let items = [];
    try {
      items = (await loadPaged({
        baseUrl,
        token,
        apiPath: `${projectApi}/merge_requests/${iid}/pipelines`,
        limit: 50,
      })).map((item) => ({
        id: item.id,
        status: item.status,
        ref: item.ref,
        sha: item.sha,
        webUrl: item.web_url,
        createdAt: item.created_at,
      }));
    } catch {
      items = [];
    }
    return { status, items };
  }
  if (resource === 'branches') {
    const result = await request({
      baseUrl,
      token,
      apiPath: `${projectApi}/repository/branches`,
      query: { per_page: Math.max(perPage, 100) },
    });
    return {
      status,
      items: asList(result.data).map((item) => ({
        name: item.name,
        default: Boolean(item.default),
        protected: Boolean(item.protected),
        merged: Boolean(item.merged),
        commitId: item.commit?.id || '',
        commitTitle: item.commit?.title || '',
        commitDate: item.commit?.committed_date || item.commit?.authored_date || '',
        webUrl: item.web_url,
      })),
    };
  }
  if (resource === 'commits') {
    const { result } = await requestWithRefs({
      baseUrl,
      token,
      apiPath: `${projectApi}/repository/commits`,
      query: { per_page: perPage },
      refs,
      refKey: 'ref_name',
    });
    return {
      status,
      items: asList(result.data).map((item) => ({
        id: item.id,
        shortId: item.short_id,
        title: item.title,
        message: item.message,
        authorName: item.author_name,
        authoredDate: item.authored_date,
        createdAt: item.created_at,
        parentIds: item.parent_ids || [],
        webUrl: item.web_url,
      })),
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
          apiPath: `${projectApi}/repository/commits/${encodeURIComponent(sha)}`,
        });
        commit = mapCommitDetail(result.data || {});
      } catch {
        commit = null;
      }
      try {
        const diffs = await loadPaged({
          baseUrl,
          token,
          apiPath: `${projectApi}/repository/commits/${encodeURIComponent(sha)}/diff`,
          limit: 400,
        });
        unified = diffsToUnified(diffs);
      } catch {
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
      apiPath: `${projectApi}/repository/tags`,
      query: { per_page: perPage },
    });
    return {
      status,
      items: asList(result.data).map((item) => ({
        name: item.name,
        message: item.message || '',
        commitId: item.commit?.id || '',
        commitTitle: item.commit?.title || '',
        commitDate: item.commit?.committed_date || item.commit?.authored_date || '',
        webUrl: item.commit?.web_url,
      })),
    };
  }
  if (resource === 'tree') {
    const recursive = Boolean(query.recursive);
    const path = query.path || '';
    const { result, ref } = await requestWithRefs({
      baseUrl,
      token,
      apiPath: `${projectApi}/repository/tree`,
      query: {
        per_page: Math.max(perPage, 100),
        path,
        page: query.page || 1,
        ...(recursive ? { recursive: true } : {}),
      },
      refs,
      refKey: 'ref',
      acceptEmpty: Boolean(path),
    });
    const mapTreeItem = (item) => ({
      id: item.id,
      name: item.name,
      path: item.path,
      type: item.type,
      mode: item.mode,
    });
    let items = asList(result.data).map(mapTreeItem);
    let nextPage = result.nextPage;
    while (nextPage && items.length < 1000) {
      const more = await request({
        baseUrl,
        token,
        apiPath: `${projectApi}/repository/tree`,
        query: {
          per_page: 100,
          path,
          page: nextPage,
          ...(ref ? { ref } : {}),
          ...(recursive ? { recursive: true } : {}),
        },
      });
      items = items.concat(asList(more.data).map(mapTreeItem));
      nextPage = more.nextPage;
    }
    if (query.withLastCommit) {
      items = await mapLimit(items, 5, async (item) => {
        try {
          const commitResult = await request({
            baseUrl,
            token,
            apiPath: `${projectApi}/repository/commits`,
            query: {
              path: item.path,
              per_page: 1,
              ...(ref ? { ref_name: ref } : {}),
            },
          });
          const commit = asList(commitResult.data)[0];
          if (!commit) return item;
          return {
            ...item,
            lastCommitId: commit.id,
            lastCommitTitle: commit.title,
            lastCommitAuthor: commit.author_name,
            lastCommitDate: commit.authored_date || commit.committed_date || commit.created_at,
            lastCommitUrl: commit.web_url,
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
    const items = await loadBlameRecord({ cwd, status, baseUrl, token, query });
    return { status, items };
  }
  throw new Error(`未知 GitLab 资源：${resource}`);
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

async function listGroupPaths({ baseUrl, token }) {
  try {
    const result = await request({
      baseUrl,
      token,
      apiPath: 'groups',
      query: { min_access_level: 30, per_page: 100 },
    });
    return asList(result.data)
      .map((item) => trimText(item.full_path || item.path))
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function findNamespaceId({ baseUrl, token, owner }) {
  const result = await request({
    baseUrl,
    token,
    apiPath: 'namespaces',
    query: { search: owner },
  });
  const match = asList(result.data).find((item) => {
    const path = trimText(item.full_path || item.path);
    return path && path.toLowerCase() === String(owner).toLowerCase();
  });
  return match?.id ?? null;
}

async function checkRepository({ enabled, baseUrl, token, query = {} }) {
  if (enabled === false) throw new Error('GitLab 集成已关闭');
  const user = await request({ baseUrl, token, apiPath: 'user' });
  const login = trimText(user.data?.username);
  const parsed = parseRepoIdentity(query.name, query.owner);
  const owner = parsed.owner || login;
  const name = parsed.name;
  const path = owner && name ? `${owner}/${name}` : name;
  let exists = false;
  let project = null;
  let reason = '';
  if (path) {
    try {
      const existing = await request({ baseUrl, token, apiPath: `projects/${encodeProjectPath(path)}` });
      exists = true;
      project = mapProject(existing.data || {}, path);
      reason = '仓库已存在';
    } catch (error) {
      if (!error || error.status !== 404) throw error;
    }
  }
  const orgs = await listGroupPaths({ baseUrl, token });
  const ownerType = owner && owner.toLowerCase() !== login.toLowerCase() ? 'group' : 'user';
  let canCreate = !exists && Boolean(name);
  if (canCreate && ownerType === 'group') {
    const listed = orgs.some((item) => item.toLowerCase() === owner.toLowerCase());
    if (!listed && !(await findNamespaceId({ baseUrl, token, owner }))) {
      canCreate = false;
      if (!reason) reason = `找不到群组 ${owner}，或 Token 无权在其中建仓`;
    }
  }
  return {
    ok: true,
    exists,
    canCreate,
    login,
    owner,
    name,
    fullName: path,
    ownerType,
    private: query.private === true || query.visibility === 'private',
    scopes: [],
    orgs,
    reason,
    project,
  };
}

async function createRepository({ enabled, baseUrl, token, query = {} }) {
  const check = await checkRepository({ enabled, baseUrl, token, query });
  if (check.exists) {
    return { ok: false, exists: true, created: false, reason: '仓库已存在，只读检查通过，未再次创建', ...check };
  }
  if (!check.canCreate) throw new Error(check.reason || '不能创建该仓库');
  if (!check.name) throw new Error('仓库名不能为空');
  const body = {
    name: check.name,
    path: check.name,
    description: trimText(query.description),
    visibility: check.private ? 'private' : 'public',
    initialize_with_readme: query.autoInit === true,
  };
  if (check.owner && check.login && check.owner.toLowerCase() !== check.login.toLowerCase()) {
    const namespaceId = await findNamespaceId({ baseUrl, token, owner: check.owner });
    if (!namespaceId) throw new Error(`找不到群组 ${check.owner}，或 Token 无权在其中建仓`);
    body.namespace_id = namespaceId;
  }
  const result = await request({
    baseUrl,
    token,
    method: 'POST',
    apiPath: 'projects',
    body,
  });
  return {
    ok: true,
    exists: false,
    created: true,
    login: check.login,
    owner: check.owner,
    name: check.name,
    fullName: result.data?.path_with_namespace || `${check.owner}/${check.name}`,
    project: mapProject(result.data || {}, `${check.owner}/${check.name}`),
  };
}

async function writeResource({ cwd, enabled, baseUrl, token, action, query = {} }) {
  const status = await inspectWorkspace({ cwd, enabled, baseUrl, token });
  if (!status.available) throw new Error(status.reason || '当前工作区未启用 GitLab 管理');
  if (!status.tokenConfigured) throw new Error('未配置 GitLab 个人 Token');
  const projectApi = projectApiPath(status);
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
      apiPath: `${projectApi}/merge_requests`,
      body: {
        source_branch: sourceBranch,
        target_branch: targetBranch,
        title,
        description: trimText(query.description),
      },
    });
    return { status, mergeRequest: mapMergeRequest(result.data || {}) };
  }
  if (action === 'createNote') {
    const iid = Number(query.iid);
    const body = trimText(query.body);
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('合并请求编号无效');
    if (!body) throw new Error('评论不能为空');
    const result = await request({
      baseUrl,
      token,
      method: 'POST',
      apiPath: `${projectApi}/merge_requests/${iid}/notes`,
      body: { body },
    });
    return {
      status,
      note: {
        id: result.data?.id,
        body: result.data?.body || body,
        system: Boolean(result.data?.system),
        author: result.data?.author?.name || result.data?.author?.username || '',
        createdAt: result.data?.created_at || '',
      },
    };
  }
  if (action === 'createReviewComment') {
    const iid = Number(query.iid);
    const body = trimText(query.body);
    const pathName = trimText(query.path || query.newPath);
    const oldPath = trimText(query.oldPath) || pathName;
    const newLine = Number(query.newLine);
    const oldLine = Number(query.oldLine);
    const refs = query.diffRefs || {};
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('合并请求编号无效');
    if (!body) throw new Error('评论不能为空');
    if (!pathName) throw new Error('文件路径不能为空');
    const baseSha = trimText(refs.baseSha || query.baseSha);
    const startSha = trimText(refs.startSha || query.startSha) || baseSha;
    const headSha = trimText(refs.headSha || query.headSha || query.sha);
    if (!baseSha || !headSha) throw new Error('缺少 diff SHA，无法发表行评论');
    const position = {
      position_type: 'text',
      base_sha: baseSha,
      start_sha: startSha,
      head_sha: headSha,
      old_path: oldPath,
      new_path: pathName,
    };
    if (Number.isFinite(newLine) && newLine > 0) position.new_line = newLine;
    if (Number.isFinite(oldLine) && oldLine > 0) position.old_line = oldLine;
    if (position.new_line == null && position.old_line == null) throw new Error('需要指定行号');
    const result = await request({
      baseUrl,
      token,
      method: 'POST',
      apiPath: `${projectApi}/merge_requests/${iid}/discussions`,
      body: { body, position },
    });
    const note = result.data?.notes?.[0] || {};
    return {
      status,
      note: {
        id: note.id || result.data?.id,
        body: note.body || body,
        system: Boolean(note.system),
        author: note.author?.name || note.author?.username || '',
        createdAt: note.created_at || result.data?.created_at || '',
      },
    };
  }
  if (action === 'mergeMergeRequest' || action === 'updateMergeRequestState') {
    const iid = Number(query.iid);
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('合并请求编号无效');
    if (action === 'mergeMergeRequest') {
      const result = await request({
        baseUrl,
        token,
        method: 'PUT',
        apiPath: `${projectApi}/merge_requests/${iid}/merge`,
        body: {
          merge_when_pipeline_succeeds: Boolean(query.whenPipelineSucceeds),
          should_remove_source_branch: query.removeSourceBranch !== false,
        },
      });
      return { status, mergeRequest: mapMergeRequest(result.data || {}) };
    }
    const stateEvent = trimText(query.stateEvent);
    if (stateEvent !== 'close' && stateEvent !== 'reopen') throw new Error('状态操作无效');
    const result = await request({
      baseUrl,
      token,
      method: 'PUT',
      apiPath: `${projectApi}/merge_requests/${iid}`,
      body: { state_event: stateEvent },
    });
    return { status, mergeRequest: mapMergeRequest(result.data || {}) };
  }
  if (action === 'approveMergeRequest') {
    const iid = Number(query.iid);
    if (!Number.isFinite(iid) || iid <= 0) throw new Error('合并请求编号无效');
    await request({
      baseUrl,
      token,
      method: 'POST',
      apiPath: `${projectApi}/merge_requests/${iid}/approve`,
      body: {},
    });
    const result = await request({ baseUrl, token, apiPath: `${projectApi}/merge_requests/${iid}` });
    return { status, mergeRequest: mapMergeRequest(result.data || {}) };
  }
  if (action === 'createBranch') {
    const name = trimText(query.name || query.branch);
    const ref = trimText(query.ref) || status.currentBranch || 'HEAD';
    if (!name || name === '.' || name === '..' || /[\s~^:?*\[\\]/.test(name) || name.includes('..')) throw new Error('分支名无效');
    const result = await request({
      baseUrl,
      token,
      method: 'POST',
      apiPath: `${projectApi}/repository/branches`,
      query: { branch: name, ref },
    });
    return {
      status,
      branch: {
        name: result.data?.name || name,
        commitId: result.data?.commit?.id || '',
        default: Boolean(result.data?.default),
        protected: Boolean(result.data?.protected),
      },
    };
  }
  throw new Error(`未知 GitLab 写入操作：${action}`);
}

module.exports = {
  SECRET_NAME,
  encodeProjectPath,
  inspectWorkspace,
  listManagedProjects,
  loadResource,
  writeResource,
  checkRepository,
  createRepository,
  readLocalGitFile,
  request,
  errorMessage,
  normalizeHost,
};
