import React, { useState } from 'react';
import { api, TurnItem } from '../api';
import { useAppDialog } from './AppDialog';
import { icons, UiIcon } from './UiIcon';

export function activityLabel(item: TurnItem): string {
  const labels: Record<string, string> = {
    commandExecution: '运行了命令',
    fileChange: '编辑了文件',
    mcpToolCall: 'MCP 工具',
    plan: '更新计划',
    reasoning: '推理',
    webSearch: '搜索',
    collabAgentToolCall: '协作代理',
    subAgentActivity: '子代理活动',
  };
  return labels[item.type] || item.type;
}

export function commandText(item: TurnItem): string {
  const value = item.command as unknown;
  if (Array.isArray(value)) return cleanShellCommand(value.map(String).join(' '));
  if (value && typeof value === 'object') {
    const command = (value as { command?: unknown }).command;
    if (Array.isArray(command)) return cleanShellCommand(command.map(String).join(' '));
    if (command) return cleanShellCommand(String(command));
  }
  return cleanShellCommand(String(value || ''));
}

function cleanShellCommand(value: string): string {
  const source = value.trim();
  const launcher = source.match(/^(?:"([^"]+)"|'([^']+)'|(\S+))\s+([\s\S]+)$/);
  if (!launcher) return source;
  const executable = launcher[1] || launcher[2] || launcher[3] || '';
  if (!/(?:powershell|pwsh|cmd|bash|sh)(?:\.exe)?$/i.test(executable)) return source;
  const rest = launcher[4].trim();
  const marker = rest.match(/^(?:(?:-[A-Za-z][\w-]*)\s+)*(?:\/d\s+\/s\s+\/c|\/c|-lc|-Command|-c)(?:\s+)([\s\S]+)$/i);
  if (!marker) return source;
  const command = marker[1].trim();
  if ((command.startsWith('"') && command.endsWith('"')) || (command.startsWith("'") && command.endsWith("'"))) return command.slice(1, -1).trim();
  return command;
}

function commandStatus(items: TurnItem[]): 'success' | 'failed' | 'running' {
  if (items.some((item) => item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0))) return 'failed';
  if (items.some((item) => item.status === 'inProgress')) return 'running';
  return 'success';
}

const ansiColors = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5'];
const ansiBrightColors = ['#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#ffffff'];

function ansiStyle(codes: number[], current: React.CSSProperties): React.CSSProperties {
  const next = { ...current };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) { Object.keys(next).forEach((key) => delete (next as Record<string, unknown>)[key]); continue; }
    if (code === 1) next.fontWeight = 700;
    else if (code === 2) next.opacity = 0.65;
    else if (code === 3) next.fontStyle = 'italic';
    else if (code === 4) next.textDecoration = 'underline';
    else if (code === 7) { const foreground = next.color; next.color = next.backgroundColor; next.backgroundColor = foreground; }
    else if (code === 22) { delete next.fontWeight; delete next.opacity; }
    else if (code === 23) delete next.fontStyle;
    else if (code === 24) delete next.textDecoration;
    else if (code === 39) delete next.color;
    else if (code === 49) delete next.backgroundColor;
    else if (code >= 30 && code <= 37) next.color = ansiColors[code - 30];
    else if (code >= 40 && code <= 47) next.backgroundColor = ansiColors[code - 40];
    else if (code >= 90 && code <= 97) next.color = ansiBrightColors[code - 90];
    else if (code >= 100 && code <= 107) next.backgroundColor = ansiBrightColors[code - 100];
    else if (code === 38 || code === 48) {
      const background = code === 48;
      const mode = codes[index + 1];
      if (mode === 5 && codes[index + 2] != null) {
        const value = codes[index + 2];
        const color = value < 16 ? (value < 8 ? ansiColors[value] : ansiBrightColors[value - 8]) : value < 232 ? `hsl(${((value - 16) * 137.5) % 360} 70% 55%)` : `rgb(${8 + (value - 232) * 10} ${8 + (value - 232) * 10} ${8 + (value - 232) * 10})`;
        if (background) next.backgroundColor = color; else next.color = color;
        index += 2;
      } else if (mode === 2 && codes[index + 4] != null) {
        const color = `rgb(${codes[index + 2]} ${codes[index + 3]} ${codes[index + 4]})`;
        if (background) next.backgroundColor = color; else next.color = color;
        index += 4;
      }
    }
  }
  return next;
}

