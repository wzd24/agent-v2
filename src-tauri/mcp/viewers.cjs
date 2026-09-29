'use strict';

const path = require('node:path');
const zlib = require('node:zlib');

const EXTRA = new Set([
  '.csv', '.tsv', '.xls', '.ppt',
  '.odt', '.ods', '.odp',
  '.epub', '.xmind',
  '.zip', '.jar', '.apk', '.vsix', '.crx', '.7z', '.rar',
  '.tar', '.tgz', '.gz',
  '.ttf', '.otf', '.woff', '.woff2',
  '.psd', '.icns', '.tif', '.tiff', '.heic', '.heif', '.parquet',
]);

function handles(filePath) {
  const base = path.basename(String(filePath || '')).toLowerCase();
  if (base.endsWith('.tar.gz')) return true;
  return EXTRA.has(path.extname(base));
}

function preview(filePath, buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const base = path.basename(String(filePath || '')).toLowerCase();
  const ext = path.extname(base);
  if (ext === '.csv') return delimited(source, ',', 'Sheet1');
  if (ext === '.tsv') return delimited(source, '\t', 'Sheet1');
  if (ext === '.xls' || ext === '.ppt') {
    throw new Error('暂不支持旧版二进制 Office 格式，请另存为 .xlsx 或 .pptx 后再预览');
  }
  if (ext === '.odt') return readOdt(source);
  if (ext === '.ods') return readOds(source);
  if (ext === '.odp') return readOdp(source);
  if (ext === '.epub') return readEpub(source);
  if (ext === '.xmind') return readXmind(source);
  if (ext === '.ttf' || ext === '.otf' || ext === '.woff' || ext === '.woff2') return readFont(filePath, source);
  if (ext === '.psd') return { kind: 'psd', text: 'Photoshop' };
  if (ext === '.icns') return { kind: 'icns', text: 'Apple 图标' };
  if (ext === '.tif' || ext === '.tiff') return { kind: 'tiff', text: 'TIFF' };
  if (ext === '.heic' || ext === '.heif') return { kind: 'heic', text: 'HEIC' };
  if (ext === '.parquet') return { kind: 'parquet', text: 'Parquet' };
  if (ext === '.7z' || ext === '.rar') return { kind: 'archive', format: ext.slice(1), entries: [], total: 0, text: ext.slice(1) };
  if (base.endsWith('.tar.gz') || ext === '.tgz') return archiveFromEntries('tar.gz', readTar(gunzipLimited(source)));
  if (ext === '.tar') return archiveFromEntries('tar', readTar(source));
  if (ext === '.gz') return readGzip(filePath, source);
  return readZipArchive(ext.slice(1) || 'zip', source);
}

