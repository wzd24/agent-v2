import React from 'react';
import { api } from '../api';
import type { CodexProject, Thread } from '../api';
import { resolveBackgroundImageSettings } from '../backgroundImageSettings';
import { useAppDialog } from './AppDialog';
import { APP_SHORTCUTS, SHORTCUT_GROUPS, bindingFor, formatShortcutEvent, shortcutPref } from '../shortcuts';
import { icons, UiIcon } from './UiIcon';
import { AutomationsView } from './AutomationsView';

type Props = {
  section: string;
  config: Record<string, any>;
  onSave: (key: string, value: any) => void | Promise<void>;
  onImport?: () => Promise<string>;
  onExport?: () => Promise<string>;
  archivedThreads?: Thread[];
  projects?: CodexProject[];
  archivedLoading?: boolean;
  onOpenThread?: (threadId: string) => void | Promise<void>;
  onUnarchiveThread?: (thread: Thread) => void | Promise<void>;
  onDeleteThread?: (thread: Thread) => void | Promise<void>;
  onDeleteAllArchived?: (threads: Thread[]) => void | Promise<void>;
};
type RowProps = { title: string; description?: string; children: React.ReactNode };

function Row({ title, description, children }: RowProps) { return <div className="settings-row"><div className="settings-row-copy"><strong>{title}</strong>{description && <small>{description}</small>}</div><div className="settings-row-control">{children}</div></div>; }
function Select({ value, options, onChange }: { value: string; options: string[]; onChange?: (value: string) => void }) { return <select className="settings-select" value={value} onChange={(event) => onChange?.(event.target.value)}>{options.map((option) => <option key={option}>{option}</option>)}</select>; }
function Toggle({ value, onChange, disabled = false }: { value: boolean; onChange: (value: boolean) => void; disabled?: boolean }) { return <button type="button" role="switch" aria-checked={value} disabled={disabled} className={`settings-toggle ${value ? 'on' : ''}`} onClick={() => onChange(!value)}><span /></button>; }
function Input({ value, placeholder, onSave }: { value: string; placeholder?: string; onSave: (value: string) => void }) { const [text, setText] = React.useState(value); React.useEffect(() => setText(value), [value]); return <input className="settings-inline-input" value={text} placeholder={placeholder} onChange={(event) => setText(event.target.value)} onBlur={() => onSave(text)} />; }
function JsonArrayInput({ value, onSave }: { value: string[]; onSave: (value: string[]) => void }) { const serialized = JSON.stringify(value); const [text, setText] = React.useState(serialized); const [error, setError] = React.useState(false); React.useEffect(() => setText(serialized), [serialized]); function apply() { try { const parsed = JSON.parse(text); if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) throw new Error(); setError(false); onSave(parsed); } catch { setError(true); } } return <input className={`settings-inline-input ${error ? 'input-error' : ''}`} value={text} onChange={(event) => setText(event.target.value)} onBlur={apply} title={error ? '必须是字符串数组 JSON' : ''} />; }
function Card({ children }: { children: React.ReactNode }) { return <div className="settings-card">{children}</div>; }

function ShortcutField({ value, onSave }: { value: string; onSave: (value: string) => void }) {
  const [text, setText] = React.useState(value);
  React.useEffect(() => setText(value), [value]);
  return <input
    className="settings-inline-input"
    value={text}
    placeholder="Ctrl+N"
    onChange={(event) => setText(event.target.value)}
    onBlur={() => onSave(text.trim() || value)}
    onKeyDown={(event) => {
      if (event.key === 'Tab') return;
      if (event.key === 'Escape' && !event.ctrlKey && !event.altKey && !event.metaKey) return;
      if (!(event.ctrlKey || event.metaKey || event.altKey || /^F\d+$/i.test(event.key))) return;
      event.preventDefault();
      event.stopPropagation();
      const chord = formatShortcutEvent(event.nativeEvent);
      if (!chord) return;
      setText(chord);
      onSave(chord);
    }}
  />;
}

function ShortcutsSection({ config, onSave }: { config: Record<string, any>; onSave: Props['onSave'] }) {
  const enabled = config.shortcuts_enabled !== false;
  return <>
    <h2>快捷键</h2>
    <p className="settings-lead">菜单上的快捷键现在都会生效。在输入框里按下组合键即可改绑，留空再失焦会保持原值。</p>
    <Card><Row title="启用应用快捷键" description="关闭后只保留输入框内的 Enter / Shift+Enter"><Toggle value={enabled} onChange={(value) => onSave('shortcuts_enabled', value)} /></Row></Card>
    {SHORTCUT_GROUPS.map((group) => (
      <React.Fragment key={group}>
        <h2>{group}</h2>
        <Card>
          {APP_SHORTCUTS.filter((item) => item.group === group).map((item) => (
            <Row key={item.id} title={item.label} description={item.aliases?.length ? `也可 ${item.aliases.join('、')}` : undefined}>
              <ShortcutField value={bindingFor(item, config)} onSave={(value) => onSave(shortcutPref(item), value)} />
            </Row>
          ))}
        </Card>
      </React.Fragment>
    ))}
  </>;
}

function archivedThreadTitle(thread: Thread): string {
  return thread.title || thread.displayTitle || thread.name || thread.preview || '未命名线程';
}

function normalizedPath(value: string): string {
  return String(value || '').replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase();
}

function archivedDate(thread: Thread): string {
  const raw = thread.updatedAt || thread.recencyAt || thread.createdAt;
  if (!raw) return '未知时间';
  const date = typeof raw === 'number' || /^\d+$/.test(String(raw))
    ? new Date(Number(raw) < 100000000000 ? Number(raw) * 1000 : Number(raw))
    : new Date(String(raw));
  if (Number.isNaN(date.getTime())) return '未知时间';
  return new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}

function archivedProject(thread: Thread, projects: CodexProject[]): CodexProject | undefined {
  if (thread.projectId) {
    const byId = projects.find((project) => String((project as any).id || '') === String(thread.projectId));
    if (byId) return byId;
  }
  const cwd = normalizedPath(String(thread.cwd || thread.path || ''));
  return projects
    .filter((project) => {
      const root = normalizedPath(project.path);
      return root && cwd && (cwd === root || cwd.startsWith(`${root}/`));
    })
    .sort((a, b) => b.path.length - a.path.length)[0];
}

