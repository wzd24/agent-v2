import React from 'react';
import hljs from 'highlight.js/lib/common';
import { api, MessageAttachment } from '../api';
import { useAppDialog } from './AppDialog';
import { DiffReviewPanel } from './DiffReviewPanel';
import { MonacoFileEditor } from './MonacoFileEditor';
import { highlightLanguageForPath, isConfigPreviewPath, prettyConfigContent } from '../monacoLanguage';
import { ContextMenu, ContextMenuItem } from './ContextMenu';
import { HtmlFilePreview, StructuredPreview } from './FilePreviews';
export { HtmlFilePreview, StructuredPreview };
import { icons, UiIcon } from './UiIcon';

function highlightDocument(source: string, filePath: string): string {
  try {
    const language = highlightLanguageForPath(filePath);
    if (language && hljs.getLanguage(language)) return hljs.highlight(source, { language, ignoreIllegals: true }).value;
    if (source.trim()) return hljs.highlightAuto(source).value;
  } catch { /* fall through to escaped text */ }
  return source.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

export function isMarkdownPath(filePath: string) {
  return /\.(?:md|mdx|markdown|mdc|mkd)$/i.test(filePath);
}

export function isHtmlPath(filePath: string) {
  return /\.(?:html?|xhtml)$/i.test(filePath);
}

const MarkdownVditor = React.lazy(() => import('./office/MarkdownPreview'));

export function MarkdownFilePreview({ path: filePath, content, onOpenFile, onChange, onSave, resolveUrl, readOnly = false }: { path: string; content: string; onOpenFile?: (path: string) => void; onChange?: (value: string) => void; onSave?: (value: string) => void; resolveUrl?: (href: string) => string; readOnly?: boolean }) {
  return <React.Suspense fallback={<div className="office-visual-status">正在打开 Markdown…</div>}><MarkdownVditor path={filePath} content={content} onOpenFile={onOpenFile} onChange={onChange} onSave={onSave} resolveUrl={resolveUrl} readOnly={readOnly || !onChange} /></React.Suspense>;
}

export function fileIconForName(name: string) {
  const base = String(name || '').split(/[\\/]/).pop()?.toLowerCase() || '';
  if (/^(dockerfile|containerfile)(?:\.[^.]+)*$/.test(base) || /^(makefile|gnumakefile|justfile|procfile|jenkinsfile|gemfile|rakefile|vagrantfile|earthfile|gulpfile|gruntfile|tiltfile|sconstruct|sconscript|jamfile)(?:\.[^.]+)?$/.test(base) || /^cmakelists\.txt$/.test(base) || /^(android\.(?:mk|bp)|application\.mk|build\.(?:xml|gradle|gradle\.kts|sbt|zig|gn|cake)|cake\.config|taskfile(?:\.[^.]+)*\.(?:ya?ml))$/.test(base) || /\.cake$/.test(base)) return icons.fileCode;
  if (/^(?:\.gitignore|\.gitattributes|\.gitmodules|\.editorconfig|\.npmrc|\.yarnrc(?:\..+)?|\.nvmrc|\.node-version|\.python-version|\.tool-versions|codeowners)$/.test(base) || /^\.env(?:\..+)?$/.test(base)) return icons.fileLines;
  if (/^(?:docker-)?compose(?:\.[^.]+)*\.(?:ya?ml)$/.test(base) || /^(package\.json|tsconfig(?:\.[^.]+)*\.json|jsconfig\.json|pyproject\.toml|cargo\.toml|go\.mod)$/.test(base)) return icons.fileLines;
  if (/\.(?:sln|slnx|slnf)$/.test(base) || /\.(?:cs|vb|fs|vcx|vc|njs|sql|py|wix|wap|android|sh|es|dc|cc|sf|pss)proj(?:\.(?:user|filters))?$/.test(base) || /\.(?:proj|projitems|pubxml|uproject|uplugin|pbxproj|iml|ipr|pro)$/.test(base)) return icons.fileLines;
  const extension = base.includes('.') ? base.slice(base.lastIndexOf('.') + 1) : '';
  if (/^(png|apng|jpe?g|jfif|pjpeg|pjp|gif|webp|bmp|svg|ico|cur|psd|icns|tiff?|heic|heif)$/.test(extension)) return icons.fileImage;
  if (/^(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte|astro|go|rs|py|pyw|pyi|rb|php|java|kt|kts|scala|c|cc|cpp|cxx|h|hpp|hh|cs|fs|swift|lua|r|dart|ex|exs|jl|pl|pm|sol|proto|tf|hcl|sh|bash|zsh|ps1|sql|graphql|gql)$/.test(extension)) return icons.fileCode;
  if (/^(json|jsonc|json5|yaml|yml|toml|ini|env|conf|config|xml|svg|plist|properties|gradle|cmake|tfvars|sln|slnx|csproj|vcxproj|props|targets|xaml|resx)$/.test(extension)) return icons.fileLines;
  if (extension === 'pdf') return icons.filePdf;
  if (/^(doc|docx|dotx|odt|rtf)$/.test(extension)) return icons.fileWord;
  if (/^(xls|xlsx|xlsm|ods|csv|tsv)$/.test(extension)) return icons.fileExcel;
  if (/^(ppt|pptx|pptm|odp)$/.test(extension)) return icons.filePowerpoint;
  if (extension === 'epub' || extension === 'xmind') return icons.fileLines;
  if (/^(zip|jar|war|apk|vsix|crx|rar|7z|tar|tgz|gz|bz2|xz)$/.test(extension)) return icons.fileArchive;
  if (extension === "parquet") return icons.fileExcel;
  if (/^(ttf|otf|woff2?|eot)$/.test(extension)) return icons.file;
  if (/^(mp4|mov|avi|mkv|webm)$/.test(extension)) return icons.fileVideo;
  if (/^(mp3|wav|ogg|flac|m4a)$/.test(extension)) return icons.fileAudio;
  if (/^(md|txt|log|csv)$/.test(extension)) return icons.fileLines;
  return icons.file;
}

type WorkspacePanelProps = {
  active: string;
  filePreview: { path: string; content: string; preview?: Record<string, any> } | null;
  imagePreview: { path: string; name: string; dataUrl: string; error?: string } | null;
  reviewOpen: boolean;
  sourcesOpen: boolean;
  browserOpen: boolean;
  reviewDiff: string;
  reviewError?: string;
  filePreviewError?: string;
  reviewFilePath: string;
  conversationSources: MessageAttachment[];
  workspaceRoot: string;
  onSelect: (panel: string) => void;
  onReviewClose: () => void;
  onDocumentClose: () => void;
  onSourcesClose: () => void;
  onBrowserClose: () => void;
  onReviewRefresh: () => void;
  onRestoreFile: (path: string) => Promise<void>;
  onRejectHunk?: (patch: string) => Promise<void>;
  onFileSave?: (path: string, content: string) => Promise<void>;
  onOpenFile?: (path: string, source?: 'tree') => void;
  onAddToChat?: (file: { name: string; path: string }) => void;
  onPathChanged?: (from: string, to: string) => void;
  revealToken?: number;
  onTakeReveal?: (token: number) => string;
  onImagePanelClose?: () => void;
  defaultFileApp?: string;
  diffMarkerStyle?: string;
  browserFindTick?: number;
  wordWrap?: boolean;
  maximized?: boolean;
  hideTabbar?: boolean;
  hideTree?: boolean;
  contentHidden?: boolean;
  onBeginTreeResize?: (event: React.MouseEvent<HTMLDivElement>) => void;
  onMaximize?: () => void;
};

async function openWithDefaultApp(filePath: string, application?: string) {
  const appName = String(application || 'VS Code');
  const result = await api.workspace.openExternal(filePath, appName);
  return result.ok ? '' : (result.output || `无法用 ${appName} 打开文件`);
}

function normalizeDisplayPath(value: string) {
  return String(value || '')
    .replace(/^\\\\\?\\UNC\\/i, '//')
    .replace(/^\\\\\?\\/i, '')
    .replace(/^\/\/\?\//, '')
    .replaceAll('\\', '/')
    .replace(/^\/+([A-Za-z]:)/, '$1')
    .replace(/\/+/g, '/')
    .replace(/\/$/, '');
}

function relativeWorkspacePath(root: string, filePath: string) {
  const prefix = normalizeDisplayPath(root);
  const file = normalizeDisplayPath(filePath);
  if (prefix && file.toLowerCase().startsWith(`${prefix.toLowerCase()}/`)) return file.slice(prefix.length + 1);
  if (prefix && file.toLowerCase() === prefix.toLowerCase()) return '';
  return file;
}

function runEditorAction(editor: import('monaco-editor').editor.IStandaloneCodeEditor | null, id: string) {
  const action = editor?.getAction(id);
  if (action) void action.run();
}

type FileClipboard = { mode: 'copy' | 'cut'; path: string };
let fileClipboard: FileClipboard | null = null;

function FileDocument({ preview, workspaceRoot, onSave, defaultFileApp, wordWrap, onOpenFile, onAddToChat }: { preview: { path: string; content: string; preview?: Record<string, any> }; workspaceRoot: string; onSave?: (path: string, content: string) => Promise<void>; defaultFileApp?: string; wordWrap?: boolean; onOpenFile?: (path: string) => void; onAddToChat?: (file: { name: string; path: string }) => void }) {
  const dialog = useAppDialog();
  const [editing, setEditing] = React.useState(false);
  const [renderMode, setRenderMode] = React.useState<'preview' | 'source'>('preview');
  const [content, setContent] = React.useState(preview.content);
  const [saving, setSaving] = React.useState(false);
  const [menu, setMenu] = React.useState<{ x: number; y: number; kind: 'editor' | 'preview'; editor?: import('monaco-editor').editor.IStandaloneCodeEditor } | null>(null);
  React.useEffect(() => { setContent(preview.content); setEditing(false); setRenderMode('preview'); }, [preview.path, preview.content]);
  const relative = relativeWorkspacePath(workspaceRoot, preview.path);
  const fromArchive = /[/\\]officeViewer-decompress-/i.test(preview.path);
  const structured = preview.preview;
  const markdown = !structured && isMarkdownPath(preview.path);
  const html = !structured && !markdown && isHtmlPath(preview.path);
  const config = !structured && !markdown && !html && isConfigPreviewPath(preview.path);
  const canPreview = markdown || config || html;
  const canEdit = !structured && !fromArchive;
  const dirty = canEdit && content !== preview.content;
  const contentRef = React.useRef(content);
  contentRef.current = content;
  async function save(next?: string) { if (!onSave) return; const value = next ?? contentRef.current; setSaving(true); try { await onSave(preview.path, value); setEditing(false); } finally { setSaving(false); } }
  const fileName = preview.path.split(/[\\/]/).pop() || preview.path;
  const previewMenu: ContextMenuItem[] = [
    { id: 'copy', label: '复制' },
    ...(onAddToChat ? [{ id: 'add-to-chat', label: '添加到对话' }] : []),
    { separator: true },
    { id: 'copy-path', label: '复制路径' },
    { id: 'copy-relative', label: '复制相对路径' },
    { id: 'reveal', label: '在资源管理器中显示' },
    ...(canEdit ? [{ separator: true } as const, { id: 'edit', label: '编辑文件' }] : []),
  ];
  const editorMenu = (readOnly: boolean): ContextMenuItem[] => [
    { id: 'cut', label: '剪切', disabled: readOnly },
    { id: 'copy', label: '复制' },
    { id: 'paste', label: '粘贴', disabled: readOnly },
    { id: 'select-all', label: '全选' },
    { separator: true },
    { id: 'find', label: '查找' },
    { id: 'change-all', label: '更改所有匹配项', disabled: readOnly },
    { id: 'format', label: '格式化文档', disabled: readOnly },
    { separator: true },
    ...(onAddToChat ? [{ id: 'add-to-chat', label: '添加到对话' }] : []),
    { id: 'copy-path', label: '复制路径' },
    { id: 'copy-relative', label: '复制相对路径' },
    { id: 'reveal', label: '在资源管理器中显示' },
  ];
  async function handleDocumentMenu(id: string) {
    const editor = menu?.editor || null;
    if (id === 'cut') runEditorAction(editor, 'editor.action.clipboardCutAction');
    else if (id === 'copy') {
      if (menu?.kind === 'preview') {
        const selected = window.getSelection()?.toString() || content;
        await navigator.clipboard.writeText(selected);
      } else runEditorAction(editor, 'editor.action.clipboardCopyAction');
    }
    else if (id === 'paste') runEditorAction(editor, 'editor.action.clipboardPasteAction');
    else if (id === 'select-all') runEditorAction(editor, 'editor.action.selectAll');
    else if (id === 'find') runEditorAction(editor, 'actions.find');
    else if (id === 'change-all') runEditorAction(editor, 'editor.action.changeAll');
    else if (id === 'format') runEditorAction(editor, 'editor.action.formatDocument');
    else if (id === 'add-to-chat') onAddToChat?.({ name: fileName, path: preview.path });
    else if (id === 'copy-path') await navigator.clipboard.writeText(preview.path);
    else if (id === 'copy-relative') await navigator.clipboard.writeText(relative);
    else if (id === 'reveal') await api.workspace.revealInFolder(preview.path);
    else if (id === 'edit') setEditing(true);
  }
  const openPreviewMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, kind: 'preview' });
  };
  const showPreview = canPreview && !editing && renderMode === 'preview';
  const body = structured ? <div className="workspace-preview-host" onContextMenu={openPreviewMenu}><StructuredPreview path={preview.path} content={preview.content} preview={structured} onOpenFile={onOpenFile} /></div> : showPreview && markdown ? <div className="workspace-preview-host" onContextMenu={openPreviewMenu}><MarkdownFilePreview path={preview.path} content={content} onOpenFile={onOpenFile} readOnly={!onSave} onChange={onSave ? setContent : undefined} onSave={(value) => void save(value)} /></div> : showPreview && html ? <div className="workspace-preview-host" onContextMenu={openPreviewMenu}><HtmlFilePreview content={content} /></div> : showPreview && config ? <div className="workspace-preview-host" onContextMenu={openPreviewMenu}><ConfigFilePreview path={preview.path} content={content} /></div> : <MonacoFileEditor path={preview.path} value={content} readOnly={!editing} wordWrap={wordWrap} onChange={setContent} onSave={() => { if (editing) void save(); }} onContextMenu={({ x, y, editor }) => setMenu({ x, y, kind: 'editor', editor })} />;
  return <div className="workspace-document"><div className="workspace-document-head"><span title={preview.path}>{dirty ? `${relative} •` : relative}</span>{canPreview && !editing && <button type="button" className={renderMode === 'source' ? 'active' : ''} title={renderMode === 'preview' ? '查看源码' : '查看预览'} onClick={() => setRenderMode((current) => current === 'preview' ? 'source' : 'preview')}><UiIcon icon={renderMode === 'preview' ? icons.code : icons.fileLines} /></button>}<button type="button" title={`用 ${defaultFileApp || 'VS Code'} 打开`} onClick={() => void openWithDefaultApp(preview.path, defaultFileApp).then((error) => { if (error) void dialog.alert('无法打开文件', error); })}><UiIcon icon={icons.external} /></button>{canEdit && <button type="button" title={editing ? '取消编辑' : '编辑源码'} onClick={() => { if (editing) setContent(preview.content); setEditing((value) => !value); }}><UiIcon icon={editing ? icons.close : icons.compose} /></button>}{(editing || (showPreview && markdown && dirty)) && <button type="button" className="workspace-document-save" title={saving ? '保存中…' : '保存'} disabled={saving || !dirty} onClick={() => void save()}><UiIcon icon={saving ? icons.refresh : icons.save} /></button>}</div>{body}{menu && <ContextMenu x={menu.x} y={menu.y} items={menu.kind === 'editor' ? editorMenu(!editing) : previewMenu} onSelect={(id) => void handleDocumentMenu(id)} onClose={() => setMenu(null)} />}{dialog.node}</div>;
}

