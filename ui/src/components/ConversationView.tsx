import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import hljs from 'highlight.js/lib/common';
import { api, Message, MessageAttachment, TurnItem } from '../api';
import { ActivityGroup, ActivityRow, FileChangeActivity, FileChangesCard, WebsitePreview, commandText } from './ActivityRow';
import { ApprovalCard, ApprovalRequest } from './ApprovalCard';
import { icons, UiIcon } from './UiIcon';

function CodeBlock({ children }: { children: React.ReactNode }) {
  const [copied, setCopied] = React.useState(false);
  const codeElement = React.Children.toArray(children).find((child) => React.isValidElement(child));
  const languageClass = React.isValidElement(codeElement) ? String(codeElement.props.className || '') : '';
  const languageCode = languageClass.match(/language-([\w+-]+)/i)?.[1]?.toLowerCase();
  const languageNames: Record<string, string> = { bash: 'Bash', sh: 'Shell', shell: 'Shell', zsh: 'Zsh', powershell: 'PowerShell', ps: 'PowerShell', javascript: 'JavaScript', js: 'JavaScript', typescript: 'TypeScript', ts: 'TypeScript', json: 'JSON', yaml: 'YAML', yml: 'YAML', css: 'CSS', html: 'HTML', go: 'Go', rust: 'Rust', python: 'Python', py: 'Python', sql: 'SQL', text: '纯文本', plaintext: '纯文本' };
  const language = languageCode ? (languageNames[languageCode] || languageCode) : '纯文本';
  const text = React.Children.toArray(children).map((child) => {
    if (typeof child === 'string' || typeof child === 'number') return String(child);
    if (React.isValidElement(child)) return React.Children.toArray(child.props.children).join('');
    return '';
  }).join('').replace(/\n$/, '');
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200); } catch { setCopied(false); }
  }
  function download() {
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `snippet.${languageCode || 'txt'}`;
    anchor.click();
    URL.revokeObjectURL(url);
  }
  const highlighted = highlightCode(text, languageCode);
  return <div className="code-card"><div className="code-card-head"><span className="code-card-language"><UiIcon icon={icons.code} /> {language}</span><span><button title="复制代码" onClick={() => void copy()}>{copied ? '已复制' : <UiIcon icon={icons.copy} />}</button><button title="下载代码" onClick={download}><UiIcon icon={icons.external} /></button></span></div><pre><code dangerouslySetInnerHTML={{ __html: highlighted }} /></pre></div>;
}

