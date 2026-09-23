import React, { useEffect, useMemo, useState } from 'react';
import { useAppDialog } from './AppDialog';
import { icons, UiIcon } from './UiIcon';

type DiffLine = { kind: 'add' | 'del' | 'context' | 'meta'; text: string; oldLine?: number; newLine?: number };
type DiffHunk = { header: string; lines: DiffLine[] };
type DiffFile = { path: string; hunks: DiffHunk[]; added: number; deleted: number };
type DiffTreeFile = { kind: 'file'; name: string; path: string; displayPath: string; file: DiffFile };
type DiffTreeDirectory = { kind: 'directory'; name: string; path: string; children: DiffTreeNode[] };
type DiffTreeNode = DiffTreeFile | DiffTreeDirectory;

function buildDiffTree(files: DiffFile[], pathFormatter: (path: string) => string): DiffTreeNode[] {
  type MutableDirectory = { name: string; path: string; directories: Map<string, MutableDirectory>; files: DiffTreeFile[] };
  const root: MutableDirectory = { name: '', path: '', directories: new Map(), files: [] };
  for (const file of files) {
    const displayPath = pathFormatter(file.path);
    const parts = displayPath.replaceAll('\\', '/').split('/').filter(Boolean);
    let directory = root;
    for (const part of parts.slice(0, -1)) {
      const childPath = directory.path ? `${directory.path}/${part}` : part;
      let child = directory.directories.get(part);
      if (!child) {
        child = { name: part, path: childPath, directories: new Map(), files: [] };
        directory.directories.set(part, child);
      }
      directory = child;
    }
    directory.files.push({ kind: 'file', name: parts.at(-1) || file.path, path: file.path, displayPath, file });
  }
  const convert = (directory: MutableDirectory): DiffTreeNode[] => {
    const directories: DiffTreeDirectory[] = [...directory.directories.values()].map((child) => ({ kind: 'directory', name: child.name, path: child.path, children: convert(child) }));
    const compacted = directories.map((node) => {
      let current = node;
      while (current.children.length === 1 && current.children[0].kind === 'directory') {
        const child = current.children[0];
        current = { kind: 'directory', name: `${current.name}/${child.name}`, path: child.path, children: child.children };
      }
      return current;
    });
    compacted.sort((left, right) => left.name.localeCompare(right.name));
    directory.files.sort((left, right) => left.name.localeCompare(right.name));
    return [...compacted, ...directory.files];
  };
  return convert(root);
}

function treeStats(node: DiffTreeNode): { added: number; deleted: number } {
  if (node.kind === "file") return { added: node.file.added, deleted: node.file.deleted };
  return node.children.reduce((sum, child) => {
    const stats = treeStats(child);
    return { added: sum.added + stats.added, deleted: sum.deleted + stats.deleted };
  }, { added: 0, deleted: 0 });
}

export function DiffFileTree({ files, filter, selectedPath, pathFormatter, onSelect, showDirectoryCounts = false }: { files: DiffFile[]; filter: string; selectedPath: string; pathFormatter: (path: string) => string; onSelect: (file: DiffFile) => void; showDirectoryCounts?: boolean }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const normalizedFilter = filter.trim().toLowerCase();
  const visibleFiles = useMemo(() => files.filter((file) => !normalizedFilter || file.path.toLowerCase().includes(normalizedFilter)), [files, normalizedFilter]);
  const nodes = useMemo(() => buildDiffTree(visibleFiles, pathFormatter), [visibleFiles, pathFormatter]);
  const toggle = (path: string) => setCollapsed((old) => { const next = new Set(old); next.has(path) ? next.delete(path) : next.add(path); return next; });
  const renderNodes = (items: DiffTreeNode[], depth = 0): React.ReactNode => items.map((node) => {
    if (node.kind === 'file') return <button type="button" role="treeitem" aria-selected={sameDiffPath(node.file.path, selectedPath)} className={`diff-review-tree-file ${sameDiffPath(node.file.path, selectedPath) ? 'active' : ''}`} style={{ paddingLeft: 8 + depth * 15 }} onClick={() => onSelect(node.file)} key={node.path}><UiIcon icon={icons.fileCode} /><span title={node.displayPath}>{node.name}</span><b>+{node.file.added}</b><i>-{node.file.deleted}</i></button>;
    const isCollapsed = !normalizedFilter && collapsed.has(node.path);
    const stats = showDirectoryCounts ? treeStats(node) : null;
    return <div className="diff-review-tree-node" key={node.path}><button type="button" role="treeitem" aria-expanded={!isCollapsed} className="diff-review-tree-directory" style={{ paddingLeft: 6 + depth * 15 }} onClick={() => toggle(node.path)}><UiIcon icon={isCollapsed ? icons.right : icons.down} /><UiIcon icon={isCollapsed ? icons.folder : icons.folderOpen} /><span title={node.path}>{node.name}</span>{stats ? <small><b>+{stats.added}</b> <i>-{stats.deleted}</i></small> : <i />}</button>{!isCollapsed && <div role="group">{renderNodes(node.children, depth + 1)}</div>}</div>;
  });
  return <div className="diff-review-tree-list" role="tree" aria-label="变更文件树">{nodes.length ? renderNodes(nodes) : <div className="diff-review-tree-empty">没有匹配文件</div>}</div>;
}