export function ConfigFilePreview({ path: filePath, content }: { path: string; content: string }) {
  const text = prettyConfigContent(filePath, content);
  return <pre className="workspace-document-content workspace-config-preview"><code dangerouslySetInnerHTML={{ __html: highlightDocument(text, filePath) }} /></pre>;
}

function normalizeBrowserUrl(value: string) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return text;
  return `https://${text}`;
}

function BrowserPanel({ findTick = 0 }: { findTick?: number }) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const findInputRef = React.useRef<HTMLInputElement>(null);
  const [url, setUrl] = React.useState('https://www.google.com');
  const [canGoBack, setCanGoBack] = React.useState(false);
  const [canGoForward, setCanGoForward] = React.useState(false);
  const [findOpen, setFindOpen] = React.useState(false);
  const [findQuery, setFindQuery] = React.useState('');
  const [findCount, setFindCount] = React.useState('0/0');
  const [browserError, setBrowserError] = React.useState('');
  const findQueryRef = React.useRef(findQuery);
  findQueryRef.current = findQuery;
  const reportBounds = React.useCallback(() => {
    const node = hostRef.current;
    if (!node) return { x: 0, y: 0, width: 1, height: 1 };
    const rect = node.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
  }, []);
  const runFind = React.useCallback((query: string, options: { findNext?: boolean; forward?: boolean } = {}) => {
    const text = String(query || '').trim();
    if (!text) {
      void api.browser.find('');
      setFindCount('0/0');
      return;
    }
    void api.browser.find(text, { forward: options.forward !== false, findNext: Boolean(options.findNext) });
  }, []);
  const closeFind = React.useCallback(() => {
    setFindOpen(false);
    runFind('');
  }, [runFind]);
  React.useEffect(() => {
    if (!findTick) return;
    setFindOpen(true);
    window.requestAnimationFrame(() => findInputRef.current?.focus());
  }, [findTick]);
  React.useEffect(() => {
    setBrowserError('');
    void api.browser.status().then((status) => {
      if (status?.url) {
        setUrl(status.url);
        setCanGoBack(Boolean(status.canGoBack));
        setCanGoForward(Boolean(status.canGoForward));
      }
      return api.browser.show({
        ...(status?.url ? { url: status.url } : {}),
        ...reportBounds(),
      });
    }).catch((error) => {
      setBrowserError(String(error));
      return api.browser.show({ ...reportBounds() }).catch((showError) => {
        setBrowserError(String(showError));
      });
    });
    const un = api.browser.onNavigated((payload) => {
      if (payload?.url) {
        setUrl(payload.url);
        setCanGoBack(Boolean(payload.canGoBack));
        setCanGoForward(Boolean(payload.canGoForward));
      }
      const query = findQueryRef.current.trim();
      if (query) runFind(query);
      else setFindCount('0/0');
    });
    const unFind = api.browser.onFind((payload) => {
      const matches = Number(payload?.matches || 0);
      const active = Number(payload?.active || 0);
      setFindCount(payload?.label || (matches ? `${active || 0}/${matches}` : '0/0'));
    });
    const sync = () => { void api.browser.setBounds(reportBounds()); };
    const observer = new ResizeObserver(sync);
    if (hostRef.current) observer.observe(hostRef.current);
    window.addEventListener('resize', sync);
    window.addEventListener('focus', sync);
    document.addEventListener('visibilitychange', sync);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', sync);
      window.removeEventListener('focus', sync);
      document.removeEventListener('visibilitychange', sync);
      un();
      unFind();
      void api.browser.hide();
    };
  }, [reportBounds]);
  const navigate = (event: React.FormEvent) => {
    event.preventDefault();
    const value = normalizeBrowserUrl(url);
    if (!value) return;
    setUrl(value);
    void api.browser.navigate(value);
  };
  return <div className="workspace-browser">
    <form className="workspace-browser-toolbar" onSubmit={navigate}>
      <button type="button" title="后退" disabled={!canGoBack} onClick={() => void api.browser.back()}><UiIcon icon={icons.arrowLeft} /></button>
      <button type="button" title="前进" disabled={!canGoForward} onClick={() => void api.browser.forward()}><UiIcon icon={icons.arrowRight} /></button>
      <button type="button" title="刷新" onClick={() => void api.browser.reload()}><UiIcon icon={icons.refresh} /></button>
      <input value={url} onChange={(event) => setUrl(event.target.value)} aria-label="浏览器地址" />
      <button type="submit" title="访问" className="workspace-browser-go"><UiIcon icon={icons.arrowRight} /></button>
      <button type="button" title="在页面中查找" onClick={() => { setFindOpen(true); window.requestAnimationFrame(() => findInputRef.current?.focus()); }}><UiIcon icon={icons.search} /></button>
    </form>
    {findOpen && <form className="conversation-find workspace-browser-find" onSubmit={(event) => { event.preventDefault(); runFind(findQuery, { findNext: true, forward: true }); }}>
      <input ref={findInputRef} value={findQuery} onChange={(event) => { setFindQuery(event.target.value); runFind(event.target.value); }} onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); closeFind(); } else if (event.key === 'F3' || (event.key === 'Enter' && event.shiftKey)) { event.preventDefault(); runFind(findQuery, { findNext: true, forward: !event.shiftKey }); } }} placeholder="在页面中查找" aria-label="在页面中查找" />
      <span>{findCount}</span>
      <button type="button" title="上一个" onClick={() => runFind(findQuery, { findNext: true, forward: false })}><UiIcon icon={icons.arrowLeft} /></button>
      <button type="button" title="下一个" onClick={() => runFind(findQuery, { findNext: true, forward: true })}><UiIcon icon={icons.arrowRight} /></button>
      <button type="button" title="关闭" onClick={closeFind}><UiIcon icon={icons.close} /></button>
    </form>}
    {browserError && <div className="plugins-message">{browserError}</div>}
    <div ref={hostRef} className="workspace-browser-view" />
  </div>;
}

