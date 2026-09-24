import "./localCodex";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import {
  api,
  CodexProject,
  listData,
  Message,
  MessageAttachment,
  Model,
  modelLabel,
  pickCatalogModel,
  Thread,
  GitLabStatus,
  ThreadSection,
  Turn,
  TurnItem,
  userText,
} from "./api";
import { shouldNotifyTurn, turnCompleteNotice } from "./notify";
import {
  isMcpAllowElicitation,
  mcpAllowTool,
  mcpElicitationResponse,
  mcpToolAlreadyGranted,
} from "./mcpElicitation";
import { Composer } from "./components/Composer";
import { OutputSchemaEditor } from "./components/OutputSchemaEditor";
import { ConversationView } from "./components/ConversationView";
import { EnvironmentPanel } from "./components/EnvironmentPanel";
import { TerminalPanel } from "./components/TerminalPanel";
import { EditorWorkbenchTabBar, WorkspacePanel } from "./components/WorkspacePanel";
import { WindowTitleBar } from "./components/WindowTitleBar";
import { APP_SHORTCUTS, dialogOpen, resolvedShortcutMap, shortcutMatches, typingTarget } from "./shortcuts";
import { StatusBar } from "./components/StatusBar";
import { ThreadSidebar } from "./components/ThreadSidebar";
import { SettingsView } from "./components/SettingsView";
import { HelpView } from "./components/HelpView";
import { PluginsView } from "./components/PluginsView";
import { AutomationsView } from "./components/AutomationsView";
import { GitLabView } from "./components/GitLabView";
import { GitView } from "./components/GitView";
import { ThreadActionsMenu } from "./components/ThreadActionsMenu";
import { useAppDialog } from "./components/AppDialog";
import {
  NewThreadWelcome,
  NewThreadWorkspacePicker,
  ProjectEditDialog,
} from "./components/NewThreadWelcome";
import { SidePanelPicker } from "./components/SidePanelPicker";
import { BackgroundLayer } from "./components/BackgroundLayer";
import { icons, UiIcon } from "./components/UiIcon";

const MODEL_RETRY_LIMIT = 5;

function formatTurnError(error: unknown): string {
  if (!error) return "模型连接失败";
  if (typeof error === "string") return error.trim() || "模型连接失败";
  if (typeof error === "object") {
    const record = error as { message?: unknown; additionalDetails?: unknown };
    const message = String(record.message || "").trim();
    const details = String(record.additionalDetails || "").trim();
    if (message && details && details !== message) return `${message}\n${details}`;
    if (message) return message;
    if (details) return details;
  }
  return "模型连接失败";
}

function titleOf(thread: Thread): string {
  return (
    thread.title ||
    thread.displayTitle ||
    thread.name ||
    thread.preview ||
    "未命名线程"
  );
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
function hostStatusFingerprint(status: GitLabStatus | null): string {
  if (!status) return "";
  return [
    status.available ? "1" : "0",
    status.enabled ? "1" : "0",
    status.workspaceRoot || "",
    status.projectPath || "",
    status.remoteUrl || "",
    status.currentBranch || "",
    status.reason || "",
    status.connectionId || "",
    String(status.project?.id ?? ""),
    status.project?.defaultBranch || "",
  ].join("\0");
}
function keepHostStatus(previous: GitLabStatus | null, next: GitLabStatus | null): GitLabStatus | null {
  return hostStatusFingerprint(previous) === hostStatusFingerprint(next) ? previous : next;
}
function projectForThread(
  thread: Thread | undefined,
  projects: CodexProject[],
): CodexProject | undefined {
  if (!thread) return undefined;
  // A null projectId is an explicit projectless conversation. Its persisted
  // cwd may still be the app process directory, so never infer a project from
  // cwd in this case.
  if (thread.projectId === null) return undefined;
  const byId = projects.find(
    (project) => project.id && String(project.id) === String(thread.projectId),
  );
  if (byId) return byId;
  const origin = canonicalRemote(
    String(thread.gitInfo?.originUrl || thread.gitInfo?.origin_url || ""),
  );
  const byOrigin = origin
    ? projects.find(
        (project) => canonicalRemote(project.gitOrigin || "") === origin,
      )
    : undefined;
  if (byOrigin) return byOrigin;
  const cwd = canonicalPath(String(thread.cwd || ""));
  const rootsOf = (project: CodexProject) =>
    [project.path, ...(project.rootPaths || [])].map((root) => canonicalPath(root));
  return projects
    .filter((project) =>
      rootsOf(project).some((root) => cwd === root || cwd.startsWith(`${root}/`)),
    )
    .sort((a, b) => b.path.length - a.path.length)[0];
}

function projectForWorkspace(
  root: string,
  projects: CodexProject[],
  projectless: boolean,
): CodexProject | undefined {
  if (projectless || !root) return undefined;
  return projectForThread({ cwd: root } as Thread, projects);
}

function listedThread(item: any): Thread {
  if (item?.thread && typeof item.thread === "object") {
    return { ...item, ...item.thread } as Thread;
  }
  return item as Thread;
}

function uniqueThreads(threads: Thread[]): Thread[] {
  const seen = new Set<string>();
  return threads.filter((thread) => {
    // Thread titles are user-editable and are not unique identifiers.
    const key = String(thread.id || "").trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function messagesFromTurns(turns: Turn[]): Message[] {
  const restored: Message[] = [];
  for (const turn of turns) {
    for (const item of turn.items || []) {
      if (item.type === "userMessage") {
        const attachments = (item.content || [])
          .filter(
            (part) =>
              (part.type === "localImage" ||
                part.type === "mention" ||
                part.type === "file") &&
              part.path,
          )
          .map((part) => ({
            name: part.name || String(part.path).split(/[\\/]/).pop() || "附件",
            path: String(part.path),
            type:
              part.type === "localImage"
                ? "image/*"
                : "application/octet-stream",
          }));
        restored.push({
          role: "user",
          text: userText(item),
          turnId: turn.id,
          turnDurationMs: turn.durationMs,
          attachments,
        });
      } else if (item.type === "agentMessage")
        restored.push({
          role: "agent",
          text: item.text || "",
          itemId: item.id,
          turnId: turn.id,
          turnDurationMs: turn.durationMs,
        });
      else
        restored.push({
          role: "activity",
          text: item.type,
          item,
          turnId: turn.id,
          turnDurationMs: turn.durationMs,
        });
    }
  }
  return restored;
}

function latestConversationChanges(
  messages: Message[],
  workspaceRoot: string,
): { diff: string; focusPath: string } {
  let latestIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const item = messages[index].item;
    if (item?.type === "fileChange" && (item.changes?.length || item.text)) {
      latestIndex = index;
      break;
    }
  }
  if (latestIndex < 0) return { diff: "", focusPath: "" };
  const turnId = messages[latestIndex].turnId;
  let previousUserIndex = -1;
  if (!turnId)
    for (let index = latestIndex - 1; index >= 0; index -= 1) {
      if (messages[index].role === "user") {
        previousUserIndex = index;
        break;
      }
    }
  const start = turnId ? 0 : Math.max(0, previousUserIndex + 1);
  const changes = messages
    .filter(
      (message, index) =>
        index >= start &&
        message.role === "activity" &&
        message.item?.type === "fileChange" &&
        (!turnId || message.turnId === turnId),
    )
    .flatMap((message) => message.item?.changes || []);
  const root = canonicalPath(workspaceRoot);
  const formatPath = (value: string) => {
    const normalized = String(value || "未命名文件").replaceAll("\\", "/");
    return root && canonicalPath(normalized).startsWith(`${root}/`)
      ? normalized.slice(workspaceRoot.replace(/[\\/]$/, "").length + 1)
      : normalized;
  };
  const sections = changes
    .map((change) => {
      const source = String(change.diff || "").trim();
      if (!source) return "";
      if (/(^|\r?\n)diff --git /.test(source)) return source;
      const path = formatPath(String(change.path || "未命名文件"));
      if (/(^|\r?\n)@@ /.test(source))
        return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${source}`;
      const lines = source.replace(/\r?\n$/, "").split(/\r?\n/);
      const kind = change.kind?.type;
      const body =
        kind === "delete"
          ? lines.map((line) => `-${line}`).join("\n")
          : lines.map((line) => `+${line}`).join("\n");
      return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${kind === "delete" ? `@@ -1,${lines.length} +0,0 @@` : `@@ -0,0 +1,${lines.length} @@`}\n${body}`;
    })
    .filter(Boolean);
  const focusPath = formatPath(String(changes[0]?.path || ""));
  return { diff: sections.join("\n"), focusPath };
}

function setConfigPath(
  source: Record<string, any>,
  keyPath: string,
  value: any,
): Record<string, any> {
  const keys = keyPath.split(".");
  const result = { ...source };
  let target = result;
  for (let index = 0; index < keys.length - 1; index += 1) {
    const key = keys[index];
    target[key] = { ...(target[key] || {}) };
    target = target[key];
  }
  target[keys[keys.length - 1]] = value;
  return result;
}

function isCodexConfigKey(key: string): boolean {
  return /^(model$|model_provider$|model_providers\.|approval_policy$|sandbox_mode$|sandbox_workspace_write\.|analytics\.|mcp_servers\.|browser_use\.|computer_use\.|permissions$|web_search$|shell_environment_policy\.)/.test(
    key,
  );
}

function isCatalogModelSlug(value: string) {
  return /^(deepseek-flash|deepseek-v4-pro)$/.test(value.trim());
}

function canonicalModelProvider(value: string) {
  const trimmed = String(value || "").trim();
  return !trimmed || isCatalogModelSlug(trimmed) ? "deepseek" : trimmed;
}

const DEFAULT_MODEL_PROVIDERS: Record<string, any> = {
  deepseek: {
    name: "DeepSeek",
    base_url: "https://api.deepseek.com/",
    env_key: "DEEPSEEK_API_KEY",
    wire_api: "responses",
    requires_openai_auth: false,
  },
};

function providerStateFromConfig(config: Record<string, any>) {
  const selected = canonicalModelProvider(String(config.model_provider || "deepseek"));
  const selectedConfig = config.model_providers?.[selected] || DEFAULT_MODEL_PROVIDERS.deepseek;
  return {
    provider: selected,
    baseUrl: String(selectedConfig.base_url || DEFAULT_MODEL_PROVIDERS.deepseek.base_url),
    model: String(config.model || "deepseek-flash"),
    envKey: String(
      selectedConfig.env_key || `${selected.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`,
    ),
    providers: Object.keys(config.model_providers || DEFAULT_MODEL_PROVIDERS),
  };
}

function mergeSettingsLayers(
  engineResult: any,
  preferences: Record<string, any> = {},
  localConfig: Record<string, any> = {},
) {
  const engineConfig = engineResult?.config || engineResult || {};
  const projectlessWorkspaceRoot =
    localConfig.projectlessWorkspaceRoot ||
    localConfig.projectless_workspace_root;
  const prefNetwork = preferences["sandbox_workspace_write.network_access"];
  const merged = {
    ...engineConfig,
    approval_policy:
      preferences.approval_policy ||
      localConfig.approval_policy ||
      engineConfig.approval_policy,
    sandbox_mode:
      preferences.sandbox_mode ||
      localConfig.sandbox_mode ||
      engineConfig.sandbox_mode,
    sandbox_workspace_write: {
      ...(engineConfig.sandbox_workspace_write || {}),
      ...(localConfig.sandbox_workspace_write || {}),
      ...(typeof prefNetwork === "boolean" ? { network_access: prefNetwork } : {}),
    },
    ...(projectlessWorkspaceRoot
      ? { projectless_workspace_root: projectlessWorkspaceRoot }
      : {}),
    ...preferences,
  };
  merged.model =
    merged.model || localConfig.model || engineConfig.model || "deepseek-flash";
  merged.model_provider = canonicalModelProvider(
    merged.model_provider ||
      localConfig.model_provider ||
      engineConfig.model_provider ||
      "deepseek",
  );
  const providers = {
    ...DEFAULT_MODEL_PROVIDERS,
    ...(engineConfig.model_providers || {}),
    ...(localConfig.model_providers || {}),
    ...(merged.model_providers || {}),
  };
  for (const slug of Object.keys(providers)) {
    if (isCatalogModelSlug(slug)) delete providers[slug];
  }
  merged.model_providers = providers;
  return merged;
}

function approvalResponse(
  approval: {
    kind?: string;
    method?: string;
    questionId?: string;
    params?: any;
  },
  decision: string,
  answer?: string,
) {
  if (approval.kind === "input") {
    return decision === "cancel"
      ? { answers: {} }
      : {
          answers: {
            [approval.questionId || "answer"]: {
              answers: [answer || ""],
            },
          },
        };
  }
  if (approval.kind === "mcp") {
    if (decision === "cancel" || decision === "decline") {
      return mcpElicitationResponse(
        decision === "cancel" ? "cancel" : "decline",
        approval.params,
      );
    }
    return mcpElicitationResponse("accept", approval.params, answer);
  }
  if (approval.kind === "permissions") {
    const requested = approval.params?.permissions || {};
    if (decision === "decline") return { permissions: {}, scope: "turn" };
    return {
      permissions: {
        ...(requested.network ? { network: requested.network } : {}),
        ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
      },
      scope: decision === "acceptForSession" ? "session" : "turn",
    };
  }
  if (
    approval.method === "applyPatchApproval" ||
    approval.method === "execCommandApproval"
  ) {
    if (decision === "accept") return { decision: "approved" };
    if (decision === "acceptForSession" || decision === "remember") {
      return { decision: "approved_for_session" };
    }
    return {
      decision: {
        denied: {
          rejection: decision === "cancel" ? "cancelled" : "user declined",
        },
      },
    };
  }
  if (decision === "remember" && approval.params?.proposedExecpolicyAmendment) {
    return {
      decision: {
        acceptWithExecpolicyAmendment: {
          execpolicy_amendment: approval.params.proposedExecpolicyAmendment,
        },
      },
    };
  }
  if (
    decision === "accept" ||
    decision === "acceptForSession" ||
    decision === "remember"
  ) {
    return {
      decision: decision === "remember" ? "acceptForSession" : decision,
    };
  }
  return { decision: "decline" };
}
class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("Renderer crashed", error, info);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="fatal-error">
        <div>
          <strong>界面加载失败</strong>
          <p>{this.state.error.message}</p>
          <button
            className="btn primary"
            onClick={() => window.location.reload()}
          >
            重新加载
          </button>
        </div>
      </main>
    );
  }
}

