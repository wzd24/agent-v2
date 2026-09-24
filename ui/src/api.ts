export type RpcMessage = { method: string; params?: Record<string, any> };

export type Thread = {
  id: string;
  name?: string | null;
  displayTitle?: string;
  title?: string;
  preview?: string;
  status?: string | { type?: string; [key: string]: any };
  archived?: boolean;
  ephemeral?: boolean;
  section?: { id: string; name: string } | null;
  projectId?: string | null;
  cwd?: string | null;
  path?: string | null;
  source?: string | null;
  threadSource?: string | null;
  modelProvider?: string | null;
  gitInfo?: Record<string, any> | null;
  [key: string]: any;
  updatedAt?: number;
};

export type CodexProject = {
  id?: string;
  path: string;
  rootPaths?: string[];
  name: string;
  trustLevel?: string;
  threadCount?: number;
  gitOrigin?: string;
};
export type GitRemote = { name: string; url: string; host: string; projectPath: string };
export type GitBranch = { name: string; sha?: string; current?: boolean; upstream?: string };
export type GitTag = { name: string; sha?: string; date?: string };
export type GitSnapshot = {
  ok: boolean;
  isRepo: boolean;
  workspaceRoot: string;
  branch: string;
  upstream: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  changes: number;
  files: Array<{ code: string; path: string }>;
  remotes: GitRemote[];
  reason?: string;
};
export type GitHostRepoCheck = {
  ok?: boolean;
  exists?: boolean;
  canCreate?: boolean;
  created?: boolean;
  login?: string;
  owner?: string;
  name?: string;
  fullName?: string;
  ownerType?: string;
  private?: boolean;
  scopes?: string[];
  orgs?: string[];
  reason?: string;
  project?: GitLabProject | null;
  connectionId?: string;
};
export type GitLabConnection = {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  tokenConfigured?: boolean;
};
export type GitLabProject = {
  id?: number | string;
  name?: string;
  description?: string;
  webUrl?: string;
  defaultBranch?: string;
  visibility?: string;
  pathWithNamespace?: string;
  lastActivityAt?: string;
  httpUrl?: string;
  sshUrl?: string;
  connectionId?: string;
  connectionName?: string;
};
export type GitLabFileCommit = {
  id?: string;
  shortId?: string;
  title?: string;
  authorName?: string;
  authoredDate?: string;
  webUrl?: string;
};
export type GitLabFile = {
  path: string;
  name: string;
  ref: string;
  size: number;
  binary: boolean;
  image: boolean;
  tooLarge: boolean;
  content: string;
  dataUrl: string;
  source: string;
  commit?: GitLabFileCommit | null;
};
export type GitLabBlameGroup = {
  commitId: string;
  shortId: string;
  authorName: string;
  authoredDate: string;
  lines: string[];
};
export type GitLabMergeRequest = {
  iid: number;
  title: string;
  description?: string;
  state?: string;
  draft?: boolean;
  sourceBranch?: string;
  targetBranch?: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  mergedAt?: string;
  mergedBy?: string;
  mergeCommitSha?: string;
  sha?: string;
  webUrl?: string;
  labels?: string[];
  assignees?: string[];
  reviewers?: string[];
  changesCount?: number;
  userNotesCount?: number;
  mergeStatus?: string;
  diffRefs?: { baseSha?: string; startSha?: string; headSha?: string };
};
export type GitLabStatus = {
  enabled: boolean;
  available: boolean;
  configured: boolean;
  tokenConfigured: boolean;
  baseUrl: string;
  workspaceRoot: string;
  remoteUrl: string;
  remoteName: string;
  projectPath: string;
  currentBranch: string;
  project?: GitLabProject | null;
  reason?: string;
  connections?: GitLabConnection[];
  connectionId?: string;
};
export type ThreadSection = { id: string; name: string };

export type TurnItem = {
  id?: string;
  type: string;
  text?: string;
  content?: Array<{
    type?: string;
    text?: string;
    path?: string;
    name?: string;
    detail?: string | null;
  }>;
  status?: string;
  command?: string;
  aggregatedOutput?: string;
  exitCode?: number;
  durationMs?: number;
  changes?: Array<{
    path?: string;
    diff?: string;
    kind?: { type?: string; [key: string]: any };
  }>;
  url?: string;
  title?: string;
  query?: string;
  path?: string;
};

