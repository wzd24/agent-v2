import React from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useCoverBrowser } from '../coverBrowser';
import { icons, UiIcon } from './UiIcon';

type MenuItem = { label?: string; shortcut?: string; action?: string; disabled?: boolean; separator?: boolean; submenu?: MenuItem[] };

function menusFor(canGoBack: boolean, canGoForward: boolean, shortcutMap: Record<string, string> = {}): Record<string, MenuItem[]> {
  const key = (action: string, fallback: string) => shortcutMap[action] || fallback;
  return {
  文件: [
    { label: '新建窗口', action: 'new-window' },
    { label: '新聊天', shortcut: key('new-chat', 'Ctrl+N'), action: 'new-chat' },
    { label: '新建临时聊天', shortcut: key('new-temporary-chat', 'Ctrl+Shift+N'), action: 'new-temporary-chat' },
    { separator: true },
    { label: '打开文件夹', shortcut: key('open-folder', 'Ctrl+O'), action: 'open-folder' },
    { separator: true },
    { label: '关闭', shortcut: key('close-window', 'Ctrl+W'), action: 'close-window' },
    { separator: true },
    { label: '退出 Local Codex', shortcut: key('quit', 'Ctrl+Q'), action: 'quit' },
  ],
  编辑: [
    { label: '撤销', shortcut: 'Ctrl+Z', action: 'undo' },
    { label: '重做', shortcut: 'Ctrl+Y', action: 'redo' },
    { separator: true },
    { label: '剪切', shortcut: 'Ctrl+X', action: 'cut' },
    { label: '复制', shortcut: 'Ctrl+C', action: 'copy' },
    { label: '粘贴', shortcut: 'Ctrl+V', action: 'paste' },
    { label: '删除', action: 'delete' },
    { separator: true },
    { label: '全选', shortcut: 'Ctrl+A', action: 'select-all' },
    { separator: true },
    { label: '设置', shortcut: key('settings', 'Ctrl+,'), action: 'settings' },
  ],
  视图: [
    { label: '切换侧边栏', shortcut: key('toggle-sidebar', 'Ctrl+B'), action: 'toggle-sidebar' },
    { label: '切换底部面板', shortcut: key('toggle-bottom-panel', 'Ctrl+J'), action: 'toggle-bottom-panel' },
    { label: '切换环境信息', shortcut: key('toggle-top-panel', 'Ctrl+Shift+J'), action: 'toggle-top-panel' },
    { label: '打开终端', shortcut: key('open-terminal', 'Ctrl+`'), action: 'open-terminal' },
    { label: '切换文件树', shortcut: key('toggle-files', 'Ctrl+P'), action: 'toggle-files' },
    { label: '切换审阅面板', shortcut: key('toggle-review', 'Ctrl+Shift+G'), action: 'toggle-review' },
    { label: '侧边面板选择', shortcut: key('toggle-side-picker', 'Ctrl+Shift+P'), action: 'toggle-side-picker' },
    { separator: true },
    { label: '浏览器', submenu: [{ label: '打开内置浏览器', shortcut: key('open-browser', 'Ctrl+T'), action: 'open-browser' }] },
    { separator: true },
    { label: '查找', shortcut: key('find', 'Ctrl+F'), action: 'find' },
    { label: '搜索对话', shortcut: key('search-threads', 'Ctrl+K'), action: 'search-threads' },
    { separator: true },
    { label: '上一个聊天', shortcut: key('previous-chat', 'Ctrl+Shift+['), action: 'previous-chat' },
    { label: '下一个聊天', shortcut: key('next-chat', 'Ctrl+Shift+]'), action: 'next-chat' },
    { label: '返回', shortcut: key('back', 'Ctrl+['), action: 'back', disabled: !canGoBack },
    { label: '前进', shortcut: key('forward', 'Ctrl+]'), action: 'forward', disabled: !canGoForward },
    { separator: true },
    { label: '放大', shortcut: key('zoom-in', 'Ctrl+='), action: 'zoom-in' },
    { label: '缩小', shortcut: key('zoom-out', 'Ctrl+-'), action: 'zoom-out' },
    { label: '实际大小', shortcut: key('zoom-reset', 'Ctrl+0'), action: 'zoom-reset' },
    { separator: true },
    { label: '切换全屏', shortcut: key('fullscreen', 'F11'), action: 'fullscreen' },
  ],
  帮助: [
    { label: '文档', action: 'docs', submenu: [
      { label: '开始使用', action: 'docs' },
      { label: '对话与线程', action: 'conversation' },
      { label: '审批与沙箱', action: 'safety' },
      { label: '插件与 MCP', action: 'tools' },
      { label: 'Git 与托管', action: 'git' },
      { label: '设置详解', action: 'settings' },
      { label: '命令行', action: 'cli' },
    ] },
    { label: '显示键盘快捷键', shortcut: key('shortcuts', 'Ctrl+/'), action: 'shortcuts' },
    { label: '新功能', action: 'whats-new' },
    { separator: true },
    { label: '故障排除', action: 'troubleshooting' },
    { label: '系统状态', action: 'system-status' },
    { label: '复制诊断', action: 'copy-diagnostics' },
    { separator: true },
    { label: '任务管理器', action: 'task-manager' },
    { label: '开始性能跟踪', action: 'performance' },
    { separator: true },
    { label: '检查更新...', action: 'check-updates' },
    { label: '关于 Local Codex', action: 'about' },
  ],
  };
}

