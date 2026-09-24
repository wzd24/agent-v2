import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { LocalCodexApi, RpcMessage } from "./api";
import helpPages from "./helpPages.json";

type HelpPage = { title: string; body: string };

const pages = helpPages as Record<string, HelpPage>;
let zoomLevel = 0;

async function host<T = unknown>(method: string, payload: Record<string, unknown> = {}): Promise<T> {
  try {
    return await invoke<T>("host_call", { method, payload });
  } catch (error) {
    throw asError(error);
  }
}

function asError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string") return new Error(error);
  return new Error(String(error));
}

function fileSrc(filePath: string): string {
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

function listenEvent<T>(name: string, callback: (payload: T) => void): () => void {
  let stopped = false;
  let unlisten: (() => void) | undefined;
  void listen<T>(name, (event) => {
    if (!stopped) callback(event.payload);
  }).then((fn) => {
    if (stopped) fn();
    else unlisten = fn;
  });
  return () => {
    stopped = true;
    unlisten?.();
  };
}

function mapStatus(status: Record<string, unknown>): Record<string, unknown> {
  const state = String(status.state || "");
  return {
    ...status,
    state: state === "starting" ? "connecting" : state,
  };
}

function gitHost(prefix: "gitlab" | "github") {
  const call = (suffix: string, query?: Record<string, unknown>) =>
    host(`${prefix}.${suffix}`, query || {});
  return {
    status: () => call("status"),
    project: () => call("project"),
    mergeRequests: (query?: Record<string, unknown>) => call("mergeRequests", query),
    mergeRequest: (query?: Record<string, unknown>) => call("mergeRequest", query),
    mergeRequestCommits: (query?: Record<string, unknown>) => call("mergeRequestCommits", query),
    mergeRequestDiffs: (query?: Record<string, unknown>) => call("mergeRequestDiffs", query),
    mergeRequestNotes: (query?: Record<string, unknown>) => call("mergeRequestNotes", query),
    mergeRequestPipelines: (query?: Record<string, unknown>) => call("mergeRequestPipelines", query),
    branches: (query?: Record<string, unknown>) => call("branches", query),
    commits: (query?: Record<string, unknown>) => call("commits", query),
    commitDiff: (query?: Record<string, unknown>) => call("commitDiff", query),
    graph: (query?: Record<string, unknown>) => call("graph", query),
    tags: (query?: Record<string, unknown>) => call("tags", query),
    tree: (query?: Record<string, unknown>) => call("tree", query),
    file: (query?: Record<string, unknown>) => call("file", query),
    blame: (query?: Record<string, unknown>) => call("blame", query),
    createMergeRequest: (query: Record<string, unknown>) => call("createMergeRequest", query),
    createNote: (query: Record<string, unknown>) => call("createNote", query),
    createReviewComment: (query: Record<string, unknown>) => call("createReviewComment", query),
    mergeMergeRequest: (query: Record<string, unknown>) => call("mergeMergeRequest", query),
    approveMergeRequest: (query: Record<string, unknown>) => call("approveMergeRequest", query),
    createBranch: (query: Record<string, unknown>) => call("createBranch", query),
    updateMergeRequestState: (query: Record<string, unknown>) => call("updateMergeRequestState", query),
    projects: (query?: Record<string, unknown>) => call("projects", query),
    clone: (query: Record<string, unknown>) => call("clone", query),
    checkRepository: (query: Record<string, unknown>) => call("checkRepository", query),
    createRepository: (query: Record<string, unknown>) => call("createRepository", query),
  };
}

async function windowAction(action: string): Promise<boolean> {
  try {
    if (action === "zoom-in" || action === "zoom-out" || action === "zoom-reset") {
      if (action === "zoom-in") zoomLevel += 0.5;
      else if (action === "zoom-out") zoomLevel -= 0.5;
      else zoomLevel = 0;
      zoomLevel = Math.max(-8, Math.min(8, zoomLevel));
      const scale = Math.max(0.5, Math.min(5, 1.2 ** zoomLevel));
      await getCurrentWebview().setZoom(scale);
      void host("browser.setZoom", { scale }).catch(() => undefined);
      return true;
    }
    if (action === "close") {
      return Boolean(await host("app.windowAction", { action: "close" }));
    }
    return Boolean(await host("app.windowAction", { action }));
  } catch {
    return false;
  }
}

export const localCodex: LocalCodexApi = {
  terminal: {
    start: (options) => host("terminal.start", { ...(options || {}) }),
    write: (id, data) => host("terminal.write", { id, data }),
    resize: (id, cols, rows) => host("terminal.resize", { id, cols, rows }),
    terminate: (id) => host("terminal.terminate", { id }),
    onOutput: (callback) => listenEvent("terminal://output", callback),
    onExit: (callback) => listenEvent("terminal://exit", callback),
  },
  app: {
    openLicenses: () => host("app.openLicenses"),
    openExternalUrl: (url) => host("app.openExternalUrl", { url }),
    fetchImage: (url) => host("app.fetchImage", { url }),
    windowAction,
    isFocused: () => host("app.isFocused"),
    notify: (payload) => host("app.notify", payload || {}),
    info: () => host("app.info"),
    checkUpdates: () => host("app.checkUpdates"),
    onUpdateStatus: (callback) => listenEvent("updates://status", callback),
  },
  tray: {
    onAction: (callback) => listenEvent("tray://action", callback),
  },
  voice: {
    listen: (locale) => host("voice.listen", { locale }),
  },
  appServer: {
    request: async (method, params) => {
      try {
        return await invoke("rpc_request", { method, params: params ?? null });
      } catch (error) {
        throw asError(error);
      }
    },
    notify: (method, params) => {
      void invoke("rpc_notify", { method, params: params ?? null }).catch(() => undefined);
    },
    respond: async (id, result) => {
      await invoke("rpc_respond", { id, result });
      return true;
    },
    restart: async () => {
      await invoke("engine_restart");
      return true;
    },
    onNotification: (callback) =>
      listenEvent<RpcMessage>("appserver://notification", callback),
    onRequest: (callback) =>
      listenEvent<RpcMessage & { id: number | string }>("appserver://request", callback),
    onStatus: (callback) => {
      void invoke<Record<string, unknown>>("engine_status")
        .then((status) => callback(mapStatus(status)))
        .catch(() => undefined);
      return listenEvent<Record<string, unknown>>("appserver://status", (status) =>
        callback(mapStatus(status)),
      );
    },
  },
  config: {
    read: () => host("config.read"),
    openFile: () => host("config.openFile"),
    providerPresets: () => host("config.providerPresets"),
    importOfficialCodex: (payload?: { apply?: boolean; path?: string }) =>
      host("config.importOfficialCodex", payload || {}),
    pickOfficialCodex: () => host("config.pickOfficialCodex"),
  },
  preferences: {
    read: () => host("preferences.read"),
    write: (key, value) => host("preferences.write", { key, value }),
    onChanged: (callback) => listenEvent("preferences://changed", callback),
  },
  backgroundImages: {
    chooseDirectory: (directory) => host("backgroundImages.chooseDirectory", { directory }),
    list: (directory) => host("backgroundImages.list", { directory }),
    read: async (filePath, directory) => {
      const result = await host<{ path?: string }>("backgroundImages.read", { filePath, directory });
      for (const path of [filePath, result.path].filter((value): value is string => Boolean(value))) {
        const dataUrl = fileSrc(path);
        if (dataUrl) return { path, dataUrl };
      }
      throw new Error("无法转换背景图片路径");
    },
  },
  browser: {
    show: (query) => host("browser.show", query),
    hide: () => host("browser.hide"),
    navigate: (url) => host("browser.navigate", { url }),
    back: () => host("browser.back"),
    forward: () => host("browser.forward"),
    reload: () => host("browser.reload"),
    setBounds: (bounds) => host("browser.setBounds", bounds),
    status: () => host("browser.status"),
    find: (query, options = {}) => host("browser.find", { query, ...options }),
    setCovered: (covered) => host("browser.setCovered", { covered }),
    onNavigated: (callback) => listenEvent("browser://navigated", callback),
    onFind: (callback) => listenEvent("browser://find", callback),
  },
  integrations: {
    status: () => host("integrations.status"),
    clearBrowserData: () => host("integrations.clearBrowserData"),
  },
  codex: {
    projects: () => host("codex.projects"),
    threadMetadata: () => host("codex.threadMetadata"),
    assignThread: (threadId, assignment) =>
      host("codex.assignThread", { threadId, assignment }),
    forgetThread: (threadId) => host("codex.forgetThread", { threadId }),
    inheritThread: (fromThreadId, toThreadId) =>
      host("codex.inheritThread", { fromThreadId, toThreadId }),
    registerProject: (projectPath, projectName) =>
      host("codex.registerProject", { projectPath, projectName }),
    updateProject: (oldPath, projectName, newPath) =>
      host("codex.updateProject", { oldPath, projectName, newPath }),
    addProjectRoot: (projectPath, extraPath) =>
      host("codex.addProjectRoot", { projectPath, extraPath }),
    setProjectRoots: (projectPath, projectName, rootPaths) =>
      host("codex.setProjectRoots", { projectPath, projectName, rootPaths }),
    deleteProject: (projectPath) => host("codex.deleteProject", { projectPath }),
    plugins: () => host("codex.plugins"),
    installPlugin: () => host("codex.installPlugin"),
    uninstallPlugin: (pluginPath) => host("codex.uninstallPlugin", { pluginPath }),
    setPluginsEnabled: (enabled) => host("codex.setPluginsEnabled", { enabled }),
  },
  skills: {
    builtin: () => host("skills.builtin"),
    read: (id) => host("skills.read", { id }),
    setEnabled: (id, enabled) => host("skills.setEnabled", { id, enabled }),
    open: (id) => host("skills.open", { id }),
  },
  automations: {
    list: () => host("automations.list"),
    upsert: (query) => host("automations.upsert", query),
    remove: (id) => host("automations.remove", { id }),
    run: (id) => host("automations.run", { id }),
    onRan: (callback) => listenEvent("automations://ran", callback),
  },
  hooks: {
    list: () => host("hooks.list"),
    add: (query) => host("hooks.add", query),
    remove: (query) => host("hooks.remove", query),
  },
  diagnostics: { read: () => host("diagnostics.read") },
  help: {
    pages: async () =>
      Object.entries(pages).map(([id, page]) => ({ id, title: page.title, body: page.body })),
    page: async (id) => {
      const page = pages[id];
      if (!page) throw new Error("没有这篇本地帮助");
      return { id, title: page.title, body: page.body };
    },
    copyDiagnostics: async () => {
      const text = await host<string>("help.copyDiagnostics");
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        await host("clipboard.write", { text });
      }
      return text;
    },
    openLog: () => host("help.openLog"),
  },
  workspace: {
    open: () => host("workspace.open"),
    pick: (query) => host("workspace.pick", { ...(query || {}) }),
    reveal: (target) => host("workspace.reveal", { target }),
    clearRoot: () => host("workspace.clearRoot"),
    setRoot: (root) => host("workspace.setRoot", { root }),
    openRoot: () => host("workspace.openRoot"),
    openInEditor: (root, application) =>
      host("workspace.openInEditor", { root: root || "", application: application || "VS Code" }),
    tree: (options) => host("workspace.tree", { ...(options || {}) }),
    searchFiles: (options) => host("workspace.searchFiles", options),
    readFile: (filePath) => host("workspace.readFile", { filePath }),
    describeFile: (filePath) => host("workspace.describeFile", { filePath }),
    writeFile: (filePath, content) => host("workspace.writeFile", { filePath, content }),
    openExternal: (filePath, application) =>
      host("workspace.openExternal", { filePath, application }),
    revealInFolder: (filePath) => host("workspace.revealInFolder", { filePath }),
    createEntry: (parent, name, type) =>
      host("workspace.createEntry", { parent, name, type }),
    renameEntry: (filePath, name) => host("workspace.renameEntry", { filePath, name }),
    deleteEntry: (filePath) => host("workspace.deleteEntry", { filePath }),
    copyEntry: (source, destination) => host("workspace.copyEntry", { source, destination }),
    moveEntry: (source, destination) => host("workspace.moveEntry", { source, destination }),
  },
  git: {
    listRepos: () => host("git.listRepos"),
    status: (cwd) => host("git.status", { cwd }),
    snapshot: (cwd) => host("git.snapshot", { cwd }),
    remotes: (cwd) => host("git.remotes", { cwd }),
    diff: (cwd) => host("git.diff", { cwd }),
    suggestCommit: (cwd) => host("git.suggestCommit", { cwd }),
    restoreFile: (filePath, cwd) => host("git.restoreFile", { filePath, cwd }),
    rejectHunk: (patch, cwd) => host("git.rejectHunk", { patch, cwd }),
    commit: (message, options, cwd) => host("git.commit", { message, cwd, ...(options || { all: true }) }),
    undoCommit: (cwd) => host("git.undoCommit", { cwd }),
    abortRebase: (cwd) => host("git.abortRebase", { cwd }),
    stageAll: (cwd) => host("git.stageAll", { cwd }),
    unstageAll: (cwd) => host("git.unstageAll", { cwd }),
    discardAll: (cwd) => host("git.discardAll", { cwd }),
    push: (cwd) => host("git.push", { cwd }),
    pushTo: (remote, setUpstream, cwd) => host("git.pushTo", { remote, setUpstream, cwd }),
    fetch: (remote, options, cwd) => host("git.fetch", { remote, cwd, ...(options || {}) }),
    pull: (remote, rebase, cwd) => host("git.pull", { remote, rebase, cwd }),
    init: (cwd) => host("git.init", { cwd }),
    addRemote: (name, url, cwd) => host("git.addRemote", { name, url, cwd }),
    removeRemote: (name, cwd) => host("git.removeRemote", { name, cwd }),
    setRemoteUrl: (name, url, cwd) => host("git.setRemoteUrl", { name, url, cwd }),
    branches: (cwd) => host("git.branches", { cwd }),
    checkout: (name, cwd) => host("git.checkout", { name, cwd }),
    deleteBranch: (name, force, cwd) => host("git.deleteBranch", { name, force, cwd }),
    merge: (name, cwd) => host("git.merge", { name, cwd }),
    rebase: (name, cwd) => host("git.rebase", { name, cwd }),
    renameBranch: (name, cwd) => host("git.renameBranch", { name, cwd }),
    deleteRemoteBranch: (name, remote, cwd) => host("git.deleteRemoteBranch", { name, remote, cwd }),
    publishBranch: (remote, cwd) => host("git.publishBranch", { remote, cwd }),
    stash: (message, options, cwd) => host("git.stash", { message, cwd, ...(options || {}) }),
    stashPop: (target, cwd) => host("git.stashPop", { target, cwd }),
    stashApply: (target, cwd) => host("git.stashApply", { target, cwd }),
    stashDrop: (target, cwd) => host("git.stashDrop", { target, cwd }),
    stashClear: (cwd) => host("git.stashClear", { cwd }),
    stashShow: (target, cwd) => host("git.stashShow", { target, cwd }),
    stashList: (cwd) => host("git.stashList", { cwd }),
    tags: (cwd) => host("git.tags", { cwd }),
    createTag: (name, message, cwd) => host("git.createTag", { name, message, cwd }),
    deleteTag: (name, cwd) => host("git.deleteTag", { name, cwd }),
    pushTags: (remote, cwd) => host("git.pushTags", { remote, cwd }),
    deleteRemoteTag: (name, remote, cwd) => host("git.deleteRemoteTag", { name, remote, cwd }),
    clone: (query) => host("git.clone", query),
    applyPatch: (patch, cwd) => host("git.applyPatch", { patch, cwd }),
    createPatch: (kind, cwd) => host("git.createPatch", { kind, cwd }),
    graph: (options, cwd) => host("git.graph", { cwd, ...(options || {}) }),
    showCommit: (sha, cwd) => host("git.showCommit", { sha, cwd }),
    listPath: (path, withCommit, cwd) => host("git.listPath", { path, withCommit, cwd }),
    createBranch: (name, checkout, cwd, start) => host("git.createBranch", { name, checkout, cwd, start }),
    worktrees: (cwd) => host("git.worktrees", { cwd }),
    createWorktree: (branch, cwd) => host("git.createWorktree", { branch, cwd }),
    removeWorktree: (worktreePath, cwd) => host("git.removeWorktree", { worktreePath, cwd }),
  },
  gitlab: gitHost("gitlab") as LocalCodexApi["gitlab"],
  github: gitHost("github") as LocalCodexApi["github"],
  secrets: {
    write: (name, value) => host("secrets.write", { name, value }),
    read: (name) => host("secrets.read", { name }),
  },
  attachments: {
    save: async (name, data, root) => {
      const bytes = Array.from(new Uint8Array(data));
      return host("attachments.save", { name, bytes, root });
    },
    readImage: async (filePath) => {
      const result = await host<{ path?: string }>("attachments.readImage", { filePath });
      for (const path of [filePath, result.path].filter((value): value is string => Boolean(value))) {
        const dataUrl = fileSrc(path);
        if (dataUrl) return { path, dataUrl };
      }
      throw new Error("无法转换图片路径");
    },
    openImage: (filePath) => host("attachments.openImage", { filePath }),
  },
  export: {
    save: (content, defaultName) => host("export.save", { content, defaultName }),
  },
  import: {
    open: () => host("import.open"),
  },
};

if (typeof window !== "undefined") {
  window.localCodex = localCodex;
}