function ArchivedChatsSection({
  threads = [],
  projects = [],
  loading = false,
  onOpenThread,
  onUnarchiveThread,
  onDeleteThread,
  onDeleteAllArchived,
}: {
  threads?: Thread[];
  projects?: CodexProject[];
  loading?: boolean;
  onOpenThread?: Props['onOpenThread'];
  onUnarchiveThread?: Props['onUnarchiveThread'];
  onDeleteThread?: Props['onDeleteThread'];
  onDeleteAllArchived?: Props['onDeleteAllArchived'];
}) {
  const [query, setQuery] = React.useState('');
  const [projectFilter, setProjectFilter] = React.useState('all');
  const [message, setMessage] = React.useState('');
  const dialog = useAppDialog();
  const projectFor = React.useCallback((thread: Thread) => archivedProject(thread, projects), [projects]);
  const projectOptions = React.useMemo(() => {
    const names = new Set<string>();
    threads.forEach((thread) => names.add(projectFor(thread)?.name || '其他'));
    return [...names].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  }, [threads, projectFor]);
  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    return threads.filter((thread) => {
      const projectName = projectFor(thread)?.name || '其他';
      if (projectFilter !== 'all' && projectName !== projectFilter) return false;
      if (!needle) return true;
      return [archivedThreadTitle(thread), String(thread.cwd || ''), projectName]
        .join(' ').toLowerCase().includes(needle);
    });
  }, [threads, query, projectFilter, projectFor]);
  const groups = React.useMemo(() => {
    const grouped = new Map<string, { name: string; path: string; threads: Thread[] }>();
    filtered.forEach((thread) => {
      const project = projectFor(thread);
      const name = project?.name || '其他';
      const key = project?.path || `other:${name}`;
      const existing = grouped.get(key) || { name, path: project?.path || '', threads: [] };
      existing.threads.push(thread);
      grouped.set(key, existing);
    });
    return [...grouped.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  }, [filtered, projectFor]);
  const run = async (action: () => void | Promise<void>, success: string) => {
    setMessage('');
    try { await action(); setMessage(success); } catch (error) { setMessage(`操作失败：${String(error)}`); }
  };
  return <>
    <div className="archived-chat-toolbar">
      <label className="archived-chat-search"><UiIcon icon={icons.search} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索已归档聊天" /></label>
      <Select value={projectFilter === 'all' ? '全部项目' : projectFilter} options={['全部项目', ...projectOptions]} onChange={(value) => setProjectFilter(value === '全部项目' ? 'all' : value)} />
      <span className="archived-chat-count">{filtered.length} / {threads.length}</span>
      {threads.length > 0 && <button type="button" className="settings-danger-action" onClick={() => { void (async () => { if (await dialog.confirm('删除全部归档', `确定删除全部 ${threads.length} 个已归档聊天？此操作无法撤销。`)) void run(() => onDeleteAllArchived?.(threads), '已删除全部归档聊天'); })(); }}>全部删除</button>}
    </div>
    {loading ? <div className="settings-plugin-empty">正在加载已归档聊天…</div> : groups.length === 0 ? <div className="settings-plugin-empty">没有已归档的聊天</div> : <div className="archived-chat-groups">
      {groups.map((group) => <section className="archived-chat-group" key={group.path || group.name}>
        <div className="archived-chat-group-head"><span><UiIcon icon={group.path ? icons.folder : icons.clock} /><strong>{group.name}</strong></span><small>{group.threads.length} 个聊天</small></div>
        <div className="archived-chat-list">
          {group.threads.map((thread) => <div className="archived-chat-row" key={thread.id}>
            <button type="button" className="archived-chat-open" onClick={() => void onOpenThread?.(thread.id)}>
              <strong>{archivedThreadTitle(thread)}</strong>
              <span>{archivedDate(thread)}{thread.cwd ? ` · ${String(thread.cwd)}` : ''}</span>
            </button>
            <button type="button" className="archived-chat-unarchive" onClick={() => void run(() => onUnarchiveThread?.(thread), '已取消归档')}><UiIcon icon={icons.undo} /> 取消归档</button>
            <button type="button" className="archived-chat-delete" title="删除聊天" aria-label={`删除 ${archivedThreadTitle(thread)}`} onClick={() => { void (async () => { if (await dialog.confirm('删除聊天', `删除聊天“${archivedThreadTitle(thread)}”？此操作无法撤销。`)) void run(() => onDeleteThread?.(thread), '已删除聊天'); })(); }}><UiIcon icon={icons.trash} /></button>
          </div>)}
        </div>
      </section>)}
    </div>}
    {message && <div className="settings-import-status">{message}</div>}
    {dialog.node}
  </>;
}

function ThemeCard({ label, value, selected, onSelect, tone }: { label: string; value: string; selected: boolean; onSelect: (value: string) => void; tone: 'system' | 'light' | 'dark' }) {
  return <button type="button" className={`theme-choice ${selected ? 'selected' : ''}`} onClick={() => onSelect(value)} aria-pressed={selected}><span className={`theme-choice-preview ${tone}`}><i /><b /><em /></span><strong>{label}</strong></button>;
}

function ColorControl({ value, fallback, onSave }: { value: string; fallback: string; onSave: (value: string) => void }) {
  const color = /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
  return <label className="appearance-color"><input type="color" value={color} onChange={(event) => onSave(event.target.value.toUpperCase())} /><span>{color.toUpperCase()}</span></label>;
}