function MenuRows({ items, onAction }: { items: MenuItem[]; onAction: (action: string) => void }) {
  return <>{items.map((item, index) => item.separator ? <div className="window-menu-separator" key={`separator-${index}`} /> : <div className="window-menu-row-wrap" key={item.label}>
    <button type="button" role="menuitem" disabled={item.disabled} onClick={() => item.action && onAction(item.action)}><span>{item.label}</span>{item.shortcut && <kbd>{item.shortcut}</kbd>}{item.submenu && <UiIcon icon={icons.right} />}</button>
    {item.submenu && <div className="window-titlebar-submenu" role="menu"><MenuRows items={item.submenu} onAction={onAction} /></div>}
  </div>)}</>;
}

export function WindowTitleBar({ onAction, canGoBack = false, canGoForward = false, shortcutMap = {} }: { onAction: (action: string) => void; canGoBack?: boolean; canGoForward?: boolean; shortcutMap?: Record<string, string> }) {
  const [menu, setMenu] = React.useState<string | null>(null);
  const [maximized, setMaximized] = React.useState(false);
  useCoverBrowser(Boolean(menu));
  const menus = menusFor(canGoBack, canGoForward, shortcutMap);
  React.useEffect(() => {
    const closeOutside = (event: PointerEvent) => { if (!(event.target as Element | null)?.closest?.('.window-titlebar-menu')) setMenu(null); };
    const closeWithKeyboard = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenu(null); };
    const closeOnBlur = () => setMenu(null);
    document.addEventListener('pointerdown', closeOutside, true);
    window.addEventListener('keydown', closeWithKeyboard);
    window.addEventListener('blur', closeOnBlur);
    const current = getCurrentWindow();
    void current.isMaximized().then(setMaximized).catch(() => undefined);
    let cancelled = false;
    let stopResize: (() => void) | undefined;
    void current.onResized(() => {
      void current.isMaximized().then(setMaximized).catch(() => undefined);
    }).then((unlisten) => {
      if (cancelled) unlisten();
      else stopResize = unlisten;
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      document.removeEventListener('pointerdown', closeOutside, true);
      window.removeEventListener('keydown', closeWithKeyboard);
      window.removeEventListener('blur', closeOnBlur);
      stopResize?.();
    };
  }, []);
  const run = (action: string) => {
    setMenu(null);
    onAction(action);
  };
  return <div className="window-titlebar" aria-label="窗口标题栏">
    {menu && <button type="button" className="window-menu-dismiss-layer" aria-label="关闭菜单" onPointerDown={() => setMenu(null)} />}
    <div className="window-titlebar-controls">
      <button type="button" title="切换侧栏" aria-label="切换侧栏" onClick={() => run('toggle-sidebar')}><UiIcon icon={icons.menu} /></button>
      <button type="button" title="后退" aria-label="后退" disabled={!canGoBack} onClick={() => run('back')}><UiIcon icon={icons.arrowLeft} /></button>
      <button type="button" title="前进" aria-label="前进" disabled={!canGoForward} onClick={() => run('forward')}><UiIcon icon={icons.arrowRight} /></button>
      {Object.entries(menus).map(([label, items]) => <div className="window-titlebar-menu" key={label} onPointerEnter={() => { if (menu && menu !== label) setMenu(label); }}><button type="button" aria-haspopup="menu" aria-expanded={menu === label} onClick={() => setMenu(menu === label ? null : label)}>{label}</button>{menu === label && <div className={`window-titlebar-menu-popup menu-${label}`} role="menu"><MenuRows items={items} onAction={run} /></div>}</div>)}
    </div>
    <div className="window-titlebar-drag" data-tauri-drag-region />
    <div className="window-titlebar-caption">
      <button type="button" title="最小化" aria-label="最小化" onClick={() => run('minimize')}><UiIcon icon={icons.windowMinimize} /></button>
      <button type="button" title={maximized ? '还原' : '最大化'} aria-label={maximized ? '还原' : '最大化'} onClick={() => run('maximize')}><UiIcon icon={maximized ? icons.windowRestore : icons.windowMaximize} /></button>
      <button type="button" className="window-titlebar-close" title="关闭" aria-label="关闭" onClick={() => run('close-window')}><UiIcon icon={icons.close} /></button>
    </div>
  </div>;
}
