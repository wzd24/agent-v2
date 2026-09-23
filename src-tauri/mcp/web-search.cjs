'use strict';

const http = require('node:http');
const https = require('node:https');

const MAX_BYTES = 400 * 1024;

function decodeEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)));
}

function assertHttpUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error('URL 无效'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 HTTP/HTTPS');
  return url;
}

function decodeDuckLink(href) {
  const raw = decodeEntities(String(href || '').trim());
  try {
    const url = new URL(raw.startsWith('//') ? `https:${raw}` : raw, 'https://duckduckgo.com');
    return url.searchParams.get('uddg') || url.toString();
  } catch {
    return raw;
  }
}

function parseDuckDuckGoHtml(html, limit = 8) {
  const results = [];
  const pattern = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match = pattern.exec(html);
  while (match && results.length < Math.max(1, Number(limit) || 8)) {
    const url = decodeDuckLink(match[1]);
    const title = decodeEntities(match[2].replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
    if (url && title && !results.some((item) => item.url === url)) results.push({ title, url });
    match = pattern.exec(html);
  }
  return results;
}

function fetchText(url, options = {}) {
  const target = assertHttpUrl(url);
  if (typeof options.fetch === 'function') return Promise.resolve(options.fetch(target.toString()));
  const hops = Number(options.redirects ?? 3);
  return new Promise((resolve, reject) => {
    const client = target.protocol === 'http:' ? http : https;
    const request = client.request(target, {
      method: 'GET',
      headers: { 'User-Agent': 'LocalCodex/0.1 (web-search)', Accept: 'text/html,text/plain,*/*' },
    }, (response) => {
      const status = Number(response.statusCode || 0);
      if (status >= 300 && status < 400 && response.headers.location && hops > 0) {
        response.resume();
        const next = new URL(response.headers.location, target);
        fetchText(next.toString(), { ...options, redirects: hops - 1 }).then(resolve, reject);
        return;
      }
      if (status >= 400) {
        response.resume();
        reject(new Error(`请求失败：${status}`));
        return;
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          request.destroy();
          reject(new Error('响应过大'));
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      response.on('error', reject);
    });
    request.setTimeout(15000, () => request.destroy(new Error('请求超时')));
    request.on('error', reject);
    request.end();
  });
}

function stripHtml(html) {
  return decodeEntities(String(html || '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

async function searchWeb(query, limit = 8, options = {}) {
  const text = String(query || '').trim();
  if (!text) throw new Error('搜索词不能为空');
  const html = await fetchText(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(text)}`, options);
  return parseDuckDuckGoHtml(html, limit);
}

async function fetchPage(url, options = {}) {
  const html = await fetchText(url, options);
  return stripHtml(html).slice(0, 8000);
}

function isEnabled(preferences = {}) {
  return preferences.web_search_enabled !== false;
}

module.exports = {
  MAX_BYTES,
  assertHttpUrl,
  decodeDuckLink,
  parseDuckDuckGoHtml,
  fetchText,
  stripHtml,
  searchWeb,
  fetchPage,
  isEnabled,
};
