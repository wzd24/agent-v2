'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const CJK_RE = /[\u3000-\u30ff\u3400-\u9fff\uf900-\ufaff]/;

function hasCjk(value) {
  return CJK_RE.test(String(value || ''));
}

function firstExisting(paths) {
  return paths.find((candidate) => candidate && fs.existsSync(candidate)) || '';
}

function systemFontCandidates() {
  const win = process.env.WINDIR || 'C:\\Windows';
  return [
    path.join(win, 'Fonts', 'msyh.ttc'),
    path.join(win, 'Fonts', 'msyh.ttf'),
    path.join(win, 'Fonts', 'msyhl.ttc'),
    path.join(win, 'Fonts', 'simhei.ttf'),
    path.join(win, 'Fonts', 'simsun.ttc'),
    path.join(win, 'Fonts', 'simkai.ttf'),
    path.join(win, 'Fonts', 'Deng.ttf'),
    path.join(win, 'Fonts', 'msjh.ttc'),
    '/System/Library/Fonts/STHeiti Light.ttc',
    '/System/Library/Fonts/PingFang.ttc',
    '/Library/Fonts/Arial Unicode.ttf',
    '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
    '/usr/share/fonts/truetype/wqy/wqy-microhei.ttc',
    '/usr/share/fonts/truetype/arphic/uming.ttc',
  ];
}

function findCjkFont() {
  const file = firstExisting(systemFontCandidates());
  return file ? { file, name: path.basename(file) } : null;
}

function readU16(buffer, offset) { return buffer.readUInt16BE(offset); }
function readI16(buffer, offset) { return buffer.readInt16BE(offset); }
function readU32(buffer, offset) { return buffer.readUInt32BE(offset); }

function tableMap(buffer, start) {
  const numTables = readU16(buffer, start + 4);
  const tables = new Map();
  for (let index = 0; index < numTables; index += 1) {
    const record = start + 12 + index * 16;
    tables.set(buffer.toString('ascii', record, record + 4), {
      offset: readU32(buffer, record + 8),
      length: readU32(buffer, record + 12),
    });
  }
  return tables;
}

function faceStarts(buffer) {
  const tag = buffer.toString('ascii', 0, 4);
  if (tag !== 'ttcf') return [0];
  const count = readU32(buffer, 8);
  const starts = [];
  for (let index = 0; index < count; index += 1) starts.push(readU32(buffer, 12 + index * 4));
  return starts;
}

function sliceTable(buffer, tables, name) {
  const table = tables.get(name);
  if (!table) return null;
  return buffer.subarray(table.offset, table.offset + table.length);
}

function parseCmap(cmap) {
  const maps = new Map();
  const numTables = readU16(cmap, 2);
  const records = [];
  for (let index = 0; index < numTables; index += 1) {
    records.push({
      platform: readU16(cmap, 4 + index * 8),
      encoding: readU16(cmap, 6 + index * 8),
      offset: readU32(cmap, 8 + index * 8),
    });
  }
  const preferred = records.find((item) => item.platform === 0 && (item.encoding === 4 || item.encoding === 3))
    || records.find((item) => item.platform === 3 && item.encoding === 10)
    || records.find((item) => item.platform === 3 && item.encoding === 1)
    || records[0];
  if (!preferred) return maps;
  const offset = preferred.offset;
  const format = readU16(cmap, offset);
  if (format === 4) {
    const segCount = readU16(cmap, offset + 6) / 2;
    const endOff = offset + 14;
    const startOff = endOff + 2 + segCount * 2;
    const deltaOff = startOff + segCount * 2;
    const rangeOff = deltaOff + segCount * 2;
    for (let index = 0; index < segCount; index += 1) {
      const end = readU16(cmap, endOff + index * 2);
      const start = readU16(cmap, startOff + index * 2);
      const delta = readI16(cmap, deltaOff + index * 2);
      const range = readU16(cmap, rangeOff + index * 2);
      for (let code = start; code <= end; code += 1) {
        let glyph = 0;
        if (range === 0) glyph = (code + delta) & 0xffff;
        else {
          const glyphOffset = rangeOff + index * 2 + range + (code - start) * 2;
          glyph = readU16(cmap, glyphOffset);
          if (glyph) glyph = (glyph + delta) & 0xffff;
        }
        if (glyph) maps.set(code, glyph);
      }
    }
  } else if (format === 12) {
    const nGroups = readU32(cmap, offset + 12);
    for (let index = 0; index < nGroups; index += 1) {
      const group = offset + 16 + index * 12;
      const start = readU32(cmap, group);
      const end = readU32(cmap, group + 4);
      const glyph = readU32(cmap, group + 8);
      for (let code = start; code <= end; code += 1) maps.set(code, glyph + (code - start));
    }
  }
  return maps;
}

