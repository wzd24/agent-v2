import { convertFileSrc } from "@tauri-apps/api/core";
import React from "react";
import {
  api,
  GitBranch,
  GitHostRepoCheck,
  GitLabProject,
  GitSnapshot,
  GitTag,
} from "../api";
import { useCoverBrowser } from "../coverBrowser";
import { AppDialog, useAppDialog } from "./AppDialog";
import { MonacoFileEditor } from "./MonacoFileEditor";
import { ConfigFilePreview, isMarkdownPath, MarkdownFilePreview, StructuredPreview } from "./WorkspacePanel";
import { isConfigPreviewPath } from "../monacoLanguage";
import { icons, UiIcon } from "./UiIcon";

type FileKind = "text" | "markdown" | "image" | "structured" | "video" | "audio" | "binary";

type TabKey = "files" | "overview" | "changes" | "branches" | "remotes" | "stash" | "tags" | "output";
type FileItem = {
  name: string;
  path: string;
  type: "tree" | "blob" | string;
  lastCommitId?: string;
  lastCommitTitle?: string;
  lastCommitAuthor?: string;
  lastCommitDate?: string;
  children?: FileItem[];
};
type RemoteSource = "custom" | "github" | "gitlab";
type DialogKind = null | "checkout" | "deleteRemote" | "deleteBranch" | "deleteTag" | "newFile" | "newFolder" | "renameFile" | "deleteFile";
type LogItem = { id: number; title: string; ok: boolean; text: string };
type ActionItem = { title: string; detail: string; label: string; run: () => void; hidden?: boolean };

const TABS: Array<{ key: TabKey; label: string; icon: typeof icons.branch }> = [
  { key: "files", label: "文件", icon: icons.folder },
  { key: "overview", label: "概览", icon: icons.activity },
  { key: "changes", label: "更改", icon: icons.fileCode },
  { key: "branches", label: "分支", icon: icons.branch },
  { key: "remotes", label: "远端", icon: icons.globe },
  { key: "stash", label: "贮藏", icon: icons.download },
  { key: "tags", label: "标签", icon: icons.tag },
  { key: "output", label: "输出", icon: icons.terminal },
];

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

function parentDir(filePath: string) {
  return filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
}

function relativeTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (Math.abs(minutes) < 1) return "刚刚";
  if (Math.abs(minutes) < 60) return `${Math.abs(minutes)}分钟前`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${Math.abs(hours)}小时前`;
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return `${Math.abs(days)}天前`;
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(date);
}

function RefSelect({
  value,
  options,
  onChange,
  placeholder = "选择分支",
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const names = value && !options.includes(value) ? [value, ...options] : options;
  React.useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [open]);
  return (
    <div className={`gitlab-ref-select ${open ? "open" : ""}`} ref={rootRef}>
      <button type="button" aria-haspopup="listbox" aria-expanded={open} title={value || placeholder} onClick={() => setOpen((current) => !current)}>
        <UiIcon icon={icons.branch} />
        <span>{value || placeholder}</span>
        <UiIcon icon={icons.down} />
      </button>
      {open && (
        <div className="gitlab-ref-menu" role="listbox">
          {names.length === 0 ? <div className="gitlab-ref-empty">没有分支</div> : names.map((name) => (
            <button type="button" role="option" aria-selected={name === value} className={name === value ? "active" : ""} key={name} onClick={() => { onChange(name); setOpen(false); }}>
              {name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function matchesQuery(query: string, ...parts: Array<string | undefined>) {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return parts.join(" ").toLowerCase().includes(needle);
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
  const [tab, setTab] = React.useState<TabKey>("files");
  const [treePath, setTreePath] = React.useState("");
  const [treeItems, setTreeItems] = React.useState<FileItem[]>([]);
  const [treeIndex, setTreeIndex] = React.useState<FileItem[]>([]);
  const [treeQuery, setTreeQuery] = React.useState("");
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
  const [latestCommit, setLatestCommit] = React.useState<{ id?: string; shortId?: string; title?: string; authorName?: string; authoredDate?: string } | null>(null);
  const [codeMenuOpen, setCodeMenuOpen] = React.useState(false);
  const [newMenuOpen, setNewMenuOpen] = React.useState(false);
  const [editMenuOpen, setEditMenuOpen] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Record<string, FileItem[]>>({});
  const [copied, setCopied] = React.useState(false);
  const [query, setQuery] = React.useState("");
  const [snapshot, setSnapshot] = React.useState<GitSnapshot | null>(null);
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
  const [creatingCommit, setCreatingCommit] = React.useState(false);
  const [creatingBranch, setCreatingBranch] = React.useState(false);
  const [creatingTag, setCreatingTag] = React.useState(false);
  const [creatingStash, setCreatingStash] = React.useState(false);
  const [commitTitle, setCommitTitle] = React.useState("");
  const [branchName, setBranchName] = React.useState("");
  const [tagName, setTagName] = React.useState("");
  const [stashMessage, setStashMessage] = React.useState("");
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
  const [cloneMessage, setCloneMessage] = React.useState("");
  useCoverBrowser(addRemoteOpen || cloneOpen);

  const log = React.useCallback((title: string, ok: boolean, text: string) => {
    const detail = String(text || "").trim();
    setLogs((old) => [{ id: Date.now() + Math.random(), title, ok, text: detail || (ok ? "完成" : "失败") }, ...old].slice(0, 80));
    setMessage(detail || (ok ? `${title}完成` : `${title}失败`));
  }, []);

  const repoName = workspaceRoot.split(/[\\/]/).filter(Boolean).pop() || "repository";
  const crumbs = treePath.split("/").filter(Boolean);
  const fileName = filePath.split("/").pop() || "";
  const filteredTree = treeItems.filter((item) => matchesQuery(query, item.name, item.lastCommitTitle));
  const treePathRef = React.useRef(treePath);
  const tabRef = React.useRef(tab);
  treePathRef.current = treePath;
  tabRef.current = tab;

  const loadFiles = React.useCallback(async (path: string) => {
    try {
      const listed = await api.git.listPath(path, true);
      setTreeItems(listed.items || []);
      setLatestCommit(listed.latest || null);
      setExpanded((old) => ({ ...old, [path]: listed.items || [] }));
      if (!path) setTreeIndex(listed.items || []);
      const parts = path.split("/").filter(Boolean);
      let acc = "";
      for (let index = 0; index < parts.length; index += 1) {
        const parent = acc;
        acc = acc ? `${acc}/${parts[index]}` : parts[index];
        if (parent === path) continue;
        const parentList = await api.git.listPath(parent, false);
        setExpanded((old) => ({ ...old, [parent]: parentList.items || [] }));
      }
    } catch (error) {
      setMessage(errorText(error));
    }
  }, []);

  const refresh = React.useCallback(async () => {
    setLoading(true);
    try {
      const [next, branchList, tagList, stashList] = await Promise.all([
        api.git.snapshot(),
        api.git.branches().catch(() => ({ items: [] as GitBranch[] })),
        api.git.tags().catch(() => ({ items: [] as GitTag[] })),
        api.git.stashList().catch(() => ({ items: [] as Array<{ label: string }> })),
      ]);
      setSnapshot(next);
      setBranches(branchList.items || []);
      setTags(tagList.items || []);
      setStashes(stashList.items || []);
      if (tabRef.current === "files") await loadFiles(treePathRef.current);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [loadFiles]);

  React.useEffect(() => {
    setTreePath("");
    setFilePath("");
    setFileContent("");
    setFileKind("text");
    setFilePreview(undefined);
    setFileMediaSrc("");
    setFileError("");
    setExpanded({});
    setTreeIndex([]);
    setTreeItems([]);
  }, [workspaceRoot]);

  React.useEffect(() => {
    void refresh();
  }, [refresh, workspaceRoot]);

  React.useEffect(() => {
    if (tab === "files") void loadFiles(treePath);
  }, [tab, treePath, loadFiles]);

  function joinWorkspace(relative: string) {
    if (!relative) return workspaceRoot;
    return `${workspaceRoot.replace(/[\\/]+$/, "")}/${relative}`.replace(/\//g, workspaceRoot.includes("\\") ? "\\" : "/");
  }

  function resetOpenedFile() {
    setFilePath("");
    setFileContent("");
    setFileKind("text");
    setFilePreview(undefined);
    setFileMediaSrc("");
    setFileError("");
    setFileView("view");
    setFileRender("preview");
  }

  async function openDirectory(path: string) {
    resetOpenedFile();
    setTreePath(path);
  }

  async function openFile(path: string) {
    const absolute = joinWorkspace(path);
    const kind = kindForPath(path);
    setFilePath(path);
    setFileKind(kind);
    setFileView("view");
    setFileRender("preview");
    setFilePreview(undefined);
    setFileMediaSrc("");
    setFileError("");
    setFileContent("");
    setFileLoading(true);
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

  function openPath(item: FileItem) {
    if (item.type === "tree") void openDirectory(item.path);
    else void openFile(item.path);
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
      await api.workspace.writeFile(joinWorkspace(filePath), fileContent);
      setFileView("view");
      setMessage(`已保存 ${fileName}`);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setEditSaving(false);
    }
  }

  async function submitFileDialog(value: string) {
    const name = value.trim();
    if (openDialog === "newFile" || openDialog === "newFolder") {
      if (!name) { setDialogError("名称不能为空"); return; }
      const kind = openDialog === "newFolder" ? "directory" : "file";
      try {
        const created = await api.workspace.createEntry(joinWorkspace(treePath), name, kind);
        setOpenDialog(null);
        await loadFiles(treePath);
        if (kind === "file") await openFile(created.relativePath.replace(/\\/g, "/"));
      } catch (error) {
        setDialogError(errorText(error));
      }
      return;
    }
    if (openDialog === "renameFile") {
      if (!name) { setDialogError("名称不能为空"); return; }
      try {
        await api.workspace.renameEntry(joinWorkspace(targetName), name);
        setOpenDialog(null);
        resetOpenedFile();
        await loadFiles(treePath);
      } catch (error) {
        setDialogError(errorText(error));
      }
      return;
    }
    if (openDialog === "deleteFile") {
      try {
        await api.workspace.deleteEntry(joinWorkspace(targetName));
        setOpenDialog(null);
        if (filePath === targetName || filePath.startsWith(`${targetName}/`)) resetOpenedFile();
        await loadFiles(treePath);
      } catch (error) {
        setDialogError(errorText(error));
      }
    }
  }

  async function runAction<T extends { ok?: boolean; output?: string }>(title: string, task: () => Promise<T>): Promise<T | { ok: false; output: string }> {
    setBusy(true);
    try {
      const result = await task();
      log(title, result.ok !== false, result.output || "");
      if (result.ok !== false) {
        await refresh();
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

  function openPrompt(kind: DialogKind, initial = "", name = "") {
    setOpenDialog(kind);
    setDraft(initial);
    setTargetName(name);
    setDialogError("");
  }

  async function submitDialog(value: string) {
    const text = value.trim();
    if (openDialog === "checkout") {
      if (!text) { setDialogError("请填写分支、标签或提交"); return; }
      const result = await runAction("签出", () => api.git.checkout(text));
      if (result.ok === false) { setDialogError(result.output || "签出失败"); return; }
    } else if (openDialog === "deleteRemote") {
      const result = await runAction("删除远端", () => api.git.removeRemote(targetName));
      if (result.ok === false) { setDialogError(result.output || "删除失败"); return; }
    } else if (openDialog === "deleteBranch") {
      const result = await runAction("删除分支", () => api.git.deleteBranch(targetName));
      if (result.ok === false) { setDialogError(result.output || "删除失败"); return; }
    } else if (openDialog === "deleteTag") {
      const result = await runAction("删除标签", () => api.git.deleteTag(targetName));
      if (result.ok === false) { setDialogError(result.output || "删除失败"); return; }
    }
    setOpenDialog(null);
  }

  function beginAddRemote() {
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
      await refresh();
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
        ? await api.git.setRemoteUrl(remoteName.trim(), remoteUrl.trim())
        : await api.git.addRemote(remoteName.trim(), remoteUrl.trim());
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

  async function applyPatchFromFile() {
    const picked = await api.import.open();
    if (picked.canceled || !picked.content) return;
    await runAction("应用补丁", () => api.git.applyPatch(picked.content || ""));
  }

  async function savePatch(kind: "staged" | "unstaged") {
    const result = await api.git.createPatch(kind);
    if (result.empty || !result.output?.trim()) {
      setMessage(kind === "staged" ? "没有已暂存的更改" : "没有未暂存的更改");
      return;
    }
    const saved = await api.export.save(result.output, kind === "staged" ? "staged.patch" : "unstaged.patch");
    if (!saved.canceled && saved.path) setMessage(`已保存补丁 ${saved.path}`);
  }

  const remotes = snapshot?.remotes || [];
  const files = snapshot?.files || [];
  const hostedLabel = remoteSource === "github" ? "GitHub" : "GitLab";
  const filteredHosted = hostedProjects.filter((item) => matchesQuery(hostedQuery, item.pathWithNamespace, item.name, item.description));
  const filteredFiles = files.filter((item) => matchesQuery(query, item.path, changeLabel(item.code)));
  const filteredBranches = branches.filter((item) => matchesQuery(query, item.name, item.upstream, item.sha));
  const filteredRemotes = remotes.filter((item) => matchesQuery(query, item.name, item.url, item.host));
  const filteredStashes = stashes.filter((item) => matchesQuery(query, item.label));
  const filteredTags = tags.filter((item) => matchesQuery(query, item.name, item.sha, item.date));
  const filteredLogs = logs.filter((item) => matchesQuery(query, item.title, item.text));

  const overviewActions: ActionItem[] = snapshot?.isRepo
    ? [
        { title: "拉取", detail: "从跟踪远端取回并合并到当前分支", label: "拉取", run: () => void runAction("拉取", () => api.git.pull()) },
        { title: "推送", detail: `推送到 ${remotes[0]?.name || "origin"}`, label: "推送", run: () => void runAction("推送", () => api.git.pushTo(remotes[0]?.name || "origin")) },
        { title: "抓取", detail: "抓取全部远端，不合并本地", label: "抓取", run: () => void runAction("抓取", () => api.git.fetch()) },
        { title: "克隆", detail: "克隆任意仓库到指定目录", label: "克隆", run: () => beginClone() },
        { title: "签出到…", detail: "签出到本地分支、标签或提交", label: "签出", run: () => openPrompt("checkout", snapshot.branch) },
        { title: "提交", detail: "暂存工作区全部更改后提交", label: "提交", run: () => { setTab("changes"); setCreatingCommit(true); } },
        { title: "拉取，推送", detail: "先拉取再推送到当前远端", label: "拉取并推送", run: () => void runAction("拉取", () => api.git.pull()).then((result) => { if (result.ok !== false) void runAction("推送", () => api.git.pushTo(remotes[0]?.name || "origin")); }) },
        { title: "拉取并变基", detail: "用 rebase 方式拉取", label: "变基拉取", run: () => void runAction("拉取并变基", () => api.git.pull("", true)) },
        { title: "推送并设上游", detail: "推送当前分支并设置 upstream", label: "设上游", run: () => void runAction("推送并设上游", () => api.git.pushTo(remotes[0]?.name || "origin", true)) },
        { title: "应用补丁", detail: "从已有补丁文件应用到工作区", label: "应用", run: () => void applyPatchFromFile() },
        { title: "从已暂存文件创建补丁", detail: "导出当前暂存区 diff", label: "导出", run: () => void savePatch("staged") },
        { title: "从未暂存文件创建补丁", detail: "导出工作区未暂存 diff", label: "导出", run: () => void savePatch("unstaged") },
      ]
    : [
        { title: "初始化仓库", detail: "把当前工作区变成 Git 仓库", label: "初始化", run: () => void runAction("初始化仓库", () => api.git.init()) },
        { title: "克隆", detail: "克隆任意仓库到指定目录", label: "克隆", run: () => beginClone() },
      ];
  const visibleActions = overviewActions.filter((item) => !item.hidden && matchesQuery(query, item.title, item.detail, item.label));
  const leftTree = (() => {
    const roots = expanded[""] || treeIndex;
    const needle = treeQuery.trim().toLowerCase();
    const filterNodes = (items: FileItem[]): FileItem[] => {
      if (!needle) return items;
      return items.reduce<FileItem[]>((acc, item) => {
        const children = filterNodes(expanded[item.path] || item.children || []);
        if (item.name.toLowerCase().includes(needle) || children.length) acc.push({ ...item, children });
        return acc;
      }, []);
    };
    return filterNodes(roots);
  })();

  function renderTreeNodes(nodes: FileItem[], depth = 0): React.ReactNode {
    return nodes.map((node) => {
      const selected = node.type === "tree" ? !filePath && treePath === node.path : filePath === node.path;
      if (node.type === "tree") {
        const opened = Boolean(treeQuery.trim()) || treePath === node.path || treePath.startsWith(`${node.path}/`) || filePath === node.path || filePath.startsWith(`${node.path}/`);
        const children = node.children || expanded[node.path] || [];
        return (
          <details className="gitlab-file-tree-directory" key={node.path} open={opened}>
            <summary
              className={selected ? "active" : ""}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              onClick={(event) => {
                event.preventDefault();
                void openDirectory(node.path);
              }}
            >
              <UiIcon icon={opened ? icons.folderOpen : icons.folder} />
              <span>{node.name}</span>
            </summary>
            {children.length > 0 && renderTreeNodes(children, depth + 1)}
          </details>
        );
      }
      return (
        <button
          type="button"
          className={`gitlab-file-tree-file ${selected ? "active" : ""}`}
          key={node.path}
          style={{ paddingLeft: `${24 + depth * 14}px` }}
          title={node.path}
          onClick={() => void openFile(node.path)}
        >
          <UiIcon icon={fileIconForName(node.name)} />
          <span>{node.name}</span>
        </button>
      );
    });
  }

  return (
    <section className="plugins-view gitlab-view">
      <div className="plugins-toolbar">
        <div className="plugins-tabs" role="tablist" aria-label="Git 管理">
          {TABS.map((entry) => (
            <button
              key={entry.key}
              role="tab"
              aria-selected={tab === entry.key}
              className={tab === entry.key ? "active" : ""}
              onClick={() => setTab(entry.key)}
            >
              <UiIcon icon={entry.icon} /> {entry.label}
            </button>
          ))}
        </div>
        <div className="plugins-toolbar-actions">
          <button title="刷新" disabled={loading || busy} onClick={() => void refresh()}>
            <UiIcon icon={icons.refresh} />
          </button>
          <button title="设置" onClick={onOpenSettings}>
            <UiIcon icon={icons.gear} />
          </button>
        </div>
      </div>
      {tab === "files" ? (
        <div className="plugins-content gitlab-content gitlab-code-page">
          {message && <div className="plugins-message">{message}</div>}
          {!workspaceRoot ? (
            <div className="plugins-empty">先选择一个工作区，再浏览本地文件。</div>
          ) : (
            <div className="gitlab-code">
              <aside className="gitlab-code-tree">
                <div className="gitlab-code-tree-head">
                  <UiIcon icon={icons.folder} />
                  <strong>文件</strong>
                </div>
                <label className="gitlab-code-tree-search">
                  <UiIcon icon={icons.search} />
                  <input value={treeQuery} onChange={(event) => setTreeQuery(event.target.value)} placeholder="Search files (*.ts, *.rs...)" />
                </label>
                <div className="gitlab-code-tree-list">
                  <button
                    type="button"
                    className={`gitlab-file-tree-file gitlab-file-tree-root ${treePath || filePath ? "" : "active"}`}
                    onClick={() => void openDirectory("")}
                  >
                    <UiIcon icon={icons.folderOpen} />
                    <span>{repoName}</span>
                  </button>
                  {leftTree.length === 0 ? <div className="plugins-empty">{loading ? "正在读取文件…" : "没有文件"}</div> : renderTreeNodes(leftTree)}
                </div>
              </aside>
              <div className="gitlab-code-main">
                <div className="gitlab-code-toolbar">
                  <div className="gitlab-code-crumbs">
                    <UiIcon icon={filePath ? fileIconForName(fileName) : icons.folder} />
                    <button type="button" className={!treePath && !filePath ? "active" : ""} onClick={() => void openDirectory("")}>
                      {repoName}
                    </button>
                    {crumbs.map((part, index) => {
                      const path = crumbs.slice(0, index + 1).join("/");
                      return (
                        <React.Fragment key={path}>
                          <span>/</span>
                          <button type="button" className={!filePath && path === treePath ? "active" : ""} onClick={() => void openDirectory(path)}>
                            {part}
                          </button>
                        </React.Fragment>
                      );
                    })}
                    {fileName && (
                      <>
                        <span>/</span>
                        <button type="button" className="active">{fileName}</button>
                      </>
                    )}
                  </div>
                  <RefSelect
                    value={snapshot?.branch || ""}
                    options={Array.from(new Set([
                      ...branches.map((item) => item.name),
                      ...tags.map((item) => item.name),
                    ].filter(Boolean)))}
                    onChange={(name) => {
                      if (!name || name === snapshot?.branch) return;
                      void (async () => {
                        const result = await runAction("签出", () => api.git.checkout(name));
                        if (result.ok !== false) {
                          resetOpenedFile();
                          setTreePath("");
                          await loadFiles("");
                        }
                      })();
                    }}
                  />
                  {filePath ? (
                    <div className="gitlab-code-actions gitlab-file-actions">
                      <button type="button" className={fileView === "view" ? "active" : ""} onClick={() => { setEditMenuOpen(false); setFileView("view"); }}>
                        <UiIcon icon={icons.fileCode} /> 查看文件
                      </button>
                      <div className="gitlab-code-menu">
                        <button
                          type="button"
                          className={fileView === "edit" || editMenuOpen ? "active" : ""}
                          aria-haspopup="menu"
                          aria-expanded={editMenuOpen}
                          onClick={() => setEditMenuOpen((open) => !open)}
                        >
                          <UiIcon icon={icons.compose} /> 编辑 <UiIcon icon={icons.down} />
                        </button>
                        {editMenuOpen && (
                          <div className="gitlab-code-popover">
                            {(fileKind === "text" || fileKind === "markdown") && (
                              <button type="button" onClick={() => { setEditMenuOpen(false); setFileView("edit"); }}>
                                在应用中编辑
                              </button>
                            )}
                            <button type="button" onClick={() => { setEditMenuOpen(false); void api.workspace.openExternal(joinWorkspace(filePath), "VS Code"); }}>
                              用 VS Code 打开
                            </button>
                            <button type="button" onClick={() => { setEditMenuOpen(false); void api.workspace.openExternal(joinWorkspace(filePath), "系统默认"); }}>
                              用系统默认程序打开
                            </button>
                            <button type="button" onClick={() => { setEditMenuOpen(false); openPrompt("renameFile", fileName, filePath); }}>
                              重命名
                            </button>
                            <button type="button" onClick={() => { setEditMenuOpen(false); openPrompt("deleteFile", "", filePath); }}>
                              删除
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <>
                      <label className="gitlab-code-find">
                        <UiIcon icon={icons.search} />
                        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="查找文件" />
                      </label>
                      <div className="gitlab-code-actions">
                        <div className="gitlab-code-menu">
                          <button type="button" title="新建" onClick={() => setNewMenuOpen((open) => !open)}>
                            <UiIcon icon={icons.plus} />
                            <UiIcon icon={icons.down} />
                          </button>
                          {newMenuOpen && (
                            <div className="gitlab-code-popover">
                              <button type="button" onClick={() => { setNewMenuOpen(false); openPrompt("newFile"); }}>新建文件</button>
                              <button type="button" onClick={() => { setNewMenuOpen(false); openPrompt("newFolder"); }}>新建文件夹</button>
                            </div>
                          )}
                        </div>
                        <div className="gitlab-code-menu">
                          <button type="button" className="gitlab-code-button" onClick={() => setCodeMenuOpen((open) => !open)}>
                            代码 <UiIcon icon={icons.down} />
                          </button>
                          {codeMenuOpen && (
                            <div className="gitlab-code-popover">
                              <button type="button" onClick={() => { setCodeMenuOpen(false); void api.workspace.openInEditor(workspaceRoot, "VS Code"); }}>
                                用 VS Code 打开工作区
                              </button>
                              <button type="button" onClick={() => { setCodeMenuOpen(false); void api.workspace.reveal(joinWorkspace(treePath)); }}>
                                在资源管理器中显示
                              </button>
                              <button type="button" onClick={() => { setCodeMenuOpen(false); void copyText(workspaceRoot); }}>
                                复制工作区路径
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
                {latestCommit && (
                  <div className="gitlab-code-commit">
                    <span className="gitlab-avatar">{String(latestCommit.authorName || "?").slice(0, 1)}</span>
                    <div>
                      <strong>
                        <span className="gitlab-code-commit-open">{latestCommit.title}</span>
                      </strong>
                      <small>{latestCommit.authorName || "未知作者"} authored {relativeTime(String(latestCommit.authoredDate || ""))}</small>
                    </div>
                    <span className="gitlab-code-sha">
                      {latestCommit.shortId || (latestCommit.id || "").slice(0, 8)}
                      <button type="button" title="复制提交" onClick={() => void copyText(latestCommit.id || latestCommit.shortId || "")}>
                        <UiIcon icon={icons.copy} />
                      </button>
                    </span>
                  </div>
                )}
                {filePath ? (
                  <div className="gitlab-file-pane">
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
                              <button
                                type="button"
                                title={fileRender === "preview" ? "查看源码" : "查看预览"}
                                className={fileRender === "source" ? "active" : ""}
                                onClick={() => setFileRender((current) => (current === "preview" ? "source" : "preview"))}
                              >
                                <UiIcon icon={fileRender === "preview" ? icons.code : icons.fileLines} />
                              </button>
                            )}
                            {fileView === "edit" && (fileKind === "text" || fileKind === "markdown") && (
                              <>
                                <button type="button" className="gitlab-code-button" disabled={editSaving} onClick={() => void saveEdit()}>
                                  {editSaving ? "保存中…" : "保存"}
                                </button>
                                <button type="button" onClick={() => setFileView("view")}>取消</button>
                              </>
                            )}
                            <button type="button" title="复制" disabled={!fileContent} onClick={() => void copyText(fileContent)}>
                              <UiIcon icon={icons.copy} />
                            </button>
                            <button type="button" title="用系统默认程序打开" onClick={() => void api.workspace.openExternal(joinWorkspace(filePath), "系统默认")}>
                              <UiIcon icon={icons.external} />
                            </button>
                            <button type="button" title="在文件夹中显示" onClick={() => void api.workspace.revealInFolder(joinWorkspace(filePath))}>
                              <UiIcon icon={icons.folderOpen} />
                            </button>
                          </span>
                        </div>
                        {fileError || (fileKind === "binary" && !fileContent) ? (
                          <div className="gitlab-file-unsupported">
                            <p>{fileError || "该文件无法在应用中预览"}</p>
                            <button type="button" onClick={() => void api.workspace.openExternal(joinWorkspace(filePath), "VS Code")}>用 VS Code 打开</button>
                            <button type="button" onClick={() => void api.workspace.revealInFolder(joinWorkspace(filePath))}>在文件夹中显示</button>
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
                          <MarkdownFilePreview path={joinWorkspace(filePath)} content={fileContent} onOpenFile={(target) => {
                            const root = workspaceRoot.replace(/[\\/]+$/, "").toLowerCase();
                            const next = target.toLowerCase().startsWith(`${root}\\`) || target.toLowerCase().startsWith(`${root}/`)
                              ? target.slice(workspaceRoot.replace(/[\\/]+$/, "").length + 1).replace(/\\/g, "/")
                              : target.replace(/\\/g, "/");
                            void openFile(next);
                          }} />
                        ) : isConfigPreviewPath(filePath) && fileView !== "edit" && fileRender === "preview" ? (
                          <ConfigFilePreview path={filePath} content={fileContent} />
                        ) : (
                          <MonacoFileEditor
                            path={filePath}
                            value={fileContent}
                            readOnly={fileView !== "edit"}
                            onChange={fileView === "edit" ? setFileContent : undefined}
                            onSave={() => void saveEdit()}
                          />
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="gitlab-code-table">
                    <div className="gitlab-code-header-row">
                      <span>名称</span>
                      <span>最后提交</span>
                      <span>最后更新</span>
                    </div>
                    {treePath && (
                      <button type="button" className="gitlab-code-row" onClick={() => void openDirectory(parentDir(treePath))}>
                        <span className="gitlab-name"><UiIcon icon={icons.folderOpen} /> ..</span>
                        <span />
                        <span />
                      </button>
                    )}
                    {filteredTree.length === 0 ? (
                      <div className="plugins-empty">{loading ? "正在读取仓库…" : "没有文件"}</div>
                    ) : (
                      filteredTree.map((item) => (
                        <button type="button" className="gitlab-code-row" key={item.path} onClick={() => openPath(item)}>
                          <span className={`gitlab-name ${item.type === "tree" ? "is-folder" : "is-file"}`}>
                            <UiIcon icon={item.type === "tree" ? icons.folder : fileIconForName(item.name)} />
                            {item.name}
                          </span>
                          <span className="gitlab-last-commit" title={item.lastCommitTitle || ""}>{item.lastCommitTitle || "—"}</span>
                          <span className="gitlab-last-update">{relativeTime(item.lastCommitDate) || "—"}</span>
                        </button>
                      ))
                    )}
                  </div>
                )}
                {copied && <div className="gitlab-copied">已复制</div>}
              </div>
            </div>
          )}
        </div>
      ) : (
      <div className="plugins-content gitlab-content">
        <header className="plugins-heading">
          <h1>{tab === "overview" ? "Git" : TABS.find((item) => item.key === tab)?.label || "Git"}</h1>
          <p>
            {workspaceRoot || "未选择工作区"}
            {snapshot?.isRepo ? ` · 当前 ${snapshot.branch || "HEAD"}` : " · 还不是 Git 仓库"}
            {snapshot?.upstream ? ` · 跟踪 ${snapshot.upstream}` : ""}
            {snapshot?.ahead ? ` · 超前 ${snapshot.ahead}` : ""}
            {snapshot?.behind ? ` · 落后 ${snapshot.behind}` : ""}
          </p>
        </header>
        <label className="plugins-search">
          <UiIcon icon={icons.search} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索当前列表" />
        </label>
        {snapshot?.reason && !snapshot.isRepo && tab !== "overview" && <div className="plugins-message">{snapshot.reason}</div>}
        {message && <div className="plugins-message">{message}</div>}

        {tab === "overview" && (
          <section className="plugins-section">
            {snapshot?.isRepo && (
              <div className="gitlab-meta">
                <div><span>分支</span><strong>{snapshot.branch || "HEAD"}</strong></div>
                <div><span>更改</span><strong>{snapshot.changes}</strong></div>
                <div><span>与远端</span><strong>{snapshot.ahead || snapshot.behind ? `超前 ${snapshot.ahead} · 落后 ${snapshot.behind}` : "已同步"}</strong></div>
              </div>
            )}
            <div className="plugins-section-heading"><h2>常用操作</h2><span>{visibleActions.length}</span></div>
            {visibleActions.length === 0 ? <div className="plugins-empty">{loading ? "正在读取仓库…" : "没有匹配的操作"}</div> : (
              <div className="gitlab-list">
                {visibleActions.map((item) => (
                  <article className="gitlab-card" key={item.title}>
                    <div>
                      <strong>{item.title}</strong>
                      <small>{item.detail}</small>
                    </div>
                    <button type="button" className="gitlab-clone-action" disabled={busy} onClick={item.run}>{item.label}</button>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === "changes" && (
          <section className="plugins-section">
            <div className="plugins-section-heading">
              <h2>更改</h2>
              <span>{filteredFiles.length}</span>
              <button type="button" className="plugins-add" disabled={busy} onClick={() => setCreatingCommit(true)}><UiIcon icon={icons.plus} /> 提交</button>
            </div>
            {creatingCommit && (
              <form className="gitlab-create-form" onSubmit={(event) => { event.preventDefault(); void runAction("提交", () => api.git.commit(commitTitle.trim())).then((result) => { if (result.ok !== false) { setCreatingCommit(false); setCommitTitle(""); } }); }}>
                <textarea value={commitTitle} onChange={(event) => setCommitTitle(event.target.value)} placeholder="提交说明" rows={4} required />
                <div className="gitlab-create-actions">
                  <button type="button" onClick={() => setCreatingCommit(false)}>取消</button>
                  <button type="submit" className="plugins-add" disabled={busy || !commitTitle.trim()}>{busy ? "提交中…" : "提交"}</button>
                </div>
              </form>
            )}
            {filteredFiles.length === 0 ? <div className="plugins-empty">{loading ? "正在读取更改…" : "工作区干净"}</div> : (
              <div className="gitlab-list">
                {filteredFiles.map((file) => (
                  <article className="gitlab-card" key={file.path}>
                    <div>
                      <strong>{file.path}</strong>
                      <small>{changeLabel(file.code)} · {file.code}</small>
                    </div>
                    <span className={`gitlab-state ${file.code.includes("?") ? "" : "open"}`}>{changeLabel(file.code)}</span>
                    <button type="button" className="gitlab-clone-action" disabled={busy} onClick={() => void runAction("还原文件", () => api.git.restoreFile(file.path))}>还原</button>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === "branches" && (
          <section className="plugins-section">
            <div className="plugins-section-heading">
              <h2>分支</h2>
              <span>{filteredBranches.length}</span>
              <button type="button" className="plugins-add" disabled={busy} onClick={() => setCreatingBranch(true)}><UiIcon icon={icons.plus} /> 新建分支</button>
            </div>
            {creatingBranch && (
              <form className="gitlab-create-form" onSubmit={(event) => { event.preventDefault(); void runAction("新建分支", () => api.git.createBranch(branchName.trim(), true)).then((result) => { if (result.ok !== false) { setCreatingBranch(false); setBranchName(""); } }); }}>
                <input value={branchName} onChange={(event) => setBranchName(event.target.value)} placeholder="例如 feature/local-search" required />
                <div className="gitlab-create-actions">
                  <button type="button" onClick={() => setCreatingBranch(false)}>取消</button>
                  <button type="submit" className="plugins-add" disabled={busy || !branchName.trim()}>{busy ? "创建中…" : "新建并检出"}</button>
                </div>
              </form>
            )}
            {filteredBranches.length === 0 ? <div className="plugins-empty">{loading ? "正在读取分支…" : "没有本地分支"}</div> : (
              <div className="gitlab-list">
                {filteredBranches.map((branch) => (
                  <article className="gitlab-card gitlab-card-open" key={branch.name}>
                    <button type="button" className="gitlab-card-main" disabled={busy || branch.current} onClick={() => void runAction("签出", () => api.git.checkout(branch.name))}>
                      <strong>{branch.name}</strong>
                      <small>{[branch.sha, branch.upstream].filter(Boolean).join(" · ") || "本地分支"}</small>
                    </button>
                    {branch.current && <span className="gitlab-state open">当前</span>}
                    {!branch.current && <button type="button" className="gitlab-clone-action" disabled={busy} onClick={() => void runAction("签出", () => api.git.checkout(branch.name))}>签出</button>}
                    {!branch.current && <button type="button" title="删除" onClick={() => openPrompt("deleteBranch", "", branch.name)}><UiIcon icon={icons.trash} /></button>}
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === "remotes" && (
          <section className="plugins-section">
            <div className="plugins-section-heading">
              <h2>远端</h2>
              <div className="plugins-section-heading-actions">
                <span>{filteredRemotes.length}</span>
                <button type="button" className="plugins-add" disabled={busy} onClick={() => beginAddRemote()}><UiIcon icon={icons.plus} /> 添加远端</button>
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
                    <button type="button" className="gitlab-clone-action" disabled={busy} onClick={() => void runAction("抓取", () => api.git.fetch(remote.name))}>抓取</button>
                    <button type="button" title="删除远端" onClick={() => openPrompt("deleteRemote", "", remote.name)}><UiIcon icon={icons.trash} /></button>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === "stash" && (
          <section className="plugins-section">
            <div className="plugins-section-heading">
              <h2>贮藏</h2>
              <span>{filteredStashes.length}</span>
              <button type="button" className="plugins-add" disabled={busy} onClick={() => setCreatingStash(true)}><UiIcon icon={icons.plus} /> 贮藏更改</button>
            </div>
            {creatingStash && (
              <form className="gitlab-create-form" onSubmit={(event) => { event.preventDefault(); void runAction("贮藏", () => api.git.stash(stashMessage.trim())).then((result) => { if (result.ok !== false) { setCreatingStash(false); setStashMessage(""); } }); }}>
                <input value={stashMessage} onChange={(event) => setStashMessage(event.target.value)} placeholder="贮藏说明（可选）" />
                <div className="gitlab-create-actions">
                  <button type="button" onClick={() => setCreatingStash(false)}>取消</button>
                  <button type="submit" className="plugins-add" disabled={busy}>{busy ? "贮藏中…" : "贮藏"}</button>
                </div>
              </form>
            )}
            {filteredStashes.length === 0 ? <div className="plugins-empty">{loading ? "正在读取贮藏…" : "没有贮藏"}</div> : (
              <div className="gitlab-list">
                {filteredStashes.map((item) => (
                  <article className="gitlab-card" key={item.label}>
                    <div>
                      <strong>{item.label}</strong>
                      <small>本地贮藏</small>
                    </div>
                    <button type="button" className="gitlab-clone-action" disabled={busy} onClick={() => void runAction("弹出贮藏", () => api.git.stashPop())}>弹出</button>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === "tags" && (
          <section className="plugins-section">
            <div className="plugins-section-heading">
              <h2>标签</h2>
              <span>{filteredTags.length}</span>
              <button type="button" className="plugins-add" disabled={busy} onClick={() => setCreatingTag(true)}><UiIcon icon={icons.plus} /> 创建标签</button>
            </div>
            {creatingTag && (
              <form className="gitlab-create-form" onSubmit={(event) => { event.preventDefault(); void runAction("创建标签", () => api.git.createTag(tagName.trim())).then((result) => { if (result.ok !== false) { setCreatingTag(false); setTagName(""); } }); }}>
                <input value={tagName} onChange={(event) => setTagName(event.target.value)} placeholder="例如 v0.1.0" required />
                <div className="gitlab-create-actions">
                  <button type="button" onClick={() => setCreatingTag(false)}>取消</button>
                  <button type="submit" className="plugins-add" disabled={busy || !tagName.trim()}>{busy ? "创建中…" : "创建"}</button>
                </div>
              </form>
            )}
            {filteredTags.length === 0 ? <div className="plugins-empty">{loading ? "正在读取标签…" : "没有标签"}</div> : (
              <div className="gitlab-list">
                {filteredTags.map((tag) => (
                  <article className="gitlab-card gitlab-card-open" key={tag.name}>
                    <button type="button" className="gitlab-card-main" disabled={busy} onClick={() => void runAction("签出", () => api.git.checkout(tag.name))}>
                      <strong>{tag.name}</strong>
                      <small>{[tag.sha, tag.date].filter(Boolean).join(" · ") || "标签"}</small>
                    </button>
                    <span className="gitlab-state merged">标签</span>
                    <button type="button" title="删除" onClick={() => openPrompt("deleteTag", "", tag.name)}><UiIcon icon={icons.trash} /></button>
                  </article>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === "output" && (
          <section className="plugins-section">
            <div className="plugins-section-heading"><h2>Git 输出</h2><span>{filteredLogs.length}</span></div>
            {filteredLogs.length === 0 ? <div className="plugins-empty">还没有命令输出</div> : (
              <div className="gitlab-list">
                {filteredLogs.map((item) => (
                  <article className="gitlab-card" key={item.id}>
                    <div>
                      <strong>{item.title}</strong>
                      <small>{item.text}</small>
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
              : openDialog === "deleteRemote" ? "删除远端"
                : openDialog === "deleteBranch" ? "删除分支"
                  : openDialog === "deleteTag" ? "删除标签"
                    : openDialog === "newFile" ? "新建文件"
                      : openDialog === "newFolder" ? "新建文件夹"
                        : openDialog === "renameFile" ? "重命名"
                          : "删除文件"
          }
          message={
            openDialog === "checkout" ? "签出到本地分支、标签或提交。"
              : openDialog === "newFile" ? `在 ${treePath || repoName} 创建文件`
                : openDialog === "newFolder" ? `在 ${treePath || repoName} 创建文件夹`
                  : openDialog === "renameFile" ? `重命名 ${targetName}`
                    : `确认删除 ${targetName}？`
          }
          value={openDialog.startsWith("delete") ? undefined : draft}
          placeholder={
            openDialog === "checkout" ? "分支 / 标签 / 提交"
              : openDialog === "newFile" || openDialog === "newFolder" || openDialog === "renameFile" ? "名称"
                : undefined
          }
          confirmLabel={
            openDialog.startsWith("delete") ? "删除"
              : openDialog === "checkout" ? "签出"
                : openDialog === "renameFile" ? "重命名"
                  : "创建"
          }
          error={dialogError}
          busy={busy}
          onChange={openDialog.startsWith("delete") ? undefined : (value) => { setDraft(value); setDialogError(""); }}
          onConfirm={(value) => {
            if (openDialog === "newFile" || openDialog === "newFolder" || openDialog === "renameFile" || openDialog === "deleteFile") {
              void submitFileDialog(value);
              return;
            }
            void submitDialog(value);
          }}
          onCancel={() => setOpenDialog(null)}
        />
      )}
      {confirm.node}
    </section>
  );
}
