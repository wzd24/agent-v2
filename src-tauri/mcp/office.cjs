'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const pdfFont = require('./pdf-font.cjs');

const KINDS = ['document', 'spreadsheet', 'presentation', 'pdf'];

function xml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index];
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zipPack(files) {
  const chunks = [];
  const centrals = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.name.replaceAll('\\', '/'), 'utf8');
    const raw = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), 'utf8');
    const compressed = zlib.deflateRawSync(raw);
    const stored = compressed.length >= raw.length;
    const payload = stored ? raw : compressed;
    const method = stored ? 0 : 8;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, name]));
    offset += 30 + name.length + payload.length;
  }
  const directory = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, eocd]);
}

function zipRead(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const files = new Map();
  let offset = 0;
  while (offset + 30 <= source.length && source.readUInt32LE(offset) === 0x04034b50) {
    const method = source.readUInt16LE(offset + 8);
    const compressedSize = source.readUInt32LE(offset + 18);
    const rawSize = source.readUInt32LE(offset + 22);
    const nameSize = source.readUInt16LE(offset + 26);
    const extraSize = source.readUInt16LE(offset + 28);
    const name = source.subarray(offset + 30, offset + 30 + nameSize).toString('utf8');
    const start = offset + 30 + nameSize + extraSize;
    const payload = source.subarray(start, start + compressedSize);
    const data = method === 8 ? zlib.inflateRawSync(payload) : payload;
    files.set(name.replaceAll('\\', '/'), rawSize ? data.subarray(0, rawSize) : data);
    offset = start + compressedSize;
  }
  return files;
}

function stripXml(value) {
  return String(value || '')
    .replace(/<w:tab\b[^/]*\/>/g, '\t')
    .replace(/<w:br\b[^/]*\/>/g, '\n')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function blocksFromMarkdown(text) {
  return String(text || '').replace(/\r\n/g, '\n').split('\n').map((line) => {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) return { type: 'heading', level: heading[1].length, text: heading[2] };
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) return { type: 'bullet', text: bullet[1] };
    return { type: 'paragraph', text: line };
  }).filter((block) => block.text || block.type === 'paragraph');
}

function applyValues(value, values = {}) {
  if (Array.isArray(value)) return value.map((item) => applyValues(item, values));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, applyValues(item, values)]));
  }
  return String(value ?? '').replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (_, key) => (values[key] == null ? `{{${key}}}` : String(values[key])));
}

function coreProps(title, kind) {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xml(title)}</dc:title><dc:creator>Local Codex</dc:creator><cp:lastModifiedBy>Local Codex</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified><cp:contentStatus>${xml(kind)}</cp:contentStatus></cp:coreProperties>`;
}

function appProps(app) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>${xml(app)}</Application></Properties>`;
}