function AppearanceSection({ config, onSave }: { config: Record<string, any>; onSave: Props['onSave'] }) {
  const theme = String(config.theme || '深色');
  const accent = String(config.accent_color || '#2563EB');
  const background = String(config.background_color || '#FFFFFF');
  const foreground = String(config.foreground_color || '#1A1C1F');
  const backgroundSettings = resolveBackgroundImageSettings(config);
  const [themeStatus, setThemeStatus] = React.useState('');
  const [backgroundStatus, setBackgroundStatus] = React.useState('');
  const setAccentPreset = (value: string) => { const colors: Record<string, string> = { 默认: '#2563EB', 蓝色: '#0EA5E9', 绿色: '#16A34A', 紫色: '#7C3AED' }; onSave('accent_preset', value); onSave('accent_color', colors[value] || colors['默认']); };
  async function importTheme() {
    try {
      const opened = await api.import.open();
      if (opened.canceled || !opened.content) return;
      const parsed = JSON.parse(opened.content);
      const source = parsed?.theme || parsed;
      if (!source || typeof source !== 'object') throw new Error('主题文件格式无效');
      for (const [key, value] of [['accent_color', source.accent_color || source.accent], ['background_color', source.background_color || source.background], ['foreground_color', source.foreground_color || source.foreground]]) if (typeof value === 'string' && value) await onSave(key, value);
      setThemeStatus('主题已导入');
    } catch (error) { setThemeStatus(`导入失败：${String(error)}`); }
  }
  async function chooseBackgroundDirectory() {
    try {
      const result = await api.backgroundImages.chooseDirectory(String(config.background_images_directory || ''));
      if (result.canceled) return;
      await onSave('background_images_directory', result.directory);
      setBackgroundStatus(result.images.length ? `已找到 ${result.images.length} 张背景图片` : '所选目录中没有支持的图片');
    } catch (error) { setBackgroundStatus(`无法读取背景图片目录：${String(error)}`); }
  }
  return <>
    <h2>主题</h2>
    <div className="theme-choice-grid">
      <ThemeCard label="系统" value="跟随系统" tone="system" selected={theme === '跟随系统'} onSelect={(value) => onSave('theme', value)} />
      <ThemeCard label="浅色" value="浅色" tone="light" selected={theme === '浅色'} onSelect={(value) => onSave('theme', value)} />
      <ThemeCard label="深色" value="深色" tone="dark" selected={theme === '深色'} onSelect={(value) => onSave('theme', value)} />
    </div>
    <div className="appearance-code-preview" aria-label="主题代码预览"><div className="code-preview-pane"><span>1</span><code>const themePreview: ThemeConfig = {'{'}</code><span>2</span><code className="removed">  surface: "sidebar",</code><span>3</span><code className="removed">  accent: "#2563eb",</code><span>4</span><code className="removed">  contrast: 42,</code><span>5</span><code>{'}'};</code></div><div className="code-preview-pane"><span>1</span><code>const themePreview: ThemeConfig = {'{'}</code><span>2</span><code className="added">  surface: "sidebar-elevated",</code><span>3</span><code className="added">  accent: "#0ea5e9",</code><span>4</span><code className="added">  contrast: 68,</code><span>5</span><code>{'}'};</code></div></div>
    <Card><div className="appearance-card-title"><strong>浅色主题</strong><div><button className="settings-action" type="button" onClick={() => void importTheme()}>导入</button><button className="settings-action" type="button" onClick={() => void navigator.clipboard?.writeText(JSON.stringify({ accent_color: accent, background_color: background, foreground_color: foreground }))}>复制主题</button><span className="appearance-aa">Aa</span><Select value={String(config.theme_source || 'Codex')} options={['Codex', '系统']} onChange={(value) => onSave('theme_source', value)} /></div></div><Row title="强调色"><Select value={String(config.accent_preset || '默认')} options={['默认', '蓝色', '绿色', '紫色']} onChange={setAccentPreset} /></Row><Row title="背景"><ColorControl value={background} fallback="#FFFFFF" onSave={(value) => onSave('background_color', value)} /></Row><Row title="前景"><ColorControl value={foreground} fallback="#1A1C1F" onSave={(value) => onSave('foreground_color', value)} /></Row><Row title="UI 字体"><div className="appearance-dual-select"><Select value={String(config.ui_font || '系统默认')} options={['系统默认', 'Segoe UI', 'Inter']} onChange={(value) => onSave('ui_font', value)} /><Select value={String(config.ui_font_weight || '常规')} options={['常规', '中等', '粗体']} onChange={(value) => onSave('ui_font_weight', value)} /></div></Row><Row title="代码字体"><div className="appearance-dual-select"><Select value={String(config.code_font || '系统默认')} options={['系统默认', 'Consolas', 'JetBrains Mono']} onChange={(value) => onSave('code_font', value)} /><Select value={String(config.code_font_weight || '常规')} options={['常规', '中等', '粗体']} onChange={(value) => onSave('code_font_weight', value)} /></div></Row><Row title="半透明侧边栏"><Toggle value={config.translucent_sidebar !== false} onChange={(value) => onSave('translucent_sidebar', value)} /></Row><Row title="对比度"><label className="appearance-range"><input type="range" min="0" max="100" value={Number(config.contrast ?? 45)} onChange={(event) => onSave('contrast', Number(event.target.value))} /><output>{Number(config.contrast ?? 45)}</output></label></Row></Card>{themeStatus && <div className="settings-import-status">{themeStatus}</div>}
    <h2>背景图片</h2><Card>
      <Row title="启用背景图片"><Toggle value={backgroundSettings.background_images_enabled} onChange={(value) => onSave('background_images_enabled', value)} /></Row>
      <Row title="图片目录"><div className="background-directory-control"><span title={String(config.background_images_directory || '')}>{String(config.background_images_directory || '尚未选择目录')}</span><button type="button" className="settings-primary" onClick={() => void chooseBackgroundDirectory()}>选择目录</button></div></Row>
      <Row title="顺序"><Select value={backgroundSettings.background_images_order} options={['随机', '顺序']} onChange={(value) => onSave('background_images_order', value)} /></Row>
      <Row title="对齐"><Select value={backgroundSettings.background_images_alignment} options={['左上', '顶部居中', '右上', '左侧居中', '居中', '右侧居中', '左下', '底部居中', '右下']} onChange={(value) => onSave('background_images_alignment', value)} /></Row>
      <Row title="模糊"><label className="appearance-range background-range"><input type="range" min="0" max="40" step="1" value={backgroundSettings.background_images_blur} onChange={(event) => onSave('background_images_blur', Number(event.target.value))} /><output>{backgroundSettings.background_images_blur}px</output></label></Row>
      <Row title="图片透明度"><label className="appearance-range background-range"><input type="range" min="0" max="1" step="0.05" value={backgroundSettings.background_images_opacity} onChange={(event) => onSave('background_images_opacity', Number(event.target.value))} /><output>{backgroundSettings.background_images_opacity.toFixed(2)}</output></label></Row>
      <Row title="前景透明度" description="统一调整整个应用前景层的透明度"><label className="appearance-range background-range"><input type="range" min="0.05" max="1" step="0.05" value={backgroundSettings.background_images_foreground_opacity} onChange={(event) => onSave('background_images_foreground_opacity', Number(event.target.value))} /><output>{backgroundSettings.background_images_foreground_opacity.toFixed(2)}</output></label></Row>
      <Row title="重复"><Select value={backgroundSettings.background_images_repeat} options={['不重复', '重复', '水平重复', '垂直重复']} onChange={(value) => onSave('background_images_repeat', value)} /></Row>
      <Row title="尺寸"><Select value={backgroundSettings.background_images_size} options={['覆盖', '包含', '原始大小']} onChange={(value) => onSave('background_images_size', value)} /></Row>
      <Row title="切换时间"><label className="appearance-number background-time"><input type="number" min="1" max="3600" value={backgroundSettings.background_images_interval} onChange={(event) => onSave('background_images_interval', Math.max(1, Number(event.target.value) || 1))} /><span>秒</span></label></Row>
    </Card>{backgroundStatus && <div className="settings-import-status">{backgroundStatus}</div>}
    <h2>偏好设置</h2><Card><Row title="使用指针光标" description="悬停交互元素时切换为指针光标"><Toggle value={config.pointer_cursor !== false} onChange={(value) => onSave('pointer_cursor', value)} /></Row><Row title="减少动态效果" description="减少动画效果或匹配系统设置"><div className="settings-segment"><button className={config.reduce_motion === 'system' || config.reduce_motion == null ? 'selected' : ''} onClick={() => { onSave('reduce_motion', 'system'); onSave('animations_enabled', true); }}>系统</button><button className={config.reduce_motion === 'on' ? 'selected' : ''} onClick={() => { onSave('reduce_motion', 'on'); onSave('animations_enabled', false); }}>开启</button><button className={config.reduce_motion === 'off' ? 'selected' : ''} onClick={() => { onSave('reduce_motion', 'off'); onSave('animations_enabled', true); }}>关闭</button></div></Row><Row title="UI 字号" description="调整界面中使用的基础字号"><label className="appearance-number"><input type="number" min="10" max="24" value={Number(config.ui_font_size || 14)} onChange={(event) => onSave('ui_font_size', Number(event.target.value))} /><span>px</span></label></Row><Row title="代码字体大小" description="调整聊天和差异视图中代码使用的基础字号"><label className="appearance-number"><input type="number" min="9" max="24" value={Number(config.code_font_size || 12)} onChange={(event) => onSave('code_font_size', Number(event.target.value))} /><span>px</span></label></Row><Row title="差异标记" description="使用颜色或 +/- 标记显示更改"><Select value={String(config.diff_marker_style || '颜色')} options={['颜色', '+/-', '颜色 + +/-']} onChange={(value) => onSave('diff_marker_style', value)} /></Row></Card>
    <h2>对话流</h2><Card><Row title="代码自动换行"><Toggle value={Boolean(config.code_wrap)} onChange={(value) => onSave('code_wrap', value)} /></Row><Row title="显示活动细节"><Toggle value={config.show_activity_details !== false} onChange={(value) => onSave('show_activity_details', value)} /></Row><Row title="界面密度"><Select value={String(config.density || '舒适')} options={['紧凑', '舒适', '宽松']} onChange={(value) => onSave('density', value)} /></Row><Row title="显示动画"><Toggle value={config.animations_enabled !== false} onChange={(value) => onSave('animations_enabled', value)} /></Row></Card>
  </>;
}

type IntegrationInfo = Awaited<ReturnType<typeof api.integrations.status>>;

function useIntegrationInfo() {
  const [info, setInfo] = React.useState<IntegrationInfo | null>(null);
  const [mcp, setMcp] = React.useState<any[]>([]);
  const refresh = React.useCallback(async () => {
    await Promise.all([
      api.integrations.status().then(setInfo),
      api.appServer.request('mcpServerStatus/list', { detail: 'full', threadId: null }).then((status) => setMcp(status?.data || [])).catch(() => setMcp([])),
    ]);
  }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);
  return { info, mcp, refresh };
}

function statusText(installed: boolean, enabled: boolean) {
  if (!installed) return '未安装';
  return enabled ? '已允许' : '未允许';
}

function ComputerSection({ config, onSave }: { config: Record<string, any>; onSave: Props['onSave'] }) {
  const { info, mcp, refresh } = useIntegrationInfo();
  const server = mcp.find((entry) => entry.name === 'computer');
  const enabled = config.mcp_servers?.computer?.enabled !== false && config.computer_enabled !== false;
  const tools = Object.keys(server?.tools || {});
  async function setEnabled(value: boolean) {
    await onSave('computer_enabled', value);
    await onSave('mcp_servers.computer.enabled', value);
    await api.appServer.request('config/mcpServer/reload', {}).catch(() => undefined);
    await refresh();
  }
  const appEnabled = (id: string) => id === 'any' ? config.computer_allow_any_app !== false : config[`computer_${id}_enabled`] !== false;
  return <>
    <p className="settings-lead">管理 Agent 如何使用你电脑上的其他应用程序。</p>
    <h2>控制</h2>
    <Card>
      <Row title="电脑操控" description={`${info == null ? '正在检测本地控制服务' : info.computer.available ? `本地 ${info.platform || ''} 控制服务可用` : '本地控制服务不可用'}${server ? ` · ${tools.length} 个工具` : ''}`}><span className={`integration-state ${server && tools.length ? 'ready' : ''}`}>{server && tools.length ? '已连接' : info == null ? '检测中' : info.computer.available ? '未连接' : '不可用'}</span><Toggle value={enabled} onChange={(value) => void setEnabled(value)} /></Row>
      {(info?.apps || []).map((entry) => { const allowed = appEnabled(entry.id); return <Row key={entry.id} title={entry.name} description={entry.id === 'any' ? '允许 Agent 控制当前获得焦点的任意应用' : `${statusText(entry.installed, allowed)}${entry.executable ? ` · ${entry.executable}` : ''}`}><span className={`integration-dot ${entry.installed ? allowed ? 'ready' : '' : 'missing'}`} />{entry.installed ? <Toggle value={allowed} disabled={!enabled} onChange={(value) => void onSave(entry.enabledKey, value)} /> : <button className="settings-action" disabled>未安装</button>}</Row>; })}
    </Card>
    <h2>能力</h2>
    <Card>
      <Row title="屏幕读取" description="截取虚拟桌面并将 PNG 图像提供给 Agent"><Toggle value={config.computer_screenshot_enabled !== false} disabled={!enabled} onChange={(value) => void onSave('computer_screenshot_enabled', value)} /></Row>
      <Row title="鼠标和键盘" description="移动、点击、滚动、输入文字和执行快捷键"><Toggle value={config.computer_input_enabled !== false} disabled={!enabled} onChange={(value) => void onSave('computer_input_enabled', value)} /></Row>
      <Row title="窗口控制" description="列出并聚焦当前桌面应用。macOS 使用 osascript，Linux 需要 xdotool 或 wmctrl"><span className="integration-capability">可用</span></Row>
    </Card>
    <h2>始终允许的应用</h2>
    <div className="settings-plugin-empty">{config.computer_allow_any_app !== false ? '任意应用已启用，无需单独维护列表' : '使用上方应用开关管理允许范围'}</div>
  </>;
}