function parseRange(value: string): [number, number] {
  const match = value.match(/^(\d+)(?:,(\d+))?/);
  return match ? [Number(match[1]), Number(match[2] || 1)] : [0, 0];
}

export function parseUnifiedDiff(source: string): DiffFile[] {
  const files: DiffFile[] = [];
  const filesByPath = new Map<string, DiffFile>();
  let current: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of String(source || '').replace(/\r\n/g, '\n').split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const match = raw.match(/^diff --git a\/(.+) b\/(.+)$/);
      const filePath = match?.[2] || match?.[1] || raw.slice(11);
      const key = filePath.replaceAll('\\', '/').toLowerCase();
      current = filesByPath.get(key) || { path: filePath, hunks: [], added: 0, deleted: 0 };
      if (!filesByPath.has(key)) {
        filesByPath.set(key, current);
        files.push(current);
      }
      hunk = null;
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('@@ ')) {
      const match = raw.match(/^@@ -([^ ]+) \+([^ ]+) @@/);
      const oldRange = parseRange(match?.[1] || '0');
      const newRange = parseRange(match?.[2] || '0');
      oldLine = oldRange[0];
      newLine = newRange[0];
      hunk = { header: raw, lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    if (!hunk || raw.startsWith('--- ') || raw.startsWith('+++ ') || raw.startsWith('index ')) continue;
    const prefix = raw[0];
    const line = raw.slice(1);
    if (prefix === '+') { hunk.lines.push({ kind: 'add', text: line, newLine: newLine++ }); current.added += 1; }
    else if (prefix === '-') { hunk.lines.push({ kind: 'del', text: line, oldLine: oldLine++ }); current.deleted += 1; }
    else { hunk.lines.push({ kind: 'context', text: prefix === ' ' ? line : raw, oldLine: oldLine++, newLine: newLine++ }); }
  }
  return files.filter((file) => file.hunks.length > 0 || file.added > 0 || file.deleted > 0);
}

