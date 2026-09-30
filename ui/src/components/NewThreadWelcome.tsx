import React from "react";
import { api, CodexProject } from "../api";
import { useCoverBrowser } from "../coverBrowser";
import { useAppDialog } from "./AppDialog";
import { icons, UiIcon } from "./UiIcon";

type WorktreeEntry = { path: string; head: string; branch: string };

function projectLabel(root: string): string {
  return String(root || "").split(/[\\/]/).filter(Boolean).pop() || "工作区";
}

export function NewThreadWorkspacePicker({ projects, workspaceRoot, gitBranch, projectless = false, onWorkspaceChange, onProjectCreated }: { projects: CodexProject[]; workspaceRoot: string; gitBranch: string; projectless?: boolean; onWorkspaceChange: (root: string) => Promise<void>; onProjectCreated?: (project: CodexProject) => void }) {
  const [menu, setMenu] = React.useState<"project" | "location" | "branch" | null>(null);
  const [createProjectOpen, setCreateProjectOpen] = React.useState(false);
  const [projectName, setProjectName] = React.useState("");
  const [projectRoot, setProjectRoot] = React.useState("");
  const [projectError, setProjectError] = React.useState("");
  const [creatingProject, setCreatingProject] = React.useState(false);
  const dialog = useAppDialog();
  useCoverBrowser(createProjectOpen || Boolean(menu));
  const [query, setQuery] = React.useState("");
  const [worktrees, setWorktrees] = React.useState<WorktreeEntry[]>([]);
  const currentName = projectless ? "不在项目中" : projectLabel(workspaceRoot);
  const hasGit = Boolean(gitBranch && gitBranch !== "无 Git");
  const visibleProjects = projects.filter((project) => !query.trim() || `${project.name} ${project.path}`.toLowerCase().includes(query.trim().toLowerCase()));
  const visibleWorktrees = worktrees.filter((entry) => !query.trim() || `${entry.branch} ${entry.path}`.toLowerCase().includes(query.trim().toLowerCase()));

  async function openBranchMenu() {
    if (!hasGit) return;
    try { const result = await window.localCodex.git.worktrees(); setWorktrees(result.entries || []); } catch { setWorktrees([]); }
    setQuery("");
    setMenu("branch");
  }

  async function createWorktree() {
    const branch = await dialog.prompt("新建工作树", "", { placeholder: "工作树分支名" });
    if (!branch?.trim()) return;
    const result = await window.localCodex.git.createWorktree(branch.trim());
    if (!result.ok || !result.path) return;
    await onWorkspaceChange(result.path);
    setMenu(null);
  }

  async function chooseNewProject() {
    setProjectName("");
    setProjectRoot("");
    setProjectError("");
    setMenu(null);
    setCreateProjectOpen(true);
  }

  async function chooseProjectRoot() {
    try {
      const result = await window.localCodex.workspace.pick();
      if (result.canceled || !result.root) return;
      setProjectRoot(result.root);
      setProjectName((current) => current.trim() ? current : projectLabel(result.root));
      setProjectError("");
    } catch (error) {
      setProjectError(String(error));
    }
  }

  async function createProject() {
    const name = projectName.trim();
    const root = projectRoot.trim();
    if (!name) { setProjectError("请输入项目名称"); return; }
    if (!root) { setProjectError("请选择源文件夹"); return; }
    setCreatingProject(true);
    setProjectError("");
    try {
      const result = await api.appServer.request("project/create", { name, roots: [{ path: root }], idempotencyKey: crypto.randomUUID() });
      const project = result?.project || result;
      const registered = await api.codex.registerProject(root, String(project?.name || name));
      onProjectCreated?.(registered);
      await onWorkspaceChange(root);
      setCreateProjectOpen(false);
    } catch (error) {
      setProjectError(String(error));
    } finally {
      setCreatingProject(false);
    }
  }

  return <div className="new-thread-workspace-picker">
    {createProjectOpen && <div className="new-project-modal-backdrop" role="presentation"><section className="new-project-modal" role="dialog" aria-modal="true" aria-labelledby="new-project-title"><div className="new-project-modal-head"><h2 id="new-project-title">创建项目</h2><button type="button" title="关闭" onClick={() => setCreateProjectOpen(false)}><UiIcon icon={icons.close} /></button></div><label className="new-project-name"><UiIcon icon={icons.folder} /><input autoFocus value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="项目名称" /></label><strong className="new-project-source-label">源文件夹</strong><button type="button" className={`new-project-source ${projectRoot ? "selected" : ""}`} onClick={() => void chooseProjectRoot()}><UiIcon icon={projectRoot ? icons.folderOpen : icons.folder} /><span>{projectRoot || "添加 Codex 可读取和编辑的文件夹"}</span></button>{projectError && <div className="new-project-error">{projectError}</div>}<div className="new-project-modal-actions"><button type="button" className="new-project-cancel" onClick={() => setCreateProjectOpen(false)}>取消</button><button type="button" className="new-project-submit" disabled={creatingProject} onClick={() => void createProject()}>{creatingProject ? "创建中…" : "创建项目"}</button></div></section></div>}
    {menu === "project" && <div className="new-thread-menu new-thread-project-menu"><label><UiIcon icon={icons.search} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目" /></label><div className="new-thread-menu-list">{visibleProjects.map((project) => <button key={project.path} className={project.path.toLowerCase() === workspaceRoot.toLowerCase() ? "active" : ""} onClick={() => { void onWorkspaceChange(project.path); setMenu(null); setQuery(""); }}><UiIcon icon={icons.folder} /><span><b>{project.name}</b><small>{project.path}</small></span>{project.path.toLowerCase() === workspaceRoot.toLowerCase() && <UiIcon icon={icons.check} />}</button>)}</div><button className="new-thread-menu-action" onClick={() => void chooseNewProject()}><UiIcon icon={icons.plus} /> 新建项目</button><button className="new-thread-menu-action" onClick={() => { void onWorkspaceChange(""); setMenu(null); setQuery(""); }}><UiIcon icon={icons.close} /> 不在项目中</button></div>}
    {menu === "location" && <div className="new-thread-menu new-thread-location-menu"><strong>工作位置</strong><button className="active"><UiIcon icon={icons.folder} /><span>本地</span><UiIcon icon={icons.check} /></button><button onClick={() => void createWorktree()}><UiIcon icon={icons.folderOpen} /><span>新建本地工作树</span></button></div>}
    {menu === "branch" && <div className="new-thread-menu new-thread-branch-menu"><label><UiIcon icon={icons.search} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索分支" /></label><strong>分支</strong>{visibleWorktrees.length > 0 ? visibleWorktrees.map((entry) => <button key={entry.path} className={entry.branch === gitBranch ? "active" : ""} onClick={() => { void onWorkspaceChange(entry.path); setMenu(null); }}><UiIcon icon={icons.branch} /><span><b>{entry.branch || "detached"}</b><small>{entry.path}</small></span>{entry.branch === gitBranch && <UiIcon icon={icons.check} />}</button>) : <button className="active"><UiIcon icon={icons.branch} /><span><b>{gitBranch}</b><small>当前工作分支</small></span><UiIcon icon={icons.check} /></button>}<button className="new-thread-menu-action" onClick={() => void createWorktree()}><UiIcon icon={icons.plus} /> 创建并检出新分支…</button></div>}
    <button className="new-thread-workspace-chip" onClick={() => { setQuery(""); setMenu(menu === "project" ? null : "project"); }}><UiIcon icon={icons.folder} /><span>{currentName}</span><UiIcon icon={icons.down} /></button>
    <button className="new-thread-workspace-chip" onClick={() => setMenu(menu === "location" ? null : "location")}><UiIcon icon={icons.folderOpen} /><span>本地</span><UiIcon icon={icons.down} /></button>
    {hasGit && <button className="new-thread-workspace-chip" onClick={() => void openBranchMenu()}><UiIcon icon={icons.branch} /><span>{gitBranch}</span><UiIcon icon={icons.down} /></button>}
    {dialog.node}
  </div>;
}

export function ProjectEditDialog({ project, onClose, onSaved, onDeleted }: { project: CodexProject; onClose: () => void; onSaved: (project: CodexProject) => Promise<void> | void; onDeleted: (projectPath: string) => Promise<void> | void }) {
  useCoverBrowser(true);
  const [name, setName] = React.useState(project.name || "");
  const [roots, setRoots] = React.useState<string[]>(() => {
    const listed = [project.path, ...(project.rootPaths || [])].filter(Boolean);
    return listed.filter((item, index) => listed.findIndex((other) => other.replace(/[\\/]+$/, "").toLowerCase() === item.replace(/[\\/]+$/, "").toLowerCase()) === index);
  });
  const [error, setError] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const dialog = useAppDialog();
  async function addFolder() {
    try {
      const result = await window.localCodex.workspace.pick({ title: "添加源文件夹" });
      if (result.canceled || !result.root) return;
      setRoots((current) => current.some((item) => item.replace(/[\\/]+$/, "").toLowerCase() === result.root.replace(/[\\/]+$/, "").toLowerCase()) ? current : [...current, result.root]);
      setError("");
    } catch (reason) { setError(String(reason)); }
  }
  async function save() {
    if (!name.trim()) { setError("项目名称不能为空"); return; }
    if (!roots.length) { setError("至少需要一个源文件夹"); return; }
    setSaving(true); setError("");
    try { const updated = await api.codex.setProjectRoots(project.path, name.trim(), roots); await onSaved(updated); } catch (reason) { setError(String(reason)); } finally { setSaving(false); }
  }
  async function remove() {
    if (!(await dialog.confirm("移除项目", `确认移除项目“${project.name}”？这不会删除磁盘上的文件。`))) return;
    setSaving(true); setError("");
    try { await api.codex.deleteProject(project.path); await onDeleted(project.path); } catch (reason) { setError(String(reason)); setSaving(false); }
  }
  return <div className="new-project-modal-backdrop" role="presentation"><section className="new-project-modal project-edit-modal" role="dialog" aria-modal="true" aria-labelledby="edit-project-title"><div className="new-project-modal-head"><h2 id="edit-project-title">编辑项目</h2><button type="button" title="关闭" onClick={onClose}><UiIcon icon={icons.close} /></button></div><label className="new-project-name"><UiIcon icon={icons.folder} /><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="项目名称" /></label><strong className="new-project-source-label">源文件夹</strong><div className="project-edit-roots">{roots.map((root) => <div className="project-edit-root-row" key={root}><UiIcon icon={icons.folder} /><span title={root}>{root}</span><button type="button" title="移除源文件夹" onClick={() => setRoots((current) => current.filter((item) => item !== root))}><UiIcon icon={icons.close} /></button></div>)}<button type="button" className="project-edit-add-root" onClick={() => void addFolder()}><UiIcon icon={icons.folderOpen} /> 添加文件夹</button></div>{error && <div className="new-project-error">{error}</div>}<div className="new-project-modal-actions project-edit-actions"><button type="button" className="project-edit-remove" disabled={saving} onClick={() => void remove()}>移除本地项目</button><span /><button type="button" className="new-project-cancel" onClick={onClose}>取消</button><button type="button" className="new-project-submit" disabled={saving} onClick={() => void save()}>{saving ? "保存中…" : "保存"}</button></div></section>{dialog.node}</div>;
}

export function NewThreadWelcome({ onPrompt, ephemeral = false }: { onPrompt: (value: string) => void; ephemeral?: boolean }) {
  return <div className="new-thread-welcome">
    <div className="new-thread-welcome-mark"><UiIcon icon={icons.comments} /></div>
    <h1>{ephemeral ? "这次对话不会保存" : "你想让我们构建什么？"}</h1>
    {ephemeral && <p className="new-thread-welcome-note">临时聊天不会写入本地历史。切换到其他线程或再开新聊天时会被删除。</p>}
    <div className="new-thread-prompts">
      <button onClick={() => onPrompt("探索并理解代码")}><UiIcon icon={icons.search} /><span>探索并理解代码</span></button>
      <button onClick={() => onPrompt("构建新功能、应用或工具")}><UiIcon icon={icons.code} /><span>构建新功能、应用或工具</span></button>
      <button onClick={() => onPrompt("审查代码并提出修改建议")}><UiIcon icon={icons.check} /><span>审查代码并提出修改建议</span></button>
      <button onClick={() => onPrompt("修复问题和失败")}><UiIcon icon={icons.undo} /><span>修复问题和失败</span></button>
    </div>
  </div>;
}