function GitLabSettingsSection({ config, onSave }: { config: Record<string, any>; onSave: Props['onSave'] }) {
  type ConnectionDraft = { id: string; name: string; baseUrl: string; enabled: boolean; secretName: string; token: string; tokenConfigured: boolean };
  const listed = Array.isArray(config.gitlab_connections) && config.gitlab_connections.length
    ? config.gitlab_connections
    : [{ id: 'default', name: 'GitLab', baseUrl: config.gitlab_base_url || '', enabled: config.gitlab_enabled === true, secretName: 'GITLAB_PERSONAL_TOKEN' }];
  const [connections, setConnections] = React.useState<ConnectionDraft[]>(listed.map((item: any, index: number) => ({
    id: String(item.id || (index === 0 ? 'default' : `conn-${index + 1}`)),
    name: String(item.name || `GitLab ${index + 1}`),
    baseUrl: String(item.baseUrl || ''),
    enabled: item.enabled !== false,
    secretName: String(item.secretName || (index === 0 ? 'GITLAB_PERSONAL_TOKEN' : `GITLAB_TOKEN_${String(item.id || index).toUpperCase()}`)),
    token: '',
    tokenConfigured: false,
  })));
  const [status, setStatus] = React.useState('');
  React.useEffect(() => {
    setConnections((current) => listed.map((item: any, index: number) => {
      const id = String(item.id || (index === 0 ? 'default' : `conn-${index + 1}`));
      const previous = current.find((entry) => entry.id === id);
      return {
        id,
        name: String(item.name || previous?.name || `GitLab ${index + 1}`),
        baseUrl: String(item.baseUrl || ''),
        enabled: item.enabled !== false,
        secretName: String(item.secretName || previous?.secretName || (id === 'default' ? 'GITLAB_PERSONAL_TOKEN' : `GITLAB_TOKEN_${id.toUpperCase()}`)),
        token: previous?.token || '',
        tokenConfigured: Boolean(previous?.tokenConfigured),
      };
    }));
  }, [JSON.stringify(config.gitlab_connections), config.gitlab_base_url, config.gitlab_enabled]);
  React.useEffect(() => {
    let cancelled = false;
    void Promise.all(connections.map((item) => api.secrets.read(item.secretName).then((result) => ({ id: item.id, configured: Boolean(result.configured) })).catch(() => ({ id: item.id, configured: false })))).then((rows) => {
      if (cancelled) return;
      setConnections((current) => current.map((item) => ({ ...item, tokenConfigured: rows.find((row) => row.id === item.id)?.configured || false })));
      setStatus(rows.some((row) => row.configured) ? '已配置个人 Token' : '尚未配置个人 Token');
    });
    return () => { cancelled = true; };
  }, [connections.map((item) => item.secretName).join('|')]);
  async function persist(next: ConnectionDraft[]) {
    const payload = next.map((item) => ({ id: item.id, name: item.name, baseUrl: item.baseUrl, enabled: item.enabled, secretName: item.secretName }));
    await onSave('gitlab_connections', payload);
    await onSave('gitlab_enabled', payload.some((item) => item.enabled && item.baseUrl));
    await onSave('gitlab_base_url', payload.find((item) => item.enabled && item.baseUrl)?.baseUrl || payload[0]?.baseUrl || '');
  }
  async function saveToken(connection: ConnectionDraft) {
    if (!connection.token.trim()) return;
    try {
      await api.secrets.write(connection.secretName, connection.token.trim());
      setConnections((current) => current.map((item) => item.id === connection.id ? { ...item, token: '', tokenConfigured: true } : item));
      setStatus(`${connection.name || '连接'} 的 Token 已保存到安全存储`);
    } catch (error) {
      setStatus(String(error));
    }
  }
  function addConnection() {
    const id = `conn-${Date.now().toString(36)}`;
    const next = [...connections, { id, name: `GitLab ${connections.length + 1}`, baseUrl: '', enabled: true, secretName: `GITLAB_TOKEN_${id.toUpperCase()}`, token: '', tokenConfigured: false }];
    setConnections(next);
    void persist(next);
  }
  return <>
    <p className="settings-lead">可以添加多个 GitLab 连接。打开对应服务器上的工作区后，会启用合并请求和仓库管理；项目列表页也可以浏览你有管理权限的仓库并克隆到任意目录。</p>
    <h2>连接</h2>
    {connections.map((connection) => (
      <Card key={connection.id}>
        <Row title="启用此连接" description="关闭后不会用这个服务器检测工作区，也不会出现在项目列表里"><Toggle value={connection.enabled} onChange={(value) => { const next = connections.map((item) => item.id === connection.id ? { ...item, enabled: value } : item); setConnections(next); void persist(next); }} /></Row>
        <Row title="显示名称" description="用于设置页和项目列表的连接筛选">
          <Input value={connection.name} placeholder="例如 公司 GitLab" onSave={(value) => { const next = connections.map((item) => item.id === connection.id ? { ...item, name: value.trim() || item.name } : item); setConnections(next); void persist(next); }} />
        </Row>
        <Row title="GitLab 服务器地址" description="例如 http://git.gem.io 或 https://gitlab.com">
          <Input value={connection.baseUrl} placeholder="https://gitlab.example.com" onSave={(value) => { const next = connections.map((item) => item.id === connection.id ? { ...item, baseUrl: value.trim() } : item); setConnections(next); void persist(next); }} />
        </Row>
        <Row title="个人 Token" description="写入系统安全存储，不进入 config.toml 或日志">
          <div className="settings-provider-inline">
            <input className="settings-inline-input" type="password" value={connection.token} onChange={(event) => setConnections((current) => current.map((item) => item.id === connection.id ? { ...item, token: event.target.value } : item))} placeholder={connection.tokenConfigured ? '已保存，输入新 Token 覆盖' : 'glpat-...'} />
            <button className="settings-action" disabled={!connection.token.trim()} onClick={() => void saveToken(connection)}>保存 Token</button>
          </div>
        </Row>
        {connections.length > 1 && (
          <Row title="删除连接" description="不会删除已克隆的本地仓库">
            <button className="settings-action" onClick={() => { const next = connections.filter((item) => item.id !== connection.id); setConnections(next); void persist(next); }}>删除</button>
          </Row>
        )}
      </Card>
    ))}
    <button className="settings-action" type="button" onClick={addConnection}>添加 GitLab 连接</button>
    {status && <div className="settings-import-status">{status}</div>}
  </>;
}