function createDocument({ title = '文档', body = '', paragraphs } = {}) {
  const blocks = Array.isArray(paragraphs) && paragraphs.length
    ? paragraphs.map((item) => (typeof item === 'string' ? { type: 'paragraph', text: item } : item))
    : blocksFromMarkdown(body);
  const content = (blocks.length ? blocks : [{ type: 'paragraph', text: '' }]).map((block) => {
    const text = `<w:r><w:t xml:space="preserve">${xml(block.text || ' ')}</w:t></w:r>`;
    if (block.type === 'heading') return `<w:p><w:pPr><w:pStyle w:val="Heading${Math.min(3, Number(block.level) || 1)}"/></w:pPr>${text}</w:p>`;
    if (block.type === 'bullet') return `<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>${text}</w:p>`;
    return `<w:p>${text}</w:p>`;
  }).join('');
  return zipPack([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: 'word/_rels/document.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>` },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${content}<w:sectPr/></w:body></w:document>` },
    { name: 'word/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:rPr><w:b/></w:rPr></w:style></w:styles>` },
    { name: 'word/numbering.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>` },
    { name: 'docProps/core.xml', data: coreProps(title, 'document') },
    { name: 'docProps/app.xml', data: appProps('Local Codex') },
  ]);
}

function readDocument(buffer) {
  const files = zipRead(buffer);
  const xmlSource = files.get('word/document.xml');
  if (!xmlSource) throw new Error('不是有效的 Word 文档');
  return { title: stripXml(files.get('docProps/core.xml')?.toString('utf8') || '').split('\n')[0] || '', text: stripXml(xmlSource.toString('utf8')) };
}

function createSpreadsheet({ title = '表格', sheets } = {}) {
  const book = (Array.isArray(sheets) && sheets.length ? sheets : [{ name: 'Sheet1', rows: [[title]] }]).map((sheet, index) => ({
    name: String(sheet.name || `Sheet${index + 1}`).slice(0, 31) || `Sheet${index + 1}`,
    rows: Array.isArray(sheet.rows) ? sheet.rows : [],
  }));
  const strings = [];
  const stringIndex = new Map();
  const intern = (value) => {
    const text = String(value ?? '');
    if (stringIndex.has(text)) return stringIndex.get(text);
    const next = strings.length;
    stringIndex.set(text, next);
    strings.push(text);
    return next;
  };
  const sheetFiles = book.map((sheet, index) => {
    const rows = sheet.rows.map((row, rowIndex) => {
      const cells = (Array.isArray(row) ? row : [row]).map((cell, col) => {
        const ref = `${String.fromCharCode(65 + (col % 26))}${rowIndex + 1}`;
        return `<c r="${ref}" t="s"><v>${intern(cell)}</v></c>`;
      }).join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    }).join('');
    return { name: `xl/worksheets/sheet${index + 1}.xml`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>` };
  });
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${book.map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')}</sheets></workbook>`;
  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${book.map((_, index) => `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`).join('')}<Relationship Id="rId${book.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId${book.length + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const shared = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((item) => `<si><t xml:space="preserve">${xml(item)}</t></si>`).join('')}</sst>`;
  const overrides = sheetFiles.map((file) => `<Override PartName="/${file.name}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('');
  return zipPack([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${overrides}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: workbook },
    { name: 'xl/_rels/workbook.xml.rels', data: rels },
    { name: 'xl/sharedStrings.xml', data: shared },
    { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf/></cellXfs></styleSheet>` },
    ...sheetFiles,
    { name: 'docProps/core.xml', data: coreProps(title, 'spreadsheet') },
    { name: 'docProps/app.xml', data: appProps('Local Codex') },
  ]);
}

function readSpreadsheet(buffer) {
  const files = zipRead(buffer);
  const shared = [...String(files.get('xl/sharedStrings.xml') || '').matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => stripXml(match[1]));
  const sheets = [];
  for (const [name, data] of files) {
    if (!name.startsWith('xl/worksheets/sheet') || !name.endsWith('.xml')) continue;
    const rows = [];
    for (const row of String(data).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [...row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)].map((cell) => {
        const value = /<v>([\s\S]*?)<\/v>/.exec(cell[2])?.[1] || '';
        return /\bt="s"/.test(cell[1]) ? (shared[Number(value)] ?? value) : value;
      });
      rows.push(cells);
    }
    sheets.push({ name: path.basename(name, '.xml'), rows });
  }
  return { sheets };
}

function slideXml(title, bullets) {
  const items = [title, ...(Array.isArray(bullets) ? bullets : [])].filter((item) => String(item || '').length);
  const shapes = items.map((text, index) => {
    const y = 400000 + index * 700000;
    return `<p:sp><p:nvSpPr><p:cNvPr id="${index + 2}" name="Text ${index + 1}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="457200" y="${y}"/><a:ext cx="8229600" cy="600000"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN" sz="${index ? 1800 : 2800}"${index ? '' : ' b="1"'}/><a:t>${xml(text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
  }).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function createPresentation({ title = '演示文稿', slides } = {}) {
  const deck = Array.isArray(slides) && slides.length ? slides : [{ title, bullets: [] }];
  const slideFiles = [];
  deck.forEach((slide, index) => {
    const number = index + 1;
    slideFiles.push({ name: `ppt/slides/slide${number}.xml`, data: slideXml(slide.title || `幻灯片 ${number}`, slide.bullets || slide.body || []) });
    slideFiles.push({ name: `ppt/slides/_rels/slide${number}.xml.rels`, data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>` });
  });
  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${deck.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000" type="screen4x3"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const presentationRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${deck.map((_, index) => `<Relationship Id="rId${index + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${index + 1}.xml"/>`).join('')}</Relationships>`;
  const overrides = deck.map((_, index) => `<Override PartName="/ppt/slides/slide${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('');
  return zipPack([
    { name: '[Content_Types].xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${overrides}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>` },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: presentationRels },
    ...slideFiles,
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>` },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>` },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>` },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>` },
    { name: 'ppt/theme/theme1.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Local Codex"><a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F497D"/></a:dk2><a:lt2><a:srgbClr val="EEECE1"/></a:lt2><a:accent1><a:srgbClr val="4F81BD"/></a:accent1><a:accent2><a:srgbClr val="C0504D"/></a:accent2><a:accent3><a:srgbClr val="9BBB59"/></a:accent3><a:accent4><a:srgbClr val="8064A2"/></a:accent4><a:accent5><a:srgbClr val="4BACC6"/></a:accent5><a:accent6><a:srgbClr val="F79646"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="Office"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="25400" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="38100" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"/></a:gs><a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="0" scaled="0"/></a:gradFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>` },
    { name: 'docProps/core.xml', data: coreProps(title, 'presentation') },
    { name: 'docProps/app.xml', data: appProps('Local Codex') },
  ]);
}