type TreeEntry = { name: string; type: 'directory' | 'file'; children?: TreeEntry[] | null };

function joinTreePath(parent: string, name: string) {
  return `${String(parent || '').replace(/[\\/]+$/, '')}\\${name}`;
}

function ancestorDirectories(root: string, filePath: string) {
  const rootNorm = String(root || '').replace(/[\\/]+$/, '');
  const fileNorm = String(filePath || '').replace(/[\\/]+$/, '');
  if (!rootNorm || !fileNorm || !fileNorm.toLowerCase().startsWith(rootNorm.toLowerCase())) return [];
  const relative = fileNorm.slice(rootNorm.length).replace(/^[\\/]+/, '');
  const parts = relative.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 1) return [];
  parts.pop();
  const dirs: string[] = [];
  let current = rootNorm;
  for (const part of parts) {
    current = `${current}\\${part}`;
    dirs.push(current);
  }
  return dirs;
}

function replaceTreeChildren(nodes: TreeEntry[], parent: string, directory: string, children: TreeEntry[]): TreeEntry[] {
  if (parent.toLowerCase() === directory.toLowerCase()) return children;
  return nodes.map((node) => {
    if (node.type !== 'directory') return node;
    const path = joinTreePath(parent, node.name);
    if (path.toLowerCase() === directory.toLowerCase()) return { ...node, children };
    if (Array.isArray(node.children)) return { ...node, children: replaceTreeChildren(node.children, path, directory, children) };
    return node;
  });
}