function locaOffsets(loca, glyfCount, long) {
  const offsets = [];
  for (let index = 0; index <= glyfCount; index += 1) {
    offsets.push(long ? readU32(loca, index * 4) : readU16(loca, index * 2) * 2);
  }
  return offsets;
}

function collectComponents(glyf, locaOff, glyph, seen) {
  if (seen.has(glyph)) return;
  seen.add(glyph);
  const start = locaOff[glyph];
  const end = locaOff[glyph + 1];
  if (end <= start || start + 2 > glyf.length) return;
  const contours = readI16(glyf, start);
  if (contours >= 0) return;
  let offset = start + 10;
  while (offset + 4 <= end) {
    const flags = readU16(glyf, offset);
    const child = readU16(glyf, offset + 2);
    collectComponents(glyf, locaOff, child, seen);
    offset += 4;
    if (flags & 0x0001) offset += 4; else offset += 2;
    if (flags & 0x0008) offset += 2;
    else if (flags & 0x0040) offset += 4;
    else if (flags & 0x0080) offset += 8;
    if (!(flags & 0x0020)) break;
  }
}

function rewriteComposite(glyfSlice, remap) {
  if (glyfSlice.length < 2 || readI16(glyfSlice, 0) >= 0) return Buffer.from(glyfSlice);
  const next = Buffer.from(glyfSlice);
  let offset = 10;
  while (offset + 4 <= next.length) {
    const flags = readU16(next, offset);
    const child = readU16(next, offset + 2);
    next.writeUInt16BE(remap.get(child) || 0, offset + 2);
    offset += 4;
    if (flags & 0x0001) offset += 4; else offset += 2;
    if (flags & 0x0008) offset += 2;
    else if (flags & 0x0040) offset += 4;
    else if (flags & 0x0080) offset += 8;
    if (!(flags & 0x0020)) break;
  }
  return next;
}

function checksum(buffer) {
  const padded = Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4)]);
  let sum = 0;
  for (let index = 0; index < padded.length; index += 4) sum = (sum + padded.readUInt32BE(index)) >>> 0;
  return sum;
}

function buildTable(tag, data) {
  return {
    tag,
    length: data.length,
    data: Buffer.concat([data, Buffer.alloc((4 - (data.length % 4)) % 4)]),
  };
}

function encodeCmap(codeToGlyph) {
  const pairs = [...codeToGlyph.entries()].filter(([code]) => code <= 0xffff).sort((left, right) => left[0] - right[0]);
  const segments = [];
  for (const [code, glyph] of pairs) {
    const last = segments[segments.length - 1];
    if (last && code === last.end + 1 && glyph === last.glyph + (last.end - last.start) + 1) last.end = code;
    else segments.push({ start: code, end: code, glyph });
  }
  segments.push({ start: 0xffff, end: 0xffff, glyph: 0 });
  const segCount = segments.length;
  const searchRange = 2 * (2 ** Math.floor(Math.log2(segCount)));
  const body = Buffer.alloc(16 + segCount * 8);
  body.writeUInt16BE(4, 0);
  body.writeUInt16BE(body.length, 2);
  body.writeUInt16BE(segCount * 2, 6);
  body.writeUInt16BE(searchRange, 8);
  body.writeUInt16BE(Math.log2(searchRange / 2), 10);
  body.writeUInt16BE(segCount * 2 - searchRange, 12);
  for (let index = 0; index < segCount; index += 1) {
    body.writeUInt16BE(segments[index].end, 14 + index * 2);
    body.writeUInt16BE(segments[index].start, 16 + segCount * 2 + index * 2);
    body.writeUInt16BE((segments[index].glyph - segments[index].start) & 0xffff, 16 + segCount * 4 + index * 2);
    body.writeUInt16BE(0, 16 + segCount * 6 + index * 2);
  }
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0, 0);
  header.writeUInt16BE(1, 2);
  const record = Buffer.alloc(8);
  record.writeUInt16BE(3, 0);
  record.writeUInt16BE(1, 2);
  record.writeUInt32BE(12, 4);
  return Buffer.concat([header, record, body]);
}