function readPresentation(buffer) {
  const files = zipRead(buffer);
  const slides = [...files.keys()].filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort().map((name) => ({
    name,
    text: stripXml(files.get(name).toString('utf8')),
  }));
  if (!slides.length) throw new Error('不是有效的演示文稿');
  return { slides, text: slides.map((slide) => slide.text).join('\n\n') };
}

function pdfEscape(value) {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll('(', '\\(').replaceAll(')', '\\)');
}

function pdfString(value) {
  const text = String(value ?? '');
  if (/^[\x20-\x7e]*$/.test(text)) return `(${pdfEscape(text)})`;
  const encoded = Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(text, 'utf16le').swap16()]);
  return `<${encoded.toString('hex')}>`;
}

function parseToUnicode(source) {
  const map = new Map();
  for (const block of String(source || '').matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(pair[1], 16), String.fromCodePoint(parseInt(pair[2], 16)));
    }
  }
  return map;
}

function decodePdfLiteral(value, hex = false, toUnicode = new Map()) {
  if (hex) {
    const buffer = Buffer.from(value, 'hex');
    if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return buffer.subarray(2).swap16().toString('utf16le');
    if (toUnicode.size) {
      let text = '';
      for (let index = 0; index + 1 < buffer.length; index += 2) text += toUnicode.get(buffer.readUInt16BE(index)) || '';
      return text;
    }
    return buffer.toString('utf8');
  }
  return value.replaceAll('\\(', '(').replaceAll('\\)', ')').replaceAll('\\\\', '\\');
}

function wrapPdfLine(line, width) {
  const text = String(line || ' ');
  if (pdfFont.hasCjk(text)) {
    const chars = [...text];
    const rows = [];
    for (let index = 0; index < chars.length; index += width) rows.push(chars.slice(index, index + width).join(''));
    return rows.length ? rows : [' '];
  }
  return text.match(new RegExp(`.{1,${Math.max(8, width * 2)}}`, 'g')) || [' '];
}

