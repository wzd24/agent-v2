import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  engineRestart,
  engineStatus,
  getSettings,
  listWorkspace,
  onNotification,
  onRequest,
  onStatus,
  pickWorkspace,
  readWorkspaceFile,
  rpcRequest,
  rpcRespond,
  saveSettings,
  type EngineStatus,
  type FileContent,
  type Settings,
  type TreeEntry,
} from "./api";

type Thread = {
  id: string;
  name?: string | null;
  preview?: string | null;
  cwd?: string | null;
  updatedAt?: number;
};

type ChatItem = {
  id: string;
  role: "user" | "agent" | "reasoning" | "command" | "file" | "tool";
  text: string;
};

type Approval = {
  id: string | number;
  method: string;
  title: string;
  detail: string;
  params: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function threadTitle(thread: Thread) {
  return (thread.name || thread.preview || thread.id).trim() || thread.id.slice(0, 8);
}

function shortPath(value?: string | null) {
  if (!value) return "";
  const parts = value.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.slice(-2).join("\\");
}

function roleFromType(type: string): ChatItem["role"] {
  if (type === "userMessage") return "user";
  if (type === "agentMessage") return "agent";
  if (type === "reasoning") return "reasoning";
  if (type === "commandExecution") return "command";
  if (type === "fileChange") return "file";
  return "tool";
}

function itemText(item: Record<string, unknown>): string {
  if (typeof item.text === "string" && item.text) return item.text;
  if (Array.isArray(item.summary) && item.summary.length) return item.summary.map(String).join("\n");
  if (typeof item.command === "string") {
    const output = typeof item.aggregatedOutput === "string" ? `\n${item.aggregatedOutput}` : "";
    const code = item.exitCode == null ? "" : `\nexit ${item.exitCode}`;
    return `$ ${item.command}${output}${code}`;
  }
  if (Array.isArray(item.changes)) {
    return item.changes
      .map((change) => {
        const rec = asRecord(change);
        return String(rec.path || rec.diff || "");
      })
      .filter(Boolean)
      .join("\n");
  }
  const content = item.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const rec = asRecord(part);
        return typeof rec.text === "string" ? rec.text : "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function flattenTurns(thread: Record<string, unknown>): ChatItem[] {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const items: ChatItem[] = [];
  for (const turn of turns) {
    const rec = asRecord(turn);
    const turnItems = Array.isArray(rec.items) ? rec.items : [];
    for (const raw of turnItems) {
      const item = asRecord(raw);
      const type = String(item.type || "tool");
      const id = String(item.id || `${type}-${items.length}`);
      items.push({ id, role: roleFromType(type), text: itemText(item) });
    }
  }
  return items;
}

function upsertItem(current: ChatItem[], next: ChatItem) {
  const index = current.findIndex((item) => item.id === next.id);
  if (index < 0) return [...current, next];
  const copy = current.slice();
  copy[index] = { ...copy[index], ...next, text: next.text || copy[index].text };
  return copy;
}

function setTreeChildren(nodes: TreeEntry[], path: string, children: TreeEntry[] | undefined): TreeEntry[] {
  return nodes.map((node) => {
    if (node.path === path) return { ...node, children };
    if (node.children?.length) {
      return { ...node, children: setTreeChildren(node.children, path, children) };
    }
    return node;
  });
}

function TreeRows({
  entries,
  depth,
  currentPath,
  onOpen,
}: {
  entries: TreeEntry[];
  depth: number;
  currentPath: string;
  onOpen: (entry: TreeEntry) => void;
}) {
  return (
    <>
      {entries.map((entry) => (
        <div key={entry.path}>
          <button
            className={`tree-item ${entry.kind === "directory" ? "dir" : ""} ${entry.path === currentPath ? "current" : ""}`}
            style={{ paddingLeft: 8 + depth * 14 }}
            onClick={() => onOpen(entry)}
          >
            {entry.kind === "directory" ? (entry.children ? "▾ " : "▸ ") : ""}
            {entry.name}
          </button>
          {entry.children ? (
            <TreeRows entries={entry.children} depth={depth + 1} currentPath={currentPath} onOpen={onOpen} />
          ) : null}
        </div>
      ))}
    </>
  );
}

export default function App() {
  const [view, setView] = useState<"chat" | "settings">("chat");
  const [status, setStatus] = useState<EngineStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<Approval | null>(null);
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [preview, setPreview] = useState<FileContent | null>(null);
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const turnId = useRef<string | null>(null);
  const selectedIdRef = useRef<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  selectedIdRef.current = selectedId;

  const workspace = settings?.workspace || "";
  const connected = status?.state === "connected";
  const keyReady = Boolean(settings?.apiKeyConfigured || status?.apiKeyConfigured);

  const loadThreads = useCallback(async () => {
    const result = await rpcRequest<{ data?: Thread[] }>("thread/list", { limit: 50 });
    setThreads(result.data || []);
  }, []);

  const loadWorkspace = useCallback(async (root: string) => {
    if (!root) {
      setTree([]);
      return;
    }
    setTree(await listWorkspace(root));
  }, []);

  const openThread = useCallback(async (threadId: string) => {
    setSelectedId(threadId);
    selectedIdRef.current = threadId;
    const result = await rpcRequest<{ thread?: Record<string, unknown> }>("thread/read", {
      threadId,
      includeTurns: true,
    });
    setItems(flattenTurns(result.thread || {}));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unlisteners: Array<() => void> = [];
    void (async () => {
      try {
        const [nextStatus, nextSettings] = await Promise.all([engineStatus(), getSettings()]);
        if (cancelled) return;
        setStatus(nextStatus);
        setSettings(nextSettings);
        setModel(nextSettings.model);
        setBaseUrl(nextSettings.baseUrl);
        if (nextSettings.workspace) await loadWorkspace(nextSettings.workspace);
        unlisteners.push(await onStatus(setStatus));
        unlisteners.push(
          await onNotification((message) => {
            const params = asRecord(message.params);
            const threadId = String(params.threadId || asRecord(params.thread).id || "");
            if (message.method === "turn/started") {
              turnId.current = String(asRecord(params.turn).id || params.turnId || "");
            }
            if (message.method === "turn/completed" || message.method === "turn/interrupted") {
              setBusy(false);
              turnId.current = null;
              void loadThreads().catch(() => undefined);
            }
            if (message.method === "thread/name/updated" || message.method === "thread/started") {
              void loadThreads().catch(() => undefined);
            }
            if (threadId && selectedIdRef.current && threadId !== selectedIdRef.current) return;
            if (message.method === "item/agentMessage/delta") {
              const itemId = String(params.itemId || "stream");
              const delta = String(params.delta || "");
              setItems((current) => {
                const index = current.findIndex((item) => item.id === itemId);
                if (index >= 0) {
                  const next = current.slice();
                  next[index] = { ...next[index], text: next[index].text + delta };
                  return next;
                }
                return [...current, { id: itemId, role: "agent", text: delta }];
              });
            }
            if (message.method === "item/commandExecution/outputDelta") {
              const itemId = String(params.itemId || "");
              const delta = String(params.delta || params.output || "");
              if (!itemId || !delta) return;
              setItems((current) => {
                const index = current.findIndex((item) => item.id === itemId);
                if (index >= 0) {
                  const next = current.slice();
                  next[index] = { ...next[index], role: "command", text: `${next[index].text}${delta}` };
                  return next;
                }
                return [...current, { id: itemId, role: "command", text: delta }];
              });
            }
            if (message.method === "item/completed" || message.method === "item/started") {
              const item = asRecord(params.item);
              const itemId = String(item.id || "");
              if (!itemId) return;
              const type = String(item.type || "");
              setItems((current) =>
                upsertItem(current, { id: itemId, role: roleFromType(type), text: itemText(item) }),
              );
            }
            if (message.method === "error") {
              setError(String(params.message || "引擎错误"));
              setBusy(false);
            }
          }),
        );
        unlisteners.push(
          await onRequest((message) => {
            const params = asRecord(message.params);
            const method = message.method;
            setApproval({
              id: message.id ?? 0,
              method,
              title: method.includes("command")
                ? "命令执行"
                : method.includes("fileChange")
                  ? "文件变更"
                  : "权限请求",
              detail: String(params.command || params.reason || method),
              params,
            });
          }),
        );
      } catch (err) {
        if (!cancelled) setError(String(err));
      }
    })();
    return () => {
      cancelled = true;
      unlisteners.forEach((stop) => stop());
    };
  }, [loadThreads, loadWorkspace]);

  useEffect(() => {
    if (connected) void loadThreads().catch((err) => setError(String(err)));
  }, [connected, loadThreads]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [items, busy, approval]);

  const selected = useMemo(
    () => threads.find((thread) => thread.id === selectedId) || null,
    [threads, selectedId],
  );

  async function chooseWorkspace() {
    const path = await pickWorkspace();
    if (!path) return;
    const next = await getSettings();
    setSettings(next);
    setPreview(null);
    await loadWorkspace(path);
  }

  async function startThread() {
    let cwd = workspace;
    if (!cwd) {
      await chooseWorkspace();
      cwd = (await getSettings()).workspace || "";
    }
    if (!cwd) return null;
    const started = await rpcRequest<{ thread?: Thread }>("thread/start", { cwd });
    const thread = started.thread;
    if (!thread?.id) throw new Error("无法创建线程");
    selectedIdRef.current = thread.id;
    setThreads((current) => [thread, ...current.filter((item) => item.id !== thread.id)]);
    setSelectedId(thread.id);
    setItems([]);
    return thread.id;
  }

  async function send() {
    const text = input.trim();
    if (!text || busy) return;
    if (!keyReady) {
      setView("settings");
      setError("先在设置里保存 DeepSeek API Key。");
      return;
    }
    setError(null);
    setBusy(true);
    setInput("");
    try {
      let threadId = selectedId;
      if (!threadId) threadId = await startThread();
      if (!threadId) throw new Error("没有可用线程");
      setItems((current) => [...current, { id: `user-${Date.now()}`, role: "user", text }]);
      const result = await rpcRequest<{ turn?: { id?: string } }>("turn/start", {
        threadId,
        cwd: workspace || undefined,
        input: [{ type: "text", text, text_elements: [] }],
      });
      turnId.current = result.turn?.id || null;
    } catch (err) {
      setBusy(false);
      setError(String(err));
    }
  }

  async function interrupt() {
    if (!selectedId || !turnId.current) return;
    await rpcRequest("turn/interrupt", { threadId: selectedId, turnId: turnId.current });
    setBusy(false);
  }

  async function decide(accept: boolean) {
    if (!approval) return;
    const result =
      approval.method === "item/permissions/requestApproval"
        ? accept
          ? { permissions: asRecord(approval.params.permissions), scope: "turn" }
          : { permissions: {}, scope: "turn" }
        : { decision: accept ? "accept" : "decline" };
    await rpcRespond(approval.id, result);
    setApproval(null);
  }

  async function persistSettings() {
    try {
      setError(null);
      const next = await saveSettings({ model, baseUrl, apiKey: apiKey.trim() || undefined });
      if (apiKey.trim() && !next.apiKeyConfigured) {
        setSettings(next);
        setError("密钥没有保存成功，请再试一次。");
        return;
      }
      setSettings(next);
      setApiKey("");
      setStatus(await engineStatus());
      setView("chat");
    } catch (err) {
      setError(String(err));
    }
  }

  async function openEntry(entry: TreeEntry) {
    if (entry.kind === "directory") {
      if (entry.children) {
        setTree((current) => setTreeChildren(current, entry.path, undefined));
        return;
      }
      const children = await listWorkspace(workspace, entry.path);
      setTree((current) => setTreeChildren(current, entry.path, children));
      return;
    }
    setPreview(await readWorkspaceFile(workspace, entry.path));
  }

  const stateLabel = status?.state || "starting";

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          Local <span>Codex</span>
        </div>
        <span className={`dot ${stateLabel}`} />
        <span>{stateLabel}</span>
        <span className="hint truncate">
          {status?.model || settings?.model || "deepseek-chat"}
          {keyReady ? "" : " · 未配置密钥"}
        </span>
        <span style={{ flex: 1 }} />
        <button className={view === "chat" ? "active" : ""} onClick={() => setView("chat")}>
          会话
        </button>
        <button className={view === "settings" ? "active" : ""} onClick={() => setView("settings")}>
          设置
        </button>
        <button onClick={() => void engineRestart()}>重启引擎</button>
      </header>

      {view === "settings" ? (
        <main className="settings">
          <h1>设置</h1>
          <p className="hint">
            本地优先，默认 DeepSeek <code>/v1/responses</code>。密钥写入 Windows 凭据管理器，不会进 config.toml。
          </p>
          <div className="settings-form">
            <label>
              模型
              <input value={model} onChange={(event) => setModel(event.target.value)} />
            </label>
            <label>
              Base URL
              <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} />
            </label>
            <label>
              API Key {settings?.apiKeyConfigured ? "（已保存）" : ""}
              <input
                type="password"
                value={apiKey}
                placeholder={settings?.apiKeyConfigured ? "留空则保持原密钥" : "粘贴 DeepSeek API Key"}
                onChange={(event) => setApiKey(event.target.value)}
              />
            </label>
            <div>
              <button className="primary" onClick={() => void persistSettings()}>
                保存并重启引擎
              </button>
            </div>
            {error ? <div className="error">{error}</div> : null}
            <p className="hint">CODEX_HOME：{settings?.codexHome}</p>
            <p className="hint truncate">引擎：{status?.binary || "未找到"}</p>
          </div>
        </main>
      ) : (
        <main className="shell">
          <aside className="sidebar">
            <div className="panel-head">
              线程
              <button onClick={() => void startThread().catch((err) => setError(String(err)))}>新建</button>
            </div>
            <div className="list">
              {threads.length === 0 ? (
                <div className="muted-empty">还没有会话。点新建，或直接在右侧输入后发送。</div>
              ) : (
                threads.map((thread) => (
                  <button
                    key={thread.id}
                    className={`thread ${thread.id === selectedId ? "selected" : ""}`}
                    onClick={() => void openThread(thread.id).catch((err) => setError(String(err)))}
                  >
                    <span className="title">{threadTitle(thread)}</span>
                    <span className="sub">{shortPath(thread.cwd) || thread.id.slice(0, 8)}</span>
                  </button>
                ))
              )}
            </div>
          </aside>

          <section className="chat">
            <div className="timeline">
              {items.length === 0 ? (
                <div className="empty">
                  <h2>从这条会话开始</h2>
                  <p>引擎已经接到本机 Codex。第一期可以建线程、流式对话、批命令/改文件、浏览工作区。</p>
                  <ol>
                    <li>工作区已默认打开当前仓库，右侧可点开文件。</li>
                    <li>{keyReady ? "密钥已就绪，直接输入问题。" : "先到设置保存 DeepSeek API Key。"}</li>
                    <li>发送后如果 Agent 要跑命令，顶部会出现审批条。</li>
                  </ol>
                </div>
              ) : (
                items.map((item) => (
                  <article key={item.id} className={`bubble ${item.role}`}>
                    <div className="who">{item.role}</div>
                    <div className="body">{item.text || "…"}</div>
                  </article>
                ))
              )}
              <div ref={bottomRef} />
            </div>
            {status?.state === "error" || status?.state === "disconnected" ? (
              <div className="banner warn">
                <span>{status.message || "引擎未连接"}</span>
                <button onClick={() => void engineRestart()}>重试</button>
              </div>
            ) : null}
            {!keyReady ? (
              <div className="banner warn">
                <span>还没有 API Key，对话发不出去。</span>
                <button className="primary" onClick={() => setView("settings")}>
                  去设置
                </button>
              </div>
            ) : null}
            {approval ? (
              <div className="approval">
                <p>
                  <strong>{approval.title}</strong>
                  <br />
                  {approval.detail}
                </p>
                <div>
                  <button onClick={() => void decide(false)}>拒绝</button>{" "}
                  <button className="primary" onClick={() => void decide(true)}>
                    允许
                  </button>
                </div>
              </div>
            ) : null}
            {error ? <div className="error" style={{ padding: "0 16px 8px" }}>{error}</div> : null}
            <div className="composer">
              <textarea
                value={input}
                placeholder={keyReady ? "问 Agent，Enter 发送，Shift+Enter 换行" : "先配置 API Key"}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void send();
                  }
                }}
              />
              <div className="composer-actions">
                <button disabled={!busy} onClick={() => void interrupt()}>
                  中断
                </button>
                <button className="primary" disabled={busy || !keyReady || !input.trim()} onClick={() => void send()}>
                  发送
                </button>
              </div>
            </div>
          </section>

          <aside className="workspace">
            <div className="panel-head">
              工作区
              <button onClick={() => void chooseWorkspace()}>选择</button>
            </div>
            <div className="list">
              <div className="hint truncate" style={{ padding: "4px 8px 10px" }} title={workspace}>
                {workspace || "未选择"}
              </div>
              {tree.length === 0 ? (
                <div className="muted-empty">没有可显示的文件。</div>
              ) : (
                <TreeRows entries={tree} depth={0} currentPath={preview?.path || ""} onOpen={(entry) => void openEntry(entry).catch((err) => setError(String(err)))} />
              )}
            </div>
            {preview ? (
              <div className="preview">
                <div className="hint">{preview.name}</div>
                <pre>{preview.text}</pre>
              </div>
            ) : null}
          </aside>
        </main>
      )}

      <footer className="status">
        <span className="truncate">{selected?.cwd || workspace || "no workspace"}</span>
        <span style={{ flex: 1 }} />
        <span>{busy ? "回合进行中" : connected ? "就绪" : status?.message || "引擎未连接"}</span>
      </footer>
    </div>
  );
}