function delimited(buffer, separator, name) {
  const text = buffer.toString('utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const rows = text.split('\n').filter((line) => line.length).map((line) => splitDelimited(line, separator));
  return { kind: 'spreadsheet', sheets: [{ name, rows }], text };
}

function splitDelimited(line, separator) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const ch = line[index];
    if (ch === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (ch === separator && !quoted) {
      cells.push(current);
      current = '';
    } else current += ch;
  }
  cells.push(current);
  return cells;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripTags(value) {
  return decodeXml(String(value || '')
    .replace(/<br\b[^>]*\/?>/gi, '\n')
    .replace(/<\/(?:p|h[1-6]|div|li|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\u00a0/g, ' '))
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function gunzipLimited(buffer) {
  const max = 24 * 1024 * 1024;
  let output;
  try {
    output = zlib.gunzipSync(buffer, { maxOutputLength: max });
  } catch (error) {
    const message = String(error && error.message || error);
    if (/max|too large|output/i.test(message)) throw new Error('解压后内容过大，暂不支持预览');
    throw new Error('无法解压 gzip 文件');
  }
  if (output.length > max) throw new Error('解压后内容过大，暂不支持预览');
  return output;
}

function findEocd(source) {
  const min = Math.max(0, source.length - 22 - 65535);
  for (let offset = source.length - 22; offset >= min; offset -= 1) {
    if (source.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function zipPayload(source) {
  if (source.length >= 4 && source.readUInt32LE(0) === 0x04034b50) return source;
  const signature = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  const index = source.indexOf(signature);
  if (index > 0 && index < 65536) return source.subarray(index);
  return source;
}

function zipCatalog(buffer) {
  const source = zipPayload(buffer);
  const eocd = findEocd(source);
  if (eocd < 0) throw new Error('不是有效的压缩包');
  const count = source.readUInt16LE(eocd + 8);
  if (count === 0xffff || source.readUInt32LE(eocd + 16) === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 压缩包');
  }
  let offset = source.readUInt32LE(eocd + 16);
  const entries = [];
  for (let index = 0; index < count && offset + 46 <= source.length; index += 1) {
    if (source.readUInt32LE(offset) !== 0x02014b50) break;
    const flags = source.readUInt16LE(offset + 8);
    const method = source.readUInt16LE(offset + 10);
    const compressedSize = source.readUInt32LE(offset + 20);
    const rawSize = source.readUInt32LE(offset + 24);
    const nameLen = source.readUInt16LE(offset + 28);
    const extraLen = source.readUInt16LE(offset + 30);
    const commentLen = source.readUInt16LE(offset + 32);
    const localOffset = source.readUInt32LE(offset + 42);
    const nameBuf = source.subarray(offset + 46, offset + 46 + nameLen);
    const name = decodeZipName(nameBuf, flags);
    entries.push({
      name,
      method,
      compressedSize,
      rawSize,
      localOffset,
      directory: name.endsWith('/'),
    });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return { source, entries };
}

function decodeZipName(buffer, flags) {
  if (flags & 0x800) return buffer.toString('utf8');
  const utf8 = buffer.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  return buffer.toString('latin1');
}

function zipExtract(catalog, entry) {
  if (entry.directory) return Buffer.alloc(0);
  if (entry.rawSize > 8 * 1024 * 1024) throw new Error('压缩包内文件过大');
  const { source } = catalog;
  const local = entry.localOffset;
  if (local + 30 > source.length || source.readUInt32LE(local) !== 0x04034b50) throw new Error('压缩包目录损坏');
  const nameLen = source.readUInt16LE(local + 26);
  const extraLen = source.readUInt16LE(local + 28);
  const start = local + 30 + nameLen + extraLen;
  const payload = source.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return payload.subarray(0, entry.rawSize || payload.length);
  if (entry.method === 8) return zlib.inflateRawSync(payload);
  throw new Error('压缩包使用了不支持的压缩方式');
}

function zipText(buffer, name) {
  const catalog = zipCatalog(buffer);
  const entry = catalog.entries.find((item) => item.name === name);
  if (!entry) throw new Error(`压缩包中缺少 ${name}`);
  return zipExtract(catalog, entry).toString('utf8');
}

function archiveFromEntries(format, entries) {
  const visible = entries.filter((entry) => entry.name && entry.name !== './');
  const limited = visible.slice(0, 4000);
  return {
    kind: 'archive',
    format,
    total: visible.length,
    truncated: visible.length > limited.length,
    entries: limited.map((entry) => ({
      name: entry.name,
      size: entry.directory ? 0 : Number(entry.size || entry.rawSize || 0),
      directory: Boolean(entry.directory),
    })),
    text: limited.slice(0, 80).map((entry) => entry.name).join('\n'),
  };
}

function readZipArchive(format, buffer) {
  const catalog = zipCatalog(buffer);
  return archiveFromEntries(format, catalog.entries.map((entry) => ({
    name: entry.name,
    size: entry.rawSize,
    directory: entry.directory,
  })));
}

function readTar(buffer) {
  const entries = [];
  let offset = 0;
  let longName = '';
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const rawName = cString(header.subarray(0, 100));
    const size = parseInt(cString(header.subarray(124, 136)), 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const prefix = cString(header.subarray(345, 500));
    offset += 512;
    const dataEnd = Math.min(buffer.length, offset + size);
    const data = buffer.subarray(offset, dataEnd);
    offset += Math.ceil(size / 512) * 512;
    if (type === 'L' || type === 'K') {
      longName = data.toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    const name = (longName || (prefix ? `${prefix}/${rawName}` : rawName)).replace(/^\.?\//, '');
    longName = '';
    if (!name) continue;
    entries.push({ name, size, directory: type === '5' || name.endsWith('/') });
    if (entries.length > 5000) break;
  }
  if (!entries.length) throw new Error('不是有效的 tar 归档');
  return entries;
}

function cString(buffer) {
  return buffer.toString('utf8').replace(/\0.*$/, '').trim();
}

function readGzip(filePath, buffer) {
  const raw = gunzipLimited(buffer);
  if (raw.length >= 262 && raw.subarray(257, 262).toString('utf8') === 'ustar') {
    return archiveFromEntries('tar.gz', readTar(raw));
  }
  const name = path.basename(filePath).replace(/\.gz$/i, '') || 'file';
  const text = looksText(raw) ? raw.toString('utf8').slice(0, 20000) : '';
  return {
    kind: 'archive',
    format: 'gzip',
    total: 1,
    truncated: raw.length > 20000 && Boolean(text),
    entries: [{ name, size: raw.length, directory: false }],
    text,
  };
}

function looksText(buffer) {
  const sample = buffer.subarray(0, 4000);
  if (sample.includes(0)) return false;
  const text = sample.toString('utf8');
  const bad = (text.match(/\uFFFD/g) || []).length;
  return bad < 4;
}

function readOdt(buffer) {
  const xml = zipText(buffer, 'content.xml');
  const blocks = [...xml.matchAll(/<text:(?:p|h)\b[^>]*>([\s\S]*?)<\/text:(?:p|h)>/g)].map((match) => stripTags(match[1]));
  const text = blocks.filter(Boolean).join('\n');
  if (!text && !xml.includes('<office:document')) throw new Error('不是有效的 OpenDocument 文本');
  return { kind: 'document', text };
}

function readOds(buffer) {
  const xml = zipText(buffer, 'content.xml');
  const tables = [...xml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/g)];
  if (!tables.length) throw new Error('不是有效的 OpenDocument 表格');
  const sheets = tables.slice(0, 30).map((table, index) => {
    const name = decodeXml(/table:name="([^"]*)"/.exec(table[1])?.[1] || `Sheet${index + 1}`);
    const rows = [];
    for (const row of table[2].matchAll(/<table:table-row\b([^>]*)>([\s\S]*?)<\/table:table-row>|<table:table-row\b([^>]*)\/>/g)) {
      const repeatRow = Math.min(Number(/table:number-rows-repeated="(\d+)"/.exec(row[1] || row[3] || '')?.[1] || 1), 30);
      const cells = [];
      if (row[2]) {
        for (const cell of row[2].matchAll(/<table:table-cell\b([^>]*)(?:\/>|>([\s\S]*?)<\/table:table-cell>)/g)) {
          const repeat = Math.min(Number(/table:number-columns-repeated="(\d+)"/.exec(cell[1])?.[1] || 1), 40);
          const typed = /office:value-type="(?:float|currency|percentage)"/.test(cell[1]);
          const value = /office:value="([^"]*)"/.exec(cell[1])?.[1];
          const text = typed && value != null ? decodeXml(value) : stripTags(cell[2] || '');
          for (let copy = 0; copy < repeat; copy += 1) cells.push(text);
        }
      }
      for (let copy = 0; copy < repeatRow; copy += 1) rows.push(cells);
      if (rows.length >= 500) break;
    }
    return { name, rows };
  });
  return {
    kind: 'spreadsheet',
    sheets,
    text: sheets.map((sheet) => sheet.rows.map((row) => row.join('\t')).join('\n')).join('\n\n'),
  };
}

function readOdp(buffer) {
  const xml = zipText(buffer, 'content.xml');
  const pages = [...xml.matchAll(/<draw:page\b([^>]*)>([\s\S]*?)<\/draw:page>/g)];
  if (!pages.length) throw new Error('不是有效的 OpenDocument 演示文稿');
  const slides = pages.map((page, index) => ({
    name: decodeXml(/draw:name="([^"]*)"/.exec(page[1])?.[1] || `page${index + 1}`),
    text: [...page[2].matchAll(/<text:p\b[^>]*>([\s\S]*?)<\/text:p>/g)].map((match) => stripTags(match[1])).filter(Boolean).join('\n'),
  }));
  return { kind: 'presentation', slides, text: slides.map((slide) => slide.text).join('\n\n') };
}

function readEpub(buffer) {
  const catalog = zipCatalog(buffer);
  const container = textEntry(catalog, 'META-INF/container.xml');
  const opfPath = decodeXml(/full-path="([^"]+)"/.exec(container || '')?.[1] || '');
  const opf = opfPath ? textEntry(catalog, opfPath) : '';
  if (!opf) throw new Error('不是有效的 EPUB');
  const title = stripTags(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)?.[1] || '') || path.basename(opfPath);
  const creator = stripTags(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opf)?.[1] || '');
  const manifest = new Map();
  for (const item of opf.matchAll(/<item\b([^>]*?)\/?>/g)) {
    const id = /id="([^"]+)"/.exec(item[1])?.[1];
    const href = /href="([^"]+)"/.exec(item[1])?.[1];
    if (id && href) manifest.set(id, decodeXml(href));
  }
  const spine = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((match) => manifest.get(match[1])).filter(Boolean);
  const chapters = [];
  let used = 0;
  for (const href of spine.slice(0, 80)) {
    if (used > 120000) break;
    const full = joinZip(opfPath, href);
    const entry = catalog.entries.find((item) => item.name === full);
    if (!entry || entry.directory || entry.rawSize > 1500000) continue;
    let html = '';
    try { html = zipExtract(catalog, entry).toString('utf8'); } catch { continue; }
    const text = stripTags(html).slice(0, 20000);
    used += text.length;
    chapters.push({
      title: chapterTitle(html, href),
      href: full,
      text,
    });
  }
  return {
    kind: 'epub',
    title,
    creator,
    chapters,
    text: [title, creator, ...chapters.map((chapter) => `${chapter.title}\n${chapter.text}`)].filter(Boolean).join('\n\n'),
  };
}