function GitHubSettingsSection({ config, onSave }: { config: Record<string, any>; onSave: Props['onSave'] }) {
  const [baseUrl, setBaseUrl] = React.useState(String(config.github_base_url || ''));
  const [token, setToken] = React.useState('');
  const [tokenConfigured, setTokenConfigured] = React.useState(false);
  const [status, setStatus] = React.useState('');
  React.useEffect(() => { setBaseUrl(String(config.github_base_url || '')); }, [config.github_base_url]);
  React.useEffect(() => {
    void api.secrets.read('GITHUB_PERSONAL_TOKEN').then((result) => {
      setTokenConfigured(Boolean(result.configured));
      setStatus(result.configured ? '已配置个人 Token' : '尚未配置个人 Token');
    }).catch(() => setStatus('无法读取安全存储'));
  }, []);
  async function saveToken() {
    if (!token.trim()) return;
    try {
      await api.secrets.write('GITHUB_PERSONAL_TOKEN', token.trim());
      setToken('');
      setTokenConfigured(true);
      setStatus('个人 Token 已保存到安全存储');
    } catch (error) {
      setStatus(String(error));
    }
  }
  return <>
    <p className="settings-lead">配置 GitHub 后，打开托管在该服务器上的工作区会启用拉取请求和仓库管理。GitHub 页的项目列表会列出你有管理权限的仓库，并可以克隆到任意目录，不必先打开工作区。</p>
    <h2>连接</h2>
    <Card>
      <Row title="全局开关" description="关闭后不会检测工作区是否托管在 GitHub 上，也不会显示管理入口"><Toggle value={config.github_enabled === true} onChange={(value) => onSave('github_enabled', value)} /></Row>
      <Row title="GitHub 服务器地址" description="GitHub.com 填写 https://github.com，GitHub Enterprise 填写实例地址">
        <Input value={baseUrl} placeholder="https://github.com" onSave={(value) => { setBaseUrl(value.trim()); onSave('github_base_url', value.trim()); }} />
      </Row>
      <Row title="个人 Token" description="写入系统安全存储，不进入 config.toml 或日志。需要 repo 权限以读取私有仓库和拉取请求">
        <div className="settings-provider-inline">
          <input className="settings-inline-input" type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={tokenConfigured ? '已保存，输入新 Token 覆盖' : 'ghp_...'} />
          <button className="settings-action" disabled={!token.trim()} onClick={() => void saveToken()}>保存 Token</button>
        </div>
      </Row>
    </Card>
    {status && <div className="settings-import-status">{status}</div>}
  </>;
}

function BrowserSection({ config, onSave }: { config: Record<string, any>; onSave: Props['onSave'] }) {
  const { info, mcp, refresh } = useIntegrationInfo();
  const [message, setMessage] = React.useState('');
  const dialog = useAppDialog();
  const server = mcp.find((entry) => entry.name === 'browser');
  const tools = Object.keys(server?.tools || {});
  const enabled = config.mcp_servers?.browser?.enabled !== false && config.browser_enabled !== false;
  const engines = info?.browser.engines || [];
  const preference = String(config.browser_engine || info?.browser.preference || 'auto');
  async function setEnabled(value: boolean) {
    await onSave('browser_enabled', value);
    await onSave('mcp_servers.browser.enabled', value);
    await api.appServer.request('config/mcpServer/reload', {}).catch(() => undefined);
    await refresh();
  }
  async function setEngine(value: string) {
    await onSave('browser_engine', value);
    await refresh();
  }
  async function clearData() {
    if (!(await dialog.confirm('清除浏览数据', '确认清除 Agent 受控浏览器和工作区内置浏览器的历史记录、网站数据、缓存和下载记录？'))) return;
    try { const result = await api.integrations.clearBrowserData(); setMessage(`已清除浏览器数据：${result.path}`); await refresh(); }
    catch (error) { setMessage(`清除失败：${String(error)}`); }
  }
  const missing = info && !info.browser.available;
  const playwrightMissing = info && !info.browser.playwright;
  return <>
    <p className="settings-lead">管理 Agent 使用的本地受控浏览器。自动模式会按 Edge、Chrome、Chromium 的顺序选择本机已安装的引擎。</p>
    <Card><Row title="浏览器" description={`${info == null ? '正在检测浏览器' : info.browser.available ? `${info.browser.engine} 已就绪` : '未找到 Edge / Chrome / Chromium'}${server ? ` · ${tools.length} 个工具` : ''}`}><span className={`integration-state ${server && tools.length ? 'ready' : ''}`}>{server && tools.length ? '已连接' : info == null ? '检测中' : info.browser.available ? '未连接' : '不可用'}</span><Toggle value={enabled} onChange={(value) => void setEnabled(value)} /></Row></Card>
    <h2>常规</h2>
    <Card>
      <Row title="Agent 浏览器引擎" description={missing ? '需要本机安装 Microsoft Edge、Google Chrome 或 Chromium' : '网页导航、DOM、点击、输入、截图和标签页操作'}>
        <select className="settings-select" value={preference} onChange={(event) => void setEngine(event.target.value)}>
          <option value="auto">自动{info?.browser.engine ? `（当前 ${info.browser.engine}）` : ''}</option>
          {engines.map((engine) => <option key={engine.id} value={engine.id}>{engine.name}{engine.installed ? '' : '（未安装）'}</option>)}
        </select>
      </Row>
      <Row title="允许浏览历史访问"><Toggle value={Boolean(config.browser_use?.allow_history_access)} disabled={!enabled} onChange={(value) => void onSave('browser_use.allow_history_access', value)} /></Row>
      <Row title="默认来源访问"><Select value={String(config.browser_use?.default_origin_policy?.access || 'allow')} options={['allow', 'deny']} onChange={(value) => void onSave('browser_use.default_origin_policy.access', value)} /></Row>
      <Row title="浏览数据" description="清除 Agent 受控浏览器和工作区内置浏览器的历史记录、网站数据、缓存和下载记录"><button className="settings-action" onClick={() => void clearData()}>清除浏览数据</button></Row>
    </Card>
    <h2>运行状态</h2>
    <Card><Row title="浏览器可执行文件" description={info?.browser.executable || '未找到'}><button className="settings-action" onClick={() => void refresh()}><UiIcon icon={icons.refresh} /> 重新检测</button></Row><Row title="浏览器数据目录" description={info?.browser.profile || '检测中…'}><span className="integration-capability">本地</span></Row><Row title="Playwright MCP" description={info?.browser.playwright || '未找到 @playwright/mcp。请在应用根目录执行 npm install，或确认打包资源包含 node_modules/@playwright/mcp 与 playwright-core'}><span className="integration-capability">{playwrightMissing ? '不可用' : '已就绪'}</span></Row><Row title="工具能力" description={tools.length ? tools.join('、') : '服务尚未公布工具'}><span className="integration-capability">{tools.length || 0} 个</span></Row></Card>{message && <div className="settings-import-status">{message}</div>}
    {missing && <div className="settings-import-status">需要本机安装浏览器引擎，并且应用能找到 Playwright MCP（cli.js）。debug 构建请在仓库根目录安装依赖。</div>}
    {dialog.node}
  </>;
}

