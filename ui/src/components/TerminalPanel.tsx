import React from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { api } from '../api';
import { icons, UiIcon } from './UiIcon';

type SessionState = 'starting' | 'running' | 'exited';
type Session = { key: string; title: string };

function createSession(index: number): Session {
  return { key: `term-${Date.now()}-${Math.random().toString(16).slice(2)}`, title: `终端 ${index}` };
}

function TerminalSession({ sessionKey, active, onMeta }: { sessionKey: string; active: boolean; onMeta: (key: string, state: SessionState, label: string) => void }) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const terminalRef = React.useRef<Terminal | null>(null);
  const fitRef = React.useRef<FitAddon | null>(null);
  const terminalIdRef = React.useRef<string | null>(null);
  const onMetaRef = React.useRef(onMeta);
  onMetaRef.current = onMeta;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: 'ui-monospace, Consolas, monospace',
      fontSize: 12,
      scrollback: 5000,
      theme: { background: '#111315', foreground: '#c9d1d9', cursor: '#c9d1d9', selectionBackground: '#264f78' },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;
    fitRef.current = fit;
    const fitTerminal = () => { try { fit.fit(); const id = terminalIdRef.current; if (id) void api.terminal.resize(id, terminal.cols, terminal.rows); } catch { /* host may be hidden during panel transitions */ } };
    const resizeObserver = new ResizeObserver(fitTerminal);
    resizeObserver.observe(host);
    const dataDisposable = terminal.onData((data) => { const id = terminalIdRef.current; if (id) void api.terminal.write(id, data); });
    const unOutput = api.terminal.onOutput((message) => { const id = terminalIdRef.current; if (id && message.id !== id) return; terminal.write(message.data); });
    const unExit = api.terminal.onExit((message) => {
      const id = terminalIdRef.current;
      if (id && message.id !== id) return;
      terminal.write(`\r\n[进程已退出，代码 ${message.exitCode}]\r\n`);
      onMetaRef.current(sessionKey, 'exited', '已退出');
      terminalIdRef.current = null;
    });
    onMetaRef.current(sessionKey, 'starting', '终端');
    void Promise.all([api.diagnostics.read(), api.preferences.read()])
      .then(([info, preferences]) => api.terminal.start({ cwd: info.cwd, cols: terminal.cols || 120, rows: terminal.rows || 30, shell: String(preferences.shell || 'PowerShell') }))
      .then((result) => { terminalIdRef.current = result.id; onMetaRef.current(sessionKey, 'running', String(result.shell || result.cwd || '终端')); fitTerminal(); })
      .catch((error) => { terminal.write(`\r\n${String(error)}\r\n`); onMetaRef.current(sessionKey, 'exited', '启动失败'); });
    requestAnimationFrame(fitTerminal);
    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      unOutput();
      unExit();
      const id = terminalIdRef.current;
      if (id) void api.terminal.terminate(id);
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
      terminalIdRef.current = null;
    };
  }, [sessionKey]);

  React.useEffect(() => {
    if (!active) return;
    const fit = () => { try { fitRef.current?.fit(); const id = terminalIdRef.current; const terminal = terminalRef.current; if (id && terminal) void api.terminal.resize(id, terminal.cols, terminal.rows); } catch { /* hidden host */ } };
    requestAnimationFrame(fit);
    if (active) terminalRef.current?.focus();
  }, [active]);

  return <div className={`terminal-session ${active ? 'active' : ''}`} ref={hostRef} onClick={() => terminalRef.current?.focus()} />;
}

export function TerminalPanel({ onClose, placement = "bottom" }: { onClose?: () => void; placement?: "bottom" | "right" }) {
  const [sessions, setSessions] = React.useState<Session[]>(() => [createSession(1)]);
  const [activeKey, setActiveKey] = React.useState(sessions[0].key);
  const [meta, setMeta] = React.useState<Record<string, { state: SessionState; label: string }>>({});
  const nextIndex = React.useRef(2);

  const setSessionMeta = React.useCallback((key: string, state: SessionState, label: string) => {
    setMeta((old) => ({ ...old, [key]: { state, label } }));
  }, []);

  function addSession() {
    const session = createSession(nextIndex.current);
    nextIndex.current += 1;
    setSessions((old) => [...old, session]);
    setActiveKey(session.key);
  }

  function closeSession(key: string) {
    setSessions((old) => {
      const index = old.findIndex((session) => session.key === key);
      const next = old.filter((session) => session.key !== key);
      if (next.length === 0) {
        onClose?.();
        return old;
      }
      if (activeKey === key) setActiveKey(next[Math.max(0, index - 1)].key);
      return next;
    });
  }

  function closePanel() {
    setSessions([]);
    onClose?.();
  }

  const activeMeta = meta[activeKey];

  return <div className="terminal-pty">
    <div className="terminal-tabbar">
      <div className="terminal-tabs">
        {sessions.map((session) => {
          const sessionMeta = meta[session.key];
          return <div className={`terminal-tab ${session.key === activeKey ? 'active' : ''}`} key={session.key} onClick={() => setActiveKey(session.key)}>
            <UiIcon icon={icons.terminal} />
            <span title={sessionMeta?.label || session.title}>{sessionMeta?.label || session.title}</span>
            <button type="button" title="关闭终端标签" onClick={(event) => { event.stopPropagation(); closeSession(session.key); }}><UiIcon icon={icons.close} /></button>
          </div>;
        })}
      </div>
      <button type="button" className="terminal-tab-add" title="新建终端" onClick={addSession}><UiIcon icon={icons.plus} /></button>
      <span className="terminal-tabbar-spacer" />
      <span className={`terminal-tab-state ${activeMeta?.state || 'starting'}`} title={activeMeta?.state === 'running' ? '终端运行中' : activeMeta?.state === 'starting' ? '终端启动中' : '终端已退出'} />
      <button type="button" className="terminal-panel-close" title={placement === "right" ? "关闭右侧面板" : "关闭底部面板"} onClick={closePanel}><UiIcon icon={icons.close} /></button>
    </div>
    <div className="terminal-surface terminal-xterm-surface">
      {sessions.map((session) => (
        <TerminalSession key={session.key} sessionKey={session.key} active={session.key === activeKey} onMeta={setSessionMeta} />
      ))}
    </div>
  </div>;
}