function AnsiOutput({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let style: React.CSSProperties = {};
  const pattern = /\x1b\[([0-9;?]*)([ -\/]*)([@-~])|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    if (match.index > cursor) parts.push(<span style={style} key={`text-${cursor}`}>{text.slice(cursor, match.index)}</span>);
    if (match[3] === 'm') {
      const codes = (match[1] || '0').split(';').filter(Boolean).map(Number);
      style = ansiStyle(codes.length ? codes : [0], style);
    }
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(<span style={style} key={`text-${cursor}`}>{text.slice(cursor)}</span>);
  return <>{parts}</>;
}

export function CommandOutputCard({ items }: { items: TurnItem[] }) {
  const commands = items.map(commandText).filter(Boolean).join('; ');
  const output = items.map((item) => item.aggregatedOutput || '').filter(Boolean).join('\n');
  const status = commandStatus(items);
  const copyText = `$ ${commands}${output ? `\n${output}` : ''}`;
  return <section className="command-output-card"><div className="command-output-head"><span>Shell</span><button title="复制输出" onClick={() => void navigator.clipboard.writeText(copyText)}><UiIcon icon={icons.copy} /></button></div><pre><code><span className="command-input">$ {commands}</span>{output && <><span>{'\n'}</span><AnsiOutput text={output} /></>}</code></pre><div className={`command-output-status ${status}`}>{status === 'success' ? <><UiIcon icon={icons.check} /> 成功</> : status === 'failed' ? <><UiIcon icon={icons.close} /> 失败</> : '运行中'}</div></section>;
}

export function FileChangesCard({ items, onReview }: { items: TurnItem[]; onReview?: (filePath?: string, diff?: string) => void }) {
  const dialog = useAppDialog();
  const [status, setStatus] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const changes = items.flatMap((item) => item.changes || []);
  const grouped = new Map<string, typeof changes>();
  changes.forEach((change, index) => { const key = change.path || `file-${index}`; grouped.set(key, [...(grouped.get(key) || []), change]); });
  const unique = [...grouped.entries()].map(([path, entries]) => ({ ...entries[entries.length - 1], path, allChanges: entries }));
  const pathLabel = (value?: string) => {
    const normalized = String(value || '未命名文件').replaceAll('\\', '/');
    const marker = normalized.lastIndexOf('/agent/');
    return marker >= 0 ? normalized.slice(marker + 7) : normalized;
  };
  const counts = (diff?: string, kind?: { type?: string }) => diffCounts(diff, kind);
  const totals = unique.reduce((sum, change) => { const count = countsForChange(change); return { add: sum.add + count.add, del: sum.del + count.del }; }, { add: 0, del: 0 });
  const reviewDiff = unique.map((change) => {
    const source = String(change.diff || '');
    if (!source.trim()) return '';
    return changeReviewDiffs(change.allChanges || [change], pathLabel);
  }).filter(Boolean).join('\n');
  const visible = showAll ? unique : unique.slice(0, 3);
  const hiddenCount = Math.max(unique.length - 3, 0);
  const review = (filePath?: string, diff?: string) => { if (onReview) onReview(filePath, diff); else window.dispatchEvent(new CustomEvent('local-codex:open-review', { detail: { filePath, diff } })); };
  async function restore() {
    const paths = unique.map((change) => String(change.path || '')).filter(Boolean);
    if (!paths.length || !(await dialog.confirm('撤销修改', `确认撤销 ${paths.length} 个文件的未暂存修改？`))) return;
    setRestoring(true); setStatus('');
    try {
      const results = await Promise.all(paths.map((filePath) => api.git.restoreFile(filePath)));
      const failed = results.filter((result) => !result.ok);
      setStatus(failed.length ? `撤销失败：${failed.map((result) => result.output).filter(Boolean).join('；')}` : `已撤销 ${paths.length} 个文件`);
    } catch (error) { setStatus(`撤销失败：${String(error)}`); }
    finally { setRestoring(false); }
  }
  if (unique.length === 1) {
    const fileName = String(pathLabel(unique[0].path)).split('/').pop();
    return <section className="change-card single-change-card"><div className="change-card-head"><span className="change-icon"><UiIcon icon={icons.squarePlus} /></span><div className="change-card-title"><strong>已编辑 {fileName}</strong><button className="change-view" onClick={() => review(unique[0].path, changeReviewDiffs(unique[0].allChanges || [unique[0]], pathLabel))}>查看更改 <UiIcon icon={icons.external} /></button></div><div className="change-actions"><button disabled={restoring} onClick={() => void restore()}>{restoring ? '撤销中…' : <>撤销 <UiIcon icon={icons.undo} /></>}</button><button onClick={() => review(unique[0].path, changeReviewDiffs(unique[0].allChanges || [unique[0]], pathLabel))}>审查</button></div></div>{status && <div className="change-operation-status">{status}</div>}{dialog.node}</section>;
  }
  return <section className="change-card"><div className="change-card-head"><span className="change-icon"><UiIcon icon={icons.fileCode} /></span><div className="change-card-title"><strong>已编辑 {unique.length || items.length} 个文件</strong><div className="change-total"><b>+{totals.add}</b> <i>-{totals.del}</i></div></div><div className="change-actions"><button disabled={restoring} onClick={() => void restore()}>{restoring ? '撤销中…' : <>撤销 <UiIcon icon={icons.undo} /></>}</button><button onClick={() => review(unique[0]?.path, reviewDiff)}>审查</button></div></div>{visible.map((change, index) => { const count = countsForChange(change); return <button type="button" className="change-file" onClick={() => review(change.path, changeReviewDiffs(change.allChanges || [change], pathLabel))} key={`${change.path}-${index}`} title={`审查 ${pathLabel(change.path)}`}><span>{pathLabel(change.path)}</span><span className="change-file-delta"><b>+{count.add}</b> <i>-{count.del}</i></span></button>; })}{hiddenCount > 0 && <button className="change-more" onClick={() => setShowAll((value) => !value)}>{showAll ? '收起文件' : `再显示 ${hiddenCount} 个文件`} <UiIcon icon={showAll ? icons.up : icons.down} /></button>}{status && <div className="change-operation-status">{status}</div>}{dialog.node}</section>;
}

function countsForChange(change: { diff?: string; kind?: { type?: string }; allChanges?: Array<{ diff?: string; kind?: { type?: string } }> }) {
  return (change.allChanges || [change]).reduce((sum, entry) => { const count = diffCounts(entry.diff, entry.kind); return { add: sum.add + count.add, del: sum.del + count.del }; }, { add: 0, del: 0 });
}

function changeReviewDiffs(changes: Array<{ path?: string; diff?: string; kind?: { type?: string } }>, pathLabel: (value?: string) => string): string {
  if (changes.length === 1) return changeReviewDiff(changes[0], pathLabel);
  const first = changes[0];
  const reviewPath = pathLabel(first.path).replaceAll('\\', '/');
  const hunkParts = changes.map((change) => {
    const source = String(change.diff || '');
    const lines = source.split(/\r?\n/);
    const hunkIndex = lines.findIndex((line) => /^@@ /.test(line));
    if (hunkIndex >= 0) return lines.slice(hunkIndex).filter((line) => line.length > 0).join('\n');
    const rawLines = source ? source.replace(/\r?\n$/, '').split(/\r?\n/) : [];
    const body = change.kind?.type === 'add' ? rawLines.map((line) => `+${line}`).join('\n') : change.kind?.type === 'delete' ? rawLines.map((line) => `-${line}`).join('\n') : source;
    const lineCount = Math.max(rawLines.length, 1);
    return `${change.kind?.type === 'delete' ? `@@ -1,${lineCount} +0,0 @@` : `@@ -0,0 +1,${lineCount} @@`}\n${body}`;
  }).filter(Boolean);
  return `diff --git a/${reviewPath} b/${reviewPath}\n--- a/${reviewPath}\n+++ b/${reviewPath}\n${hunkParts.join('\n')}`;
}

function changeReviewDiff(change: { path?: string; diff?: string; kind?: { type?: string } }, pathLabel: (value?: string) => string): string {
  const source = String(change.diff || '');
  if (!source.trim()) return '';
  if (/(^|\r?\n)diff --git /.test(source)) return source;
  const reviewPath = pathLabel(change.path).replaceAll('\\', '/');
  const rawWholeFile = !/(^|\r?\n)@@ /.test(source) && (change.kind?.type === 'add' || change.kind?.type === 'delete');
  const rawLines = source ? source.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  const body = rawWholeFile && change.kind?.type === 'add' ? rawLines.map((line) => `+${line}`).join('\n') : rawWholeFile && change.kind?.type === 'delete' ? rawLines.map((line) => `-${line}`).join('\n') : source;
  const lineCount = Math.max(body.split(/\r?\n/).length, 1);
  const hunk = rawWholeFile ? (change.kind?.type === 'delete' ? `@@ -1,${lineCount} +0,0 @@\n` : `@@ -0,0 +1,${lineCount} @@\n`) : '';
  return `diff --git a/${reviewPath} b/${reviewPath}\n--- a/${reviewPath}\n+++ b/${reviewPath}\n${hunk}${body}`;
}

function filePath(value?: string): string {
  const normalized = String(value || '未命名文件').replaceAll('\\', '/');
  const marker = normalized.lastIndexOf('/agent/');
  return marker >= 0 ? normalized.slice(marker + 7) : normalized;
}

function diffCounts(diff?: string, kind?: { type?: string }) {
  const source = String(diff || '');
  const lines = source.split(/\r?\n/);
  if (!/(^|\r?\n)@@ /.test(source) && (kind?.type === 'add' || kind?.type === 'delete')) {
    const contentLines = source ? source.replace(/\r?\n$/, '').split(/\r?\n/).length : 0;
    return kind.type === 'add' ? { add: contentLines, del: 0 } : { add: 0, del: contentLines };
  }
  const add = lines.filter((line) => line.startsWith('+') && !line.startsWith('+++')).length;
  const del = lines.filter((line) => line.startsWith('-') && !line.startsWith('---')).length;
  return { add, del };
}

export function FileChangeActivity({ items, heading = '编辑了文件', defaultOpen = false }: { items: TurnItem[]; heading?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const changes = items.flatMap((item) => item.changes || []);
  const first = changes[0];
  const firstCount = diffCounts(first?.diff, first?.kind);
  const summary = changes.length === 1 ? `已编辑 ${String(filePath(first?.path)).split('/').pop()} +${firstCount.add} -${firstCount.del}` : heading;
  return <section className={`file-activity ${open ? 'open' : ''}`}><button className="file-activity-summary" onClick={() => setOpen((value) => !value)} aria-expanded={open}><UiIcon icon={icons.compose} /><span>{summary}</span><UiIcon icon={open ? icons.down : icons.right} /></button>{open && (changes.length === 1 ? <FileDiff change={first!} /> : changes.map((change, index) => <FileChangeEntry change={change} key={`${change.path}-${index}`} />))}</section>;
}

function FileChangeEntry({ change }: { change: { path?: string; diff?: string; kind?: { type?: string } } }) {
  const [open, setOpen] = useState(false);
  const count = diffCounts(change.diff, change.kind);
  const name = String(filePath(change.path)).split('/').pop();
  return <div className="file-change-entry"><button className="file-change-entry-summary" onClick={() => setOpen((value) => !value)} aria-expanded={open}><UiIcon icon={icons.compose} /><span>已编辑 {name}</span><span className="file-change-entry-count"><b>+{count.add}</b> <i>-{count.del}</i></span><UiIcon icon={open ? icons.down : icons.right} /></button>{open && <FileDiff change={change} />}</div>;
}

function FileDiff({ change }: { change: { path?: string; diff?: string; kind?: { type?: string } } }) {
  const count = diffCounts(change.diff, change.kind);
  const name = String(filePath(change.path)).split('/').pop();
  return <div className="file-diff"><div className="file-diff-head"><span>{name}</span><span><b>+{count.add}</b> <i>-{count.del}</i></span><button title="复制 diff" onClick={() => void navigator.clipboard.writeText(change.diff || '')}><UiIcon icon={icons.copy} /></button></div><pre>{String(change.diff || '').split('\n').map((line, lineIndex) => <span className={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-del' : ''} key={`${lineIndex}-${line}`}><em>{lineIndex + 1}</em>{line || ' '}{'\n'}</span>)}</pre></div>;
}

export function ActivityRow({ item, defaultOpen = false }: { item: TurnItem; defaultOpen?: boolean }) {
  if (item.type === 'modelReconnect') {
    const failed = item.status === 'failed';
    return <div className={`model-reconnect-row ${failed ? 'failed' : ''}`}><UiIcon icon={failed ? icons.close : icons.globe} /><span>{item.text || (failed ? '连接失败' : '正在重新连接')}</span></div>;
  }
  const [open, setOpen] = useState(defaultOpen);
  const command = commandText(item);
  const detail = item.aggregatedOutput || item.text || command || (item.content || []).map((part) => part.text || '').join('\n');
  const state = item.status === 'failed' ? 'fail' : item.status === 'inProgress' ? 'run' : 'ok';
  if (item.type === 'imageView') return null;
  if (item.type === 'webSearch') return <WebsitePreview url={item.url || item.query || ''} />;
  if (item.type === 'fileChange') return <FileChangesCard items={[item]} />;
  return <div className={`activity-row ${item.type === 'commandExecution' ? 'command-activity' : ''} ${open ? 'open' : ''}`}>
    <button className={`activity-summary ${item.type === 'commandExecution' ? 'command-summary' : ''}`} onClick={() => setOpen((value) => !value)} aria-expanded={open}>
      {item.type === 'commandExecution' ? <UiIcon icon={icons.terminal} /> : <span className={`activity-dot ${state}`} />}
      <span className="activity-label">{item.type === 'commandExecution' && command ? '已运行' : activityLabel(item)}</span>
      {command && <code className="activity-target">{command}</code>}
      {item.type !== 'commandExecution' && <span className="activity-meta">{item.status === 'failed' ? '失败' : item.status === 'inProgress' ? '运行中' : item.exitCode != null ? `退出 ${item.exitCode}` : '完成'}</span>}
      <span className="activity-chevron"><UiIcon icon={open ? icons.down : icons.right} /></span>
    </button>
    {open && (item.type === 'commandExecution' ? <CommandOutputCard items={[item]} /> : detail && <pre className="activity-detail">{detail}</pre>)}
  </div>;
}

export function ActivityGroup({ items, defaultOpen = false }: { items: TurnItem[]; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const visible = items.filter((item) => item.type !== 'reasoning' && item.type !== 'imageView');
  if (visible.length === 0) return null;
  const allCommands = visible.every((item) => item.type === 'commandExecution');
  const summary = allCommands
    ? `已运行 ${visible.map(commandText).filter(Boolean).join('; ')}`
    : [...new Set(visible.map((item) => activityLabel(item)))].join(' ');
  const state = visible.some((item) => item.status === 'failed') ? 'fail' : visible.some((item) => item.status === 'inProgress') ? 'run' : 'ok';
  const children: React.ReactNode[] = [];
  if (allCommands) children.push(<CommandOutputCard items={visible} key="commands" />);
  let fileItems: TurnItem[] = [];
  const flushFiles = () => {
    if (!fileItems.length) return;
    children.push(<FileChangeActivity items={fileItems} defaultOpen={defaultOpen} key={`files-${children.length}`} />);
    fileItems = [];
  };
  if (!allCommands) {
    visible.forEach((item, index) => {
      if (item.type === 'fileChange') fileItems.push(item);
      else { flushFiles(); children.push(<ActivityRow item={item} defaultOpen={defaultOpen} key={`${item.id || item.type}-${index}`} />); }
    });
    flushFiles();
  }
  return <section className={`activity-group ${allCommands ? 'command-group' : 'inline-activity-group'} ${open ? 'open' : ''}`}><button className={`activity-group-summary ${allCommands ? 'command-group-summary' : 'inline-activity-summary'}`} onClick={() => setOpen((value) => !value)} aria-expanded={open}>{allCommands ? <UiIcon icon={icons.terminal} /> : <UiIcon icon={icons.compose} />}<span className="activity-label">{summary}</span>{allCommands && <span className="activity-chevron"><UiIcon icon={open ? icons.down : icons.right} /></span>}</button>{open && <div className="activity-group-children">{children}</div>}</section>;
}

export function WebsitePreview({ url }: { url: string }) {
  const [status, setStatus] = useState('');
  async function open() { const result = await api.app.openExternalUrl(url); setStatus(result.ok ? '已打开' : result.output); }
  return <section className="preview-card website-preview" title={url}><div className="preview-icon"><UiIcon icon={icons.globe} /></div><div className="preview-copy"><strong>网页预览</strong><small>{status || url || '网站'}</small></div><button className="preview-action" disabled={!/^https?:\/\//i.test(url)} onClick={() => void open()}>打开 <UiIcon icon={icons.external} /></button></section>;
}