export type Turn = {
  id: string;
  status?: string;
  durationMs?: number;
  items?: TurnItem[];
};
export type Model = {
  id?: string;
  model?: string;
  name?: string;
  displayName?: string;
  display_name?: string;
  description?: string;
  isDefault?: boolean;
};
export type MessageAttachment = { name: string; path: string; type?: string };
export type BackgroundImageEntry = {
  path: string;
  name: string;
  relativePath: string;
};
export type Message = {
  role: "user" | "agent" | "activity";
  text: string;
  item?: TurnItem;
  itemId?: string;
  turnId?: string;
  turnDurationMs?: number;
  turnStartedAt?: number;
  attachments?: MessageAttachment[];
};

export type LocalCodexApi = {
  terminal: {
    start: (options?: {
      cwd?: string;
      cols?: number;
      rows?: number;
      shell?: string;
    }) => Promise<{ id: string; cwd: string; shell: string }>;
    write: (id: string, data: string) => Promise<boolean>;
    resize: (id: string, cols: number, rows: number) => Promise<boolean>;
    terminate: (id: string) => Promise<boolean>;
    onOutput: (
      callback: (message: { id: string; data: string }) => void,
    ) => () => void;
    onExit: (
      callback: (message: {
        id: string;
        exitCode: number;
        signal?: number;
      }) => void,
    ) => () => void;
  };
  app: {
    openLicenses: () => Promise<string>;
    openExternalUrl: (url: string) => Promise<{ ok: boolean; output: string }>;
    fetchImage: (url: string) => Promise<{ dataUrl: string }>;
    windowAction?: (action: string) => Promise<boolean>;
    isFocused?: () => Promise<boolean>;
    notify?: (payload: { title?: string; body?: string }) => Promise<boolean>;
    info: () => Promise<{ name: string; version: string }>;
    checkUpdates: () => Promise<{
      current: string;
      latest: string;
      newer: boolean;
      url: string;
      notes: string;
      source: string;
      checkedAt: string;
    }>;
    onUpdateStatus: (
      callback: (status: {
        current: string;
        latest: string;
        newer: boolean;
        url: string;
        notes: string;
        source: string;
        checkedAt: string;
      }) => void,
    ) => () => void;
  };
  tray: { onAction: (callback: (action: { action: string; threadId?: string }) => void) => () => void };
  voice?: {
    listen: (locale?: string) => Promise<{ text: string }>;
  };
  appServer: {
    request: (method: string, params?: Record<string, any>) => Promise<any>;
    notify: (method: string, params?: Record<string, any>) => void;
    respond: (id: number | string, result: unknown) => Promise<boolean>;
    restart: () => Promise<boolean>;
    onNotification: (callback: (message: RpcMessage) => void) => () => void;
    onRequest: (
      callback: (message: RpcMessage & { id: number | string }) => void,
    ) => () => void;
    onStatus: (callback: (status: Record<string, any>) => void) => () => void;
  };
  config: {
    read: () => Promise<{
      appRoot?: string;
      engineHome?: string;
      codexHome: string;
      mock: boolean;
      state?: string;
      workspaceRoot?: string;
      projectlessWorkspaceRoot?: string;
      attachmentRoot?: string;
      approval_policy?: string;
      sandbox_mode?: string;
      sandbox_workspace_write?: { network_access?: boolean };
      model?: string;
      model_provider?: string;
      model_providers?: Record<string, any>;
    }>;
    openFile: () => Promise<string>;
    providerPresets: () => Promise<{
      presets?: Array<{
        id: string;
        name: string;
        baseUrl?: string;
        base_url?: string;
        envKey?: string;
        env_key?: string;
        defaultModel?: string;
      }>;
    }>;
    importOfficialCodex: (payload?: { apply?: boolean; path?: string }) => Promise<{
      found?: boolean;
      path?: string;
      providers?: Array<Record<string, any>>;
      model?: string;
      modelProvider?: string;
      willSelectProvider?: string;
      skippedOpenAi?: boolean;
      applied?: boolean;
      baseUrl?: string;
      envKey?: string;
      importedEnvKeys?: string[];
    }>;
    pickOfficialCodex: () => Promise<{ canceled?: boolean; path?: string }>;
  };
  preferences: {
    read: () => Promise<Record<string, any>>;
    write: (key: string, value: any) => Promise<Record<string, any>>;
    onChanged: (
      callback: (preferences: Record<string, any>) => void,
    ) => () => void;
  };
  backgroundImages: {
    chooseDirectory: (
      directory?: string,
    ) => Promise<{
      canceled: boolean;
      directory: string;
      images: BackgroundImageEntry[];
    }>;
    list: (
      directory: string,
    ) => Promise<{ directory: string; images: BackgroundImageEntry[] }>;
    read: (
      filePath: string,
      directory: string,
    ) => Promise<{ path: string; dataUrl: string }>;
  };
  browser: {
    show: (query: {
      url?: string;
      x: number;
      y: number;
      width: number;
      height: number;
    }) => Promise<boolean>;
    hide: () => Promise<boolean>;
    navigate: (url: string) => Promise<boolean>;
    back: () => Promise<boolean>;
    forward: () => Promise<boolean>;
    reload: () => Promise<boolean>;
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<boolean>;
    status: () => Promise<{
      open: boolean;
      url?: string;
      canGoBack?: boolean;
      canGoForward?: boolean;
    }>;
    find: (
      query: string,
      options?: { forward?: boolean; findNext?: boolean; matchCase?: boolean },
    ) => Promise<boolean>;
    setCovered: (covered: boolean) => Promise<boolean>;
    onNavigated: (callback: (payload: {
      url: string;
      canGoBack?: boolean;
      canGoForward?: boolean;
    }) => void) => () => void;
    onFind: (callback: (payload: {
      matches?: number;
      active?: number;
      label?: string;
    }) => void) => () => void;
  };
  integrations: {
    status: () => Promise<{
      platform: string;
      computer: { available: boolean; toolCount: number };
      browser: {
        available: boolean;
        engine: string;
        executable: string;
        profile: string;
        preference?: string;
        playwright?: string;
        engines?: Array<{
          id: string;
          name: string;
          playwright: string;
          executable: string;
          installed: boolean;
        }>;
      };
      apps: Array<{
        id: string;
        name: string;
        installed: boolean;
        executable?: string;
        enabledKey: string;
      }>;
    }>;
    clearBrowserData: () => Promise<{ ok: boolean; path: string }>;
  };
  codex: {
    projects: () => Promise<CodexProject[]>;
    threadMetadata: () => Promise<{
      assignments: Record<string, { projectId?: string; projectKind?: string; projectPath?: string }>;
      projectless: string[];
    }>;
    assignThread: (
      threadId: string,
      assignment: { projectId?: string; projectKind?: string; projectPath?: string } | null,
    ) => Promise<{
      assignments: Record<string, { projectId?: string; projectKind?: string; projectPath?: string }>;
      projectless: string[];
    }>;
    forgetThread: (threadId: string) => Promise<{
      assignments: Record<string, { projectId?: string; projectKind?: string; projectPath?: string }>;
      projectless: string[];
    }>;
    inheritThread: (
      fromThreadId: string,
      toThreadId: string,
    ) => Promise<{
      assignments: Record<string, { projectId?: string; projectKind?: string; projectPath?: string }>;
      projectless: string[];
    }>;
    registerProject: (
      projectPath: string,
      projectName: string,
    ) => Promise<CodexProject>;
    updateProject: (
      oldPath: string,
      projectName: string,
      newPath: string,
    ) => Promise<CodexProject>;
    addProjectRoot: (projectPath: string, extraPath: string) => Promise<CodexProject>;
    setProjectRoots: (projectPath: string, projectName: string, rootPaths: string[]) => Promise<CodexProject>;
    deleteProject: (projectPath: string) => Promise<{ path: string }>;
    plugins: () => Promise<
      Array<{
        name: string;
        description: string;
        path: string;
        source: string;
        enabled: boolean;
      }>
    >;
    installPlugin: () => Promise<{
      canceled: boolean;
      plugin?: { name: string; path: string };
    }>;
    uninstallPlugin: (
      pluginPath: string,
    ) => Promise<{ ok: boolean; output?: string }>;
    setPluginsEnabled: (enabled: boolean) => Promise<boolean>;
  };
  skills: {
    builtin: () => Promise<Array<{
      id: string;
      name: string;
      description: string;
      path: string;
      enabled: boolean;
      settingsSection: string;
    }>>;
    read: (id: string) => Promise<{ id: string; path: string; name: string; description: string; body: string }>;
    setEnabled: (id: string, enabled: boolean) => Promise<Array<{
      id: string;
      name: string;
      description: string;
      path: string;
      enabled: boolean;
      settingsSection: string;
    }>>;
    open: (id: string) => Promise<{ ok: boolean; output: string; path: string }>;
  };
  automations: {
    list: () => Promise<{
      file: string;
      automations: Array<{
        id: string;
        name: string;
        prompt: string;
        cwd: string;
        enabled: boolean;
        schedule: { kind: string; minutes?: number; hour?: number; minute?: number; at?: string };
        lastRunAt?: string | null;
        lastThreadId?: string | null;
        lastError?: string;
        nextRunAt?: number | null;
        scheduleLabel?: string;
      }>;
    }>;
    upsert: (query: Record<string, any>) => Promise<{ file: string; automations: Array<any> }>;
    remove: (id: string) => Promise<{ file: string; automations: Array<any> }>;
    run: (id: string) => Promise<{ threadId?: string; skipped?: boolean; reason?: string }>;
    onRan: (callback: (message: { id: string; threadId: string; name: string; reason: string }) => void) => () => void;
  };
  hooks: {
    list: () => Promise<Array<{
      scope: "user" | "project";
      file: string;
      exists: boolean;
      hooks: Array<{
        id: string;
        scope: string;
        file: string;
        event: string;
        matcher: string;
        groupIndex: number;
        hookIndex: number;
        type: string;
        command: string;
        commandWindows?: string;
        statusMessage: string;
        timeout: number | null;
        async: boolean;
      }>;
      error: string;
    }>>;
    add: (query: {
      scope?: "user" | "project";
      event: string;
      matcher?: string;
      command: string;
      commandWindows?: string;
      statusMessage?: string;
      timeout?: number | null;
      async?: boolean;
    }) => Promise<{ file: string; scope: string; hooks: Array<any> }>;
    remove: (query: {
      scope?: "user" | "project";
      file?: string;
      event: string;
      groupIndex: number;
      hookIndex: number;
    }) => Promise<{ file: string; scope: string; hooks: Array<any> }>;
  };
  diagnostics: { read: () => Promise<Record<string, any>> };
  help: {
    pages: () => Promise<Array<{ id: string; title: string; body: string }>>;
    page: (id: string) => Promise<{ id: string; title: string; body: string }>;
    copyDiagnostics: () => Promise<string>;
    openLog: () => Promise<{ ok: boolean; output: string; path: string }>;
  };
  workspace: {
    open: () => Promise<{ canceled: boolean; root: string }>;
    pick: (query?: { title?: string; defaultPath?: string }) => Promise<{ canceled: boolean; root: string }>;
    reveal: (target: string) => Promise<{ ok: boolean; output: string; path: string }>;
    clearRoot: () => Promise<{ root: string }>;
    setRoot: (root: string) => Promise<{ root: string }>;
    openRoot: () => Promise<{ ok: boolean; output: string }>;
    openInEditor: (
      root?: string,
      application?: string,
    ) => Promise<{ ok: boolean; output: string }>;
    tree: (options?: {
      root?: string;
      depth?: number;
    }) => Promise<{
      root: string;
      entries: Array<{
        name: string;
        type: "directory" | "file";
        children?: Array<any> | null;
      }>;
    }>;
    searchFiles: (options: {
      root?: string;
      query: string;
      limit?: number;
    }) => Promise<{
      root: string;
      entries: Array<{ name: string; path: string; relativePath: string }>;
    }>;
    readFile: (filePath: string) => Promise<{
      path: string;
      content: string;
      preview?: {
        kind?: string;
        title?: string;
        text?: string;
        pages?: number;
        sheets?: Array<{ name: string; rows: string[][] }>;
        slides?: Array<{ name?: string; text: string }>;
        cells?: Array<{ index: number; type: string; source: string; executionCount?: number | null; outputs?: number }>;
        language?: string;
      };
    }>;
    describeFile: (
      filePath: string,
    ) => Promise<{
      path: string;
      relativePath: string;
      name: string;
      extension: string;
      language: string;
      size: number;
      lines: number;
      modifiedAt: string;
      summary: string;
    }>;
    writeFile: (
      filePath: string,
      content: string,
    ) => Promise<{ path: string; content: string }>;
    openExternal: (
      filePath: string,
      application: string,
    ) => Promise<{ ok: boolean; output: string }>;
    revealInFolder: (filePath: string) => Promise<{ ok: boolean; path: string }>;
    createEntry: (
      parent: string,
      name: string,
      type: "file" | "directory",
    ) => Promise<{ path: string; relativePath: string; type: "file" | "directory" }>;
    renameEntry: (
      filePath: string,
      name: string,
    ) => Promise<{ path: string; relativePath: string }>;
    deleteEntry: (filePath: string) => Promise<{ path: string }>;
    copyEntry: (
      source: string,
      destination: string,
    ) => Promise<{ path: string; relativePath: string }>;
    moveEntry: (
      source: string,
      destination: string,
    ) => Promise<{ path: string; relativePath: string }>;
  };
  git: {
    status: () => Promise<{ ok: boolean; output: string }>;
    snapshot: () => Promise<GitSnapshot>;
    remotes: () => Promise<{
      items: GitRemote[];
      signature: string;
    }>;
    diff: () => Promise<{ ok: boolean; output: string }>;
    restoreFile: (filePath: string) => Promise<{ ok: boolean; output: string }>;
    rejectHunk: (patch: string) => Promise<{ ok: boolean; output: string }>;
    commit: (
      message: string,
      sign?: boolean,
    ) => Promise<{ ok: boolean; output: string }>;
    push: () => Promise<{ ok: boolean; output: string; branch?: string }>;
    pushTo: (remote?: string, setUpstream?: boolean) => Promise<{ ok: boolean; output: string; branch?: string }>;
    fetch: (remote?: string) => Promise<{ ok: boolean; output: string }>;
    pull: (remote?: string, rebase?: boolean) => Promise<{ ok: boolean; output: string }>;
    init: () => Promise<{ ok: boolean; output: string }>;
    addRemote: (name: string, url: string) => Promise<{ ok: boolean; output: string; exists?: boolean }>;
    removeRemote: (name: string) => Promise<{ ok: boolean; output: string }>;
    setRemoteUrl: (name: string, url: string) => Promise<{ ok: boolean; output: string }>;
    branches: () => Promise<{ ok: boolean; output: string; items: GitBranch[] }>;
    checkout: (name: string) => Promise<{ ok: boolean; output: string }>;
    deleteBranch: (name: string, force?: boolean) => Promise<{ ok: boolean; output: string }>;
    stash: (message?: string) => Promise<{ ok: boolean; output: string }>;
    stashPop: () => Promise<{ ok: boolean; output: string }>;
    stashList: () => Promise<{ ok: boolean; output: string; items: Array<{ label: string }> }>;
    tags: () => Promise<{ ok: boolean; output: string; items: GitTag[] }>;
    createTag: (name: string, message?: string) => Promise<{ ok: boolean; output: string }>;
    deleteTag: (name: string) => Promise<{ ok: boolean; output: string }>;
    clone: (query: { url: string; parentDir: string; folderName?: string; shallow?: boolean }) => Promise<{ ok: boolean; output: string; path?: string; name?: string }>;
    applyPatch: (patch: string) => Promise<{ ok: boolean; output: string }>;
    createPatch: (kind: "staged" | "unstaged" | "all") => Promise<{ ok: boolean; output: string; empty?: boolean }>;
    listPath: (path?: string, withCommit?: boolean) => Promise<{
      ok: boolean;
      output: string;
      path: string;
      items: Array<{
        name: string;
        path: string;
        type: "tree" | "blob";
        lastCommitId?: string;
        lastCommitTitle?: string;
        lastCommitAuthor?: string;
        lastCommitDate?: string;
      }>;
      latest?: { id?: string; shortId?: string; title?: string; authorName?: string; authoredDate?: string } | null;
    }>;
    createBranch: (
      name: string,
      checkout?: boolean,
    ) => Promise<{ ok: boolean; output: string; branch?: string }>;
    worktrees: () => Promise<{
      ok: boolean;
      output: string;
      entries: Array<{ path: string; head: string; branch: string }>;
    }>;
    createWorktree: (
      branch: string,
    ) => Promise<{ ok: boolean; output: string; path?: string }>;
    removeWorktree: (
      worktreePath: string,
    ) => Promise<{ ok: boolean; output: string }>;
  };
  gitlab: {
    status: () => Promise<GitLabStatus>;
    project: () => Promise<{ status: GitLabStatus; project: GitLabProject }>;
    mergeRequests: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: GitLabMergeRequest[] }>;
    mergeRequest: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; mergeRequest: GitLabMergeRequest }>;
    mergeRequestCommits: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: any[] }>;
    mergeRequestDiffs: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; diff: string }>;
    mergeRequestNotes: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: any[] }>;
    mergeRequestPipelines: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: any[] }>;
    branches: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: any[] }>;
    commits: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: any[] }>;
    commitDiff: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; commit: any; diff: string }>;
    graph: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: any[]; total?: number; hasMore?: boolean; shallow?: boolean }>;
    tags: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: any[] }>;
    tree: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: any[]; ref?: string }>;
    file: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; file: GitLabFile }>;
    blame: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: GitLabBlameGroup[] }>;
    createMergeRequest: (query: { title: string; sourceBranch?: string; targetBranch?: string; description?: string }) => Promise<{ status: GitLabStatus; mergeRequest: GitLabMergeRequest }>;
    createNote: (query: { iid: number; body: string }) => Promise<{ status: GitLabStatus; note: { id: number; body: string; system: boolean; author: string; createdAt: string } }>;
    createReviewComment: (query: { iid: number; body: string; path: string; oldPath?: string; newLine?: number; oldLine?: number; sha?: string; diffRefs?: GitLabMergeRequest["diffRefs"] }) => Promise<{ status: GitLabStatus; note: { id: number; body: string; system: boolean; author: string; createdAt: string } }>;
    mergeMergeRequest: (query: { iid: number; whenPipelineSucceeds?: boolean; removeSourceBranch?: boolean; mergeMethod?: string }) => Promise<{ status: GitLabStatus; mergeRequest: GitLabMergeRequest }>;
    approveMergeRequest: (query: { iid: number; body?: string }) => Promise<{ status: GitLabStatus; mergeRequest: GitLabMergeRequest }>;
    createBranch: (query: { name: string; ref?: string }) => Promise<{ status: GitLabStatus; branch: { name: string; commitId?: string } }>;
    updateMergeRequestState: (query: { iid: number; stateEvent: "close" | "reopen" }) => Promise<{ status: GitLabStatus; mergeRequest: GitLabMergeRequest }>;
    projects: (query?: { connectionId?: string; search?: string; limit?: number }) => Promise<{ items: GitLabProject[]; connections: GitLabConnection[] }>;
    clone: (query: { url?: string; httpUrl?: string; sshUrl?: string; webUrl?: string; protocol?: "https" | "ssh"; parentDir: string; folderName?: string; connectionId?: string; shallow?: boolean }) => Promise<{ ok: boolean; path: string; name: string }>;
    checkRepository: (query: { name?: string; owner?: string; private?: boolean; connectionId?: string }) => Promise<GitHostRepoCheck>;
    createRepository: (query: { name: string; owner?: string; description?: string; private?: boolean; autoInit?: boolean; connectionId?: string }) => Promise<GitHostRepoCheck & { created?: boolean; project?: GitLabProject }>;
  };
  github: {
    status: () => Promise<GitLabStatus>;
    project: () => Promise<{ status: GitLabStatus; project: GitLabProject }>;
    mergeRequests: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: GitLabMergeRequest[] }>;
    mergeRequest: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; mergeRequest: GitLabMergeRequest }>;
    mergeRequestCommits: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: any[] }>;
    mergeRequestDiffs: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; diff: string }>;
    mergeRequestNotes: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: any[] }>;
    mergeRequestPipelines: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: any[] }>;
    branches: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: any[] }>;
    commits: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: any[] }>;
    commitDiff: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; commit: any; diff: string }>;
    graph: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: any[]; total?: number; hasMore?: boolean; shallow?: boolean }>;
    tags: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: any[] }>;
    tree: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: any[]; ref?: string }>;
    file: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; file: GitLabFile }>;
    blame: (query?: Record<string, any>) => Promise<{ status: GitLabStatus; items: GitLabBlameGroup[] }>;
    createMergeRequest: (query: { title: string; sourceBranch?: string; targetBranch?: string; description?: string }) => Promise<{ status: GitLabStatus; mergeRequest: GitLabMergeRequest }>;
    createNote: (query: { iid: number; body: string }) => Promise<{ status: GitLabStatus; note: { id: number; body: string; system: boolean; author: string; createdAt: string } }>;
    createReviewComment: (query: { iid: number; body: string; path: string; oldPath?: string; newLine?: number; oldLine?: number; sha?: string; diffRefs?: GitLabMergeRequest["diffRefs"] }) => Promise<{ status: GitLabStatus; note: { id: number; body: string; system: boolean; author: string; createdAt: string } }>;
    mergeMergeRequest: (query: { iid: number; whenPipelineSucceeds?: boolean; removeSourceBranch?: boolean; mergeMethod?: string }) => Promise<{ status: GitLabStatus; mergeRequest: GitLabMergeRequest }>;
    approveMergeRequest: (query: { iid: number; body?: string }) => Promise<{ status: GitLabStatus; mergeRequest: GitLabMergeRequest }>;
    createBranch: (query: { name: string; ref?: string }) => Promise<{ status: GitLabStatus; branch: { name: string; commitId?: string } }>;
    updateMergeRequestState: (query: { iid: number; stateEvent: "close" | "reopen" }) => Promise<{ status: GitLabStatus; mergeRequest: GitLabMergeRequest }>;
    projects: (query?: { connectionId?: string; search?: string; limit?: number }) => Promise<{ items: GitLabProject[]; connections: GitLabConnection[] }>;
    clone: (query: { url?: string; httpUrl?: string; sshUrl?: string; webUrl?: string; protocol?: "https" | "ssh"; parentDir: string; folderName?: string; connectionId?: string; shallow?: boolean }) => Promise<{ ok: boolean; path: string; name: string }>;
    checkRepository: (query: { name?: string; owner?: string; private?: boolean; connectionId?: string }) => Promise<GitHostRepoCheck>;
    createRepository: (query: { name: string; owner?: string; description?: string; private?: boolean; autoInit?: boolean; connectionId?: string }) => Promise<GitHostRepoCheck & { created?: boolean; project?: GitLabProject }>;
  };
  secrets: {
    write: (name: string, value: string) => Promise<boolean>;
    read: (name: string) => Promise<{ configured: boolean; value?: string }>;
  };
  attachments: {
    save: (name: string, data: ArrayBuffer, root?: string) => Promise<string>;
    readImage: (filePath: string) => Promise<{ path: string; dataUrl: string }>;
    openImage: (filePath: string) => Promise<{ ok: boolean; output: string }>;
  };
  export: {
    save: (
      content: string,
      defaultName?: string,
    ) => Promise<{ canceled: boolean; path?: string }>;
  };
  import: {
    open: () => Promise<{ canceled: boolean; path?: string; content?: string }>;
  };
};