function highlightCode(text: string, language?: string): string {
  const aliases: Record<string, string> = {
    sh: 'bash', shell: 'bash', zsh: 'bash', fish: 'bash', bat: 'dos', cmd: 'dos',
    ps: 'powershell', ps1: 'powershell',
    ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
    js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
    yml: 'yaml', md: 'markdown', mdx: 'markdown', rst: 'markdown',
    text: 'plaintext', plain: 'plaintext', txt: 'plaintext',
    kt: 'kotlin', kts: 'kotlin', cs: 'csharp', fs: 'fsharp', vb: 'vbnet',
    h: 'c', hpp: 'cpp', hh: 'cpp', cc: 'cpp', cxx: 'cpp', mm: 'cpp',
    objc: 'objectivec', 'objective-c': 'objectivec',
    rb: 'ruby', py: 'python', rs: 'rust', ex: 'elixir', exs: 'elixir',
    pl: 'perl', pm: 'perl', proto: 'protobuf', tf: 'ini', hcl: 'ini',
    dockerfile: 'dockerfile', graphql: 'graphql', gql: 'graphql',
    html: 'xml', vue: 'xml', svelte: 'xml', svg: 'xml',
    toml: 'ini', env: 'ini', conf: 'ini', properties: 'ini',
    pgsql: 'pgsql', mysql: 'sql', prisma: 'graphql',
  };
  const normalized = language ? aliases[language] || language : '';
  try {
    if (normalized && normalized !== 'plaintext' && hljs.getLanguage(normalized)) return hljs.highlight(text, { language: normalized, ignoreIllegals: true }).value;
    if (!normalized && text.trim()) return hljs.highlightAuto(text).value;
  } catch { /* Unknown language falls back to escaped text below. */ }
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

type TurnTimelineItem = { role: Message['role']; message?: Message; item?: TurnItem };
type TurnGroup = { id: string; user: Message[]; agent: Message[]; activities: TurnItem[]; timeline: TurnTimelineItem[]; durationMs?: number; startedAt?: number };

type ParsedUserMessage = { text: string; attachments: Array<{ name: string; path: string }> };

function parseUserMessage(value: string): ParsedUserMessage {
  const source = String(value || '').replace(/\r\n/g, '\n');
  const attachments: Array<{ name: string; path: string }> = [];
  const section = source.match(/# Files mentioned by the user:\n([\s\S]*?)(?=\n## My request:\n|$)/i)?.[1] || '';
  const pathPattern = /^##\s+([^:\n]+):\n((?:[A-Za-z]:[\\/]|\/)[^\n]+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = pathPattern.exec(section))) {
    const path = match[2].trim();
    if (/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(path)) attachments.push({ name: match[1].trim(), path });
  }
  const text = source.match(/## My request:\n([\s\S]*)$/i)?.[1]?.trim() || source.trim();
  return { text, attachments: [...new Map(attachments.map((item) => [item.path, item])).values()] };
}

type ImagePreviewRequest = { path: string; name: string; dataUrl?: string };

function UserReply({ message, onOpenImage, onOpenFile }: { message: Message; onOpenImage?: (image: ImagePreviewRequest) => void; onOpenFile?: (filePath: string) => void }) {
  const parsed = parseUserMessage(message.text);
  const attachments = [...new Map([...(message.attachments || []), ...parsed.attachments].map((attachment) => [attachment.path, attachment])).values()];
  const [sources, setSources] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    let cancelled = false;
    void Promise.all(attachments.map(async (attachment) => {
      try { return [attachment.path, (await api.attachments.readImage(attachment.path)).dataUrl] as const; } catch { return [attachment.path, ''] as const; }
    })).then((entries) => { if (!cancelled) setSources(Object.fromEntries(entries)); });
    return () => { cancelled = true; };
  }, [message.attachments, message.text]);
  const isImage = (attachment: MessageAttachment) => String(attachment.type || '').startsWith('image/') || /\.(?:png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(attachment.name);
  return <div className="user-reply">{attachments.length > 0 && <div className="user-reply-attachments">{attachments.map((attachment) => isImage(attachment) ? <button type="button" className="user-reply-thumbnail-button" key={attachment.path} aria-label={`预览图片 ${attachment.name}`} title={attachment.path} onClick={() => onOpenImage?.({ path: attachment.path, name: attachment.name, dataUrl: sources[attachment.path] || undefined })}><img className="user-reply-thumbnail" src={sources[attachment.path] || undefined} alt={attachment.name} /></button> : <button type="button" className="user-reply-file" key={attachment.path} title={attachment.path} onClick={() => onOpenFile?.(attachment.path)}><UiIcon icon={icons.file} /><span>{attachment.name}</span></button>)}</div>}<div className="user-reply-bubble">{parsed.text}</div></div>;
}
const MemoUserReply = React.memo(UserReply);

function compactMarkdown(value: string): string {
  const fences: string[] = [];
  const protectedText = value.replace(/```[\s\S]*?```/g, (block) => {
    fences.push(block);
    return `\u0000CODE_${fences.length - 1}\u0000`;
  });
  const compact = protectedText
    .replace(/\r\n/g, '\n')
    // Preserve intentional Markdown paragraph breaks while removing only
    // excessive blank lines introduced by streamed message chunks.
    .replace(/\n{3,}/g, '\n\n');
  return compact.replace(/\u0000CODE_(\d+)\u0000/g, (_match, index) => fences[Number(index)]);
}

function urlsInText(value: string): string[] {
  const urls = [...String(value || '').matchAll(/https?:\/\/[^\s)`<>]+/g)].map((match) => match[0].replace(/[.,;:!?\"'\\]+$/, ''));
  return [...new Set(urls)];
}

function localFilePath(href?: string): string {
  if (!href || /^(?:https?:|mailto:|#)/i.test(href)) return '';
  let value = href;
  try { value = decodeURIComponent(value); } catch { /* use raw href */ }
  value = value.replace(/^file:\/\/+?/i, '').replace(/^\/([A-Za-z]:[\\/])/, '$1').replace(/[?#].*$/, '');
  if (!/\.(?:[cm]?[jt]sx?|json|md|go|rs|py|css|html?|ya?ml|toml|sql|sh|ps1|txt|xml|vue|svelte)(?::\d+(?::\d+)?)?$/i.test(value)) return '';
  return value.replace(/:(\d+)(?::\d+)?$/, '');
}

function markdownUrlTransform(url: string): string {
  return localFilePath(url) ? url : defaultUrlTransform(url);
}

function formatFileSize(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function MarkdownLink({ href, children, onOpenFile }: { href?: string; children: React.ReactNode; onOpenFile?: (filePath: string) => void }) {
  const filePath = localFilePath(href);
  const anchorRef = React.useRef<HTMLAnchorElement>(null);
  const [hovered, setHovered] = React.useState(false);
  const [meta, setMeta] = React.useState<Awaited<ReturnType<typeof api.workspace.describeFile>> | null>(null);
  const [error, setError] = React.useState('');
  const [position, setPosition] = React.useState({ left: 0, top: 0 });
  async function openHover() {
    if (!filePath) return;
    const rect = anchorRef.current?.getBoundingClientRect();
    if (rect) setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - 382)), top: rect.top > 150 ? rect.top - 10 : rect.bottom + 8 });
    setHovered(true); setError('');
    try { setMeta(await api.workspace.describeFile(filePath)); } catch (reason) { setError(String(reason)); }
  }
  if (!filePath) return <a ref={anchorRef} href={href} onClick={(event) => { if (/^https?:/i.test(href || '')) { event.preventDefault(); void api.app.openExternalUrl(href || ''); } }}>{children}</a>;
  return <><a ref={anchorRef} href={href} className="local-file-link" onMouseEnter={() => void openHover()} onMouseLeave={() => setHovered(false)} onFocus={() => void openHover()} onBlur={() => setHovered(false)} onClick={(event) => { event.preventDefault(); onOpenFile?.(filePath); }}>{children}</a>{hovered && createPortal(<div className={`file-link-popover ${position.top > 150 ? 'above' : 'below'}`} style={{ left: position.left, top: position.top }} role="tooltip">{meta ? <><strong>{meta.name}</strong><span>{meta.relativePath}</span><small>{meta.language} · {meta.lines} 行 · {formatFileSize(meta.size)}</small><p>{meta.summary}</p></> : error ? <small>{error}</small> : <small>正在读取文件简介…</small>}</div>, document.body)}</>;
}

function AssistantMessage({ text, streaming = false, onOpenFile }: { text: string; streaming?: boolean; onOpenFile?: (filePath: string) => void }) {
  const content = compactMarkdown(text);
  return <><div className={`assistant-message ${streaming ? 'streaming' : ''}`}><div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={markdownUrlTransform} components={{ pre: ({ children }) => <CodeBlock>{children}</CodeBlock>, a: ({ href, children }) => <MarkdownLink href={href} onOpenFile={onOpenFile}>{children}</MarkdownLink> }}>{content}</ReactMarkdown></div></div>{urlsInText(content).map((url) => <WebsitePreview key={url} url={url} />)}</>;
}
const MemoAssistantMessage = React.memo(AssistantMessage);

function liveActivityLabel(item: TurnItem): string {
  if (item.type === 'modelReconnect') return item.text || (item.status === 'failed' ? '连接失败' : '正在重新连接');
  if (item.type === 'fileChange') return '正在编辑文件';
  if (item.type === 'commandExecution') {
    const command = commandText(item);
    return command ? `正在运行 ${command}` : '正在运行命令';
  }
  if (item.type === 'reasoning') return '正在思考';
  if (item.type === 'webSearch') return '正在搜索';
  return `正在处理 ${item.type}`;
}

function LiveActivityGroup({ items }: { items: TurnItem[] }) {
  const [open, setOpen] = React.useState(false);
  const visible = items.filter((item) => item.type !== 'imageView' && item.type !== 'reasoning');
  const current = visible[visible.length - 1];
  if (!current) return null;
  const sequence: React.ReactNode[] = [];
  let commandBatch: TurnItem[] = [];
  const flushCommands = () => {
    if (!commandBatch.length) return;
    sequence.push(<ActivityGroup items={commandBatch} key={`commands-${sequence.length}`} />);
    commandBatch = [];
  };
  visible.forEach((item, index) => {
    if (item.type === 'commandExecution') commandBatch.push(item);
    else { flushCommands(); sequence.push(item.type === 'fileChange' ? <FileChangeActivity items={[item]} key={`${item.id || item.type}-${index}`} /> : <ActivityRow item={item} key={`${item.id || item.type}-${index}`} />); }
  });
  flushCommands();
  return <section className={`live-activity-group ${open ? 'open' : ''}`}><button type="button" className="live-activity-summary" aria-expanded={open} onClick={() => setOpen((value) => !value)}><UiIcon icon={current.type === 'commandExecution' ? icons.terminal : current.type === 'modelReconnect' ? icons.globe : icons.compose} /><span>{liveActivityLabel(current)}</span><UiIcon icon={open ? icons.down : icons.right} /></button>{open && <div className="live-activity-sequence">{sequence}</div>}</section>;
}

function formatDuration(durationMs?: number, startedAt?: number, running = false): string {
  const elapsed = running && startedAt ? Date.now() - startedAt : (durationMs || 0);
  if (!elapsed) return running ? '处理中' : '用时';
  const seconds = Math.max(1, Math.round(elapsed / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `用时 ${minutes ? `${minutes}m ` : ''}${remainder}s`;
}

function groupByTurn(messages: Message[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  const byId = new Map<string, TurnGroup>();
  let fallback = 0;
  for (const message of messages) {
    const id = message.turnId || (message.role === 'user' ? `pending-${fallback++}` : groups[groups.length - 1]?.id || `pending-${fallback++}`);
    let group = byId.get(id);
    if (!group) { group = { id, user: [], agent: [], activities: [], timeline: [] }; groups.push(group); byId.set(id, group); }
    group.durationMs = group.durationMs || message.turnDurationMs;
    group.startedAt = group.startedAt || message.turnStartedAt;
    if (message.role === 'user') group.user.push(message);
    else if (message.role === 'agent') group.agent.push(message);
    else if (message.item) group.activities.push(message.item);
    group.timeline.push({ role: message.role, message, item: message.item });
  }
  return groups;
}

function findOccurrences(messages: Message[], term: string) {
  const query = String(term || '').trim();
  if (!query) return [];
  const needle = query.toLowerCase();
  const hits: Array<{ turnId: string; start: number }> = [];
  for (const message of messages) {
    const text = String(message.text || '');
    const lower = text.toLowerCase();
    let from = 0;
    while (from < lower.length) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      hits.push({ turnId: String(message.turnId || ''), start: at });
      from = at + needle.length;
    }
  }
  return hits;
}

type ConversationViewProps = { threadKey?: string; messages: Message[]; activeTurn: string | null; approval?: ApprovalRequest | null; onApproval?: (decision: string, answer?: string) => void; onOpenReview?: (filePath?: string, diff?: string) => void; onOpenFile?: (filePath: string) => void; onOpenImage?: (image: ImagePreviewRequest) => void; onLoadEarlier?: () => void; hasEarlier?: boolean; loadingEarlier?: boolean; loading?: boolean; findTick?: number };

function ConversationViewImpl({ threadKey = '', messages, activeTurn, approval = null, onApproval, onOpenReview, onOpenFile, onOpenImage, onLoadEarlier, hasEarlier = false, loadingEarlier = false, loading = false, findTick = 0 }: ConversationViewProps) {
  const ref = useRef<HTMLDivElement>(null);
  const feedRef = useRef<HTMLDivElement>(null);
  const locatorRef = useRef<HTMLDivElement>(null);
  const locatorTrackRef = useRef<HTMLDivElement>(null);
  const locatorSlotRefs = useRef(new Map<string, HTMLDivElement>());
  const locatorUserScrolledRef = useRef(false);
  const turnRefs = React.useRef(new Map<string, HTMLElement>());
  const pinnedTurnRef = React.useRef<string | null>(null);
  const jumpObserverRef = React.useRef<ResizeObserver | null>(null);
  const jumpTimerRef = React.useRef<number | null>(null);
  const [expandedTurns, setExpandedTurns] = React.useState<Set<string>>(new Set());
  const [, setClock] = React.useState(0);
  const [hoveredTurn, setHoveredTurn] = React.useState<string | null>(null);
  const [locatorPopupPosition, setLocatorPopupPosition] = React.useState({ left: 0, top: 0 });
  const [locatorOverflow, setLocatorOverflow] = React.useState({ top: false, bottom: false });
  const [findOpen, setFindOpen] = React.useState(false);
  const [findQuery, setFindQuery] = React.useState('');
  const [findIndex, setFindIndex] = React.useState(0);
  const findInputRef = React.useRef<HTMLInputElement>(null);
  const findHits = React.useMemo(() => findOccurrences(messages, findQuery), [messages, findQuery]);
  const currentFind = findHits[findIndex] || null;
  const locatorCloseTimer = React.useRef<number | null>(null);
  const updateLocatorPopupPosition = React.useCallback((turnId: string) => {
    const slot = locatorSlotRefs.current.get(turnId);
    if (!slot) return;
    const rect = slot.getBoundingClientRect();
    setLocatorPopupPosition({ left: Math.round(rect.right + 8), top: Math.max(8, Math.round(rect.top + rect.height / 2 - 40)) });
  }, []);
  const openLocator = (turnId: string) => { if (locatorCloseTimer.current != null) window.clearTimeout(locatorCloseTimer.current); setHoveredTurn(turnId); updateLocatorPopupPosition(turnId); };
  const closeLocator = () => { if (locatorCloseTimer.current != null) window.clearTimeout(locatorCloseTimer.current); locatorCloseTimer.current = window.setTimeout(() => setHoveredTurn(null), 140); };
  const alignTurn = React.useCallback((turnId: string) => {
    const target = turnRefs.current.get(turnId);
    const container = ref.current;
    if (!target || !container) return;
    const delta = target.getBoundingClientRect().top - container.getBoundingClientRect().top;
    const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = Math.max(0, Math.min(maxScroll, container.scrollTop + delta));
  }, []);
  React.useEffect(() => {
    if (!findTick) return;
    setFindOpen(true);
    window.requestAnimationFrame(() => findInputRef.current?.focus());
  }, [findTick]);
  React.useEffect(() => { setFindIndex(0); }, [findQuery, threadKey]);
  const jumpToTurn = React.useCallback((turnId: string) => {
    pinnedTurnRef.current = turnId;
    alignTurn(turnId);
    jumpObserverRef.current?.disconnect();
    if (jumpTimerRef.current != null) window.clearTimeout(jumpTimerRef.current);
    const feed = feedRef.current;
    if (feed) {
      jumpObserverRef.current = new ResizeObserver(() => window.requestAnimationFrame(() => alignTurn(turnId)));
      jumpObserverRef.current.observe(feed);
    }
    jumpTimerRef.current = window.setTimeout(() => {
      alignTurn(turnId);
      jumpObserverRef.current?.disconnect();
      jumpObserverRef.current = null;
      pinnedTurnRef.current = null;
    }, 2200);
  }, [alignTurn]);
  React.useEffect(() => {
    if (!currentFind?.turnId) return;
    jumpToTurn(currentFind.turnId);
  }, [currentFind, jumpToTurn]);
  const moveFind = (offset: number) => {
    if (!findHits.length) return;
    setFindIndex((current) => (current + offset + findHits.length) % findHits.length);
  };
  useEffect(() => {
    if (!ref.current) return;
    if (pinnedTurnRef.current) window.requestAnimationFrame(() => alignTurn(pinnedTurnRef.current!));
    else ref.current.scrollTop = ref.current.scrollHeight;
  }, [messages, alignTurn]);
  useEffect(() => () => { jumpObserverRef.current?.disconnect(); if (jumpTimerRef.current != null) window.clearTimeout(jumpTimerRef.current); }, []);
  const updateLocatorOverflow = React.useCallback(() => {
    const locator = locatorRef.current;
    if (!locator) return;
    const next = { top: locator.scrollTop > 2, bottom: locator.scrollTop + locator.clientHeight < locator.scrollHeight - 2 };
    setLocatorOverflow((old) => old.top === next.top && old.bottom === next.bottom ? old : next);
    if (hoveredTurn) window.requestAnimationFrame(() => updateLocatorPopupPosition(hoveredTurn));
  }, [hoveredTurn, updateLocatorPopupPosition]);
  const syncLocatorToBottom = React.useCallback(() => {
    if (locatorUserScrolledRef.current) return;
    const locator = locatorRef.current;
    if (locator) locator.scrollTop = locator.scrollHeight;
  }, []);
  useEffect(() => {
    if (!activeTurn) return undefined;
    const timer = window.setInterval(() => setClock(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [activeTurn]);
  useEffect(() => { if (!activeTurn) setExpandedTurns(new Set()); }, [activeTurn]);
  const toggleTurn = (turnId: string) => {
    setExpandedTurns((old) => { const next = new Set(old); if (next.has(turnId)) next.delete(turnId); else next.add(turnId); return next; });
  };
  const turns = React.useMemo(() => groupByTurn(messages), [messages]);
  const visibleTurns = turns;
  const summaryFor = (turn: TurnGroup) => String(turn.user[0]?.text || turn.agent.find((message) => message.text.trim())?.text || '此回合暂无文本').replace(/\s+/g, ' ').trim().slice(0, 150);
  const hoveredIndex = hoveredTurn ? visibleTurns.findIndex((turn) => turn.id === hoveredTurn) : -1;
  useEffect(() => { updateLocatorOverflow(); const locator = locatorRef.current; const track = locatorTrackRef.current; if (!locator || !track) return undefined; const observer = new ResizeObserver(() => { syncLocatorToBottom(); updateLocatorOverflow(); }); observer.observe(locator); observer.observe(track); return () => observer.disconnect(); }, [visibleTurns.length, syncLocatorToBottom, updateLocatorOverflow]);
  useEffect(() => {
    const locator = locatorRef.current;
    if (!locator) return undefined;
    const markUserScroll = () => { locatorUserScrolledRef.current = true; };
    locator.addEventListener('wheel', markUserScroll, { passive: true });
    return () => locator.removeEventListener('wheel', markUserScroll);
  }, []);
  useEffect(() => {
    if (loading || visibleTurns.length === 0 || locatorUserScrolledRef.current) return undefined;
    syncLocatorToBottom();
    updateLocatorOverflow();
    return undefined;
  }, [loading, visibleTurns.length, syncLocatorToBottom, updateLocatorOverflow]);
  return <><div ref={locatorRef} className={`turn-locator ${locatorOverflow.top ? 'has-overflow-top' : ''} ${locatorOverflow.bottom ? 'has-overflow-bottom' : ''}`} aria-label="回合快速定位" onScroll={updateLocatorOverflow}>{!loading && <div ref={locatorTrackRef} className="turn-locator-track" style={{ height: `max(100%, ${Math.max(visibleTurns.length * 18, 0)}px)` }}>{visibleTurns.map((turn, index) => { const slotHeight = 100 / Math.max(visibleTurns.length, 1); const top = index * slotHeight; const hasHover = hoveredIndex >= 0; const distance = hasHover ? Math.abs(index - hoveredIndex) : -1; const direction = !hasHover || distance === 0 ? 0 : index < hoveredIndex ? -1 : 1; const width = !hasHover ? 9 : distance === 0 ? 24 : Math.max(8, 18 - Math.min(distance, 4) * 3); const jump = () => jumpToTurn(turn.id); return <div ref={(element) => { if (element) locatorSlotRefs.current.set(turn.id, element); else locatorSlotRefs.current.delete(turn.id); }} className={`turn-locator-slot ${distance > 0 ? (direction < 0 ? 'above' : 'below') : distance === 0 ? 'current' : ''}`} key={turn.id} style={{ top: `${top}%`, height: `${slotHeight}%` }} onMouseEnter={() => openLocator(turn.id)} onMouseLeave={closeLocator} onClick={jump}><button type="button" className={`turn-locator-line ${hoveredTurn === turn.id ? 'hovered' : ''}`} style={{ width: `${width}px`, transitionDelay: `${hasHover ? Math.min(Math.max(distance, 0) * 18, 90) : 0}ms` }} aria-label={`定位回合 ${index + 1}`} onFocus={() => openLocator(turn.id)} onBlur={closeLocator} tabIndex={-1} /></div>; })}</div>}{hoveredTurn && hoveredIndex >= 0 && typeof document !== 'undefined' && createPortal(<div className="turn-locator-popup" style={{ left: locatorPopupPosition.left, top: locatorPopupPosition.top }} role="tooltip"><strong>回合 {hoveredIndex + 1}</strong><span>{summaryFor(visibleTurns[hoveredIndex])}</span></div>, document.body)}</div>{findOpen && <form className="conversation-find" onSubmit={(event) => { event.preventDefault(); moveFind(1); }}><input ref={findInputRef} value={findQuery} onChange={(event) => setFindQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); setFindOpen(false); } else if (event.key === 'F3' || (event.key === 'Enter' && event.shiftKey)) { event.preventDefault(); moveFind(event.shiftKey ? -1 : 1); } }} placeholder="在当前对话中查找" aria-label="在当前对话中查找" /><span>{findQuery.trim() ? `${findHits.length ? findIndex + 1 : 0}/${findHits.length}` : '0/0'}</span><button type="button" title="上一个" onClick={() => moveFind(-1)}><UiIcon icon={icons.arrowLeft} /></button><button type="button" title="下一个" onClick={() => moveFind(1)}><UiIcon icon={icons.arrowRight} /></button><button type="button" title="关闭" onClick={() => setFindOpen(false)}><UiIcon icon={icons.close} /></button></form>}  <div className="conversation-view codex-scroll" ref={ref}><div className="codex-feed" ref={feedRef}>
    {approval && onApproval ? <ApprovalCard approval={approval} onApproval={onApproval} /> : null}
    {loading && turns.length === 0 ? <div className="codex-loading" role="status"><span className="codex-loading-spinner" /><strong>正在加载线程</strong><small>正在读取本地回合记录…</small></div> : turns.length === 0 ? <div className="codex-empty"><strong>开始新对话</strong><span>描述你希望 Agent 在当前项目中完成的工作。</span></div> : <>{visibleTurns.map((turn, index) => {
      const finalAgent = [...turn.agent].reverse().find((message) => message.text.trim());
      const agentText = compactMarkdown(finalAgent?.text.trim() || '');
      const running = activeTurn === turn.id;
      const expanded = expandedTurns.has(turn.id);
      const showDuration = running || turn.agent.length > 0 || turn.activities.length > 0;
      const activityNodes: React.ReactNode[] = [];
      const timeline = turn.timeline.length > 160 ? turn.timeline.slice(-160) : turn.timeline;
      if (running) {
        // While a turn is active, keep actionable edits and commands visible;
        // raw reasoning events only drive the thinking status indicator.
        const liveActivities: TurnItem[] = [];
        timeline.forEach((entry, timelineIndex) => {
          if (entry.role === 'agent' && entry.message?.text.trim()) {
            activityNodes.push(<MemoAssistantMessage text={entry.message.text.trim()} streaming={timelineIndex === turn.timeline.length - 1} onOpenFile={onOpenFile} key={`live-agent-${timelineIndex}`} />);
          } else if (entry.role === 'activity' && entry.item && entry.item.type !== 'imageView' && entry.item.type !== 'reasoning') {
            liveActivities.push(entry.item);
          }
        });
        if (liveActivities.length > 0) activityNodes.push(<div className="codex-artifact live-processing" key={`live-processing-${turn.id}`}><LiveActivityGroup items={liveActivities} /></div>);
      } else if (expanded) {
        for (let timelineIndex = 0; timelineIndex < timeline.length; timelineIndex += 1) {
          const entry = timeline[timelineIndex];
          if (entry.role === 'agent' && entry.message?.text.trim()) {
            activityNodes.push(<MemoAssistantMessage text={entry.message.text.trim()} onOpenFile={onOpenFile} key={`agent-${timelineIndex}`} />);
          } else if (entry.role === 'activity' && entry.item) {
            const contiguous: TurnItem[] = [entry.item];
            while (timelineIndex + 1 < timeline.length && timeline[timelineIndex + 1].role === 'activity') {
              contiguous.push(timeline[timelineIndex + 1].item!);
              timelineIndex += 1;
            }
            const visible = contiguous.filter((item) => item.type !== 'imageView' && item.type !== 'reasoning');
            if (visible.length === 0) continue;
            if (visible.length === 1 && visible[0].type === 'fileChange') activityNodes.push(<div className="codex-artifact" key={`file-${timelineIndex}`}><FileChangeActivity items={[visible[0]]} /></div>);
            else if (visible.every((item) => item.type === 'fileChange')) activityNodes.push(<div className="codex-artifact" key={`files-${timelineIndex}`}><FileChangeActivity items={visible} /></div>);
            else activityNodes.push(<div className="codex-artifact" key={`activity-group-${timelineIndex}`}><ActivityGroup items={visible} /></div>);
          }
        }
        // Expanded mode shows the original timeline entries; the aggregate
        // file summary is reserved for the completed collapsed state.
      } else {
        if (agentText) activityNodes.push(<MemoAssistantMessage text={agentText} streaming={running} onOpenFile={onOpenFile} key={`final-agent-${turn.id}`} />);
        // Completed turns keep one aggregate edit summary. Command execution
        // remains available only in the live/expanded timeline.
        const allFiles = turn.activities.filter((item) => item.type === 'fileChange');
        let filesInserted = false;
        for (let index = 0; index < timeline.length; index += 1) {
          const entry = timeline[index];
          if (entry.role !== 'activity' || !entry.item || entry.item.type === 'imageView' || entry.item.type === 'reasoning') continue;
          if (entry.item.type === 'fileChange') {
            if (!filesInserted && allFiles.length > 0) { filesInserted = true; activityNodes.push(<div className="codex-artifact" key={`collapsed-files-${turn.id}`}><FileChangesCard items={allFiles} onReview={onOpenReview} /></div>); }
          } else if (entry.item.type === 'commandExecution') {
            // Command execution belongs to the live/expanded timeline. Codex
            // hides it from the completed default view.
          } else activityNodes.push(<div className="codex-artifact" key={`collapsed-${entry.item.id || entry.item.type}-${index}`}><ActivityRow item={entry.item} /></div>);
        }
      }
      return <section ref={(node) => { if (node) turnRefs.current.set(turn.id, node); else turnRefs.current.delete(turn.id); }} className={`turn-block${currentFind?.turnId === turn.id ? ' find-current' : ''}`} data-turn-id={turn.id} key={`${threadKey}:${turn.id}`}>{turn.user.map((message, userIndex) => <MemoUserReply message={message} onOpenImage={onOpenImage} onOpenFile={onOpenFile} key={`user-${userIndex}`} />)}{showDuration && <button type="button" className={`turn-duration-row ${expanded || running ? 'expanded' : ''}`} aria-expanded={expanded || running} onClick={() => toggleTurn(turn.id)}><span>{formatDuration(turn.durationMs, turn.startedAt, running)}</span><UiIcon icon={expanded || running ? icons.down : icons.right} /></button>}{activityNodes.length > 0 && <div className={`turn-activities ${expanded || running ? 'expanded' : ''}`}>{activityNodes}</div>}{running && activityNodes.length === 0 ? <div className="turn-thinking" role="status"><span className="turn-thinking-spinner" /><span>正在思考中</span></div> : expanded && activityNodes.length === 0 && <div className="turn-empty-activity">此回合没有可展开的活动</div>}{agentText && !running && <div className="turn-footer"><button title="复制回复" onClick={() => void navigator.clipboard.writeText(agentText)}><UiIcon icon={icons.copy} /></button><button title="导出回复" onClick={() => void api.export.save(agentText, `reply-${turn.id}.md`)}><UiIcon icon={icons.external} /></button><span><UiIcon icon={icons.clock} /> {formatDuration(turn.durationMs, turn.startedAt)}</span></div>}</section>;
    })}</>}{loading && turns.length > 0 && <div className="codex-loading-more" role="status"><span className="codex-loading-spinner" /> 正在加载更早的回合…</div>}
  </div></div></>;
}

// Composer keystrokes update parent state, but do not change the conversation
// data. Avoid reparsing a large Markdown thread for every typed character.
export const ConversationView = React.memo(ConversationViewImpl, (previous, next) =>
  previous.threadKey === next.threadKey &&
  previous.messages === next.messages &&
  previous.activeTurn === next.activeTurn &&
  previous.approval === next.approval &&
  previous.hasEarlier === next.hasEarlier &&
  previous.loadingEarlier === next.loadingEarlier &&
  previous.loading === next.loading &&
  previous.findTick === next.findTick,
);