function createPdf({ title = '文档', body = '', paragraphs } = {}) {
  const raw = (Array.isArray(paragraphs) && paragraphs.length ? paragraphs : String(body || title).split(/\r?\n/)).map((line) => String(line || ' '));
  const needsCjk = raw.some((line) => pdfFont.hasCjk(line));
  let embedded = null;
  if (needsCjk) {
    const found = pdfFont.findCjkFont();
    if (found) {
      try { embedded = pdfFont.fontObjectTexts(pdfFont.subsetFont(found.file, `${title}\n${raw.join('\n')}`)); }
      catch { embedded = null; }
    }
  }
  const lines = raw.flatMap((line) => wrapPdfLine(line, needsCjk ? 32 : 43));
  const pages = [];
  for (let index = 0; index < lines.length; index += 36) pages.push(lines.slice(index, index + 36));
  if (!pages.length) pages.push([' ']);
  const objects = [];
  const add = (bodyText) => {
    objects.push(bodyText);
    return objects.length;
  };
  const encode = embedded ? embedded.encode : (line) => pdfString(line);
  let font = 0;
  if (embedded) {
    const fontFile = add(Buffer.concat([
      Buffer.from(`<< /Length ${embedded.compressed.length} /Length1 ${embedded.length1} /Filter /FlateDecode >>\nstream\n`),
      embedded.compressed,
      Buffer.from('\nendstream'),
    ]));
    const descriptor = add(`<< /Type /FontDescriptor /FontName /LocalCJK /Flags 4 /FontBBox [${embedded.bbox.join(' ')}] /ItalicAngle 0 /Ascent ${embedded.ascent} /Descent ${embedded.descent} /CapHeight ${embedded.ascent} /StemV 80 /FontFile2 ${fontFile} 0 R >>`);
    const cid = add(`<< /Type /Font /Subtype /CIDFontType2 /BaseFont /LocalCJK /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor ${descriptor} 0 R /DW 1000 /W [ 0 [${embedded.widths.join(' ')}] ] /CIDToGIDMap /Identity >>`);
    const toUnicode = add(`<< /Length ${Buffer.byteLength(embedded.toUnicode)} >>\nstream\n${embedded.toUnicode}\nendstream`);
    font = add(`<< /Type /Font /Subtype /Type0 /BaseFont /LocalCJK /Encoding /Identity-H /DescendantFonts [${cid} 0 R] /ToUnicode ${toUnicode} 0 R >>`);
  } else {
    font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  }
  const contentIds = pages.map((pageLines) => {
    const stream = `BT /F1 12 Tf 50 780 Td ${pageLines.map((line, index) => `${index ? '0 -18 Td ' : ''}${encode(line)} Tj`).join(' ')} ET`;
    return add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  });
  const pageIds = contentIds.map((content) => add(`<< /Type /Page /Parent 0 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`));
  const pagesId = add(`<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`);
  objects[pagesId - 1] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`;
  pageIds.forEach((id) => {
    objects[id - 1] = objects[id - 1].replace('/Parent 0 0 R', `/Parent ${pagesId} 0 R`);
  });
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const info = add(`<< /Title ${pdfString(title)} /Creator (Local Codex) >>`);
  let output = Buffer.from('%PDF-1.4\n');
  const offsets = [0];
  objects.forEach((item, index) => {
    offsets.push(output.length);
    const body = Buffer.isBuffer(item) ? item : Buffer.from(String(item));
    output = Buffer.concat([output, Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from('\nendobj\n')]);
  });
  const startxref = output.length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let index = 1; index <= objects.length; index += 1) xref += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  xref += `trailer << /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.concat([output, Buffer.from(xref)]);
}

function readPdf(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer);
  if (!source.startsWith('%PDF-')) throw new Error('不是有效的 PDF');
  const toUnicode = parseToUnicode(source);
  const pages = (source.match(/\/Type\s*\/Page\b/g) || []).length;
  const text = [...source.matchAll(/(?:\(((?:\\\)|[^)])*)\)|<([0-9A-Fa-f]+)>)\s*Tj/g)]
    .map((match) => decodePdfLiteral(match[1] || match[2] || '', Boolean(match[2]), toUnicode))
    .join('\n')
    .trim();
  return { pages, text, header: source.slice(0, 8) };
}

function verifyPdf(buffer) {
  const source = Buffer.isBuffer(buffer) ? buffer.toString('latin1') : String(buffer);
  const issues = [];
  if (!source.startsWith('%PDF-')) issues.push('缺少 %PDF- 文件头');
  if (!/%%EOF\s*$/.test(source)) issues.push('缺少 %%EOF 结束标记');
  if (!/startxref/.test(source)) issues.push('缺少 startxref');
  const pages = (source.match(/\/Type\s*\/Page\b/g) || []).length;
  if (!pages) issues.push('没有页面对象');
  return { ok: issues.length === 0, pages, issues };
}

function replaceInZip(buffer, replacer) {
  const files = zipRead(buffer);
  const next = [];
  for (const [name, data] of files) {
    if (/\.xml$/.test(name)) next.push({ name, data: replacer(data.toString('utf8'), name) });
    else next.push({ name, data });
  }
  return zipPack(next);
}

function replaceText(buffer, kind, replacements = []) {
  const pairs = replacements.map((item) => [String(item.from ?? item.search ?? ''), String(item.to ?? item.replace ?? '')]).filter(([from]) => from);
  const apply = (text) => pairs.reduce((current, [from, to]) => current.split(from).join(to), text);
  if (kind === 'pdf') {
    const current = readPdf(buffer);
    return createPdf({ title: '文档', body: apply(current.text || '') });
  }
  return replaceInZip(buffer, apply);
}

