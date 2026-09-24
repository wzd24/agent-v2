import { convertFileSrc } from "@tauri-apps/api/core";
import React from "react";
import {
  api,
  GitBranch,
  GitHostRepoCheck,
  GitLabProject,
  GitRepo,
  GitSnapshot,
  GitTag,
} from "../api";
import { useCoverBrowser } from "../coverBrowser";
import { AppDialog, AppDialogOption, useAppDialog } from "./AppDialog";
import { ContextMenu, ContextMenuItem, hasContextActions } from "./ContextMenu";
import { parseUnifiedDiff } from "./DiffReviewPanel";
import { GitGraph, GraphCommit } from "./GitGraph";
import { MonacoFileEditor } from "./MonacoFileEditor";
import { ConfigFilePreview, isMarkdownPath, MarkdownFilePreview, StructuredPreview } from "./WorkspacePanel";
import { isConfigPreviewPath } from "../monacoLanguage";
import { icons, UiIcon } from "./UiIcon";

type FileKind = "text" | "markdown" | "image" | "structured" | "video" | "audio" | "binary";
type PaneKey = "welcome" | "file" | "changes" | "branches" | "remotes" | "stash" | "tags" | "output" | "graph";
type TreeEntry = { name: string; type: "directory" | "file"; children?: TreeEntry[] | null };
type MenuTarget = { x: number; y: number; path: string; type: "file" | "directory" | "repo" | "blank" };
type RemoteSource = "custom" | "github" | "gitlab";
type DialogKind =
  | null
  | "checkout"
  | "deleteRemote"
  | "deleteBranch"
  | "deleteTag"
  | "newFile"
  | "newFolder"
  | "renameFile"
  | "deleteFile"
  | "commit"
  | "createBranch"
  | "createTag"
  | "stash"
  | "pullFrom"
  | "pushTo"
  | "merge"
  | "rebase"
  | "createBranchFrom"
  | "renameBranch"
  | "deleteRemoteBranch"
  | "deleteRemoteTag"
  | "stashPick"
  | "createBranchStart";
type LogItem = { id: number; title: string; ok: boolean; text: string };

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error || "操作失败");
}

function changeLabel(code: string) {
  const index = code[0] || " ";
  const work = code[1] || " ";
  if (code.includes("?")) return "未跟踪";
  if (index === "D" || work === "D") return "删除";
  if (index === "A" || work === "A") return "新增";
  if (index === "R" || work === "R") return "重命名";
  return "修改";
}

function extensionOf(name: string) {
  const base = String(name || "").split(/[\\/]/).pop()?.toLowerCase() || "";
  return base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
}

function kindForPath(path: string): FileKind {
  const extension = extensionOf(path);
  if (/^(png|jpe?g|gif|webp|bmp|svg|ico)$/.test(extension)) return "image";
  if (/^(md|mdx|markdown|mdc|mkd)$/.test(extension)) return "markdown";
  if (/^(pdf|docx|xlsx|xls|csv|pptx|ppt|odt|ods|odp|ipynb)$/.test(extension)) return "structured";
  if (/^(mp4|webm|ogv|mov|mkv)$/.test(extension)) return "video";
  if (/^(mp3|wav|ogg|flac|m4a|aac)$/.test(extension)) return "audio";
  if (/^(exe|dll|so|dylib|bin|o|obj|class|wasm|zip|rar|7z|tar|gz|bz2|xz|iso|dmg|apk|ipa|pdb|lib|a|woff2?|ttf|eot|otf)$/.test(extension)) return "binary";
  return "text";
}