function directoriesToLoad(root: string, activePath: string, expanded: Iterable<string>) {
  const keep = new Set<string>();
  for (const dir of [...ancestorDirectories(root, activePath), ...expanded]) {
    for (const ancestor of ancestorDirectories(root, joinTreePath(dir, '_'))) keep.add(ancestor);
  }
  return keep;
}

function WorkspaceTree({ root, activePath, revealToken = 0, onTakeReveal, onOpenFile, onAddToChat, onPathChanged, onDeleted }: { root: string; activePath: string; revealToken?: number; onTakeReveal?: (token: number) => string; onOpenFile?: (path: string, source?: 'tree') => void; onAddToChat?: (file: { name: string; path: string }) => void; onPathChanged?: (from: string, to: string) => void; onDeleted?: (path: string) => void }) {
  const dialog = useAppDialog();
  const [entries, setEntries] = React.useState<TreeEntry[]>([]);
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [query, setQuery] = React.useState('');
  const [tick, setTick] = React.useState(0);
  const [menu, setMenu] = React.useState<{ x: number; y: number; path: string; type: 'file' | 'directory' | 'blank' } | null>(null);
  const expandedRef = React.useRef(expanded);
  const initialRevealRef = React.useRef(true);
  expandedRef.current = expanded;
  const reload = React.useCallback(() => setTick((value) => value + 1), []);
  const loadFolder = React.useCallback(async (dir: string) => {
    const result = await api.workspace.tree({ root: dir, depth: 0 });
    return (result.entries || []) as TreeEntry[];
  }, []);
  const takeReveal = React.useCallback(() => {
    if (!revealToken || !onTakeReveal) return '';
    return onTakeReveal(revealToken);
  }, [revealToken, onTakeReveal]);
  const takeRevealRef = React.useRef(takeReveal);
  takeRevealRef.current = takeReveal;
  const revealDirectories = React.useCallback(async (filePath: string) => {
    const chain = ancestorDirectories(root, filePath);
    if (!chain.length) return;
    setExpanded((current) => {
      const next = new Set(current);
      let changed = false;
      for (const dir of chain) {
        if (!next.has(dir)) { next.add(dir); changed = true; }
      }
      return changed ? next : current;
    });
    for (const dir of chain) {
      try {
        const children = await loadFolder(dir);
        setEntries((tree) => replaceTreeChildren(tree, root, dir, children));
      } catch { /* folder may have been removed */ }
    }
  }, [root, loadFolder]);
  React.useEffect(() => { initialRevealRef.current = true; }, [root]);
  React.useEffect(() => {
    let cancelled = false;
    if (!root) return undefined;
    void (async () => {
      const reveal = initialRevealRef.current ? takeRevealRef.current() : '';
      initialRevealRef.current = false;
      try {
        let tree = await loadFolder(root);
        const keep = directoriesToLoad(root, reveal, expandedRef.current);
        for (const dir of keep) {
          const children = await loadFolder(dir);
          if (cancelled) return;
          tree = replaceTreeChildren(tree, root, dir, children);
        }
        if (cancelled) return;
        setEntries(tree);
        setExpanded((current) => new Set([...keep, ...current]));
      } catch {
        if (!cancelled) setEntries([]);
      }
    })();
    return () => { cancelled = true; };
  }, [root, tick, loadFolder]);
  React.useEffect(() => {
    if (!root || !revealToken) return;
    const path = takeReveal();
    if (path) void revealDirectories(path);
  }, [root, revealToken, takeReveal, revealDirectories]);
  const parentOf = (filePath: string) => filePath.replace(/[\\/][^\\/]+$/, '') || root;
  const destinationFor = (target: { path: string; type: string }) => target.type === 'directory' || target.type === 'blank' ? (target.type === 'blank' ? root : target.path) : parentOf(target.path);
  async function create(parent: string, type: 'file' | 'directory') {
    const name = await dialog.prompt(type === 'directory' ? '新建文件夹' : '新建文件', type === 'directory' ? '新建文件夹' : 'untitled.txt', { placeholder: '名称' });
    if (!name?.trim()) return;
    const created = await api.workspace.createEntry(parent, name.trim(), type);
    reload();
    if (type === 'file') onOpenFile?.(created.path, 'tree');
  }
  async function handleTreeMenu(id: string) {
    if (!menu) return;
    const targetPath = menu.type === 'blank' ? root : menu.path;
    const name = targetPath.split(/[\\/]/).pop() || targetPath;
    try {
      if (id === 'add-to-chat' && menu.type === 'file') onAddToChat?.({ name, path: targetPath });
      else if (id === 'open' && menu.type === 'file') onOpenFile?.(targetPath, 'tree');
      else if (id === 'reveal') await api.workspace.revealInFolder(targetPath);
      else if (id === 'open-vscode') {
        const result = await api.workspace.openInEditor(root, 'VS Code');
        if (!result.ok) await dialog.alert('无法打开工作区', result.output || '未找到 VS Code');
      }
      else if (id === 'new-file') await create(destinationFor(menu), 'file');
      else if (id === 'new-folder') await create(destinationFor(menu), 'directory');
      else if (id === 'copy-path') await navigator.clipboard.writeText(targetPath);
      else if (id === 'copy-relative') await navigator.clipboard.writeText(relativeWorkspacePath(root, targetPath));
      else if (id === 'cut' && menu.type !== 'blank') fileClipboard = { mode: 'cut', path: targetPath };
      else if (id === 'copy' && menu.type !== 'blank') fileClipboard = { mode: 'copy', path: targetPath };
      else if (id === 'paste') {
        if (!fileClipboard) return;
        const dest = destinationFor(menu);
        const moved = fileClipboard.mode === 'cut'
          ? await api.workspace.moveEntry(fileClipboard.path, dest)
          : await api.workspace.copyEntry(fileClipboard.path, dest);
        if (fileClipboard.mode === 'cut') {
          onPathChanged?.(fileClipboard.path, moved.path);
          fileClipboard = null;
        }
        reload();
      }
      else if (id === 'rename' && menu.type !== 'blank') {
        const next = await dialog.prompt('重命名', name, { placeholder: '新名称' });
        if (!next?.trim() || next.trim() === name) return;
        const renamed = await api.workspace.renameEntry(targetPath, next.trim());
        onPathChanged?.(targetPath, renamed.path);
        reload();
      }
      else if (id === 'delete' && menu.type !== 'blank') {
        const ok = await dialog.confirm('删除', `确定删除 ${name}？此操作不能撤销。`);
        if (!ok) return;
        await api.workspace.deleteEntry(targetPath);
        onDeleted?.(targetPath);
        reload();
      }
    } catch (error) {
      await dialog.alert('无法完成操作', String(error));
    }
  }
  const treeItems = (kind: 'file' | 'directory' | 'blank'): ContextMenuItem[] => {
    if (kind === 'blank') return [
      { id: 'new-file', label: '新建文件' },
      { id: 'new-folder', label: '新建文件夹' },
      { id: 'reveal', label: '在资源管理器中显示' },
      { id: 'open-vscode', label: '用 VS Code 打开工作区' },
      { separator: true },
      { id: 'paste', label: '粘贴', disabled: !fileClipboard },
    ];
    return [
      ...(kind === 'file' && onAddToChat ? [{ id: 'add-to-chat', label: '添加到对话' }] : []),
      ...(kind === 'file' ? [{ id: 'open', label: '打开' }] : []),
      { id: 'reveal', label: '在资源管理器中显示' },
      { separator: true },
      { id: 'new-file', label: '新建文件' },
      { id: 'new-folder', label: '新建文件夹' },
      { separator: true },
      { id: 'copy-path', label: '复制路径' },
      { id: 'copy-relative', label: '复制相对路径' },
      { separator: true },
      { id: 'cut', label: '剪切' },
      { id: 'copy', label: '复制' },
      { id: 'paste', label: '粘贴', disabled: !fileClipboard },
      { separator: true },
      { id: 'rename', label: '重命名' },
      { id: 'delete', label: '删除', danger: true },
    ];
  };
  const openMenu = (event: React.MouseEvent, path: string, type: 'file' | 'directory' | 'blank') => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, path, type });
  };
  const toggleDirectory = (path: string, nextOpen: boolean, children?: TreeEntry[] | null) => {
    setExpanded((current) => {
      if (current.has(path) === nextOpen) return current;
      const next = new Set(current);
      if (nextOpen) next.add(path);
      else next.delete(path);
      return next;
    });
    if (nextOpen && children == null) {
      void loadFolder(path).then((loaded) => {
        setEntries((tree) => replaceTreeChildren(tree, root, path, loaded));
      }).catch(() => undefined);
    }
  };
  const render = (items: TreeEntry[], parent = root, depth = 0): React.ReactNode => items.filter((item) => !query.trim() || String(item.name).toLowerCase().includes(query.trim().toLowerCase())).map((item) => {
    const path = joinTreePath(parent, item.name);
    if (item.type === 'directory') {
      const isOpen = expanded.has(path);
      return <details className="workspace-tree-directory" open={isOpen} key={path} onToggle={(event) => toggleDirectory(path, (event.currentTarget as HTMLDetailsElement).open, item.children)} onContextMenu={(event) => openMenu(event, path, 'directory')}>
        <summary style={{ paddingLeft: `${6 + depth * 14}px` }} onContextMenu={(event) => openMenu(event, path, 'directory')}>
          <UiIcon icon={isOpen ? icons.down : icons.right} />
          <UiIcon icon={isOpen ? icons.folderOpen : icons.folder} />
          <span>{item.name}</span>
        </summary>
        {isOpen && Array.isArray(item.children) && render(item.children, path, depth + 1)}
      </details>;
    }
    return <button type="button" className={`workspace-tree-file ${path.toLowerCase() === activePath.toLowerCase() ? 'active' : ''}`} style={{ paddingLeft: `${22 + depth * 14}px` }} title={path} onClick={() => onOpenFile?.(path, 'tree')} onContextMenu={(event) => openMenu(event, path, 'file')}><UiIcon icon={fileIconForName(item.name)} /><span>{item.name}</span></button>;
  });
  return <aside className="workspace-tree" onContextMenu={(event) => openMenu(event, root, 'blank')}>
    <label><UiIcon icon={icons.search} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选文件…" /></label>
    <div className="workspace-tree-list">{render(entries)}</div>
    {menu && <ContextMenu x={menu.x} y={menu.y} items={treeItems(menu.type)} onSelect={(id) => void handleTreeMenu(id)} onClose={() => setMenu(null)} />}
    {dialog.node}
  </aside>;
}

