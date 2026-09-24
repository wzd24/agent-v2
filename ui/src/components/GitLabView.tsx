import React from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api, CodexProject, GitHostRepoCheck, GitLabBlameGroup, GitLabFile, GitLabMergeRequest, GitLabProject, GitLabStatus } from "../api";
import { AppDialog, useAppDialog } from "./AppDialog";
import { DiffFileTree, DiffLineComment, parseUnifiedDiff } from "./DiffReviewPanel";
import { GitGraph } from "./GitGraph";
import { MonacoFileEditor } from "./MonacoFileEditor";
import { ConfigFilePreview, isMarkdownPath } from "./WorkspacePanel";
import { isConfigPreviewPath } from "../monacoLanguage";
import { useCoverBrowser } from "../coverBrowser";
import { icons, UiIcon } from "./UiIcon";

export type HostProvider = "gitlab" | "github";

type HostCopy = {
  name: string;
  mr: string;
  mrReading: string;
  conversation: string;
  filesChanged: string;
  pipelines: string;
  pipelinesEmpty: string;
  prefix: string;
  openIn: string;
  openHost: string;
  settings: string;
  disabled: string;
  commented: string;
  addedCommits: string;
  mergedClosed: string;
  branchSafe: string;
  noReviews: string;
  noAssignees: string;
  noneYet: string;
  filesList: string;
  create: string;
  merge: string;
  approve: string;
  closeMr: string;
  reopen: string;
  comment: string;
  commentPlaceholder: string;
  icon: typeof icons.merge;
};

const HOST_COPY: Record<HostProvider, HostCopy> = {
  gitlab: {
    name: "GitLab",
    mr: "合并请求",
    mrReading: "正在读取合并请求…",
    conversation: "对话",
    filesChanged: "文件变更",
    pipelines: "流水线",
    pipelinesEmpty: "没有流水线",
    prefix: "!",
    openIn: "在 GitLab 中打开",
    openHost: "打开 GitLab",
    settings: "GitLab 设置",
    disabled: "当前工作区未启用 GitLab 管理",
    commented: "评论于",
    addedCommits: "添加了",
    mergedClosed: "合并请求已成功合并并关闭",
    branchSafe: "源分支可以安全删除",
    noReviews: "暂无审核",
    noAssignees: "未指派",
    noneYet: "暂无",
    filesList: "文件列表",
    create: "新建合并请求",
    merge: "合并",
    approve: "批准",
    closeMr: "关闭",
    reopen: "重新打开",
    comment: "发表评论",
    commentPlaceholder: "发表评论…",
    icon: icons.merge,
  },
  github: {
    name: "GitHub",
    mr: "拉取请求",
    mrReading: "正在读取拉取请求…",
    conversation: "对话",
    filesChanged: "文件变更",
    pipelines: "检查",
    pipelinesEmpty: "没有检查",
    prefix: "#",
    openIn: "在 GitHub 中打开",
    openHost: "打开 GitHub",
    settings: "GitHub 设置",
    disabled: "当前工作区未启用 GitHub 管理",
    commented: "评论于",
    addedCommits: "添加了",
    mergedClosed: "拉取请求已成功合并并关闭",
    branchSafe: "源分支可以安全删除",
    noReviews: "暂无审核",
    noAssignees: "未指派",
    noneYet: "暂无",
    filesList: "文件列表",
    create: "新建拉取请求",
    merge: "合并",
    approve: "批准",
    closeMr: "关闭",
    reopen: "重新打开",
    comment: "发表评论",
    commentPlaceholder: "发表评论…",
    icon: icons.branch,
  },
};

type TabKey = "projects" | "mergeRequests" | "repository" | "branches" | "commits" | "tags" | "graph";
const GRAPH_PAGE = 1000;
type FileViewMode = "view" | "blame" | "edit";
type TreeItem = {
  id?: string;
  name: string;
  path: string;
  type: string;
  lastCommitId?: string;
  lastCommitTitle?: string;
  lastCommitAuthor?: string;
  lastCommitDate?: string;
  lastCommitUrl?: string;
};
type TreeNode = TreeItem & { children: TreeNode[] };

const TABS: Array<{ key: TabKey; label: string; icon: typeof icons.branch }> = [
  { key: "projects", label: "项目", icon: icons.folder },
  { key: "mergeRequests", label: "合并请求", icon: icons.merge },
  { key: "repository", label: "仓库", icon: icons.folder },
  { key: "branches", label: "分支", icon: icons.branch },
  { key: "commits", label: "提交", icon: icons.commit },
  { key: "tags", label: "标签", icon: icons.tag },
  { key: "graph", label: "仓库图", icon: icons.graph },
];

function hostTabs(copy: HostCopy) {
  return TABS.map((entry) => (entry.key === "mergeRequests" ? { ...entry, label: copy.mr, icon: copy.icon } : entry));
}