function mediaSrc(filePath: string) {
  if (!filePath) return "";
  const variants = [filePath, filePath.replace(/\\/g, "/"), filePath.replace(/\//g, "\\")];
  for (const variant of [...new Set(variants)]) {
    try {
      const src = convertFileSrc(variant);
      if (src) return src;
    } catch {
      /* try the next path form */
    }
  }
  return "";
}

function looksBinary(text: string) {
  if (!text) return false;
  const sample = text.slice(0, 8000);
  if (sample.includes("\u0000")) return true;
  const replacement = (sample.match(/\uFFFD/g) || []).length;
  return replacement > 8 && replacement / sample.length > 0.02;
}

function fileIconForName(name: string) {
  const base = String(name || "").split(/[\\/]/).pop()?.toLowerCase() || "";
  const extension = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  if (/^(png|jpe?g|gif|webp|bmp|svg|ico)$/.test(extension)) return icons.fileImage;
  if (/^(ts|tsx|js|jsx|mjs|cjs|go|rs|py|java|c|cpp|h|hpp|css|scss|less|html|vue|svelte)$/.test(extension)) return icons.fileCode;
  if (/^(json|yaml|yml|toml|ini|env|conf|config|xml|md|txt|log)$/.test(extension)) return icons.fileLines;
  if (extension === "pdf") return icons.filePdf;
  if (/^(zip|rar|7z|tar|gz)$/.test(extension)) return icons.fileArchive;
  return icons.file;
}

function matchesQuery(query: string, ...parts: Array<string | undefined>) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return parts.join(" ").toLowerCase().includes(needle);
}

function sameRepoPath(left?: string, right?: string) {
  return String(left || "").replace(/[\\/]+$/, "").toLowerCase() === String(right || "").replace(/[\\/]+$/, "").toLowerCase();
}

function sameChangePath(left?: string, right?: string) {
  const a = String(left || "").replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  const b = String(right || "").replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  return Boolean(a && b && (a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`)));
}

const CHANGES_DIFF_HEIGHT_KEY = "local-codex:git-changes-diff-height";
const GRAPH_DIFF_HEIGHT_KEY = "local-codex:git-graph-diff-height";

function readStoredHeight(key: string) {
  try {
    const value = Number(window.localStorage.getItem(key));
    if (Number.isFinite(value) && value >= 120) return Math.round(value);
  } catch { /* storage can be disabled */ }
  return 0;
}

function writeStoredHeight(key: string, value: number) {
  try {
    if (value > 0) window.localStorage.setItem(key, String(value));
    else window.localStorage.removeItem(key);
  } catch { /* storage can be disabled */ }
}

function pathSep(value: string) {
  return value.includes("/") && !value.includes("\\") ? "/" : "\\";
}

function joinTreePath(parent: string, name: string) {
  const root = String(parent || "").replace(/[\\/]+$/, "");
  return `${root}${pathSep(root)}${name}`;
}

function parentOf(path: string, fallback = "") {
  const value = String(path || "").replace(/[\\/]+$/, "");
  const index = Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/"));
  return index > 0 ? value.slice(0, index) : fallback;
}

function repoForPath(path: string, items: GitRepo[]) {
  const target = String(path || "").replace(/[\\/]+$/, "").toLowerCase();
  let best: GitRepo | undefined;
  for (const repo of items) {
    const root = repo.path.replace(/[\\/]+$/, "").toLowerCase();
    if (target === root || target.startsWith(`${root}\\`) || target.startsWith(`${root}/`)) {
      if (!best || repo.path.length > best.path.length) best = repo;
    }
  }
  return best;
}

function replaceTreeChildren(nodes: TreeEntry[], parent: string, directory: string, children: TreeEntry[]): TreeEntry[] {
  if (sameRepoPath(parent, directory)) return children;
  return nodes.map((node) => {
    if (node.type !== "directory") return node;
    const path = joinTreePath(parent, node.name);
    if (sameRepoPath(path, directory)) return { ...node, children };
    if (Array.isArray(node.children)) return { ...node, children: replaceTreeChildren(node.children, path, directory, children) };
    return node;
  });
}

function filterTree(nodes: TreeEntry[], parent: string, query: string): TreeEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return nodes;
  return nodes.reduce<TreeEntry[]>((acc, node) => {
    const path = joinTreePath(parent, node.name);
    const children = node.type === "directory" ? filterTree(node.children || [], path, query) : [];
    if (node.name.toLowerCase().includes(needle) || children.length) acc.push({ ...node, children: node.type === "directory" ? children : node.children });
    return acc;
  }, []);
}

export function GitView({
  workspaceRoot,
  gitlabConfigured,
  githubConfigured,
  onOpenSettings,
  onRemotesChanged,
  onOpenCloneWorkspace,
}: {
  workspaceRoot: string;
  gitlabConfigured?: boolean;
  githubConfigured?: boolean;
  onOpenSettings: () => void;
  onRemotesChanged?: () => void;
  onOpenCloneWorkspace?: (root: string) => void | Promise<void>;
}) {
  const confirm = useAppDialog();
  const [pane, setPane] = React.useState<PaneKey>("welcome");
  const [repoEntries, setRepoEntries] = React.useState<Record<string, TreeEntry[]>>({});
  const [expanded, setExpanded] = React.useState<Set<string>>(new Set());
  const [treeQuery, setTreeQuery] = React.useState("");
  const [treeTick, setTreeTick] = React.useState(0);
  const [menu, setMenu] = React.useState<MenuTarget | null>(null);
  const [filePath, setFilePath] = React.useState("");
  const [fileContent, setFileContent] = React.useState("");
  const [fileKind, setFileKind] = React.useState<FileKind>("text");
  const [filePreview, setFilePreview] = React.useState<Record<string, any> | undefined>(undefined);
  const [fileMediaSrc, setFileMediaSrc] = React.useState("");
  const [fileError, setFileError] = React.useState("");
  const [fileView, setFileView] = React.useState<"view" | "edit">("view");
  const [fileRender, setFileRender] = React.useState<"preview" | "source">("preview");
  const [fileLoading, setFileLoading] = React.useState(false);
  const [editSaving, setEditSaving] = React.useState(false);
  const [editMenuOpen, setEditMenuOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [repos, setRepos] = React.useState<GitRepo[]>([]);
  const [selectedRepo, setSelectedRepo] = React.useState("");
  const [snapshot, setSnapshot] = React.useState<GitSnapshot | null>(null);
  const [snapshots, setSnapshots] = React.useState<Record<string, GitSnapshot>>({});
  const [branches, setBranches] = React.useState<GitBranch[]>([]);
  const [tags, setTags] = React.useState<GitTag[]>([]);
  const [stashes, setStashes] = React.useState<Array<{ label: string }>>([]);
  const [loading, setLoading] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [logs, setLogs] = React.useState<LogItem[]>([]);
  const [openDialog, setOpenDialog] = React.useState<DialogKind>(null);
  const [draft, setDraft] = React.useState("");
  const [dialogError, setDialogError] = React.useState("");
  const [targetName, setTargetName] = React.useState("");
  const [dialogCwd, setDialogCwd] = React.useState("");
  const [dialogMode, setDialogMode] = React.useState("");
  const [dialogOptions, setDialogOptions] = React.useState<AppDialogOption[] | undefined>(undefined);
  const [addRemoteOpen, setAddRemoteOpen] = React.useState(false);
  const [remoteSource, setRemoteSource] = React.useState<RemoteSource>("custom");
  const [remoteName, setRemoteName] = React.useState("origin");
  const [remoteUrl, setRemoteUrl] = React.useState("");
  const [remoteProtocol, setRemoteProtocol] = React.useState<"https" | "ssh">("https");
  const [overwriteRemote, setOverwriteRemote] = React.useState(false);
  const [hostedProjects, setHostedProjects] = React.useState<GitLabProject[]>([]);
  const [hostedQuery, setHostedQuery] = React.useState("");
  const [hostedBusy, setHostedBusy] = React.useState(false);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createName, setCreateName] = React.useState("");
  const [createOwner, setCreateOwner] = React.useState("");
  const [createDescription, setCreateDescription] = React.useState("");
  const [createPrivate, setCreatePrivate] = React.useState(true);
  const [createReadme, setCreateReadme] = React.useState(false);
  const [createCheck, setCreateCheck] = React.useState<GitHostRepoCheck | null>(null);
  const [createMessage, setCreateMessage] = React.useState("");
  const [cloneOpen, setCloneOpen] = React.useState(false);
  const [cloneUrl, setCloneUrl] = React.useState("");
  const [cloneParent, setCloneParent] = React.useState("");
  const [cloneName, setCloneName] = React.useState("");
  const [cloneShallow, setCloneShallow] = React.useState(false);
  const [clonePath, setClonePath] = React.useState("");
  const [diffText, setDiffText] = React.useState("");
  const [commitDraft, setCommitDraft] = React.useState("");
  const [commitMode, setCommitMode] = React.useState("commit");
  const [commitError, setCommitError] = React.useState("");
  const [commitGenerating, setCommitGenerating] = React.useState(false);
  const [pushReady, setPushReady] = React.useState(false);
  const commitGenRef = React.useRef(0);
  const [selectedChange, setSelectedChange] = React.useState("");
  const [collapsedDiffs, setCollapsedDiffs] = React.useState<Set<string>>(new Set());
  const [changesDiffHeight, setChangesDiffHeight] = React.useState(() => readStoredHeight(CHANGES_DIFF_HEIGHT_KEY));
  const [graphDiffHeight, setGraphDiffHeight] = React.useState(() => readStoredHeight(GRAPH_DIFF_HEIGHT_KEY));
  const [changesDiffMaximized, setChangesDiffMaximized] = React.useState(false);
  const [graphItems, setGraphItems] = React.useState<GraphCommit[]>([]);
  const [graphRef, setGraphRef] = React.useState("");
  const [graphRemotes, setGraphRemotes] = React.useState(true);
  const [graphLimit, setGraphLimit] = React.useState(300);
  const [graphHasMore, setGraphHasMore] = React.useState(false);
  const [graphShallow, setGraphShallow] = React.useState(false);
  const [graphCommit, setGraphCommit] = React.useState<GraphCommit | null>(null);
  const [graphDiff, setGraphDiff] = React.useState("");
  const commitRef = React.useRef<HTMLTextAreaElement>(null);
  const [cloneMessage, setCloneMessage] = React.useState("");
  useCoverBrowser(addRemoteOpen || cloneOpen);

  const log = React.useCallback((title: string, ok: boolean, text: string) => {
    const detail = String(text || "").trim();
    setLogs((old) => [{ id: Date.now() + Math.random(), title, ok, text: detail || (ok ? "完成" : "失败") }, ...old].slice(0, 80));
    setMessage(detail || (ok ? `${title}完成` : `${title}失败`));
  }, []);

  const repoRoot = selectedRepo || workspaceRoot;
  const selectedMeta = repos.find((item) => sameRepoPath(item.path, repoRoot));
  const fileName = filePath.split(/[\\/]/).pop() || "";
  const workspaceName = workspaceRoot.split(/[\\/]/).filter(Boolean).pop() || "工作区";
  const treeRoots = repos.length > 0
    ? repos
    : workspaceRoot
      ? [{ path: workspaceRoot, name: workspaceName, relativePath: "", branch: "", upstream: "", ahead: 0, behind: 0, changes: 0, dirty: false } as GitRepo]
      : [];

  const gitAt = React.useCallback((cwd?: string) => {
    const root = cwd || selectedRepo || workspaceRoot;
    return {
      snapshot: () => api.git.snapshot(root),
      remotes: () => api.git.remotes(root),
      branches: () => api.git.branches(root),
      tags: () => api.git.tags(root),
      stashList: () => api.git.stashList(root),
      checkout: (name: string) => api.git.checkout(name, root),
      removeRemote: (name: string) => api.git.removeRemote(name, root),
      deleteBranch: (name: string, force?: boolean) => api.git.deleteBranch(name, force, root),
      deleteTag: (name: string) => api.git.deleteTag(name, root),
      clone: api.git.clone,
      setRemoteUrl: (name: string, url: string) => api.git.setRemoteUrl(name, url, root),
      addRemote: (name: string, url: string) => api.git.addRemote(name, url, root),
      applyPatch: (patch: string) => api.git.applyPatch(patch, root),
      createPatch: (kind: "staged" | "unstaged" | "all") => api.git.createPatch(kind, root),
      pull: (remote?: string, rebase?: boolean) => api.git.pull(remote, rebase, root),
      pushTo: (remote?: string, setUpstream?: boolean) => api.git.pushTo(remote, setUpstream, root),
      fetch: (remote?: string, options?: { all?: boolean; prune?: boolean }) => api.git.fetch(remote, options, root),
      init: () => api.git.init(root),
      commit: (message: string, options?: { all?: boolean; amend?: boolean; signoff?: boolean; sign?: boolean }) => api.git.commit(message, options, root),
      undoCommit: () => api.git.undoCommit(root),
      abortRebase: () => api.git.abortRebase(root),
      stageAll: () => api.git.stageAll(root),
      unstageAll: () => api.git.unstageAll(root),
      discardAll: () => api.git.discardAll(root),
      restoreFile: (filePath: string) => api.git.restoreFile(filePath, root),
      createBranch: (name: string, checkout?: boolean, start?: string) => api.git.createBranch(name, checkout, root, start),
      merge: (name: string) => api.git.merge(name, root),
      rebase: (name: string) => api.git.rebase(name, root),
      renameBranch: (name: string) => api.git.renameBranch(name, root),
      deleteRemoteBranch: (name: string, remote?: string) => api.git.deleteRemoteBranch(name, remote, root),
      publishBranch: (remote?: string) => api.git.publishBranch(remote, root),
      stash: (message?: string, options?: { includeUntracked?: boolean; staged?: boolean }) => api.git.stash(message, options, root),
      stashPop: (target?: string) => api.git.stashPop(target, root),
      stashApply: (target?: string) => api.git.stashApply(target, root),
      stashDrop: (target?: string) => api.git.stashDrop(target, root),
      stashClear: () => api.git.stashClear(root),
      stashShow: (target?: string) => api.git.stashShow(target, root),
      createTag: (name: string, message?: string) => api.git.createTag(name, message, root),
      pushTags: (remote?: string) => api.git.pushTags(remote, root),
      deleteRemoteTag: (name: string, remote?: string) => api.git.deleteRemoteTag(name, remote, root),
    };
  }, [selectedRepo, workspaceRoot]);

  const git = React.useMemo(() => gitAt(selectedRepo || workspaceRoot), [gitAt, selectedRepo, workspaceRoot]);

  const loadFolder = React.useCallback(async (dir: string) => {
    const listed = await api.workspace.tree({ root: dir, depth: 0 });
    return (listed.entries || []) as TreeEntry[];
  }, []);

  const refreshTree = React.useCallback(() => setTreeTick((value) => value + 1), []);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const listed = await api.git.listRepos().catch(() => ({ items: [] as GitRepo[] }));
      const items = listed.items || [];
      setRepos(items);
      const target = items.find((item) => sameRepoPath(item.path, selectedRepo)) || items[0];
      setSelectedRepo((current) => {
        if (current && items.some((item) => sameRepoPath(item.path, current))) return current;
        return items[0]?.path || "";
      });
      if (!target) {
        setSnapshot(null);
        setBranches([]);
        setTags([]);
        setStashes([]);
        return;
      }
      const cwd = target.path;
      const [next, nextBranches, nextTags, nextStashes] = await Promise.all([
        api.git.snapshot(cwd),
        api.git.branches(cwd).catch(() => ({ items: [] as GitBranch[] })),
        api.git.tags(cwd).catch(() => ({ items: [] as GitTag[] })),
        api.git.stashList(cwd).catch(() => ({ items: [] as Array<{ label: string }> })),
      ]);
      setSnapshot(next);
      setSnapshots((old) => ({ ...old, [cwd]: next }));
      setBranches(nextBranches.items || []);
      setTags(nextTags.items || []);
      setStashes(nextStashes.items || []);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [selectedRepo, workspaceRoot]);

  React.useEffect(() => {
    setSelectedRepo("");
    setFilePath("");
    setFileContent("");
    setRepoEntries({});
    setExpanded(new Set());
    setSnapshots({});
    setPane("welcome");
    setMessage("");
    setSelectedChange("");
    setCollapsedDiffs(new Set());
    setChangesDiffMaximized(false);
    setCommitDraft("");
    setCommitGenerating(false);
    setPushReady(false);
  }, [workspaceRoot]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  React.useEffect(() => {
    if (!selectedRepo) return;
    setExpanded((current) => {
      if (current.has(selectedRepo)) return current;
      const next = new Set(current);
      next.add(selectedRepo);
      return next;
    });
  }, [selectedRepo]);

  React.useEffect(() => {
    if (pane !== "changes" || !repoRoot) {
      setDiffText("");
      return;
    }
    let cancelled = false;
    void api.git.diff(repoRoot).then((result) => {
      if (!cancelled) setDiffText(result.output || "");
    }).catch(() => {
      if (!cancelled) setDiffText("");
    });
    return () => { cancelled = true; };
  }, [pane, repoRoot, snapshot?.changes, snapshot?.dirty]);

  React.useEffect(() => {
    if (pane !== "changes" || !repoRoot || commitDraft.trim()) return;
    void generateCommitMessage(false, repoRoot);
  }, [pane, repoRoot]);

  React.useEffect(() => {
    if (pane !== "graph" || !repoRoot) {
      return;
    }
    let cancelled = false;
    void api.git.graph({ limit: graphLimit, remotes: graphRemotes, ref: graphRef }, repoRoot).then((result) => {
      if (cancelled) return;
      setGraphItems(result.items || []);
      setGraphHasMore(Boolean(result.hasMore));
      setGraphShallow(Boolean(result.shallow));
      setGraphCommit(null);
      setGraphDiff("");
    }).catch(() => {
      if (!cancelled) setGraphItems([]);
    });
    return () => { cancelled = true; };
  }, [pane, repoRoot, graphLimit, graphRemotes, graphRef]);

  React.useEffect(() => {
    let cancelled = false;
    const roots = repos.length > 0 ? repos.map((item) => item.path) : workspaceRoot ? [workspaceRoot] : [];
    if (!roots.length) {
      setRepoEntries({});
      return undefined;
    }
    void Promise.all(roots.map(async (root) => {
      const tree = await loadFolder(root).catch(() => [] as TreeEntry[]);
      return [root, tree] as const;
    })).then((pairs) => {
      if (!cancelled) setRepoEntries(Object.fromEntries(pairs));
    });
    return () => {
      cancelled = true;
    };
  }, [repos, workspaceRoot, treeTick, loadFolder]);

  function resetOpenedFile() {
    setFilePath("");
    setFileContent("");
    setFileKind("text");
    setFilePreview(undefined);
    setFileMediaSrc("");
    setFileError("");
    setFileView("view");
    setFileRender("preview");
    setEditMenuOpen(false);
  }

  function selectRepo(path: string) {
    if (!path || sameRepoPath(path, selectedRepo)) return;
    setSelectedRepo(path);
  }

  function relatedPane(id: string): PaneKey | undefined {
    if ([
      "commit", "commit-staged", "commit-all", "commit-amend", "commit-amend-staged",
      "commit-amend-all", "commit-signoff", "commit-sign-staged", "commit-sign-all",
      "undo-commit", "abort-rebase", "stage-all", "unstage-all", "discard-all",
      "restore", "patch-staged", "patch-unstaged", "apply-patch",
      "stash", "stash-untracked", "stash-staged",
    ].includes(id)) return "changes";
    if (id.startsWith("stash")) return "stash";
    if ([
      "checkout", "create-branch", "create-branch-from", "rename-branch",
      "merge", "rebase", "delete-branch", "delete-remote-branch", "publish-branch",
    ].includes(id)) return "branches";
    if (id === "add-remote" || id === "delete-remote" || id === "pull-from" || id === "push-to") return "remotes";
    if ([
      "pull", "push", "fetch", "sync", "pull-push", "pull-rebase",
      "push-upstream", "fetch-prune", "fetch-all",
    ].includes(id)) return "output";
    if (id === "create-tag" || id === "delete-tag" || id === "delete-remote-tag" || id === "push-tags") return "tags";
    if (id === "graph") return "graph";
    return undefined;
  }

  function showRelated(id: string, cwd?: string) {
    if (cwd) selectRepo(cwd);
    const next = relatedPane(id);
    if (next) setPane(next);
    if (next === "changes") setSelectedChange("");
  }

  function listedChanges(mode = "") {
    const files = snapshot?.files || [];
    const stagedOnly = mode.includes("staged") || mode === "stash-staged";
    return stagedOnly
      ? files.filter((item) => item.code[0] && item.code[0] !== " " && item.code[0] !== "?")
      : files;
  }

  function changeSummary(mode = "") {
    const listed = listedChanges(mode);
    if (!listed.length) return "当前没有相关更改。";
    const lines = listed.slice(0, 12).map((item) => `${changeLabel(item.code)}  ${item.path}`);
    const more = listed.length > 12 ? `\n还有 ${listed.length - 12} 个文件…` : "";
    return `将处理 ${listed.length} 个文件：\n${lines.join("\n")}${more}`;
  }

  function commitModeLabel(mode = commitMode) {
    if (mode === "commit-staged") return "提交暂存文件";
    if (mode === "commit-all") return "全部提交";
    if (mode === "commit-amend") return "提交(修改)";
    if (mode === "commit-amend-staged") return "提交已暂存文件(修改)";
    if (mode === "commit-amend-all") return "全部提交(修改)";
    if (mode === "commit-signoff") return "提交(签收)";
    if (mode === "commit-sign-staged") return "提交已暂存文件(已署名)";
    if (mode === "commit-sign-all") return "全部提交(已署名)";
    return "提交";
  }

  async function openGraphCommit(sha: string, item?: GraphCommit) {
    setGraphCommit(item || { id: sha });
    const result = await api.git.showCommit(sha, repoRoot);
    if (result.ok === false) {
      setGraphDiff("");
      log("查看提交", false, result.output || "无法读取提交");
      return;
    }
    if (result.commit) setGraphCommit(result.commit);
    setGraphDiff(result.diff || result.output || "");
  }

  function beginDiffResize(event: React.MouseEvent<HTMLDivElement>, key: string, onChange: (height: number) => void) {
    event.preventDefault();
    const panel = event.currentTarget.nextElementSibling as HTMLElement | null;
    if (!panel) return;
    const startY = event.clientY;
    const startH = panel.getBoundingClientRect().height;
    const parentH = panel.parentElement?.clientHeight || window.innerHeight;
    const maxH = Math.max(160, parentH - 148);
    let last = Math.round(startH);
    document.body.style.userSelect = "none";
    document.body.style.cursor = "row-resize";
    const move = (moveEvent: MouseEvent) => {
      last = Math.max(120, Math.min(maxH, Math.round(startH + (startY - moveEvent.clientY))));
      onChange(last);
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      writeStoredHeight(key, last);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop);
  }

  function resetDiffHeight(key: string, onChange: (height: number) => void) {
    onChange(0);
    writeStoredHeight(key, 0);
  }

  function beginInlineCommit(mode = "commit", cwd?: string) {
    if (cwd) selectRepo(cwd);
    setPane("changes");
    setSelectedChange("");
    setCommitMode(mode);
    setCommitError("");
    window.setTimeout(() => commitRef.current?.focus(), 0);
    if (!commitDraft.trim()) void generateCommitMessage(false, cwd || selectedRepo || workspaceRoot);
  }

  async function generateCommitMessage(force = false, cwd = "") {
    const target = cwd || selectedRepo || workspaceRoot;
    if (!target) return;
    const ticket = ++commitGenRef.current;
    setCommitGenerating(true);
    setCommitError("");
    try {
      const result = await api.git.suggestCommit(target);
      if (ticket !== commitGenRef.current) return;
      if (result.ok === false) {
        setCommitError(result.output || "无法生成提交说明");
        return;
      }
      const message = String(result.message || "").trim();
      if (!message) {
        setCommitError("模型没有返回提交说明");
        return;
      }
      setCommitDraft((current) => (force || !current.trim() ? message : current));
    } catch (error) {
      if (ticket !== commitGenRef.current) return;
      setCommitError(errorText(error));
    } finally {
      if (ticket === commitGenRef.current) setCommitGenerating(false);
    }
  }

  async function submitInlineCommit() {
    const text = commitDraft.trim();
    const staged = (snapshot?.files || []).some((item) => item.code[0] && item.code[0] !== " " && item.code[0] !== "?");
    const flags = commitFlags(commitMode || "commit", staged);
    if (!text && !flags.amend) {
      setCommitError("请填写提交说明");
      commitRef.current?.focus();
      return;
    }
    const target = gitAt(repoRoot);
    const result = await runAction(flags.amend ? "提交(修改)" : "提交", () => target.commit(text, flags));
    if (result.ok === false) {
      setCommitError(result.output || "提交失败");
      return;
    }
    commitGenRef.current += 1;
    setCommitDraft("");
    setCommitError("");
    setCommitMode("commit");
    setCommitGenerating(false);
    setPushReady(true);
  }

  async function pushCurrent() {
    const target = gitAt(repoRoot);
    const remotes = snapshot?.remotes || [];
    if (!remotes.length) {
      setCommitError("还没有远端，请先添加远程仓库");
      return;
    }
    const remote = remotes.find((item) => item.name === "origin")?.name || remotes[0].name;
    const needsUpstream = !String(snapshot?.upstream || "").trim();
    const result = await runAction("推送", () => target.pushTo(remote, needsUpstream));
    if (result.ok === false) {
      setCommitError(result.output || "推送失败");
      return;
    }
    setPushReady(false);
    setCommitError("");
  }

  function repoOf(path?: string) {
    return repoForPath(path || selectedRepo || workspaceRoot, repos);
  }

  async function openFile(absolute: string) {
    const kind = kindForPath(absolute);
    const repo = repoOf(absolute);
    if (repo) selectRepo(repo.path);
    setFilePath(absolute);
    setFileKind(kind);
    setFileView("view");
    setFileRender("preview");
    setFilePreview(undefined);
    setFileMediaSrc("");
    setFileError("");
    setFileContent("");
    setFileLoading(true);
    setPane("file");
    try {
      if (kind === "image") {
        try {
          const loaded = await api.attachments.readImage(absolute);
          setFileMediaSrc(loaded.dataUrl || mediaSrc(absolute));
        } catch {
          const src = mediaSrc(absolute);
          if (!src) throw new Error("无法预览该图片");
          setFileMediaSrc(src);
        }
        return;
      }
      if (kind === "video" || kind === "audio") {
        const src = mediaSrc(absolute);
        if (!src) throw new Error("无法预览该媒体文件");
        setFileMediaSrc(src);
        return;
      }
      if (kind === "binary") {
        setFileError("二进制文件无法在应用中预览");
        return;
      }
      const result = await api.workspace.readFile(absolute);
      const text = result.content || result.preview?.text || "";
      if (kind === "text" && looksBinary(text)) {
        setFileKind("binary");
        setFileError("二进制文件无法在应用中预览");
        return;
      }
      setFileContent(text);
      setFilePreview(result.preview);
      if (result.preview) setFileKind("structured");
    } catch (error) {
      setFileError(errorText(error));
      setMessage(errorText(error));
    } finally {
      setFileLoading(false);
    }
  }

  async function copyText(value: string) {
    if (!value) return;
    await navigator.clipboard.writeText(value).catch(() => undefined);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }

  async function saveEdit() {
    if (!filePath || (fileKind !== "text" && fileKind !== "markdown")) return;
    setEditSaving(true);
    try {
      await api.workspace.writeFile(filePath, fileContent);
      setFileView("view");
      setMessage(`已保存 ${fileName}`);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setEditSaving(false);
    }
  }

  async function runAction<T extends { ok?: boolean; output?: string }>(title: string, task: () => Promise<T>): Promise<T | { ok: false; output: string }> {
    setBusy(true);
    try {
      const result = await task();
      log(title, result.ok !== false, result.output || "");
      if (result.ok !== false) {
        await refresh();
        refreshTree();
        onRemotesChanged?.();
      }
      return result;
    } catch (error) {
      log(title, false, errorText(error));
      return { ok: false, output: errorText(error) };
    } finally {
      setBusy(false);
    }
  }

  function openPrompt(kind: DialogKind, initial = "", name = "", cwd = "", options?: AppDialogOption[], mode = "") {
    setOpenDialog(kind);
    setDraft(initial);
    setTargetName(name);
    setDialogCwd(cwd || selectedRepo || workspaceRoot);
    setDialogError("");
    setDialogOptions(options);
    setDialogMode(mode);
  }

  function openPick(kind: DialogKind, options: AppDialogOption[], cwd: string, mode = "") {
    if (!options.length) {
      void confirm.alert("没有可选项", "当前仓库没有可用的目标。");
      return;
    }
    openPrompt(kind, options[0].id, "", cwd, options, mode);
  }

  function stashRef(label: string) {
    const match = String(label || "").match(/stash@\{\d+\}/);
    return match ? match[0] : label;
  }

  function commitFlags(mode: string, staged: boolean) {
    const stagedOnly = mode === "commit-staged" || mode === "commit-amend-staged" || mode === "commit-sign-staged";
    const forceAll = mode === "commit-all" || mode === "commit-amend-all" || mode === "commit-sign-all";
    const smart = mode === "commit" || mode === "commit-amend" || mode === "commit-signoff";
    return {
      all: forceAll || (!stagedOnly && (!smart || !staged)),
      amend: mode.includes("amend"),
      signoff: mode === "commit-signoff",
      sign: mode === "commit-sign-staged" || mode === "commit-sign-all",
    };
  }

  function beginAddRemote(cwd = "") {
    if (cwd) selectRepo(cwd);
    const hasOrigin = (snapshot?.remotes || []).some((item) => item.name === "origin");
    setRemoteName(hasOrigin ? "" : "origin");
    setRemoteUrl("");
    setRemoteSource(githubConfigured ? "github" : gitlabConfigured ? "gitlab" : "custom");
    setOverwriteRemote(false);
    setCreateOpen(false);
    setHostedQuery("");
    setAddRemoteOpen(true);
    if (githubConfigured || gitlabConfigured) void loadHosted(githubConfigured ? "github" : "gitlab", "");
  }

  function beginClone() {
    setCloneOpen(true);
    setCloneUrl("");
    setCloneName("");
    setClonePath("");
    setCloneMessage("");
  }

  async function pickCloneParent() {
    const picked = await api.workspace.pick({ title: "选择克隆到的目录" });
    if (!picked.canceled && picked.root) setCloneParent(picked.root);
  }

  async function submitClone() {
    if (!cloneUrl.trim()) { setCloneMessage("请填写克隆地址"); return; }
    let parent = cloneParent;
    if (!parent) {
      const picked = await api.workspace.pick({ title: "选择克隆到的目录" });
      if (picked.canceled || !picked.root) { setCloneMessage("请选择目标目录"); return; }
      parent = picked.root;
      setCloneParent(parent);
    }
    setBusy(true);
    setCloneMessage("正在克隆…");
    try {
      const result = await api.git.clone({ url: cloneUrl.trim(), parentDir: parent, folderName: cloneName, shallow: cloneShallow });
      log("克隆", result.ok !== false, result.output || "");
      if (result.ok === false) {
        setCloneMessage(result.output || "克隆失败");
        return;
      }
      setClonePath(result.path || "");
      setCloneMessage(result.path ? `已克隆到 ${result.path}` : "克隆完成");
      if (result.path) setSelectedRepo(result.path);
      await refresh();
      refreshTree();
    } catch (error) {
      setCloneMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function loadHosted(source: RemoteSource, search: string) {
    if (source === "custom") return;
    setHostedBusy(true);
    try {
      const client = source === "github" ? api.github : api.gitlab;
      const result = await client.projects({ search: search.trim() || undefined, limit: 40 });
      setHostedProjects(result.items || []);
    } catch (error) {
      setMessage(errorText(error));
      setHostedProjects([]);
    } finally {
      setHostedBusy(false);
    }
  }

  function pickHosted(project: GitLabProject) {
    const url = remoteProtocol === "ssh" ? (project.sshUrl || project.httpUrl) : (project.httpUrl || project.sshUrl);
    setRemoteUrl(url || "");
    if (!remoteName.trim()) {
      setRemoteName((snapshot?.remotes || []).some((item) => item.name === "origin") ? "" : "origin");
    }
  }

  async function submitAddRemote() {
    if (!remoteName.trim()) { setMessage("请填写远端名称"); return; }
    if (!remoteUrl.trim()) { setMessage("请填写远端地址"); return; }
    setBusy(true);
    try {
      const existing = (snapshot?.remotes || []).some((item) => item.name === remoteName.trim());
      const result = existing && overwriteRemote
        ? await git.setRemoteUrl(remoteName.trim(), remoteUrl.trim())
        : await git.addRemote(remoteName.trim(), remoteUrl.trim());
      if (result.ok === false && result.exists && !overwriteRemote) {
        setMessage("该远端已存在，勾选覆盖后可更新地址");
        setOverwriteRemote(true);
        return;
      }
      log(existing ? "更新远端" : "添加远端", result.ok !== false, result.output || "");
      if (result.ok !== false) {
        setAddRemoteOpen(false);
        await refresh();
        onRemotesChanged?.();
      }
    } catch (error) {
      log("添加远端", false, errorText(error));
    } finally {
      setBusy(false);
    }
  }

  async function runCreateHostedRepo() {
    if (!createName.trim()) { setCreateMessage("请填写仓库名"); return; }
    const client = remoteSource === "github" ? api.github : api.gitlab;
    setHostedBusy(true);
    setCreateMessage("正在检查并创建…");
    try {
      const checked = await client.checkRepository({
        name: createName.trim(),
        owner: createOwner.trim(),
        private: createPrivate,
      });
      setCreateCheck(checked);
      if (checked.exists) {
        setCreateMessage(checked.reason || "仓库已存在");
        if (checked.project) pickHosted(checked.project);
        return;
      }
      const created = await client.createRepository({
        name: createName.trim(),
        owner: createOwner.trim(),
        description: createDescription.trim(),
        private: createPrivate,
        autoInit: createReadme,
      });
      setCreateCheck(created);
      if (created.project) {
        pickHosted(created.project);
        setCreateOpen(false);
        setCreateMessage(`已创建 ${created.fullName || createName}`);
      } else {
        setCreateMessage(created.reason || "创建完成");
      }
    } catch (error) {
      setCreateMessage(errorText(error));
    } finally {
      setHostedBusy(false);
    }
  }

  async function applyPatchFromFile(cwd?: string) {
    const picked = await api.import.open();
    if (picked.canceled || !picked.content) return;
    await runAction("应用补丁", () => gitAt(cwd).applyPatch(picked.content || ""));
  }

  async function savePatch(kind: "staged" | "unstaged", cwd?: string) {
    const result = await gitAt(cwd).createPatch(kind);
    if (result.empty || !result.output?.trim()) {
      setMessage(kind === "staged" ? "没有已暂存的更改" : "没有未暂存的更改");
      return;
    }
    const saved = await api.export.save(result.output, kind === "staged" ? "staged.patch" : "unstaged.patch");
    if (!saved.canceled && saved.path) setMessage(`已保存补丁 ${saved.path}`);
  }

  async function submitFileDialog(value: string) {
    const name = value.trim();
    const parent = openDialog === "newFile" || openDialog === "newFolder"
      ? (targetName || dialogCwd || workspaceRoot)
      : parentOf(targetName, workspaceRoot);
    if (openDialog === "newFile" || openDialog === "newFolder") {
      if (!name) { setDialogError("名称不能为空"); return; }
      try {
        const created = await api.workspace.createEntry(parent, name, openDialog === "newFolder" ? "directory" : "file");
        setOpenDialog(null);
        refreshTree();
        if (openDialog === "newFile") await openFile(created.path);
      } catch (error) {
        setDialogError(errorText(error));
      }
      return;
    }
    if (openDialog === "renameFile") {
      if (!name) { setDialogError("名称不能为空"); return; }
      try {
        const renamed = await api.workspace.renameEntry(targetName, name);
        setOpenDialog(null);
        if (sameRepoPath(filePath, targetName)) await openFile(renamed.path);
        refreshTree();
      } catch (error) {
        setDialogError(errorText(error));
      }
      return;
    }
    if (openDialog === "deleteFile") {
      try {
        await api.workspace.deleteEntry(targetName);
        setOpenDialog(null);
        if (sameRepoPath(filePath, targetName) || filePath.toLowerCase().startsWith(`${targetName.replace(/[\\/]+$/, "").toLowerCase()}\\`) || filePath.toLowerCase().startsWith(`${targetName.replace(/[\\/]+$/, "").toLowerCase()}/`)) {
          resetOpenedFile();
          setPane("welcome");
        }
        refreshTree();
      } catch (error) {
        setDialogError(errorText(error));
      }
    }
  }

  async function loadMenuLists(cwd: string) {
    if (sameRepoPath(cwd, selectedRepo) && snapshot) {
      return {
        remotes: snapshot.remotes || [],
        branches,
        tags,
        stashes,
        branch: snapshot.branch || "",
      };
    }
    const [next, nextBranches, nextTags, nextStashes] = await Promise.all([
      api.git.snapshot(cwd).catch(() => null),
      api.git.branches(cwd).catch(() => ({ items: [] as GitBranch[] })),
      api.git.tags(cwd).catch(() => ({ items: [] as GitTag[] })),
      api.git.stashList(cwd).catch(() => ({ items: [] as Array<{ label: string }> })),
    ]);
    if (next) {
      setSnapshot(next);
      setSnapshots((old) => ({ ...old, [cwd]: next }));
    }
    setBranches(nextBranches.items || []);
    setTags(nextTags.items || []);
    setStashes(nextStashes.items || []);
    return {
      remotes: next?.remotes || [],
      branches: nextBranches.items || [],
      tags: nextTags.items || [],
      stashes: nextStashes.items || [],
      branch: next?.branch || "",
    };
  }

  function menuTargetPath() {
    if (!menu) return dialogCwd || workspaceRoot;
    if (menu.type === "blank") return workspaceRoot;
    if (menu.type === "directory" || menu.type === "repo") return menu.path;
    return parentOf(menu.path, workspaceRoot);
  }

  async function submitDialog(value: string) {
    const text = value.trim();
    const target = gitAt(dialogCwd);
    const staged = (snapshot?.files || []).some((item) => item.code[0] && item.code[0] !== " " && item.code[0] !== "?");
    if (openDialog === "checkout") {
      if (!text) { setDialogError("请填写分支、标签或提交"); return; }
      const result = await runAction("签出", () => target.checkout(text));
      if (result.ok === false) { setDialogError(result.output || "签出失败"); return; }
    } else if (openDialog === "deleteRemote") {
      const name = targetName || text;
      if (!name) { setDialogError("请选择远端"); return; }
      const result = await runAction("删除远端", () => target.removeRemote(name));
      if (result.ok === false) { setDialogError(result.output || "删除失败"); return; }
    } else if (openDialog === "deleteBranch") {
      const name = targetName || text;
      if (!name) { setDialogError("请选择分支"); return; }
      const result = await runAction("删除分支", () => target.deleteBranch(name));
      if (result.ok === false) { setDialogError(result.output || "删除失败"); return; }
    } else if (openDialog === "deleteTag") {
      const name = targetName || text;
      if (!name) { setDialogError("请选择标签"); return; }
      const result = await runAction("删除标签", () => target.deleteTag(name));
      if (result.ok === false) { setDialogError(result.output || "删除失败"); return; }
    } else if (openDialog === "commit") {
      const flags = commitFlags(dialogMode || "commit", staged);
      if (!text && !flags.amend) { setDialogError("请填写提交说明"); return; }
      const result = await runAction(flags.amend ? "提交(修改)" : "提交", () => target.commit(text, flags));
      if (result.ok === false) { setDialogError(result.output || "提交失败"); return; }
    } else if (openDialog === "createBranch") {
      if (!text) { setDialogError("请填写分支名"); return; }
      const result = await runAction("新建分支", () => target.createBranch(text, true));
      if (result.ok === false) { setDialogError(result.output || "创建失败"); return; }
    } else if (openDialog === "createBranchFrom") {
      if (!text) { setDialogError("请填写新分支名"); return; }
      setTargetName(text);
      setOpenDialog("createBranchStart");
      setDraft(snapshot?.branch || "");
      setDialogOptions(undefined);
      setDialogError("");
      return;
    } else if (openDialog === "createBranchStart") {
      if (!text) { setDialogError("请填写来源分支、标签或提交"); return; }
      const result = await runAction("从现有来源创建分支", () => target.createBranch(targetName, true, text));
      if (result.ok === false) { setDialogError(result.output || "创建失败"); return; }
    } else if (openDialog === "renameBranch") {
      if (!text) { setDialogError("请填写新分支名"); return; }
      const result = await runAction("重命名分支", () => target.renameBranch(text));
      if (result.ok === false) { setDialogError(result.output || "重命名失败"); return; }
    } else if (openDialog === "merge") {
      if (!text) { setDialogError("请选择要合并的分支"); return; }
      const result = await runAction("合并", () => target.merge(text));
      if (result.ok === false) { setDialogError(result.output || "合并失败"); return; }
    } else if (openDialog === "rebase") {
      if (!text) { setDialogError("请选择变基目标"); return; }
      const result = await runAction("变基", () => target.rebase(text));
      if (result.ok === false) { setDialogError(result.output || "变基失败"); return; }
    } else if (openDialog === "deleteRemoteBranch") {
      if (!text) { setDialogError("请选择远程分支"); return; }
      const [remote, ...rest] = text.includes("/") ? text.split("/") : [undefined, text];
      const name = rest.length ? rest.join("/") : text;
      const result = await runAction("删除远程分支", () => target.deleteRemoteBranch(name, remote));
      if (result.ok === false) { setDialogError(result.output || "删除失败"); return; }
    } else if (openDialog === "deleteRemoteTag") {
      if (!text) { setDialogError("请选择远程标记"); return; }
      const remotesNow = snapshot?.remotes || [];
      const result = await runAction("删除远程标记", () => target.deleteRemoteTag(text, remotesNow[0]?.name));
      if (result.ok === false) { setDialogError(result.output || "删除失败"); return; }
    } else if (openDialog === "createTag") {
      if (!text) { setDialogError("请填写标签名"); return; }
      const result = await runAction("创建标签", () => target.createTag(text));
      if (result.ok === false) { setDialogError(result.output || "创建失败"); return; }
    } else if (openDialog === "stash") {
      const result = await runAction("贮藏", () => target.stash(text, {
        includeUntracked: dialogMode === "stash-untracked",
        staged: dialogMode === "stash-staged",
      }));
      if (result.ok === false) { setDialogError(result.output || "贮藏失败"); return; }
    } else if (openDialog === "stashPick") {
      if (!text) { setDialogError("请选择贮藏"); return; }
      const ref = stashRef(text);
      const action = dialogMode === "stash-pop" ? "弹出储藏"
        : dialogMode === "stash-drop" ? "删除储藏"
          : dialogMode === "stash-show" ? "查看储藏"
            : "应用储藏";
      const result = await runAction(action, () => (
        dialogMode === "stash-pop" ? target.stashPop(ref)
          : dialogMode === "stash-drop" ? target.stashDrop(ref)
            : dialogMode === "stash-show" ? target.stashShow(ref)
              : target.stashApply(ref)
      ));
      if (result.ok === false) { setDialogError(result.output || "操作失败"); return; }
      if (dialogMode === "stash-show") setPane("output");
    } else if (openDialog === "pullFrom") {
      if (!text) { setDialogError("请填写远端名称"); return; }
      const rebase = dialogMode === "pull-rebase";
      const result = await runAction(rebase ? "拉取并变基" : "拉取", () => target.pull(text, rebase));
      if (result.ok === false) { setDialogError(result.output || "拉取失败"); return; }
    } else if (openDialog === "pushTo") {
      if (!text) { setDialogError("请填写远端名称"); return; }
      const result = await runAction(dialogMode === "publish" ? "发布分支" : "推送", () => (
        dialogMode === "publish" ? target.publishBranch(text) : target.pushTo(text)
      ));
      if (result.ok === false) { setDialogError(result.output || "推送失败"); return; }
    }
    setOpenDialog(null);
    setDialogOptions(undefined);
    setDialogMode("");
  }

  function openMenu(event: React.MouseEvent, path: string, type: MenuTarget["type"]) {
    event.preventDefault();
    event.stopPropagation();
    const repo = repoOf(path);
    if (repo) selectRepo(repo.path);
    setMenu({ x: event.clientX, y: event.clientY, path, type });
  }

  function toggleDirectory(root: string, path: string, nextOpen: boolean, children?: TreeEntry[] | null) {
    setExpanded((current) => {
      const next = new Set(current);
      if (nextOpen) next.add(path);
      else next.delete(path);
      return next;
    });
    const repo = repoOf(path);
    if (repo) selectRepo(repo.path);
    if (nextOpen && children == null) {
      void loadFolder(path).then((loaded) => {
        setRepoEntries((old) => ({
          ...old,
          [root]: replaceTreeChildren(old[root] || [], root, path, loaded),
        }));
      }).catch(() => undefined);
    }
  }

  async function handleMenu(id: string) {
    if (!menu) return;
    const targetPath = menu.type === "blank" ? workspaceRoot : menu.path;
    const repo = repoOf(targetPath);
    const cwd = repo?.path || (menu.type === "directory" ? targetPath : parentOf(targetPath, workspaceRoot));
    const target = gitAt(cwd);
    const lists = await loadMenuLists(cwd);
    const remotes = lists.remotes;
    const remoteName = remotes[0]?.name || "origin";
    const remoteOptions = remotes.map((item) => ({ id: item.name, label: item.name, sub: item.url }));
    const otherBranches = lists.branches.filter((item) => !item.current).map((item) => ({ id: item.name, label: item.name, sub: item.upstream }));
    const remoteBranches = lists.branches.filter((item) => item.upstream).map((item) => ({ id: item.upstream || item.name, label: item.upstream || item.name, sub: item.name }));
    const tagOptions = lists.tags.map((item) => ({ id: item.name, label: item.name, sub: item.sha }));
    const stashOptions = lists.stashes.map((item) => ({ id: item.label, label: item.label }));
    showRelated(id, cwd);
    if (id === "pull") void runAction("拉取", () => target.pull(remoteName));
    else if (id === "push") void runAction("推送", () => target.pushTo(remoteName));
    else if (id === "fetch") void runAction("抓取", () => target.fetch(remoteName));
    else if (id === "sync" || id === "pull-push") void runAction("拉取", () => target.pull(remoteName)).then((result) => { if (result.ok !== false) void runAction("推送", () => target.pushTo(remoteName)); });
    else if (id === "pull-rebase") void runAction("拉取并变基", () => target.pull(remoteName, true));
    else if (id === "pull-from") openPick("pullFrom", remoteOptions, cwd);
    else if (id === "push-to") openPick("pushTo", remoteOptions, cwd);
    else if (id === "push-upstream") void runAction("推送并设上游", () => target.pushTo(remoteName, true));
    else if (id === "fetch-prune") void runAction("抓取（删除）", () => target.fetch(remoteName, { prune: true }));
    else if (id === "fetch-all") void runAction("从所有远程仓库中抓取", () => target.fetch("", { all: true }));
    else if (id === "commit" || id === "commit-staged" || id === "commit-all" || id === "commit-amend" || id === "commit-amend-staged" || id === "commit-amend-all" || id === "commit-signoff" || id === "commit-sign-staged" || id === "commit-sign-all") {
      beginInlineCommit(id, cwd);
    }
    else if (id === "undo-commit") void runAction("撤销上次提交", () => target.undoCommit());
    else if (id === "abort-rebase") void runAction("中止变基", () => target.abortRebase());
    else if (id === "stage-all") void runAction("暂存所有更改", () => target.stageAll());
    else if (id === "unstage-all") void runAction("取消暂存所有更改", () => target.unstageAll());
    else if (id === "discard-all") {
      const ok = await confirm.confirm("放弃所有更改", "将丢弃工作区和暂存区的所有未提交更改，且无法恢复。");
      if (ok) void runAction("放弃所有更改", () => target.discardAll());
    }
    else if (id === "checkout") openPrompt("checkout", repo?.branch || lists.branch || "", "", cwd);
    else if (id === "create-branch") openPrompt("createBranch", "", "", cwd);
    else if (id === "create-branch-from") openPrompt("createBranchFrom", "", "", cwd);
    else if (id === "rename-branch") openPrompt("renameBranch", lists.branch || repo?.branch || "", "", cwd);
    else if (id === "merge") openPick("merge", otherBranches, cwd);
    else if (id === "rebase") openPick("rebase", otherBranches, cwd);
    else if (id === "delete-branch") openPick("deleteBranch", otherBranches, cwd);
    else if (id === "delete-remote-branch") openPick("deleteRemoteBranch", remoteBranches.length ? remoteBranches : otherBranches, cwd);
    else if (id === "publish-branch") {
      if (remoteOptions.length > 1) openPick("pushTo", remoteOptions, cwd, "publish");
      else void runAction("发布分支", () => target.publishBranch(remoteName));
    }
    else if (id === "create-tag") openPrompt("createTag", "", "", cwd);
    else if (id === "delete-tag") openPick("deleteTag", tagOptions, cwd);
    else if (id === "delete-remote-tag") openPick("deleteRemoteTag", tagOptions, cwd);
    else if (id === "push-tags") void runAction("推送标记", () => target.pushTags(remoteName));
    else if (id === "stash") openPrompt("stash", "", "", cwd, undefined, "stash");
    else if (id === "stash-untracked") openPrompt("stash", "", "", cwd, undefined, "stash-untracked");
    else if (id === "stash-staged") openPrompt("stash", "", "", cwd, undefined, "stash-staged");
    else if (id === "stash-apply-latest") void runAction("应用最新储藏", () => target.stashApply());
    else if (id === "stash-pop-latest") void runAction("弹出最新储藏", () => target.stashPop());
    else if (id === "stash-apply") openPick("stashPick", stashOptions, cwd, "stash-apply");
    else if (id === "stash-pop") openPick("stashPick", stashOptions, cwd, "stash-pop");
    else if (id === "stash-drop") openPick("stashPick", stashOptions, cwd, "stash-drop");
    else if (id === "stash-show") openPick("stashPick", stashOptions, cwd, "stash-show");
    else if (id === "stash-clear") {
      const ok = await confirm.confirm("删除所有储藏", "将删除当前仓库的全部储藏，且无法恢复。");
      if (ok) void runAction("删除所有储藏", () => target.stashClear());
    }
    else if (id === "add-remote") beginAddRemote(cwd);
    else if (id === "delete-remote") {
      if (remoteOptions.length === 1) openPrompt("deleteRemote", "", remoteOptions[0].id, cwd);
      else openPick("deleteRemote", remoteOptions, cwd);
    }
    else if (id === "clone") beginClone();
    else if (id === "init") void runAction("初始化仓库", () => api.git.init(cwd));
    else if (id === "apply-patch") void applyPatchFromFile(cwd);
    else if (id === "patch-staged") void savePatch("staged", cwd);
    else if (id === "patch-unstaged") void savePatch("unstaged", cwd);
    else if (id === "restore" && menu.type === "file") void runAction("还原文件", () => target.restoreFile(toRepoRelative(targetPath, cwd)));
    else if (id === "open" && menu.type === "file") void openFile(targetPath);
    else if (id === "reveal") void api.workspace.revealInFolder(targetPath);
    else if (id === "open-vscode") void api.workspace.openInEditor(workspaceRoot, "VS Code");
    else if (id === "copy-path") void copyText(targetPath);
    else if (id === "new-file") openPrompt("newFile", "", menuTargetPath(), cwd);
    else if (id === "new-folder") openPrompt("newFolder", "", menuTargetPath(), cwd);
    else if (id === "rename" && menu.type !== "blank" && menu.type !== "repo") openPrompt("renameFile", targetPath.split(/[\\/]/).pop() || "", targetPath);
    else if (id === "delete" && menu.type !== "blank" && menu.type !== "repo") openPrompt("deleteFile", "", targetPath);
    else if (id === "changes" || id === "branches" || id === "remotes" || id === "stash-list" || id === "tags" || id === "output" || id === "graph") {
      if (repo) selectRepo(repo.path);
      setPane(id === "stash-list" ? "stash" : id);
    }
  }

  function toRepoRelative(absolute: string, cwd: string) {
    const root = cwd.replace(/[\\/]+$/, "");
    const value = String(absolute || "").replace(/[\\/]+$/, "");
    if (root && value.toLowerCase().startsWith(root.toLowerCase())) {
      return value.slice(root.length).replace(/^[\\/]+/, "").replace(/\\/g, "/");
    }
    return value.replace(/\\/g, "/");
  }

  function snapshotOf(repo?: GitRepo) {
    if (!repo) return snapshot;
    return snapshots[repo.path] || (sameRepoPath(repo.path, selectedRepo) ? snapshot : null);
  }

  function fileDirty(path: string, repo?: GitRepo) {
    const snap = snapshotOf(repo);
    if (!snap || !repo) return false;
    const relative = toRepoRelative(path, repo.path);
    return (snap.files || []).some((item) => item.path.replace(/\\/g, "/") === relative);
  }

  function changeFlags(repo?: GitRepo) {
    const snap = snapshotOf(repo);
    const files = snap?.files || [];
    return {
      dirty: Boolean(repo?.dirty || (repo?.changes || 0) > 0 || snap?.dirty || files.length),
      staged: files.some((item) => item.code[0] && item.code[0] !== " " && item.code[0] !== "?"),
      unstaged: files.some((item) => item.code[1] && item.code[1] !== " "),
      remotes: snap?.remotes || [],
      rebasing: Boolean(snap?.rebasing),
      hasCommits: snap?.hasCommits ?? Boolean(repo?.branch || snap?.branch),
      hasStash: stashes.length > 0 && sameRepoPath(repo?.path, selectedRepo),
    };
  }

  function menuItems(): ContextMenuItem[] {
    const targetPath = menu?.type === "blank" ? workspaceRoot : menu?.path || workspaceRoot;
    const repo = menu?.type === "repo" ? repos.find((item) => sameRepoPath(item.path, targetPath)) : undefined;
    const owning = repo || repoOf(targetPath);
    const flags = changeFlags(owning);
    const hasRemote = Boolean(owning?.upstream) || flags.remotes.length > 0;
    const isRepoNode = menu?.type === "repo" && Boolean(repo);
    const isVirtualRoot = menu?.type === "repo" && !repos.some((item) => sameRepoPath(item.path, targetPath));
    const fileItems: ContextMenuItem[] = [
      ...(menu?.type === "file" ? [{ id: "open", label: "打开" }] : []),
      ...(menu?.type === "file" && owning && fileDirty(targetPath, owning) ? [{ id: "restore", label: "还原文件", disabled: busy }] : []),
      { id: "new-file", label: "新建文件" },
      { id: "new-folder", label: "新建文件夹" },
      { id: "copy-path", label: "复制路径" },
      { id: "reveal", label: "在资源管理器中显示" },
      { id: "open-vscode", label: "用 VS Code 打开工作区" },
      ...(menu?.type === "file" || menu?.type === "directory" ? [{ separator: true } as const, { id: "rename", label: "重命名" }, { id: "delete", label: "删除", danger: true }] : []),
    ];
    if (menu?.type === "blank") {
      return [
        ...(repos.length === 0 ? [{ id: "init", label: "初始化仓库", disabled: busy }] : []),
        { id: "clone", label: "克隆" },
        { separator: true },
        { id: "new-file", label: "新建文件" },
        { id: "new-folder", label: "新建文件夹" },
        { id: "open-vscode", label: "用 VS Code 打开工作区" },
        { id: "reveal", label: "在资源管理器中显示" },
      ];
    }
    if (isVirtualRoot) {
      return [
        { id: "init", label: "初始化仓库", disabled: busy },
        { id: "clone", label: "克隆" },
        { separator: true },
        ...fileItems,
      ];
    }
    if (!isRepoNode) return fileItems;
    const commitItems: ContextMenuItem[] = [
      ...(flags.dirty ? [{ id: "commit", label: "提交", disabled: busy }] : []),
      ...(flags.staged ? [{ id: "commit-staged", label: "提交暂存文件", disabled: busy }] : []),
      ...(flags.dirty ? [{ id: "commit-all", label: "全部提交", disabled: busy }] : []),
      ...(flags.hasCommits ? [{ id: "undo-commit", label: "撤销上次提交", disabled: busy }] : []),
      ...(flags.rebasing ? [{ id: "abort-rebase", label: "中止变基", disabled: busy }] : []),
      ...(flags.dirty && flags.hasCommits ? [{ id: "commit-amend", label: "提交(修改)", disabled: busy }] : []),
      ...(flags.staged && flags.hasCommits ? [{ id: "commit-amend-staged", label: "提交已暂存文件(修改)", disabled: busy }] : []),
      ...(flags.dirty && flags.hasCommits ? [{ id: "commit-amend-all", label: "全部提交(修改)", disabled: busy }] : []),
      ...(flags.dirty ? [{ id: "commit-signoff", label: "提交(签收)", disabled: busy }] : []),
      ...(flags.staged ? [{ id: "commit-sign-staged", label: "提交已暂存文件(已署名)", disabled: busy }] : []),
      ...(flags.dirty ? [{ id: "commit-sign-all", label: "全部提交(已署名)", disabled: busy }] : []),
    ];
    const changeItems: ContextMenuItem[] = [
      ...(flags.dirty ? [{ id: "stage-all", label: "暂存所有更改", disabled: busy }] : []),
      ...(flags.staged ? [{ id: "unstage-all", label: "取消暂存所有更改", disabled: busy }] : []),
      ...(flags.dirty ? [{ id: "discard-all", label: "放弃所有更改", disabled: busy, danger: true }] : []),
    ];
    const syncItems: ContextMenuItem[] = [
      { id: "sync", label: "同步", disabled: busy },
      { id: "pull", label: "拉取", disabled: busy },
      { id: "pull-rebase", label: "拉取(变基)", disabled: busy },
      { id: "pull-from", label: "拉取自…" },
      { id: "push", label: "推送", disabled: busy },
      { id: "push-to", label: "推送到…" },
      { id: "fetch", label: "抓取", disabled: busy },
      { id: "fetch-prune", label: "抓取(删除)", disabled: busy },
      { id: "fetch-all", label: "从所有远程仓库中抓取", disabled: busy },
    ];
    const branchItems: ContextMenuItem[] = [
      { id: "merge", label: "合并…" },
      { id: "rebase", label: "变基分支…" },
      { id: "create-branch", label: "创建分支…" },
      { id: "create-branch-from", label: "从现有来源创建新的分支…" },
      { id: "rename-branch", label: "重命名分支…" },
      { id: "delete-branch", label: "删除分支…" },
      ...(hasRemote ? [{ id: "delete-remote-branch", label: "删除远程分支…" }] : []),
      ...(hasRemote ? [{ id: "publish-branch", label: "发布分支…", disabled: busy }] : []),
    ];
    const remoteItems: ContextMenuItem[] = [
      { id: "add-remote", label: "添加远程存储库…" },
      ...(hasRemote ? [{ id: "delete-remote", label: "删除远程存储库" }] : []),
    ];
    const stashItems: ContextMenuItem[] = [
      ...(flags.dirty ? [{ id: "stash", label: "储藏" }] : []),
      ...(flags.dirty ? [{ id: "stash-untracked", label: "储藏(包含未跟踪)" }] : []),
      ...(flags.staged ? [{ id: "stash-staged", label: "储藏暂存" }] : []),
      ...(flags.hasStash ? [{ id: "stash-apply-latest", label: "应用最新储藏", disabled: busy }] : []),
      ...(flags.hasStash ? [{ id: "stash-apply", label: "应用储藏…" }] : []),
      ...(flags.hasStash ? [{ id: "stash-pop-latest", label: "弹出最新储藏", disabled: busy }] : []),
      ...(flags.hasStash ? [{ id: "stash-pop", label: "弹出储藏…" }] : []),
      ...(flags.hasStash ? [{ id: "stash-drop", label: "删除储藏…" }] : []),
      ...(flags.hasStash ? [{ id: "stash-clear", label: "删除所有储藏…" }] : []),
      ...(flags.hasStash ? [{ id: "stash-show", label: "查看储藏条目…" }] : []),
    ];
    const tagItems: ContextMenuItem[] = [
      { id: "create-tag", label: "创建标记…" },
      { id: "delete-tag", label: "删除标签…" },
      ...(hasRemote ? [{ id: "delete-remote-tag", label: "删除远程标记…" }] : []),
      ...(hasRemote ? [{ id: "push-tags", label: "推送标记", disabled: busy }] : []),
    ];
    const items: ContextMenuItem[] = [
      { id: "new-file", label: "新建文件" },
      { id: "new-folder", label: "新建文件夹" },
      { id: "copy-path", label: "复制路径" },
      { id: "reveal", label: "在资源管理器中显示" },
      { separator: true },
      { id: "clone", label: "克隆" },
      { id: "checkout", label: "签出到…" },
      { separator: true },
      ...(commitItems.length ? [{ id: "commit-menu", label: "提交", children: commitItems }] : []),
      ...(changeItems.length ? [{ id: "changes-menu", label: "更改", children: changeItems }] : []),
      ...(hasRemote ? [{ id: "sync-menu", label: "拉取，推送", children: syncItems }] : []),
      { id: "branch-menu", label: "分支", children: branchItems },
      { id: "remote-menu", label: "远程", children: remoteItems },
      ...(stashItems.length ? [{ id: "stash-menu", label: "贮藏", children: stashItems }] : []),
      { id: "tag-menu", label: "标记", children: tagItems },
      { separator: true },
      { id: "graph", label: "仓库图" },
      { id: "output", label: "显示 Git 输出" },
      { separator: true },
      { id: "apply-patch", label: "应用已有补丁" },
      ...(flags.staged ? [{ id: "patch-staged", label: "从已暂存文件创建补丁" }] : []),
      ...(flags.unstaged || flags.dirty ? [{ id: "patch-unstaged", label: "从未暂存文件创建补丁" }] : []),
    ];
    return items.filter((item, index, list) => {
      if (!("separator" in item)) return true;
      const prev = list[index - 1];
      const next = list[index + 1];
      return Boolean(prev && next && !("separator" in prev) && !("separator" in next));
    });
  }

  const remotes = snapshot?.remotes || [];
  const files = snapshot?.files || [];
  const hostedLabel = remoteSource === "github" ? "GitHub" : "GitLab";
  const filteredHosted = hostedProjects.filter((item) => matchesQuery(hostedQuery, item.pathWithNamespace, item.name, item.description));
  const filteredFiles = files.filter((item) => matchesQuery(query, item.path, changeLabel(item.code)));
  const diffFiles = React.useMemo(() => parseUnifiedDiff(diffText), [diffText]);
  const selectedDiff = selectedChange
    ? diffFiles.find((item) => sameChangePath(item.path, selectedChange))
    : undefined;
  const visibleDiffs = selectedChange ? (selectedDiff ? [selectedDiff] : []) : diffFiles;
  const visibleAdded = visibleDiffs.reduce((sum, item) => sum + item.added, 0);
  const visibleDeleted = visibleDiffs.reduce((sum, item) => sum + item.deleted, 0);
  const graphDiffFiles = React.useMemo(() => parseUnifiedDiff(graphDiff), [graphDiff]);
  function toggleDiffFile(path: string) {
    setCollapsedDiffs((current) => {
      const next = new Set(current);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  }
  function setDiffFilesCollapsed(paths: string[], collapsed: boolean) {
    setCollapsedDiffs((current) => {
      const next = new Set(current);
      for (const path of paths) {
        if (collapsed) next.add(path);
        else next.delete(path);
      }
      return next;
    });
  }
  function renderDiffHunks(file: (typeof visibleDiffs)[number]) {
    return file.hunks.map((hunk, hunkIndex) => (
      <div className="diff-review-hunk" key={`${file.path}:${hunkIndex}`}>
        <div className="diff-review-hunk-head"><code>{hunk.header}</code></div>
        <pre>
          {hunk.lines.map((line, lineIndex) => (
            <span className={`diff-review-line ${line.kind}`} key={`${hunkIndex}:${lineIndex}`}>
              <em>{line.oldLine ?? ""}</em>
              <em>{line.newLine ?? ""}</em>
              <b>{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</b>
              {line.text || " "}
            </span>
          ))}
        </pre>
      </div>
    ));
  }
  function renderDiffFiles(files: typeof visibleDiffs, foldable: boolean) {
    return files.map((file) => {
      const isCollapsed = foldable && collapsedDiffs.has(file.path);
      return (
        <section className={`git-diff-file${isCollapsed ? " collapsed" : ""}`} key={file.path}>
          {foldable ? (
            <button type="button" className="git-diff-file-head" onClick={() => toggleDiffFile(file.path)} aria-expanded={!isCollapsed}>
              <UiIcon icon={isCollapsed ? icons.right : icons.down} />
              <code>{file.path}</code>
              <span><b>+{file.added}</b> <i>−{file.deleted}</i></span>
            </button>
          ) : null}
          {!isCollapsed ? renderDiffHunks(file) : null}
        </section>
      );
    });
  }
  React.useEffect(() => {
    if (pane !== "changes") return;
    if (selectedChange && !filteredFiles.some((item) => sameChangePath(item.path, selectedChange))) {
      setSelectedChange("");
    }
  }, [pane, query, files, selectedChange, filteredFiles]);
  const filteredBranches = branches.filter((item) => matchesQuery(query, item.name, item.upstream, item.sha));
  const filteredRemotes = remotes.filter((item) => matchesQuery(query, item.name, item.url, item.host));
  const filteredStashes = stashes.filter((item) => matchesQuery(query, item.label));
  const filteredTags = tags.filter((item) => matchesQuery(query, item.name, item.sha, item.date));
  const filteredLogs = logs.filter((item) => matchesQuery(query, item.title, item.text));

  function renderTree(nodes: TreeEntry[], parent: string, depth: number, root: string): React.ReactNode {
    return nodes.map((node) => {
      const path = joinTreePath(parent, node.name);
      if (node.type === "directory") {
        const isOpen = expanded.has(path) || Boolean(treeQuery.trim());
        return (
          <details
            className="workspace-tree-directory"
            open={isOpen}
            key={path}
            onToggle={(event) => toggleDirectory(root, path, (event.currentTarget as HTMLDetailsElement).open, node.children)}
            onContextMenu={(event) => openMenu(event, path, "directory")}
          >
            <summary
              className={sameRepoPath(path, filePath) ? "active" : ""}
              style={{ paddingLeft: `${6 + depth * 14}px` }}
              onContextMenu={(event) => openMenu(event, path, "directory")}
            >
              <UiIcon icon={isOpen ? icons.down : icons.right} />
              <UiIcon icon={isOpen ? icons.folderOpen : icons.folder} />
              <span>{node.name}</span>
            </summary>
            {isOpen && Array.isArray(node.children) && renderTree(node.children, path, depth + 1, root)}
          </details>
        );
      }
      return (
        <button
          type="button"
          className={`workspace-tree-file ${sameRepoPath(path, filePath) ? "active" : ""}`}
          key={path}
          style={{ paddingLeft: `${22 + depth * 14}px` }}
          title={path}
          onClick={() => void openFile(path)}
          onContextMenu={(event) => openMenu(event, path, "file")}
        >
          <UiIcon icon={fileIconForName(node.name)} />
          <span>{node.name}</span>
        </button>
      );
    });
  }

  function renderRepoRoots() {
    return treeRoots.map((repo) => {
      const children = filterTree(repoEntries[repo.path] || [], repo.path, treeQuery);
      const isOpen = expanded.has(repo.path) || Boolean(treeQuery.trim());
      const isGit = repos.some((item) => sameRepoPath(item.path, repo.path));
      return (
        <details
          className="workspace-tree-directory git-ide-repo"
          open={isOpen}
          key={repo.path}
          onToggle={(event) => toggleDirectory(repo.path, repo.path, (event.currentTarget as HTMLDetailsElement).open, repoEntries[repo.path])}
          onContextMenu={(event) => openMenu(event, repo.path, "repo")}
        >
          <summary
            className={sameRepoPath(repo.path, selectedRepo) && !filePath ? "active" : ""}
            onContextMenu={(event) => openMenu(event, repo.path, "repo")}
          >
            <UiIcon icon={isOpen ? icons.down : icons.right} />
            <UiIcon icon={isOpen ? icons.folderOpen : icons.folder} />
            <span>{repo.name}</span>
            {isGit && repo.branch && <em className="git-ide-branch">{repo.branch}</em>}
            {isGit && repo.changes > 0 && <b className="git-ide-badge">{repo.changes}</b>}
          </summary>
          {isOpen && renderTree(children, repo.path, 1, repo.path)}
        </details>
      );
    });
  }

  const paneTitle = pane === "changes" ? "更改"
    : pane === "branches" ? "分支"
      : pane === "remotes" ? "远端"
        : pane === "stash" ? "贮藏"
          : pane === "tags" ? "标签"
            : pane === "output" ? "Git 输出"
              : pane === "graph" ? "仓库图"
                : selectedMeta?.name || workspaceName;

  return (
    <section className="plugins-view git-ide-view" onContextMenu={(event) => event.preventDefault()}>
      <aside className="git-ide-tree workspace-tree" onContextMenu={(event) => openMenu(event, workspaceRoot, "blank")}>
        <div className="git-ide-tree-head">
          <strong>存储库</strong>
          <span>{treeRoots.length}</span>
          <button type="button" title="刷新" disabled={loading || busy} onClick={() => { void refresh(); refreshTree(); }}>
            <UiIcon icon={icons.refresh} />
          </button>
          <button type="button" title="设置" onClick={onOpenSettings}>
            <UiIcon icon={icons.gear} />
          </button>
        </div>
        <label>
          <UiIcon icon={icons.search} />
          <input value={treeQuery} onChange={(event) => setTreeQuery(event.target.value)} placeholder="筛选文件…" />
        </label>
        <div className="workspace-tree-list">
          {!workspaceRoot ? (
            <div className="git-ide-tree-empty">先选择一个工作区</div>
          ) : treeRoots.length === 0 ? (
            <div className="git-ide-tree-empty">{loading ? "正在扫描仓库…" : "这个工作区还没有 Git 仓库"}</div>
          ) : renderRepoRoots()}
        </div>
        {menu && hasContextActions(menuItems()) && <ContextMenu x={menu.x} y={menu.y} items={menuItems()} onSelect={(id) => void handleMenu(id)} onClose={() => setMenu(null)} />}
      </aside>

      <div className="git-ide-main" onContextMenu={(event) => event.preventDefault()}>
        {message && <div className="plugins-message">{message}</div>}
        {pane === "welcome" && (
          <div className="git-ide-welcome">
            <div>
              <p>从左侧文件树打开文件</p>
              <p>在文件或文件夹上右键使用 Git 操作</p>
              {selectedMeta?.branch && <small>{selectedMeta.name} · {selectedMeta.branch}</small>}
            </div>
          </div>
        )}

        {pane === "file" && (
          <div className="gitlab-file-pane">
            <div className="gitlab-code-toolbar">
              <div className="gitlab-code-crumbs">
                <UiIcon icon={fileIconForName(fileName)} />
                <span>{fileName || "未选择文件"}</span>
                {selectedMeta?.branch && <em>{selectedMeta.branch}</em>}
              </div>
              {filePath && (
                <div className="gitlab-code-actions gitlab-file-actions">
                  <button type="button" className={fileView === "view" ? "active" : ""} onClick={() => { setEditMenuOpen(false); setFileView("view"); }}>
                    <UiIcon icon={icons.fileCode} /> 查看文件
                  </button>
                  <div className="gitlab-code-menu">
                    <button type="button" className={fileView === "edit" || editMenuOpen ? "active" : ""} aria-haspopup="menu" aria-expanded={editMenuOpen} onClick={() => setEditMenuOpen((open) => !open)}>
                      <UiIcon icon={icons.compose} /> 编辑 <UiIcon icon={icons.down} />
                    </button>
                    {editMenuOpen && (
                      <div className="gitlab-code-popover">
                        {(fileKind === "text" || fileKind === "markdown") && (
                          <button type="button" onClick={() => { setEditMenuOpen(false); setFileView("edit"); }}>在应用中编辑</button>
                        )}
                        <button type="button" onClick={() => { setEditMenuOpen(false); void api.workspace.openExternal(filePath, "VS Code"); }}>用 VS Code 打开</button>
                        <button type="button" onClick={() => { setEditMenuOpen(false); void api.workspace.openExternal(filePath, "系统默认"); }}>用系统默认程序打开</button>
                        <button type="button" onClick={() => { setEditMenuOpen(false); openPrompt("renameFile", fileName, filePath); }}>重命名</button>
                        <button type="button" onClick={() => { setEditMenuOpen(false); openPrompt("deleteFile", "", filePath); }}>删除</button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
            {fileLoading ? (
              <div className="plugins-empty">正在打开 {fileName}…</div>
            ) : (
              <div className="gitlab-file-card">
                <div className="gitlab-file-card-head">
                  <strong>{fileName}</strong>
                  <span>
                    {fileKind === "image" ? "图片"
                      : fileKind === "video" ? "视频"
                        : fileKind === "audio" ? "音频"
                          : fileKind === "structured" ? (filePreview?.kind || "文档")
                            : fileKind === "binary" ? "二进制"
                              : fileContent ? `${fileContent.split("\n").length} 行` : ""}
                  </span>
                  <span className="gitlab-file-card-tools">
                    {fileView !== "edit" && (fileKind === "markdown" || isMarkdownPath(filePath) || isConfigPreviewPath(filePath)) && (
                      <button type="button" title={fileRender === "preview" ? "查看源码" : "查看预览"} className={fileRender === "source" ? "active" : ""} onClick={() => setFileRender((current) => (current === "preview" ? "source" : "preview"))}>
                        <UiIcon icon={fileRender === "preview" ? icons.code : icons.fileLines} />
                      </button>
                    )}
                    {fileView === "edit" && (fileKind === "text" || fileKind === "markdown") && (
                      <>
                        <button type="button" className="gitlab-code-button" disabled={editSaving} onClick={() => void saveEdit()}>{editSaving ? "保存中…" : "保存"}</button>
                        <button type="button" onClick={() => setFileView("view")}>取消</button>
                      </>
                    )}
                    <button type="button" title="复制" disabled={!fileContent} onClick={() => void copyText(fileContent)}><UiIcon icon={icons.copy} /></button>
                    <button type="button" title="用系统默认程序打开" onClick={() => void api.workspace.openExternal(filePath, "系统默认")}><UiIcon icon={icons.external} /></button>
                    <button type="button" title="在文件夹中显示" onClick={() => void api.workspace.revealInFolder(filePath)}><UiIcon icon={icons.folderOpen} /></button>
                  </span>
                </div>
                {fileError || (fileKind === "binary" && !fileContent) ? (
                  <div className="gitlab-file-unsupported">
                    <p>{fileError || "该文件无法在应用中预览"}</p>
                    <button type="button" onClick={() => void api.workspace.openExternal(filePath, "VS Code")}>用 VS Code 打开</button>
                    <button type="button" onClick={() => void api.workspace.revealInFolder(filePath)}>在文件夹中显示</button>
                  </div>
                ) : fileKind === "image" ? (
                  fileMediaSrc ? <div className="gitlab-file-image"><img src={fileMediaSrc} alt={fileName} /></div> : <div className="plugins-empty">正在加载图片…</div>
                ) : fileKind === "video" ? (
                  fileMediaSrc ? <div className="gitlab-file-media"><video src={fileMediaSrc} controls /></div> : <div className="plugins-empty">无法预览该视频</div>
                ) : fileKind === "audio" ? (
                  fileMediaSrc ? <div className="gitlab-file-media"><audio src={fileMediaSrc} controls /></div> : <div className="plugins-empty">无法预览该音频</div>
                ) : fileKind === "structured" || filePreview ? (
                  <StructuredPreview path={filePath} content={fileContent} preview={filePreview} />
                ) : (fileKind === "markdown" || isMarkdownPath(filePath)) && fileView !== "edit" && fileRender === "preview" ? (
                  <MarkdownFilePreview path={filePath} content={fileContent} onOpenFile={(target) => void openFile(target)} />
                ) : isConfigPreviewPath(filePath) && fileView !== "edit" && fileRender === "preview" ? (
                  <ConfigFilePreview path={filePath} content={fileContent} />
                ) : (
                  <MonacoFileEditor path={filePath} value={fileContent} readOnly={fileView !== "edit"} onChange={fileView === "edit" ? setFileContent : undefined} onSave={() => void saveEdit()} />
                )}
              </div>
            )}
            {copied && <div className="gitlab-copied">已复制</div>}
          </div>
        )}

        {pane === "changes" && (
          <div className={`git-changes-panel${changesDiffHeight && !changesDiffMaximized ? " has-sized-diff" : ""}${changesDiffMaximized ? " is-diff-max" : ""}`}>
            <header className="git-changes-head">
              <strong>更改</strong>
              <span>
                {filteredFiles.length} 个文件
                {snapshot?.branch ? ` · ${snapshot.branch}` : ""}
                {snapshot?.ahead ? ` · 超前 ${snapshot.ahead}` : ""}
                {snapshot?.behind ? ` · 落后 ${snapshot.behind}` : ""}
              </span>
              <label>
                <UiIcon icon={icons.search} />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="筛选…" />
              </label>
            </header>
            <form className="git-commit-form" onSubmit={(event) => { event.preventDefault(); void submitInlineCommit(); }}>
              <textarea
                ref={commitRef}
                value={commitDraft}
                rows={2}
                placeholder={commitGenerating
                  ? "正在根据当前变更生成提交说明…"
                  : commitFlags(commitMode, Boolean(snapshot?.files?.some((item) => item.code[0] && item.code[0] !== " " && item.code[0] !== "?"))).amend
                    ? "提交说明（可空，空则保留原说明）"
                    : "提交说明"}
                onChange={(event) => { setCommitDraft(event.target.value); setCommitError(""); }}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                    event.preventDefault();
                    void submitInlineCommit();
                  }
                }}
              />
              <div className="git-commit-bar">
                <small>{commitModeLabel()} · {listedChanges(commitMode).length} 个文件</small>
                {commitError ? <em>{commitError}</em> : null}
                <button
                  type="button"
                  className="git-commit-generate"
                  disabled={busy || commitGenerating || !listedChanges(commitMode).length}
                  onClick={() => void generateCommitMessage(true, repoRoot)}
                >
                  <UiIcon icon={icons.compose} />
                  {commitGenerating ? "生成中…" : "生成说明"}
                </button>
                <button type="submit" disabled={busy || (!listedChanges(commitMode).length && !commitMode.includes("amend"))}>
                  {busy ? "提交中…" : commitModeLabel()}
                </button>
                {pushReady || (snapshot?.ahead || 0) > 0 ? (
                  <button type="button" className="git-commit-push" disabled={busy} onClick={() => void pushCurrent()}>
                    {snapshot?.ahead ? `推送 · ${snapshot.ahead}` : "推送"}
                  </button>
                ) : null}
              </div>
            </form>
            {filteredFiles.length === 0 ? <div className="plugins-empty">{loading ? "正在读取更改…" : "工作区干净"}</div> : changesDiffMaximized ? null : (
              <div className="git-changes-list">
                {filteredFiles.map((file) => {
                  const stats = diffFiles.find((item) => sameChangePath(item.path, file.path));
                  return (
                    <article className={`gitlab-card gitlab-card-open${sameChangePath(file.path, selectedChange) ? " selected" : ""}`} key={file.path}>
                      <button type="button" className="gitlab-card-main" onClick={() => setSelectedChange((current) => sameChangePath(current, file.path) ? "" : file.path)}>
                        <strong>{file.path}</strong>
                        <small>{changeLabel(file.code)}{stats ? ` · +${stats.added} −${stats.deleted}` : ` · ${file.code}`}</small>
                      </button>
                      <span className={`gitlab-state ${file.code.includes("?") ? "" : "open"}`}>{changeLabel(file.code)}</span>
                      <button type="button" className="gitlab-clone-action" disabled={busy} onClick={() => void runAction("还原文件", () => git.restoreFile(file.path))}>还原</button>
                    </article>
                  );
                })}
              </div>
            )}
            {visibleDiffs.length > 0 ? (
              <>
              {!changesDiffMaximized ? (
              <div
                className="panel-resize-handle panel-resize-bottom git-diff-resize"
                role="separator"
                aria-label="调整差异区域高度"
                onMouseDown={(event) => beginDiffResize(event, CHANGES_DIFF_HEIGHT_KEY, setChangesDiffHeight)}
                onDoubleClick={() => resetDiffHeight(CHANGES_DIFF_HEIGHT_KEY, setChangesDiffHeight)}
              />
              ) : null}
              <div className={`git-file-diff diff-review marker-color${changesDiffHeight && !changesDiffMaximized ? " is-sized" : ""}`} style={changesDiffHeight && !changesDiffMaximized ? { height: changesDiffHeight } : undefined}>
                <div className="git-file-diff-head">
                  <strong>{selectedDiff ? selectedDiff.path : `全部变更 · ${visibleDiffs.length} 个文件`}</strong>
                  {!selectedDiff && visibleDiffs.length > 1 ? (
                    <div className="git-diff-fold-actions">
                      <button type="button" onClick={() => setDiffFilesCollapsed(visibleDiffs.map((item) => item.path), false)}>全部展开</button>
                      <button type="button" onClick={() => setDiffFilesCollapsed(visibleDiffs.map((item) => item.path), true)}>全部折叠</button>
                    </div>
                  ) : null}
                  <span><b>+{visibleAdded}</b> <i>−{visibleDeleted}</i></span>
                  <button
                    type="button"
                    className="git-diff-max"
                    title={changesDiffMaximized ? "还原" : "最大化"}
                    aria-label={changesDiffMaximized ? "还原差异区域" : "最大化差异区域"}
                    onClick={() => setChangesDiffMaximized((current) => !current)}
                  >
                    <UiIcon icon={changesDiffMaximized ? icons.compress : icons.expand} />
                  </button>
                </div>
                <div className="git-file-diff-body">
                  {renderDiffFiles(visibleDiffs, !selectedDiff && visibleDiffs.length > 1)}
                </div>
              </div>
              </>
            ) : filteredFiles.length > 0 ? (
              <div className="plugins-empty">
                {diffText.trim()
                  ? (selectedChange ? "该文件没有文本差异，可能是二进制或重命名。" : "这些更改没有文本差异，可能是二进制或重命名。")
                  : "正在读取差异…"}
              </div>
            ) : null}
          </div>
        )}

        {pane === "graph" && (
          <div className="git-graph-panel">
            <div className="git-graph-toolbar">
              <label>
                <span>仓库</span>
                <select value={repoRoot} onChange={(event) => selectRepo(event.target.value)}>
                  {repos.map((item) => (
                    <option value={item.path} key={item.path}>{item.name}{item.branch ? ` · ${item.branch}` : ""}</option>
                  ))}
                </select>
              </label>
              <label>
                <span>分支</span>
                <select value={graphRef} onChange={(event) => setGraphRef(event.target.value)}>
                  <option value="">显示全部</option>
                  {branches.map((item) => (
                    <option value={item.name} key={item.name}>{item.current ? `${item.name} (当前)` : item.name}</option>
                  ))}
                </select>
              </label>
              <button type="button" className={!graphRef ? "active" : ""} onClick={() => setGraphRef("")}>显示全部</button>
              <label className="git-graph-check">
                <input type="checkbox" checked={graphRemotes} onChange={(event) => setGraphRemotes(event.target.checked)} />
                显示远程分支
              </label>
              <span className="git-graph-toolbar-count">{graphItems.length} 个提交</span>
            </div>
            {graphItems.length === 0 ? (
              <div className="plugins-empty">{loading ? "正在读取仓库图…" : "没有可显示的提交"}</div>
            ) : (
              <div className="git-graph-scroll">
                <GitGraph
                  commits={graphItems}
                  filter={query}
                  onOpenCommit={(sha, item) => void openGraphCommit(sha, item)}
                  onOpenFiles={(sha) => void openGraphCommit(sha)}
                />
                <div className="git-graph-more">
                  {graphShallow && <p>当前仓库是浅克隆，更早的提交不在本地。</p>}
                  {graphHasMore ? (
                    <button type="button" disabled={busy || loading} onClick={() => setGraphLimit((current) => Math.min(2000, current + 300))}>
                      加载更早的提交
                    </button>
                  ) : (
                    <p>{graphShallow ? "" : "已经到仓库最早的提交"}</p>
                  )}
                </div>
              </div>
            )}
            {graphCommit && (
              <>
              <div
                className="panel-resize-handle panel-resize-bottom git-diff-resize"
                role="separator"
                aria-label="调整提交差异高度"
                onMouseDown={(event) => beginDiffResize(event, GRAPH_DIFF_HEIGHT_KEY, setGraphDiffHeight)}
                onDoubleClick={() => resetDiffHeight(GRAPH_DIFF_HEIGHT_KEY, setGraphDiffHeight)}
              />
              <div className={`git-file-diff diff-review marker-color${graphDiffHeight ? " is-sized" : ""}`} style={graphDiffHeight ? { height: graphDiffHeight } : undefined}>
                <div className="git-file-diff-head">
                  <strong>{graphCommit.shortId || String(graphCommit.id || "").slice(0, 8)} · {graphCommit.title || "提交"}</strong>
                  <span>{graphCommit.authorName}{graphCommit.authoredDate ? ` · ${graphCommit.authoredDate}` : ""}</span>
                </div>
                {graphDiff.trim() ? (
                  <div className="git-file-diff-body">
                    {graphDiffFiles.length > 1 ? (
                      <div className="git-diff-fold-actions git-diff-fold-actions-inline">
                        <button type="button" onClick={() => setDiffFilesCollapsed(graphDiffFiles.map((item) => item.path), false)}>全部展开</button>
                        <button type="button" onClick={() => setDiffFilesCollapsed(graphDiffFiles.map((item) => item.path), true)}>全部折叠</button>
                      </div>
                    ) : null}
                    {renderDiffFiles(graphDiffFiles, graphDiffFiles.length > 1)}
                  </div>
                ) : (
                  <div className="plugins-empty">这个提交没有文本差异。</div>
                )}
              </div>
              </>
            )}
          </div>
        )}

        {pane !== "welcome" && pane !== "file" && pane !== "changes" && pane !== "graph" && (
          <div className="plugins-content gitlab-content git-ide-panel">
            <header className="plugins-heading">
              <h1>{paneTitle}</h1>
              <p>
                {repoRoot || workspaceRoot || "未选择工作区"}
                {snapshot?.isRepo ? ` · 当前 ${snapshot.branch || "HEAD"}` : " · 还不是 Git 仓库"}
                {snapshot?.ahead ? ` · 超前 ${snapshot.ahead}` : ""}
                {snapshot?.behind ? ` · 落后 ${snapshot.behind}` : ""}
              </p>
            </header>
            <label className="plugins-search">
              <UiIcon icon={icons.search} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前列表" />
            </label>

            {pane === "branches" && (
              <section className="plugins-section">
                <div className="plugins-section-heading">
                  <h2>分支</h2>
                  <span>{filteredBranches.length}</span>
                  <button type="button" className="plugins-add" disabled={busy} onClick={() => openPrompt("createBranch", "", "", repoRoot)}><UiIcon icon={icons.plus} /> 新建分支</button>
                </div>
                {filteredBranches.length === 0 ? <div className="plugins-empty">{loading ? "正在读取分支…" : "没有本地分支"}</div> : (
                  <div className="gitlab-list">
                    {filteredBranches.map((branch) => (
                      <article className="gitlab-card gitlab-card-open" key={branch.name}>
                        <button type="button" className="gitlab-card-main" disabled={busy || branch.current} onClick={() => void runAction("签出", () => git.checkout(branch.name))}>
                          <strong>{branch.name}</strong>
                          <small>{[branch.sha, branch.upstream].filter(Boolean).join(" · ") || "本地分支"}</small>
                        </button>
                        {branch.current && <span className="gitlab-state open">当前</span>}
                        {!branch.current && <button type="button" className="gitlab-clone-action" disabled={busy} onClick={() => void runAction("签出", () => git.checkout(branch.name))}>签出</button>}
                        {!branch.current && <button type="button" title="删除" onClick={() => openPrompt("deleteBranch", "", branch.name, repoRoot)}><UiIcon icon={icons.trash} /></button>}
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}

            {pane === "remotes" && (
              <section className="plugins-section">
                <div className="plugins-section-heading">
                  <h2>远端</h2>
                  <div className="plugins-section-heading-actions">
                    <span>{filteredRemotes.length}</span>
                    <button type="button" className="plugins-add" disabled={busy} onClick={() => beginAddRemote(repoRoot)}><UiIcon icon={icons.plus} /> 添加远端</button>
                  </div>
                </div>
                {filteredRemotes.length === 0 ? <div className="plugins-empty">{loading ? "正在读取远端…" : "还没有远端。可以从 GitHub / GitLab 项目添加，或填写自定义地址。"}</div> : (
                  <div className="gitlab-list">
                    {filteredRemotes.map((remote) => (
                      <article className="gitlab-card" key={`${remote.name}:${remote.url}`}>
                        <div>
                          <strong>{remote.name}</strong>
                          <small>{remote.url}</small>
                        </div>
                        <button type="button" className="gitlab-clone-action" disabled={busy} onClick={() => void runAction("抓取", () => git.fetch(remote.name))}>抓取</button>
                        <button type="button" title="删除远端" onClick={() => openPrompt("deleteRemote", "", remote.name, repoRoot)}><UiIcon icon={icons.trash} /></button>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}

            {pane === "stash" && (
              <section className="plugins-section">
                <div className="plugins-section-heading">
                  <h2>贮藏</h2>
                  <span>{filteredStashes.length}</span>
                  <button type="button" className="plugins-add" disabled={busy} onClick={() => openPrompt("stash", "", "", repoRoot)}><UiIcon icon={icons.plus} /> 贮藏更改</button>
                </div>
                {filteredStashes.length === 0 ? <div className="plugins-empty">{loading ? "正在读取贮藏…" : "没有贮藏"}</div> : (
                  <div className="gitlab-list">
                    {filteredStashes.map((item) => (
                      <article className="gitlab-card" key={item.label}>
                        <div>
                          <strong>{item.label}</strong>
                          <small>本地贮藏</small>
                        </div>
                        <button type="button" className="gitlab-clone-action" disabled={busy} onClick={() => void runAction("查看储藏", () => git.stashShow(item.label)).then(() => setPane("output"))}>查看</button>
                        <button type="button" className="gitlab-clone-action" disabled={busy} onClick={() => void runAction("应用储藏", () => git.stashApply(item.label))}>应用</button>
                        <button type="button" className="gitlab-clone-action" disabled={busy} onClick={() => void runAction("弹出储藏", () => git.stashPop(item.label))}>弹出</button>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}

            {pane === "tags" && (
              <section className="plugins-section">
                <div className="plugins-section-heading">
                  <h2>标签</h2>
                  <span>{filteredTags.length}</span>
                  <button type="button" className="plugins-add" disabled={busy} onClick={() => openPrompt("createTag", "", "", repoRoot)}><UiIcon icon={icons.plus} /> 创建标签</button>
                </div>
                {filteredTags.length === 0 ? <div className="plugins-empty">{loading ? "正在读取标签…" : "没有标签"}</div> : (
                  <div className="gitlab-list">
                    {filteredTags.map((tag) => (
                      <article className="gitlab-card gitlab-card-open" key={tag.name}>
                        <button type="button" className="gitlab-card-main" disabled={busy} onClick={() => void runAction("签出", () => git.checkout(tag.name))}>
                          <strong>{tag.name}</strong>
                          <small>{[tag.sha, tag.date].filter(Boolean).join(" · ") || "标签"}</small>
                        </button>
                        <span className="gitlab-state merged">标签</span>
                        <button type="button" title="删除" onClick={() => openPrompt("deleteTag", "", tag.name, repoRoot)}><UiIcon icon={icons.trash} /></button>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}

            {pane === "output" && (
              <section className="plugins-section">
                <div className="plugins-section-heading"><h2>Git 输出</h2><span>{filteredLogs.length}</span></div>
                {filteredLogs.length === 0 ? <div className="plugins-empty">还没有命令输出</div> : (
                  <div className="gitlab-list">
                    {filteredLogs.map((item) => (
                      <article className="gitlab-card git-output-card" key={item.id}>
                        <div>
                          <strong>{item.title}</strong>
                          <pre className="git-output-text">{item.text}</pre>
                        </div>
                        <span className={`gitlab-state ${item.ok ? "open" : "closed"}`}>{item.ok ? "成功" : "失败"}</span>
                      </article>
                    ))}
                  </div>
                )}
              </section>
            )}
          </div>
        )}
      </div>

      {addRemoteOpen && (
        <div className="new-project-modal-backdrop" role="presentation" onMouseDown={() => !busy && setAddRemoteOpen(false)}>
          <form className="new-project-modal" role="dialog" aria-modal="true" aria-labelledby="add-remote-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submitAddRemote(); }}>
            <div className="new-project-modal-head">
              <h2 id="add-remote-title">添加远端</h2>
              <button type="button" title="关闭" disabled={busy} onClick={() => setAddRemoteOpen(false)}><UiIcon icon={icons.close} /></button>
            </div>
            <p className="gitlab-clone-target">可从已配置的 GitHub / GitLab 项目选择，也可以填写自定义地址，或先新建仓库再添加。</p>
            <strong className="new-project-source-label">来源</strong>
            <div className="settings-segment gitlab-clone-protocol" role="radiogroup" aria-label="远端来源">
              <button type="button" role="radio" aria-checked={remoteSource === "custom"} className={remoteSource === "custom" ? "selected" : ""} onClick={() => setRemoteSource("custom")}>自定义</button>
              {githubConfigured && <button type="button" role="radio" aria-checked={remoteSource === "github"} className={remoteSource === "github" ? "selected" : ""} onClick={() => { setRemoteSource("github"); void loadHosted("github", hostedQuery); }}>GitHub</button>}
              {gitlabConfigured && <button type="button" role="radio" aria-checked={remoteSource === "gitlab"} className={remoteSource === "gitlab" ? "selected" : ""} onClick={() => { setRemoteSource("gitlab"); void loadHosted("gitlab", hostedQuery); }}>GitLab</button>}
            </div>
            {!githubConfigured && !gitlabConfigured && <div className="plugins-message">尚未配置 GitHub / GitLab 连接，可先到设置里添加，或直接使用自定义地址。</div>}
            <label className="new-project-name">
              <span>远端名称</span>
              <input value={remoteName} onChange={(event) => setRemoteName(event.target.value)} placeholder="origin" required />
            </label>
            {remoteSource === "custom" ? (
              <label className="new-project-name">
                <span>地址</span>
                <input value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="https://github.com/org/repo.git" required />
              </label>
            ) : (
              <>
                <strong className="new-project-source-label">协议</strong>
                <div className="settings-segment gitlab-clone-protocol" role="radiogroup" aria-label="协议">
                  <button type="button" role="radio" aria-checked={remoteProtocol === "https"} className={remoteProtocol === "https" ? "selected" : ""} onClick={() => setRemoteProtocol("https")}>HTTPS</button>
                  <button type="button" role="radio" aria-checked={remoteProtocol === "ssh"} className={remoteProtocol === "ssh" ? "selected" : ""} onClick={() => setRemoteProtocol("ssh")}>SSH</button>
                </div>
                <label className="plugins-search">
                  <UiIcon icon={icons.search} />
                  <input
                    value={hostedQuery}
                    onChange={(event) => {
                      setHostedQuery(event.target.value);
                      void loadHosted(remoteSource, event.target.value);
                    }}
                    placeholder={`搜索可管理的${hostedLabel}项目`}
                  />
                </label>
                {hostedBusy ? <div className="plugins-empty">正在读取{hostedLabel}项目…</div> : filteredHosted.length === 0 ? <div className="plugins-empty">没有可列出的项目</div> : (
                  <div className="gitlab-list">
                    {filteredHosted.map((project) => {
                      const url = remoteProtocol === "ssh" ? (project.sshUrl || project.httpUrl) : (project.httpUrl || project.sshUrl);
                      return (
                        <article className="gitlab-card" key={`${project.pathWithNamespace}:${url}`}>
                          <div>
                            <strong>{project.pathWithNamespace || project.name}</strong>
                            <small>{[project.visibility, project.defaultBranch, url].filter(Boolean).join(" · ")}</small>
                          </div>
                          {project.webUrl && <button type="button" title="打开" onClick={() => void api.app.openExternalUrl(project.webUrl || "")}><UiIcon icon={icons.external} /></button>}
                          <button type="button" className="gitlab-clone-action" onClick={() => pickHosted(project)}>{url && remoteUrl === url ? "已选用" : "选用"}</button>
                        </article>
                      );
                    })}
                  </div>
                )}
                <button type="button" className="plugins-add" onClick={() => { setCreateOpen((open) => !open); setCreateMessage(""); }}>
                  <UiIcon icon={icons.plus} /> {createOpen ? "收起新建" : `新建${hostedLabel}仓库`}
                </button>
                {createOpen && (
                  <div className="gitlab-create-form">
                    <input value={createName} onChange={(event) => setCreateName(event.target.value)} placeholder="仓库名，例如 local-codex 或 owner/name" />
                    <input value={createOwner} onChange={(event) => setCreateOwner(event.target.value)} placeholder="所有者，可空" />
                    <textarea value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} placeholder="说明（可选）" rows={3} />
                    <label className="gitlab-clone-shallow"><input type="checkbox" checked={createPrivate} onChange={(event) => setCreatePrivate(event.target.checked)} /> 私有仓库</label>
                    <label className="gitlab-clone-shallow"><input type="checkbox" checked={createReadme} onChange={(event) => setCreateReadme(event.target.checked)} /> 用 README 初始化</label>
                    {createCheck && <div className="plugins-message">{[createCheck.login ? `登录 ${createCheck.login}` : "", createCheck.fullName, createCheck.exists ? "已存在" : createCheck.canCreate ? "可以创建" : ""].filter(Boolean).join(" · ")}</div>}
                    {createMessage && <div className="plugins-message">{createMessage}</div>}
                    <div className="gitlab-create-actions">
                      <button type="button" onClick={() => setCreateOpen(false)}>取消</button>
                      <button type="button" className="plugins-add" disabled={hostedBusy || !createName.trim()} onClick={() => void runCreateHostedRepo()}>{hostedBusy ? "处理中…" : "创建并选用"}</button>
                    </div>
                  </div>
                )}
                <label className="new-project-name">
                  <span>将使用的地址</span>
                  <input value={remoteUrl} onChange={(event) => setRemoteUrl(event.target.value)} placeholder="选择项目后自动填入，也可手改" />
                </label>
              </>
            )}
            <label className="gitlab-clone-shallow">
              <input type="checkbox" checked={overwriteRemote} onChange={(event) => setOverwriteRemote(event.target.checked)} />
              若同名远端已存在则覆盖地址
            </label>
            <div className="new-project-modal-actions">
              <button type="button" className="new-project-cancel" disabled={busy} onClick={() => setAddRemoteOpen(false)}>取消</button>
              <button type="submit" className="new-project-submit" disabled={busy || !remoteName.trim() || !remoteUrl.trim()}>{busy ? "处理中…" : "添加"}</button>
            </div>
          </form>
        </div>
      )}

      {cloneOpen && (
        <div className="new-project-modal-backdrop" role="presentation" onMouseDown={() => !busy && setCloneOpen(false)}>
          <form className="new-project-modal" role="dialog" aria-modal="true" aria-labelledby="clone-git-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); void submitClone(); }}>
            <div className="new-project-modal-head">
              <h2 id="clone-git-title">克隆项目</h2>
              <button type="button" title="关闭" disabled={busy} onClick={() => setCloneOpen(false)}><UiIcon icon={icons.close} /></button>
            </div>
            <p className="gitlab-clone-target">克隆任意 Git 地址到指定目录，不必打开当前工作区。</p>
            <label className="new-project-name">
              <span>地址</span>
              <input value={cloneUrl} onChange={(event) => setCloneUrl(event.target.value)} placeholder="https://github.com/org/repo.git" required />
            </label>
            <label className="gitlab-clone-shallow">
              <input type="checkbox" checked={cloneShallow} onChange={(event) => setCloneShallow(event.target.checked)} />
              浅克隆（只取最近一次提交）
            </label>
            <strong className="new-project-source-label">目标目录</strong>
            <button type="button" className={`new-project-source ${cloneParent ? "selected" : ""}`} onClick={() => void pickCloneParent()}>
              <UiIcon icon={cloneParent ? icons.folderOpen : icons.folder} />
              <span>{cloneParent || "选择要克隆到的文件夹"}</span>
            </button>
            <label className="new-project-name">
              <UiIcon icon={icons.folder} />
              <input value={cloneName} onChange={(event) => setCloneName(event.target.value)} placeholder="仓库文件夹名" />
            </label>
            {cloneMessage && <div className={clonePath || busy ? "plugins-message" : "new-project-error"}>{cloneMessage}</div>}
            {clonePath && (
              <div className="gitlab-clone-next">
                <strong className="new-project-source-label">接下来</strong>
                <button type="button" className="new-project-source selected" onClick={() => { setCloneOpen(false); void onOpenCloneWorkspace?.(clonePath); }}>
                  <UiIcon icon={icons.plus} />
                  <span>用这个仓库打开工作区</span>
                  <small>{clonePath}</small>
                </button>
              </div>
            )}
            <div className="new-project-modal-actions">
              <button type="button" className="new-project-cancel" disabled={busy} onClick={() => setCloneOpen(false)}>取消</button>
              {clonePath && <button type="button" onClick={() => void api.workspace.reveal(clonePath)}>打开目录</button>}
              {!clonePath && <button type="submit" className="new-project-submit" disabled={busy}>{busy ? "克隆中…" : "克隆"}</button>}
            </div>
          </form>
        </div>
      )}

      {openDialog && (
        <AppDialog
          title={
            openDialog === "checkout" ? "签出到…"
              : openDialog === "deleteRemote" ? "删除远程存储库"
                : openDialog === "deleteBranch" ? "删除分支…"
                  : openDialog === "deleteTag" ? "删除标签…"
                    : openDialog === "deleteRemoteBranch" ? "删除远程分支…"
                      : openDialog === "deleteRemoteTag" ? "删除远程标记…"
                        : openDialog === "newFile" ? "新建文件"
                          : openDialog === "newFolder" ? "新建文件夹"
                            : openDialog === "renameFile" ? "重命名"
                              : openDialog === "commit" ? (
                                dialogMode.includes("amend") ? "提交(修改)"
                                  : dialogMode.includes("sign") ? "提交(已署名)"
                                    : dialogMode === "commit-signoff" ? "提交(签收)"
                                      : "提交"
                              )
                                : openDialog === "createBranch" ? "创建分支…"
                                  : openDialog === "createBranchFrom" ? "从现有来源创建新的分支…"
                                    : openDialog === "createBranchStart" ? "选择来源"
                                      : openDialog === "renameBranch" ? "重命名分支…"
                                        : openDialog === "merge" ? "合并…"
                                          : openDialog === "rebase" ? "变基分支…"
                                            : openDialog === "createTag" ? "创建标记…"
                                              : openDialog === "stash" ? (
                                                dialogMode === "stash-untracked" ? "储藏(包含未跟踪)"
                                                  : dialogMode === "stash-staged" ? "储藏暂存"
                                                    : "储藏"
                                              )
                                                : openDialog === "stashPick" ? (
                                                  dialogMode === "stash-pop" ? "弹出储藏…"
                                                    : dialogMode === "stash-drop" ? "删除储藏…"
                                                      : dialogMode === "stash-show" ? "查看储藏条目…"
                                                        : "应用储藏…"
                                                )
                                                  : openDialog === "pullFrom" ? "拉取自…"
                                                    : openDialog === "pushTo" ? (dialogMode === "publish" ? "发布分支…" : "推送到…")
                                                      : "删除文件"
          }
          message={
            openDialog === "checkout" ? "签出到本地分支、标签或提交。"
              : openDialog === "newFile" ? `在 ${targetName || workspaceName} 创建文件`
                : openDialog === "newFolder" ? `在 ${targetName || workspaceName} 创建文件夹`
                  : openDialog === "renameFile" ? `重命名 ${targetName}`
                    : openDialog === "commit" ? (
                      `${
                        dialogMode.includes("amend") ? "修改上次提交。说明可空，空则保留原说明。"
                          : dialogMode === "commit-staged" || dialogMode === "commit-sign-staged" ? "只提交已暂存文件。"
                            : dialogMode === "commit-all" || dialogMode === "commit-sign-all" || dialogMode === "commit-amend-all" ? "暂存全部更改后提交。"
                              : dialogMode === "commit-signoff" ? "提交并追加 Signed-off-by。"
                                : "提交当前更改。"
                      }\n\n${changeSummary(dialogMode)}`
                    )
                      : openDialog === "createBranch" ? "创建并检出新分支。"
                        : openDialog === "createBranchFrom" ? "先填写新分支名。"
                          : openDialog === "createBranchStart" ? `从现有来源创建 ${targetName}。`
                            : openDialog === "renameBranch" ? "重命名当前分支。"
                              : openDialog === "merge" ? `把选定分支合并到 ${snapshot?.branch || "当前分支"}。右侧显示全部分支。`
                                : openDialog === "rebase" ? `把 ${snapshot?.branch || "当前分支"} 变基到选定分支。右侧显示全部分支。`
                                  : openDialog === "createTag" ? "在当前提交上创建标签。"
                                    : openDialog === "stash" ? `贮藏当前工作区更改，说明可空。\n\n${changeSummary(dialogMode)}`
                                      : openDialog === "stashPick" ? "选择一条贮藏。右侧会显示贮藏列表。"
                                        : openDialog === "pullFrom" ? "从指定远端拉取当前分支。"
                                          : openDialog === "pushTo" ? (dialogMode === "publish" ? "把当前分支发布到选定远端。" : "推送到指定远端。")
                                            : openDialog === "deleteRemote" ? "删除选定的远程存储库。"
                                              : openDialog === "deleteBranch" ? "删除选定的本地分支。"
                                                : openDialog === "deleteTag" ? "删除选定的本地标签。"
                                                  : openDialog === "deleteRemoteBranch" ? "从远端删除选定分支。"
                                                    : openDialog === "deleteRemoteTag" ? "从远端删除选定标记。"
                                                      : `确认删除 ${targetName}？`
          }
          value={openDialog === "deleteFile" && !dialogOptions ? undefined : draft}
          placeholder={
            openDialog === "checkout" || openDialog === "createBranchStart" ? "分支 / 标签 / 提交"
              : openDialog === "commit" ? "提交说明"
                : openDialog === "createBranch" || openDialog === "createBranchFrom" || openDialog === "renameBranch" ? "例如 feature/local-search"
                  : openDialog === "createTag" ? "例如 v0.1.0"
                    : openDialog === "stash" ? "贮藏说明（可选）"
                      : openDialog === "pullFrom" || openDialog === "pushTo" ? "远端名称，例如 origin"
                        : openDialog === "newFile" || openDialog === "newFolder" || openDialog === "renameFile" ? "名称"
                          : undefined
          }
          options={dialogOptions}
          multiline={openDialog === "commit"}
          confirmLabel={
            openDialog === "deleteFile" || openDialog === "deleteRemote" || openDialog === "deleteBranch" || openDialog === "deleteTag" || openDialog === "deleteRemoteBranch" || openDialog === "deleteRemoteTag" || dialogMode === "stash-drop" ? "删除"
              : openDialog === "checkout" ? "签出"
                : openDialog === "renameFile" || openDialog === "renameBranch" ? "重命名"
                  : openDialog === "commit" ? "提交"
                    : openDialog === "stash" ? "贮藏"
                      : openDialog === "stashPick" ? (dialogMode === "stash-pop" ? "弹出" : dialogMode === "stash-show" ? "查看" : dialogMode === "stash-drop" ? "删除" : "应用")
                        : openDialog === "pullFrom" ? "拉取"
                          : openDialog === "pushTo" ? (dialogMode === "publish" ? "发布" : "推送")
                            : openDialog === "merge" ? "合并"
                              : openDialog === "rebase" ? "变基"
                                : "创建"
          }
          error={dialogError}
          busy={busy}
          onChange={openDialog === "deleteFile" && !dialogOptions ? undefined : (value) => { setDraft(value); setDialogError(""); }}
          onConfirm={(value) => {
            if (openDialog === "newFile" || openDialog === "newFolder" || openDialog === "renameFile" || openDialog === "deleteFile") {
              void submitFileDialog(value);
              return;
            }
            void submitDialog(value);
          }}
          onCancel={() => { setOpenDialog(null); setDialogOptions(undefined); setDialogMode(""); }}
        />
      )}
      {confirm.node}
    </section>
  );
}