export function SettingsCategoryView({ section, config, onSave, onImport, onExport, archivedThreads, projects, archivedLoading, onOpenThread, onUnarchiveThread, onDeleteThread, onDeleteAllArchived }: Props) {
  switch (section) {
    case 'import': return <ImportSection config={config} onSave={onSave} onImport={onImport} onExport={onExport} />;
    case 'appearance': return <AppearanceSection config={config} onSave={onSave} />;
    case 'voice': return <><h2>系统语音</h2><Card><Row title="语音输入" description="使用系统 Speech Recognition 填充 Composer"><Toggle value={Boolean(config.voice_enabled)} onChange={(value) => onSave('voice_enabled', value)} /></Row><Row title="自动朗读最终回复" description="回合完成后使用系统 Speech Synthesis 朗读"><Toggle value={Boolean(config.voice_auto_read)} onChange={(value) => onSave('voice_auto_read', value)} /></Row><Row title="朗读速度"><Select value={String(config.voice_rate || '1.0x')} options={['0.8x', '1.0x', '1.2x', '1.5x']} onChange={(value) => onSave('voice_rate', value)} /></Row></Card></>;
    case 'personalization': return <><h2>个性化</h2><Card><Row title="显示名称" description="用于本地界面显示"><Input value={String(config.display_name || '')} placeholder="输入名称" onSave={(value) => onSave('display_name', value)} /></Row><Row title="默认回复风格"><Select value={String(config.response_style || '专业')} options={['专业', '简洁', '详细', '教学']} onChange={(value) => onSave('response_style', value)} /></Row><Row title="自定义指令" description="会附加到每个新线程的上下文"><textarea className="settings-multiline" defaultValue={String(config.custom_instructions || '')} onBlur={(event) => onSave('custom_instructions', event.target.value)} placeholder="例如：始终使用中文回答…" /></Row></Card></>;
    case 'shortcuts': return <ShortcutsSection config={config} onSave={onSave} />;
    case 'automations': return <><p className="settings-lead">应用在运行或最小化到托盘时，会按计划启动本地线程。</p><AutomationsView embedded onOpenThread={onOpenThread} /></>;
    case 'computer': return <ComputerSection config={config} onSave={onSave} />;
    case 'plugins': return <><h2>本地插件</h2><Card><Row title="允许加载本地插件"><Toggle value={config.plugins_enabled !== false} onChange={(value) => { onSave('plugins_enabled', value); void api.codex.setPluginsEnabled(value); }} /></Row></Card><h2>网页搜索</h2><Card><Row title="网页搜索" description="用 DuckDuckGo 搜索并读取公开网页。关闭后不会注册 web-search MCP"><Toggle value={config.mcp_servers?.['web-search']?.enabled !== false && config.web_search_enabled !== false} onChange={(value) => { void (async () => { await onSave('web_search_enabled', value); await onSave('mcp_servers.web-search.enabled', value); await api.appServer.request('config/mcpServer/reload', {}).catch(() => undefined); })(); }} /></Row></Card><PluginManager /></>;
    case 'gitlab': return <GitLabSettingsSection config={config} onSave={onSave} />;
    case 'github': return <GitHubSettingsSection config={config} onSave={onSave} />;
    case 'browser': return <BrowserSection config={config} onSave={onSave} />;
    case 'hooks': return <HooksSection config={config} onSave={onSave} />;
    case 'connections': return <ConnectionsSection config={config} onSave={onSave} />;
    case 'git': return <><h2>Git 集成</h2><Card><Row title="自动刷新状态"><Toggle value={config.git_auto_refresh !== false} onChange={(value) => onSave('git_auto_refresh', value)} /></Row><Row title="提交前显示确认" description="填写提交说明后再弹一次确认"><Toggle value={config.git_confirm_commit !== false} onChange={(value) => onSave('git_confirm_commit', value)} /></Row><Row title="使用 Git 配置签名提交"><Toggle value={Boolean(config.git_sign_commits)} onChange={(value) => onSave('git_sign_commits', value)} /></Row></Card></>;
    case 'environment': return <EnvironmentSection config={config} onSave={onSave} />;
    case 'worktrees': return <WorktreesSection />;
    case 'archived': return <><p className="settings-lead">已归档的聊天不会出现在左侧线程列表中，可在这里搜索、恢复或删除。</p><ArchivedChatsSection threads={archivedThreads} projects={projects} loading={archivedLoading} onOpenThread={onOpenThread} onUnarchiveThread={onUnarchiveThread} onDeleteThread={onDeleteThread} onDeleteAllArchived={onDeleteAllArchived} /><h2>归档行为</h2><Card><Row title="回合完成后自动归档"><Toggle value={Boolean(config.auto_archive_completed)} onChange={(value) => onSave('auto_archive_completed', value)} /></Row></Card></>;
    default: return <div className="settings-placeholder"><UiIcon icon={icons.gear} /><strong>暂无设置</strong><p>该分类没有可配置项。</p></div>;
  }
}

function ImportSection({ config, onSave, onImport, onExport }: { config: Record<string, any>; onSave: Props['onSave']; onImport?: Props['onImport']; onExport?: Props['onExport'] }) {
  const [message, setMessage] = React.useState('');
  const run = async (action?: () => Promise<string>) => { if (!action) return; try { setMessage(await action()); } catch (error) { setMessage(String(error)); } };
  return <><h2>线程数据</h2><Card><Row title="导入线程" description="从本地 JSON、TXT 或 Markdown 恢复线程和模型可见历史"><button className="settings-action" onClick={() => void run(onImport)}>选择文件</button></Row><Row title="导出当前线程" description="将当前线程导出为可移植 JSON"><button className="settings-action" onClick={() => void run(onExport)}>导出</button></Row></Card>{message && <div className="settings-import-status">{message}</div>}</>;
}

const HOOK_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt'];