function subsetFace(buffer, start, text) {
  const sfnt = buffer.toString('ascii', start, start + 4);
  if (sfnt === 'OTTO') throw new Error('不支持 CFF 字体');
  const tables = tableMap(buffer, start);
  const cmap = sliceTable(buffer, tables, 'cmap');
  const loca = sliceTable(buffer, tables, 'loca');
  const glyf = sliceTable(buffer, tables, 'glyf');
  const head = sliceTable(buffer, tables, 'head');
  const hhea = sliceTable(buffer, tables, 'hhea');
  const hmtx = sliceTable(buffer, tables, 'hmtx');
  const maxp = sliceTable(buffer, tables, 'maxp');
  if (!cmap || !loca || !glyf || !head || !hhea || !hmtx || !maxp) throw new Error('字体缺少 TrueType 表');
  const unitsPerEm = readU16(head, 18);
  const longLoca = readI16(head, 50) === 1;
  const numGlyphs = readU16(maxp, 4);
  const numberOfHMetrics = readU16(hhea, 34);
  const cmapMap = parseCmap(cmap);
  const locaOff = locaOffsets(loca, numGlyphs, longLoca);
  const needed = new Set([0]);
  const codes = [...new Set([...String(text || '')].map((char) => char.codePointAt(0)).filter((code) => code && code > 31))];
  for (const code of codes) {
    const glyph = cmapMap.get(code);
    if (glyph) collectComponents(glyf, locaOff, glyph, needed);
  }
  const oldGlyphs = [...needed].sort((left, right) => left - right);
  const remap = new Map(oldGlyphs.map((glyph, index) => [glyph, index]));
  const newGlyfs = [];
  const advances = [];
  for (const glyph of oldGlyphs) {
    const startOff = locaOff[glyph];
    const endOff = locaOff[glyph + 1];
    const slice = rewriteComposite(glyf.subarray(startOff, endOff), remap);
    newGlyfs.push(slice.length % 2 ? Buffer.concat([slice, Buffer.alloc(1)]) : slice);
    if (glyph < numberOfHMetrics) advances.push(readU16(hmtx, glyph * 4));
    else advances.push(readU16(hmtx, (numberOfHMetrics - 1) * 4));
  }
  const newLoca = Buffer.alloc((oldGlyphs.length + 1) * 4);
  let offset = 0;
  newGlyfs.forEach((item, index) => {
    newLoca.writeUInt32BE(offset, index * 4);
    offset += item.length;
  });
  newLoca.writeUInt32BE(offset, oldGlyphs.length * 4);
  const newHmtx = Buffer.alloc(oldGlyphs.length * 4);
  advances.forEach((width, index) => newHmtx.writeUInt16BE(width, index * 4));
  const newMaxp = Buffer.from(maxp);
  newMaxp.writeUInt16BE(oldGlyphs.length, 4);
  const newHead = Buffer.from(head);
  newHead.writeInt16BE(1, 50);
  newHead.writeUInt32BE(0, 8);
  const newHhea = Buffer.from(hhea);
  newHhea.writeUInt16BE(oldGlyphs.length, 34);
  const codeToGlyph = new Map();
  for (const code of codes) {
    const glyph = cmapMap.get(code);
    if (glyph != null && remap.has(glyph)) codeToGlyph.set(code, remap.get(glyph));
  }
  const built = [
    buildTable('cmap', encodeCmap(codeToGlyph)),
    buildTable('glyf', Buffer.concat(newGlyfs)),
    buildTable('head', newHead),
    buildTable('hhea', newHhea),
    buildTable('hmtx', newHmtx),
    buildTable('loca', newLoca),
    buildTable('maxp', newMaxp),
  ];
  for (const extra of ['OS/2', 'name', 'post']) {
    const table = sliceTable(buffer, tables, extra);
    if (table) built.push(buildTable(extra, Buffer.from(table)));
  }
  built.sort((left, right) => (left.tag < right.tag ? -1 : 1));
  const header = Buffer.alloc(12);
  header.writeUInt32BE(0x00010000, 0);
  header.writeUInt16BE(built.length, 4);
  const searchRange = 16 * (2 ** Math.floor(Math.log2(built.length)));
  header.writeUInt16BE(searchRange, 6);
  header.writeUInt16BE(Math.log2(searchRange / 16), 8);
  header.writeUInt16BE(built.length * 16 - searchRange, 10);
  const records = Buffer.alloc(built.length * 16);
  let cursor = header.length + records.length;
  built.forEach((table, index) => {
    const record = index * 16;
    records.write(table.tag, record, 4, 'ascii');
    records.writeUInt32BE(checksum(table.data), record + 4);
    records.writeUInt32BE(cursor, record + 8);
    records.writeUInt32BE(table.length, record + 12);
    cursor += table.data.length;
  });
  const font = Buffer.concat([header, records, ...built.map((table) => table.data)]);
  const headOffset = header.length + records.length + built.slice(0, built.findIndex((table) => table.tag === 'head')).reduce((sum, table) => sum + table.data.length, 0);
  font.writeUInt32BE(0, headOffset + 8);
  font.writeUInt32BE((0xB1B0AFBA - checksum(font)) >>> 0, headOffset + 8);
  return {
    buffer: font,
    unitsPerEm,
    ascent: readI16(hhea, 4),
    descent: readI16(hhea, 6),
    xMin: readI16(head, 36),
    yMin: readI16(head, 38),
    xMax: readI16(head, 40),
    yMax: readI16(head, 42),
    advances,
    codeToGlyph,
    glyphCount: oldGlyphs.length,
  };
}