function textEntry(catalog, name) {
  const entry = catalog.entries.find((item) => item.name === name);
  if (!entry) return '';
  try { return zipExtract(catalog, entry).toString('utf8'); } catch { return ''; }
}

function joinZip(base, href) {
  const clean = String(href || '').split('#')[0].split('?')[0];
  const parts = String(base || '').split('/').slice(0, -1);
  for (const part of clean.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function chapterTitle(html, href) {
  const heading = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  if (heading) return stripTags(heading[1]).slice(0, 160) || path.basename(href);
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (title) return stripTags(title[1]).slice(0, 160) || path.basename(href);
  return path.basename(href);
}

function readXmind(buffer) {
  const catalog = zipCatalog(buffer);
  const jsonEntry = catalog.entries.find((entry) => entry.name === 'content.json');
  if (jsonEntry) {
    const data = JSON.parse(zipExtract(catalog, jsonEntry).toString('utf8'));
    const sheets = (Array.isArray(data) ? data : [data]).slice(0, 12).map((sheet, index) => {
      const lines = [];
      const root = topicNode(sheet.rootTopic || sheet, lines, 0);
      return { name: String(sheet.title || `画布 ${index + 1}`), root, text: lines.join('\n') };
    });
    return {
      kind: 'xmind',
      sheets,
      text: sheets.map((sheet) => sheet.text).join('\n\n'),
    };
  }
  const xmlEntry = catalog.entries.find((entry) => entry.name === 'content.xml');
  if (!xmlEntry) throw new Error('不是有效的 XMind 文件');
  const nodes = parseXmindXml(zipExtract(catalog, xmlEntry).toString('utf8'));
  const lines = [];
  flattenNodes(nodes, lines, 0);
  return { kind: 'xmind', sheets: [{ name: '思维导图', root: { title: nodes[0]?.title || '思维导图', children: nodes[0]?.children || nodes }, text: lines.join('\n') }], text: lines.join('\n') };
}

function topicNode(topic, lines, depth) {
  if (!topic || depth > 12) return { title: '', children: [] };
  const title = String(topic.title || '未命名');
  lines.push(`${'  '.repeat(depth)}${title}`);
  const attached = topic.children?.attached || topic.children?.detached || [];
  const list = Array.isArray(attached) ? attached.slice(0, 200) : [];
  return { title, children: list.map((child) => topicNode(child, lines, depth + 1)) };
}

function parseXmindXml(xml) {
  const root = [];
  const stack = [{ children: root }];
  const pattern = /<topic\b[^>]*>|<\/topic>|<title>([\s\S]*?)<\/title>/g;
  let current = null;
  for (const match of xml.matchAll(pattern)) {
    if (match[0].startsWith('<topic')) {
      const node = { title: '', children: [] };
      stack[stack.length - 1].children.push(node);
      stack.push(node);
      current = node;
    } else if (match[0] === '</topic>') {
      if (stack.length > 1) stack.pop();
      current = stack[stack.length - 1].children ? stack[stack.length - 1] : current;
      if (stack.length > 1) current = stack[stack.length - 1];
    } else if (current && !current.title) current.title = stripTags(match[1]);
  }
  return root;
}

function flattenNodes(nodes, lines, depth) {
  for (const node of nodes || []) {
    lines.push(`${'  '.repeat(depth)}${node.title || '未命名'}`);
    flattenNodes(node.children, lines, depth + 1);
  }
}

function readFont(filePath, buffer) {
  const ext = path.extname(filePath).toLowerCase();
  const format = ext === '.otf' ? 'opentype' : ext === '.woff' ? 'woff' : ext === '.woff2' ? 'woff2' : 'truetype';
  const fallback = path.basename(filePath, ext);
  let family = fallback;
  let fullName = fallback;
  try {
    const names = readFontNames(buffer);
    if (names.family) family = names.family;
    if (names.fullName) fullName = names.fullName;
  } catch {
    /* 名称表缺失时仍用文件名做字形预览 */
  }
  return { kind: 'font', format, family, fullName, text: fullName };
}

function readFontNames(buffer) {
  const signature = buffer.toString('latin1', 0, 4);
  let table = null;
  if (signature === 'wOFF') table = woffTable(buffer, 'name');
  else if (signature !== 'wOF2') table = sfntTable(buffer, 'name');
  if (!table) return {};
  return parseNameTable(table);
}

function sfntTable(buffer, tag) {
  if (buffer.length < 12) return null;
  const count = buffer.readUInt16BE(4);
  for (let index = 0; index < count; index += 1) {
    const offset = 12 + index * 16;
    if (offset + 16 > buffer.length) return null;
    if (buffer.toString('latin1', offset, offset + 4) !== tag) continue;
    const start = buffer.readUInt32BE(offset + 8);
    const length = buffer.readUInt32BE(offset + 12);
    return buffer.subarray(start, start + length);
  }
  return null;
}

function woffTable(buffer, tag) {
  if (buffer.length < 44) return null;
  const count = buffer.readUInt16BE(12);
  for (let index = 0; index < count; index += 1) {
    const offset = 44 + index * 20;
    if (offset + 20 > buffer.length) return null;
    if (buffer.toString('latin1', offset, offset + 4) !== tag) continue;
    const start = buffer.readUInt32BE(offset + 4);
    const compLength = buffer.readUInt32BE(offset + 8);
    const origLength = buffer.readUInt32BE(offset + 12);
    const slice = buffer.subarray(start, start + compLength);
    if (compLength < origLength) return zlib.inflateSync(slice);
    return slice;
  }
  return null;
}

function decodeFontName(bytes, platform) {
  if (platform === 3 || platform === 0) {
    let text = '';
    for (let index = 0; index + 1 < bytes.length; index += 2) {
      text += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    }
    return text.replace(/\0/g, '').trim();
  }
  return bytes.toString('latin1').replace(/\0/g, '').trim();
}

function parseNameTable(table) {
  if (table.length < 6) return {};
  const count = table.readUInt16BE(2);
  const stringOffset = table.readUInt16BE(4);
  const names = {};
  for (let index = 0; index < count; index += 1) {
    const offset = 6 + index * 12;
    if (offset + 12 > table.length) break;
    const platform = table.readUInt16BE(offset);
    const nameId = table.readUInt16BE(offset + 6);
    const length = table.readUInt16BE(offset + 8);
    const start = stringOffset + table.readUInt16BE(offset + 10);
    if (![1, 4, 16].includes(nameId) || start + length > table.length) continue;
    const bytes = table.subarray(start, start + length);
    const text = decodeFontName(bytes, platform);
    if (!text) continue;
    if (nameId === 16) names.family = text;
    else if (nameId === 1 && !names.family) names.family = text;
    else if (nameId === 4) names.fullName = text;
  }
  return names;
}

module.exports = {
  handles,
  preview,
  readFontNames,
  splitDelimited,
};