function formatDate(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function relativeTime(value?: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const delta = Date.now() - date.getTime();
  const minutes = Math.round(delta / 60000);
  if (Math.abs(minutes) < 1) return "刚刚";
  if (Math.abs(minutes) < 60) return `${Math.abs(minutes)}分钟前`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `${Math.abs(hours)}小时前`;
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return `${Math.abs(days)}天前`;
  return formatDate(value);
}

function shortSha(value?: string | null) {
  return String(value || "").slice(0, 8);
}

function displayRef(value?: string | null) {
  const ref = String(value || "").trim();
  if (/^[0-9a-f]{12,40}$/i.test(ref)) return ref.slice(0, 8);
  return ref;
}

function isOpenMr(state?: string) {
  const value = String(state || "").toLowerCase();
  return value === "opened" || value === "open";
}

function isClosedMr(state?: string) {
  return String(state || "").toLowerCase() === "closed";
}

function stateClass(state?: string) {
  const value = String(state || "").toLowerCase();
  if (value === "opened" || value === "open" || value === "running" || value === "success") return "open";
  if (value === "merged" || value === "protected") return "merged";
  if (value === "closed" || value === "failed" || value === "canceled") return "closed";
  return "";
}

function stateLabel(state?: string) {
  const value = String(state || "").toLowerCase();
  if (value === "opened" || value === "open") return "开放";
  if (value === "merged") return "已合并";
  if (value === "closed") return "关闭";
  if (value === "locked") return "锁定";
  if (value === "success") return "成功";
  if (value === "running") return "运行中";
  if (value === "failed") return "失败";
  if (value === "canceled") return "已取消";
  return state || "";
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message;
  return String(error);
}

type CloneProtocol = "https" | "ssh";

function previewCloneUrl(project: GitLabProject, protocol: CloneProtocol) {
  if (protocol === "ssh") {
    if (project.sshUrl) return project.sshUrl;
    const source = project.httpUrl || project.webUrl || "";
    try {
      const url = new URL(source);
      const repo = url.pathname.replace(/^\//, "").replace(/\.git$/i, "").replace(/\/+$/, "");
      return repo ? `git@${url.hostname}:${repo}.git` : "";
    } catch {
      return "";
    }
  }
  if (project.httpUrl) return project.httpUrl;
  const web = String(project.webUrl || "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (web) return /\.git$/i.test(web) ? web : `${web}.git`;
  return project.sshUrl || "";
}

function asItems(result: any) {
  return Array.isArray(result?.items) ? result.items : [];
}

function fileIconForName(name: string) {
  const base = String(name || "").split(/[\\/]/).pop()?.toLowerCase() || "";
  if (/^(dockerfile|containerfile)(?:\.[^.]+)*$/.test(base) || /^(makefile|gnumakefile|justfile|procfile|jenkinsfile|gemfile|rakefile|vagrantfile)(?:\.[^.]+)?$/.test(base)) return icons.fileCode;
  if (/^(?:\.gitignore|\.editorconfig|\.npmrc|\.yarnrc(?:\..+)?|\.nvmrc)$/.test(base) || /^\.env(?:\..+)?$/.test(base) || /^(?:docker-)?compose(?:\.[^.]+)*\.(?:ya?ml)$/.test(base) || /^(package\.json|tsconfig(?:\.[^.]+)*\.json|pyproject\.toml|cargo\.toml)$/.test(base) || /\.(?:sln|slnx|csproj|vcxproj|uproject|pbxproj|iml|cake)$/.test(base)) return icons.fileLines;
  const extension = base.includes(".") ? base.slice(base.lastIndexOf(".") + 1) : "";
  if (/^(png|jpe?g|gif|webp|bmp|svg|ico)$/.test(extension)) return icons.fileImage;
  if (/^(ts|tsx|js|jsx|mjs|cjs|go|rs|py|java|c|cpp|h|hpp|css|scss|less|html|vue|svelte)$/.test(extension)) return icons.fileCode;
  if (/^(json|yaml|yml|toml|ini|env|conf|config|xml)$/.test(extension)) return icons.fileLines;
  if (extension === "pdf") return icons.filePdf;
  if (/^(md|txt|log|csv)$/.test(extension)) return icons.fileLines;
  if (/^(zip|rar|7z|tar|gz)$/.test(extension)) return icons.fileArchive;
  return icons.file;
}

function compareTreeItems(left: { type: string; name: string }, right: { type: string; name: string }) {
  const leftDir = left.type === "tree" ? 0 : 1;
  const rightDir = right.type === "tree" ? 0 : 1;
  if (leftDir !== rightDir) return leftDir - rightDir;
  return left.name.localeCompare(right.name, "en", { sensitivity: "base" });
}

function nestTree(items: TreeItem[]): TreeNode[] {
  const root: TreeNode[] = [];
  const index = new Map<string, TreeNode>();
  const sorted = [...items].sort((left, right) => left.path.split("/").length - right.path.split("/").length || compareTreeItems(left, right));
  for (const item of sorted) {
    const node: TreeNode = { ...item, children: [] };
    index.set(item.path, node);
    const parentPath = item.path.includes("/") ? item.path.slice(0, item.path.lastIndexOf("/")) : "";
    const parent = parentPath ? index.get(parentPath) : null;
    if (parent) parent.children.push(node);
    else root.push(node);
  }
  const sortNodes = (nodes: TreeNode[]) => {
    nodes.sort(compareTreeItems);
    nodes.forEach((node) => sortNodes(node.children));
  };
  sortNodes(root);
  return root;
}

function sanitizeMarkdown(source: string) {
  return String(source || "").replace(/<!--[\s\S]*?-->/g, "").trim();
}

const remoteImageCache = new Map<string, Promise<string>>();

function isInlineImageSrc(src?: string) {
  return /^(data:|blob:|file:)/i.test(String(src || ""));
}

function loadRemoteImage(url: string) {
  const cached = remoteImageCache.get(url);
  if (cached) return cached;
  const pending = api.app.fetchImage(url).then((result) => {
    if (!result?.dataUrl) throw new Error("图片为空");
    return result.dataUrl;
  }).catch((error) => {
    remoteImageCache.delete(url);
    throw error;
  });
  remoteImageCache.set(url, pending);
  return pending;
}

function HostMarkdownImage({ src, alt, title }: { src?: string; alt?: string; title?: string }) {
  const inline = isInlineImageSrc(src);
  const [dataUrl, setDataUrl] = React.useState(inline ? String(src || "") : "");
  const [failed, setFailed] = React.useState(false);
  React.useEffect(() => {
    if (!src || inline) return;
    let cancelled = false;
    void loadRemoteImage(src).then((value) => {
      if (!cancelled) setDataUrl(value);
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [src, inline]);
  if (!src || failed) return alt ? <span className="gitlab-md-img-alt">{alt}</span> : null;
  if (!dataUrl) return <span className="gitlab-md-img-pending" aria-hidden="true" />;
  return <img src={dataUrl} alt={alt || ""} title={title || alt || ""} className="gitlab-md-img" />;
}

function HostMarkdown({ children, resolveUrl }: { children: string; resolveUrl?: (href: string) => string }) {
  const source = sanitizeMarkdown(children);
  if (!source) return null;
  const resolve = (href?: string) => {
    const raw = String(href || "");
    if (!raw || /^(?:https?:|data:|mailto:|#)/i.test(raw)) return raw;
    return resolveUrl ? resolveUrl(raw) : raw;
  };
  return (
    <div className="markdown-content gitlab-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => {
          const resolved = resolve(url);
          return /^(?:https?:|mailto:|#)/i.test(resolved) ? defaultUrlTransform(resolved) : resolved;
        }}
        components={{
          a: ({ href, children: label }) => {
            const target = resolve(href);
            return (
              <a
                href={target || href}
                onClick={(event) => {
                  event.preventDefault();
                  if (target && /^https?:/i.test(target)) void api.app.openExternalUrl(target);
                }}
              >
                {label}
              </a>
            );
          },
          img: ({ src, alt, title }) => <HostMarkdownImage src={resolve(src)} alt={alt} title={title} />,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

function rawUrl(projectUrl: string, ref: string, path: string, provider: HostProvider = "gitlab") {
  if (!projectUrl || !path) return "";
  const root = projectUrl.replace(/\/+$/, "");
  const encodedRef = encodeURIComponent(ref || "HEAD").replace(/%2F/g, "/");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  if (provider === "github") {
    try {
      const parsed = new URL(root);
      if (/github\.com$/i.test(parsed.host)) {
        const repo = parsed.pathname.replace(/^\/|\/$/g, "");
        return `https://raw.githubusercontent.com/${repo}/${encodedRef}/${encodedPath}`;
      }
    } catch {
      /* fall through */
    }
    return `${root}/raw/${encodedRef}/${encodedPath}`;
  }
  return `${root}/-/raw/${encodedRef}/${encodedPath}`;
}

function resolveRepoHref(href: string, filePath: string, projectUrl: string, ref: string, provider: HostProvider) {
  const raw = String(href || "").trim();
  if (!raw || /^(?:https?:|data:|mailto:|#)/i.test(raw)) return raw;
  let value = raw.replace(/[?#].*$/, "");
  try {
    value = decodeURIComponent(value);
  } catch {
    /* keep raw */
  }
  const parts = [...parentDir(filePath).split("/"), ...value.split("/")];
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") stack.pop();
    else stack.push(part);
  }
  return rawUrl(projectUrl, ref, stack.join("/"), provider);
}

function blobUrl(projectUrl: string, ref: string, path: string, provider: HostProvider = "gitlab") {
  if (!projectUrl || !path) return "";
  const root = projectUrl.replace(/\/+$/, "");
  const encodedRef = encodeURIComponent(ref || "HEAD");
  const encodedPath = path.split("/").map(encodeURIComponent).join("/");
  return provider === "github"
    ? `${root}/blob/${encodedRef}/${encodedPath}`
    : `${root}/-/blob/${encodedRef}/${encodedPath}`;
}

function formatFileSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(2)} KiB`;
  return `${(size / 1024 / 1024).toFixed(2)} MiB`;
}

function parentDir(filePath: string) {
  return filePath.includes("/") ? filePath.slice(0, filePath.lastIndexOf("/")) : "";
}

function BlameView({ groups }: { groups: GitLabBlameGroup[] }) {
  return (
    <div className="gitlab-blame">
      {groups.map((group, index) => (
        <div className="gitlab-blame-group" key={`${group.commitId}-${index}`}>
          <div className="gitlab-blame-meta" title={group.commitId}>
            <strong>{group.authorName || "未知作者"}</strong>
            <small>{shortSha(group.shortId || group.commitId)} · {relativeTime(group.authoredDate) || formatDate(group.authoredDate)}</small>
          </div>
          <pre>{group.lines.join("\n")}</pre>
        </div>
      ))}
    </div>
  );
}

function RefSelect({
  value,
  options,
  onChange,
  placeholder = "选择分支",
  label,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
}) {
  const [open, setOpen] = React.useState(false);
  const rootRef = React.useRef<HTMLDivElement>(null);
  const names = value && !options.includes(value) ? [value, ...options] : options;
  React.useEffect(() => {
    if (!open) return undefined;
    function onPointer(event: MouseEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <div className={`gitlab-ref-select ${open ? "open" : ""}`} ref={rootRef}>
      <button type="button" aria-haspopup="listbox" aria-expanded={open} aria-label={label || placeholder} title={value || placeholder} onClick={() => setOpen((current) => !current)}>
        <UiIcon icon={icons.branch} />
        <span>{displayRef(value) || placeholder}</span>
        <UiIcon icon={icons.down} />
      </button>
      {open && (
        <div className="gitlab-ref-menu" role="listbox" aria-label={label || placeholder}>
          {names.length === 0 ? (
            <div className="gitlab-ref-empty">没有分支</div>
          ) : (
            names.map((name) => (
              <button
                type="button"
                role="option"
                aria-selected={name === value}
                className={name === value ? "active" : ""}
                key={name}
                onClick={() => {
                  onChange(name);
                  setOpen(false);
                }}
              >
                {name.length > 12 && /^[0-9a-f]+$/i.test(name) ? shortSha(name) : name}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

type MrTab = "overview" | "commits" | "pipelines" | "changes";

function CommitDiffPage({
  copy,
  commit,
  diff,
  loading,
  onBack,
  onOpenFiles,
  onOpenParent,
  onOpenGitLab,
}: {
  copy: HostCopy;
  commit: any;
  diff: string;
  loading: boolean;
  onBack: () => void;
  onOpenFiles: () => void;
  onOpenParent: (sha: string) => void;
  onOpenGitLab: (event: React.MouseEvent, url?: string) => void;
}) {
  const files = React.useMemo(() => parseUnifiedDiff(diff), [diff]);
  const added = commit?.stats?.additions || files.reduce((sum, file) => sum + file.added, 0);
  const deleted = commit?.stats?.deletions || files.reduce((sum, file) => sum + file.deleted, 0);
  const parent = commit?.parentIds?.[0] || "";
  return (
    <div className="gitlab-mr-page">
      <header className="gitlab-mr-head">
        <button type="button" className="gitlab-mr-back" onClick={onBack}>
          <UiIcon icon={icons.arrowLeft} /> 返回
        </button>
        <div className="gitlab-mr-title">
          <h1>{commit?.title || shortSha(commit?.shortId || commit?.id)}</h1>
          <p>
            {commit?.authorName || "未知作者"}
            {commit?.authoredDate || commit?.createdAt ? ` · ${relativeTime(commit.authoredDate || commit.createdAt) || formatDate(commit.authoredDate || commit.createdAt)}` : ""}
            {parent && (
              <>
                {" · 上级 "}
                <button type="button" className="gitlab-mr-ref" onClick={() => onOpenParent(parent)}>{shortSha(parent)}</button>
              </>
            )}
          </p>
        </div>
        <button type="button" className="gitlab-mr-back" title={copy.filesList} onClick={onOpenFiles}>
          <UiIcon icon={icons.folder} /> {copy.filesList}
        </button>
        {commit?.webUrl && (
          <button type="button" className="plugins-add" title={copy.openIn} onClick={(event) => onOpenGitLab(event, commit.webUrl)}>
            <UiIcon icon={icons.external} /> {copy.openIn}
          </button>
        )}
      </header>
      <div className="gitlab-commit-summary">
        <span>{files.length} 个文件</span>
        <DiffStat added={added} deleted={deleted} />
      </div>
      {loading ? <div className="plugins-empty">正在读取提交变更…</div> : <MergeRequestDiffs diff={diff} />}
    </div>
  );
}

function MergeRequestDiffs({
  diff,
  onCommentLine,
}: {
  diff: string;
  onCommentLine?: (comment: { path: string; body: string; newLine?: number; oldLine?: number }) => Promise<void>;
}) {
  const files = React.useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [selected, setSelected] = React.useState(files[0]?.path || "");
  const [fileFilter, setFileFilter] = React.useState("");
  const [activeComment, setActiveComment] = React.useState("");
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => {
    setSelected(files[0]?.path || "");
    setFileFilter("");
    setActiveComment("");
  }, [diff]);
  const current = files.find((file) => file.path === selected) || files[0];
  if (!diff.trim() || files.length === 0) return <div className="plugins-empty">没有可显示的变更</div>;
  async function submit(path: string, key: string, line: { newLine?: number; oldLine?: number }) {
    if (!onCommentLine || busy) return;
    const body = String(drafts[key] || "").trim();
    if (!body) return;
    setBusy(true);
    try {
      await onCommentLine({ path, body, ...line });
      setDrafts((old) => ({ ...old, [key]: "" }));
      setActiveComment("");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="gitlab-mr-changes">
      <aside className="gitlab-mr-files">
        <label className="gitlab-mr-file-search">
          <UiIcon icon={icons.search} />
          <input value={fileFilter} onChange={(event) => setFileFilter(event.target.value)} placeholder="筛选文件…" />
        </label>
        <DiffFileTree
          files={files}
          filter={fileFilter}
          selectedPath={current?.path || ""}
          pathFormatter={(path) => path}
          showDirectoryCounts
          onSelect={(file) => setSelected(file.path)}
        />
      </aside>
      <div className="gitlab-mr-diff">
        {current?.hunks.map((hunk, index) => (
          <div className="diff-review-hunk" key={`${current.path}:${index}`}>
            <div className="diff-review-hunk-head"><code>{hunk.header}</code></div>
            <pre>
              {hunk.lines.map((line, lineIndex) => {
                const commentKey = `${current.path}:${index}:${lineIndex}`;
                return (
                  <React.Fragment key={`${lineIndex}-${line.text}`}>
                    <span
                      className={`diff-review-line ${line.kind}${activeComment === commentKey ? " commenting" : ""}`}
                      title={onCommentLine ? "点击添加行评论" : undefined}
                      onClick={() => onCommentLine && setActiveComment((value) => value === commentKey ? "" : commentKey)}
                    >
                      <em>{line.oldLine ?? ""}</em>
                      <em>{line.newLine ?? ""}</em>
                      <b>{line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}</b>
                      {line.text || " "}
                    </span>
                    {activeComment === commentKey && onCommentLine && (
                      <DiffLineComment
                        draft={drafts[commentKey] || ""}
                        editing
                        onChange={(value) => setDrafts((old) => ({ ...old, [commentKey]: value }))}
                        onSave={() => submit(current.path, commentKey, { newLine: line.newLine, oldLine: line.oldLine })}
                        submitLabel={busy ? "发送中…" : "发表行评论"}
                      />
                    )}
                  </React.Fragment>
                );
              })}
            </pre>
          </div>
        ))}
      </div>
    </div>
  );
}

const AVATAR_COLORS = ["#1f6feb", "#1b7f4e", "#8250df", "#bf4b8a", "#d29922", "#cf222e", "#3d8fd1"];

function personInitial(name?: string) {
  return String(name || "?").trim().slice(0, 1).toUpperCase() || "?";
}

function avatarColor(name?: string) {
  const text = String(name || "?");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length];
}

function PersonAvatar({ name, size = "md" }: { name?: string; size?: "md" | "sm" | "xs" }) {
  return (
    <span className={`gitlab-pr-avatar ${size}`} title={name} style={{ background: avatarColor(name) }}>
      {personInitial(name)}
    </span>
  );
}

function isBotName(name?: string) {
  return /\[bot\]$/i.test(String(name || "")) || /(^|[^a-z])bot$/i.test(String(name || ""));
}

function commitCheck(pipelines: any[], sha?: string) {
  const value = String(sha || "");
  if (!value) return "";
  const item = pipelines.find((pipeline) => {
    const other = String(pipeline.sha || "");
    return other && (other.startsWith(value.slice(0, 7)) || value.startsWith(other.slice(0, 7)));
  });
  return String(item?.status || "");
}

function DiffStat({ added, deleted }: { added: number; deleted: number }) {
  const total = added + deleted;
  const green = total ? Math.max(added ? 1 : 0, Math.round((added / total) * 5)) : 0;
  const red = Math.min(5 - green, deleted ? Math.max(1, 5 - green) : 0);
  const empty = 5 - green - red;
  return (
    <span className="gitlab-pr-diffstat" title={`+${added} −${deleted}`}>
      <b>+{added}</b>
      <i>−{deleted}</i>
      <span className="gitlab-pr-diffbar" aria-hidden="true">
        {Array.from({ length: green }, (_, index) => <em className="add" key={`g${index}`} />)}
        {Array.from({ length: red }, (_, index) => <em className="del" key={`r${index}`} />)}
        {Array.from({ length: empty }, (_, index) => <em key={`e${index}`} />)}
      </span>
    </span>
  );
}

function TimelineComment({
  author,
  createdAt,
  badge,
  authorComment,
  copy,
  children,
}: {
  author?: string;
  createdAt?: string;
  badge?: string;
  authorComment?: boolean;
  copy: HostCopy;
  children: React.ReactNode;
}) {
  return (
    <article className={`gitlab-pr-comment${authorComment ? " is-author" : ""}`}>
      <PersonAvatar name={author} />
      <div className="gitlab-pr-comment-card">
        <header className="gitlab-pr-comment-head">
          <div className="gitlab-pr-comment-meta">
            <strong>{author || "未知作者"}</strong>
            {badge && !authorComment && <span className="gitlab-pr-badge">{badge}</span>}
            <small>{copy.commented} {relativeTime(createdAt) || formatDate(createdAt)}</small>
          </div>
          {badge && authorComment && <span className="gitlab-pr-badge">{badge}</span>}
        </header>
        <div className="gitlab-pr-comment-body">{children}</div>
      </div>
    </article>
  );
}

function MergeRequestDetail({
  copy,
  mergeRequest,
  commits,
  pipelines,
  notes,
  diff,
  loading,
  onBack,
  onOpenRef,
  onOpenCommit,
  onOpenGitLab,
  onCreateNote,
  onCreateReviewComment,
  onMerge,
  onApprove,
  onCloseMr,
  onReopen,
  actionBusy = false,
}: {
  copy: HostCopy;
  mergeRequest: GitLabMergeRequest;
  commits: any[];
  pipelines: any[];
  notes: any[];
  diff: string;
  loading: boolean;
  onBack: () => void;
  onOpenRef: (ref: string) => void;
  onOpenCommit: (sha: string, item?: any) => void;
  onOpenGitLab: (event: React.MouseEvent, url?: string) => void;
  onCreateNote?: (body: string) => Promise<void>;
  onCreateReviewComment?: (comment: { path: string; body: string; newLine?: number; oldLine?: number }) => Promise<void>;
  onMerge?: () => void;
  onApprove?: () => void;
  onCloseMr?: () => void;
  onReopen?: () => void;
  actionBusy?: boolean;
}) {
  const [comment, setComment] = React.useState("");
  const [commenting, setCommenting] = React.useState(false);
  const [mrTab, setMrTab] = React.useState<MrTab>("overview");
  const files = React.useMemo(() => parseUnifiedDiff(diff), [diff]);
  const added = files.reduce((sum, file) => sum + file.added, 0);
  const deleted = files.reduce((sum, file) => sum + file.deleted, 0);
  const conversationCount = (mergeRequest.description ? 1 : 0) + notes.filter((note) => note.body && !note.system).length;
  const participants = Array.from(new Set([
    mergeRequest.author,
    ...(mergeRequest.assignees || []),
    ...(mergeRequest.reviewers || []),
    ...notes.map((note) => note.author),
  ].filter(Boolean)));
  const passedChecks = pipelines.filter((item) => stateClass(item.status) === "open" || item.status === "success").length;
  const commentNotes = notes.filter((note) => note.body && !note.system);
  const eventNotes = notes.filter((note) => note.system && note.body);
  return (
    <div className="gitlab-mr-page">
      <header className="gitlab-mr-head">
        <button type="button" className="gitlab-mr-back" onClick={onBack}>
          <UiIcon icon={icons.arrowLeft} /> 返回列表
        </button>
        <div className="gitlab-mr-title">
          <h1>{copy.prefix}{mergeRequest.iid} {mergeRequest.title}</h1>
          <p>
            <span className={`gitlab-state ${stateClass(mergeRequest.state)}`}>{stateLabel(mergeRequest.state)}</span>
            {mergeRequest.draft && <span className="gitlab-state">草稿</span>}
            {mergeRequest.author || "未知作者"} 请求将{" "}
            <button type="button" className="gitlab-mr-ref" onClick={() => onOpenRef(mergeRequest.sourceBranch || "")}>{mergeRequest.sourceBranch}</button>
            {" "}合并到{" "}
            <button type="button" className="gitlab-mr-ref" onClick={() => onOpenRef(mergeRequest.targetBranch || "")}>{mergeRequest.targetBranch}</button>
            {mergeRequest.createdAt ? ` · ${relativeTime(mergeRequest.createdAt) || formatDate(mergeRequest.createdAt)}` : ""}
          </p>
        </div>
        {mergeRequest.webUrl && (
          <button type="button" className="plugins-add" title={copy.openIn} onClick={(event) => onOpenGitLab(event, mergeRequest.webUrl)}>
            <UiIcon icon={icons.external} /> {copy.openIn}
          </button>
        )}
        <div className="gitlab-mr-actions">
          {isOpenMr(mergeRequest.state) && (
            <>
              <button type="button" className="plugins-add" disabled={actionBusy} onClick={onApprove}>{copy.approve}</button>
              <button type="button" className="plugins-add" disabled={actionBusy} onClick={onMerge}>{actionBusy ? "处理中…" : copy.merge}</button>
              <button type="button" className="gitlab-pr-ghost" disabled={actionBusy} onClick={onCloseMr}>{copy.closeMr}</button>
            </>
          )}
          {mergeRequest.state === "closed" && (
            <button type="button" className="plugins-add" disabled={actionBusy} onClick={onReopen}>{actionBusy ? "处理中…" : copy.reopen}</button>
          )}
        </div>
      </header>
      <div className="gitlab-mr-tabs" role="tablist">
        {([
          ["overview", copy.conversation, conversationCount],
          ["commits", "提交", commits.length],
          ["pipelines", copy.pipelines, pipelines.length],
          ["changes", copy.filesChanged, files.length || mergeRequest.changesCount || 0],
        ] as Array<[MrTab, string, number | null]>).map(([key, label, count]) => (
          <button key={key} type="button" role="tab" aria-selected={mrTab === key} className={mrTab === key ? "active" : ""} onClick={() => setMrTab(key)}>
            {label}{count == null ? null : <span className="gitlab-pr-tabcount">{count}</span>}
          </button>
        ))}
        <DiffStat added={added} deleted={deleted} />
      </div>
      {loading ? <div className="plugins-empty">{copy.mrReading}</div> : mrTab === "overview" ? (
        <div className="gitlab-mr-overview">
          <div className="gitlab-pr-conversation">
          <div className="gitlab-pr-timeline">
            <TimelineComment author={mergeRequest.author} createdAt={mergeRequest.createdAt} badge="成员" authorComment copy={copy}>
              {mergeRequest.description ? <HostMarkdown>{mergeRequest.description}</HostMarkdown> : <div className="plugins-empty">没有描述</div>}
            </TimelineComment>
            {commits.length > 0 && (
              <section className="gitlab-pr-commits">
                <span className="gitlab-pr-node"><UiIcon icon={icons.commit} /></span>
                <div>
                  <div className="gitlab-pr-event-head">
                    <strong>{mergeRequest.author || commits[0]?.authorName || "未知作者"}</strong>
                    <span>{copy.addedCommits} {commits.length} 个提交</span>
                    <small>{relativeTime(commits[0]?.authoredDate || commits[0]?.createdAt) || formatDate(commits[0]?.authoredDate || commits[0]?.createdAt)}</small>
                  </div>
                  <div className="gitlab-pr-commit-list">
                    {commits.map((item) => {
                      const status = commitCheck(pipelines, item.id || item.sha);
                      const check = stateClass(status);
                      return (
                        <div className="gitlab-pr-commit" key={item.id}>
                          <PersonAvatar name={item.authorName || mergeRequest.author} size="xs" />
                          <button type="button" className="gitlab-pr-commit-msg" onClick={() => onOpenCommit(item.id, item)}>{item.title}</button>
                          {status && (
                            <span className={`gitlab-pr-check ${check}`}>
                              <UiIcon icon={check === "closed" ? icons.close : icons.check} />
                            </span>
                          )}
                          <button type="button" className="gitlab-pr-sha" onClick={() => onOpenCommit(item.id, item)}>{shortSha(item.shortId || item.id)}</button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </section>
            )}
            {commentNotes.map((note) => (
              <TimelineComment key={note.id} author={note.author} createdAt={note.createdAt} badge={isBotName(note.author) ? "Bot" : undefined} copy={copy}>
                <HostMarkdown>{note.body}</HostMarkdown>
              </TimelineComment>
            ))}
            {eventNotes.map((note) => (
              <div className="gitlab-pr-system" key={note.id}>
                <span className="gitlab-pr-node" />
                <p>
                  <strong>{note.author || "系统"}</strong>
                  <span>{note.body}</span>
                  <small>{relativeTime(note.createdAt) || formatDate(note.createdAt)}</small>
                </p>
              </div>
            ))}
            {onCreateNote && mergeRequest.state !== "merged" && mergeRequest.state !== "closed" && (
              <form className="gitlab-pr-comment-form" onSubmit={(event) => {
                event.preventDefault();
                const body = comment.trim();
                if (!body || commenting) return;
                setCommenting(true);
                void onCreateNote(body).then(() => setComment("")).finally(() => setCommenting(false));
              }}>
                <textarea value={comment} onChange={(event) => setComment(event.target.value)} placeholder={copy.commentPlaceholder} rows={3} />
                <button type="submit" className="plugins-add" disabled={!comment.trim() || commenting}>{commenting ? "发送中…" : copy.comment}</button>
              </form>
            )}
            {mergeRequest.state === "merged" && (
              <div className="gitlab-pr-merge-event">
                <span className="gitlab-pr-merge-icon"><UiIcon icon={icons.merge} /></span>
                <div className="gitlab-pr-merge-body">
                  <div className="gitlab-pr-merge-copy">
                    <PersonAvatar name={mergeRequest.mergedBy || mergeRequest.author} size="xs" />
                    <p>
                      <strong>{mergeRequest.mergedBy || mergeRequest.author || "未知作者"}</strong>
                      {" "}将提交{" "}
                      {mergeRequest.mergeCommitSha ? (
                        <button type="button" className="gitlab-pr-sha" onClick={() => onOpenCommit(mergeRequest.mergeCommitSha || "")}>{shortSha(mergeRequest.mergeCommitSha)}</button>
                      ) : "此次变更"}
                      {" "}合并到 <code>{mergeRequest.targetBranch}</code>
                      <small> · {relativeTime(mergeRequest.mergedAt) || formatDate(mergeRequest.mergedAt)}</small>
                    </p>
                  </div>
                  {passedChecks > 0 && <small className="gitlab-pr-merge-checks">{passedChecks} 项检查通过</small>}
                </div>
                <button type="button" className="gitlab-pr-ghost" onClick={() => setMrTab("pipelines")}>查看详情</button>
              </div>
            )}
          </div>
            {mergeRequest.state === "merged" && (
              <div className="gitlab-pr-closed">
                <span className="gitlab-pr-merge-icon large"><UiIcon icon={icons.merge} /></span>
                <div>
                  <strong>{copy.mergedClosed}</strong>
                  <p>{copy.branchSafe} — <code>{mergeRequest.sourceBranch}</code></p>
                </div>
              </div>
            )}
          </div>
          <aside className="gitlab-pr-side">
            <section>
              <h3>审核者</h3>
              <p>{mergeRequest.reviewers?.length ? mergeRequest.reviewers.join("、") : copy.noReviews}</p>
            </section>
            <section>
              <h3>指派人</h3>
              <p>{mergeRequest.assignees?.length ? mergeRequest.assignees.join("、") : copy.noAssignees}</p>
            </section>
            <section>
              <h3>标记</h3>
              <p>{mergeRequest.labels?.length ? mergeRequest.labels.join("、") : copy.noneYet}</p>
            </section>
            <section>
              <h3>{participants.length} 位参与者</h3>
              <div className="gitlab-pr-people">
                {participants.length === 0 ? <p>{copy.noneYet}</p> : participants.map((name) => (
                  <PersonAvatar name={name} size="sm" key={name} />
                ))}
              </div>
            </section>
          </aside>
        </div>
      ) : mrTab === "commits" ? (
        <div className="gitlab-list gitlab-mr-list">
          {commits.length === 0 ? <div className="plugins-empty">没有提交</div> : commits.map((item) => (
            <article className="gitlab-card gitlab-card-open" key={item.id}>
              <button type="button" className="gitlab-card-main" onClick={() => onOpenCommit(item.id, item)}>
                <strong>{item.title}</strong>
                <small>{shortSha(item.shortId || item.id)} · {item.authorName || "未知作者"} · {formatDate(item.authoredDate || item.createdAt)}</small>
              </button>
              {item.webUrl && <button type="button" title={copy.openIn} onClick={(event) => onOpenGitLab(event, item.webUrl)}><UiIcon icon={icons.external} /></button>}
            </article>
          ))}
        </div>
      ) : mrTab === "pipelines" ? (
        <div className="gitlab-list gitlab-mr-list">
          {pipelines.length === 0 ? <div className="plugins-empty">{copy.pipelinesEmpty}</div> : pipelines.map((item) => (
            <article className="gitlab-card gitlab-card-open" key={item.id}>
              <button type="button" className="gitlab-card-main" onClick={() => item.sha && onOpenCommit(item.sha)}>
                <strong>{item.ref || item.sha || `#${item.id}`}</strong>
                <small>{formatDate(item.createdAt)}</small>
              </button>
              <span className={`gitlab-state ${stateClass(item.status)}`}>{stateLabel(item.status) || item.status}</span>
              {item.webUrl && <button type="button" title={copy.openIn} onClick={(event) => onOpenGitLab(event, item.webUrl)}><UiIcon icon={icons.external} /></button>}
            </article>
          ))}
        </div>
      ) : (
        <MergeRequestDiffs diff={diff} onCommentLine={onCreateReviewComment} />
      )}
    </div>
  );
}

function commitUrl(projectUrl: string, sha: string, provider: HostProvider = "gitlab") {
  if (!projectUrl || !sha) return "";
  const root = projectUrl.replace(/\/+$/, "");
  return provider === "github" ? `${root}/commit/${sha}` : `${root}/-/commit/${sha}`;
}

function treeUrl(projectUrl: string, ref: string, path = "", provider: HostProvider = "gitlab") {
  if (!projectUrl) return "";
  const root = projectUrl.replace(/\/+$/, "");
  const encodedRef = encodeURIComponent(ref || "HEAD");
  const encodedPath = path ? `/${path.split("/").map(encodeURIComponent).join("/")}` : "";
  return provider === "github"
    ? `${root}/tree/${encodedRef}${encodedPath}`
    : `${root}/-/tree/${encodedRef}${encodedPath}`;
}

function sameProjectPath(a?: string, b?: string) {
  return String(a || "").replace(/[\\/]+$/, "").toLowerCase() === String(b || "").replace(/[\\/]+$/, "").toLowerCase();
}

function projectHasRoot(project: CodexProject, root: string) {
  return [project.path, ...(project.rootPaths || [])].some((item) => sameProjectPath(item, root));
}

export function GitLabView({
  status,
  onOpenSettings,
  onStatusChange,
  provider = "gitlab",
  projects = [],
  onProjectChanged,
  onUseClone,
  onOpenCloneWorkspace,
  onAssignClone,
}: {
  status: GitLabStatus | null;
  onOpenSettings: () => void;
  onStatusChange?: (status: GitLabStatus | null) => void;
  provider?: HostProvider;
  projects?: CodexProject[];
  onProjectChanged?: (project: CodexProject) => void;
  onUseClone?: (root: string) => void;
  onOpenCloneWorkspace?: (root: string) => void | Promise<void>;
  onAssignClone?: (project: CodexProject, root: string) => void | Promise<void>;
}) {
  const copy = HOST_COPY[provider];
  const client = provider === "github" ? api.github : api.gitlab;
  const tabs = hostTabs(copy);
  const [tab, setTab] = React.useState<TabKey>("repository");
  const [query, setQuery] = React.useState("");
  const [treeQuery, setTreeQuery] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const dialog = useAppDialog();
  const [branchDialog, setBranchDialog] = React.useState(false);
  const [branchDraft, setBranchDraft] = React.useState("");
  const [branchError, setBranchError] = React.useState("");
  const [mergeRequests, setMergeRequests] = React.useState<any[]>([]);
  const [branches, setBranches] = React.useState<any[]>([]);
  const [commits, setCommits] = React.useState<any[]>([]);
  const [tags, setTags] = React.useState<any[]>([]);
  const [repository, setRepository] = React.useState<any>(null);
  const [tree, setTree] = React.useState<TreeItem[]>([]);
  const [treeIndex, setTreeIndex] = React.useState<TreeItem[]>([]);
  const [graph, setGraph] = React.useState<any[]>([]);
  const [graphLimit, setGraphLimit] = React.useState(GRAPH_PAGE);
  const [graphTotal, setGraphTotal] = React.useState(0);
  const [graphHasMore, setGraphHasMore] = React.useState(false);
  const [graphShallow, setGraphShallow] = React.useState(false);
  const graphSentinel = React.useRef<HTMLDivElement | null>(null);
  const [treePath, setTreePath] = React.useState("");
  const [refName, setRefName] = React.useState("");
  const [latestCommit, setLatestCommit] = React.useState<any>(null);
  const [codeMenuOpen, setCodeMenuOpen] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [filePath, setFilePath] = React.useState("");
  const [fileView, setFileView] = React.useState<FileViewMode>("view");
  const [fileRender, setFileRender] = React.useState<"preview" | "source">("preview");
  const [fileData, setFileData] = React.useState<GitLabFile | null>(null);
  const [fileLoading, setFileLoading] = React.useState(false);
  const [editText, setEditText] = React.useState("");
  const [editSaving, setEditSaving] = React.useState(false);
  const [blameGroups, setBlameGroups] = React.useState<GitLabBlameGroup[]>([]);
  const [blameLoading, setBlameLoading] = React.useState(false);
  const [editMenuOpen, setEditMenuOpen] = React.useState(false);
  const [mrIid, setMrIid] = React.useState<number | null>(null);
  const [mrDetail, setMrDetail] = React.useState<GitLabMergeRequest | null>(null);
  const [mrCommits, setMrCommits] = React.useState<any[]>([]);
  const [mrPipelines, setMrPipelines] = React.useState<any[]>([]);
  const [mrNotes, setMrNotes] = React.useState<any[]>([]);
  const [mrDiff, setMrDiff] = React.useState("");
  const [mrLoading, setMrLoading] = React.useState(false);
  const [mrBusy, setMrBusy] = React.useState(false);
  const [mrEpoch, setMrEpoch] = React.useState(0);
  const [mrSource, setMrSource] = React.useState("");
  const [mrTarget, setMrTarget] = React.useState("");
  const [commitSha, setCommitSha] = React.useState("");
  const [commitDetail, setCommitDetail] = React.useState<any>(null);
  const [commitDiff, setCommitDiff] = React.useState("");
  const [commitLoading, setCommitLoading] = React.useState(false);
  const [commitEpoch, setCommitEpoch] = React.useState(0);
  const [creatingMr, setCreatingMr] = React.useState(false);
  const [createTitle, setCreateTitle] = React.useState("");
  const [createSource, setCreateSource] = React.useState("");
  const [createTarget, setCreateTarget] = React.useState("");
  const [createDescription, setCreateDescription] = React.useState("");
  const [createBusy, setCreateBusy] = React.useState(false);
  const [managedProjects, setManagedProjects] = React.useState<GitLabProject[]>([]);
  const [connectionFilter, setConnectionFilter] = React.useState("");
  const [cloneTarget, setCloneTarget] = React.useState<GitLabProject | null>(null);
  const [cloneParent, setCloneParent] = React.useState("");
  const [cloneName, setCloneName] = React.useState("");
  const [cloneBusy, setCloneBusy] = React.useState(false);
  const [cloneMessage, setCloneMessage] = React.useState("");
  const [clonePath, setClonePath] = React.useState("");
  const [cloneProtocol, setCloneProtocol] = React.useState<CloneProtocol>("https");
  const [cloneShallow, setCloneShallow] = React.useState(false);
  const [cloneAttachPath, setCloneAttachPath] = React.useState("");
  const [cloneLinkBusy, setCloneLinkBusy] = React.useState(false);
  const [createRepoOpen, setCreateRepoOpen] = React.useState(false);
  const [createRepoName, setCreateRepoName] = React.useState("");
  const [createRepoOwner, setCreateRepoOwner] = React.useState("");
  const [createRepoDescription, setCreateRepoDescription] = React.useState("");
  const [createRepoPrivate, setCreateRepoPrivate] = React.useState(true);
  const [createRepoReadme, setCreateRepoReadme] = React.useState(false);
  const [createRepoCheck, setCreateRepoCheck] = React.useState<GitHostRepoCheck | null>(null);
  const [createRepoBusy, setCreateRepoBusy] = React.useState(false);
  const [createRepoMessage, setCreateRepoMessage] = React.useState("");
  const createRepoCheckTimer = React.useRef<number | null>(null);
  useCoverBrowser(Boolean(cloneTarget) || createRepoOpen);
  const queryRef = React.useRef(query);
  queryRef.current = query;

  React.useEffect(() => {
    void api.preferences.read().then((prefs) => {
      const parent = String(prefs.clone_parent_dir || "").trim();
      const protocol = prefs.clone_protocol === "ssh" ? "ssh" : prefs.clone_protocol === "https" ? "https" : "";
      if (parent) setCloneParent(parent);
      if (protocol) setCloneProtocol(protocol);
      setCloneShallow(prefs.clone_shallow === true);
    }).catch(() => { /* keep defaults */ });
  }, []);

  async function rememberClonePrefs(next: { parent?: string; protocol?: CloneProtocol; shallow?: boolean } = {}) {
    const parent = next.parent ?? cloneParent;
    const protocol = next.protocol ?? cloneProtocol;
    const shallow = next.shallow ?? cloneShallow;
    try {
      if (parent) await api.preferences.write("clone_parent_dir", parent);
      await api.preferences.write("clone_protocol", protocol);
      await api.preferences.write("clone_shallow", shallow);
    } catch {
      /* preference write is optional */
    }
  }

  const projectKey = `${provider}:${status?.projectPath || ""}:${status?.project?.id ?? ""}`;
  const [seenProject, setSeenProject] = React.useState(projectKey);
  if (seenProject !== projectKey) {
    setSeenProject(projectKey);
    setRefName(String(status?.project?.defaultBranch || status?.currentBranch || ""));
    setTreePath("");
    setFilePath("");
    setFileData(null);
    setTree([]);
    setTreeIndex([]);
    setLatestCommit(null);
    setMessage("");
    setCommitSha("");
    setCommitDetail(null);
    setCommitDiff("");
  }
  const activeRef = refName || status?.project?.defaultBranch || status?.currentBranch || repository?.defaultBranch || "";
  const projectUrl = repository?.webUrl || status?.project?.webUrl || "";

  const refresh = React.useCallback(async (nextTab = tab, path = treePath, ref = activeRef) => {
    if (nextTab !== "projects" && !status?.available) {
      setMessage(status?.reason || copy.disabled);
      return;
    }
    setLoading(true);
    setMessage("");
    try {
      if (nextTab === "projects") {
        const result = await client.projects({ connectionId: connectionFilter || undefined, search: queryRef.current });
        setManagedProjects(result.items || []);
      } else if (nextTab === "mergeRequests") {
        const [result, branchList] = await Promise.all([client.mergeRequests(), client.branches()]);
        setMergeRequests(asItems(result));
        setBranches(asItems(branchList));
      } else if (nextTab === "branches") {
        const result = await client.branches();
        setBranches(asItems(result));
      } else if (nextTab === "commits") {
        const result = await client.commits({ ref: ref || activeRef, perPage: 50 });
        setCommits(asItems(result));
      } else if (nextTab === "tags") {
        const result = await client.tags();
        setTags(asItems(result));
      } else if (nextTab === "repository") {
        const resolvedRef = String(
          ref ||
            status?.project?.defaultBranch ||
            status?.currentBranch ||
            "",
        ).trim();
        const [project, files, latest, branchList] = await Promise.all([
          client.project(),
          client.tree({ path, ref: resolvedRef, withLastCommit: true, perPage: 100 }),
          client.commits({ ref: resolvedRef, perPage: 1 }),
          client.branches(),
        ]);
        const listed = asItems(files).sort(compareTreeItems);
        setRepository(project.project || status?.project);
        setTree(listed);
        setLatestCommit(asItems(latest)[0] || null);
        setBranches(asItems(branchList));
        setTreeIndex((current) => current.length ? current : listed);
        const nextRef = String(
          files.ref ||
            project.project?.defaultBranch ||
            status?.project?.defaultBranch ||
            status?.currentBranch ||
            resolvedRef ||
            "",
        ).trim();
        if (nextRef && nextRef !== refName) setRefName(nextRef);
      } else if (nextTab === "graph") {
        const result = await client.graph({ limit: graphLimit });
        setGraph(asItems(result));
        setGraphTotal(Number(result.total) || asItems(result).length);
        setGraphHasMore(Boolean(result.hasMore));
        setGraphShallow(Boolean(result.shallow));
      }
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [status, tab, treePath, refName, activeRef, client, copy.disabled, graphLimit, connectionFilter]);

  React.useEffect(() => {
    void refresh(tab, treePath, activeRef);
  }, [refresh, tab, treePath, activeRef]);
  React.useEffect(() => {
    if (tab !== "projects") return;
    const timer = window.setTimeout(() => void refresh("projects"), 280);
    return () => window.clearTimeout(timer);
  }, [query, refresh, tab]);
  const parkedForRemote = React.useRef(false);
  React.useEffect(() => {
    parkedForRemote.current = false;
  }, [provider, status?.workspaceRoot]);
  React.useEffect(() => {
    if (!status) return;
    if (!status.available) {
      if (!parkedForRemote.current) {
        parkedForRemote.current = true;
        setTab("projects");
      }
      return;
    }
    if (parkedForRemote.current) {
      parkedForRemote.current = false;
      setTab("repository");
      setMessage("");
      setRefName(String(status.project?.defaultBranch || status.currentBranch || ""));
      setTreePath("");
      setFilePath("");
    }
  }, [status]);

  React.useEffect(() => {
    setGraphLimit(GRAPH_PAGE);
  }, [status?.projectPath, provider]);

  React.useEffect(() => {
    if (tab !== "graph" || !graphHasMore || loading) return;
    const node = graphSentinel.current;
    if (!node) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setGraphLimit((current) => Math.min(5000, current + GRAPH_PAGE));
      }
    }, { rootMargin: "240px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [tab, graphHasMore, loading, graph.length]);

  React.useEffect(() => {
    if (!status?.available || tab !== "repository" || !filePath) {
      setFileData(null);
      setBlameGroups([]);
      return;
    }
    let cancelled = false;
    setFileLoading(true);
    void client
      .file({ path: filePath, ref: activeRef })
      .then((result) => {
        if (cancelled) return;
        setFileData(result.file);
        setEditText(result.file.content || "");
        setMessage("");
      })
      .catch((error) => {
        if (cancelled) return;
        setFileData(null);
        setMessage(errorText(error));
      })
      .finally(() => {
        if (!cancelled) setFileLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status, tab, filePath, activeRef, client]);

  React.useEffect(() => {
    if (!status?.available || tab !== "repository" || !filePath || fileView !== "blame") {
      return;
    }
    let cancelled = false;
    setBlameLoading(true);
    void client
      .blame({ path: filePath, ref: activeRef })
      .then((result) => {
        if (!cancelled) {
          setBlameGroups(result.items || []);
          setMessage("");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setBlameGroups([]);
          setMessage(errorText(error));
        }
      })
      .finally(() => {
        if (!cancelled) setBlameLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [status, tab, filePath, activeRef, fileView, client]);

  React.useEffect(() => {
    if (!status?.available || tab !== "repository") return;
    let cancelled = false;
    void client
      .tree({ ref: activeRef, recursive: true, perPage: 100 })
      .then((result) => {
        if (!cancelled) setTreeIndex(asItems(result));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [status, tab, activeRef, client]);

  React.useEffect(() => {
    if (!status?.available || tab !== "mergeRequests" || !mrIid) return;
    let cancelled = false;
    setMrLoading(true);
    const query = {
      iid: mrIid,
      sourceBranch: mrSource,
      targetBranch: mrTarget,
      sha: mrDetail?.sha || "",
    };
    void (async () => {
      try {
        const [detail, commitList, diffs, notes, pipelines] = await Promise.all([
          client.mergeRequest({ iid: mrIid }),
          client.mergeRequestCommits(query).catch(() => ({ items: [] as any[] })),
          client.mergeRequestDiffs(query).catch(() => ({ diff: "" })),
          client.mergeRequestNotes({ iid: mrIid }).catch(() => ({ items: [] as any[] })),
          client.mergeRequestPipelines(query).catch(() => ({ items: [] as any[] })),
        ]);
        if (cancelled) return;
        setMrDetail(detail.mergeRequest);
        setMrSource(detail.mergeRequest.sourceBranch || mrSource);
        setMrTarget(detail.mergeRequest.targetBranch || mrTarget);
        setMrCommits(commitList.items || []);
        setMrDiff(diffs.diff || "");
        setMrNotes(notes.items || []);
        setMrPipelines(pipelines.items || []);
        setMessage("");
      } catch (error) {
        if (!cancelled) setMessage(errorText(error));
      } finally {
        if (!cancelled) setMrLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status?.available, tab, mrIid, mrEpoch, client]);

  React.useEffect(() => {
    if (!status?.available || !commitSha) return;
    let cancelled = false;
    setCommitLoading(true);
    void client.commitDiff({ sha: commitSha }).then((result) => {
      if (cancelled) return;
      setCommitDetail(result.commit || { id: commitSha });
      setCommitDiff(result.diff || "");
      setMessage("");
    }).catch((error) => {
      if (!cancelled) setMessage(errorText(error));
    }).finally(() => {
      if (!cancelled) setCommitLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [status?.available, commitSha, commitEpoch, client]);

  const needle = query.trim().toLowerCase();
  const filteredMrs = mergeRequests.filter((item) => !needle || `${item.title} ${item.sourceBranch} ${item.targetBranch} ${item.author}`.toLowerCase().includes(needle));
  const branchOptions = Array.from(new Set(branches.map((item) => String(item.name || "")).filter(Boolean)));
  const filteredBranches = branches.filter((item) => !needle || `${item.name} ${item.commitTitle}`.toLowerCase().includes(needle));
  const filteredCommits = commits.filter((item) => !needle || `${item.title} ${item.shortId} ${item.authorName}`.toLowerCase().includes(needle));
  const filteredTags = tags.filter((item) => !needle || `${item.name} ${item.message} ${item.commitTitle}`.toLowerCase().includes(needle));
  const filteredTree = tree.filter((item) => !needle || `${item.name} ${item.path} ${item.lastCommitTitle || ""}`.toLowerCase().includes(needle));
  const treeNeedle = treeQuery.trim().toLowerCase();
  const nestedTree = React.useMemo(() => nestTree(treeIndex.filter((item) => !treeNeedle || `${item.name} ${item.path}`.toLowerCase().includes(treeNeedle))), [treeIndex, treeNeedle]);
  const crumbs = treePath ? treePath.split("/").filter(Boolean) : [];
  const fileName = filePath.split("/").pop() || "";
  const displayedCommit = fileData?.commit || latestCommit;
  const emptyText = (kind: string) => {
    if (loading || fileLoading) return `正在读取${kind}…`;
    if (message) return `读取失败：${message}`;
    return `没有匹配的${kind}`;
  };

  function openRepositoryRef(ref: string) {
    const next = String(ref || "").trim();
    if (!next) return;
    setCommitSha("");
    setCommitDetail(null);
    setCommitDiff("");
    setRefName(next);
    setTab("repository");
    setFilePath("");
    setFileView("view");
    setEditMenuOpen(false);
    setCodeMenuOpen(false);
    setTreePath("");
    setQuery("");
  }

  function openCommitDiff(sha: string, item?: any) {
    const next = String(sha || item?.id || "").trim();
    if (!next) return;
    setCommitSha(next);
    setCommitDetail(item || { id: next });
    setCommitDiff("");
    setQuery("");
    setMessage("");
  }

  function closeCommitDiff() {
    setCommitSha("");
    setCommitDetail(null);
    setCommitDiff("");
    setCommitLoading(false);
  }

  function openMergeRequest(item: GitLabMergeRequest) {
    const iid = Number(item.iid);
    if (!Number.isFinite(iid) || iid <= 0) return;
    setMrIid(iid);
    setMrDetail(item);
    setMrSource(item.sourceBranch || "");
    setMrTarget(item.targetBranch || "");
    setMrCommits([]);
    setMrPipelines([]);
    setMrNotes([]);
    setMrDiff("");
    setQuery("");
    setMessage("");
  }

  function closeMergeRequest() {
    setMrIid(null);
    setMrDetail(null);
    setMrSource("");
    setMrTarget("");
    setMrCommits([]);
    setMrPipelines([]);
    setMrNotes([]);
    setMrDiff("");
    setMrLoading(false);
  }

  function beginCreateMergeRequest() {
    const names = branches.map((item) => String(item.name || "")).filter(Boolean);
    setCreatingMr(true);
    setCreateTitle("");
    setCreateSource(status?.currentBranch || names[0] || "");
    setCreateTarget(status?.project?.defaultBranch || repository?.defaultBranch || names[0] || "");
    setCreateDescription("");
    setMessage("");
    if (!names.length) void refresh("mergeRequests");
  }

  React.useEffect(() => {
    if (!creatingMr) return;
    const names = branches.map((item) => String(item.name || "")).filter(Boolean);
    if (!names.length) return;
    setCreateSource((current) => current || status?.currentBranch || names[0]);
    setCreateTarget((current) => current || status?.project?.defaultBranch || repository?.defaultBranch || names[0]);
  }, [creatingMr, branches, status, repository]);

  async function submitCreateMergeRequest() {
    if (createBusy) return;
    setCreateBusy(true);
    setMessage("");
    try {
      const result = await client.createMergeRequest({
        title: createTitle.trim(),
        sourceBranch: createSource.trim(),
        targetBranch: createTarget.trim(),
        description: createDescription.trim(),
      });
      setCreatingMr(false);
      if (result.mergeRequest) openMergeRequest(result.mergeRequest);
      else void refresh("mergeRequests");
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setCreateBusy(false);
    }
  }

  async function submitNote(body: string) {
    if (!mrIid) return;
    const result = await client.createNote({ iid: mrIid, body });
    if (result.note) setMrNotes((old) => [...old, result.note]);
    else setMrEpoch((value) => value + 1);
  }

  async function submitReviewComment(comment: { path: string; body: string; newLine?: number; oldLine?: number }) {
    if (!mrIid) return;
    const result = await client.createReviewComment({
      iid: mrIid,
      body: comment.body,
      path: comment.path,
      newLine: comment.newLine,
      oldLine: comment.oldLine,
      sha: mrDetail?.sha,
      diffRefs: mrDetail?.diffRefs,
    });
    if (result.note) setMrNotes((old) => [...old, result.note]);
    else setMrEpoch((value) => value + 1);
  }

  async function approveCurrentMr() {
    if (!mrIid || mrBusy) return;
    setMrBusy(true);
    setMessage("");
    try {
      const result = await client.approveMergeRequest({ iid: mrIid });
      if (result.mergeRequest) applyMergeRequest(result.mergeRequest);
      else setMrEpoch((value) => value + 1);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setMrBusy(false);
    }
  }

  async function createRemoteBranch() {
    setBranchError("");
    setBranchDraft("");
    setBranchDialog(true);
  }

  async function submitRemoteBranch(name: string) {
    const trimmed = name.trim();
    if (!/^[A-Za-z0-9._/-]+$/.test(trimmed) || trimmed.includes("..")) {
      setBranchError("分支名无效");
      return;
    }
    const ref = activeRef || "HEAD";
    setMessage("");
    try {
      const result = await client.createBranch({ name: trimmed, ref });
      setMessage(`已创建分支 ${result.branch?.name || trimmed}`);
      setBranchDialog(false);
      await refresh("branches");
      setTab("branches");
    } catch (error) {
      setBranchError(errorText(error));
    }
  }

  function applyMergeRequest(next: GitLabMergeRequest) {
    setMrDetail(next);
    setMergeRequests((old) => old.map((item) => (Number(item.iid) === Number(next.iid) ? { ...item, ...next } : item)));
  }

  async function mergeCurrentMr() {
    if (!mrIid || mrBusy) return;
    if (!(await dialog.confirm("合并请求", `确认合并 ${copy.prefix}${mrIid}？`))) return;
    setMrBusy(true);
    setMessage("");
    try {
      const result = await client.mergeMergeRequest({ iid: mrIid });
      if (result.mergeRequest) applyMergeRequest(result.mergeRequest);
      else setMrEpoch((value) => value + 1);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setMrBusy(false);
    }
  }

  async function updateCurrentMrState(stateEvent: "close" | "reopen") {
    if (!mrIid || mrBusy) return;
    setMrBusy(true);
    setMessage("");
    try {
      const result = await client.updateMergeRequestState({ iid: mrIid, stateEvent });
      if (result.mergeRequest) applyMergeRequest(result.mergeRequest);
      else setMrEpoch((value) => value + 1);
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setMrBusy(false);
    }
  }

  function openGitLab(event: React.MouseEvent, url?: string) {
    event.stopPropagation();
    if (url) void api.app.openExternalUrl(url);
  }

  function closeClone(force = false) {
    if (!force && (cloneBusy || cloneLinkBusy)) return;
    setCloneTarget(null);
    setCloneMessage("");
    setClonePath("");
    setCloneAttachPath("");
  }

  async function pickCloneParent() {
    try {
      const picked = await api.workspace.pick({ title: "选择克隆到的目录" });
      if (!picked.canceled && picked.root) {
        setCloneParent(picked.root);
        void rememberClonePrefs({ parent: picked.root });
      }
    } catch (error) {
      setCloneMessage(errorText(error));
    }
  }

  async function beginClone(project: GitLabProject) {
    const name = String(project.pathWithNamespace || project.name || "repository").split("/").pop() || "repository";
    setCloneTarget(project);
    setCloneName(name);
    setCloneMessage("");
    setClonePath("");
    setCloneAttachPath("");
    if (!cloneParent.trim()) await pickCloneParent();
  }

  const attachableProjects = projects.filter((project) => !clonePath || !projectHasRoot(project, clonePath));

  async function finishCloneUse(project: CodexProject) {
    onProjectChanged?.(project);
    onUseClone?.(clonePath);
    closeClone(true);
  }

  async function createCloneProject() {
    if (!clonePath) return;
    const name = cloneName.trim() || cloneTarget?.name || "repository";
    setCloneLinkBusy(true);
    setCloneMessage("");
    try {
      try {
        await api.appServer.request("project/create", { name, roots: [{ path: clonePath }], idempotencyKey: crypto.randomUUID() });
      } catch {
        /* local registration still creates the conversation project */
      }
      const registered = await api.codex.registerProject(clonePath, name);
      setCloneMessage(`已创建项目 ${registered.name}`);
      await finishCloneUse(registered);
    } catch (error) {
      setCloneMessage(errorText(error));
    } finally {
      setCloneLinkBusy(false);
    }
  }

  async function attachCloneProject() {
    if (!clonePath || !cloneAttachPath) {
      setCloneMessage("请先选择要加入的项目");
      return;
    }
    const target = projects.find((project) => sameProjectPath(project.path, cloneAttachPath));
    if (!target) {
      setCloneMessage("未找到该项目");
      return;
    }
    setCloneLinkBusy(true);
    setCloneMessage("");
    try {
      if (target.id) {
        const roots = Array.from(new Set([...(target.rootPaths || [target.path]), clonePath]));
        try {
          await api.appServer.request("project/update", { projectId: target.id, roots: roots.map((item) => ({ path: item })) });
        } catch {
          /* local project list is enough if app-server is unavailable */
        }
      }
      const updated = await api.codex.addProjectRoot(target.path, clonePath);
      setCloneMessage(`已加入项目 ${updated.name}`);
      onProjectChanged?.(updated);
      await onAssignClone?.(updated, clonePath);
      closeClone(true);
    } catch (error) {
      setCloneMessage(errorText(error));
    } finally {
      setCloneLinkBusy(false);
    }
  }

  async function submitClone() {
    if (!cloneTarget || !cloneParent.trim()) {
      setCloneMessage("请先选择要克隆到的目录");
      if (!cloneParent.trim()) await pickCloneParent();
      return;
    }
    setCloneBusy(true);
    setCloneMessage("正在克隆…");
    try {
      const result = await client.clone({
        url: cloneProtocol === "ssh" ? cloneTarget.sshUrl : cloneTarget.httpUrl,
        httpUrl: cloneTarget.httpUrl,
        sshUrl: cloneTarget.sshUrl,
        webUrl: cloneTarget.webUrl,
        protocol: cloneProtocol,
        parentDir: cloneParent,
        folderName: cloneName,
        connectionId: cloneTarget.connectionId || connectionFilter,
        shallow: cloneShallow,
      });
      setClonePath(result.path);
      setCloneMessage(`已克隆到 ${result.path}`);
      void rememberClonePrefs();
      await onOpenCloneWorkspace?.(result.path);
    } catch (error) {
      setCloneMessage(errorText(error));
    } finally {
      setCloneBusy(false);
    }
  }

  function scheduleCreateRepoCheck(next?: { name?: string; owner?: string; private?: boolean }) {
    if (createRepoCheckTimer.current) window.clearTimeout(createRepoCheckTimer.current);
    createRepoCheckTimer.current = window.setTimeout(() => {
      void runCreateRepoCheck(next);
    }, 400);
  }

  async function runCreateRepoCheck(next?: { name?: string; owner?: string; private?: boolean }) {
    const name = (next?.name ?? createRepoName).trim();
    const owner = (next?.owner ?? createRepoOwner).trim();
    const isPrivate = next?.private ?? createRepoPrivate;
    setCreateRepoBusy(true);
    setCreateRepoMessage("");
    try {
      const result = await client.checkRepository({
        name,
        owner,
        private: isPrivate,
        connectionId: connectionFilter || undefined,
      });
      setCreateRepoCheck(result);
      if (!owner && result.login) setCreateRepoOwner(result.login);
      setCreateRepoMessage(result.reason || (result.canCreate ? "只读检查通过，可以创建" : ""));
    } catch (error) {
      setCreateRepoCheck(null);
      setCreateRepoMessage(errorText(error));
    } finally {
      setCreateRepoBusy(false);
    }
  }

  function beginCreateRepo() {
    setCreateRepoOpen(true);
    setCreateRepoName("");
    setCreateRepoOwner("");
    setCreateRepoDescription("");
    setCreateRepoPrivate(true);
    setCreateRepoReadme(false);
    setCreateRepoCheck(null);
    setCreateRepoMessage("");
    void runCreateRepoCheck({ name: "", owner: "", private: true });
  }

  async function submitCreateRepo() {
    if (!createRepoName.trim()) {
      setCreateRepoMessage("请填写仓库名");
      return;
    }
    setCreateRepoBusy(true);
    setCreateRepoMessage("正在创建仓库…");
    try {
      const checked = await client.checkRepository({
        name: createRepoName.trim(),
        owner: createRepoOwner.trim(),
        private: createRepoPrivate,
        connectionId: connectionFilter || undefined,
      });
      setCreateRepoCheck(checked);
      if (checked.exists) {
        setCreateRepoMessage(checked.reason || "仓库已存在");
        if (checked.project) {
          setManagedProjects((old) => {
            const key = checked.project?.pathWithNamespace || checked.fullName;
            if (old.some((item) => (item.pathWithNamespace || item.name) === key)) return old;
            return [checked.project as GitLabProject, ...old];
          });
        }
        return;
      }
      const created = await client.createRepository({
        name: createRepoName.trim(),
        owner: createRepoOwner.trim(),
        description: createRepoDescription.trim(),
        private: createRepoPrivate,
        autoInit: createRepoReadme,
        connectionId: connectionFilter || undefined,
      });
      setCreateRepoCheck(created);
      if (created.project) {
        setManagedProjects((old) => [created.project as GitLabProject, ...old]);
      }
      setCreateRepoMessage(created.created ? `已创建 ${created.fullName || createRepoName}` : created.reason || "创建完成");
      if (created.project) {
        setCreateRepoOpen(false);
        void beginClone(created.project);
      }
    } catch (error) {
      setCreateRepoMessage(errorText(error));
    } finally {
      setCreateRepoBusy(false);
    }
  }

  function openDirectory(path: string) {
    setFilePath("");
    setFileView("view");
    setEditMenuOpen(false);
    setTreePath(path);
    setQuery("");
  }

  function openPath(item: TreeItem) {
    if (item.type === "tree") {
      openDirectory(item.path);
      return;
    }
    setFilePath(item.path);
    setFileView("view");
    setFileRender("preview");
    setEditMenuOpen(false);
    setTreePath(parentDir(item.path));
    setQuery("");
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  }

  function downloadFile() {
    if (!fileData) return;
    const blob = fileData.dataUrl ? undefined : new Blob([fileData.content], { type: "text/plain;charset=utf-8" });
    const url = fileData.dataUrl || (blob ? URL.createObjectURL(blob) : "");
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = fileData.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    if (blob) URL.revokeObjectURL(url);
  }

  function workspaceAbsolutePath() {
    const root = String(status?.workspaceRoot || "").replace(/[\\/]+$/, "");
    if (!root || !filePath) return "";
    const separator = root.includes("\\") ? "\\" : "/";
    return `${root}${separator}${filePath.split("/").join(separator)}`;
  }

  async function saveEdit() {
    const absolute = workspaceAbsolutePath();
    if (!absolute) {
      setMessage("当前工作区没有可写入的本地文件");
      return;
    }
    setEditSaving(true);
    try {
      await api.workspace.writeFile(absolute, editText);
      setFileData((current) => (current ? { ...current, content: editText, size: new Blob([editText]).size } : current));
      setFileView("view");
      setMessage("");
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setEditSaving(false);
    }
  }

  function renderTreeNodes(nodes: TreeNode[], depth = 0): React.ReactNode {
    return nodes.map((node) => {
      const selected = node.type === "tree" ? !filePath && treePath === node.path : filePath === node.path;
      if (node.type === "tree") {
        const opened = Boolean(treeNeedle) || treePath === node.path || treePath.startsWith(`${node.path}/`) || filePath === node.path || filePath.startsWith(`${node.path}/`);
        return (
          <details className="gitlab-file-tree-directory" key={node.path} open={opened || Boolean(treeNeedle)}>
            <summary
              className={selected ? "active" : ""}
              style={{ paddingLeft: `${8 + depth * 14}px` }}
              onClick={(event) => {
                event.preventDefault();
                openDirectory(node.path);
              }}
            >
              <UiIcon icon={opened ? icons.folderOpen : icons.folder} />
              <span>{node.name}</span>
            </summary>
            {node.children.length > 0 && renderTreeNodes(node.children, depth + 1)}
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
          onClick={() => openPath(node)}
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
        <div className="plugins-tabs" role="tablist" aria-label={`${copy.name} 管理`}>
          {tabs.map((entry) => (
            <button
              key={entry.key}
              role="tab"
              aria-selected={tab === entry.key}
              className={tab === entry.key ? "active" : ""}
              onClick={() => {
                closeCommitDiff();
                setTab(entry.key);
              }}
            >
              <UiIcon icon={entry.icon} /> {entry.label}
            </button>
          ))}
        </div>
        <div className="plugins-toolbar-actions">
          <button title="刷新" onClick={() => {
            void (async () => {
              try {
                onStatusChange?.(await client.status());
              } catch {
                /* keep the last known host status */
              }
              if (mrIid) setMrEpoch((current) => current + 1);
              if (commitSha) setCommitEpoch((current) => current + 1);
              void refresh();
            })();
          }} disabled={loading || mrLoading || commitLoading}>
            <UiIcon icon={icons.refresh} />
          </button>
          <button title={copy.settings} onClick={onOpenSettings}>
            <UiIcon icon={icons.gear} />
          </button>
          {projectUrl && (
            <button className="plugins-add" onClick={() => void api.app.openExternalUrl(projectUrl)}>
              <UiIcon icon={icons.external} /> {copy.openHost}
            </button>
          )}
        </div>
      </div>
      {tab === "repository" && !commitSha ? (
        <div className="plugins-content gitlab-content gitlab-code-page">
          {status?.reason && <div className="plugins-message">{status.reason}</div>}
          {message && <div className="plugins-message">{message}</div>}
          <div className="gitlab-code">
            <aside className="gitlab-code-tree">
              <div className="gitlab-code-tree-head">
                <UiIcon icon={icons.folder} />
                <strong>文件</strong>
              </div>
              <label className="gitlab-code-tree-search">
                <UiIcon icon={icons.search} />
                <input value={treeQuery} onChange={(event) => setTreeQuery(event.target.value)} placeholder="Search files (*.vue, *.rb...)" />
              </label>
              <div className="gitlab-code-tree-list">
                <button
                  type="button"
                  className={`gitlab-file-tree-file gitlab-file-tree-root ${treePath || filePath ? "" : "active"}`}
                  onClick={() => openDirectory("")}
                >
                  <UiIcon icon={icons.folderOpen} />
                  <span>{status?.project?.name?.split(" / ").pop() || status?.projectPath?.split("/").pop() || "repository"}</span>
                </button>
                {nestedTree.length === 0 ? <div className="plugins-empty">{emptyText("文件")}</div> : renderTreeNodes(nestedTree)}
              </div>
            </aside>
            <div className="gitlab-code-main">
              <div className="gitlab-code-toolbar">
                <div className="gitlab-code-crumbs">
                  <UiIcon icon={filePath ? fileIconForName(fileName) : icons.folder} />
                  <button type="button" className={!treePath && !filePath ? "active" : ""} onClick={() => openDirectory("")}>
                    {status?.project?.name?.split(" / ").pop() || status?.projectPath?.split("/").pop() || "repository"}
                  </button>
                  {crumbs.map((part, index) => {
                    const path = crumbs.slice(0, index + 1).join("/");
                    return (
                      <React.Fragment key={path}>
                        <span>/</span>
                        <button type="button" className={!filePath && path === treePath ? "active" : ""} onClick={() => openDirectory(path)}>
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
                  value={activeRef}
                  options={Array.from(new Set([
                    ...branches.map((item) => item.name),
                    ...tags.map((item) => item.name),
                  ].filter(Boolean)))}
                  onChange={(name) => {
                    setRefName(name);
                    if (!filePath) setTreePath("");
                  }}
                />
                {filePath ? (
                  <div className="gitlab-code-actions gitlab-file-actions">
                    <button type="button" className={fileView === "view" ? "active" : ""} onClick={() => { setEditMenuOpen(false); setFileView("view"); }}>
                      <UiIcon icon={icons.fileCode} /> 查看文件
                    </button>
                    <button type="button" className={fileView === "blame" ? "active" : ""} onClick={() => { setEditMenuOpen(false); setFileView("blame"); }}>
                      <UiIcon icon={icons.comment} /> Blame
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
                          <button type="button" onClick={() => { setEditMenuOpen(false); setFileView("edit"); }}>
                            在应用中编辑
                          </button>
                          {projectUrl && (
                            <button type="button" onClick={() => { setEditMenuOpen(false); void api.app.openExternalUrl(blobUrl(projectUrl, activeRef, filePath, provider)); }}>
                              {copy.openIn}
                            </button>
                          )}
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
                      <button type="button" title="新建" onClick={() => projectUrl && void api.app.openExternalUrl(treeUrl(projectUrl, activeRef, treePath, provider))}>
                        <UiIcon icon={icons.plus} />
                        <UiIcon icon={icons.down} />
                      </button>
                      <div className="gitlab-code-menu">
                        <button type="button" className="gitlab-code-button" onClick={() => setCodeMenuOpen((open) => !open)}>
                          代码 <UiIcon icon={icons.down} />
                        </button>
                        {codeMenuOpen && (
                          <div className="gitlab-code-popover">
                            <button type="button" onClick={() => { setCodeMenuOpen(false); if (projectUrl) void api.app.openExternalUrl(treeUrl(projectUrl, activeRef, treePath, provider)); }}>
                              {copy.openIn}
                            </button>
                            <button type="button" onClick={() => { setCodeMenuOpen(false); void copyText(status?.remoteUrl || projectUrl); }}>
                              复制克隆地址
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  </>
                )}
              </div>
              {displayedCommit && (
                <div className="gitlab-code-commit">
                  <span className="gitlab-avatar">{String(displayedCommit.authorName || "?").slice(0, 1)}</span>
                  <div>
                    <strong>
                      <button type="button" className="gitlab-code-commit-open" onClick={() => displayedCommit.id && openCommitDiff(displayedCommit.id, displayedCommit)}>
                        {displayedCommit.title}
                      </button>
                    </strong>
                    <small>{displayedCommit.authorName || "未知作者"} authored {relativeTime(String(displayedCommit.authoredDate || ""))}</small>
                  </div>
                  <span className="gitlab-code-sha">
                    {shortSha(displayedCommit.shortId || displayedCommit.id)}
                    <button type="button" title="复制提交" onClick={() => void copyText(displayedCommit.id || displayedCommit.shortId || "")}>
                      <UiIcon icon={icons.copy} />
                    </button>
                    <button type="button" title="历史" onClick={() => setTab("commits")}>
                      <UiIcon icon={icons.clock} /> 历史
                    </button>
                  </span>
                </div>
              )}
              {filePath ? (
                <div className="gitlab-file-pane">
                  {fileLoading ? (
                    <div className="plugins-empty">正在打开 {fileName}…</div>
                  ) : !fileData ? (
                    <div className="plugins-empty">{message || emptyText("文件")}</div>
                  ) : (
                    <div className="gitlab-file-card">
                      <div className="gitlab-file-card-head">
                        <strong>{fileData.name}</strong>
                        <span>{formatFileSize(fileData.size)}</span>
                        <span className="gitlab-file-card-tools">
                          {fileView === "view" && (isMarkdownPath(fileData.path || fileData.name || fileName) || isConfigPreviewPath(fileData.path || fileData.name || fileName)) && (
                            <button
                              type="button"
                              title={fileRender === "preview" ? "查看源码" : "查看预览"}
                              className={fileRender === "source" ? "active" : ""}
                              onClick={() => setFileRender((current) => (current === "preview" ? "source" : "preview"))}
                            >
                              <UiIcon icon={fileRender === "preview" ? icons.code : icons.fileLines} />
                            </button>
                          )}
                          {fileView === "edit" && (
                            <>
                              <button type="button" className="gitlab-code-button" disabled={editSaving || fileData.binary || fileData.image} onClick={() => void saveEdit()}>
                                {editSaving ? "保存中…" : "保存"}
                              </button>
                              <button type="button" onClick={() => { setEditText(fileData.content); setFileView("view"); }}>取消</button>
                            </>
                          )}
                          <button type="button" title="复制" disabled={!fileData.content} onClick={() => void copyText(fileData.content)}>
                            <UiIcon icon={icons.copy} />
                          </button>
                          <button type="button" title="下载" disabled={fileData.binary && !fileData.dataUrl && !fileData.content} onClick={downloadFile}>
                            <UiIcon icon={icons.download} />
                          </button>
                        </span>
                      </div>
                      {fileView === "blame" ? (
                        blameLoading ? <div className="plugins-empty">正在读取 Blame…</div> : blameGroups.length === 0 ? <div className="plugins-empty">{emptyText("Blame")}</div> : <BlameView groups={blameGroups} />
                      ) : fileView === "edit" ? (
                        fileData.binary || fileData.image ? <div className="plugins-empty">该文件不能在应用中编辑</div> : (
                          <MonacoFileEditor path={fileData.path} value={editText} onChange={setEditText} onSave={() => void saveEdit()} />
                        )
                      ) : fileData.image && fileData.dataUrl ? (
                        <div className="gitlab-file-image"><img src={fileData.dataUrl} alt={fileData.name} /></div>
                      ) : fileData.binary || fileData.tooLarge ? (
                        <div className="plugins-empty">{fileData.tooLarge ? "文件过大，无法在应用中预览" : "二进制文件无法预览"}</div>
                      ) : isMarkdownPath(fileData.path || fileData.name || fileName) && fileRender === "preview" ? (
                        <div className="gitlab-file-markdown">
                          <HostMarkdown resolveUrl={(href) => resolveRepoHref(href, filePath, projectUrl, activeRef, provider)}>
                            {fileData.content || ""}
                          </HostMarkdown>
                        </div>
                      ) : isConfigPreviewPath(fileData.path || fileData.name || fileName) && fileRender === "preview" ? (
                        <ConfigFilePreview path={fileData.path || fileData.name || fileName} content={fileData.content || ""} />
                      ) : (
                        <MonacoFileEditor path={fileData.path} value={fileData.content} readOnly />
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
                  <button type="button" className="gitlab-code-row" onClick={() => openDirectory(parentDir(treePath))}>
                    <span className="gitlab-name"><UiIcon icon={icons.folderOpen} /> ..</span>
                    <span />
                    <span />
                  </button>
                )}
                {filteredTree.length === 0 ? (
                  <div className="plugins-empty">{emptyText("仓库文件")}</div>
                ) : (
                  filteredTree.map((item) => (
                    <button type="button" className="gitlab-code-row" key={item.path || item.id} onClick={() => openPath(item)}>
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
        </div>
      ) : commitSha ? (
        <div className="plugins-content gitlab-content gitlab-mr-wrap">
          {status?.reason && <div className="plugins-message">{status.reason}</div>}
          {message && <div className="plugins-message">{message}</div>}
          <CommitDiffPage
            copy={copy}
            commit={commitDetail || { id: commitSha }}
            diff={commitDiff}
            loading={commitLoading}
            onBack={closeCommitDiff}
            onOpenFiles={() => openRepositoryRef(commitSha)}
            onOpenParent={(sha) => openCommitDiff(sha)}
            onOpenGitLab={openGitLab}
          />
        </div>
      ) : tab === "mergeRequests" && mrDetail ? (
        <div className="plugins-content gitlab-content gitlab-mr-wrap">
          {status?.reason && <div className="plugins-message">{status.reason}</div>}
          {message && <div className="plugins-message">{message}</div>}
          <MergeRequestDetail
            key={mrDetail.iid}
            copy={copy}
            mergeRequest={mrDetail}
            commits={mrCommits}
            pipelines={mrPipelines}
            notes={mrNotes}
            diff={mrDiff}
            loading={mrLoading}
            onBack={closeMergeRequest}
            onOpenRef={openRepositoryRef}
            onOpenCommit={openCommitDiff}
            onOpenGitLab={openGitLab}
            onCreateNote={submitNote}
            onCreateReviewComment={submitReviewComment}
            onMerge={() => void mergeCurrentMr()}
            onApprove={() => void approveCurrentMr()}
            onCloseMr={() => void updateCurrentMrState("close")}
            onReopen={() => void updateCurrentMrState("reopen")}
            actionBusy={mrBusy}
          />
        </div>
      ) : (
        <div className={`plugins-content gitlab-content${tab === "graph" ? " gitlab-graph-wrap" : ""}`}>
          <header className="plugins-heading">
            <h1>{tab === "projects" ? `可管理的${copy.name}项目` : (status?.project?.name || status?.projectPath || copy.name)}</h1>
            <p>
              {tab === "projects"
                ? "列出你有 Maintainer / Admin 权限的仓库，可克隆到任意目录，不必打开当前工作区。"
                : `${status?.projectPath || "当前工作区"}${status?.currentBranch ? ` · 当前 ${status.currentBranch}` : ""}${status?.project?.defaultBranch ? ` · 默认分支 ${status.project.defaultBranch}` : ""}`}
            </p>
          </header>
          <label className="plugins-search">
            <UiIcon icon={icons.search} />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tab === "projects" ? "搜索可管理的项目" : "搜索当前列表"} />
          </label>
          {tab === "projects" && (status?.connections || []).length > 1 && (
            <label className="plugins-search gitlab-connection-filter">
              <span>连接</span>
              <select value={connectionFilter} onChange={(event) => setConnectionFilter(event.target.value)}>
                <option value="">全部连接</option>
                {(status?.connections || []).filter((item) => item.enabled).map((item) => (
                  <option value={item.id} key={item.id}>{item.name || item.baseUrl}</option>
                ))}
              </select>
            </label>
          )}
          {tab !== "projects" && status?.reason && <div className="plugins-message">{status.reason}</div>}
          {message && <div className="plugins-message">{message}</div>}
          {tab === "projects" && (
            <section className="plugins-section">
              <div className="plugins-section-heading">
                <h2>项目</h2>
                <div className="plugins-section-heading-actions">
                  <span>{managedProjects.length}</span>
                  <button type="button" className="plugins-add" onClick={() => beginCreateRepo()}><UiIcon icon={icons.plus} /> 创建仓库</button>
                </div>
              </div>
              {createRepoOpen && (
                <div className="new-project-modal-backdrop" role="presentation" onMouseDown={() => !createRepoBusy && setCreateRepoOpen(false)}>
                  <form
                    className="new-project-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="create-repo-title"
                    onMouseDown={(event) => event.stopPropagation()}
                    onSubmit={(event) => { event.preventDefault(); void submitCreateRepo(); }}
                  >
                    <div className="new-project-modal-head">
                      <h2 id="create-repo-title">创建{copy.name}仓库</h2>
                      <button type="button" title="关闭" disabled={createRepoBusy} onClick={() => setCreateRepoOpen(false)}><UiIcon icon={icons.close} /></button>
                    </div>
                    <p className="gitlab-clone-target">先通过 REST 只读检查仓库是否存在以及 Token 权限，再创建。不会改本地仓库。</p>
                    <label className="new-project-name">
                      <span>仓库名</span>
                      <input
                        value={createRepoName}
                        onChange={(event) => {
                          setCreateRepoName(event.target.value);
                          scheduleCreateRepoCheck({ name: event.target.value });
                        }}
                        placeholder="例如 local-codex 或 owner/local-codex"
                        required
                      />
                    </label>
                    <label className="new-project-name">
                      <span>所有者</span>
                      <input
                        list="create-repo-owners"
                        value={createRepoOwner}
                        onChange={(event) => {
                          setCreateRepoOwner(event.target.value);
                          scheduleCreateRepoCheck({ owner: event.target.value });
                        }}
                        placeholder={createRepoCheck?.login || "当前登录用户"}
                      />
                      <datalist id="create-repo-owners">
                        {[createRepoCheck?.login, ...(createRepoCheck?.orgs || [])].filter(Boolean).map((item) => (
                          <option value={item as string} key={item as string} />
                        ))}
                      </datalist>
                    </label>
                    <label className="new-project-name">
                      <span>说明</span>
                      <input value={createRepoDescription} onChange={(event) => setCreateRepoDescription(event.target.value)} placeholder="可选" />
                    </label>
                    <label className="gitlab-clone-shallow">
                      <input type="checkbox" checked={createRepoPrivate} onChange={(event) => { setCreateRepoPrivate(event.target.checked); scheduleCreateRepoCheck({ private: event.target.checked }); }} />
                      私有仓库
                    </label>
                    <label className="gitlab-clone-shallow">
                      <input type="checkbox" checked={createRepoReadme} onChange={(event) => setCreateRepoReadme(event.target.checked)} />
                      用 README 初始化
                    </label>
                    {createRepoCheck && (
                      <div className="plugins-message">
                        {[
                          createRepoCheck.login ? `登录 ${createRepoCheck.login}` : "",
                          createRepoCheck.fullName || "",
                          createRepoCheck.exists ? "已存在" : createRepoCheck.name ? "不存在" : "",
                          createRepoCheck.scopes?.length ? `权限 ${createRepoCheck.scopes.join(", ")}` : "",
                          createRepoCheck.canCreate ? "可以创建" : "",
                        ].filter(Boolean).join(" · ")}
                      </div>
                    )}
                    {createRepoMessage && <div className={createRepoCheck?.canCreate ? "plugins-message" : "new-project-error"}>{createRepoMessage}</div>}
                    <div className="new-project-modal-actions">
                      <button type="button" className="new-project-cancel" disabled={createRepoBusy} onClick={() => setCreateRepoOpen(false)}>取消</button>
                      <button type="button" className="settings-action" disabled={createRepoBusy} onClick={() => void runCreateRepoCheck()}>{createRepoBusy ? "检查中…" : "只读检查"}</button>
                      <button type="submit" className="new-project-submit" disabled={createRepoBusy || !createRepoName.trim() || createRepoCheck?.exists === true || createRepoCheck?.canCreate === false}>
                        {createRepoBusy ? "处理中…" : "创建"}
                      </button>
                    </div>
                  </form>
                </div>
              )}
              {cloneTarget && (
                <div className="new-project-modal-backdrop" role="presentation" onMouseDown={() => closeClone()}>
                  <form
                    className="new-project-modal"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="clone-project-title"
                    onMouseDown={(event) => event.stopPropagation()}
                    onSubmit={(event) => { event.preventDefault(); void submitClone(); }}
                  >
                    <div className="new-project-modal-head">
                      <h2 id="clone-project-title">克隆项目</h2>
                      <button type="button" title="关闭" disabled={cloneBusy || cloneLinkBusy} onClick={() => closeClone()}><UiIcon icon={icons.close} /></button>
                    </div>
                    <p className="gitlab-clone-target">{cloneTarget.pathWithNamespace || cloneTarget.name}</p>
                    <strong className="new-project-source-label">协议</strong>
                    <div className="settings-segment gitlab-clone-protocol" role="radiogroup" aria-label="克隆协议">
                      <button type="button" role="radio" aria-checked={cloneProtocol === "https"} className={cloneProtocol === "https" ? "selected" : ""} onClick={() => { setCloneProtocol("https"); void rememberClonePrefs({ protocol: "https" }); }}>HTTPS</button>
                      <button type="button" role="radio" aria-checked={cloneProtocol === "ssh"} className={cloneProtocol === "ssh" ? "selected" : ""} onClick={() => { setCloneProtocol("ssh"); void rememberClonePrefs({ protocol: "ssh" }); }}>SSH</button>
                    </div>
                    <code className="gitlab-clone-url">{previewCloneUrl(cloneTarget, cloneProtocol) || (cloneProtocol === "ssh" ? "未找到 SSH 地址" : "未找到 HTTPS 地址")}</code>
                    <label className="gitlab-clone-shallow">
                      <input type="checkbox" checked={cloneShallow} onChange={(event) => { setCloneShallow(event.target.checked); void rememberClonePrefs({ shallow: event.target.checked }); }} />
                      浅克隆（只取最近一次提交）
                    </label>
                    <strong className="new-project-source-label">目标目录</strong>
                    <button type="button" className={`new-project-source ${cloneParent ? "selected" : ""}`} onClick={() => void pickCloneParent()}>
                      <UiIcon icon={cloneParent ? icons.folderOpen : icons.folder} />
                      <span>{cloneParent || "选择要克隆到的文件夹"}</span>
                    </button>
                    <label className="new-project-name">
                      <UiIcon icon={icons.folder} />
                      <input value={cloneName} onChange={(event) => setCloneName(event.target.value)} placeholder="仓库文件夹名" required />
                    </label>
                    {cloneMessage && <div className={clonePath || cloneBusy || cloneLinkBusy ? "plugins-message" : "new-project-error"}>{cloneMessage}</div>}
                    {clonePath && (
                      <div className="gitlab-clone-next">
                        <strong className="new-project-source-label">接下来</strong>
                        <button type="button" className="new-project-source selected" disabled={cloneLinkBusy} onClick={() => void createCloneProject()}>
                          <UiIcon icon={icons.plus} />
                          <span>创建新对话项目</span>
                          <small>用这个仓库新建项目并开始对话</small>
                        </button>
                        {attachableProjects.length > 0 && (
                          <div className="gitlab-clone-attach">
                            <select value={cloneAttachPath} onChange={(event) => setCloneAttachPath(event.target.value)} disabled={cloneLinkBusy}>
                              <option value="">选择现有项目</option>
                              {attachableProjects.map((project) => (
                                <option value={project.path} key={project.path}>{project.name}</option>
                              ))}
                            </select>
                            <button type="button" className="new-project-submit" disabled={cloneLinkBusy || !cloneAttachPath} onClick={() => void attachCloneProject()}>添加进去</button>
                          </div>
                        )}
                      </div>
                    )}
                    <div className="new-project-modal-actions">
                      <button type="button" className="new-project-cancel" disabled={cloneBusy || cloneLinkBusy} onClick={() => closeClone()}>取消</button>
                      {clonePath && (
                        <>
                          <button type="button" onClick={() => { setTab("repository"); closeClone(true); }}>查看仓库</button>
                          <button type="button" onClick={() => void api.workspace.reveal(clonePath)}>打开目录</button>
                        </>
                      )}
                      {!clonePath && <button type="submit" className="new-project-submit" disabled={cloneBusy}>{cloneBusy ? "克隆中…" : "克隆"}</button>}
                    </div>
                  </form>
                </div>
              )}
              {managedProjects.length === 0 ? <div className="plugins-empty">{loading ? "正在读取项目…" : "没有可管理的项目"}</div> : (
                <div className="gitlab-list">
                  {managedProjects.map((item) => (
                    <article className="gitlab-card" key={`${item.connectionId || "default"}:${item.id || item.pathWithNamespace}`}>
                      <div>
                        <strong>{item.pathWithNamespace || item.name}</strong>
                        <small>{[item.connectionName, item.visibility, item.defaultBranch, item.lastActivityAt ? formatDate(item.lastActivityAt) : ""].filter(Boolean).join(" · ")}</small>
                      </div>
                      {item.webUrl && <button type="button" title={copy.openIn} onClick={(event) => openGitLab(event, item.webUrl)}><UiIcon icon={icons.external} /></button>}
                      <button type="button" className="gitlab-clone-action" title="克隆到指定目录" onClick={() => void beginClone(item)}>克隆</button>
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
          {tab === "mergeRequests" && (
            <section className="plugins-section">
              <div className="plugins-section-heading">
                <h2>{copy.mr}</h2>
                <span>{filteredMrs.length}</span>
                <button type="button" className="plugins-add" onClick={beginCreateMergeRequest}><UiIcon icon={icons.plus} /> {copy.create}</button>
              </div>
              {creatingMr && (
                <form className="gitlab-create-form" onSubmit={(event) => { event.preventDefault(); void submitCreateMergeRequest(); }}>
                  <input value={createTitle} onChange={(event) => setCreateTitle(event.target.value)} placeholder="标题" required />
                  <div className="gitlab-create-branches">
                    <RefSelect
                      value={createSource}
                      options={branchOptions}
                      placeholder="源分支"
                      label="源分支"
                      onChange={setCreateSource}
                    />
                    <span>→</span>
                    <RefSelect
                      value={createTarget}
                      options={branchOptions}
                      placeholder="目标分支"
                      label="目标分支"
                      onChange={setCreateTarget}
                    />
                  </div>
                  <textarea value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} placeholder="描述（可选）" rows={4} />
                  <div className="gitlab-create-actions">
                    <button type="button" onClick={() => setCreatingMr(false)}>取消</button>
                    <button type="submit" className="plugins-add" disabled={!createTitle.trim() || !createSource.trim() || !createTarget.trim() || createBusy}>{createBusy ? "创建中…" : copy.create}</button>
                  </div>
                </form>
              )}
              {filteredMrs.length === 0 ? <div className="plugins-empty">{emptyText(copy.mr)}</div> : (
                <div className="gitlab-list">
                  {filteredMrs.map((item) => (
                    <article className="gitlab-card gitlab-card-open" key={item.iid}>
                      <button type="button" className="gitlab-card-main" onClick={() => openMergeRequest(item)}>
                        <strong>{copy.prefix}{item.iid} {item.title}</strong>
                        <small>{item.sourceBranch} → {item.targetBranch} · {item.author || "未知作者"} · {formatDate(item.updatedAt)}</small>
                      </button>
                      {item.draft && <span className="gitlab-state">草稿</span>}
                      <span className={`gitlab-state ${stateClass(item.state)}`}>{stateLabel(item.state) || item.state}</span>
                      {item.webUrl && <button type="button" title={copy.openIn} onClick={(event) => openGitLab(event, item.webUrl)}><UiIcon icon={icons.external} /></button>}
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
          {tab === "branches" && (
            <section className="plugins-section">
              <div className="plugins-section-heading"><h2>分支</h2><span>{filteredBranches.length}</span><button type="button" className="plugins-add" onClick={() => void createRemoteBranch()}><UiIcon icon={icons.plus} /> 新建分支</button></div>
              {filteredBranches.length === 0 ? <div className="plugins-empty">{emptyText("分支")}</div> : (
                <div className="gitlab-list">
                  {filteredBranches.map((item) => (
                    <article className="gitlab-card gitlab-card-open" key={item.name}>
                      <button type="button" className="gitlab-card-main" onClick={() => openRepositoryRef(item.name)}>
                        <strong>{item.name}</strong>
                        <small>{shortSha(item.commitId)} {item.commitTitle || ""} · {formatDate(item.commitDate)}</small>
                      </button>
                      {item.protected && <span className="gitlab-state merged">受保护</span>}
                      {item.default && <span className="gitlab-state open">默认</span>}
                      {item.webUrl && <button type="button" title={copy.openIn} onClick={(event) => openGitLab(event, item.webUrl)}><UiIcon icon={icons.external} /></button>}
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
          {tab === "commits" && (
            <section className="plugins-section">
              <div className="plugins-section-heading"><h2>提交</h2><span>{filteredCommits.length}</span></div>
              {filteredCommits.length === 0 ? <div className="plugins-empty">{emptyText("提交")}</div> : (
                <div className="gitlab-list">
                  {filteredCommits.map((item) => (
                    <article className="gitlab-card gitlab-card-open" key={item.id}>
                      <button type="button" className="gitlab-card-main" onClick={() => openCommitDiff(item.id, item)}>
                        <strong>{item.title}</strong>
                        <small>{shortSha(item.shortId || item.id)} · {item.authorName || "未知作者"} · {formatDate(item.authoredDate || item.createdAt)}</small>
                      </button>
                      <button type="button" title={copy.filesList} onClick={() => openRepositoryRef(item.id)}><UiIcon icon={icons.folder} /></button>
                      {item.webUrl && <button type="button" title={copy.openIn} onClick={(event) => openGitLab(event, item.webUrl)}><UiIcon icon={icons.external} /></button>}
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
          {tab === "tags" && (
            <section className="plugins-section">
              <div className="plugins-section-heading"><h2>标签</h2><span>{filteredTags.length}</span></div>
              {filteredTags.length === 0 ? <div className="plugins-empty">{emptyText("标签")}</div> : (
                <div className="gitlab-list">
                  {filteredTags.map((item) => (
                    <article className="gitlab-card gitlab-card-open" key={item.name}>
                      <button type="button" className="gitlab-card-main" onClick={() => openRepositoryRef(item.name)}>
                        <strong>{item.name}</strong>
                        <small>{item.message || item.commitTitle || shortSha(item.commitId)} · {formatDate(item.commitDate)}</small>
                      </button>
                      {item.webUrl && <button type="button" title={copy.openIn} onClick={(event) => openGitLab(event, item.webUrl)}><UiIcon icon={icons.external} /></button>}
                    </article>
                  ))}
                </div>
              )}
            </section>
          )}
          {tab === "graph" && (
            <section className="plugins-section gitlab-graph-section">
              <div className="plugins-section-heading">
                <h2>仓库图</h2>
                <span>{graphTotal > graph.length ? `${graph.length} / ${graphTotal}` : graph.length}</span>
              </div>
              {graph.length === 0 ? <div className="plugins-empty">{emptyText("仓库图")}</div> : (
                <>
                  <GitGraph
                    commits={graph.map((item) => ({ ...item, webUrl: item.webUrl || commitUrl(projectUrl, item.id, provider) }))}
                    filter={query}
                    onOpenCommit={openCommitDiff}
                    onOpenFiles={openRepositoryRef}
                    onOpenRemote={openGitLab}
                  />
                  <div className="git-graph-more" ref={graphSentinel}>
                    {graphShallow && <p>当前仓库是浅克隆，更早的提交不在本地。</p>}
                    {graphHasMore ? (
                      <button type="button" disabled={loading} onClick={() => setGraphLimit((current) => Math.min(5000, current + GRAPH_PAGE))}>
                        {loading ? "正在加载…" : "加载更早的提交"}
                      </button>
                    ) : (
                      <p>{graphShallow ? "" : "已经到仓库最早的提交"}</p>
                    )}
                  </div>
                </>
              )}
            </section>
          )}
        </div>
      )}
      {branchDialog && (
        <AppDialog
          title="新建远程分支"
          message={`将从 ${activeRef || "HEAD"} 创建。`}
          value={branchDraft}
          placeholder="例如 feature/local-search"
          confirmLabel="创建"
          error={branchError}
          onChange={(value) => { setBranchDraft(value); setBranchError(""); }}
          onConfirm={(value) => void submitRemoteBranch(value)}
          onCancel={() => setBranchDialog(false)}
        />
      )}
      {dialog.node}
    </section>
  );
}
