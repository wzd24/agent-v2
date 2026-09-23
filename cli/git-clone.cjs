'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

function trimText(value) {
  return String(value || '').trim();
}

function folderNameFromUrl(url) {
  const raw = trimText(url).replace(/[?#].*$/, '').replace(/\/+$/, '').replace(/\.git$/i, '');
  const base = path.basename(raw.replace(/\\/g, '/'));
  return base || 'repository';
}

function parseRemote(url) {
  const value = trimText(url).replace(/[?#].*$/, '');
  if (!value) return null;
  let match = value.match(/^git@([^:]+):(.+)$/i);
  if (match) {
    return { host: match[1].toLowerCase(), path: match[2].replace(/\.git$/i, '').replace(/^\/+/, '').replace(/\/+$/, '') };
  }
  match = value.match(/^ssh:\/\/(?:git@)?([^/]+)\/(.+)$/i);
  if (match) {
    return { host: match[1].replace(/:\d+$/, '').toLowerCase(), path: match[2].replace(/\.git$/i, '').replace(/^\/+/, '').replace(/\/+$/, '') };
  }
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    const repo = parsed.pathname.replace(/\.git$/i, '').replace(/^\/+/, '').replace(/\/+$/, '');
    return repo ? { host: parsed.host.toLowerCase(), path: repo } : null;
  } catch {
    return null;
  }
}

function toHttpsUrl(remote) {
  return remote ? `https://${remote.host}/${remote.path}.git` : '';
}

function toSshUrl(remote) {
  return remote ? `git@${String(remote.host).replace(/:\d+$/, '')}:${remote.path}.git` : '';
}

function normalizeProtocol(value) {
  return String(value || 'https').toLowerCase() === 'ssh' ? 'ssh' : 'https';
}

function isLocalPath(value) {
  const text = trimText(value);
  if (!text || /^(https?:\/\/|git@|ssh:\/\/)/i.test(text)) return false;
  return text.startsWith('/') || text.startsWith('\\\\') || /^[a-zA-Z]:[\\/]/.test(text);
}

function resolveCloneUrl({ url, httpUrl, sshUrl, webUrl, protocol } = {}) {
  if (isLocalPath(url) && !trimText(httpUrl) && !trimText(sshUrl) && !trimText(webUrl)) return trimText(url);
  const wanted = normalizeProtocol(protocol);
  if (wanted === 'ssh') {
    const ssh = trimText(sshUrl);
    if (ssh) return ssh;
    return toSshUrl(parseRemote(url || httpUrl || webUrl));
  }
  const http = trimText(httpUrl) || (/^https?:\/\//i.test(trimText(url)) ? trimText(url) : '');
  if (http) return http;
  const fromWeb = trimText(webUrl).replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (fromWeb) return /\.git$/i.test(fromWeb) ? fromWeb : `${fromWeb}.git`;
  return toHttpsUrl(parseRemote(url || sshUrl));
}

function authenticatedCloneUrl(url, token, provider) {
  const source = trimText(url);
  if (!source || !trimText(token) || !/^https?:\/\//i.test(source)) return source;
  const parsed = new URL(source);
  parsed.username = provider === 'github' ? 'x-access-token' : 'oauth2';
  parsed.password = trimText(token);
  return parsed.toString();
}

function redactSecret(text, token) {
  const value = String(text || '');
  const secret = trimText(token);
  return secret ? value.split(secret).join('***') : value;
}

function prepareClone({ url, httpUrl, sshUrl, webUrl, protocol, parentDir, folderName, token = '', provider = 'gitlab', shallow = false }) {
  const source = resolveCloneUrl({ url, httpUrl, sshUrl, webUrl, protocol });
  if (!source) throw new Error(normalizeProtocol(protocol) === 'ssh' ? '未找到 SSH 克隆地址' : '克隆地址不能为空');
  const parent = path.resolve(trimText(parentDir));
  if (!parent || !fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) throw new Error('请选择已存在的目标目录');
  const name = trimText(folderName) || folderNameFromUrl(source);
  if (!name || name === '.' || name === '..' || /[<>:"|?*]/.test(name) || name.includes('/') || name.includes('\\')) {
    throw new Error('仓库目录名无效');
  }
  const target = path.join(parent, name);
  if (fs.existsSync(target)) throw new Error(`目标已存在：${target}`);
  return {
    source,
    parent,
    name,
    target,
    shallow: Boolean(shallow),
    token: trimText(token),
    cloneUrl: authenticatedCloneUrl(source, token, provider),
  };
}

function cloneGitArgs(prepared) {
  const args = ['clone'];
  if (prepared.shallow) args.push('--depth', '1');
  args.push('--', prepared.cloneUrl, prepared.target);
  return args;
}

function cloneRepository(options) {
  const prepared = prepareClone(options);
  return new Promise((resolve, reject) => {
    execFile('git', cloneGitArgs(prepared), {
      windowsHide: true,
      encoding: 'utf8',
      timeout: 10 * 60 * 1000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
      },
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(redactSecret(stderr || stdout || error.message || '克隆失败', prepared.token).trim() || '克隆失败'));
        return;
      }
      resolve({ ok: true, path: prepared.target, name: prepared.name });
    });
  });
}

module.exports = {
  folderNameFromUrl,
  resolveCloneUrl,
  authenticatedCloneUrl,
  redactSecret,
  prepareClone,
  cloneGitArgs,
  cloneRepository,
};