declare global {
  interface Window {
    localCodex: LocalCodexApi;
  }
}

import { localCodex } from "./localCodex";
import type { ClientRequest } from "./generated/app-server/ClientRequest";

export const api = localCodex;

export function typedRequest<M extends AppServerMethod>(
  method: M,
  params: AppServerParams<M>,
): Promise<any> {
  return api.appServer.request(method, params as Record<string, any>);
}

export function listData<T>(result: any): T[] {
  if (Array.isArray(result)) return result;
  for (const key of [
    "data",
    "items",
    "threads",
    "models",
    "skills",
    "servers",
    "profiles",
    "hooks",
    "modes",
  ]) {
    if (Array.isArray(result?.[key])) return result[key] as T[];
  }
  return [];
}

export function modelId(item?: Model | null): string {
  return String(item?.model || item?.id || "").trim();
}

export function modelLabel(item?: Model | null): string {
  return String(
    item?.displayName || item?.display_name || item?.name || modelId(item),
  ).trim();
}

export function pickCatalogModel(data: Model[], current = ""): string {
  const ids = data.map(modelId).filter(Boolean);
  if (current && ids.includes(current)) return current;
  const preferred = data.find((item) => item.isDefault) || data[0];
  return modelId(preferred);
}

export function userText(item: TurnItem): string {
  return (item.content || [])
    .filter((part) => part.type === "text")
    .map((part) => part.text || "")
    .join(" ");
}

export type AppServerMethod = ClientRequest["method"];
export type AppServerParams<M extends AppServerMethod> = Extract<
  ClientRequest,
  { method: M }
>["params"];
