'use strict';

const path = require('node:path');

function emptyNotebook(title = 'Notebook') {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' },
      title,
    },
    cells: [],
  };
}

function cellSource(cell) {
  if (Array.isArray(cell?.source)) return cell.source.join('');
  return String(cell?.source ?? '');
}

function normalizeCell(input, index = 0) {
  const type = String(input?.cell_type || input?.type || 'markdown').toLowerCase() === 'code' ? 'code' : 'markdown';
  const source = Array.isArray(input?.source) ? input.source : String(input?.source ?? input?.text ?? '').split(/(?<=\n)/);
  const cell = {
    cell_type: type,
    metadata: input?.metadata && typeof input.metadata === 'object' ? input.metadata : {},
    source,
  };
  if (type === 'code') {
    cell.execution_count = Number.isFinite(input?.execution_count) ? input.execution_count : null;
    cell.outputs = Array.isArray(input?.outputs) ? input.outputs : [];
  }
  if (!cell.metadata.id) cell.metadata.id = `cell-${index + 1}`;
  return cell;
}

function parseNotebook(buffer) {
  const raw = Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer || '');
  let data;
  try { data = JSON.parse(raw); } catch (error) {
    throw new Error(`不是有效的 Jupyter Notebook：${error.message}`);
  }
  if (!data || typeof data !== 'object' || !Array.isArray(data.cells)) throw new Error('不是有效的 Jupyter Notebook');
  return {
    ...emptyNotebook(data.metadata?.title || ''),
    ...data,
    metadata: { ...emptyNotebook().metadata, ...(data.metadata || {}) },
    cells: data.cells.map((cell, index) => normalizeCell(cell, index)),
  };
}

function serializeNotebook(notebook) {
  const payload = parseNotebook(JSON.stringify(notebook && notebook.cells ? notebook : { cells: [] }));
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function createNotebook({ title = 'Notebook', cells = [] } = {}) {
  const notebook = emptyNotebook(title);
  notebook.metadata.title = title;
  notebook.cells = (Array.isArray(cells) ? cells : []).map((cell, index) => normalizeCell(cell, index));
  if (!notebook.cells.length) notebook.cells.push(normalizeCell({ cell_type: 'markdown', source: `# ${title}\n` }, 0));
  return Buffer.from(serializeNotebook(notebook), 'utf8');
}

function addCell(notebook, cell, index) {
  const current = parseNotebook(JSON.stringify(notebook));
  const next = normalizeCell(cell, current.cells.length);
  const at = index == null ? current.cells.length : Math.max(0, Math.min(current.cells.length, Number(index)));
  current.cells.splice(at, 0, next);
  return current;
}

function updateCell(notebook, index, patch = {}) {
  const current = parseNotebook(JSON.stringify(notebook));
  const at = Number(index);
  if (!Number.isInteger(at) || at < 0 || at >= current.cells.length) throw new Error('单元格索引越界');
  current.cells[at] = normalizeCell({ ...current.cells[at], ...patch, source: patch.source ?? patch.text ?? current.cells[at].source }, at);
  return current;
}

function previewNotebook(buffer) {
  const notebook = parseNotebook(buffer);
  return {
    kind: 'notebook',
    title: notebook.metadata?.title || '',
    language: notebook.metadata?.language_info?.name || notebook.metadata?.kernelspec?.language || 'python',
    cells: notebook.cells.map((cell, index) => ({
      index,
      type: cell.cell_type,
      source: cellSource(cell),
      executionCount: cell.execution_count ?? null,
      outputs: Array.isArray(cell.outputs) ? cell.outputs.length : 0,
    })),
    text: notebook.cells.map((cell) => cellSource(cell)).join('\n\n'),
  };
}

function detectNotebook(filePath, buffer) {
  if (path.extname(String(filePath || '')).toLowerCase() === '.ipynb') return true;
  if (!buffer) return false;
  try {
    const data = JSON.parse(Buffer.isBuffer(buffer) ? buffer.toString('utf8') : String(buffer));
    return Boolean(data && Array.isArray(data.cells) && data.nbformat);
  } catch {
    return false;
  }
}

module.exports = {
  emptyNotebook,
  parseNotebook,
  serializeNotebook,
  createNotebook,
  addCell,
  updateCell,
  previewNotebook,
  detectNotebook,
  cellSource,
};