function App() {
  const dialog = useAppDialog();
  const [mock, setMock] = useState(false);
  const [configReady, setConfigReady] = useState(false);
  const [status, setStatus] = useState("连接中…");
  const [threads, setThreads] = useState<Thread[]>([]);
  const [projects, setProjects] = useState<CodexProject[]>([]);
  const [codexThreadMetadataReady, setCodexThreadMetadataReady] =
    useState(false);
  const [sections, setSections] = useState<ThreadSection[]>([]);
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loadingThreadId, setLoadingThreadId] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [models, setModels] = useState<Model[]>([]);
  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [activeTurn, setActiveTurn] = useState<string | null>(null);
  const [submitBehavior, setSubmitBehavior] = useState<"queue" | "steer">(
    "steer",
  );
  const [queuedSubmissions, setQueuedSubmissions] = useState<
    Array<{
      id: string;
      input: Array<Record<string, any>>;
      clientUserMessageId: string;
    }>
  >([]);
  const [queueError, setQueueError] = useState("");
  const [panel, setPanel] = useState("");
  const [topPanelOpen, setTopPanelOpen] = useState(true);
  const [bottomPanelOpen, setBottomPanelOpen] = useState(false);
  const [sidePanelOpen, setSidePanelOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [sidebarWidth, setSidebarWidth] = useState(270);
  const [workspacePanelWidth, setWorkspacePanelWidth] = useState(760);
  const [editorMaximized, setEditorMaximized] = useState(false);
  const [workbenchTab, setWorkbenchTab] = useState<"conversation" | "document">("conversation");
  const [bottomPanelHeight, setBottomPanelHeight] = useState(300);
  const [sideTerminalWidth, setSideTerminalWidth] = useState(420);
  const [systemReduceMotion, setSystemReduceMotion] = useState(() =>
    window.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [panelRows, setPanelRows] = useState<
    Array<{ name: string; sub?: string }>
  >([]);
  const [mode, setMode] = useState("普通");
  const [reasoningEffort, setReasoningEffort] = useState("high");
  const [navigation, setNavigation] = useState("");
  const [search, setSearch] = useState("");
  const [attachments, setAttachments] = useState<
    Array<{ name: string; type: string; data: ArrayBuffer; path?: string }>
  >([]);
  const [approval, setApproval] = useState<{
    id: number | string;
    title: string;
    detail: string;
    kind?: "decision" | "input" | "mcp" | "permissions";
    questionId?: string;
    method?: string;
    params?: any;
    canRemember?: boolean;
  } | null>(null);
  const [tokens, setTokens] = useState(0);
  const [tokenHistory, setTokenHistory] = useState<number[]>(() => {
    try {
      const saved = JSON.parse(
        localStorage.getItem("local-codex:token-history") || "[]",
      );
      return Array.isArray(saved)
        ? saved.filter((value) => Number.isFinite(value)).slice(-24)
        : [];
    } catch {
      return [];
    }
  });
  const [terminalProcessId, setTerminalProcessId] = useState<string | null>(
    null,
  );
  const [filePreview, setFilePreview] = useState<{
    path: string;
    content: string;
    preview?: Record<string, any>;
  } | null>(null);
  const [filePreviewError, setFilePreviewError] = useState("");
  const [treeRevealToken, setTreeRevealToken] = useState(0);
  const treeRevealRef = useRef<{ path: string; token: number } | null>(null);
  const requestTreeReveal = useCallback((filePath: string) => {
    const token = Date.now();
    treeRevealRef.current = { path: filePath, token };
    setTreeRevealToken(token);
  }, []);
  const takeTreeReveal = useCallback((token: number) => {
    const pending = treeRevealRef.current;
    if (!pending || pending.token !== token) return "";
    treeRevealRef.current = null;
    return pending.path;
  }, []);
  const [imagePreview, setImagePreview] = useState<{
    path: string;
    name: string;
    dataUrl: string;
    error?: string;
  } | null>(null);
  const [planSteps, setPlanSteps] = useState<
    Array<{ step: string; status: string }>
  >([]);
  const [reviewDiff, setReviewDiff] = useState("");
  const [reviewError, setReviewError] = useState("");
  const [reviewFilePath, setReviewFilePath] = useState("");
  const [reviewTabOpen, setReviewTabOpen] = useState(false);
  const [sourcesTabOpen, setSourcesTabOpen] = useState(false);
  const [browserTabOpen, setBrowserTabOpen] = useState(false);
  const [providerConfig, setProviderConfig] = useState<{
    provider: string;
    baseUrl: string;
    model: string;
    envKey: string;
    providers: string[];
  }>({ provider: "", baseUrl: "", model: "", envKey: "", providers: [] });
  const [settingsView, setSettingsView] = useState(false);
  const [settingsSection, setSettingsSection] = useState("general");
  const [helpView, setHelpView] = useState("");
  const [editingProject, setEditingProject] = useState<CodexProject | null>(
    null,
  );
  const [settingsConfig, setSettingsConfig] = useState<Record<string, any>>({});
  const terminalOnRight = String(settingsConfig.terminal_placement || "底部") === "右侧";
  const [gitlabStatus, setGitlabStatus] = useState<GitLabStatus | null>(null);
  const [githubStatus, setGithubStatus] = useState<GitLabStatus | null>(null);
  const [archivedThreads, setArchivedThreads] = useState<Thread[]>([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [providerCapabilities, setProviderCapabilities] = useState<{
    responses?: boolean;
    tools?: boolean;
    images?: boolean;
  }>({});
  const [collaborationModes, setCollaborationModes] = useState<any[]>([]);
  const [outputSchema, setOutputSchema] = useState("");
  const [mcpServers, setMcpServers] = useState<any[]>([]);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [attachmentRoot, setAttachmentRoot] = useState("");
  const [projectlessWorkspaceActive, setProjectlessWorkspaceActive] =
    useState(false);
  const [gitBranch, setGitBranch] = useState("无 Git");
  const [gitActionStatus, setGitActionStatus] = useState("");
  const [gitBusy, setGitBusy] = useState(false);
  const spokenTurnRef = React.useRef<string | null>(null);
  const settingsRef = React.useRef<Record<string, any>>({});
  const mcpSessionAllowRef = React.useRef<Set<string>>(new Set());
  const resizingPanelRef = React.useRef<string | null>(null);
  const connectionStateRef = React.useRef("starting");
  const listedThreadRef = React.useRef(new Map<string, Thread>());
  const codexThreadMetadataRef = React.useRef<{
    assignments: Record<string, { projectId?: string; projectKind?: string; projectPath?: string }>;
    projectless: Set<string>;
  }>({ assignments: {}, projectless: new Set() });
  const currentIdRef = React.useRef<string | null>(null);
  const activeTurnRef = React.useRef<string | null>(null);
  const activeTurnsByThreadRef = React.useRef(new Map<string, string>());
  const modelRetryCountsRef = React.useRef(new Map<string, number>());
  const modelRetryStoppedRef = React.useRef(new Set<string>());
  const startingQueueRef = React.useRef(new Set<string>());
  const historyCursorRef = React.useRef(new Map<string, string | null>());
  const ephemeralThreadsRef = React.useRef(new Map<string, Thread>());
  const threadNavRef = React.useRef<{ stack: Array<string | null>; index: number }>({ stack: [], index: -1 });
  const [threadNav, setThreadNav] = useState({ canBack: false, canForward: false });
  const [pendingEphemeral, setPendingEphemeral] = useState(false);
  const [conversationFindTick, setConversationFindTick] = useState(0);
  const [browserFindTick, setBrowserFindTick] = useState(0);
  const dismissedUpdateRef = React.useRef("");
  const skipUpdatePromptRef = React.useRef(false);

  const current = useMemo(
    () => threads.find((thread) => thread.id === currentId),
    [threads, currentId],
  );
  const collaborationItems = useMemo(
    () =>
      messages
        .map((message) => message.item)
        .filter(
          (item: any) =>
            item?.type === "collabAgentToolCall" ||
            item?.type === "subAgentActivity",
        ) as any[],
    [messages],
  );
  const runtimeWorkspaceRoots = React.useCallback((root = workspaceRoot, extraRoot = attachmentRoot) => {
    return [...new Set([root, extraRoot].filter(Boolean))];
  }, [workspaceRoot, attachmentRoot]);
  const conversationSources = useMemo(() => {
    const byPath = new Map<string, MessageAttachment>();
    for (const message of messages) {
      for (const attachment of message.attachments || []) {
        if (!attachment.path) continue;
        const key = attachment.path.replaceAll("\\", "/").toLowerCase();
        byPath.set(key, { ...attachment, type: attachment.type || "file" });
      }
      const source = String(message.text || "").replace(/\r\n/g, "\n");
      const section =
        source.match(
          /# Files mentioned by the user:\n([\s\S]*?)(?=\n## My request:\n|$)/i,
        )?.[1] || "";
      const pathPattern = /^##\s+([^:\n]+):\n((?:[A-Za-z]:[\\/]|\/)[^\n]+)$/gm;
      let match: RegExpExecArray | null;
      while ((match = pathPattern.exec(section))) {
        const path = match[2].trim();
        const extension =
          path.split(/[?#]/)[0].split(".").pop()?.toLowerCase() || "";
        if (
          ![
            "png",
            "jpg",
            "jpeg",
            "gif",
            "webp",
            "bmp",
            "svg",
            "pdf",
            "zip",
            "txt",
            "md",
            "json",
            "csv",
          ].includes(extension)
        )
          continue;
        const key = path.replaceAll("\\", "/").toLowerCase();
        byPath.set(key, {
          name: match[1].trim(),
          path,
          type: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(
            extension,
          )
            ? "image/*"
            : "file",
        });
      }
    }
    return [...byPath.values()].reverse();
  }, [messages]);

  useEffect(() => {
    try {
      localStorage.setItem(
        "local-codex:token-history",
        JSON.stringify(tokenHistory.slice(-24)),
      );
    } catch {
      /* local storage may be unavailable in hardened profiles */
    }
  }, [tokenHistory]);
  useEffect(() => {
    if (settingsConfig.shortcuts_enabled === false) return;
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || dialogOpen()) return;
      if (typingTarget(event.target) && !event.ctrlKey && !event.metaKey && !event.altKey && event.key !== "Escape") return;
      for (const item of APP_SHORTCUTS) {
        if (item.requiresTurn && !activeTurn) continue;
        if (!shortcutMatches(event, item, settingsConfig)) continue;
        event.preventDefault();
        runWindowMenuAction(item.action);
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [settingsConfig, activeTurn, currentId, panel, threads, sidebarVisible]);
  useEffect(() => {
    const unsubscribe = api.tray.onAction((action) => {
      if (action.action === "new-thread") startNewThread();
      else if (action.action === "select-thread" && action.threadId) void selectThread(action.threadId);
      else if (action.action === "open-automations") setNavigation("自动化");
      else if (action.action === "copy-diagnostics") {
        void api.help.copyDiagnostics().then((text) => navigator.clipboard.writeText(text)).catch(() => undefined);
      } else if (action.action === "demo") {
        const input = document.querySelector("#composer-input") as HTMLTextAreaElement | null;
        const send = document.querySelector("#send") as HTMLButtonElement | null;
        if (input) {
          const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
          setter?.call(input, "回复一个字：好");
          input.dispatchEvent(new Event("input", { bubbles: true }));
          send?.click();
        }
      }
    });
    return unsubscribe;
  }, []);
  useEffect(() => api.automations.onRan((event) => {
    void listAllThreads(search).then(setThreads).catch(() => undefined);
    if (event.threadId && navigation === "自动化") {
      setNavigation("");
      void selectThread(event.threadId);
    }
  }), [navigation, search]);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setSystemReduceMotion(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    const root = document.documentElement;
    const configuredTheme = String(settingsConfig.theme || "深色");
    root.dataset.theme =
      configuredTheme === "浅色" ||
      (configuredTheme === "跟随系统" &&
        window.matchMedia("(prefers-color-scheme: light)").matches)
        ? "light"
        : "dark";
    root.dataset.density =
      String(settingsConfig.density || "舒适") === "紧凑"
        ? "compact"
        : String(settingsConfig.density || "舒适") === "宽松"
          ? "spacious"
          : "comfortable";
    root.dataset.fontSize =
      String(settingsConfig.font_size || "默认") === "小"
        ? "small"
        : String(settingsConfig.font_size || "默认") === "大"
          ? "large"
          : "default";
    const reduceMotion = String(settingsConfig.reduce_motion || "system");
    root.classList.toggle(
      "no-animations",
      settingsConfig.animations_enabled === false ||
        reduceMotion === "on" ||
        (reduceMotion === "system" && systemReduceMotion),
    );
    root.classList.toggle("code-wrap", settingsConfig.code_wrap === true);
    root.classList.toggle(
      "hide-activity-details",
      settingsConfig.show_activity_details === false,
    );
    root.classList.toggle("terminal-bottom-open", bottomPanelOpen);
    root.classList.toggle(
      "pointer-cursor",
      settingsConfig.pointer_cursor !== false,
    );
    root.style.setProperty(
      "--accent",
      String(settingsConfig.accent_color || "#7aa2f7"),
    );
    root.style.setProperty(
      "--ui-font-size",
      `${Number(settingsConfig.ui_font_size || 14)}px`,
    );
    root.style.setProperty(
      "--code-font-size",
      `${Number(settingsConfig.code_font_size || 12)}px`,
    );
    const useSystemThemeSource = String(settingsConfig.theme_source || "Codex") === "系统";
    root.dataset.themeSource = useSystemThemeSource ? "system" : "codex";
    if (useSystemThemeSource) {
      root.style.setProperty("--appearance-background", "Canvas");
      root.style.setProperty("--appearance-foreground", "CanvasText");
    } else {
      root.style.setProperty(
        "--appearance-background",
        String(settingsConfig.background_color || "#FFFFFF"),
      );
      root.style.setProperty(
        "--appearance-foreground",
        String(settingsConfig.foreground_color || "#1A1C1F"),
      );
    }
    root.style.setProperty(
      "--ui-font-family",
      settingsConfig.ui_font === "Segoe UI"
        ? '"Segoe UI", sans-serif'
        : settingsConfig.ui_font === "Inter"
          ? "Inter, sans-serif"
          : "system-ui, sans-serif",
    );
    root.style.setProperty(
      "--code-font-family",
      settingsConfig.code_font === "JetBrains Mono"
        ? '"JetBrains Mono", monospace'
        : settingsConfig.code_font === "Consolas"
          ? "Consolas, monospace"
          : "ui-monospace, Consolas, monospace",
    );
    root.style.setProperty(
      "--ui-font-weight",
      settingsConfig.ui_font_weight === "粗体"
        ? "700"
        : settingsConfig.ui_font_weight === "中等"
          ? "600"
          : "400",
    );
    root.style.setProperty(
      "--code-font-weight",
      settingsConfig.code_font_weight === "粗体"
        ? "700"
        : settingsConfig.code_font_weight === "中等"
          ? "600"
          : "400",
    );
    const contrast = Math.max(
      0,
      Math.min(100, Number(settingsConfig.contrast ?? 45)),
    );
    root.style.setProperty("--appearance-contrast", `${contrast}%`);
    root.style.setProperty(
      "--appearance-contrast-filter",
      String(0.82 + (contrast / 100) * 0.36),
    );
    root.classList.add("appearance-contrast-enabled");
    root.classList.toggle(
      "translucent-sidebar",
      settingsConfig.translucent_sidebar !== false,
    );
    root.dataset.diffMarker =
      settingsConfig.diff_marker_style === "+/-"
        ? "signs"
        : settingsConfig.diff_marker_style === "颜色 + +/-"
          ? "both"
          : "color";
  }, [settingsConfig, panel, bottomPanelOpen, systemReduceMotion]);
  useEffect(() => {
    settingsRef.current = settingsConfig;
  }, [settingsConfig]);
  useEffect(() => {
    const conversation = document.querySelector<HTMLElement>(".conversation");
    const composer = document.querySelector<HTMLElement>(".composer-v2");
    if (!conversation || !composer) return undefined;
    const syncComposerHeight = () => {
      conversation.style.setProperty("--composer-height", `${Math.ceil(composer.getBoundingClientRect().height)}px`);
    };
    const observer = new ResizeObserver(syncComposerHeight);
    observer.observe(composer);
    syncComposerHeight();
    return () => observer.disconnect();
  }, [currentId, activeTurn, attachments.length, queuedSubmissions.length, bottomPanelOpen, panel, approval]);
  useEffect(() => {
    const sidebar = Number(settingsConfig.sidebar_width);
    const workspace = Number(settingsConfig.workspace_panel_width);
    const bottom = Number(settingsConfig.bottom_panel_height);
    const side = Number(settingsConfig.side_terminal_width);
    if (Number.isFinite(sidebar) && sidebar > 0) setSidebarWidth(Math.round(sidebar));
    if (Number.isFinite(workspace) && workspace > 0) setWorkspacePanelWidth(Math.round(workspace));
    if (Number.isFinite(bottom) && bottom > 0) setBottomPanelHeight(Math.round(bottom));
    if (Number.isFinite(side) && side > 0) setSideTerminalWidth(Math.round(side));
  }, [settingsConfig.sidebar_width, settingsConfig.workspace_panel_width, settingsConfig.bottom_panel_height, settingsConfig.side_terminal_width]);

  function beginPanelResize(kind: "sidebar" | "workspace" | "bottom" | "side", event: React.MouseEvent<HTMLDivElement>) {
    event.preventDefault();
    resizingPanelRef.current = kind;
    let lastValue = kind === "sidebar" ? sidebarWidth : kind === "workspace" ? workspacePanelWidth : kind === "side" ? sideTerminalWidth : bottomPanelHeight;
    let pendingValue = lastValue;
    let frame = 0;
    const shell = document.querySelector<HTMLElement>(".app-shell");
    const cssKey = kind === "sidebar" ? "--sidebar-width" : kind === "workspace" ? "--workspace-panel-width" : kind === "side" ? "--side-terminal-width" : "--bottom-panel-height";
    const applyFrame = () => {
      frame = 0;
      shell?.style.setProperty(cssKey, `${pendingValue}px`);
    };
    document.body.style.userSelect = "none";
    document.body.style.cursor = kind === "bottom" ? "row-resize" : "col-resize";
    const move = (moveEvent: MouseEvent) => {
      if (kind === "sidebar") {
        const next = Math.max(190, Math.min(440, moveEvent.clientX));
        lastValue = Math.round(next);
      } else if (kind === "workspace") {
        const next = Math.max(360, Math.min(Math.round(window.innerWidth * 0.72), Math.round(window.innerWidth - moveEvent.clientX)));
        lastValue = next;
      } else if (kind === "side") {
        const next = Math.max(280, Math.min(Math.round(window.innerWidth * 0.55), Math.round(window.innerWidth - moveEvent.clientX)));
        lastValue = next;
      } else {
        const panel = document.querySelector<HTMLElement>(".bottom-terminal-panel");
        const bottom = panel?.getBoundingClientRect().bottom || window.innerHeight;
        lastValue = Math.max(180, Math.min(620, Math.round(bottom - moveEvent.clientY)));
      }
      pendingValue = lastValue;
      if (!frame) frame = window.requestAnimationFrame(applyFrame);
      window.dispatchEvent(new Event("resize"));
    };
    const stop = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", stop);
      if (frame) window.cancelAnimationFrame(frame);
      pendingValue = lastValue;
      applyFrame();
      if (kind === "sidebar") setSidebarWidth(lastValue);
      else if (kind === "workspace") setWorkspacePanelWidth(lastValue);
      else if (kind === "side") setSideTerminalWidth(lastValue);
      else setBottomPanelHeight(lastValue);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
      const key = kind === "sidebar" ? "sidebar_width" : kind === "workspace" ? "workspace_panel_width" : kind === "side" ? "side_terminal_width" : "bottom_panel_height";
      void saveSetting(key, lastValue);
      resizingPanelRef.current = null;
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", stop, { once: true });
  }
  useEffect(() => {
    let cancelled = false;
    const unsubscribe = api.preferences.onChanged((preferences) => {
      if (!cancelled)
        setSettingsConfig((currentConfig) => ({
          ...currentConfig,
          ...preferences,
        }));
    });
    void api.preferences
      .read()
      .then((preferences) => {
        if (!cancelled)
          setSettingsConfig((currentConfig) => ({
            ...currentConfig,
            ...preferences,
          }));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  useEffect(() => {
    if (!api.app.onUpdateStatus) return undefined;
    return api.app.onUpdateStatus((status) => {
      if (skipUpdatePromptRef.current) {
        skipUpdatePromptRef.current = false;
        return;
      }
      if (!status?.newer) return;
      void promptFoundUpdate(status, true);
    });
  }, []);
  useEffect(() => {
    currentIdRef.current = currentId;
  }, [currentId]);
  useEffect(() => {
    if (!currentId || projects.length === 0) return;
    const metadata =
      listedThreadRef.current.get(currentId) ||
      threads.find((thread) => thread.id === currentId);
    const project = projectForThread(metadata, projects);
    if (
      !project ||
      canonicalPath(project.path) === canonicalPath(workspaceRoot)
    )
      return;
    let cancelled = false;
    void api.workspace
      .setRoot(project.path)
      .then(async (selected) => {
        if (cancelled) return;
        setWorkspaceRoot(selected.root);
        const git = await api.git.status();
        if (cancelled) return;
        const branch = git.output.match(
          /^##\s+(?:No commits yet on )?([^\.\s]+)/,
        )?.[1];
        setGitBranch(branch || (git.ok ? "HEAD" : "无 Git"));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [currentId, projects, threads, workspaceRoot]);
  const reloadHostStatuses = useCallback(async () => {
    const [gitlab, github] = await Promise.all([
      api.gitlab.status().catch(() => null),
      api.github.status().catch(() => null),
    ]);
    setGitlabStatus((old) => keepHostStatus(old, gitlab));
    setGithubStatus((old) => keepHostStatus(old, github));
  }, []);
  useEffect(() => {
    let cancelled = false;
    let lastSignature: string | null = null;
    const watchingHost = navigation === "Git" || navigation === "GitLab" || navigation === "GitHub";
    const tick = async (force = false) => {
      try {
        const remotes = await api.git.remotes();
        if (cancelled) return;
        const signature = `${workspaceRoot}\0${remotes.signature || ""}`;
        const changed = lastSignature !== signature;
        lastSignature = signature;
        if (changed) {
          const origin =
            (remotes.items || []).find((item) => item.name === "origin") || (remotes.items || [])[0];
          if (origin?.url && workspaceRoot) {
            setProjects((old) =>
              old.map((project) =>
                canonicalPath(project.path) === canonicalPath(workspaceRoot) &&
                canonicalRemote(project.gitOrigin || "") !== canonicalRemote(origin.url)
                  ? { ...project, gitOrigin: origin.url }
                  : project,
              ),
            );
          }
        }
        if (force || changed) await reloadHostStatuses();
      } catch {
        if (!cancelled && force) await reloadHostStatuses();
      }
    };
    void tick(true);
    const interval = window.setInterval(() => void tick(), watchingHost ? 2500 : 8000);
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [
    workspaceRoot,
    navigation,
    reloadHostStatuses,
    settingsConfig.gitlab_enabled,
    settingsConfig.gitlab_base_url,
    settingsConfig.gitlab_connections,
    settingsConfig.github_enabled,
    settingsConfig.github_base_url,
    settingsConfig.github_connections,
  ]);
  useEffect(() => {
    if (panel !== "git" || settingsConfig.git_auto_refresh === false) return;
    const timer = window.setInterval(() => void loadPanel("git"), 5000);
    return () => window.clearInterval(timer);
  }, [panel, settingsConfig.git_auto_refresh]);
  useEffect(() => {
    if (activeTurn) {
      spokenTurnRef.current = activeTurn;
      return;
    }
    if (
      !spokenTurnRef.current ||
      !settingsConfig.voice_auto_read ||
      !("speechSynthesis" in window)
    )
      return;
    spokenTurnRef.current = null;
    const latest = [...messages]
      .reverse()
      .find((message) => message.role === "agent" && message.text.trim());
    if (!latest) return;
    const utterance = new SpeechSynthesisUtterance(latest.text);
    utterance.lang =
      String(settingsConfig.language || "简体中文") === "English"
        ? "en-US"
        : "zh-CN";
    utterance.rate =
      Number.parseFloat(String(settingsConfig.voice_rate || "1.0x")) || 1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
    return () => window.speechSynthesis.cancel();
  }, [
    activeTurn,
    messages,
    settingsConfig.voice_auto_read,
    settingsConfig.voice_rate,
    settingsConfig.language,
  ]);

  useEffect(() => {
    const unStatus = api.appServer.onStatus((next) => {
      const connected = next.state === "connected";
      const recovering = connected && ["disconnected", "reconnecting", "error", "starting", "connecting"].includes(connectionStateRef.current);
      connectionStateRef.current = String(next.state || "");
      setStatus(
        next.state === "connected"
          ? "已连接"
          : next.state === "connecting"
            ? "连接中…"
            : next.state === "reconnecting"
              ? "重连中…"
            : next.state === "error"
              ? `连接失败${next.message ? `：${next.message}` : ""}`
            : "已断开",
      );
      if (connected) {
        void listAllThreads(search).then((listed) => setThreads(mock ? uniqueThreads(listed) : listed)).catch(() => undefined);
        const threadId = currentIdRef.current;
        if (recovering && threadId) {
          void readThreadMessages(threadId).then((loaded) => {
            if (currentIdRef.current !== threadId) return;
            setMessages(loaded);
            setActiveTurn(null);
            activeTurnRef.current = null;
            setLoadingThreadId(null);
          }).catch(() => undefined);
        }
      }
    });
    const unNotify = api.appServer.onNotification((message) => {
      const params = message.params || {};
      const eventThreadId = String(
        params.threadId ||
          params.thread?.id ||
          params.turn?.threadId ||
          params.turn?.thread_id ||
          "",
      );
      const eventTurnId = String(
        params.turnId ||
          params.turn?.id ||
          params.item?.turnId ||
          params.item?.turn_id ||
          "",
      );
      if (eventThreadId && message.method === "turn/started" && eventTurnId)
        activeTurnsByThreadRef.current.set(eventThreadId, eventTurnId);
      if (eventThreadId && message.method === "turn/completed")
        activeTurnsByThreadRef.current.delete(eventThreadId);
      if (message.method === "turn/completed") {
        void Promise.resolve(api.app.isFocused?.()).then((focused) => {
          const enabled = settingsRef.current.notify_on_turn_complete !== false;
          if (!shouldNotifyTurn({
            enabled,
            focused: Boolean(focused),
            currentThreadId: currentIdRef.current || "",
            eventThreadId,
          })) return;
          const thread = listedThreadRef.current.get(eventThreadId);
          const notice = turnCompleteNotice({
            enabled,
            title: thread ? titleOf(thread) : "线程",
            error: Boolean(params.turn?.error || params.error),
          });
          if (notice) void api.app.notify?.(notice);
        });
      }
      if (eventThreadId && message.method === "thread/status/changed")
        setThreads((old) => old.map((thread) => thread.id === eventThreadId ? { ...thread, status: params.status || thread.status } : thread));
      const threadScopedEvent =
        /^(?:turn\/|item\/|command\/|process\/|thread\/queue\/|thread\/tokenUsage)/.test(
          message.method,
        );
      if (
        threadScopedEvent &&
        eventThreadId &&
        currentIdRef.current &&
        eventThreadId !== currentIdRef.current
      )
        return;
      if (message.method === "error" && eventTurnId) {
        const errorText = formatTurnError(params.error);
        const viewingThisThread = !eventThreadId || eventThreadId === currentIdRef.current;
        const stopTurn = (reason: string) => {
          if (modelRetryStoppedRef.current.has(eventTurnId)) return;
          modelRetryStoppedRef.current.add(eventTurnId);
          const threadId = eventThreadId || currentIdRef.current || "";
          if (threadId) {
            activeTurnsByThreadRef.current.delete(threadId);
            void api.appServer.request("turn/interrupt", { threadId, turnId: eventTurnId }).catch(() => undefined);
          }
          if (activeTurnRef.current === eventTurnId) {
            setActiveTurn(null);
            activeTurnRef.current = null;
          }
          if (!viewingThisThread) return;
          const reconnectId = `model-reconnect-${eventTurnId}`;
          setMessages((old) => {
            let replacedReconnect = false;
            let filledAgent = false;
            const next = old.map((entry) => {
              if (entry.item?.type === "modelReconnect" && (entry.item.id === reconnectId || entry.turnId === eventTurnId)) {
                replacedReconnect = true;
                return { ...entry, text: reason, item: { ...entry.item, id: reconnectId, type: "modelReconnect", status: "failed", text: reason } };
              }
              if (entry.role === "agent" && entry.turnId === eventTurnId && !entry.text) {
                filledAgent = true;
                return { ...entry, text: `连接失败：${reason}` };
              }
              return entry;
            });
            const extras: Message[] = [];
            if (!replacedReconnect) extras.push({ role: "activity", text: reason, turnId: eventTurnId, item: { id: reconnectId, type: "modelReconnect", status: "failed", text: reason } });
            if (!filledAgent && !next.some((entry) => entry.role === "agent" && entry.turnId === eventTurnId && entry.text)) {
              extras.push({ role: "agent", text: `连接失败：${reason}`, turnId: eventTurnId });
            }
            return extras.length ? [...next, ...extras] : next;
          });
        };
        if (modelRetryStoppedRef.current.has(eventTurnId)) return;
        if (params.willRetry) {
          const attempt = (modelRetryCountsRef.current.get(eventTurnId) || 0) + 1;
          modelRetryCountsRef.current.set(eventTurnId, attempt);
          if (attempt >= MODEL_RETRY_LIMIT) {
            stopTurn(errorText);
            return;
          }
          if (viewingThisThread) {
            const reconnectId = `model-reconnect-${eventTurnId}`;
            const text = `正在重新连接 ${attempt}/${MODEL_RETRY_LIMIT}`;
            setMessages((old) => {
              const index = old.findIndex((entry) => entry.item?.id === reconnectId || (entry.item?.type === "modelReconnect" && entry.turnId === eventTurnId));
              const nextMessage: Message = { role: "activity", text, turnId: eventTurnId, item: { id: reconnectId, type: "modelReconnect", text, status: "inProgress" } };
              if (index < 0) return [...old, nextMessage];
              return old.map((entry, i) => (i === index ? nextMessage : entry));
            });
          }
          return;
        }
        stopTurn(errorText);
        return;
      }
      if (
        threadScopedEvent &&
        !eventThreadId &&
        eventTurnId &&
        (!activeTurnRef.current || eventTurnId !== activeTurnRef.current)
      )
        return;
      const upsertActivity = (item: TurnItem, turnId = params.turnId) => {
        if (!item?.id && !turnId) return;
        setMessages((old) => {
          const itemId = item.id ? String(item.id) : "";
          const index = itemId
            ? [...old]
                .map((entry, i) => ({ entry, i }))
                .reverse()
                .find(
                  ({ entry }) =>
                    entry.role === "activity" && entry.item?.id === itemId,
                )?.i
            : undefined;
          const nextMessage: Message = {
            role: "activity",
            text: item.type || "activity",
            item,
            turnId: String(turnId || ""),
          };
          if (index == null) return [...old, nextMessage];
          return old.map((entry, i) =>
            i === index
              ? {
                  ...entry,
                  text: item.type || entry.text,
                  item: { ...(entry.item || {}), ...item },
                  turnId: entry.turnId || String(turnId || ""),
                }
              : entry,
          );
        });
      };
      const appendItemDelta = (
        itemId: unknown,
        turnId: unknown,
        patch: Partial<TurnItem>,
      ) => {
        const key = String(itemId || "");
        if (!key) return;
        setMessages((old) => {
          const index = [...old]
            .map((entry, i) => ({ entry, i }))
            .reverse()
            .find(
              ({ entry }) =>
                entry.role === "activity" && entry.item?.id === key,
            )?.i;
          if (index == null)
            return [
              ...old,
              {
                role: "activity",
                text: String(patch.type || "activity"),
                item: {
                  id: key,
                  type: String(patch.type || "activity"),
                  ...patch,
                },
                turnId: String(turnId || ""),
              },
            ];
          return old.map((entry, i) => {
            if (i !== index) return entry;
            const existing = (entry.item || {}) as TurnItem;
            const nextPatch = { ...patch } as TurnItem;
            if (patch.aggregatedOutput != null && existing.aggregatedOutput)
              nextPatch.aggregatedOutput = `${existing.aggregatedOutput}${patch.aggregatedOutput}`;
            if (patch.text != null && existing.text)
              nextPatch.text = `${existing.text}${patch.text}`;
            return { ...entry, item: { ...existing, ...nextPatch } };
          });
        });
      };
      if (message.method === "thread/started") {
        const thread = params.thread as Thread;
        if (!thread?.id) return;
        setThreads((old) =>
          uniqueThreads(
            old.some((item) => item.id === thread.id)
              ? old.map((item) => {
                  const listed = listedThreadRef.current.get(thread.id);
                  return item.id === thread.id
                    ? {
                        ...item,
                        ...thread,
                        title: thread.title || thread.name || item.title,
                        displayTitle: thread.displayTitle || item.displayTitle,
                        cwd: listed?.cwd || item.cwd || thread.cwd,
                        gitInfo:
                          listed?.gitInfo || item.gitInfo || thread.gitInfo,
                      }
                    : item;
                })
              : [...old, thread],
          ),
        );
        setCurrentId(thread.id);
      } else if (message.method === "turn/started") {
        const turn = (params.turn || {}) as Turn;
        if (eventThreadId && turn.id) activeTurnsByThreadRef.current.set(eventThreadId, turn.id);
        setActiveTurn(turn.id || null);
        activeTurnRef.current = turn.id || null;
        if (turn.id)
          setMessages((old) =>
            old.map((item, index) =>
              index >= old.length - 2 &&
              (item.role === "user" || item.role === "agent") &&
              !item.turnId
                ? { ...item, turnId: turn.id, turnStartedAt: Date.now() }
                : item,
            ),
          );
      } else if (message.method === "item/started") {
        const item = params.item as TurnItem;
        if (item?.type === "userMessage") {
          const content = Array.isArray((item as any).content) ? (item as any).content : [];
          const text = content
            .filter((entry: any) => entry?.type === "text")
            .map((entry: any) => String(entry.text || ""))
            .join(" ")
            .trim();
          const itemId = String((item as any).clientId || item.id || "");
          if (text || itemId) {
            setMessages((old) => {
              if (itemId && old.some((entry) => entry.itemId === itemId || entry.itemId === item.id)) return old;
              if (text && old.some((entry) => entry.role === "user" && entry.text === text)) return old;
              return [...old, { role: "user", text: text || "附件消息", itemId: itemId || undefined }];
            });
          }
        } else if (item?.type === "agentMessage") {
          const itemId = String(item.id || "");
          setMessages((old) =>
            itemId &&
            old.some(
              (entry) => entry.role === "agent" && entry.itemId === itemId,
            )
              ? old
              : [
                  ...old,
                  {
                    role: "agent",
                    text: item.text || "",
                    itemId: itemId || undefined,
                    turnId: String(params.turnId || ""),
                  },
                ],
          );
        } else if (item && item.type !== "userMessage") upsertActivity(item);
      } else if (message.method === "item/agentMessage/delta") {
        setMessages((old) => {
          const itemId = String(params.itemId || "");
          const target = [...old]
            .map((entry, i) => ({ entry, i }))
            .reverse()
            .find(
              ({ entry }) =>
                entry.role === "agent" &&
                ((itemId && entry.itemId === itemId) ||
                  (!itemId && entry.turnId === String(params.turnId || ""))),
            )?.i;
          if (target == null)
            return [
              ...old,
              {
                role: "agent",
                text: String(params.delta || ""),
                itemId: itemId || undefined,
                turnId: String(params.turnId || ""),
              },
            ];
          return old.map((item, i) =>
            i === target
              ? {
                  ...item,
                  itemId: item.itemId || itemId || undefined,
                  turnId: item.turnId || String(params.turnId || ""),
                  text: item.text + String(params.delta || ""),
                }
              : item,
          );
        });
      } else if (message.method === "item/completed") {
        const item = params.item as TurnItem;
        if (item?.type === "agentMessage" && item.text) {
          setMessages((old) => {
            const itemId = String(item.id || "");
            const index = [...old]
              .map((entry, i) => ({ entry, i }))
              .reverse()
              .find(
                ({ entry }) =>
                  entry.role === "agent" &&
                  ((itemId && entry.itemId === itemId) ||
                    (!itemId && entry.turnId === String(params.turnId || ""))),
              )?.i;
            return index == null
              ? [
                  ...old,
                  {
                    role: "agent",
                    text: item.text || "",
                    itemId: itemId || undefined,
                    turnId: String(params.turnId || ""),
                  },
                ]
              : old.map((entry, i) =>
                  i === index
                    ? {
                        ...entry,
                        itemId: entry.itemId || itemId || undefined,
                        turnId: entry.turnId || String(params.turnId || ""),
                        text: item.text || "",
                      }
                    : entry,
                );
          });
        } else if (
          item &&
          item.type !== "userMessage" &&
          item.type !== "agentMessage"
        )
          upsertActivity(item);
      } else if (message.method === "turn/completed") {
        if (eventThreadId) activeTurnsByThreadRef.current.delete(eventThreadId);
        if (eventTurnId) {
          modelRetryCountsRef.current.delete(eventTurnId);
          modelRetryStoppedRef.current.delete(eventTurnId);
        }
        setActiveTurn(null);
        activeTurnRef.current = null;
        const completedTurn = params.turn || {};
        const completionText = completedTurn.error
          ? `回合失败：${completedTurn.error.message || completedTurn.error}`
          : "回合已完成（无文本输出）";
        setMessages((old) => {
          const index = [...old]
            .map((entry, i) => ({ entry, i }))
            .reverse()
            .find(({ entry }) => entry.role === "agent" && !entry.text)?.i;
          return old.map((entry, i) =>
            entry.turnId === completedTurn.id
              ? {
                  ...entry,
                  turnDurationMs:
                    Number(completedTurn.durationMs) || entry.turnDurationMs,
                }
              : i === index
                ? { ...entry, text: completionText }
                : entry,
          );
        });
        if (settingsRef.current.auto_archive_completed && params.threadId)
          void api.appServer
            .request("thread/archive", { threadId: params.threadId })
            .then(() =>
              setThreads((old) =>
                old.map((thread) =>
                  thread.id === params.threadId
                    ? { ...thread, archived: true }
                    : thread,
                ),
              ),
            )
            .catch(() => undefined);
        if (params.threadId && !startingQueueRef.current.has(params.threadId)) {
          startingQueueRef.current.add(params.threadId);
          void api.appServer
            .request("thread/queue/list", { threadId: params.threadId })
            .then(async (result) => {
              const queue = listData<any>(result);
              if (currentIdRef.current === params.threadId)
                setQueuedSubmissions(queue);
              if (queue[0]?.id) {
                if (currentIdRef.current === params.threadId)
                  setMessages((old) => [
                    ...old,
                    { role: "user", text: queuedText(queue[0]) },
                    { role: "agent", text: "" },
                  ]);
                await api.appServer.request("thread/queue/start", {
                  threadId: params.threadId,
                  queuedSubmissionId: queue[0].id,
                });
              }
            })
            .catch((error) =>
              setPanelRows((old) => [
                ...old.slice(-19),
                { name: "队列启动失败", sub: String(error) },
              ]),
            )
            .finally(() => startingQueueRef.current.delete(params.threadId));
        }
      }
      if (message.method === "thread/queue/changed" && params.threadId) {
        void api.appServer
          .request("thread/queue/list", { threadId: params.threadId })
          .then((result) => {
            if (currentIdRef.current === params.threadId)
              setQueuedSubmissions(listData<any>(result));
          })
          .catch(() => undefined);
      }
      if (message.method === "thread/tokenUsage/updated") {
        const total =
          params.tokenUsage?.last?.totalTokens ||
          params.tokenUsage?.total?.totalTokens ||
          0;
        const next = Number(total) || 0;
        setTokens(next);
        if (next > 0) setTokenHistory((old) => [...old.slice(-23), next]);
      }
      if (message.method === "turn/plan/updated") {
        const plan = (params.plan || []) as Array<{
          step: string;
          status: string;
        }>;
        setPlanSteps(plan);
        if (panel === "plans")
          setPanelRows(
            plan.map((item) => ({ name: item.step, sub: item.status })),
          );
      }
      if (message.method === "command/exec/outputDelta") {
        const delta = String(params.delta || params.output || "");
        if (delta)
          setPanelRows((old) =>
            old.length
              ? old.map((row, index) =>
                  index === old.length - 1
                    ? { ...row, sub: `${row.sub || ""}${delta}` }
                    : row,
                )
              : [{ name: "终端输出", sub: delta }],
          );
      }
      if (
        message.method === "item/reasoning/summaryTextDelta" ||
        message.method === "item/reasoning/textDelta"
      ) {
        const delta = String(params.delta || params.text || "");
        if (delta)
          appendItemDelta(params.itemId, params.turnId, {
            type: "reasoning",
            text: `${String(params.previousText || "" || "")}${delta}`,
            status: "inProgress",
          });
      }
      if (
        message.method === "item/commandExecution/outputDelta" ||
        message.method === "command/exec/outputDelta" ||
        message.method === "process/outputDelta"
      ) {
        const delta = String(params.delta || params.output || "");
        if (delta && params.itemId)
          appendItemDelta(params.itemId, params.turnId, {
            type: "commandExecution",
            aggregatedOutput: delta,
            status: "inProgress",
          });
      }
      if (message.method === "item/fileChange/outputDelta") {
        const delta = String(params.delta || params.output || "");
        if (delta)
          appendItemDelta(params.itemId, params.turnId, {
            type: "fileChange",
            text: delta,
            status: "inProgress",
          });
      }
      if (/collab|subAgent|agentToolCall/i.test(message.method)) {
        const detail =
          params.agentName ||
          params.subAgentId ||
          params.item?.type ||
          params.status ||
          "协作活动";
        setPanelRows((old) => [
          ...old.slice(-19),
          {
            name: String(detail),
            sub: String(params.message || params.command || message.method),
          },
        ]);
      }
    });
    const unRequest = api.appServer.onRequest((request) => {
      if (request.method === "item/permissions/requestApproval") {
        const params = request.params || {};
        setApproval({
          id: request.id,
          title: "额外权限",
          detail: String(params.reason || "Agent 请求额外文件或网络权限"),
          kind: "permissions",
          method: request.method,
          params,
        });
      } else if (request.method.endsWith("requestApproval")) {
        const params = request.params || {};
        setApproval({
          id: request.id,
          title: request.method.includes("command") ? "命令执行" : "文件变更",
          detail: String(
            params.command || params.reason || "Agent 请求额外权限",
          ),
          method: request.method,
          params,
          canRemember: Boolean(params.proposedExecpolicyAmendment?.length),
        });
      } else if (request.method.endsWith("requestUserInput")) {
        const question = (request.params?.questions || [])[0];
        setApproval({
          id: request.id,
          title: "Agent 需要输入",
          detail: String(
            question?.question || question?.header || "请输入信息",
          ),
          kind: "input",
          questionId: question?.id || "answer",
          method: request.method,
          params: request.params,
        });
      } else if (request.method === "mcpServer/elicitation/request") {
        const params = request.params || {};
        const grant = mcpAllowTool(params);
        if (
          isMcpAllowElicitation(params) &&
          grant &&
          mcpToolAlreadyGranted(
            grant.server,
            grant.tool,
            settingsRef.current,
            mcpSessionAllowRef.current,
          )
        ) {
          void api.appServer.respond(
            request.id,
            mcpElicitationResponse("accept", params),
          );
          return;
        }
        setApproval({
          id: request.id,
          title: `MCP · ${params.serverName || "服务"}`,
          detail: String(params.message || params.url || "MCP 服务需要输入"),
          kind: "mcp",
          method: request.method,
          params,
          canRemember: isMcpAllowElicitation(params),
        });
      } else if (request.method === "applyPatchApproval") {
        const files = Object.keys(request.params?.fileChanges || {});
        setApproval({
          id: request.id,
          title: "文件变更",
          detail: String(request.params?.reason || files.join(", ") || "Agent 请求写入文件"),
          method: request.method,
          params: request.params,
          canRemember: true,
        });
      } else if (request.method === "execCommandApproval") {
        const command = Array.isArray(request.params?.command)
          ? request.params.command.join(" ")
          : "";
        setApproval({
          id: request.id,
          title: "命令执行",
          detail: String(request.params?.reason || command || "Agent 请求执行命令"),
          method: request.method,
          params: request.params,
          canRemember: true,
        });
      } else if (request.method === "currentTime/read") {
        void api.appServer.respond(request.id, {
          currentTimeAt: Math.floor(Date.now() / 1000),
        });
      } else if (request.method === "item/tool/call") {
        void api.appServer.respond(request.id, {
          contentItems: [
            { type: "inputText", text: "本地客户端未注册该动态工具" },
          ],
          success: false,
        });
        } else {
          setMessages((old) => [
            ...old,
            { role: "activity", text: `未处理的引擎请求：${request.method}` },
          ]);
          void api.appServer.respond(request.id, { decision: "decline" });
        }
    });
    void Promise.all([
      api.config.read(),
      api.codex
        .threadMetadata()
        .catch(() => ({ assignments: {}, projectless: [] })),
    ])
      .then(([config, metadata]) => {
        codexThreadMetadataRef.current = {
          assignments: metadata.assignments || {},
          projectless: new Set(metadata.projectless || []),
        };
        setCodexThreadMetadataReady(true);
        setMock(Boolean(config.mock));
        if (config.projectlessWorkspaceRoot)
          setWorkspaceRoot(config.projectlessWorkspaceRoot);
        if (config.attachmentRoot) setAttachmentRoot(config.attachmentRoot);
        if (config.state)
          setStatus(
            config.state === "connected"
              ? "已连接"
              : config.state === "reconnecting"
                ? "重连中…"
                : config.state === "connecting"
                  ? "连接中…"
                  : config.state === "error"
                    ? `连接失败${(config as { message?: string }).message ? `：${(config as { message?: string }).message}` : ""}`
                  : "已断开",
          );
        setConfigReady(true);
      })
      .catch(() => {
        setCodexThreadMetadataReady(true);
        setConfigReady(true);
      });
    void api.git
      .status()
      .then((result) => {
        const match = result.output.match(
          /^##\s+(?:No commits yet on )?([^\.\s]+)/,
        );
        setGitBranch(match?.[1] || (result.ok ? "HEAD" : "无 Git"));
      })
      .catch(() => setGitBranch("无 Git"));
    return () => {
      unStatus();
      unNotify();
      unRequest();
    };
  }, []);

  useEffect(() => {
    if (!configReady || !codexThreadMetadataReady) return;
    void listAllThreads(search)
      .then((listed) => {
        const data = mock ? uniqueThreads(listed) : listed;
        setThreads(data);
        if (!currentId) {
          let remembered = "";
          try {
            remembered =
              localStorage.getItem("local-codex:last-thread-id") || "";
          } catch {
            /* local storage may be unavailable */
          }
          const preferred =
            remembered && data.some((thread) => thread.id === remembered)
              ? remembered
              : data[0]?.id;
          if (remembered && preferred !== remembered) {
            try {
              localStorage.removeItem("local-codex:last-thread-id");
            } catch {
              /* best effort */
            }
          }
          if (preferred) void selectThread(preferred);
        }
      })
      .catch(() => undefined);
    void api.appServer
      .request("model/list", {})
      .then((result) => {
        const data = listData<Model>(result);
        if (!data.length) return;
        setModels(data);
        setModel((current) => pickCatalogModel(data, current));
      })
      .catch(() => undefined);
    void Promise.all([
      api.appServer.request("config/read", {}).catch(() => ({})),
      api.preferences.read().catch(() => ({})),
      api.config.read().catch(() => ({})),
    ]).then(([result, preferences, localConfig]) => {
      const merged = mergeSettingsLayers(
        result,
        preferences || {},
        (localConfig || {}) as Record<string, any>,
      );
      setSettingsConfig(merged);
      const configuredEffort = String(
        merged.model_reasoning_effort || merged.reasoning_effort || "",
      )
        .trim()
        .toLowerCase();
      if (configuredEffort) setReasoningEffort(configuredEffort);
    });
    void api.appServer
      .request("collaborationMode/list", {})
      .then((result) => setCollaborationModes(listData<any>(result)))
      .catch(() => setCollaborationModes([]));
    void api.codex.projects().then((configured) => {
      const merged = configured.filter((project) => project.path);
      const byPath = new Map<string, CodexProject>();
      for (const project of merged) {
        const key = String(project.path)
          .replace(/[\\/]+$/, "")
          .toLowerCase();
        const previous = byPath.get(key);
        byPath.set(key, {
          ...previous,
          ...project,
          gitOrigin: project.gitOrigin || previous?.gitOrigin || "",
        });
      }
      setProjects([...byPath.values()]);
    });
    void api.appServer
      .request("threadSection/list", {})
      .then((result) => setSections(listData<ThreadSection>(result)))
      .catch(() => setSections([]));
  }, [configReady, codexThreadMetadataReady, mock, search]);

  async function readThreadMessages(
    threadId: string,
    onPage?: (messages: Message[]) => void,
    shouldContinue?: () => boolean,
    maxPages = Number.POSITIVE_INFINITY,
    startCursor: string | null = null,
    onCursor?: (cursor: string | null) => void,
  ): Promise<Message[]> {
    let result: any;
    let turnPages: Turn[] = [];
    let emittedPage = false;
    try {
      if (mock) {
        result = await api.appServer.request("thread/read", {
          threadId,
          includeTurns: true,
        });
      } else {
        let cursor: string | null = startCursor;
        let pageIndex = 0;
        const seenCursors = new Set<string>();
        do {
          if (cursor) {
            if (seenCursors.has(cursor)) {
              cursor = null;
              onCursor?.(null);
              break;
            }
            seenCursors.add(cursor);
          }
          const page = await api.appServer.request("thread/turns/list", {
            threadId,
            itemsView: "full",
            limit: 20,
            sortDirection: "desc",
            cursor,
          });
          if (shouldContinue && !shouldContinue()) return [];
          turnPages = [...turnPages, ...(page?.data || [])];
          if (pageIndex === 0 || pageIndex % 5 === 4) {
            onPage?.(messagesFromTurns([...turnPages].reverse()));
            emittedPage = true;
          }
          pageIndex += 1;
          const nextCursor = page?.nextCursor || null;
          if (nextCursor && seenCursors.has(nextCursor)) cursor = null;
          else cursor = nextCursor;
          onCursor?.(cursor);
        } while (
          cursor &&
          pageIndex < maxPages &&
          (!shouldContinue || shouldContinue())
        );
      }
    } catch (error) {
      // A newly created real thread has no persisted user turn yet. The
      // server reports this as not materialized; render a normal empty state.
      if (
        !mock &&
        /not materialized|before first user message/i.test(String(error))
      )
        return [];
      throw error;
    }
    const turns =
      ((mock ? result?.thread?.turns : [...turnPages].reverse()) as Turn[]) ||
      [];
    const restored = messagesFromTurns(turns);
    if (!onPage || maxPages !== 1 || !emittedPage) onPage?.(restored);
    return restored;
  }

  const loadRequestRef = React.useRef(0);
  async function discardEphemeralThreads(keepId?: string | null) {
    const doomed = [...ephemeralThreadsRef.current.values()].filter((thread) => thread.id && thread.id !== keepId);
    for (const thread of doomed) {
      ephemeralThreadsRef.current.delete(thread.id);
      try { await api.appServer.request("thread/delete", { threadId: thread.id }); } catch { /* already gone */ }
    }
    if (doomed.length) setThreads((old) => old.filter((thread) => !doomed.some((item) => item.id === thread.id)));
  }

  function publishThreadNav() {
    const { stack, index } = threadNavRef.current;
    setThreadNav({ canBack: index > 0, canForward: index >= 0 && index < stack.length - 1 });
  }

  function pushThreadNav(id: string | null) {
    const nav = threadNavRef.current;
    if (nav.stack[nav.index] === id) return;
    nav.stack = nav.stack.slice(0, nav.index + 1);
    nav.stack.push(id);
    if (nav.stack.length > 40) nav.stack.shift();
    nav.index = nav.stack.length - 1;
    publishThreadNav();
  }

  function goThreadNav(offset: number) {
    const nav = threadNavRef.current;
    const next = nav.index + offset;
    if (next < 0 || next >= nav.stack.length) return;
    nav.index = next;
    publishThreadNav();
    const id = nav.stack[next];
    if (id) void selectThread(id, { fromHistory: true });
    else startNewThread(false, { fromHistory: true });
  }

  async function selectThread(threadId: string, options?: { fromHistory?: boolean }) {
    if (!options?.fromHistory && currentIdRef.current && currentIdRef.current !== threadId) void discardEphemeralThreads(threadId);
    if (!options?.fromHistory) pushThreadNav(threadId);
    React.startTransition(() => {
      setNavigation("");
      setCurrentId(threadId);
      setMessages([]);
    });
    currentIdRef.current = threadId;
    const savedActiveTurn = activeTurnsByThreadRef.current.get(threadId) || null;
    setActiveTurn(savedActiveTurn);
    activeTurnRef.current = savedActiveTurn;
    setApproval(null);
    setQueuedSubmissions([]);
    setPlanSteps([]);
    historyCursorRef.current.delete(threadId);
    setHistoryHasMore(false);
    const selected =
      listedThreadRef.current.get(threadId) ||
      threads.find((thread) => thread.id === threadId);
    if (!selected?.ephemeral) {
      try {
        localStorage.setItem("local-codex:last-thread-id", threadId);
      } catch {
        /* local storage may be unavailable */
      }
    }
    const requestId = ++loadRequestRef.current;
    setLoadingThreadId(threadId);
    setQueueError("");
    try {
      const metadata = selected ||
        listedThreadRef.current.get(threadId) ||
        threads.find((thread) => thread.id === threadId);
      const project = projectForThread(metadata, projects);
      if (project && canonicalPath(project.path) !== canonicalPath(workspaceRoot)) {
        const selected = await api.workspace.setRoot(project.path);
        if (loadRequestRef.current !== requestId) return;
        setWorkspaceRoot(selected.root);
        const git = await api.git.status();
        const branch = git.output.match(
          /^##\s+(?:No commits yet on )?([^\.\s]+)/,
        )?.[1];
        setGitBranch(branch || (git.ok ? "HEAD" : "无 Git"));
      }
      const loaded = await readThreadMessages(
        threadId,
        (partial) => {
          if (loadRequestRef.current === requestId) setMessages(partial);
        },
        () => loadRequestRef.current === requestId,
        Number.POSITIVE_INFINITY,
        null,
        (cursor) => {
          if (loadRequestRef.current === requestId) {
            historyCursorRef.current.set(threadId, cursor);
            setHistoryHasMore(Boolean(cursor));
          }
        },
      );
      if (loadRequestRef.current !== requestId) return;
      const firstUserMessage = loaded.find(
        (message) => message.role === "user" && message.text.trim(),
      );
      if (
        firstUserMessage &&
        metadata &&
        !metadata.title &&
        !metadata.displayTitle &&
        !metadata.name
      ) {
        const inferredTitle = firstUserMessage.text
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 80);
        if (inferredTitle)
          setThreads((old) =>
            old.map((thread) =>
              thread.id === threadId
                ? { ...thread, title: inferredTitle }
                : thread,
            ),
          );
      }
      const queue = await api.appServer
        .request("thread/queue/list", { threadId })
        .catch(() => ({ data: [] }));
      if (loadRequestRef.current === requestId)
        setQueuedSubmissions(listData<any>(queue));
      try {
        const saved = JSON.parse(
          localStorage.getItem(`local-codex:plan:${threadId}`) || "[]",
        );
        setPlanSteps(Array.isArray(saved) ? saved : []);
      } catch {
        setPlanSteps([]);
      }
    } catch (error) {
      if (loadRequestRef.current === requestId)
        setMessages([
          { role: "activity", text: `加载线程失败：${String(error)}` },
        ]);
    } finally {
      if (loadRequestRef.current === requestId) setLoadingThreadId(null);
    }
  }

  async function loadEarlierThread() {
    const threadId = currentIdRef.current;
    const cursor = threadId
      ? historyCursorRef.current.get(threadId) || null
      : null;
    if (!threadId || !cursor || historyLoading) return;
    setHistoryLoading(true);
    const requestId = loadRequestRef.current;
    try {
      const older = await readThreadMessages(
        threadId,
        undefined,
        () =>
          loadRequestRef.current === requestId &&
          currentIdRef.current === threadId,
        1,
        cursor,
        (nextCursor) => {
          if (loadRequestRef.current === requestId) {
            historyCursorRef.current.set(threadId, nextCursor);
            setHistoryHasMore(Boolean(nextCursor));
          }
        },
      );
      if (
        loadRequestRef.current === requestId &&
        currentIdRef.current === threadId &&
        older.length > 0
      )
        setMessages((old) => [...older, ...old]);
    } finally {
      if (loadRequestRef.current === requestId) setHistoryLoading(false);
    }
  }

  async function listAllThreads(
    searchTerm = "",
    archived?: boolean,
  ): Promise<Thread[]> {
    const all: Thread[] = [];
    let cursor: string | null = null;
    const notReady = (error: unknown) =>
      /尚未就绪|not ready|还未连接|disconnected|connecting/i.test(String(error));
    for (let page = 0; page < 100; page += 1) {
      let result: any;
      for (let attempt = 0; attempt < 10; attempt += 1) {
        try {
          result = await api.appServer.request("thread/list", {
            ...(searchTerm ? { searchTerm } : {}),
            ...(archived === true ? { archived: true } : {}),
            limit: 100,
            sortKey: "recency_at",
            sortDirection: "desc",
            ...(cursor ? { cursor } : {}),
          });
          break;
        } catch (error) {
          if (!notReady(error) || attempt === 9) throw error;
          await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
        }
      }
      all.push(...listData<Thread>(result).map(listedThread));
      const next = result?.nextCursor || result?.next_cursor || null;
      if (!next || next === cursor) break;
      cursor = String(next);
    }
    const listed = uniqueThreads(all).map((thread) => {
      const metadata = codexThreadMetadataRef.current;
      if (metadata.projectless.has(thread.id))
        return { ...thread, projectId: null };
      const assignment = metadata.assignments[thread.id];
      if (assignment?.projectId)
        return { ...thread, projectId: assignment.projectId };
      return thread.projectId === null
        ? { ...thread, projectId: undefined }
        : thread;
    });
    listed.forEach((thread) => listedThreadRef.current.set(thread.id, thread));
    if (archived === true) return listed;
    const extras = [...ephemeralThreadsRef.current.values()].filter((thread) => !listed.some((item) => item.id === thread.id));
    extras.forEach((thread) => listedThreadRef.current.set(thread.id, thread));
    return [...extras, ...listed];
  }

  async function refreshArchivedThreads() {
    setArchivedLoading(true);
    try {
      setArchivedThreads(await listAllThreads("", true));
    } finally {
      setArchivedLoading(false);
    }
  }

  async function send(behavior: "queue" | "steer" = submitBehavior) {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    const sentAttachments = attachments.slice();
    setQueueError("");
    let threadId = currentId;
    let createdThread = false;
    const savedAttachments: Array<{ name: string; path: string; type: string }> = [];
    try {
      for (const file of sentAttachments) {
        if (file.path) {
          savedAttachments.push({ name: file.name, path: file.path, type: file.type || "mention" });
          continue;
        }
        const path = await api.attachments.save(file.name, file.data);
        savedAttachments.push({ name: file.name, path, type: file.type });
      }
      if (!threadId) {
        const instructions = personalizationText();
        const result = await api.appServer.request("thread/start", {
          cwd: workspaceRoot || null,
          runtimeWorkspaceRoots: runtimeWorkspaceRoots(),
          model: model || undefined,
          modelProvider: canonicalModelProvider(model || "deepseek"),
          projectId: null,
          ...(pendingEphemeral ? { ephemeral: true } : {}),
          ...(instructions ? { developerInstructions: instructions } : {}),
        });
        threadId = result?.thread?.id || null;
        createdThread = Boolean(threadId);
        if (threadId) {
          const provisionalTitle =
            text ||
            sentAttachments.map((file) => file.name).join(", ") ||
            "新线程";
          const created = {
            ...(result?.thread || {}),
            id: threadId,
            title: provisionalTitle,
            cwd: workspaceRoot,
            ephemeral: Boolean(pendingEphemeral || result?.thread?.ephemeral),
          } as Thread;
          if (created.ephemeral) ephemeralThreadsRef.current.set(threadId, created);
          setThreads((old) =>
            old.some((item) => item.id === threadId)
              ? old.map((item) =>
                  item.id === threadId &&
                  !item.title &&
                  !item.displayTitle &&
                  !item.name
                    ? { ...item, title: provisionalTitle, cwd: workspaceRoot, ephemeral: created.ephemeral || item.ephemeral }
                    : item,
                )
              : [...old, created],
          );
          setCurrentId(threadId);
          currentIdRef.current = threadId;
          pushThreadNav(threadId);
          if (created.ephemeral) setPendingEphemeral(false);
        }
      }
      if (!threadId) throw new Error("线程尚未就绪");

      const inputItems: Array<Record<string, any>> = [];
      if (text) inputItems.push({ type: "text", text, text_elements: [] });
      for (const [index, file] of sentAttachments.entries()) {
        const saved = savedAttachments[index];
        const path = saved?.path || "";
        inputItems.push(
          file.type.startsWith("image/") && !file.path
            ? { type: "localImage", path }
            : { type: "mention", name: file.name, path },
        );
      }

      if (activeTurn) {
        const clientUserMessageId = crypto.randomUUID();
        if (behavior === "queue") {
          const result = await api.appServer.request("thread/queue/add", {
            threadId,
            input: inputItems,
            clientUserMessageId,
          });
          const queued = result?.queuedSubmission || {
            id: clientUserMessageId,
            input: inputItems,
            clientUserMessageId,
          };
          setQueuedSubmissions((old) =>
            old.some((item) => item.id === queued.id) ? old : [...old, queued],
          );
        } else {
          const steered = {
            role: "user" as const,
            text: text || sentAttachments.map((file) => file.name).join(", "),
            attachments: savedAttachments,
            itemId: clientUserMessageId,
          };
          setMessages((old) => [...old, steered]);
          try {
            await api.appServer.request("turn/steer", {
              threadId,
              expectedTurnId: activeTurn,
              input: inputItems,
              clientUserMessageId,
              additionalContext: turnAdditionalContext(),
            });
          } catch (error) {
            setMessages((old) => old.filter((entry) => entry.itemId !== clientUserMessageId));
            throw error;
          }
        }
        setInput("");
        setAttachments([]);
        return;
      }

      setInput("");
      setAttachments([]);
      setMessages((old) => [
        ...old,
        {
          role: "user",
          text: text || sentAttachments.map((file) => file.name).join(", "),
          attachments: savedAttachments,
        },
        { role: "agent", text: "" },
      ]);
      if (mock) {
        await api.appServer.request("turn/start", { threadId, text });
      } else {
        if (!createdThread)
          await api.appServer.request("thread/resume", {
            threadId,
            excludeTurns: true,
            modelProvider: canonicalModelProvider(model || "deepseek"),
            ...(workspaceRoot
              ? { cwd: workspaceRoot, runtimeWorkspaceRoots: runtimeWorkspaceRoots() }
              : { runtimeWorkspaceRoots: runtimeWorkspaceRoots() }),
          });
        let parsedOutputSchema: Record<string, any> | undefined;
        if (outputSchema.trim()) {
          try {
            parsedOutputSchema = JSON.parse(outputSchema);
          } catch {
            throw new Error("输出 Schema 不是有效 JSON");
          }
        }
        const presetName = mode === "计划" ? "plan" : "default";
        const preset = collaborationModes.find(
          (item) =>
            String(item.mode || item.name || "").toLowerCase() === presetName,
        );
        const collaborationMode =
          mode === "普通"
            ? undefined
            : {
                mode: preset?.mode || presetName,
                settings: {
                  model: preset?.model || model,
                  reasoning_effort: mode === "协作" ? "ultra" : reasoningEffort,
                  developer_instructions:
                    preset?.developer_instructions ?? null,
                },
              };
        await api.appServer.request("turn/start", {
          threadId,
          input: inputItems,
          cwd: workspaceRoot || undefined,
          runtimeWorkspaceRoots: runtimeWorkspaceRoots(),
          model: model || undefined,
          effort: mode === "协作" ? "ultra" : reasoningEffort || undefined,
          collaborationMode,
          outputSchema: parsedOutputSchema,
          additionalContext: turnAdditionalContext(),
        });
      }
    } catch (error) {
      setQueueError(String(error));
      setInput(text);
      setAttachments(sentAttachments);
      setActiveTurn(null);
      activeTurnRef.current = null;
      setMessages((old) =>
        old.map((item, index) =>
          index === old.length - 1 && item.role === "agent" && !item.text
            ? { ...item, text: `请求失败：${String(error)}` }
            : item,
        ),
      );
    }
  }

  const queuedText = (submission: { input: Array<Record<string, any>> }) =>
    submission.input
      .filter((item) => item.type === "text")
      .map((item) => String(item.text || ""))
      .join(" ") || "附件消息";
  async function deleteQueued(submissionId: string) {
    if (!currentId) return;
    try {
      await api.appServer.request("thread/queue/delete", {
        threadId: currentId,
        queuedSubmissionId: submissionId,
      });
      setQueuedSubmissions((old) =>
        old.filter((item) => item.id !== submissionId),
      );
      setQueueError("");
    } catch (error) {
      setQueueError(String(error));
    }
  }
  async function updateQueued(submissionId: string) {
    if (!currentId) return;
    const submission = queuedSubmissions.find(
      (item) => item.id === submissionId,
    );
    if (!submission) return;
    const nextText = await dialog.prompt("编辑待处理消息", queuedText(submission), { multiline: true });
    if (nextText == null || !nextText.trim()) return;
    const input = [
      { type: "text", text: nextText.trim(), text_elements: [] },
      ...submission.input.filter((item) => item.type !== "text"),
    ];
    try {
      await api.appServer.request("thread/queue/update", {
        threadId: currentId,
        queuedSubmissionId: submissionId,
        input,
      });
      setQueuedSubmissions((old) =>
        old.map((item) =>
          item.id === submissionId ? { ...item, input } : item,
        ),
      );
      setQueueError("");
    } catch (error) {
      setQueueError(String(error));
    }
  }
  async function steerQueued(submissionId: string) {
    if (!currentId) return;
    const submission = queuedSubmissions.find(
      (item) => item.id === submissionId,
    );
    if (!submission) return;
    try {
      if (!activeTurn) {
        await api.appServer.request("thread/queue/start", {
          threadId: currentId,
          queuedSubmissionId: submissionId,
        });
        return;
      }
      await api.appServer.request("thread/queue/delete", {
        threadId: currentId,
        queuedSubmissionId: submissionId,
      });
      setQueuedSubmissions((old) =>
        old.filter((item) => item.id !== submissionId),
      );
      const steeredId = submission.clientUserMessageId || submission.id;
      setMessages((old) => [
        ...old,
        {
          role: "user",
          text: queuedText(submission),
          itemId: steeredId,
        },
      ]);
      try {
        await api.appServer.request("turn/steer", {
          threadId: currentId,
          expectedTurnId: activeTurn,
          input: submission.input,
          clientUserMessageId: submission.clientUserMessageId,
          additionalContext: turnAdditionalContext(),
        });
        setQueueError("");
      } catch (error) {
        setMessages((old) => old.filter((entry) => entry.itemId !== steeredId));
        throw error;
      }
    } catch (error) {
      setQueueError(String(error));
    }
  }

  function gitHostInstruction(): string {
    const hosts = [
      gitlabStatus?.available ? `GitLab（${gitlabStatus.projectPath || "当前仓库"}）` : "",
      githubStatus?.available ? `GitHub（${githubStatus.projectPath || "当前仓库"}）` : "",
    ].filter(Boolean);
    if (!hosts.length) return "";
    return [
      `当前工作区已启用 Local Codex 的 ${hosts.join(" 和 ")} 集成。`,
      "查询合并请求或 PR 时直接调用工具 git_status、git_merge_requests、git_merge_request；不要先用 list_mcp_resources 判断是否存在。list_mcp_resources 只列资源，空列表不代表工具不可用。",
      "也可以读取资源 git-host://status、git-host://merge-requests。",
      "禁止用 GitHub/GitLab REST、curl、git log、git show、gh、glab 代替。本地改文件、提交、推送仍用普通 git。",
    ].join("\n");
  }

  function personalizationText(): string {
    const preferences = settingsRef.current;
    const style = String(preferences.response_style || "专业");
    const styleInstruction: Record<string, string> = {
      简洁: "回答应简洁直接，优先给出结果和必要证据。",
      详细: "回答应完整说明实现细节、验证结果和重要限制。",
      教学: "回答应循序解释关键概念和决策依据。",
      专业: "使用专业、清晰、务实的工程沟通风格。",
    };
    return [
      styleInstruction[style],
      String(preferences.custom_instructions || "").trim(),
      gitHostInstruction(),
    ]
      .filter(Boolean)
      .join("\n");
  }

  function turnAdditionalContext() {
    const instructions = personalizationText();
    const gitHost = gitHostInstruction();
    const context: Record<string, { value: string; kind: "application" }> = {};
    if (instructions) context["local-codex-personalization"] = { value: instructions, kind: "application" };
    if (gitHost) context["local-codex-git-host"] = { value: gitHost, kind: "application" };
    return Object.keys(context).length ? context : undefined;
  }

  function sandboxNetworkEnabled(config = settingsConfig) {
    return Boolean(config.sandbox_workspace_write?.network_access);
  }

  const searchMentions = React.useCallback(async (query: string) => {
    const root = workspaceRoot || (await api.diagnostics.read()).cwd;
    if (!root) return [];
    const result = await api.appServer.request("fuzzyFileSearch", {
      query: query || "/",
      roots: [root],
      cancellationToken: null,
    });
    return (result?.files || []).slice(0, 8).map((file: any) => ({
      name: file.file_name || String(file.path || "").split(/[\\/]/).pop() || file.path,
      path: String(file.path || ""),
    })).filter((file: { name: string; path: string }) => file.path);
  }, [workspaceRoot]);

  function addMention(file: { name: string; path: string }) {
    setAttachments((old) => old.some((item) => item.path === file.path) ? old : [...old, {
      name: file.name,
      type: "mention",
      path: file.path,
      data: new ArrayBuffer(0),
    }]);
  }

  function addAttachments(files: FileList | File[] | null) {
    if (!files) return;
    for (const file of Array.from(files))
      void file.arrayBuffer().then((data) =>
        setAttachments((old) => {
          const duplicate = old.some(
            (item) =>
              item.name === file.name &&
              item.type === (file.type || "application/octet-stream") &&
              item.data.byteLength === data.byteLength &&
              buffersEqual(item.data, data),
          );
          if (duplicate) return old;
          return [
            ...old,
            {
              name: file.name,
              type: file.type || "application/octet-stream",
              data,
            },
          ];
        }),
      );
  }

  function buffersEqual(left: ArrayBuffer, right: ArrayBuffer) {
    if (left.byteLength !== right.byteLength) return false;
    const a = new Uint8Array(left);
    const b = new Uint8Array(right);
    for (let index = 0; index < a.length; index += 1) {
      if (a[index] !== b[index]) return false;
    }
    return true;
  }

  function continueAfterArchive(thread: Thread) {
    if (currentIdRef.current !== thread.id) return;
    const project = projectForThread(thread, projects);
    const next = threads
      .filter((item) => {
        if (item.archived || item.id === thread.id) return false;
        const other = projectForThread(item, projects);
        if (thread.projectId === null) return item.projectId === null && !other;
        if (project) return canonicalPath(other?.path || "") === canonicalPath(project.path);
        return canonicalPath(String(item.cwd || "")) === canonicalPath(String(thread.cwd || ""));
      })
      .sort(
        (a, b) =>
          Number(b.recencyAt || b.updatedAt || b.createdAt || 0) -
          Number(a.recencyAt || a.updatedAt || a.createdAt || 0),
      )[0];
    if (next) void selectThread(next.id);
    else startNewThread();
  }

  function startNewThread(ephemeral = false, options?: { fromHistory?: boolean }) {
    if (!options?.fromHistory) void discardEphemeralThreads();
    if (!options?.fromHistory) pushThreadNav(null);
    setPendingEphemeral(Boolean(ephemeral));
    setNavigation("");
    setMessages([]);
    setQueuedSubmissions([]);
    setQueueError("");
    setCurrentId(null);
    currentIdRef.current = null;
    if (!ephemeral) {
      try {
        localStorage.removeItem("local-codex:last-thread-id");
      } catch {
        /* local storage may be unavailable */
      }
    }
    setPanel("");
    setApproval(null);
  }

  async function handleComposerSlash(command: { command: string; arg: string }) {
    const threadId = currentIdRef.current;
    try {
      if (command.command === "new") {
        startNewThread();
        return;
      }
      if (!threadId) {
        await dialog.alert("斜杠命令", "请先打开一个线程");
        return;
      }
      if (command.command === "compact") {
        await api.appServer.request("thread/compact/start", { threadId });
        setMessages(await readThreadMessages(threadId));
        return;
      }
      if (command.command === "archive") {
        const current =
          threads.find((item) => item.id === threadId) || ({ id: threadId } as Thread);
        await api.appServer.request("thread/archive", { threadId });
        setThreads((old) => old.map((item) => item.id === threadId ? { ...item, archived: true } : item));
        continueAfterArchive(current);
        return;
      }
      if (command.command === "rename") {
        if (!command.arg) {
          await dialog.alert("重命名线程", "请输入新标题，例如 /rename 修复登录");
          return;
        }
        await api.appServer.request("thread/name/set", { threadId, name: command.arg });
        setThreads((old) => old.map((item) => item.id === threadId ? { ...item, title: command.arg, name: command.arg } : item));
        return;
      }
      if (command.command === "rollback") {
        const numTurns = Number(command.arg || "1");
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          await dialog.alert("回滚回合", "请输入正整数，例如 /rollback 1");
          return;
        }
        await api.appServer.request("thread/rollback", { threadId, numTurns });
        setMessages(await readThreadMessages(threadId));
        return;
      }
      if (command.command === "goal") {
        if (!command.arg) {
          await api.appServer.request("thread/goal/clear", { threadId });
          return;
        }
        await api.appServer.request("thread/goal/set", {
          threadId,
          objective: command.arg,
          status: "active",
        });
      }
    } catch (error) {
      await dialog.alert("斜杠命令失败", String(error));
    }
  }

  async function pickProjectlessDirectory() {
    const result = await api.workspace.pick();
    if (result.canceled || !result.root) return;
    await saveSetting("projectless_workspace_root", result.root);
  }

  async function chooseNewThreadWorkspace(root: string) {
    try {
      if (!root) {
        const configured = String(
          settingsConfig.projectless_workspace_root ||
            (await api.config.read()).projectlessWorkspaceRoot ||
            "",
        ).trim();
        if (!configured) throw new Error("请先配置无项目任务文件夹");
        const selected = await api.workspace.setRoot(configured);
        setWorkspaceRoot(selected.root);
        setProjectlessWorkspaceActive(true);
        setGitBranch("无 Git");
        setPanel("");
        setQueueError("");
        return;
      }
      const selected = await api.workspace.setRoot(root);
      setWorkspaceRoot(selected.root);
      setProjectlessWorkspaceActive(false);
      const git = await api.git.status();
      const match = git.output.match(/^##\s+(?:No commits yet on )?([^\.\s]+)/);
      setGitBranch(match?.[1] || (git.ok ? "HEAD" : "无 Git"));
      setPanel("");
    } catch (error) {
      setQueueError(String(error));
    }
  }

  async function threadAction(
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
  ) {
    if (action === "rename") {
      const name = await dialog.prompt("重命名线程", titleOf(thread));
      if (!name?.trim()) return;
      await api.appServer.request("thread/name/set", {
        threadId: thread.id,
        name: name.trim(),
      });
    } else if (action === "fork") {
      const forked = await api.appServer.request("thread/fork", { threadId: thread.id });
      const newId = String(forked?.thread?.id || forked?.id || "");
      if (newId) {
        const metadata = await api.codex.inheritThread(thread.id, newId);
        codexThreadMetadataRef.current = {
          assignments: metadata.assignments || {},
          projectless: new Set(metadata.projectless || []),
        };
      }
    } else if (action === "archive") {
      await api.appServer.request("thread/archive", { threadId: thread.id });
      setThreads((old) =>
        old.map((item) =>
          item.id === thread.id ? { ...item, archived: true } : item,
        ),
      );
      continueAfterArchive(thread);
    } else if (action === "revert") {
      const input = await dialog.prompt("回溯回合", "0", {
        message: "输入从 0 开始的回合索引",
      });
      if (input == null) return;
      const toTurnIndex = Number(input);
      if (!Number.isInteger(toTurnIndex) || toTurnIndex < 0) {
        await dialog.alert("无法回溯", "回合索引必须是非负整数");
        return;
      }
      const currentMessages =
        currentId === thread.id
          ? messages
          : await readThreadMessages(thread.id);
      const turnIds = [
        ...new Set(
          currentMessages.map((message) => message.turnId).filter(Boolean),
        ),
      ] as string[];
      const beforeTurnId = turnIds[toTurnIndex];
      if (!beforeTurnId) {
        await dialog.alert("无法回溯", `线程只有 ${turnIds.length} 个可回溯回合`);
        return;
      }
      await api.appServer.request("thread/revert", {
        threadId: thread.id,
        beforeTurnId,
      });
      if (currentId === thread.id)
        setMessages(await readThreadMessages(thread.id));
    } else if (action === "inject") {
      const text = await dialog.prompt("注入上下文", "", { multiline: true, placeholder: "写入要注入的内容" });
      if (!text?.trim()) return;
      await api.appServer.request("thread/inject_items", {
        threadId: thread.id,
        items: [
          {
            role: "user",
            content: [{ type: "input_text", text: text.trim() }],
          },
        ],
      });
      if (currentId === thread.id)
        setMessages(await readThreadMessages(thread.id));
    } else if (action === "section") {
      const name = await dialog.prompt("移动到分区", "", {
        message: `已有：${sections.map((section) => section.name).join("、") || "无"}`,
        placeholder: "分区名称",
      });
      if (!name?.trim()) return;
      let section = sections.find((item) => item.name === name.trim());
      if (!section) {
        const created = await api.appServer.request("threadSection/create", {
          name: name.trim(),
        });
        section = created?.section;
        if (section) setSections((old) => [...old, section!]);
      }
      if (!section) throw new Error("分区创建失败");
      await api.appServer.request("thread/section/move", {
        threadId: thread.id,
        sectionId: section.id,
      });
    } else if (action === "export") {
      const result = await api.appServer.request("thread/read", {
        threadId: thread.id,
      });
      const turns = await readThreadMessages(thread.id);
      await api.export.save(
        JSON.stringify({ thread: result?.thread || result, turns }, null, 2),
        `${titleOf(thread)}.json`,
      );
    } else if (action === "delete") {
      if (!(await dialog.confirm("删除线程", `删除线程“${titleOf(thread)}”？`))) return;
      await api.appServer.request("thread/delete", { threadId: thread.id });
      try {
        const metadata = await api.codex.forgetThread(thread.id);
        codexThreadMetadataRef.current = {
          assignments: metadata.assignments || {},
          projectless: new Set(metadata.projectless || []),
        };
      } catch {
        /* assignment cleanup is best effort */
      }
      if (currentId === thread.id) {
        setCurrentId(null);
        try {
          localStorage.removeItem("local-codex:last-thread-id");
        } catch {
          /* best effort */
        }
        setMessages([]);
      }
    }
    setThreads(await listAllThreads(search));
  }

  async function loadPanel(tab: string, focusFilePath = "", focusDiff = "") {
    setPanel(tab);
    if (tab === "review") {
      setReviewTabOpen(true);
      setReviewFilePath(focusFilePath);
    }
    try {
      const method: Record<string, string> = {
        skills: "skills/list",
        mcp: "mcpServerStatus/list",
        permissions: "permissionProfile/list",
        models: "model/list",
        timeline: "thread/timeline/list",
        queue: "thread/queue/list",
        collab: "collaborationMode/list",
        plans: "thread/timeline/list",
        diagnostics: "diagnostics/read",
      };
      if (tab === "settings") {
        const { result } = await reloadSettingsConfig();
        const secret = await api.secrets.read("DEEPSEEK_API_KEY");
        setPanelRows([
          ...Object.entries(result?.config || {}).map(([name, value]) => ({
            name,
            sub: String(value),
          })),
          {
            name: "DEEPSEEK_API_KEY",
            sub: secret.configured ? "已配置（安全存储）" : "未配置",
          },
        ]);
        return;
      }
      if (tab === "mcp") {
        const result = await api.appServer.request("mcpServerStatus/list", {
          detail: "full",
          threadId: null,
        });
        const servers = listData<any>(result).filter(
          (server) => !/openai|chatgpt/i.test(String(server.name || "")),
        );
        setMcpServers(servers);
        setPanelRows(
          servers.map((item) => ({
            name: item.name || "MCP 服务",
            sub: `${item.runtimeStatus || "notStarted"} · ${Object.keys(item.tools || {}).length} 个工具 · ${(item.resources || []).length} 个资源`,
          })),
        );
        return;
      }
      const rpc = method[tab];
      if (tab === "review") {
        if (focusDiff.trim()) {
          const filePath = String(focusFilePath || "未命名文件").replaceAll(
            "\\",
            "/",
          );
          const source = /(^|\r?\n)diff --git /.test(focusDiff)
            ? focusDiff
            : `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n${focusDiff}`;
          setReviewDiff(source);
          setPanelRows([
            { name: "文件变更", sub: `${filePath} · 可审查区块、评论或撤销` },
          ]);
          return;
        }
        if (currentId) {
          try {
            await api.appServer.request("review/start", {
              threadId: currentId,
              target: { type: "uncommittedChanges" },
            });
          } catch {
            /* review RPC is optional */
          }
        }
        await refreshReview();
        return;
      }
      if (tab === "memory") {
        setPanelRows([
          { name: "线程记忆", sub: "enabled / disabled" },
          { name: "清除记忆", sub: "memory/reset" },
        ]);
        return;
      }
      if (tab === "skills") {
        const plugins = await api.codex.plugins();
        const skillEntries = listData<any>(
          await api.appServer.request("skills/list", {}),
        );
        const skills = skillEntries.flatMap((entry) =>
          Array.isArray(entry.skills) ? entry.skills : [entry],
        );
        setPanelRows([
          ...plugins.map((plugin) => ({
            name: plugin.name,
            sub: `${plugin.source} · ${plugin.enabled ? "已启用" : "已禁用"}`,
          })),
          ...skills.map((skill) => ({
            name: skill.name || "本地技能",
            sub: skill.description || "",
          })),
        ]);
        return;
      }
      if (tab === "plans") {
        setPanelRows(
          planSteps.length
            ? planSteps.map((item) => ({ name: item.step, sub: item.status }))
            : [{ name: "暂无计划", sub: "在回合中启用计划模式后会显示步骤" }],
        );
        return;
      }
      if (tab === "files") {
        setFilePreview(null);
        const tree = await api.workspace.tree({
          root: (await api.diagnostics.read()).cwd,
          depth: 2,
        });
        const rows: Array<{ name: string; sub?: string; path?: string }> = [];
        const flatten = (entries: any[], prefix = "", parentPath = tree.root) =>
          entries.forEach((entry) => {
            const entryPath = `${parentPath}\\${entry.name}`;
            rows.push({
              name: `${prefix}${entry.type === "directory" ? "folder" : "file"} ${entry.name}`,
              sub: entry.type,
              path: entry.type === "file" ? entryPath : undefined,
            });
            if (entry.children)
              flatten(entry.children, `${prefix}  `, entryPath);
          });
        flatten(tree.entries);
        setPanelRows(rows);
        return;
      }
      if (tab === "git") {
        setPanelRows([]);
        return;
      }
      if (tab === "diagnostics") {
        const diagnostics = await api.diagnostics.read();
        setPanelRows(
          Object.entries(diagnostics).map(([name, value]) => ({
            name,
            sub:
              typeof value === "object" ? JSON.stringify(value) : String(value),
          })),
        );
        return;
      }
      if (!rpc) {
        setPanelRows([
          { name: tab, sub: "该能力由 app-server 或本地插件提供" },
        ]);
        return;
      }
      const result = await api.appServer.request(
        rpc,
        currentId ? { threadId: currentId } : {},
      );
      setPanelRows(
        listData<any>(result).map((item) => {
          if (typeof item === "string") return { name: item };
          if (tab === "mcp") {
            const toolCount =
              item.tools && typeof item.tools === "object"
                ? Object.keys(item.tools).length
                : 0;
            const resourceCount = Array.isArray(item.resources)
              ? item.resources.length
              : 0;
            const state = item.runtimeStatus || item.status || "未启动";
            return {
              name: item.name || item.id || "MCP 服务",
              sub: `${state} · ${toolCount} 个工具 · ${resourceCount} 个资源`,
            };
          }
          if (tab === "permissions")
            return {
              name: item.id || item.name || "权限 Profile",
              sub: `${item.allowed === false ? "不可用" : "可用"}${item.description ? ` · ${item.description}` : ""}`,
            };
          if (tab === "collab")
            return {
              name: item.name || item.id || item.mode || "协作模式",
              sub: [item.mode, item.reasoning_effort, item.description]
                .filter(Boolean)
                .join(" · "),
            };
          return {
            name:
              item.displayName ||
              item.display_name ||
              item.name ||
              item.id ||
              item.model ||
              item.tag ||
              "条目",
            sub: item.description || item.runtimeStatus || item.preview || "",
          };
        }),
      );
    } catch (error) {
      setPanelRows([{ name: "加载失败", sub: String(error) }]);
    }
  }

  async function updatePlan(next: Array<{ step: string; status: string }>) {
    setPlanSteps(next);
    setPanelRows(
      next.length
        ? next.map((item) => ({ name: item.step, sub: item.status }))
        : [{ name: "暂无计划", sub: "添加一个计划步骤" }],
    );
    try {
      localStorage.setItem(
        `local-codex:plan:${currentId || "draft"}`,
        JSON.stringify(next),
      );
    } catch {
      /* local draft remains in component state */
    }
  }

  async function changeModel(nextModel: string) {
    setModel(nextModel);
    if (!currentId) return;
    try {
      await api.appServer.request("thread/settings/update", {
        threadId: currentId,
        model: nextModel,
      });
    } catch {
      /* selection still applies to the next turn request */
    }
  }

  async function changeMode(nextMode: string) {
    setMode(nextMode);
    if (!currentId) return;
    if (nextMode === "普通") {
      try {
        await api.appServer.request("thread/settings/update", {
          threadId: currentId,
          collaborationMode: null,
          effort: reasoningEffort || null,
        });
      } catch {
        /* next turn carries the selected effort */
      }
      return;
    }
    const presetName = nextMode === "计划" ? "plan" : "default";
    const preset = collaborationModes.find(
      (item) =>
        String(item.mode || item.name || "").toLowerCase() === presetName,
    );
    const collaborationMode = {
      mode: preset?.mode || presetName,
      settings: {
        model: preset?.model || model,
        reasoning_effort: nextMode === "协作" ? "ultra" : reasoningEffort,
        developer_instructions: preset?.developer_instructions ?? null,
      },
    };
    try {
      await api.appServer.request("thread/settings/update", {
        threadId: currentId,
        effort: nextMode === "协作" ? "ultra" : reasoningEffort || undefined,
        collaborationMode,
      });
    } catch {
      /* next turn carries the same overrides */
    }
  }

  async function changeReasoningEffort(nextEffort: string) {
    setReasoningEffort(nextEffort);
    if (!currentId) return;
    try {
      await api.appServer.request("thread/settings/update", {
        threadId: currentId,
        effort: mode === "协作" ? "ultra" : nextEffort,
      });
    } catch {
      /* selection still applies to the next turn request */
    }
  }

  async function gitCommit(message: string) {
    setGitBusy(true);
    const result = await api.git.commit(
      message,
      Boolean(settingsRef.current.git_sign_commits),
    );
    setGitBusy(false);
    setGitActionStatus(result.ok ? "提交成功" : result.output);
    setPanelRows([
      { name: result.ok ? "提交成功" : "提交失败", sub: result.output },
    ]);
    if (result.ok) await loadPanel("git");
    return result.ok;
  }

  async function gitPush() {
    setGitBusy(true);
    const result = await api.git.push();
    setGitBusy(false);
    setGitActionStatus(result.ok ? `已推送 ${result.branch || ""}` : result.output);
    setPanelRows([
      {
        name: result.ok ? "推送成功" : "推送失败",
        sub: result.output || result.branch || "",
      },
    ]);
  }

  async function gitCreateBranch(name: string) {
    setGitBusy(true);
    const result = await api.git.createBranch(name.trim(), true);
    setGitBusy(false);
    setGitActionStatus(result.ok ? `已检出 ${result.branch}` : result.output);
    if (result.ok) setGitBranch(result.branch || name.trim());
    return result.ok;
  }

  async function persistThreadAssignment(
    threadId: string,
    project: CodexProject | null,
    syncWorkspace = true,
  ) {
    const metadata = await api.codex.assignThread(
      threadId,
      project ? { projectId: project.id, projectPath: project.path } : null,
    );
    codexThreadMetadataRef.current = {
      assignments: metadata.assignments || {},
      projectless: new Set(metadata.projectless || []),
    };
    setThreads((old) =>
      old.map((thread) =>
        thread.id === threadId
          ? { ...thread, projectId: project?.id ?? null, cwd: project?.path || thread.cwd }
          : thread,
      ),
    );
    if (syncWorkspace && project?.path) await chooseNewThreadWorkspace(project.path);
  }

  async function applyThreadAssignment(threadId: string, project: CodexProject | null) {
    await persistThreadAssignment(threadId, project, true);
  }

  async function openCloneWorkspace(root: string) {
    await chooseNewThreadWorkspace(root);
  }

  async function assignCloneToProject(project: CodexProject, root: string) {
    await chooseNewThreadWorkspace(root);
    const threadId = currentIdRef.current;
    if (threadId && project.id) await applyThreadAssignment(threadId, { ...project, path: root });
  }

  async function refreshReview() {
    const result = await api.git.diff();
    if (!result.ok) {
      const message = result.output || "git 命令失败";
      setReviewDiff("");
      setReviewError(message);
      setPanelRows([{ name: "无法读取 Git 差异", sub: message }]);
      return;
    }
    setReviewError("");
    setReviewDiff(result.output || "");
    setPanelRows(
      result.output
        ? [{ name: "未提交变更", sub: "可按文件审查、评论或撤销" }]
        : [{ name: "没有未提交变更", sub: "工作区干净" }],
    );
  }

  async function restoreReviewFile(filePath: string) {
    const result = await api.git.restoreFile(filePath);
    setPanelRows([
      {
        name: result.ok ? "已撤销文件修改" : "撤销失败",
        sub: result.output || filePath,
      },
    ]);
    if (result.ok) await refreshReview();
  }

  async function rejectReviewHunk(patch: string) {
    const result = await api.git.rejectHunk(patch);
    if (!result.ok) throw new Error(result.output || "区块拒绝失败");
    await refreshReview();
  }

  async function saveProvider(
    provider: string,
    baseUrl: string,
    nextModel: string,
  ) {
    try {
      new URL(baseUrl);
      const resolved = canonicalModelProvider(provider);
      const envKey =
        providerConfig.provider === resolved && providerConfig.envKey
          ? providerConfig.envKey
          : `${resolved.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
      await api.preferences.write("model_provider", resolved);
      await api.appServer.request("config/batchWrite", {
        edits: [
          {
            keyPath: "model_provider",
            value: resolved,
            mergeStrategy: "replace",
          },
          {
            keyPath: `model_providers.${resolved}.name`,
            value: resolved,
            mergeStrategy: "replace",
          },
          {
            keyPath: `model_providers.${resolved}.base_url`,
            value: baseUrl,
            mergeStrategy: "replace",
          },
          {
            keyPath: `model_providers.${resolved}.env_key`,
            value: envKey,
            mergeStrategy: "replace",
          },
          {
            keyPath: `model_providers.${resolved}.wire_api`,
            value: "responses",
            mergeStrategy: "replace",
          },
          {
            keyPath: `model_providers.${resolved}.requires_openai_auth`,
            value: false,
            mergeStrategy: "replace",
          },
          {
            keyPath: "preferred_auth_method",
            value: "apikey",
            mergeStrategy: "replace",
          },
          { keyPath: "model", value: nextModel, mergeStrategy: "replace" },
        ],
        reloadUserConfig: true,
      });
      setModel(nextModel);
      setProviderConfig((old) => ({
        ...old,
        provider: resolved,
        baseUrl,
        model: nextModel,
        envKey,
        providers: old.providers.includes(resolved)
          ? old.providers
          : [...old.providers, resolved],
      }));
      await api.appServer.restart();
      setPanelRows([
        { name: "Provider 已保存并生效", sub: `${resolved} · ${nextModel}` },
      ]);
    } catch (error) {
      setPanelRows([{ name: "Provider 保存失败", sub: String(error) }]);
    }
  }

  async function saveProviderKey(
    provider: string,
    envKey: string,
    value: string,
  ) {
    if (!provider || !envKey || !value)
      throw new Error("Provider、env_key 和密钥不能为空");
    await api.secrets.write(envKey, value);
    const resolved = canonicalModelProvider(provider);
    await api.appServer.request("config/value/write", {
      keyPath: `model_providers.${resolved}.env_key`,
      value: envKey,
      mergeStrategy: "replace",
    });
    setProviderConfig((old) => ({ ...old, envKey }));
    await api.appServer.restart();
  }

  async function runCommand(command: string) {
    setPanel("terminal");
    setPanelRows([{ name: command, sub: "执行中…" }]);
    try {
      const processId = `local-codex-${Date.now()}`;
      setTerminalProcessId(processId);
      const result = await api.appServer.request("command/exec", {
        processId,
        command: command.trim().split(/\s+/),
        cwd: (await api.diagnostics.read()).cwd,
        streamStdoutStderr: true,
        timeoutMs: 120000,
      });
      setTerminalProcessId(null);
      setPanelRows([
        {
          name: command,
          sub:
            result?.output ||
            result?.aggregatedOutput ||
            JSON.stringify(result),
        },
      ]);
    } catch (error) {
      setTerminalProcessId(null);
      setPanelRows([{ name: "执行失败", sub: String(error) }]);
    }
  }

  async function saveSetting(key: string, value: any) {
    if (key.endsWith("base_url") && typeof value === "string") {
      try {
        new URL(value);
      } catch {
        setPanelRows((old) => [
          ...old,
          { name: "配置错误", sub: "base_url 必须是有效 URL" },
        ]);
        return;
      }
    }
    try {
      if (key === "model_provider") value = canonicalModelProvider(String(value || ""));
      await api.preferences.write(key, value);
      if (isCodexConfigKey(key)) {
        try {
          await api.appServer.request("config/value/write", {
            keyPath: key,
            value,
            mergeStrategy: "replace",
          });
        } catch {
          /* local toml/preferences already hold the value */
        }
        if (key.startsWith("mcp_servers."))
          await api.appServer.request("config/mcpServer/reload", {}).catch(() => undefined);
      }
      setSettingsConfig((old) =>
        isCodexConfigKey(key) ? setConfigPath(old, key, value) : { ...old, [key]: value },
      );
      setPanelRows((old) => [
        ...old.filter((row) => row.name !== "配置错误"),
        { name: "已保存", sub: key },
      ]);
    } catch (error) {
      setPanelRows((old) => [...old, { name: "保存失败", sub: String(error) }]);
    }
  }

  async function savePermissionProfile(profile: string) {
    try {
      await api.appServer.request("config/value/write", {
        keyPath: "permission_profile",
        value: profile,
        mergeStrategy: "replace",
      });
      setPanelRows((old) => [
        ...old,
        { name: "权限 Profile 已切换", sub: profile },
      ]);
    } catch (error) {
      setPanelRows((old) => [
        ...old,
        { name: "权限 Profile 切换失败", sub: String(error) },
      ]);
    }
  }

  async function terminateCommand() {
    if (!terminalProcessId) return;
    try {
      await api.appServer.request("command/exec/terminate", {
        processId: terminalProcessId,
      });
    } catch {
      /* process may already be gone */
    }
    setTerminalProcessId(null);
  }

  async function openFile(filePath: string, source?: "tree") {
    if (/\.(?:png|jpe?g|gif|webp|bmp|svg|ico)$/i.test(filePath)) {
      const name = filePath.split(/[\\/]/).pop() || "图片";
      setFilePreviewError("");
      await openImage({ path: filePath, name }, source);
      return;
    }
    try {
      const file = await api.workspace.readFile(filePath);
      if (source !== "tree") requestTreeReveal(file.path);
      setSidePanelOpen(false);
      setPanel("files");
      setImagePreview(null);
      setFilePreview(file);
      setFilePreviewError("");
      setWorkbenchTab("document");
    } catch (error) {
      setFilePreview(null);
      setFilePreviewError(String(error));
      setPanel("files");
      setPanelRows([{ name: "文件读取失败", sub: String(error) }]);
    }
  }

  function openLatestConversationChanges() {
    setSidePanelOpen(false);
    const latest = latestConversationChanges(messages, workspaceRoot);
    setReviewDiff(latest.diff);
    setReviewFilePath(latest.focusPath);
    setReviewTabOpen(true);
    setPanel("review");
  }

  const openImage = useCallback(
    async (image: { path: string; name: string; dataUrl?: string }, source?: "tree") => {
      if (source !== "tree") requestTreeReveal(image.path);
      setSidePanelOpen(false);
      setPanel("image");
      setFilePreview(null);
      setWorkbenchTab("document");
      setImagePreview({
        path: image.path,
        name: image.name,
        dataUrl: image.dataUrl || "",
      });
      if (image.dataUrl) return;
      try {
        const loaded = await api.attachments.readImage(image.path);
        setImagePreview((current) =>
          current?.path === image.path
            ? { ...current, dataUrl: loaded.dataUrl, error: undefined }
            : current,
        );
      } catch (error) {
        setImagePreview((current) =>
          current?.path === image.path
            ? { ...current, error: String(error) }
            : current,
        );
      }
    },
    [requestTreeReveal],
  );

  function selectPanelTab(tab: string) {
    if (!tab) {
      setPanel("");
      return;
    }
    if (tab === "review" && reviewTabOpen) {
      setPanel("review");
      return;
    }
    if (tab === "files" && filePreview) {
      setPanel("files");
      return;
    }
    if (tab === "image" && imagePreview) {
      setPanel("image");
      return;
    }
    if (tab === "sources" && sourcesTabOpen) {
      setPanel("sources");
      return;
    }
    if (tab === "browser" && browserTabOpen) {
      setPanel("browser");
      return;
    }
    void loadPanel(tab);
  }

  function closeReviewTab() {
    setReviewTabOpen(false);
    if (panel !== "review") return;
    if (imagePreview) setPanel("image");
    else if (filePreview) setPanel("files");
    else if (sourcesTabOpen) setPanel("sources");
    else if (browserTabOpen) setPanel("browser");
    else {
      setPanel("");
      setSidePanelOpen(false);
    }
  }

  function closeDocumentTab() {
    setFilePreview(null);
    setFilePreviewError("");
    setImagePreview(null);
    if (editorMaximized) {
      setEditorMaximized(false);
      setWorkbenchTab("conversation");
    }
    if (panel !== "files" && panel !== "image") return;
    if (reviewTabOpen) setPanel("review");
    else if (sourcesTabOpen) setPanel("sources");
    else if (browserTabOpen) setPanel("browser");
    else {
      setPanel("");
      setSidePanelOpen(false);
    }
  }

  function openSources() {
    setSidePanelOpen(false);
    setSourcesTabOpen(true);
    setPanel("sources");
  }

  function closeSources() {
    setSourcesTabOpen(false);
    if (panel === "sources") {
      if (reviewTabOpen) setPanel("review");
      else if (imagePreview) setPanel("image");
      else if (filePreview) setPanel("files");
      else if (browserTabOpen) setPanel("browser");
      else {
        setPanel("");
        setSidePanelOpen(false);
      }
    }
  }

  function closeBrowserTab() {
    setBrowserTabOpen(false);
    if (panel !== "browser") return;
    if (reviewTabOpen) setPanel("review");
    else if (imagePreview) setPanel("image");
    else if (filePreview) setPanel("files");
    else if (sourcesTabOpen) setPanel("sources");
    else {
      setPanel("");
      setSidePanelOpen(false);
    }
  }

  async function saveFile(filePath: string, content: string) {
    try {
      const saved = await api.workspace.writeFile(filePath, content);
      setFilePreview(saved);
      setPanelRows((old) => [
        ...old.filter((row) => row.name !== "文件已保存"),
        { name: "文件已保存", sub: saved.path },
      ]);
    } catch (error) {
      setPanelRows((old) => [
        ...old,
        { name: "文件保存失败", sub: String(error) },
      ]);
      throw error;
    }
  }

  async function searchFiles(query: string) {
    if (!query) {
      await loadPanel("files");
      return;
    }
    try {
      const diagnostics = await api.diagnostics.read();
      const result = await api.appServer.request("fuzzyFileSearch", {
        query,
        roots: [diagnostics.cwd],
        cancellationToken: null,
      });
      setFilePreview(null);
      setPanelRows(
        (result?.files || []).map((file: any) => ({
          name: file.file_name || file.path,
          sub: `${file.match_type || "匹配"} · ${Number(file.score || 0).toFixed(2)}`,
          path: file.path,
        })),
      );
    } catch (error) {
      setPanelRows([{ name: "文件搜索失败", sub: String(error) }]);
    }
  }

  async function reloadMcp() {
    await api.appServer.request("config/mcpServer/reload", {});
    await loadPanel("mcp");
  }

  async function callMcpTool(server: string, tool: string, args: any) {
    if (!currentId) throw new Error("请先打开一个线程");
    if (/openai|chatgpt/i.test(server))
      throw new Error("按本地模式策略禁止调用 OpenAI 托管 MCP");
    return api.appServer.request("mcpServer/tool/call", {
      threadId: currentId,
      server,
      tool,
      arguments: args,
    });
  }

  async function readMcpResource(server: string, uri: string) {
    if (/openai|chatgpt/i.test(server))
      throw new Error("按本地模式策略禁止读取 OpenAI 托管 MCP");
    return api.appServer.request("mcpServer/resource/read", {
      threadId: currentId || null,
      server,
      uri,
    });
  }

  async function setMemoryMode(nextMode: "enabled" | "disabled") {
    if (!currentId) throw new Error("请先打开一个线程");
    await api.appServer.request("thread/memoryMode/set", {
      threadId: currentId,
      mode: nextMode,
    });
  }

  async function resetMemory() {
    await api.appServer.request("memory/reset");
  }

  async function openArchivedThread(threadId: string) {
    const archived = archivedThreads.find((thread) => thread.id === threadId);
    setSettingsView(false);
    if (archived)
      setThreads((old) =>
        old.some((thread) => thread.id === threadId) ? old : [...old, archived],
      );
    await selectThread(threadId);
  }

  async function unarchiveThread(thread: Thread) {
    await api.appServer.request("thread/unarchive", { threadId: thread.id });
    setArchivedThreads((old) => old.filter((item) => item.id !== thread.id));
    setThreads(await listAllThreads(search));
  }

  async function deleteArchivedThread(thread: Thread) {
    await api.appServer.request("thread/delete", { threadId: thread.id });
    setArchivedThreads((old) => old.filter((item) => item.id !== thread.id));
    if (currentId === thread.id) {
      setCurrentId(null);
      currentIdRef.current = null;
      setMessages([]);
      try {
        localStorage.removeItem("local-codex:last-thread-id");
      } catch {
        /* best effort */
      }
    }
  }

  async function deleteAllArchivedThreads(items: Thread[]) {
    for (const thread of items)
      await api.appServer.request("thread/delete", { threadId: thread.id });
    setArchivedThreads([]);
    if (items.some((thread) => thread.id === currentId)) {
      setCurrentId(null);
      currentIdRef.current = null;
      setMessages([]);
      try {
        localStorage.removeItem("local-codex:last-thread-id");
      } catch {
        /* best effort */
      }
    }
  }

  async function reloadSettingsConfig() {
    const result = await api.appServer.request("config/read", {});
    const [preferences, localConfig] = await Promise.all([
      api.preferences.read().catch(() => ({})),
      api.config.read().catch(() => ({})),
    ]);
    const config = mergeSettingsLayers(
      result,
      preferences || {},
      (localConfig || {}) as Record<string, any>,
    );
    const selected = canonicalModelProvider(
      String(config.model_provider || "deepseek"),
    );
    const selectedConfig = config.model_providers?.[selected] || {};
    setSettingsConfig(config);
    setProviderConfig(providerStateFromConfig(config));
    try {
      const capabilities = await api.appServer.request(
        "modelProvider/capabilities/read",
        {},
      );
      setProviderCapabilities({
        responses: selectedConfig.wire_api === "responses",
        tools: capabilities.namespaceTools ?? capabilities.tools,
        images: capabilities.imageGeneration ?? capabilities.images,
      });
    } catch {
      setProviderCapabilities({
        responses: selectedConfig.wire_api === "responses",
      });
    }
    return { config, result };
  }

  async function openSettingsView(section = "general") {
    setSettingsSection(section || "general");
    setHelpView("");
    setSettingsView(true);
    void refreshArchivedThreads().catch((error) =>
      setQueueError(String(error)),
    );
    try {
      await reloadSettingsConfig();
    } catch {
      /* the settings page can still show local defaults while reconnecting */
    }
    setPanel("");
  }

  async function openWorkspace() {
    const result = await api.workspace.open();
    if (result.canceled) return;
    setWorkspaceRoot(result.root);
    void api.codex.projects().then((configured) => {
      setProjects(configured.filter((project) => project.path));
    });
    void api.git.status().then((status) => {
      const match = status.output.match(
        /^##\s+(?:No commits yet on )?([^\.\s]+)/,
      );
      setGitBranch(match?.[1] || (status.ok ? "HEAD" : "无 Git"));
    });
    setFilePreview(null);
    setPanel("files");
    const tree = await api.workspace.tree({ root: result.root, depth: 2 });
    const rows: Array<{ name: string; sub?: string; path?: string }> = [];
    const flatten = (entries: any[], prefix = "", parentPath = tree.root) =>
      entries.forEach((entry) => {
        const entryPath = `${parentPath}\\${entry.name}`;
        rows.push({
          name: `${prefix}${entry.type === "directory" ? "folder" : "file"} ${entry.name}`,
          sub: entry.type,
          path: entry.type === "file" ? entryPath : undefined,
        });
        if (entry.children) flatten(entry.children, `${prefix}  `, entryPath);
      });
    flatten(tree.entries);
    setPanelRows(rows);
  }

  function openWorkspaceFileTree() {
    setSidePanelOpen(false);
    if (workspaceRoot) {
      setPanel("files");
      return;
    }
    void openWorkspace();
  }

  async function editProject(projectPath: string) {
    const project = projects.find(
      (item) => canonicalPath(item.path) === canonicalPath(projectPath),
    );
    if (project) setEditingProject(project);
  }

  async function quickNewProjectThread(projectPath: string) {
    startNewThread();
    await chooseNewThreadWorkspace(projectPath);
  }

  async function openProjectRoot(projectPath: string) {
    try {
      await api.workspace.setRoot(projectPath);
      await api.workspace.openRoot();
    } catch (error) {
      setQueueError(String(error));
    }
  }

  async function openWorkspaceInVscode(root = workspaceRoot) {
    if (!root) {
      setQueueError("请先打开工作区");
      return;
    }
    try {
      const result = await api.workspace.openInEditor(root, "VS Code");
      if (!result.ok) setQueueError(result.output || "无法用 VS Code 打开工作区");
    } catch (error) {
      setQueueError(String(error));
    }
  }

  async function createProjectWorktree(projectPath: string) {
    const branch = await dialog.prompt("新建工作树", "", { placeholder: "永久工作树分支名" });
    if (!branch?.trim()) return;
    try {
      await api.workspace.setRoot(projectPath);
      const result = await api.git.createWorktree(branch.trim());
      setQueueError(
        result.ok
          ? `已创建永久工作树：${result.path || branch.trim()}`
          : result.output,
      );
    } catch (error) {
      setQueueError(String(error));
    }
  }

  async function removeProject(projectPath: string) {
    if (!(await dialog.confirm("移除项目", "确认移除该项目？这不会删除磁盘上的文件。"))) return;
    try {
      await api.codex.deleteProject(projectPath);
      setProjects((old) =>
        old.filter(
          (item) => canonicalPath(item.path) !== canonicalPath(projectPath),
        ),
      );
      if (canonicalPath(workspaceRoot) === canonicalPath(projectPath)) {
        await api.workspace.clearRoot();
        setWorkspaceRoot("");
        setGitBranch("无 Git");
      }
    } catch (error) {
      setQueueError(String(error));
    }
  }

  async function saveEditedProject(project: CodexProject) {
    setProjects((old) =>
      old.map((item) =>
        canonicalPath(item.path) === canonicalPath(editingProject?.path || "")
          ? project
          : item,
      ),
    );
    const nextRoots = [project.path, ...(project.rootPaths || [])].map((root) => canonicalPath(root));
    const previousRoots = editingProject
      ? [editingProject.path, ...(editingProject.rootPaths || [])].map((root) => canonicalPath(root))
      : [];
    if (previousRoots.includes(canonicalPath(workspaceRoot)) && !nextRoots.includes(canonicalPath(workspaceRoot))) {
      const selected = await api.workspace.setRoot(project.path);
      setWorkspaceRoot(selected.root);
      const git = await api.git.status();
      const match = git.output.match(/^##\s+(?:No commits yet on )?([^\.\s]+)/);
      setGitBranch(match?.[1] || (git.ok ? "HEAD" : "无 Git"));
    }
    setEditingProject(null);
  }

  async function deleteEditedProject(projectPath: string) {
    setProjects((old) =>
      old.filter(
        (item) => canonicalPath(item.path) !== canonicalPath(projectPath),
      ),
    );
    if (canonicalPath(workspaceRoot) === canonicalPath(projectPath)) {
      await api.workspace.clearRoot();
      setWorkspaceRoot("");
      setGitBranch("无 Git");
    }
    setEditingProject(null);
  }

  async function importThread() {
    const opened = await api.import.open();
    if (opened.canceled || !opened.content) return "已取消导入";
    let title =
      opened.path
        ?.split(/[\\/]/)
        .pop()
        ?.replace(/\.(json|txt|md)$/i, "") || "导入的线程";
    let importedMessages: Array<{ role: string; text: string }> = [];
    try {
      const parsed = JSON.parse(opened.content);
      title = parsed?.thread ? titleOf(parsed.thread) : title;
      const source = Array.isArray(parsed?.turns)
        ? parsed.turns
        : Array.isArray(parsed?.messages)
          ? parsed.messages
          : [];
      importedMessages = source
        .filter(
          (item: any) =>
            (item.role === "user" || item.role === "agent") && item.text,
        )
        .map((item: any) => ({ role: item.role, text: String(item.text) }));
    } catch {
      importedMessages = [{ role: "user", text: opened.content }];
    }
    if (importedMessages.length === 0)
      throw new Error("导入文件中没有可恢复的消息");
    const started = await api.appServer.request(
      "thread/start",
      workspaceRoot
        ? {
            cwd: workspaceRoot,
            runtimeWorkspaceRoots: [workspaceRoot],
            modelProvider: canonicalModelProvider(model || "deepseek"),
          }
        : { modelProvider: canonicalModelProvider(model || "deepseek") },
    );
    const threadId = started?.thread?.id;
    if (!threadId) throw new Error("新线程创建失败");
    const items = importedMessages.map((message) =>
      message.role === "user"
        ? {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: message.text }],
          }
        : {
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: message.text }],
          },
    );
    await api.appServer.request("thread/inject_items", { threadId, items });
    await api.appServer.request("thread/name/set", { threadId, name: title });
    setThreads(await listAllThreads());
    setSettingsView(false);
    await selectThread(threadId);
    return `已导入 ${importedMessages.length} 条消息`;
  }

  async function exportCurrentThread() {
    if (!currentId || !current) throw new Error("请先打开一个线程");
    const result = await api.appServer.request("thread/read", {
      threadId: currentId,
    });
    const turns = await readThreadMessages(currentId);
    const saved = await api.export.save(
      JSON.stringify(
        {
          format: "local-codex-thread",
          version: 1,
          thread: result?.thread || result,
          turns,
        },
        null,
        2,
      ),
      `${titleOf(current)}.json`,
    );
    return saved.canceled ? "已取消导出" : `已导出到 ${saved.path}`;
  }

  useEffect(() => {
    if (mock && panel && panel !== "environment") void loadPanel(panel);
  }, [mock, panel]);

  function toggleTopPanel() {
    setTopPanelOpen((open) => !open);
  }
  function toggleBottomPanel() {
    setBottomPanelOpen((open) => !open);
  }
  function toggleSidePanel() {
    setBottomPanelOpen(false);
    const sideContentActive = [
      "review",
      "files",
      "image",
      "sources",
      "browser",
    ].includes(panel);
    if (sidePanelOpen || sideContentActive) {
      setPanel("");
      setSidePanelOpen(false);
      return;
    }
    setPanel("");
    setSidePanelOpen(true);
  }

  async function showAbout() {
    try {
      const info = await api.app.info();
      await dialog.alert(info.name || "Local Codex", info.version);
    } catch {
      await dialog.alert("Local Codex");
    }
  }

  async function promptFoundUpdate(
    result: {
      current: string;
      latest: string;
      newer: boolean;
      url: string;
      notes: string;
    },
    fromBackground = false,
  ) {
    if (!result.newer) {
      if (fromBackground) return;
      await dialog.alert(
        "检查更新",
        result.latest
          ? `当前版本 ${result.current} 已是最新。`
          : `当前版本 ${result.current}。未配置更新源，也没有从 git 标签读到更新。可在设置里填写 update feed URL。`,
      );
      return;
    }
    if (fromBackground && dismissedUpdateRef.current === result.latest) return;
    const open = await dialog.confirm(
      "发现更新",
      `发现新版本 ${result.latest}（当前 ${result.current}）。${result.notes ? `\n${result.notes}` : ""}${result.url ? "\n\n打开下载页？" : ""}`,
    );
    if (!open) {
      dismissedUpdateRef.current = result.latest;
      return;
    }
    if (result.url) void api.app.openExternalUrl(result.url);
  }

  function runWindowMenuAction(action: string) {
    const editCommands: Record<string, string> = {
      undo: "undo",
      redo: "redo",
      cut: "cut",
      copy: "copy",
      paste: "paste",
      delete: "delete",
      "select-all": "selectAll",
    };
    if (editCommands[action]) {
      document.execCommand(editCommands[action]);
      return;
    }
    if (action === "focus-input") {
      document.querySelector<HTMLTextAreaElement>("#composer-input")?.focus();
      return;
    }
    if (action === "stop-turn") {
      if (currentId && activeTurn)
        void api.appServer.request("turn/interrupt", {
          threadId: currentId,
          turnId: activeTurn,
        });
      return;
    }
    if (action === "search-threads") {
      setSidebarVisible(true);
      window.requestAnimationFrame(() => {
        document.querySelector<HTMLInputElement>(".codex-search")?.focus();
      });
      return;
    }
    if (action === "toggle-side-picker") {
      setSidePanelOpen((open) => !open);
      return;
    }
    if (action === "new-chat") {
      startNewThread(false);
      return;
    }
    if (action === "new-temporary-chat") {
      startNewThread(true);
      return;
    }
    if (action === "open-folder") {
      void openWorkspace();
      return;
    }
    if (action === "open-workspace-vscode") {
      void openWorkspaceInVscode();
      return;
    }
    if (action === "settings") {
      void openSettingsView();
      return;
    }
    if (action === "shortcuts") {
      void openSettingsView("shortcuts");
      return;
    }
    if (action === "toggle-sidebar") {
      setSidebarVisible((visible) => !visible);
      return;
    }
    if (action === "toggle-bottom-panel" || action === "open-terminal") {
      toggleBottomPanel();
      return;
    }
    if (action === "toggle-top-panel") {
      toggleTopPanel();
      return;
    }
    if (action === "toggle-files") {
      setSidePanelOpen(false);
      setPanel(panel === "files" ? "" : "files");
      return;
    }
    if (action === "toggle-review") {
      setSidePanelOpen(false);
      if (panel === "review") setPanel("");
      else void loadPanel("review");
      return;
    }
    if (action === "open-browser") {
      setSidePanelOpen(false);
      setBrowserTabOpen(true);
      setPanel("browser");
      return;
    }
    if (action === "find") {
      if (panel === "browser") setBrowserFindTick((value) => value + 1);
      else if (currentId) setConversationFindTick((value) => value + 1);
      else document.querySelector<HTMLInputElement>(".codex-search")?.focus();
      return;
    }
    if (action === "back") {
      goThreadNav(-1);
      return;
    }
    if (action === "forward") {
      goThreadNav(1);
      return;
    }
    if (action === "previous-chat" || action === "next-chat") {
      if (!threads.length) return;
      const currentIndex = Math.max(
        0,
        threads.findIndex((thread) => thread.id === currentId),
      );
      const offset = action === "previous-chat" ? -1 : 1;
      const target =
        threads[(currentIndex + offset + threads.length) % threads.length];
      if (target) void selectThread(target.id);
      return;
    }
    const helpPages: Record<string, string> = {
      docs: "docs",
      conversation: "conversation",
      safety: "safety",
      tools: "tools",
      git: "git",
      settings: "settings",
      cli: "cli",
      "whats-new": "whats-new",
      troubleshooting: "troubleshooting",
      "system-status": "status",
    };
    if (helpPages[action]) {
      setSettingsView(false);
      setHelpView(helpPages[action]);
      return;
    }
    if (action === "copy-diagnostics" || action === "feedback") {
      void api.help
        .copyDiagnostics()
        .then((text) => navigator.clipboard.writeText(text))
        .then(() => dialog.alert("诊断", "已复制本地诊断信息"))
        .catch((error) => dialog.alert("诊断", `复制诊断失败：${String(error)}`));
      return;
    }
    if (action === "check-updates") {
      void (async () => {
        try {
          skipUpdatePromptRef.current = true;
          await promptFoundUpdate(await api.app.checkUpdates());
        } catch (error) {
          await dialog.alert("检查更新", `检查更新失败：${String(error)}`);
        }
      })();
      return;
    }
    if (action === "about") {
      void showAbout();
      return;
    }
    const windowActions: Record<string, string> = {
      "new-window": "new-window",
      "close-window": "close",
      minimize: "minimize",
      maximize: "maximize",
      quit: "quit",
      "zoom-in": "zoom-in",
      "zoom-out": "zoom-out",
      "zoom-reset": "zoom-reset",
      fullscreen: "fullscreen",
      "task-manager": "task-manager",
      performance: "devtools",
    };
    if (windowActions[action])
      void (api.app as any).windowAction(windowActions[action]);
  }

  if (helpView)
    return (
      <>
      <BackgroundLayer config={settingsConfig}>
        <HelpView
          initialPage={helpView}
          onClose={() => setHelpView("")}
          onOpenShortcuts={() => void openSettingsView("shortcuts")}
        />
      </BackgroundLayer>
      {dialog.node}
      </>
    );

  if (settingsView)
    return (
      <>
      <BackgroundLayer config={settingsConfig}>
        <SettingsView
          initialSection={settingsSection}
          config={settingsConfig}
          providerConfig={providerConfig}
          providerCapabilities={providerCapabilities}
          workspaceRoot={workspaceRoot}
          archivedThreads={archivedThreads}
          projects={projects}
          archivedLoading={archivedLoading}
          onOpenThread={openArchivedThread}
          onUnarchiveThread={unarchiveThread}
          onDeleteThread={deleteArchivedThread}
          onDeleteAllArchived={deleteAllArchivedThreads}
          onPickProjectlessDirectory={pickProjectlessDirectory}
          onWorkspaceOpen={openWorkspace}
          onOpenLicenses={() => api.app.openLicenses().then(() => undefined)}
          onPluginsEnabledChange={(enabled) =>
            api.codex
              .setPluginsEnabled(enabled)
              .then(() => undefined)
              .catch(() => undefined)
          }
          onBack={() => setSettingsView(false)}
          onSave={saveSetting}
          onProviderSave={(provider, baseUrl, nextModel) =>
            void saveProvider(provider, baseUrl, nextModel)
          }
          onProviderImported={async () => {
            await api.appServer.restart().catch(() => undefined);
            await reloadSettingsConfig().catch(() => undefined);
          }}
          onProviderKeySave={saveProviderKey}
          onImport={importThread}
          onExport={exportCurrentThread}
        />
      </BackgroundLayer>
      {dialog.node}
      </>
    );

  return (
    <>
    <BackgroundLayer config={settingsConfig}>
      <div className="app-shell" style={{ "--sidebar-width": `${sidebarWidth}px`, "--workspace-panel-width": `${workspacePanelWidth}px`, "--bottom-panel-height": `${bottomPanelHeight}px`, "--side-terminal-width": `${sideTerminalWidth}px` } as React.CSSProperties}>
        <WindowTitleBar onAction={runWindowMenuAction} canGoBack={threadNav.canBack} canGoForward={threadNav.canForward} shortcutMap={resolvedShortcutMap(settingsConfig)} />
        <main>
          {sidebarVisible && (
            <ThreadSidebar
              projects={projects}
              sections={sections}
              threads={threads}
              currentId={currentId}
              loadingId={loadingThreadId}
              search={search}
              onSearch={setSearch}
              onNew={() => void startNewThread()}
              onSelect={(id) => void selectThread(id)}
              onNavigate={(label) => {
                setNavigation(label);
                if (label === "已安排" || label === "自动化") setPanel("");
                else if (label === "插件" || label === "Git" || label === "GitLab" || label === "GitHub") setPanel("");
                else
                  setMessages([
                    { role: "activity", text: `${label}视图已选择` },
                  ]);
              }}
              onOpenSettings={() => void openSettingsView()}
              onEditProject={editProject}
              onQuickNewProject={quickNewProjectThread}
              onOpenProjectRoot={openProjectRoot}
              onOpenProjectInVscode={(path) => void openWorkspaceInVscode(path)}
              onCreateProjectWorktree={createProjectWorktree}
              onRemoveProject={removeProject}
              onExportCurrent={exportCurrentThread}
              onOpenHelp={() => setHelpView("docs")}
              onOpenAbout={() => void showAbout()}
              collabItems={collaborationItems}
              currentMode={mode}
              onSelectCollabMode={(value) => void changeMode(value)}
              gitlabAvailable={Boolean(gitlabStatus?.available || gitlabStatus?.configured || gitlabStatus?.enabled)}
              githubAvailable={Boolean(githubStatus?.available || githubStatus?.configured || githubStatus?.enabled)}
              onMoveCurrentToSection={() => {
                if (current) void threadAction("section", current);
              }}
              profileName={String(settingsConfig.display_name || "本地")}
              onThreadAction={(action, thread) =>
                void threadAction(action, thread)
              }
            />
          )}
          {sidebarVisible && <div className="panel-resize-handle panel-resize-sidebar" role="separator" aria-label="调整左侧栏宽度" onMouseDown={(event) => beginPanelResize("sidebar", event)} />}
          <div className="main-stage">
            {navigation === "插件" ? (
              <PluginsView onOpenSettings={(section) => void openSettingsView(section || "plugins")} />
            ) : navigation === "自动化" ? (
              <AutomationsView
                workspaceRoot={workspaceRoot}
                onOpenThread={(threadId) => {
                  setNavigation("");
                  void selectThread(threadId);
                }}
              />
            ) : navigation === "Git" ? (
              <GitView
                workspaceRoot={workspaceRoot}
                gitlabConfigured={Boolean(gitlabStatus?.configured || gitlabStatus?.enabled || gitlabStatus?.tokenConfigured)}
                githubConfigured={Boolean(githubStatus?.configured || githubStatus?.enabled || githubStatus?.tokenConfigured)}
                onOpenSettings={() => void openSettingsView()}
                onRemotesChanged={() => void reloadHostStatuses()}
                onOpenCloneWorkspace={(root) => void openCloneWorkspace(root)}
              />
            ) : navigation === "GitLab" ? (
              <GitLabView
                status={gitlabStatus}
                provider="gitlab"
                onStatusChange={(status) => setGitlabStatus((old) => keepHostStatus(old, status))}
                projects={projects}
                onOpenSettings={() => void openSettingsView()}
                onProjectChanged={(project) =>
                  setProjects((old) =>
                    old.some((item) => canonicalPath(item.path) === canonicalPath(project.path))
                      ? old.map((item) => (canonicalPath(item.path) === canonicalPath(project.path) ? { ...item, ...project } : item))
                      : [...old, project],
                  )
                }
                onUseClone={(root) => {
                  setNavigation("");
                  void quickNewProjectThread(root);
                }}
                onOpenCloneWorkspace={(root) => void openCloneWorkspace(root)}
                onAssignClone={(project, root) => void assignCloneToProject(project, root)}
              />
            ) : navigation === "GitHub" ? (
              <GitLabView
                status={githubStatus}
                provider="github"
                onStatusChange={(status) => setGithubStatus((old) => keepHostStatus(old, status))}
                projects={projects}
                onOpenSettings={() => void openSettingsView()}
                onProjectChanged={(project) =>
                  setProjects((old) =>
                    old.some((item) => canonicalPath(item.path) === canonicalPath(project.path))
                      ? old.map((item) => (canonicalPath(item.path) === canonicalPath(project.path) ? { ...item, ...project } : item))
                      : [...old, project],
                  )
                }
                onUseClone={(root) => {
                  setNavigation("");
                  void quickNewProjectThread(root);
                }}
                onOpenCloneWorkspace={(root) => void openCloneWorkspace(root)}
                onAssignClone={(project, root) => void assignCloneToProject(project, root)}
              />
            ) : (
              <>
                <div className="main-stage-top">
                  <div className={`editor-workbench${editorMaximized ? " is-maximized" : ""}`}>
                    {editorMaximized && (
                      <EditorWorkbenchTabBar
                        conversationTitle={
                          navigation ||
                          (current ? titleOf(current) : pendingEphemeral ? "临时聊天" : "新线程")
                        }
                        conversationActive={workbenchTab === "conversation"}
                        filePreview={filePreview}
                        imagePreview={imagePreview}
                        documentActive={workbenchTab === "document"}
                        workspaceRoot={workspaceRoot}
                        onAddToChat={addMention}
                        onSelectConversation={() => setWorkbenchTab("conversation")}
                        onSelectDocument={() => {
                          setWorkbenchTab("document");
                          setPanel(imagePreview ? "image" : "files");
                        }}
                        onCloseDocument={closeDocumentTab}
                        onToggleTree={() => {
                          setWorkbenchTab("document");
                          if (imagePreview) setPanel("image");
                          else setPanel("files");
                        }}
                        onRestore={() => {
                          setEditorMaximized(false);
                          setWorkbenchTab("conversation");
                          if (imagePreview) setPanel("image");
                          else if (filePreview) setPanel("files");
                        }}
                      />
                    )}
                    <div className={`editor-workbench-body${editorMaximized ? (workbenchTab === "conversation" ? " is-conversation" : " is-document") : ""}`}>
                  <div className="main-workspace" hidden={editorMaximized && workbenchTab !== "conversation" || undefined}>
                    <section className="conversation">
                      <div className="thread-header">
                        <div className="thread-header-title">
                          <span>
                            {navigation ||
                              (current ? titleOf(current) : pendingEphemeral ? "临时聊天" : "新线程")}
                          </span>
                          {(pendingEphemeral || current?.ephemeral) && <span className="thread-temp-badge">临时</span>}
                          <span className="sub">
                            {model || "默认模型"} ·{" "}
                            {workspaceRoot
                              ? workspaceRoot.split(/[\\/]/).pop()
                              : "工作区写"}
                            {(pendingEphemeral || current?.ephemeral) ? " · 关闭后不保留" : ""}
                          </span>
                        </div>
                        <div className="thread-header-tools">
                          <ThreadActionsMenu
                            threadId={currentId}
                            busy={Boolean(activeTurn || loadingThreadId)}
                            projects={projects}
                            onAssigned={(project) => currentId ? applyThreadAssignment(currentId, project) : undefined}
                            onReloaded={async () => {
                              if (!currentId) return;
                              setMessages(await readThreadMessages(currentId));
                            }}
                          />
                          <button
                            type="button"
                            className={`thread-panel-toggle ${topPanelOpen ? "active" : ""}`}
                            title="切换顶部面板"
                            aria-label="切换顶部面板"
                            aria-pressed={topPanelOpen}
                            onClick={toggleTopPanel}
                          >
                            <UiIcon icon={icons.topPanel} />
                          </button>
                          <button
                            type="button"
                            className={`thread-panel-toggle ${bottomPanelOpen ? "active" : ""}`}
                            title={terminalOnRight ? "切换右侧终端面板" : "切换底部面板"}
                            aria-label="切换底部面板"
                            aria-pressed={bottomPanelOpen}
                            onClick={toggleBottomPanel}
                          >
                            <UiIcon icon={icons.bottomPanel} />
                          </button>
                          <button
                            type="button"
                            className={`thread-panel-toggle ${sidePanelOpen || ["review", "files", "image", "sources", "browser"].includes(panel) ? "active" : ""}`}
                            title="显示/隐藏侧边面板"
                            aria-label="显示/隐藏侧边面板"
                            aria-pressed={
                              sidePanelOpen ||
                              [
                                "review",
                                "files",
                                "image",
                                "sources",
                                "browser",
                              ].includes(panel)
                            }
                            onClick={toggleSidePanel}
                          >
                            <UiIcon icon={icons.sidePanel} />
                          </button>
                        </div>
                      </div>
                      {!currentId && messages.length === 0 ? (
                        <NewThreadWelcome onPrompt={setInput} ephemeral={pendingEphemeral} />
                      ) : (
                        <ConversationView
                          key={currentId || "draft"}
                          threadKey={currentId || ""}
                          messages={messages}
                          loading={Boolean(loadingThreadId)}
                          activeTurn={activeTurn}
                          onLoadEarlier={() => void loadEarlierThread()}
                          hasEarlier={historyHasMore}
                          loadingEarlier={historyLoading}
                          onOpenImage={openImage}
                          findTick={conversationFindTick}
                          onOpenFile={(filePath) => void openFile(filePath)}
                          onOpenReview={(filePath, diff) =>
                            void loadPanel("review", filePath || "", diff || "")
                          }
                          approval={approval}
                          onApproval={(decision, answer) => {
                            if (!approval) return;
                            if (approval.kind === "mcp") {
                              const grant = mcpAllowTool(approval.params);
                              if (grant && decision === "remember") {
                                const current = {
                                  ...(settingsRef.current.mcp_allowed_tools || {}),
                                };
                                current[grant.server.toLowerCase()] = "*";
                                void api.preferences.write(
                                  "mcp_allowed_tools",
                                  current,
                                );
                              }
                              if (grant && decision === "acceptForSession") {
                                mcpSessionAllowRef.current.add(
                                  `${grant.server.toLowerCase()}:*`,
                                );
                              }
                            }
                            void api.appServer.respond(
                              approval.id,
                              approvalResponse(approval, decision, answer),
                            );
                            setApproval(null);
                          }}
                        />
                      )}
                      <OutputSchemaEditor
                        value={outputSchema}
                        onChange={setOutputSchema}
                        disabled={Boolean(loadingThreadId)}
                      />
                      <Composer
                        value={input}
                        onChange={setInput}
                        onSend={(behavior) => void send(behavior)}
                        models={models}
                        model={model}
                        onModelChange={(value) => void changeModel(value)}
                        mode={mode}
                        onModeChange={(value) => void changeMode(value)}
                        reasoningEffort={reasoningEffort}
                        onReasoningEffortChange={(value) =>
                          void changeReasoningEffort(value)
                        }
                        workspacePicker={
                          !currentId && messages.length === 0 ? (
                            <NewThreadWorkspacePicker
                              projects={projects}
                              workspaceRoot={workspaceRoot}
                              gitBranch={gitBranch}
                              projectless={projectlessWorkspaceActive}
                              onWorkspaceChange={chooseNewThreadWorkspace}
                              onProjectCreated={(project) =>
                                setProjects((old) =>
                                  old.some(
                                    (item) =>
                                      canonicalPath(item.path) ===
                                      canonicalPath(project.path),
                                  )
                                    ? old.map((item) =>
                                        canonicalPath(item.path) ===
                                        canonicalPath(project.path)
                                          ? { ...item, ...project }
                                          : item,
                                      )
                                    : [...old, project],
                                )
                              }
                            />
                          ) : undefined
                        }
                        activeTurn={activeTurn}
                        attachments={attachments}
                        onAttach={addAttachments}
                        onSearchMentions={searchMentions}
                        onMention={addMention}
                        onSlash={(command) => void handleComposerSlash(command)}
                        onRemoveAttachment={(name) =>
                          setAttachments((old) =>
                            old.filter((file) => file.name !== name),
                          )
                        }
                        voiceEnabled={Boolean(settingsConfig.voice_enabled)}
                        disabled={Boolean(loadingThreadId)}
                        submitBehavior={submitBehavior}
                        onSubmitBehaviorChange={setSubmitBehavior}
                        queued={queuedSubmissions.map((submission) => ({
                          id: submission.id,
                          text: queuedText(submission),
                        }))}
                        queueError={queueError}
                        onSteerQueued={(id) => void steerQueued(id)}
                        onEditQueued={(id) => void updateQueued(id)}
                        onDeleteQueued={(id) => void deleteQueued(id)}
                        onInterrupt={() => {
                          if (currentId && activeTurn)
                            void api.appServer.request("turn/interrupt", {
                              threadId: currentId,
                              turnId: activeTurn,
                            });
                        }}
                      />
                    </section>
                    {navigation !== "插件" && navigation !== "GitLab" && topPanelOpen && (
                      <EnvironmentPanel
                        workspaceRoot={workspaceRoot}
                        gitBranch={gitBranch}
                        conversationSources={conversationSources}
                        gitBusy={gitBusy}
                        gitStatus={gitActionStatus}
                        onWorkspaceOpen={openWorkspaceFileTree}
                        onOpenInVscode={() => void openWorkspaceInVscode()}
                        onOpenLatestChanges={openLatestConversationChanges}
                        onCommit={(message) => gitCommit(message)}
                        onPush={() => void gitPush()}
                        onCreateBranch={(name) => gitCreateBranch(name)}
                        confirmCommit={settingsConfig.git_confirm_commit !== false}
                        onOpenSources={openSources}
                        onClose={() => setTopPanelOpen(false)}
                      />
                    )}
                  </div>
                  {navigation !== "插件" && navigation !== "GitLab" &&
                    sidePanelOpen &&
                    ![
                      "review",
                      "files",
                      "image",
                      "sources",
                      "browser",
                    ].includes(panel) && (
                      <SidePanelPicker
                        onClose={() => setSidePanelOpen(false)}
                        onSelect={(next) => {
                          setSidePanelOpen(false);
                          setPanel(next);
                          if (next === "browser") {
                            setBrowserTabOpen(true);
                            return;
                          }
                          if (next === "files") return;
                          void loadPanel(next);
                        }}
                      />
                    )}
                  {navigation !== "插件" && navigation !== "GitLab" && (
                    <>
                    {!editorMaximized && (["review", "files", "image", "sources", "browser"] as string[]).includes(panel) && <div className="panel-resize-handle panel-resize-workspace" role="separator" aria-label="调整右侧栏宽度" onMouseDown={(event) => beginPanelResize("workspace", event)} />}
                    <WorkspacePanel
                      active={panel}
                      filePreview={filePreview}
                      filePreviewError={filePreviewError}
                      imagePreview={imagePreview}
                      reviewOpen={reviewTabOpen}
                      sourcesOpen={sourcesTabOpen}
                      browserOpen={browserTabOpen}
                      reviewDiff={reviewDiff}
                      reviewError={reviewError}
                      reviewFilePath={reviewFilePath}
                      conversationSources={conversationSources}
                      workspaceRoot={workspaceRoot}
                      onSelect={selectPanelTab}
                      onReviewClose={closeReviewTab}
                      onDocumentClose={closeDocumentTab}
                      onSourcesClose={closeSources}
                      onBrowserClose={closeBrowserTab}
                      onReviewRefresh={() => void refreshReview()}
                      onRestoreFile={restoreReviewFile}
                      onRejectHunk={rejectReviewHunk}
                      onFileSave={saveFile}
                      onOpenFile={(filePath, source) => void openFile(filePath, source)}
                      revealToken={treeRevealToken}
                      onTakeReveal={takeTreeReveal}
                      onAddToChat={addMention}
                      onPathChanged={(from, to) => {
                        setFilePreview((current) => current && current.path.toLowerCase() === from.toLowerCase() ? { ...current, path: to } : current);
                        setImagePreview((current) => current && current.path.toLowerCase() === from.toLowerCase() ? { ...current, path: to, name: to.split(/[\\/]/).pop() || current.name } : current);
                      }}
                      onImagePanelClose={() => {
                        setImagePreview(null);
                        setPanel("files");
                      }}
                      defaultFileApp={String(settingsConfig.default_file_app || "VS Code")}
                      diffMarkerStyle={String(settingsConfig.diff_marker_style || "颜色")}
                      browserFindTick={browserFindTick}
                      wordWrap={settingsConfig.code_wrap === true}
                      maximized={editorMaximized}
                      hideTabbar={editorMaximized}
                      hideTree={false}
                      contentHidden={editorMaximized && workbenchTab === "conversation"}
                      onMaximize={() => {
                        setEditorMaximized(true);
                        setWorkbenchTab("document");
                      }}
                    />
                    </>
                  )}
                    </div>
                  </div>
                  {navigation !== "插件" && navigation !== "GitLab" && navigation !== "GitHub" && terminalOnRight && bottomPanelOpen && (
                    <>
                      <div className="panel-resize-handle panel-resize-side" role="separator" aria-label="调整右侧终端宽度" onMouseDown={(event) => beginPanelResize("side", event)} />
                      <aside className="right-terminal-panel">
                        <TerminalPanel placement="right" onClose={() => setBottomPanelOpen(false)} />
                      </aside>
                    </>
                  )}
                </div>
                {navigation !== "插件" && navigation !== "GitLab" && navigation !== "GitHub" && !terminalOnRight && bottomPanelOpen && (
                  <>
                  <div className="panel-resize-handle panel-resize-bottom" role="separator" aria-label="调整下方栏高度" onMouseDown={(event) => beginPanelResize("bottom", event)} />
                  <aside className="bottom-terminal-panel">
                    <TerminalPanel placement="bottom" onClose={() => setBottomPanelOpen(false)} />
                  </aside>
                  </>
                )}
              </>
            )}
          </div>
        </main>
        {editingProject && (
          <ProjectEditDialog
            project={editingProject}
            onClose={() => setEditingProject(null)}
            onSaved={saveEditedProject}
            onDeleted={deleteEditedProject}
          />
        )}
        {settingsConfig.show_bottom_panel !== false && (
          <StatusBar
            mock={mock}
            model={
              modelLabel(models.find((item) => (item.model || item.id) === model)) ||
              model
            }
            tokens={tokens}
            tokenHistory={tokenHistory}
            sandbox={String(settingsConfig.sandbox_mode || "workspace-write")}
            network={
              sandboxNetworkEnabled()
                ? "工具允许"
                : "工具关闭"
            }
          />
        )}
      </div>
    </BackgroundLayer>
    {dialog.node}
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>,
);
