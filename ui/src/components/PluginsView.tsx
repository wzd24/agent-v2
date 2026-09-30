import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, listData } from "../api";
import { icons, UiIcon } from "./UiIcon";

type PluginEntry = { name: string; description?: string; path?: string; source?: string; enabled?: boolean };
type BuiltinSkill = {
  id: string;
  name: string;
  description: string;
  path: string;
  enabled: boolean;
  settingsSection: string;
};

const CARD_META: Record<string, { icon: typeof icons.puzzle; color: string; fallbackName: string; fallbackDescription: string }> = {
  documents: { icon: icons.fileWord, color: "#2b7de1", fallbackName: "文档", fallbackDescription: "创建和编辑文档" },
  pdf: { icon: icons.filePdf, color: "#e24b4a", fallbackName: "PDF", fallbackDescription: "读取、创建和校验 PDF" },
  spreadsheets: { icon: icons.fileExcel, color: "#1f8f4e", fallbackName: "表格", fallbackDescription: "创建和编辑电子表格" },
  presentations: { icon: icons.filePowerpoint, color: "#d29922", fallbackName: "演示文稿", fallbackDescription: "创建和编辑演示文稿" },
  "template-creator": { icon: icons.squarePlus, color: "#7c5cbf", fallbackName: "模板", fallbackDescription: "创建或更新可复用模板" },
  "computer-use": { icon: icons.activity, color: "#4c8dff", fallbackName: "电脑操控", fallbackDescription: "控制本机桌面应用" },
  notebooks: { icon: icons.fileCode, color: "#e67e22", fallbackName: "Notebooks", fallbackDescription: "创建和编辑 Jupyter Notebook" },
  "web-search": { icon: icons.search, color: "#3d8bfd", fallbackName: "网页搜索", fallbackDescription: "用 DuckDuckGo 搜索并读取公开网页" },
};

function PluginIcon({ color, icon = icons.puzzle }: { color: string; icon?: typeof icons.puzzle }) {
  return <span className="plugins-icon" style={{ backgroundColor: color }}><UiIcon icon={icon} /></span>;
}