export function WorkspacePanel({ active, filePreview, filePreviewError, imagePreview, reviewOpen, sourcesOpen, browserOpen, reviewDiff, reviewError, reviewFilePath, conversationSources, workspaceRoot, onSelect, onReviewClose, onDocumentClose, onSourcesClose, onBrowserClose, onReviewRefresh, onRestoreFile, onRejectHunk, onFileSave, onOpenFile, onAddToChat, onPathChanged, revealToken = 0, onTakeReveal, onImagePanelClose, defaultFileApp, diffMarkerStyle, browserFindTick = 0, wordWrap, maximized = false, hideTabbar = false, hideTree = false, contentHidden = false, onBeginTreeResize, onMaximize }: WorkspacePanelProps) {
  const documentOpen = Boolean(filePreview || imagePreview || filePreviewError);
  const documentName = imagePreview?.name || filePreview?.path.split(/[\\/]/).pop() || (filePreviewError ? '读取失败' : '文档');
  const open = active === 'review' || active === 'sources' || active === 'browser' || active === 'files' || (active === 'image' && imagePreview) || (maximized && documentOpen);
  if (!open) return null;
  const closePanel = () => onSelect('');
  const showFilesLayout = active === 'files' || (maximized && Boolean(filePreview || filePreviewError) && contentHidden);
  const showImageLayout = active === 'image' && Boolean(imagePreview);
  const showTree = !hideTree || maximized;
  const treeResizeHandle = onBeginTreeResize ? <div className="panel-resize-handle panel-resize-tree" role="separator" aria-label="调整文件树宽度" onMouseDown={onBeginTreeResize} /> : null;
  return <aside className={`workspace-panel${active === 'review' ? ' workspace-review-panel' : ''}${maximized ? ' is-maximized' : ''}${contentHidden ? ' is-tree-only' : ''}`} aria-label="工作区面板">
    {!hideTabbar && <div className="workspace-panel-tabbar">
      {reviewOpen && <div className={`workspace-panel-tab ${active === 'review' ? 'active' : ''}`}><button type="button" onClick={() => onSelect('review')}><UiIcon icon={icons.fileCode} /><strong>审查</strong></button><button type="button" className="workspace-panel-tab-close" title="关闭审查" onClick={onReviewClose}><UiIcon icon={icons.close} /></button></div>}
      {browserOpen && <div className={`workspace-panel-tab ${active === 'browser' ? 'active' : ''}`}><button type="button" onClick={() => onSelect('browser')}><UiIcon icon={icons.globe} /><strong>浏览器</strong></button><button type="button" className="workspace-panel-tab-close" title="关闭浏览器" onClick={onBrowserClose}><UiIcon icon={icons.close} /></button></div>}
      {documentOpen && <DocumentTab label={documentName} path={imagePreview?.path || filePreview?.path || ''} image={Boolean(imagePreview)} active={active === 'files' || active === 'image'} workspaceRoot={workspaceRoot} onSelect={() => onSelect(imagePreview ? 'image' : 'files')} onClose={onDocumentClose} onAddToChat={onAddToChat} />}
      {sourcesOpen && <div className={`workspace-panel-tab ${active === 'sources' ? 'active' : ''}`}><button type="button" onClick={() => onSelect('sources')}><UiIcon icon={icons.link} /><strong>来源</strong></button><button type="button" className="workspace-panel-tab-close" title="关闭来源" onClick={onSourcesClose}><UiIcon icon={icons.close} /></button></div>}
      <span className="workspace-panel-spacer" />
      {documentOpen && onMaximize && <button type="button" className="workspace-panel-close" title="最大化编辑器" aria-label="最大化编辑器" onClick={onMaximize}><UiIcon icon={icons.expand} /></button>}
      <button type="button" className="workspace-panel-close" title="关闭右侧栏" onClick={closePanel}><UiIcon icon={icons.close} /></button>
    </div>}
    {active === 'review' && !contentHidden && <DiffReviewPanel diff={reviewDiff} error={reviewError} focusPath={reviewFilePath} workspaceRoot={workspaceRoot} onRefresh={onReviewRefresh} onRestoreFile={onRestoreFile} onRejectHunk={onRejectHunk} markerStyle={diffMarkerStyle} />}
    {active === 'browser' && !contentHidden && <BrowserPanel findTick={browserFindTick} />}
    {showFilesLayout && <div className="workspace-files-layout"><div className="workspace-files-main" hidden={contentHidden || undefined}>{filePreviewError ? <div className="workspace-files-empty">{filePreviewError}</div> : filePreview ? <FileDocument preview={filePreview} workspaceRoot={workspaceRoot} onSave={onFileSave} defaultFileApp={defaultFileApp} wordWrap={wordWrap} onOpenFile={onOpenFile} onAddToChat={onAddToChat} /> : <div className="workspace-files-empty">从右侧文件树选择一个文件</div>}</div>{showTree && treeResizeHandle}{showTree && <WorkspaceTree root={workspaceRoot} activePath={filePreview?.path || imagePreview?.path || ''} revealToken={revealToken} onTakeReveal={onTakeReveal} onOpenFile={onOpenFile} onAddToChat={onAddToChat} onPathChanged={onPathChanged} onDeleted={(path) => { if (path.toLowerCase() === (filePreview?.path || imagePreview?.path || '').toLowerCase()) onDocumentClose(); }} />}</div>}
    {showImageLayout && <div className={`workspace-files-layout${contentHidden ? ' is-tree-only' : ''}`}><div className="workspace-image" hidden={contentHidden || undefined}><div className="workspace-image-head"><span>{imagePreview.name}</span><button type="button" title={`用 ${defaultFileApp || 'VS Code'} 打开`} onClick={() => void openWithDefaultApp(imagePreview.path, defaultFileApp)}><UiIcon icon={icons.external} /></button><button type="button" title="关闭图片并返回文件树" onClick={onImagePanelClose}><UiIcon icon={icons.close} /></button></div>{imagePreview.error ? <div className="workspace-image-state">{imagePreview.error}</div> : imagePreview.dataUrl ? <img src={imagePreview.dataUrl} alt={imagePreview.name} /> : <div className="workspace-image-state">正在加载图片…</div>}</div>{showTree && treeResizeHandle}{showTree && <WorkspaceTree root={workspaceRoot} activePath={imagePreview.path} revealToken={revealToken} onTakeReveal={onTakeReveal} onOpenFile={onOpenFile} onAddToChat={onAddToChat} onPathChanged={onPathChanged} onDeleted={(path) => { if (path.toLowerCase() === imagePreview.path.toLowerCase()) onDocumentClose(); }} />}</div>}
    {active === 'sources' && <div className="workspace-sources">{conversationSources.length === 0 ? <div className="workspace-image-state">当前线程没有附加资源</div> : conversationSources.map((source) => <div className="workspace-source-row" key={source.path}><UiIcon icon={String(source.type || '').startsWith('image/') ? icons.image : icons.file} /><span title={source.path}>{source.name || source.path.split(/[\\/]/).pop() || source.path}</span></div>)}</div>}
  </aside>;
}