function HooksSection({ config, onSave }: { config: Record<string, any>; onSave: Props['onSave'] }) {
  const dialog = useAppDialog();
  const [entries, setEntries] = React.useState<any[]>([]);
  const [files, setFiles] = React.useState<Awaited<ReturnType<typeof api.hooks.list>>>([]);
  const [error, setError] = React.useState('');
  const [enabled, setEnabled] = React.useState(config.hooks_enabled !== false);
  const [scope, setScope] = React.useState<'user' | 'project'>('user');
  const [event, setEvent] = React.useState('SessionStart');
  const [matcher, setMatcher] = React.useState('');
  const [command, setCommand] = React.useState('');
  const [statusMessage, setStatusMessage] = React.useState('');
  const refresh = React.useCallback(async () => {
    try {
      const [result, features, localFiles] = await Promise.all([
        api.appServer.request('hooks/list', {}).catch(() => ({ data: [] })),
        api.appServer.request('experimentalFeature/list', {}).catch(() => ({ data: [] })),
        api.hooks.list(),
      ]);
      setEntries(Array.isArray(result?.data) ? result.data : []);
      setFiles(localFiles);
      const feature = (features?.data || []).find((item: any) => item.name === 'hooks');
      if (feature) setEnabled(Boolean(feature.enabled));
      setError('');
    } catch (reason) {
      setError(String(reason));
    }
  }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);
  async function toggle(value: boolean) {
    setEnabled(value);
    onSave('hooks_enabled', value);
    try { await api.appServer.request('experimentalFeature/enablement/set', { enablement: { hooks: value } }); } catch (reason) { setError(String(reason)); }
  }
  async function addHook() {
    try {
      await api.hooks.add({ scope, event, matcher, command, statusMessage });
      setCommand('');
      setStatusMessage('');
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  }
  async function removeHook(hook: { scope: string; file: string; event: string; groupIndex: number; hookIndex: number }) {
    if (!(await dialog.confirm('删除钩子', `确认删除 ${hook.event} 钩子？`))) return;
    try {
      await api.hooks.remove({ scope: hook.scope as 'user' | 'project', file: hook.file, event: hook.event, groupIndex: hook.groupIndex, hookIndex: hook.hookIndex });
      await refresh();
    } catch (reason) {
      setError(String(reason));
    }
  }
  return <>
    <h2>生命周期钩子</h2>
    <Card><Row title="启用 Hooks"><Toggle value={enabled} onChange={(value) => void toggle(value)} /></Row></Card>
    <h2>添加命令钩子</h2>
    <div className="settings-card settings-mcp-form">
      <div className="settings-mcp-fields">
        <select className="settings-select" value={scope} onChange={(event) => setScope(event.target.value as 'user' | 'project')}>
          <option value="user">用户 hooks.json</option>
          <option value="project">项目 .local-codex/hooks.json</option>
        </select>
        <select className="settings-select" value={event} onChange={(item) => setEvent(item.target.value)}>
          {HOOK_EVENTS.map((name) => <option key={name}>{name}</option>)}
        </select>
        <input className="settings-inline-input" value={matcher} onChange={(item) => setMatcher(item.target.value)} placeholder="匹配器，例如 Bash 或 startup|resume" />
        <input className="settings-inline-input" value={command} onChange={(item) => setCommand(item.target.value)} placeholder="要执行的命令" />
        <input className="settings-inline-input" value={statusMessage} onChange={(item) => setStatusMessage(item.target.value)} placeholder="可选状态说明" />
        <button className="settings-primary" onClick={() => void addHook()}>添加钩子</button>
      </div>
    </div>
    <div className="settings-plugin-toolbar"><strong>可编辑文件</strong><button className="settings-action" onClick={() => void refresh()}><UiIcon icon={icons.refresh} /> 刷新</button></div>
    {files.map((file) => <div className="hooks-entry" key={file.file}>
      <strong>{file.scope === 'user' ? '用户' : '项目'} · {file.file}</strong>
      {file.error && <small className="hook-error">{file.error}</small>}
      {file.hooks.length === 0 ? <div className="settings-plugin-empty">此文件还没有钩子</div> : file.hooks.map((hook) => (
        <div className="hook-row" key={hook.id}>
          <UiIcon icon={icons.branch} />
          <span><b>{hook.event}{hook.matcher ? ` · ${hook.matcher}` : ''}</b><small>{hook.command || hook.type}</small></span>
          <button className="settings-action" onClick={() => void removeHook(hook)}>删除</button>
        </div>
      ))}
    </div>)}
    <div className="settings-plugin-toolbar"><strong>运行时已加载</strong></div>
    {entries.length === 0 ? <div className="settings-plugin-empty">没有发现已加载的 Hooks</div> : entries.map((entry, index) => <div className="hooks-entry" key={`${entry.cwd}-${index}`}><strong>{entry.cwd}</strong>{(entry.hooks || []).map((hook: any, hookIndex: number) => <div className="hook-row" key={`${hook.eventName || hook.event || hook.name}-${hookIndex}`}><UiIcon icon={icons.branch} /><span><b>{hook.eventName || hook.event || hook.name || 'Hook'}</b><small>{hook.command || hook.description || JSON.stringify(hook)}</small></span></div>)}{(entry.warnings || []).map((warning: any, i: number) => <small className="hook-warning" key={`w-${i}`}>{String(warning.message || warning)}</small>)}{(entry.errors || []).map((failure: any, i: number) => <small className="hook-error" key={`e-${i}`}>{String(failure.message || failure)}</small>)}</div>)}
    {error && <div className="settings-import-status">{error}</div>}
    {dialog.node}
  </>;
}

function formatUpdateStatus(status: { current?: string; latest?: string; newer?: boolean; error?: string }) {
  if (status.newer) return `发现 ${status.latest}`;
  if (status.latest) return `已是最新 ${status.current}`;
  return status.error || `当前 ${status.current}，未发现更新源`;
}

function EnvironmentSection({ config, onSave }: { config: Record<string, any>; onSave: Props['onSave'] }) {
  const [diagnostics, setDiagnostics] = React.useState<any>({});
  const [sandbox, setSandbox] = React.useState<any>(null);
  const refresh = React.useCallback(async () => { try { const info = await api.diagnostics.read(); setDiagnostics(info); if (String(info.platform || '').startsWith('win')) { try { setSandbox(await api.appServer.request('windowsSandbox/readiness', {})); } catch (error) { setSandbox({ error: String(error) }); } } } catch { /* shown as unavailable */ } }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);
  const [updateStatus, setUpdateStatus] = React.useState(String(config.last_update_check || ''));
  const [updateUrl, setUpdateUrl] = React.useState('');
  React.useEffect(() => api.app.onUpdateStatus((status) => {
    setUpdateStatus(formatUpdateStatus(status));
    setUpdateUrl(status.newer && status.url ? status.url : '');
  }), []);
  function sandboxLabel(value: any) {
    if (!value) return '正在检测';
    if (value.error) return String(value.error);
    if (value.mode === 'mock' || value.supported === false) return String(value.error || '当前引擎不提供 Windows 沙箱');
    if (value.ready === true || value.status === 'ready') return '已就绪';
    return JSON.stringify(value);
  }
  async function checkUpdates() {
    try {
      const result = await api.app.checkUpdates();
      setUpdateStatus(formatUpdateStatus(result));
      setUpdateUrl(result.newer && result.url ? result.url : '');
    } catch (error) {
      setUpdateStatus(String(error));
      setUpdateUrl('');
    }
  }
  return <><h2>运行环境</h2><Card><Row title="平台"><div className="settings-value">{diagnostics.platform || '检测中…'}</div></Row><Row title="回合完成时通知" description="当前窗口不在看这个线程时弹出系统通知"><Toggle value={config.notify_on_turn_complete !== false} onChange={(value) => onSave('notify_on_turn_complete', value)} /></Row><Row title="默认沙箱模式"><Select value={String(config.sandbox_mode || 'workspace-write')} options={['read-only', 'workspace-write', 'danger-full-access']} onChange={(value) => onSave('sandbox_mode', value)} /></Row><Row title="默认审批策略"><Select value={String(config.approval_policy || 'on-request')} options={['untrusted', 'on-request', 'never']} onChange={(value) => onSave('approval_policy', value)} /></Row><Row title="沙箱工具网络"><Toggle value={Boolean(config.sandbox_workspace_write?.network_access)} onChange={(value) => onSave('sandbox_workspace_write.network_access', value)} /></Row></Card><h2>应用更新</h2><Card><Row title="启动时检查更新" description="发现新版本时弹出提示，可打开下载页"><Toggle value={config.auto_check_updates !== false} onChange={(value) => onSave('auto_check_updates', value)} /></Row><Row title="更新源 URL" description="留空则读取 GitHub Releases（wzd24/agent-v2 的 latest）。也可填写自定义 JSON，需包含 version，可选 url / notes"><Input value={String(config.update_feed_url || '')} placeholder="https://api.github.com/repos/wzd24/agent-v2/releases?per_page=20" onSave={(value) => onSave('update_feed_url', value.trim())} /></Row><Row title="检查更新" description={updateStatus || (config.last_update_check ? `上次 ${config.last_update_check}` : '尚未检查')}><button className="settings-action" onClick={() => void checkUpdates()}>立即检查</button>{updateUrl ? <button className="settings-action" onClick={() => void api.app.openExternalUrl(updateUrl)}>打开下载页</button> : null}</Row></Card><h2>平台沙箱</h2><Card><Row title="沙箱就绪状态" description={sandboxLabel(sandbox)}><button className="settings-action" onClick={() => void refresh()}>重新检测</button></Row>{String(diagnostics.platform || '').startsWith('win') && <Row title="设置 Windows 沙箱" description="按 Codex 当前版本配置 Windows 隔离环境"><button className="settings-primary" disabled={sandbox?.mode === 'mock' || sandbox?.supported === false} onClick={() => void api.appServer.request('windowsSandbox/setupStart', { mode: 'unelevated', cwd: diagnostics.cwd || null }).catch((error) => setSandbox({ error: String(error) })).then(refresh)}>开始设置</button></Row>}</Card></>;
}

const MCP_AUTH_LABELS: Record<string, string> = {
  unknown: '鉴权未知',
  unsupported: '无需登录',
  notLoggedIn: '未登录',
  bearerToken: '已配置 Token',
  oAuth: '已 OAuth 登录',
};

function ConnectionsSection({ config, onSave }: { config: Record<string, any>; onSave: Props['onSave'] }) {
  const [servers, setServers] = React.useState<any[]>([]);
  const [status, setStatus] = React.useState('');
  const [name, setName] = React.useState('');
  const [command, setCommand] = React.useState('npx');
  const [args, setArgs] = React.useState('[]');
  const [url, setUrl] = React.useState('');
  const [bearerEnv, setBearerEnv] = React.useState('');
  const [showForm, setShowForm] = React.useState(false);
  const [loggingIn, setLoggingIn] = React.useState('');
  const refresh = React.useCallback(async () => {
    try {
      const result = await api.appServer.request('mcpServerStatus/list', { detail: 'full', threadId: null });
      setServers((result?.data || []).filter((server: any) => !/openai|chatgpt/i.test(String(server.name || ''))));
    } catch (error) {
      setStatus(String(error));
    }
  }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);
  React.useEffect(() => api.appServer.onNotification((message) => {
    if (message.method !== 'mcpServer/oauthLogin/completed') return;
    const params = message.params || {};
    setLoggingIn('');
    setStatus(params.success ? `「${params.name || ''}」OAuth 登录完成` : (params.error || 'OAuth 登录失败'));
    void refresh();
  }), [refresh]);
  async function reload() {
    try {
      await api.appServer.request('config/mcpServer/reload');
      await refresh();
      setStatus('MCP 配置已重载');
    } catch (error) {
      setStatus(String(error));
    }
  }
  async function addServer() {
    const cleanName = name.trim();
    if (!cleanName) { setStatus('服务名称不能为空'); return; }
    if (!/^[A-Za-z0-9_-]+$/.test(cleanName)) { setStatus('服务名称只能包含字母、数字、下划线和短横线'); return; }
    const remoteUrl = url.trim();
    if (remoteUrl) {
      try { new URL(remoteUrl); } catch { setStatus('远程地址必须是有效 URL'); return; }
      await onSave(`mcp_servers.${cleanName}.url`, remoteUrl);
      if (bearerEnv.trim()) await onSave(`mcp_servers.${cleanName}.bearer_token_env_var`, bearerEnv.trim());
    } else {
      let parsedArgs: string[];
      try {
        const value = JSON.parse(args || '[]');
        if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error();
        parsedArgs = value;
      } catch {
        setStatus('参数必须是字符串数组 JSON');
        return;
      }
      await onSave(`mcp_servers.${cleanName}.command`, command.trim() || 'npx');
      await onSave(`mcp_servers.${cleanName}.args`, parsedArgs);
    }
    await onSave(`mcp_servers.${cleanName}.enabled`, true);
    setName(''); setCommand('npx'); setArgs('[]'); setUrl(''); setBearerEnv(''); setShowForm(false);
    await reload();
  }
  async function toggleServer(server: any, enabled: boolean) {
    await onSave(`mcp_servers.${server.name}.enabled`, enabled);
    await reload();
  }
  async function loginServer(serverName: string) {
    setLoggingIn(serverName);
    setStatus(`正在为「${serverName}」启动 OAuth…`);
    try {
      const result = await api.appServer.request('mcpServer/oauth/login', { name: serverName, threadId: null });
      const authorizationUrl = String(result?.authorizationUrl || '');
      if (authorizationUrl) {
        const opened = await api.app.openExternalUrl(authorizationUrl);
        setStatus(opened?.ok ? `已打开「${serverName}」授权页，完成后会自动刷新` : (opened?.output || '无法打开授权页'));
      } else {
        setStatus(`已发起「${serverName}」OAuth，等待完成通知`);
      }
    } catch (error) {
      setLoggingIn('');
      setStatus(String(error));
    }
  }
  const configured = Object.entries(config.mcp_servers || {}).filter(([key]) => !/openai|chatgpt/i.test(key)).map(([key, value]: [string, any]) => ({
    name: key,
    command: value?.command || '',
    args: value?.args || [],
    url: value?.url || '',
  }));
  const visibleServers = [...servers, ...configured.filter((entry) => !servers.some((server) => server.name === entry.name))];
  return <>
    <div className="settings-plugin-toolbar">
      <strong>MCP 连接</strong>
      <div>
        <button className="settings-action" onClick={() => setShowForm((value) => !value)}><UiIcon icon={icons.plus} /> 添加服务</button>
        <button className="settings-action" onClick={() => void api.config.openFile()}>打开配置文件</button>
        <button className="settings-primary" onClick={() => void reload()}><UiIcon icon={icons.refresh} /> 重载</button>
      </div>
    </div>
    {showForm && <div className="settings-card settings-mcp-form">
      <div className="settings-mcp-fields">
        <input className="settings-inline-input" value={name} onChange={(event) => setName(event.target.value)} placeholder="服务名称" />
        <input className="settings-inline-input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="远程 URL（HTTP/SSE，可走 OAuth）" />
        <input className="settings-inline-input" value={bearerEnv} onChange={(event) => setBearerEnv(event.target.value)} placeholder="可选：Bearer Token 环境变量名" />
        <input className="settings-inline-input" value={command} onChange={(event) => setCommand(event.target.value)} placeholder="本地命令，例如 npx" disabled={Boolean(url.trim())} />
        <input className="settings-inline-input" value={args} onChange={(event) => setArgs(event.target.value)} placeholder='参数 JSON，例如 ["-y","包名"]' disabled={Boolean(url.trim())} />
        <button className="settings-primary" onClick={() => void addServer()}>保存服务</button>
      </div>
      <small>填写远程 URL 时按 HTTP MCP 保存，可随后用 OAuth 登录；留空则按本地命令启动。</small>
    </div>}
    {visibleServers.length === 0 ? <div className="settings-plugin-empty">没有本地 MCP 服务</div> : <div className="settings-plugin-list">{visibleServers.map((server) => {
      const configuredServer = configured.find((item) => item.name === server.name);
      const enabled = config.mcp_servers?.[server.name]?.enabled !== false;
      const authStatus = String(server.authStatus || 'unknown');
      const canLogin = authStatus === 'notLoggedIn' || (authStatus !== 'unsupported' && authStatus !== 'oAuth' && authStatus !== 'bearerToken' && Boolean(configuredServer?.url || config.mcp_servers?.[server.name]?.url));
      const detail = configuredServer?.url
        ? configuredServer.url
        : configuredServer?.command
          ? `${configuredServer.command} ${JSON.stringify(configuredServer.args || [])}`
          : '';
      return <div className="settings-plugin-item" key={server.name}>
        <div>
          <strong>{server.name}</strong>
          <small>{server.runtimeStatus || 'notStarted'} · {MCP_AUTH_LABELS[authStatus] || authStatus} · {Object.keys(server.tools || {}).length} 个工具 · {(server.resources || []).length} 个资源{detail ? ` · ${detail}` : ''}</small>
        </div>
        {canLogin && <button className="settings-action" disabled={loggingIn === server.name} onClick={() => void loginServer(server.name)}>{loggingIn === server.name ? '登录中…' : 'OAuth 登录'}</button>}
        <button className="settings-action" onClick={() => void toggleServer(server, !enabled)}>{enabled ? '停用' : '启用'}</button>
        <span className={`mcp-state ${server.runtimeStatus || 'notStarted'}`} />
      </div>;
    })}</div>}
    {status && <div className="settings-import-status">{status}</div>}
  </>;
}

function WorktreesSection() {
  const dialog = useAppDialog();
  const [entries, setEntries] = React.useState<Array<{ path: string; head: string; branch: string }>>([]); const [status, setStatus] = React.useState('');
  const refresh = React.useCallback(async () => { const result = await api.git.worktrees(); setEntries(result.entries || []); setStatus(result.ok ? '' : result.output); }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);
  async function create() {
    const branch = await dialog.prompt('新建 Worktree', '', { placeholder: '分支名' });
    if (!branch?.trim()) return;
    const result = await api.git.createWorktree(branch.trim());
    setStatus(result.ok ? `已创建 ${result.path}` : result.output);
    await refresh();
  }
  async function remove(entry: { path: string; branch: string }) {
    if (!(await dialog.confirm('移除 Worktree', `确认移除 Worktree“${entry.branch || entry.path}”？`))) return;
    const result = await api.git.removeWorktree(entry.path);
    setStatus(result.ok ? 'Worktree 已移除' : result.output);
    await refresh();
  }
  return <><div className="settings-plugin-toolbar"><strong>Git Worktrees</strong><div><button className="settings-action" onClick={() => void refresh()}><UiIcon icon={icons.refresh} /> 刷新</button><button className="settings-primary" onClick={() => void create()}><UiIcon icon={icons.plus} /> 新建</button></div></div>{entries.length === 0 ? <div className="settings-plugin-empty">当前仓库没有 Worktree</div> : <div className="settings-plugin-list">{entries.map((entry) => <div className="settings-plugin-item" key={entry.path}><div><strong>{entry.branch || 'detached'}</strong><small>{entry.path}</small></div><button className="settings-action" disabled={entries[0]?.path === entry.path} onClick={() => void remove(entry)}>{entries[0]?.path === entry.path ? '当前' : '移除'}</button></div>)}</div>}{status && <div className="settings-import-status">{status}</div>}{dialog.node}</>;
}

function PluginManager() {
  const dialog = useAppDialog();
  const [plugins, setPlugins] = React.useState<Array<{ name: string; description: string; path: string; source: string; enabled: boolean }>>([]);
  const [message, setMessage] = React.useState('');
  const refresh = React.useCallback(async () => { try { setPlugins(await api.codex.plugins()); } catch (error) { setMessage(String(error)); } }, []);
  React.useEffect(() => { void refresh(); }, [refresh]);
  async function install() { try { const result = await api.codex.installPlugin(); if (!result.canceled) { setMessage(`已安装 ${result.plugin?.name || '插件'}`); await refresh(); } } catch (error) { setMessage(String(error)); } }
  async function uninstall(plugin: { name: string; path: string }) {
    if (!(await dialog.confirm('卸载插件', `确认卸载插件“${plugin.name}”？`))) return;
    const result = await api.codex.uninstallPlugin(plugin.path);
    setMessage(result.ok ? `已卸载 ${plugin.name}` : result.output || '卸载失败');
    if (result.ok) await refresh();
  }
  return <div className="settings-plugin-manager"><div className="settings-plugin-toolbar"><strong>已安装插件</strong><div><button className="settings-action" onClick={() => void refresh()}><UiIcon icon={icons.refresh} /> 刷新</button><button className="settings-primary" onClick={() => void install()}><UiIcon icon={icons.plus} /> 安装插件</button></div></div>{plugins.length === 0 ? <div className="settings-plugin-empty">暂无本地插件</div> : <div className="settings-plugin-list">{plugins.map((plugin) => <div className="settings-plugin-item" key={plugin.path}><div><strong>{plugin.name}</strong><small>{plugin.description || plugin.source}</small></div><button className="settings-action" disabled={plugin.source !== '应用目录'} onClick={() => void uninstall(plugin)}>{plugin.source === '应用目录' ? '卸载' : '项目插件'}</button></div>)}</div>}{message && <small className="settings-plugin-message">{message}</small>}{dialog.node}</div>;
}