function subsetFont(file, text) {
  const buffer = fs.readFileSync(file);
  let lastError = new Error('无法子集化字体');
  for (const start of faceStarts(buffer)) {
    try { return subsetFace(buffer, start, text); }
    catch (error) { lastError = error; }
  }
  throw lastError;
}

function pdfHex(bytes) {
  return bytes.toString('hex').toUpperCase();
}

function encodeText(text, codeToGlyph) {
  const ids = [...String(text || '')].map((char) => {
    const code = char.codePointAt(0);
    return codeToGlyph.get(code) || 0;
  });
  return `<${ids.map((id) => id.toString(16).padStart(4, '0')).join('')}>`;
}

function buildToUnicode(codeToGlyph) {
  const pairs = [...codeToGlyph.entries()];
  const lines = pairs.map(([code, glyph]) => `<${glyph.toString(16).padStart(4, '0')}> <${code.toString(16).padStart(4, '0')}>`);
  const chunks = [];
  for (let index = 0; index < lines.length; index += 100) chunks.push(lines.slice(index, index + 100));
  return `/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n${chunks.map((chunk) => `${chunk.length} beginbfchar\n${chunk.join('\n')}\nendbfchar`).join('\n')}\nendcmap\nCMapName currentdict /CMap defineresource pop\nend\nend`;
}

function scale(value, unitsPerEm) {
  return Math.round((Number(value) * 1000) / (unitsPerEm || 1000));
}

function fontObjectTexts(subset) {
  const compressed = zlib.deflateSync(subset.buffer);
  const widths = subset.advances.map((width) => scale(width, subset.unitsPerEm));
  const bbox = [subset.xMin, subset.yMin, subset.xMax, subset.yMax].map((value) => scale(value, subset.unitsPerEm));
  const toUnicode = buildToUnicode(subset.codeToGlyph);
  return {
    compressed,
    length1: subset.buffer.length,
    widths,
    bbox,
    toUnicode,
    ascent: scale(subset.ascent, subset.unitsPerEm),
    descent: scale(subset.descent, subset.unitsPerEm),
    encode: (text) => encodeText(text, subset.codeToGlyph),
  };
}

module.exports = {
  CJK_RE,
  hasCjk,
  findCjkFont,
  subsetFont,
  encodeText,
  fontObjectTexts,
  systemFontCandidates,
};