function detectKind(filePath, buffer) {
  const ext = path.extname(filePath || '').toLowerCase();
  if (ext === '.docx') return 'document';
  if (ext === '.xlsx' || ext === '.csv') return 'spreadsheet';
  if (ext === '.pptx') return 'presentation';
  if (ext === '.pdf') return 'pdf';
  if (buffer && String(buffer.subarray(0, 5)) === '%PDF-') return 'pdf';
  return '';
}

function readAny(filePath, buffer) {
  const kind = detectKind(filePath, buffer);
  if (kind === 'document') return { kind, ...readDocument(buffer) };
  if (kind === 'spreadsheet') {
    if (path.extname(filePath).toLowerCase() === '.csv') {
      const rows = String(buffer).replace(/\r\n/g, '\n').split('\n').map((line) => line.split(','));
      return { kind, sheets: [{ name: 'Sheet1', rows }] };
    }
    return { kind, ...readSpreadsheet(buffer) };
  }
  if (kind === 'presentation') return { kind, ...readPresentation(buffer) };
  if (kind === 'pdf') return { kind, ...readPdf(buffer), ...verifyPdf(buffer) };
  throw new Error('不支持的文件类型');
}

function createAny(kind, spec = {}) {
  if (kind === 'document') return createDocument(spec);
  if (kind === 'spreadsheet') return createSpreadsheet(spec);
  if (kind === 'presentation') return createPresentation(spec);
  if (kind === 'pdf') return createPdf(spec);
  throw new Error('不支持的模板类型');
}

function safeJoin(root, target) {
  const base = path.resolve(String(root || ''));
  const resolved = path.resolve(base, String(target || ''));
  const relative = path.relative(base, resolved);
  if (!base || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('只能读写当前工作区或模板目录中的文件');
  return resolved;
}

function templateRoots({ codexHome, workspaceRoot }) {
  return [
    { scope: 'user', dir: path.join(path.resolve(codexHome || os.homedir()), 'templates') },
    workspaceRoot ? { scope: 'project', dir: path.join(path.resolve(workspaceRoot), '.codex', 'templates') } : null,
  ].filter(Boolean);
}

function listTemplates(roots) {
  return roots.flatMap((root) => {
    if (!fs.existsSync(root.dir)) return [];
    return fs.readdirSync(root.dir).filter((name) => name.endsWith('.json')).map((name) => {
      const file = path.join(root.dir, name);
      let spec = {};
      try { spec = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { spec = {}; }
      return {
        scope: root.scope,
        name: path.basename(name, '.json'),
        file,
        kind: spec.kind || '',
        title: spec.title || path.basename(name, '.json'),
        description: spec.description || '',
      };
    });
  });
}

function saveTemplate(roots, { scope = 'user', name, kind, spec }) {
  const clean = String(name || '').replace(/[^A-Za-z0-9._-]/g, '-');
  if (!clean) throw new Error('模板名称不能为空');
  if (!KINDS.includes(kind)) throw new Error('模板类型必须是 document、spreadsheet、presentation 或 pdf');
  const root = roots.find((item) => item.scope === scope);
  if (!root) throw new Error('找不到模板目录');
  fs.mkdirSync(root.dir, { recursive: true });
  const file = path.join(root.dir, `${clean}.json`);
  const payload = { ...spec, name: clean, kind, title: spec.title || clean, description: spec.description || '' };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return { file, ...payload };
}

function loadTemplate(roots, name) {
  const clean = String(name || '');
  const found = listTemplates(roots).find((item) => item.name === clean);
  if (!found) throw new Error(`找不到模板：${clean}`);
  return { ...found, spec: JSON.parse(fs.readFileSync(found.file, 'utf8')) };
}

module.exports = {
  KINDS,
  zipPack,
  zipRead,
  applyValues,
  createDocument,
  readDocument,
  createSpreadsheet,
  readSpreadsheet,
  createPresentation,
  readPresentation,
  createPdf,
  readPdf,
  verifyPdf,
  replaceText,
  detectKind,
  readAny,
  createAny,
  safeJoin,
  templateRoots,
  listTemplates,
  saveTemplate,
  loadTemplate,
};
