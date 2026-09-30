import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../api";
import { useCoverBrowser } from "../coverBrowser";
import { icons, UiIcon } from "./UiIcon";

const FALLBACK_TABS = [
  { id: "docs", label: "开始使用" },
  { id: "whats-new", label: "新功能" },
  { id: "troubleshooting", label: "故障排除" },
];

const DOC_PAGE_IDS = new Set(["docs", "conversation", "safety", "tools", "git", "settings", "cli"]);

export function HelpView({
  initialPage = "docs",
  onClose,
  onOpenShortcuts,
}: {
  initialPage?: string;
  onClose: () => void;
  onOpenShortcuts?: () => void;
}) {
  useCoverBrowser(true);
  const [tab, setTab] = React.useState(initialPage || "docs");
  const [pages, setPages] = React.useState<Array<{ id: string; title: string; body: string }>>([]);
  const [diagnostics, setDiagnostics] = React.useState<Record<string, any> | null>(null);
  const [message, setMessage] = React.useState("");

  const navItems = [
    ...(pages.length
      ? pages.map((page) => ({ id: page.id, label: page.title }))
      : FALLBACK_TABS),
    { id: "status", label: "系统状态" },
  ];

  const refresh = React.useCallback(async () => {
    try {
      const [helpPages, info] = await Promise.all([api.help.pages(), api.diagnostics.read()]);
      setPages(helpPages);
      setDiagnostics(info);
      setMessage("");
    } catch (error) {
      setMessage(String(error));
    }
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);
  React.useEffect(() => { setTab(initialPage || "docs"); }, [initialPage]);
  React.useEffect(() => {
    if (!pages.length) return;
    const allowed = new Set(["status", ...pages.map((page) => page.id)]);
    setTab((current) => (allowed.has(current) ? current : "docs"));
  }, [pages]);

  const page = pages.find((entry) => entry.id === tab);
  async function copyDiagnostics() {
    try {
      const text = await api.help.copyDiagnostics();
      await navigator.clipboard.writeText(text);
      setMessage("已复制本地诊断信息");
    } catch (error) {
      setMessage(String(error));
    }
  }
  async function openLog() {
    try {
      const result = await api.help.openLog();
      setMessage(result.ok ? `已打开日志：${result.path}` : result.output || "无法打开日志");
    } catch (error) {
      setMessage(String(error));
    }
  }

  return (
    <div className="help-shell">
      <div className="help-layout">
        <aside className="help-nav">
          <button className="settings-back" onClick={onClose}>
            <UiIcon icon={icons.right} className="settings-back-icon" /> 返回应用
          </button>
          <div className="help-nav-group-title">手册</div>
          {navItems.filter((entry) => DOC_PAGE_IDS.has(entry.id)).map((entry) => (
            <button
              key={entry.id}
              className={`settings-nav-item ${tab === entry.id ? "active" : ""}`}
              onClick={() => setTab(entry.id)}
            >
              <UiIcon icon={icons.fileLines} />
              <span>{entry.label}</span>
            </button>
          ))}
          <div className="help-nav-group-title">支持</div>
          {navItems.filter((entry) => !DOC_PAGE_IDS.has(entry.id)).map((entry) => (
            <button
              key={entry.id}
              className={`settings-nav-item ${tab === entry.id ? "active" : ""}`}
              onClick={() => setTab(entry.id)}
            >
              <UiIcon icon={entry.id === "status" ? icons.activity : icons.fileLines} />
              <span>{entry.label}</span>
            </button>
          ))}
          <button className="settings-nav-item" onClick={() => onOpenShortcuts?.()}>
            <UiIcon icon={icons.code} />
            <span>键盘快捷键</span>
          </button>
        </aside>
        <main className="help-main">
          <article className="help-article">
          {tab === "status" ? (
            <>
              <header className="help-page-head">
                <h1>系统状态</h1>
                <p className="help-page-lead">这些是本机 Scorpio Agent 的运行信息，不会上报到任何云端。</p>
              </header>
              <div className="settings-card">
                <div className="settings-row"><div className="settings-row-copy"><strong>应用状态</strong><small>{diagnostics?.state || "读取中…"}{diagnostics?.message ? ` · ${diagnostics.message}` : ""}</small></div></div>
                <div className="settings-row"><div className="settings-row-copy"><strong>平台</strong><small>{diagnostics?.platform || "…"}</small></div></div>
                <div className="settings-row"><div className="settings-row-copy"><strong>工作区</strong><small>{diagnostics?.cwd || "…"}</small></div></div>
                <div className="settings-row"><div className="settings-row-copy"><strong>应用数据</strong><small>{diagnostics?.appRoot || "…"}</small></div></div>
                <div className="settings-row"><div className="settings-row-copy"><strong>引擎运行时</strong><small>{diagnostics?.engineHome || diagnostics?.codexHome || "…"}</small></div></div>
                <div className="settings-row"><div className="settings-row-copy"><strong>Provider</strong><small>{diagnostics?.provider?.provider || "未设置"}{diagnostics?.provider?.blocked ? " · 已被拦截" : ""}</small></div></div>
                <div className="settings-row"><div className="settings-row-copy"><strong>网络边界</strong><small>{diagnostics?.networkBoundary || "…"}</small></div></div>
                <div className="settings-row"><div className="settings-row-copy"><strong>Node</strong><small>{diagnostics?.versions?.node || "未找到 node.exe"}</small></div></div>
                <div className="settings-row"><div className="settings-row-copy"><strong>日志</strong><small>{diagnostics?.logFile || "…"}</small></div>
                  <div className="settings-row-control">
                    <button className="settings-action" onClick={() => void copyDiagnostics()}><UiIcon icon={icons.copy} /> 复制诊断</button>
                    <button className="settings-action" onClick={() => void openLog()}><UiIcon icon={icons.folderOpen} /> 打开日志</button>
                    <button className="settings-action" onClick={() => void refresh()}><UiIcon icon={icons.refresh} /> 刷新</button>
                  </div>
                </div>
              </div>
            </>
          ) : (
            <>
              <header className="help-page-head">
                <h1>{page?.title || navItems.find((entry) => entry.id === tab)?.label}</h1>
              </header>
              <div className="help-markdown markdown-content">
                {page?.body ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{page.body}</ReactMarkdown> : <p>正在读取本地文档…</p>}
              </div>
            </>
          )}
          {message && <div className="settings-import-status">{message}</div>}
          </article>
        </main>
      </div>
    </div>
  );
}