export function PluginsView({ onOpenSettings }: { onOpenSettings: (section?: string) => void }) {
  const [tab, setTab] = React.useState<"plugins" | "skills">("plugins");
  const [query, setQuery] = React.useState("");
  const [installed, setInstalled] = React.useState<PluginEntry[]>([]);
  const [skills, setSkills] = React.useState<PluginEntry[]>([]);
  const [builtin, setBuiltin] = React.useState<BuiltinSkill[]>([]);
  const [menuId, setMenuId] = React.useState("");
  const [doc, setDoc] = React.useState<{ title: string; body: string } | null>(null);
  const [message, setMessage] = React.useState("");
  const [loading, setLoading] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const [pluginsResult, skillsResult, builtinResult] = await Promise.all([
        api.codex.plugins(),
        api.appServer.request("skills/list", {}),
        api.skills.builtin(),
      ]);
      setInstalled(pluginsResult || []);
      setSkills(listData<PluginEntry>(skillsResult).flatMap((entry) => Array.isArray((entry as any).skills) ? (entry as any).skills : [entry]));
      setBuiltin(builtinResult);
      setMessage("");
    } catch (error) {
      setMessage(String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { void refresh(); }, [refresh]);
  React.useEffect(() => {
    const close = () => setMenuId("");
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, []);

  async function install() {
    try {
      const result = await api.codex.installPlugin();
      if (!result.canceled) { setMessage(`已安装 ${result.plugin?.name || "插件"}`); await refresh(); }
    } catch (error) { setMessage(String(error)); }
  }

  async function showDoc(id: string, title: string) {
    try {
      const skill = await api.skills.read(id);
      setDoc({ title: skill.name || title, body: skill.body });
      setMenuId("");
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function toggleSkill(id: string, enabled: boolean) {
    try {
      setBuiltin(await api.skills.setEnabled(id, enabled));
      setMenuId("");
      setMessage(enabled ? `已启用 ${id}` : `已停用 ${id}`);
    } catch (error) {
      setMessage(String(error));
    }
  }

  const normalized = query.trim().toLowerCase();
  const visibleBuiltin = builtin
    .filter((entry) => CARD_META[entry.id])
    .filter((entry) => !normalized || `${entry.name} ${entry.description} ${CARD_META[entry.id].fallbackName}`.toLowerCase().includes(normalized));
  const visibleInstalled = installed.filter((entry) => !normalized || `${entry.name} ${entry.description || ""}`.toLowerCase().includes(normalized));
  const visibleSkills = skills.filter((entry) => !normalized || `${entry.name} ${entry.description || ""}`.toLowerCase().includes(normalized));

  return <section className="plugins-view">
    <div className="plugins-toolbar">
      <div className="plugins-tabs" role="tablist" aria-label="插件视图">
        <button role="tab" aria-selected={tab === "plugins"} className={tab === "plugins" ? "active" : ""} onClick={() => setTab("plugins")}>插件</button>
        <button role="tab" aria-selected={tab === "skills"} className={tab === "skills" ? "active" : ""} onClick={() => setTab("skills")}>技能</button>
      </div>
      <div className="plugins-toolbar-actions">
        <button title="刷新插件" onClick={() => void refresh()} disabled={loading}><UiIcon icon={icons.refresh} /></button>
        <button title="插件设置" onClick={() => onOpenSettings("plugins")}><UiIcon icon={icons.gear} /></button>
        <button className="plugins-add" onClick={() => void install()}><UiIcon icon={icons.plus} /> 添加 <UiIcon icon={icons.down} /></button>
      </div>
    </div>
    <div className="plugins-content">
      <header className="plugins-heading"><h1>{tab === "plugins" ? "插件" : "技能"}</h1><p>{tab === "plugins" ? "在常用办公和桌面工具中使用 Scorpio Agent" : "扩展 Agent 在本地工作区中的能力"}</p></header>
      <label className="plugins-search"><UiIcon icon={icons.search} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === "plugins" ? "搜索插件" : "搜索技能"} /></label>
      {tab === "plugins" ? <>
        <section className="plugins-section">
          <div className="plugins-section-heading"><h2>内置</h2></div>
          {visibleBuiltin.length ? <div className="plugins-app-grid">{visibleBuiltin.map((entry) => {
            const meta = CARD_META[entry.id];
            return <article className={`plugins-app-card ${entry.enabled ? "" : "disabled"}`} key={entry.id}>
              <PluginIcon color={meta.color} icon={meta.icon} />
              <div>
                <strong>{meta.fallbackName || entry.name}</strong>
                <small>{entry.enabled === false ? "已停用" : (entry.description || meta.fallbackDescription)}</small>
              </div>
              <div className="plugins-app-menu-wrap">
                <button type="button" className="plugins-app-more" title="插件操作" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); setMenuId((current) => current === entry.id ? "" : entry.id); }}>···</button>
                {menuId === entry.id && <div className="plugins-app-menu" role="menu" onPointerDown={(event) => event.stopPropagation()}>
                  <button type="button" onClick={() => void showDoc(entry.id, meta.fallbackName)}><UiIcon icon={icons.fileLines} /><span>查看说明</span></button>
                  <button type="button" onClick={() => void toggleSkill(entry.id, entry.enabled === false)}><UiIcon icon={icons.check} /><span>{entry.enabled === false ? "启用" : "停用"}</span></button>
                  <button type="button" onClick={() => { setMenuId(""); onOpenSettings(entry.settingsSection || "plugins"); }}><UiIcon icon={icons.gear} /><span>打开设置</span></button>
                </div>}
              </div>
            </article>;
          })}</div> : <div className="plugins-empty">没有匹配的内置插件</div>}
        </section>
        <section className="plugins-section">
          <div className="plugins-section-heading"><h2>已安装</h2><button title="插件设置" onClick={() => onOpenSettings("plugins")}><UiIcon icon={icons.gear} /></button></div>
          {visibleInstalled.length > 0 ? <div className="plugins-installed-grid">{visibleInstalled.map((entry) => <article className="plugins-installed-card" key={entry.path || entry.name}><PluginIcon color="#6b9bd4" /><strong>{entry.name}</strong><small>{entry.description || entry.source || "本地插件"}</small></article>)}</div> : <div className="plugins-empty">{loading ? "正在读取本地插件…" : "暂无额外本地插件。内置办公能力已在上方提供。"}</div>}
        </section>
        <div className="plugins-local-note"><UiIcon icon={icons.link} /><span>内置插件在本地生成文件并控制本机应用，不连接云端插件目录。</span></div>
      </> : <section className="plugins-section">
        <div className="plugins-section-heading"><h2>本地技能</h2><button title="刷新技能" onClick={() => void refresh()}><UiIcon icon={icons.refresh} /></button></div>
        {visibleSkills.length > 0 ? <div className="plugins-skill-list">{visibleSkills.map((entry) => <article className="plugins-skill-card" key={entry.path || entry.name}><PluginIcon color="#6b9bd4" icon={icons.puzzle} /><div><strong>{entry.name || "未命名技能"}</strong><small>{entry.description || "本地技能"}</small></div><span>{entry.enabled === false ? "已停用" : "已启用"}</span></article>)}</div> : <div className="plugins-empty">{loading ? "正在读取本地技能…" : "暂无本地技能"}</div>}
      </section>}
      {message && <div className="plugins-message">{message}</div>}
    </div>
    {doc && <div className="plugins-doc-overlay" onClick={() => setDoc(null)}>
      <div className="plugins-doc-dialog" role="dialog" aria-label={doc.title} onClick={(event) => event.stopPropagation()}>
        <header><strong>{doc.title}</strong><button type="button" title="关闭" onClick={() => setDoc(null)}><UiIcon icon={icons.close} /></button></header>
        <div className="markdown-content plugins-doc-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.body}</ReactMarkdown></div>
      </div>
    </div>}
  </section>;
}