export function DiffReviewPanel({ diff, error = '', focusPath = '', workspaceRoot = '', onRefresh, onRestoreFile, onRejectHunk, markerStyle = '颜色' }: { diff: string; error?: string; focusPath?: string; workspaceRoot?: string; onRefresh: () => void; onRestoreFile: (path: string) => Promise<void>; onRejectHunk?: (patch: string) => Promise<void>; markerStyle?: string }) {
  const dialog = useAppDialog();
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const reviewKey = `local-codex:review:${hashDiff(diff)}`;
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [reviewed, setReviewed] = useState<Set<string>>(() => readReview(reviewKey)?.reviewed || new Set());
  const [comments, setComments] = useState<Record<string, string>>(() => readReview(reviewKey)?.comments || {});
  const [savedComments, setSavedComments] = useState<Record<string, string>>(() => readReview(reviewKey)?.savedComments || {});
  const [activeComment, setActiveComment] = useState('');
  const [selectedPath, setSelectedPath] = useState(focusPath);
  const [fileFilter, setFileFilter] = useState('');
  const fileRefs = React.useRef(new Map<string, HTMLElement>());
  const displayPath = React.useCallback((value: string) => {
    const filePath = String(value || '').replaceAll('\\', '/');
    const root = String(workspaceRoot || '').replaceAll('\\', '/').replace(/\/$/, '');
    if (root && filePath.toLowerCase().startsWith(`${root.toLowerCase()}/`)) return filePath.slice(root.length + 1);
    return filePath;
  }, [workspaceRoot]);
  useEffect(() => {
    try { localStorage.setItem(reviewKey, JSON.stringify({ reviewed: [...reviewed], comments, savedComments })); } catch { /* storage can be disabled in hardened Electron profiles */ }
  }, [reviewKey, reviewed, comments, savedComments]);
  useEffect(() => {
    setSelectedPath(focusPath);
  }, [focusPath]);
  useEffect(() => {
    const targetPath = selectedPath || focusPath;
    if (!targetPath || files.length === 0) return;
    const target = files.find((file) => sameDiffPath(file.path, targetPath));
    if (!target) return;
    setCollapsed((old) => { if (!old.has(target.path)) return old; const next = new Set(old); next.delete(target.path); return next; });
    window.requestAnimationFrame(() => fileRefs.current.get(target.path)?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  }, [selectedPath, focusPath, diff, files.length]);
  const toggle = (key: string) => setCollapsed((old) => { const next = new Set(old); next.has(key) ? next.delete(key) : next.add(key); return next; });
  const totalAdded = files.reduce((sum, file) => sum + file.added, 0);
  const totalDeleted = files.reduce((sum, file) => sum + file.deleted, 0);
  const markerClass = markerStyle === '+/-' ? 'marker-signs' : markerStyle === '颜色 + +/-' ? 'marker-both' : 'marker-color';
  const showSigns = markerStyle !== '颜色';
  if (error) return <><div className="diff-review-empty diff-review-error"><UiIcon icon={icons.warning} /><strong>无法读取 Git 差异</strong><span>{error}</span><button className="btn small" onClick={onRefresh}><UiIcon icon={icons.refresh} /> 刷新</button></div>{dialog.node}</>;
  if (!diff.trim() || files.length === 0) return <><div className="diff-review-empty"><UiIcon icon={icons.check} /><strong>没有未提交变更</strong><button className="btn small" onClick={onRefresh}><UiIcon icon={icons.refresh} /> 刷新</button></div>{dialog.node}</>;
  return <><div className={`diff-review ${markerClass}`}>
    <div className="diff-review-toolbar"><div><strong>变更审查</strong><span className="diff-review-stats"><b>+{totalAdded}</b> <i>-{totalDeleted}</i> · {files.length} 个文件</span></div><button className="btn small" onClick={onRefresh}><UiIcon icon={icons.refresh} /> 刷新</button></div>
    <div className="diff-review-layout"><div className="diff-review-main">{files.map((file) => { const fileKey = file.path; const isCollapsed = collapsed.has(fileKey); const fileReviewed = reviewed.has(fileKey); const focused = Boolean((selectedPath || focusPath) && sameDiffPath(file.path, selectedPath || focusPath)); return <section ref={(node) => { if (node) fileRefs.current.set(fileKey, node); else fileRefs.current.delete(fileKey); }} data-review-file={fileKey} className={`diff-review-file ${fileReviewed ? 'reviewed' : ''} ${focused ? 'focused' : ''}`} key={fileKey}>
      <div className="diff-review-file-head"><button className="diff-review-toggle" onClick={() => toggle(fileKey)} aria-expanded={!isCollapsed}><UiIcon icon={isCollapsed ? icons.right : icons.down} /><span title={file.path}>{displayPath(file.path)}</span></button><span className="diff-review-file-stats"><b>+{file.added}</b> <i>-{file.deleted}</i></span><button className="diff-review-mark" title={fileReviewed ? '标记为未审查' : '标记为已审查'} onClick={() => setReviewed((old) => { const next = new Set(old); next.has(fileKey) ? next.delete(fileKey) : next.add(fileKey); return next; })}>{fileReviewed ? <UiIcon icon={icons.check} /> : <UiIcon icon={icons.circle} />}</button><button className="diff-review-restore" title="撤销此文件的未暂存修改" onClick={() => { void (async () => { if (await dialog.confirm('撤销修改', `确认撤销文件“${file.path}”的未暂存修改？`)) void onRestoreFile(file.path); })(); }}><UiIcon icon={icons.undo} /></button></div>
      {!isCollapsed && <div className="diff-review-file-body"><div className="diff-review-file-content">{file.hunks.map((item, hunkIndex) => <React.Fragment key={`${fileKey}:${hunkIndex}`}>{hunkIndex > 0 && <div className="diff-review-unmodified"><span>未修改行</span></div>}<div className="diff-review-hunk"><div className="diff-review-hunk-head"><code>{item.header}</code></div><pre>{item.lines.map((line, lineIndex) => {
        const commentKey = `${fileKey}:${hunkIndex}:${lineIndex}`;
        const hasComment = Boolean(savedComments[commentKey]);
        return <React.Fragment key={`${lineIndex}-${line.text}`}>
          <span className={`diff-review-line ${line.kind}${hasComment ? ' has-comment' : ''}${activeComment === commentKey ? ' commenting' : ''}`} onClick={() => setActiveComment((current) => current === commentKey ? '' : commentKey)} title="点击添加行评论">
            <em>{line.oldLine ?? ''}</em><em>{line.newLine ?? ''}</em><b>{showSigns ? (line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ') : ''}</b>{line.text || ' '}
          </span>
          {(activeComment === commentKey || hasComment) && <DiffLineComment
            draft={comments[commentKey] || savedComments[commentKey] || ''}
            saved={hasComment}
            editing={activeComment === commentKey}
            onChange={(value) => setComments((old) => ({ ...old, [commentKey]: value }))}
            onSave={() => { setSavedComments((old) => ({ ...old, [commentKey]: comments[commentKey] || savedComments[commentKey] || '' })); setActiveComment(''); }}
            onDelete={() => { setSavedComments((old) => { const next = { ...old }; delete next[commentKey]; return next; }); setComments((old) => { const next = { ...old }; delete next[commentKey]; return next; }); setActiveComment(''); }}
          />}
        </React.Fragment>;
      })}</pre></div></React.Fragment>)}</div></div>}
    </section>; })}</div><aside className="diff-review-tree"><label><UiIcon icon={icons.search} /><input value={fileFilter} onChange={(event) => setFileFilter(event.target.value)} placeholder="筛选文件…" /></label><DiffFileTree files={files} filter={fileFilter} selectedPath={selectedPath || focusPath} pathFormatter={displayPath} onSelect={(file) => { setSelectedPath(file.path); fileRefs.current.get(file.path)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }} /></aside></div>
  </div>{dialog.node}</>;
}

function hashDiff(value: string): string { let hash = 2166136261; for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619); return (hash >>> 0).toString(16); }
function sameDiffPath(left: string, right: string): boolean { const a = String(left || '').replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase(); const b = String(right || '').replaceAll('\\', '/').replace(/^\.\//, '').toLowerCase(); return Boolean(a && b && (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`))); }
function hunkPatch(filePath: string, hunk: DiffHunk): string { const path = filePath.replaceAll('\\', '/'); const body = hunk.lines.map((line) => `${line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}${line.text}`).join('\n'); return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunk.header}\n${body}\n`; }
export function DiffLineComment({
  draft,
  saved,
  editing,
  onChange,
  onSave,
  onDelete,
  submitLabel = '保存本地评论',
}: {
  draft: string;
  saved?: boolean;
  editing?: boolean;
  onChange: (value: string) => void;
  onSave: () => void | Promise<void>;
  onDelete?: () => void;
  submitLabel?: string;
}) {
  return <div className={`diff-review-comment${saved && !editing ? ' saved' : ''}`} onClick={(event) => event.stopPropagation()}>
    {editing ? <>
      <label>行评论</label>
      <textarea value={draft} rows={3} onChange={(event) => onChange(event.target.value)} placeholder="写下对这一行的意见…" />
      <div className="diff-review-comment-actions">
        <button type="button" className="btn small" disabled={!draft.trim()} onClick={() => void onSave()}>{submitLabel}</button>
        {saved && onDelete && <button type="button" className="btn small" onClick={onDelete}>删除</button>}
      </div>
    </> : <p>{draft}</p>}
  </div>;
}

function readReview(key: string): { reviewed: Set<string>; hunkDecisions: Record<string, 'accepted' | 'rejected'>; comments: Record<string, string>; savedComments: Record<string, string> } | null {
  try { const parsed = JSON.parse(localStorage.getItem(key) || 'null'); if (!parsed) return null; return { reviewed: new Set(Array.isArray(parsed.reviewed) ? parsed.reviewed : []), hunkDecisions: parsed.hunkDecisions || {}, comments: parsed.comments || {}, savedComments: parsed.savedComments || {} }; } catch { return null; }
}
