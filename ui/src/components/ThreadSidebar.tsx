import React, { useEffect, useMemo, useState } from "react";
import { api, CodexProject, Thread, ThreadSection } from "../api";
import { CollaborationModeOption, CollaborationPanel } from "./CollaborationPanel";
import { useAppDialog } from "./AppDialog";
import { icons, UiIcon } from "./UiIcon";

function titleOf(thread: Thread): string {
  return (
    thread.title ||
    thread.displayTitle ||
    thread.name ||
    thread.preview ||
    "未命名线程"
  );
}
function threadIsRunning(thread: Thread): boolean {
  const status = thread.status;
  const value = typeof status === "string" ? status : status?.type;
  return value === "running" || value === "inProgress" || value === "active";
}
function formatThreadDuration(thread: Thread): string {
  const milliseconds = Number(thread.durationMs || thread.lastTurnDurationMs || thread.turnDurationMs || thread.elapsedMs || 0);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return threadIsRunning(thread) ? "进行中" : "";
  const seconds = Math.max(1, Math.round(milliseconds / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)} 分` : `${seconds} 秒`;
}
function canonicalPath(value: string): string {
  return String(value || "")
    .replace(/^\\\\\?\\/, "")
    .replace(/[\\/]+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
}
function canonicalRemote(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^[a-z]+:\/\//i, "")
    .replace(/^git@/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
}

const PRODUCT_COLLAB_MODES: CollaborationModeOption[] = [
  { name: "普通", mode: "normal", sub: "标准对话" },
  { name: "计划", mode: "plan", sub: "先规划再动手" },
  { name: "协作", mode: "collab", sub: "高推理协作" },
];

function productModeFromServer(item: { name?: string; mode?: string; id?: string }): string {
  const name = String(item.name || "");
  const raw = String(item.mode || item.id || name).toLowerCase();
  if (name === "计划" || raw === "plan") return "计划";
  if (name === "普通" || raw === "normal") return "普通";
  if (name === "协作" || raw === "default" || raw === "collab" || raw === "collaboration") return "协作";
  return "";
}

type Props = {
  projects: CodexProject[];
  sections: ThreadSection[];
  threads: Thread[];
  currentId: string | null;
  loadingId?: string | null;
  search: string;
  onSearch: (value: string) => void;
  onNew: () => void;
  onSelect: (id: string) => void;
  onNavigate: (label: string) => void;
  onOpenSettings: () => void;
  onEditProject?: (path: string) => Promise<void>;
  onQuickNewProject?: (path: string) => void | Promise<void>;
  onOpenProjectRoot?: (path: string) => void | Promise<void>;
  onOpenProjectInVscode?: (path: string) => void | Promise<void>;
  onCreateProjectWorktree?: (path: string) => void | Promise<void>;
  onRemoveProject?: (path: string) => void | Promise<void>;
  onExportCurrent?: () => Promise<string>;
  onOpenHelp?: () => void;
  onOpenAbout?: () => void;
  collabItems?: any[];
  currentMode?: string;
  onSelectCollabMode?: (mode: string) => void;
  gitlabAvailable?: boolean;
  githubAvailable?: boolean;
  onMoveCurrentToSection: () => void;
  profileName?: string;
  onThreadAction: (
    action:
      | "rename"
      | "fork"
      | "archive"
      | "delete"
      | "export"
      | "revert"
      | "inject"
      | "section",
    thread: Thread,
  ) => void;
};

export function ThreadSidebar({
  projects,
  sections,
  threads,
  currentId,
  loadingId,
  search,
  onSearch,
  onNew,
  onSelect,
  onNavigate,
  onOpenSettings,
  onEditProject,
  onQuickNewProject,
  onOpenProjectRoot,
  onOpenProjectInVscode,
  onCreateProjectWorktree,
  onRemoveProject,
  onExportCurrent,
  onOpenHelp,
  onOpenAbout,
  collabItems = [],
  currentMode = "",
  onSelectCollabMode,
  gitlabAvailable = false,
  githubAvailable = false,
  onMoveCurrentToSection,
  profileName = "本地",
  onThreadAction,
}: Props) {
  const dialog = useAppDialog();
  const [activeNav, setActiveNav] = useState("新对话");
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    new Set(),
  );
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [hoveredProject, setHoveredProject] = useState<string | null>(null);
  const [projectMenu, setProjectMenu] = useState<string | null>(null);
  const [projectMenuPosition, setProjectMenuPosition] = useState<{ top: number; left: number } | null>(null);
  const [pinnedProjects, setPinnedProjects] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('local-codex:pinned-projects') || '[]');
      return new Set(Array.isArray(saved) ? saved.filter((value) => typeof value === 'string') : []);
    } catch { return new Set(); }
  });
  const [hoveredThread, setHoveredThread] = useState<string | null>(null);
  const [threadPopupPosition, setThreadPopupPosition] = useState<{ top: number; left: number } | null>(null);
  const [pinnedThreads, setPinnedThreads] = useState<Set<string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('local-codex:pinned-threads') || '[]');
      return new Set(Array.isArray(saved) ? saved.filter((value) => typeof value === 'string') : []);
    } catch { return new Set(); }
  });
  const [searchHits, setSearchHits] = useState<Array<{ thread: Thread; snippet: string }>>([]);
  const [searching, setSearching] = useState(false);
  const [headerMenu, setHeaderMenu] = useState<null | "brand" | "collab">(null);
  const [searchFocused, setSearchFocused] = useState(false);
  const [collabModes, setCollabModes] = useState<CollaborationModeOption[]>(PRODUCT_COLLAB_MODES);
  const [collabPos, setCollabPos] = useState<{ top: number; left: number } | null>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);
  const [popupPosition, setPopupPosition] = useState<{
    top: number;
    left: number;
  } | null>(null);
  useEffect(() => {
    const term = search.trim();
    if (!term) {
      setSearchHits([]);
      setSearching(false);
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setSearching(true);
      try {
        const result = await api.appServer.request("thread/search", {
          searchTerm: term,
          limit: 50,
          archived: false,
        });
        if (!cancelled) setSearchHits(Array.isArray(result?.data) ? result.data : []);
      } catch {
        if (!cancelled) setSearchHits([]);
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 280);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [search]);
  const closeTimer = React.useRef<number | null>(null);
  const cancelPopupClose = () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
  };
  const schedulePopupClose = () => {
    cancelPopupClose();
    closeTimer.current = window.setTimeout(() => setHoveredProject(null), 140);
  };
  const openThreadPopup = (event: React.MouseEvent<HTMLElement>, threadId: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setThreadPopupPosition({ top: rect.top, left: rect.right + 3 });
    setHoveredThread(threadId);
  };
  const toggleProjectPin = (key: string) => {
    setPinnedProjects((old) => {
      const next = new Set(old);
      next.has(key) ? next.delete(key) : next.add(key);
      try { localStorage.setItem('local-codex:pinned-projects', JSON.stringify([...next])); } catch { /* best effort */ }
      return next;
    });
  };
  const toggleThreadPin = (threadId: string) => {
    setPinnedThreads((old) => {
      const next = new Set(old);
      next.has(threadId) ? next.delete(threadId) : next.add(threadId);
      try { localStorage.setItem('local-codex:pinned-threads', JSON.stringify([...next])); } catch { /* best effort */ }
      return next;
    });
  };
  const openProjectPopup = (
    event: React.SyntheticEvent<HTMLElement>,
    key: string,
  ) => {
    cancelPopupClose();
    const rect = event.currentTarget.getBoundingClientRect();
    setPopupPosition({ top: rect.top, left: rect.right + 3 });
    setHoveredProject(key);
  };
  const navigate = (label: string) => {
    setActiveNav(label);
    onNavigate(label);
  };
  React.useEffect(() => {
    if (!headerMenu) return undefined;
    const onDoc = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest(".codex-sidebar-top, .sidebar-header-menu, .sidebar-collab-popup")) return;
      setHeaderMenu(null);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setHeaderMenu(null);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [headerMenu]);
  function focusThreadSearch() {
    setHeaderMenu(null);
    const input = searchRef.current;
    input?.scrollIntoView({ block: "nearest" });
    input?.focus();
    input?.select();
  }
  async function loadCollabModes() {
    const extras: CollaborationModeOption[] = [];
    try {
      const result = await api.appServer.request("collaborationMode/list", {});
      const listed = Array.isArray(result?.data) ? result.data : Array.isArray(result) ? result : [];
      for (const item of listed) {
        if (productModeFromServer(item)) continue;
        extras.push({
          name: String(item.name || item.id || item.mode || "协作模式"),
          mode: String(item.mode || item.id || ""),
          sub: [item.mode, item.reasoning_effort, item.description].filter(Boolean).join(" · ") || "默认设置",
        });
      }
    } catch {
      /* product modes still remain available */
    }
    setCollabModes([...PRODUCT_COLLAB_MODES, ...extras]);
  }
  function selectCollabMode(option: CollaborationModeOption) {
    const product =
      option.name === "普通" || option.name === "计划" || option.name === "协作"
        ? option.name
        : productModeFromServer(option) || "协作";
    onSelectCollabMode?.(product);
    setHeaderMenu(null);
  }
  async function toggleCollab(event: React.MouseEvent<HTMLButtonElement>) {
    if (headerMenu === "collab") {
      setHeaderMenu(null);
      return;
    }
    const rect = event.currentTarget.getBoundingClientRect();
    setCollabPos({ top: rect.bottom + 6, left: Math.max(8, Math.min(rect.left, window.innerWidth - 360)) });
    setHeaderMenu("collab");
    await loadCollabModes();
  }
  const groups = useMemo(() => {
    // Archived conversations are managed from Settings and never belong in
    // the active navigation tree, even when an old preference is present.
    const visible = threads.filter((thread) => !thread.archived);
    const projectGroups = projects.map((project, order) => ({
      key: `project:${project.path}`,
      id: project.id || "",
      name: project.name === "agent" ? "Agent" : project.name,
      path: project.path,
      gitOrigin: project.gitOrigin || "",
      threads: [] as Thread[],
      recent: false,
      section: false,
      order,
    }));
    const sectionGroups = sections.map((section) => ({
      key: `section:${section.id}`,
      name: section.name,
      path: "",
      threads: [] as Thread[],
      recent: true,
      section: true,
    }));
    const recent: Thread[] = [];
    for (const thread of visible) {
      if (thread.section?.id || thread.section?.name) {
        const section = sectionGroups.find(
          (item) =>
            item.key === `section:${thread.section?.id}` ||
            item.name === thread.section?.name,
        );
        if (section) {
          section.threads.push(thread);
          continue;
        }
      }
      if (thread.projectId === null) {
        recent.push(thread);
        continue;
      }
      const cwd = canonicalPath(String(thread.cwd || ""));
      const assignedProject = thread.projectId
        ? projectGroups.find((item) => item.id && item.id === String(thread.projectId))
        : undefined;
      const cwdProject = projectGroups
        .filter((item) => {
          const roots = [item.path, ...((projects.find((project) => project.path === item.path)?.rootPaths) || [])]
            .map((root) => canonicalPath(root));
          return cwd && roots.some((root) => cwd === root || cwd.startsWith(`${root}/`));
        })
        .sort((a, b) => b.path.length - a.path.length)[0];
      const threadOrigin = canonicalRemote(
        String(thread.gitInfo?.originUrl || thread.gitInfo?.origin_url || ""),
      );
      const originProject = threadOrigin
        ? projectGroups.find(
            (item) =>
              canonicalRemote(String(item.gitOrigin || "")) === threadOrigin,
          )
        : undefined;
      const project = assignedProject || originProject || cwdProject;
      if (project) project.threads.push(thread);
      else recent.push(thread);
    }
    const recency = (thread?: Thread) =>
      Number(thread?.recencyAt || thread?.updatedAt || thread?.createdAt || 0);
    const sortRecent = (list: Thread[]) =>
      list.sort((a, b) => Number(pinnedThreads.has(b.id)) - Number(pinnedThreads.has(a.id)) || recency(b) - recency(a));
    projectGroups.forEach((group) => sortRecent(group.threads));
    sectionGroups.forEach((group) => sortRecent(group.threads));
    sortRecent(recent);
    projectGroups.sort((a, b) => {
      const pinnedOrder = Number(pinnedProjects.has(b.key)) - Number(pinnedProjects.has(a.key));
      return pinnedOrder || recency(b.threads[0]) - recency(a.threads[0]) || a.order - b.order;
    });
    return [
      ...projectGroups,
      ...sectionGroups.filter((group) => group.threads.length > 0),
      ...(recent.length
        ? [
            {
              key: "recent",
              name: "最近",
              path: "",
              threads: recent,
              recent: true,
              section: false,
              order: Number.MAX_SAFE_INTEGER,
            },
          ]
        : []),
    ];
  }, [threads, projects, sections, pinnedProjects, pinnedThreads]);
  const searchNeedle = search.trim().toLowerCase();
  const searchResults = useMemo(() => {
    if (!searchNeedle) return [];
    const byId = new Map<string, { thread: Thread; snippet: string }>();
    for (const thread of threads) {
      if (thread.archived) continue;
      const haystack = [titleOf(thread), thread.preview, thread.cwd].filter(Boolean).join(" ").toLowerCase();
      if (haystack.includes(searchNeedle)) byId.set(thread.id, { thread, snippet: String(thread.preview || "") });
    }
    for (const hit of searchHits) {
      const thread = (hit.thread || hit) as Thread;
      if (!thread?.id) continue;
      const existing = byId.get(thread.id);
      byId.set(thread.id, { thread: existing?.thread || thread, snippet: hit.snippet || existing?.snippet || "" });
    }
    return [...byId.values()];
  }, [searchNeedle, threads, searchHits]);

  return (
    <aside className="codex-sidebar">
      <div className="codex-sidebar-top">
        <button
          type="button"
          className={`codex-brand ${headerMenu === "brand" ? "open" : ""}`}
          title="Local Codex"
          aria-haspopup="menu"
          aria-expanded={headerMenu === "brand"}
          onClick={() => setHeaderMenu((value) => (value === "brand" ? null : "brand"))}
        >
          Codex <UiIcon icon={icons.down} />
        </button>
        <div className="sidebar-tools">
          <button type="button" title="搜索线程" className={search ? "active" : ""} onClick={focusThreadSearch}>
            <UiIcon icon={icons.search} />
          </button>
          <button type="button" title="协作" className={headerMenu === "collab" ? "active" : ""} onClick={(event) => void toggleCollab(event)}>
            <UiIcon icon={icons.nodes} />
          </button>
        </div>
        {headerMenu === "brand" && (
          <div className="sidebar-header-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setHeaderMenu(null); onNew(); }}>新对话</button>
            <button type="button" role="menuitem" onClick={() => { setHeaderMenu(null); onOpenSettings(); }}>设置</button>
            <button type="button" role="menuitem" onClick={() => { setHeaderMenu(null); onOpenHelp?.(); }}>帮助</button>
            <button type="button" role="menuitem" onClick={() => { setHeaderMenu(null); onOpenAbout?.(); }}>关于</button>
          </div>
        )}
      </div>
      {headerMenu === "collab" && collabPos && (
        <div className="sidebar-collab-popup" role="dialog" aria-label="协作" style={{ top: collabPos.top, left: collabPos.left }}>
          <CollaborationPanel
            modes={collabModes}
            items={collabItems}
            currentMode={currentMode}
            onRefresh={() => void loadCollabModes()}
            onSelectMode={selectCollabMode}
          />
        </div>
      )}
      <nav className="codex-nav">
        <button
          className={!currentId && activeNav === "新对话" ? "active" : ""}
          onClick={() => {
            setActiveNav("新对话");
            onNew();
          }}
        >
          <UiIcon icon={icons.compose} /> <span>新对话</span>
        </button>
        <button
          className={activeNav === "插件" ? "active" : ""}
          onClick={() => navigate("插件")}
        >
          <UiIcon icon={icons.puzzle} /> <span>插件</span>
        </button>
        <button
          className={activeNav === "自动化" ? "active" : ""}
          onClick={() => navigate("自动化")}
        >
          <UiIcon icon={icons.clock} /> <span>自动化</span>
        </button>
        <button
          className={activeNav === "Git" ? "active" : ""}
          onClick={() => navigate("Git")}
        >
          <UiIcon icon={icons.commit} /> <span>Git</span>
        </button>
        {gitlabAvailable && (
          <button
            className={activeNav === "GitLab" ? "active" : ""}
            onClick={() => navigate("GitLab")}
          >
            <UiIcon icon={icons.merge} /> <span>GitLab</span>
          </button>
        )}
        {githubAvailable && (
          <button
            className={activeNav === "GitHub" ? "active" : ""}
            onClick={() => navigate("GitHub")}
          >
            <UiIcon icon={icons.branch} /> <span>GitHub</span>
          </button>
        )}
      </nav>
      <div className={`codex-search-wrap${searchFocused ? " focused" : ""}`}>
        <input
          ref={searchRef}
          className="codex-search"
          value={search}
          onFocus={() => setSearchFocused(true)}
          onBlur={() => setSearchFocused(false)}
          onChange={(event) => onSearch(event.target.value)}
          placeholder="搜索标题和对话内容…"
        />
      </div>
      {searchNeedle ? (
        <div className="codex-search-results">
          <div className="codex-section-label">{searching ? "正在搜索…" : `${searchResults.length} 个结果`}</div>
          {searchResults.length === 0 && !searching && <div className="codex-search-empty">没有匹配的线程</div>}
          {searchResults.map(({ thread, snippet }) => (
            <div className={`codex-thread-wrap${thread.id === currentId ? " active" : ""}`} key={thread.id}>
              <button
                className="codex-task search-hit"
                data-thread-id={thread.id}
                onClick={() => {
                  setActiveNav("新对话");
                  onSelect(thread.id);
                }}
              >
                {threadIsRunning(thread) && <span className="task-dot" />}
                <span>
                  <strong>{titleOf(thread)}</strong>
                  {snippet ? <small>{snippet}</small> : null}
                </span>
              </button>
            </div>
          ))}
        </div>
      ) : (
      <>
      <div className="codex-section-label">项目</div>
      <div className="codex-projects">
        {groups.length === 0 && (
          <button className="codex-task active" onClick={onNew}>
            开始一个新对话
          </button>
        )}
        {groups.map((group) => {
          const collapsed = collapsedProjects.has(group.key);
          const expanded = expandedGroups.has(group.key);
          const shownThreads = expanded
            ? group.threads
            : group.threads.slice(0, 5);
          const openCount = group.threads.filter(threadIsRunning).length;
          return (
            <section
              className={`project-section ${collapsed ? "collapsed" : ""} ${group.recent ? "recent-section" : ""}`}
              key={group.key}
            >
              <div
                className="project-heading"
                aria-expanded={!collapsed}
                role="button"
                tabIndex={0}
                onMouseEnter={(event) =>
                  !group.recent && openProjectPopup(event, group.key)
                }
                onMouseLeave={schedulePopupClose}
                onFocus={(event) =>
                  !group.recent && openProjectPopup(event, group.key)
                }
                onClick={() =>
                  setCollapsedProjects((old) => {
                    const next = new Set(old);
                    if (next.has(group.key)) next.delete(group.key);
                    else next.add(group.key);
                    return next;
                  })
                }
                onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setCollapsedProjects((old) => { const next = new Set(old); next.has(group.key) ? next.delete(group.key) : next.add(group.key); return next; }); } }}
              >
                {!group.recent && (
                  <UiIcon icon={collapsed ? icons.folder : icons.folderOpen} />
                )}{" "}
                <span>{group.name}</span>
                {!group.recent && hoveredProject === group.key && <span className="project-heading-actions"><button type="button" title="在此项目中新建对话" onClick={(event) => { event.stopPropagation(); void onQuickNewProject?.(group.path); }}><UiIcon icon={icons.compose} /></button><button type="button" title="项目快捷菜单" onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setProjectMenu(group.key); setProjectMenuPosition({ top: rect.bottom + 3, left: Math.max(6, rect.right - 180) }); }}><UiIcon icon={icons.more} /></button></span>}
                {!group.recent && (
                  <UiIcon
                    className="project-chevron"
                    icon={collapsed ? icons.right : icons.down}
                  />
                )}
              </div>
              {hoveredProject === group.key &&
                !group.recent &&
                popupPosition && (
                  <div
                    className="project-popup"
                    style={{ top: popupPosition.top, left: popupPosition.left }}
                    onMouseEnter={cancelPopupClose}
                    onMouseLeave={schedulePopupClose}
                  >
                    <div className="project-popup-title">
                      <UiIcon icon={icons.folderOpen} />
                      <strong>{group.name}</strong>
                      <UiIcon className="project-popup-pin" icon={icons.pin} />
                    </div>
                    <div className="project-popup-row">
                      <UiIcon icon={icons.comments} />
                      <span>
                        {group.threads.length} 个任务 · {openCount} 个已开启
                      </span>
                    </div>
                    <div className="project-popup-row">
                      <UiIcon icon={icons.folder} />
                      <span title={group.path}>{group.path}</span>
                    </div>
                    <button
                      className="project-popup-edit"
                      onClick={() => {
                        setHoveredProject(null);
                        void onEditProject?.(group.path);
                      }}
                    >
                      <UiIcon icon={icons.gear} /> 编辑项目
                    </button>
                  </div>
                )}
              {projectMenu === group.key && projectMenuPosition && <div className="project-quick-menu" style={{ top: projectMenuPosition.top, left: projectMenuPosition.left }} onMouseEnter={cancelPopupClose} onMouseLeave={() => { setProjectMenu(null); schedulePopupClose(); }}><button type="button" onClick={() => { toggleProjectPin(group.key); setProjectMenu(null); }}>{<UiIcon icon={icons.pin} />}<span>{pinnedProjects.has(group.key) ? '取消置顶' : '置顶'}</span></button><button type="button" onClick={() => { setProjectMenu(null); setHoveredProject(null); void onEditProject?.(group.path); }}><UiIcon icon={icons.compose} /><span>编辑</span></button><div className="project-quick-menu-separator" /><button type="button" onClick={() => { setProjectMenu(null); void onOpenProjectRoot?.(group.path); }}><UiIcon icon={icons.folderOpen} /><span>在资源管理器中打开</span></button><button type="button" onClick={() => { setProjectMenu(null); void onOpenProjectInVscode?.(group.path); }}><UiIcon icon={icons.code} /><span>用 VS Code 打开</span></button><button type="button" onClick={() => { setProjectMenu(null); void onCreateProjectWorktree?.(group.path); }}><UiIcon icon={icons.external} /><span>创建永久工作树</span></button><div className="project-quick-menu-separator" /><button type="button" onClick={() => { setProjectMenu(null); group.threads.forEach((thread) => onThreadAction('archive', thread)); }}><UiIcon icon={icons.fileArchive} /><span>归档聊天</span></button><div className="project-quick-menu-separator" /><button type="button" className="danger" onClick={() => { setProjectMenu(null); void onRemoveProject?.(group.path); }}><UiIcon icon={icons.close} /><span>移除项目</span></button></div>}
              {!collapsed &&
                shownThreads.map((thread) => (
                  <div
                    className={`codex-thread-wrap${thread.id === currentId ? " active" : ""}`}
                    key={thread.id}
                    onMouseEnter={(event) => openThreadPopup(event, thread.id)}
                    onMouseLeave={() => setHoveredThread(null)}
                  >
                    <button
                      className="codex-task"
                      data-thread-id={thread.id}
                      data-thread-cwd={thread.cwd || ""}
                      onClick={() => {
                        setActiveNav("新对话");
                        onSelect(thread.id);
                      }}
                    >
                      {threadIsRunning(thread) && <span className="task-dot" />}
                      {thread.ephemeral && <span className="thread-temp-badge">临时</span>}
                      {titleOf(thread)}
                      {((threadIsRunning(thread) && thread.id === currentId) ||
                        thread.id === loadingId) && (
                        <span className="thread-loading" />
                      )}
                    </button>
                    <span className={`thread-hover-actions ${hoveredThread === thread.id ? "visible" : ""}`}><button type="button" title={pinnedThreads.has(thread.id) ? "取消置顶线程" : "置顶线程"} className={pinnedThreads.has(thread.id) ? "active" : ""} onClick={(event) => { event.stopPropagation(); toggleThreadPin(thread.id); }}><UiIcon icon={icons.pin} /></button><button type="button" title="归档线程" onClick={(event) => { event.stopPropagation(); onThreadAction("archive", thread); }}><UiIcon icon={icons.fileArchive} /></button></span>
                    {hoveredThread === thread.id && threadPopupPosition && <div className="thread-summary-popup" style={{ top: threadPopupPosition.top, left: threadPopupPosition.left }} onMouseEnter={() => setHoveredThread(thread.id)}><div className="thread-summary-head"><strong>{titleOf(thread)}</strong><span>{formatThreadDuration(thread)}</span></div><div className="thread-summary-row"><UiIcon icon={icons.folder} /><span>{group.name}</span></div><div className="thread-summary-row"><UiIcon icon={icons.folderOpen} /><span title={String(thread.cwd || group.path || "")}>{String(thread.cwd || group.path || "未选择工作区")}</span></div></div>}
                  </div>
                ))}
              {!collapsed && group.threads.length > 5 && (
                <button
                  className="show-more-threads"
                  onClick={() =>
                    setExpandedGroups((old) => {
                      const next = new Set(old);
                      if (next.has(group.key)) next.delete(group.key);
                      else next.add(group.key);
                      return next;
                    })
                  }
                >
                  {expanded ? "收起" : "展开显示"}
                </button>
              )}
            </section>
          );
        })}
        {currentId && (
          <button className="codex-task dim" onClick={onMoveCurrentToSection}>
            <UiIcon icon={icons.folder} /> 移动到分区
          </button>
        )}
      </div>
      </>
      )}
      <div className="codex-sidebar-foot">
        <button
          className="sidebar-settings-button"
          title="设置"
          onClick={onOpenSettings}
        >
          <UiIcon icon={icons.gear} /> <span>{profileName}</span>
        </button>
        <button
          className="download-dot"
          title="导出当前线程"
          disabled={!currentId || !onExportCurrent}
          onClick={() =>
            void onExportCurrent?.()
              .then((message) => dialog.alert("导出", message))
              .catch((error) => dialog.alert("导出失败", String(error)))
          }
        >
          <UiIcon icon={icons.download} />
        </button>
      </div>
      {dialog.node}
    </aside>
  );
}