function DocumentTab({ label, path, image, active, workspaceRoot, onSelect, onClose, onAddToChat }: { label: string; path: string; image?: boolean; active: boolean; workspaceRoot: string; onSelect: () => void; onClose: () => void; onAddToChat?: (file: { name: string; path: string }) => void }) {
  const [menu, setMenu] = React.useState<{ x: number; y: number } | null>(null);
  const items: ContextMenuItem[] = [
    { id: 'close', label: '关闭' },
    ...(onAddToChat && !image ? [{ id: 'add-to-chat', label: '添加到对话' }] : []),
    { separator: true },
    { id: 'copy-path', label: '复制路径' },
    { id: 'copy-relative', label: '复制相对路径' },
    { id: 'reveal', label: '在资源管理器中显示' },
  ];
  async function handle(id: string) {
    if (id === 'close') onClose();
    else if (id === 'add-to-chat') onAddToChat?.({ name: label, path });
    else if (id === 'copy-path') await navigator.clipboard.writeText(path);
    else if (id === 'copy-relative') await navigator.clipboard.writeText(relativeWorkspacePath(workspaceRoot, path));
    else if (id === 'reveal') await api.workspace.revealInFolder(path);
  }
  return <div className={`workspace-panel-tab ${active ? 'active' : ''}`} role="tab" aria-selected={active} onContextMenu={(event) => { event.preventDefault(); setMenu({ x: event.clientX, y: event.clientY }); }}>
    <button type="button" title={path} onClick={onSelect}><UiIcon icon={image ? icons.image : fileIconForName(label)} /><strong>{label}</strong></button>
    <button type="button" className="workspace-panel-tab-close" title="关闭文档" onClick={onClose}><UiIcon icon={icons.close} /></button>
    {menu && <ContextMenu x={menu.x} y={menu.y} items={items} onSelect={(id) => void handle(id)} onClose={() => setMenu(null)} />}
  </div>;
}

type EditorWorkbenchTabBarProps = {
  conversationTitle: string;
  conversationActive: boolean;
  filePreview: { path: string } | null;
  imagePreview: { path: string; name: string } | null;
  documentActive: boolean;
  workspaceRoot?: string;
  treeOpen?: boolean;
  onSelectConversation: () => void;
  onSelectDocument: () => void;
  onCloseDocument: () => void;
  onAddToChat?: (file: { name: string; path: string }) => void;
  onToggleTree?: () => void;
  onRestore: () => void;
};

export function EditorWorkbenchTabBar({ conversationTitle, conversationActive, filePreview, imagePreview, documentActive, workspaceRoot = '', treeOpen = false, onSelectConversation, onSelectDocument, onCloseDocument, onAddToChat, onToggleTree, onRestore }: EditorWorkbenchTabBarProps) {
  const documentName = imagePreview?.name || filePreview?.path.split(/[\\/]/).pop() || '文档';
  const documentPath = imagePreview?.path || filePreview?.path || '';
  const documentOpen = Boolean(filePreview || imagePreview);
  return <div className="workbench-tabbar" role="tablist" aria-label="编辑器标签">
    <div className={`workspace-panel-tab workbench-tab-pinned ${conversationActive ? 'active' : ''}`} role="tab" aria-selected={conversationActive}>
      <button type="button" title={conversationTitle} aria-label={`${conversationTitle}（不可关闭）`} onClick={onSelectConversation}>
        <UiIcon icon={icons.comments} />
      </button>
    </div>
    {documentOpen && <DocumentTab label={documentName} path={documentPath} image={Boolean(imagePreview)} active={documentActive} workspaceRoot={workspaceRoot} onSelect={onSelectDocument} onClose={onCloseDocument} onAddToChat={onAddToChat} />}
    {onToggleTree && <button type="button" className={`workbench-tab-add${treeOpen ? ' active' : ''}`} title="打开文件" aria-label="打开文件" onClick={onToggleTree}><UiIcon icon={icons.plus} /></button>}
    <span className="workspace-panel-spacer" />
    <button type="button" className="workspace-panel-close" title="退出最大化" aria-label="退出最大化" onClick={onRestore}><UiIcon icon={icons.compress} /></button>
  </div>;
}
