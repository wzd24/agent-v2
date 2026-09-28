import React from "react";
import { api, listData, modelLabel, pickCatalogModel } from "../api";
import type { CodexProject, Model, Thread } from "../api";
import { useCoverBrowser } from "../coverBrowser";
import { icons, UiIcon } from "./UiIcon";
import { useAppDialog } from "./AppDialog";
import { SettingsCategoryView } from "./SettingsCategoryView";

type SettingsViewProps = {
  config: Record<string, any>;
  providerConfig: {
    provider: string;
    baseUrl: string;
    model: string;
    envKey: string;
    providers: string[];
  };
  onBack: () => void;
  onSave: (key: string, value: any) => void | Promise<void>;
  onProviderSave: (provider: string, baseUrl: string, model: string) => void;
  onProviderImported?: () => void | Promise<void>;
  onProviderKeySave?: (
    provider: string,
    envKey: string,
    value: string,
  ) => Promise<void>;
  providerCapabilities?: {
    responses?: boolean;
    tools?: boolean;
    images?: boolean;
  };
  onImport?: () => Promise<string>;
  onExport?: () => Promise<string>;
  workspaceRoot?: string;
  onWorkspaceOpen?: () => Promise<void>;
  onOpenLicenses?: () => Promise<void>;
  onPluginsEnabledChange?: (enabled: boolean) => Promise<void>;
  onPickProjectlessDirectory?: () => void | Promise<void>;
  archivedThreads?: Thread[];
  projects?: CodexProject[];
  archivedLoading?: boolean;
  onOpenThread?: (threadId: string) => void | Promise<void>;
  onUnarchiveThread?: (thread: Thread) => void | Promise<void>;
  onDeleteThread?: (thread: Thread) => void | Promise<void>;
  onDeleteAllArchived?: (threads: Thread[]) => void | Promise<void>;
  initialSection?: string;
};

const navGroups: Array<{ title: string; items: Array<[string, string, any]> }> =
  [
    {
      title: "个人",
      items: [
        ["general", "常规", icons.gear],
        ["import", "导入", icons.download],
        ["appearance", "外观", icons.image],
        ["voice", "语音", icons.globe],
        ["configuration", "配置", icons.gear],
        ["personalization", "个性化", icons.compose],
        ["shortcuts", "键盘快捷键", icons.code],
        ["automations", "自动化", icons.clock],
      ],
    },
    {
      title: "集成",
      items: [
        ["computer", "电脑操控", icons.nodes],
        ["plugins", "插件", icons.puzzle],
        ["gitlab", "GitLab", icons.merge],
        ["github", "GitHub", icons.branch],
        ["browser", "浏览器", icons.globe],
      ],
    },
    {
      title: "编码",
      items: [
        ["hooks", "钩子", icons.branch],
        ["connections", "连接", icons.nodes],
        ["git", "Git", icons.branch],
        ["environment", "环境", icons.folder],
        ["worktrees", "Worktrees", icons.folderOpen],
      ],
    },
    { title: "已归档", items: [["archived", "已归档的聊天", icons.clock]] },
  ];

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={`settings-toggle ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row-copy">
        <strong>{title}</strong>
        {description && <small>{description}</small>}
      </div>
      <div className="settings-row-control">{children}</div>
    </div>
  );
}

function SelectControl({
  value,
  options,
  onChange,
}: {
  value: string;
  options: string[];
  onChange?: (value: string) => void;
}) {
  return (
    <select
      className="settings-select"
      value={value}
      onChange={(event) => onChange?.(event.target.value)}
    >
      {options.map((option) => (
        <option key={option}>{option}</option>
      ))}
    </select>
  );
}

export function SettingsView({
  config,
  providerConfig,
  onBack,
  onSave,
  onProviderSave,
  onProviderImported,
  onProviderKeySave,
  providerCapabilities = {},
  onImport,
  onExport,
  workspaceRoot = "",
  onWorkspaceOpen,
  onOpenLicenses,
  onPluginsEnabledChange,
  onPickProjectlessDirectory,
  archivedThreads,
  projects,
  archivedLoading,
  onOpenThread,
  onUnarchiveThread,
  onDeleteThread,
  onDeleteAllArchived,
  initialSection = "general",
}: SettingsViewProps) {
  useCoverBrowser(true);
  const [section, setSection] = React.useState(initialSection || "general");
  React.useEffect(() => {
    if (initialSection) setSection(initialSection);
  }, [initialSection]);
  const [bottomPanel, setBottomPanel] = React.useState(
    config.show_bottom_panel !== false,
  );
  const [plugins, setPlugins] = React.useState(
    config.plugins_enabled !== false,
  );
  const [defaultApp, setDefaultApp] = React.useState(
    String(config.default_file_app || "VS Code"),
  );
  const [shell, setShell] = React.useState(
    String(config.shell || "PowerShell"),
  );
  const [search, setSearch] = React.useState("");
  const [terminalPlacement, setTerminalPlacement] = React.useState(
    String(config.terminal_placement || "底部"),
  );

  const title =
    navGroups
      .flatMap((group) => group.items)
      .find(([key]) => key === section)?.[1] || "常规";
  const visibleGroups = search.trim()
    ? navGroups
        .map((group) => ({
          ...group,
          items: group.items.filter(([, label]) =>
            label.toLowerCase().includes(search.trim().toLowerCase()),
          ),
        }))
        .filter((group) => group.items.length)
    : navGroups;
  const saveToggle = (
    key: string,
    value: boolean,
    setter: (value: boolean) => void,
  ) => {
    setter(value);
    onSave(key, value);
  };
  return (
    <div className="settings-shell">
      <div className="settings-layout">
        <aside className="settings-nav">
          <button className="settings-back" onClick={onBack}>
            <UiIcon icon={icons.right} className="settings-back-icon" />{" "}
            返回应用
          </button>
          <div className="settings-search">
            <UiIcon icon={icons.search} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="搜索设置…"
            />
          </div>
          {visibleGroups.map((group) => (
            <div className="settings-nav-group" key={group.title}>
              <div className="settings-nav-group-title">{group.title}</div>
              {group.items.map(([key, label, icon]) => (
                <button
                  className={`settings-nav-item ${section === key ? "active" : ""}`}
                  key={key}
                  onClick={() => {
                    setSection(key);
                    setSearch("");
                  }}
                >
                  <UiIcon icon={icon} />
                  <span>{label}</span>
                </button>
              ))}
            </div>
          ))}
          {visibleGroups.length === 0 && (
            <div className="settings-nav-empty">没有匹配设置</div>
          )}
        </aside>
        <main className="settings-main">
          <div className="settings-content">
            <h1>{title}</h1>
            {section !== "general" && section !== "configuration" ? (
              <SettingsCategoryView
                section={section}
                config={config}
                onSave={onSave}
                onImport={onImport}
                onExport={onExport}
                archivedThreads={archivedThreads}
                projects={projects}
                archivedLoading={archivedLoading}
                onOpenThread={onOpenThread}
                onUnarchiveThread={onUnarchiveThread}
                onDeleteThread={onDeleteThread}
                onDeleteAllArchived={onDeleteAllArchived}
              />
            ) : section === "configuration" ? (
              <ConfigurationSection
                config={config}
                providerConfig={providerConfig}
                providerCapabilities={providerCapabilities}
                onSave={onSave}
                onProviderSave={onProviderSave}
                onProviderImported={onProviderImported}
                onProviderKeySave={onProviderKeySave}
              />
            ) : (
              <>
                <h2>权限</h2>
                <div className="settings-card">
                  <SettingRow
                    title="默认权限"
                    description="默认情况下，Agent 可以读取和编辑其工作空间中的文件。需要时，它可以请求额外访问权限。"
                  >
                    <div className="settings-segment">
                      {([
                        ["untrusted", "不信任"],
                        ["on-request", "按需"],
                        ["never", "从不"],
                      ] as const).map(([value, label]) => (
                        <button
                          key={value}
                          className={
                            String(config.approval_policy || "on-request") ===
                            value
                              ? "selected"
                              : ""
                          }
                          onClick={() => onSave("approval_policy", value)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </SettingRow>
                  <SettingRow
                    title="完整访问权限"
                    description="允许 Agent 在无需单独批准的情况下访问工作区外的文件和网络。"
                  >
                    <Toggle
                      checked={config.sandbox_mode === "danger-full-access"}
                      onChange={(value) =>
                        onSave(
                          "sandbox_mode",
                          value ? "danger-full-access" : "workspace-write",
                        )
                      }
                    />
                  </SettingRow>
                </div>
                <h2>常规</h2>
                <div className="settings-card">
                  <SettingRow
                    title="当前工作区"
                    description="文件、Git、终端和新线程使用的根目录。"
                  >
                    <div className="settings-value">
                      {workspaceRoot || "未选择"}
                    </div>
                    <button
                      className="settings-action"
                      onClick={() => void onWorkspaceOpen?.()}
                    >
                      更改
                    </button>
                  </SettingRow>
                  <SettingRow
                    title="无项目任务文件夹"
                    description="在项目外启动的任务默认存储数据的位置。"
                  >
                    <div
                      className="settings-value"
                      title={String(config.projectless_workspace_root || "")}
                    >
                      {String(config.projectless_workspace_root || "未配置")}
                    </div>
                    <button
                      className="settings-action"
                      onClick={() => void onPickProjectlessDirectory?.()}
                    >
                      更改
                    </button>
                  </SettingRow>
                  <SettingRow
                    title="默认文件打开位置"
                    description="从文件面板外部打开文件时使用的应用"
                  >
                    <SelectControl
                      value={defaultApp}
                      options={["VS Code", "Cursor", "系统默认"]}
                      onChange={(value) => {
                        setDefaultApp(value);
                        onSave("default_file_app", value);
                      }}
                    />
                  </SettingRow>
                  <SettingRow
                    title="集成终端 Shell"
                    description="新建 PTY 终端时使用的 Shell"
                  >
                    <SelectControl
                      value={shell}
                      options={["PowerShell", "命令提示符", "Git Bash"]}
                      onChange={(value) => {
                        setShell(value);
                        onSave("shell", value);
                      }}
                    />
                  </SettingRow>
                  <SettingRow
                    title="底部状态栏"
                    description="显示模型、沙箱、网络与 Token 状态"
                  >
                    <Toggle
                      checked={bottomPanel}
                      onChange={(value) =>
                        saveToggle("show_bottom_panel", value, setBottomPanel)
                      }
                    />
                  </SettingRow>
                  <SettingRow title="终端面板位置">
                    <div className="settings-segment">
                      <button
                        className={
                          terminalPlacement === "底部" ? "selected" : ""
                        }
                        onClick={() => {
                          setTerminalPlacement("底部");
                          onSave("terminal_placement", "底部");
                        }}
                      >
                        底部
                      </button>
                      <button
                        className={
                          terminalPlacement === "右侧" ? "selected" : ""
                        }
                        onClick={() => {
                          setTerminalPlacement("右侧");
                          onSave("terminal_placement", "右侧");
                        }}
                      >
                        右侧
                      </button>
                    </div>
                  </SettingRow>
                  <SettingRow
                    title="应用许可证"
                    description="打开 Local Codex 及捆绑组件的许可证，不是 Chromium credits"
                  >
                    <button
                      className="settings-action"
                      onClick={() => void onOpenLicenses?.()}
                    >
                      查看
                    </button>
                  </SettingRow>
                  <SettingRow
                    title="本地插件"
                    description="控制本地插件 Skills 是否注入 app-server"
                  >
                    <Toggle
                      checked={plugins}
                      onChange={(value) => {
                        setPlugins(value);
                        onSave("plugins_enabled", value);
                        void onPluginsEnabledChange?.(value);
                      }}
                    />
                  </SettingRow>
                </div>
              </>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function ConfigurationSection({
  config,
  providerConfig,
  providerCapabilities,
  onSave,
  onProviderSave,
  onProviderImported,
  onProviderKeySave,
}: {
  config: Record<string, any>;
  providerConfig: SettingsViewProps["providerConfig"];
  providerCapabilities?: SettingsViewProps["providerCapabilities"];
  onSave: SettingsViewProps["onSave"];
  onProviderSave: SettingsViewProps["onProviderSave"];
  onProviderImported?: SettingsViewProps["onProviderImported"];
  onProviderKeySave?: SettingsViewProps["onProviderKeySave"];
}) {
  const dialog = useAppDialog();
  const [sandbox, setSandbox] = React.useState(
    String(config.sandbox_mode || "workspace-write"),
  );
  const [approval, setApproval] = React.useState(
    String(config.approval_policy || "on-request"),
  );
  const [network, setNetwork] = React.useState(
    Boolean(config.sandbox_workspace_write?.network_access),
  );
  const [provider, setProvider] = React.useState(
    providerConfig.provider || "deepseek",
  );
  const [baseUrl, setBaseUrl] = React.useState(
    providerConfig.baseUrl || "https://api.deepseek.com/",
  );
  const [model, setModel] = React.useState(
    providerConfig.model || "deepseek-flash",
  );
  const [catalog, setCatalog] = React.useState<Model[]>([]);
  const [appRoot, setAppRoot] = React.useState("");
  const [presets, setPresets] = React.useState<
    Array<{
      id: string;
      name: string;
      baseUrl?: string;
      base_url?: string;
      envKey?: string;
      env_key?: string;
      defaultModel?: string;
    }>
  >([]);
  const [providerOverlay, setProviderOverlay] = React.useState<
    Record<string, any>
  >({});
  const [importStatus, setImportStatus] = React.useState("");
  const providerMap = {
    ...(config.model_providers || {}),
    ...providerOverlay,
  };
  const providerOptions = Array.from(
    new Set([
      ...Object.keys(providerMap),
      ...providerConfig.providers,
      ...presets.map((item) => item.id),
      provider,
    ].filter(Boolean)),
  );
  React.useEffect(() => {
    setProvider(providerConfig.provider || "deepseek");
    setBaseUrl(providerConfig.baseUrl || "https://api.deepseek.com/");
    setModel(providerConfig.model || "deepseek-flash");
  }, [providerConfig.provider, providerConfig.baseUrl, providerConfig.model]);
  React.useEffect(() => {
    void api.config
      .read()
      .then((info) => setAppRoot(String(info.appRoot || info.codexHome || "")))
      .catch(() => undefined);
    void api.config
      .providerPresets()
      .then((result) => setPresets(result.presets || []))
      .catch(() => undefined);
  }, []);
  React.useEffect(() => {
    void api.appServer
      .request("model/list", {})
      .then((result) => {
        const data = listData<Model>(result);
        setCatalog(data);
      })
      .catch(() => undefined);
  }, [providerConfig.provider]);
  function applyPreset(preset: {
    id: string;
    name: string;
    baseUrl?: string;
    base_url?: string;
    envKey?: string;
    env_key?: string;
    defaultModel?: string;
  }) {
    const nextUrl = String(preset.baseUrl || preset.base_url || "");
    const nextKey = String(preset.envKey || preset.env_key || "");
    const nextModel = String(preset.defaultModel || model || "deepseek-flash");
    setProvider(preset.id);
    setBaseUrl(nextUrl);
    if (nextModel) setModel(nextModel);
    setProviderOverlay((old) => ({
      ...old,
      [preset.id]: {
        name: preset.name,
        base_url: nextUrl,
        env_key: nextKey,
        wire_api: "responses",
        requires_openai_auth: false,
      },
    }));
  }
  async function importOfficial(path?: string) {
    setImportStatus("正在读取官方 Codex 配置…");
    try {
      const preview = await api.config.importOfficialCodex({
        apply: false,
        path,
      });
      const names = (preview.providers || [])
        .map((item) => item.name || item.id)
        .filter(Boolean);
      if (!names.length) {
        setImportStatus("官方配置中没有可导入的模型提供者（已跳过 OpenAI/ChatGPT）");
        return;
      }
      const confirmed = await dialog.confirm(
        "从 Codex 导入",
        [
          `来源：${preview.path || "官方 ~/.codex/config.toml"}`,
          `将导入 ${names.length} 个提供者：${names.join("、")}`,
          preview.willSelectProvider
            ? `导入后当前提供者：${preview.willSelectProvider}`
            : "",
          preview.skippedOpenAi ? "已跳过 OpenAI/ChatGPT 登录相关项。" : "",
        ]
          .filter(Boolean)
          .join("\n"),
      );
      if (!confirmed) {
        setImportStatus("");
        return;
      }
      const applied = await api.config.importOfficialCodex({
        apply: true,
        path: preview.path || path,
      });
      const selected = String(
        applied.willSelectProvider || applied.modelProvider || provider,
      );
      const selectedConfig =
        (applied.providers || []).find((item) => item.id === selected) || {};
      setProvider(selected);
      setBaseUrl(
        String(applied.baseUrl || selectedConfig.baseUrl || selectedConfig.base_url || baseUrl),
      );
      if (applied.model) setModel(String(applied.model));
      setImportStatus(
        applied.importedEnvKeys?.length
          ? `已导入 ${names.length} 个提供者，并写入 ${applied.importedEnvKeys.length} 个环境密钥`
          : `已导入 ${names.length} 个提供者`,
      );
      await onProviderImported?.();
    } catch (error) {
      setImportStatus(String(error));
    }
  }
  async function pickOfficial() {
    try {
      const picked = await api.config.pickOfficialCodex();
      if (picked.canceled || !picked.path) return;
      await importOfficial(picked.path);
    } catch (error) {
      setImportStatus(String(error));
    }
  }
  return (
    <>
      <h2>模型提供者</h2>
      <div className="settings-card">
        <SettingRow
          title="当前 Provider"
          description="模型请求使用的本地或托管 Responses API 提供者。未配置时默认 DeepSeek。"
        >
          <SelectControl
            value={provider || "deepseek"}
            options={providerOptions.length ? providerOptions : ["deepseek"]}
            onChange={(value) => {
              setProvider(value);
              const selected = providerMap[value] || {};
              const nextBaseUrl = String(selected.base_url || selected.baseUrl || "");
              const preset = presets.find((item) => item.id === value);
              const presetModel = String(preset?.defaultModel || "").trim();
              const kept =
                model &&
                !presets.some(
                  (item) => item.id !== value && item.defaultModel && item.defaultModel === model,
                )
                  ? model
                  : "";
              const nextModel = presetModel || kept;
              setBaseUrl(nextBaseUrl);
              setModel(nextModel);
              if (nextBaseUrl && nextModel) onProviderSave(value, nextBaseUrl, nextModel);
              else onSave("model_provider", value);
            }}
          />
          <button
            className="settings-action"
            title="新建 Provider"
            onClick={() => {
              void (async () => {
                const name = await dialog.prompt("新建 Provider", "", { placeholder: "Provider 名称" });
                if (name?.trim()) {
                  setProvider(name.trim());
                  setBaseUrl("");
                }
              })();
            }}
          >
            <UiIcon icon={icons.plus} />
          </button>
        </SettingRow>
        <SettingRow
          title="常见预设"
          description="一键填入常见 Responses 兼容提供者，保存后才会写入引擎配置"
        >
          <div className="settings-preset-list">
            {(presets.length
              ? presets
              : [
                  {
                    id: "deepseek",
                    name: "DeepSeek",
                    baseUrl: "https://api.deepseek.com/",
                    envKey: "DEEPSEEK_API_KEY",
                    defaultModel: "deepseek-flash",
                  },
                ]
            ).map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={provider === preset.id ? "selected" : ""}
                onClick={() => applyPreset(preset)}
              >
                {preset.name}
              </button>
            ))}
          </div>
        </SettingRow>
        <SettingRow
          title="从 Codex 导入"
          description="显式读取官方 ~/.codex/config.toml 的模型提供者，不会自动继承 CODEX_HOME"
        >
          <button
            className="settings-action"
            onClick={() => void importOfficial()}
          >
            导入官方配置
          </button>
          <button className="settings-action" onClick={() => void pickOfficial()}>
            选择文件
          </button>
        </SettingRow>
        {importStatus ? (
          <div className="settings-import-status">{importStatus}</div>
        ) : null}
        <SettingRow
          title="Responses base_url"
          description="提供者的原生 /v1/responses 服务地址"
        >
          <input
            className="settings-inline-input"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </SettingRow>
        <SettingRow title="默认模型" description="新回合默认使用的模型">
          {catalog.length ? (
            <select
              className="settings-inline-input"
              value={model || pickCatalogModel(catalog, model)}
              onChange={(event) => setModel(event.target.value)}
            >
              {catalog.map((item) => (
                <option key={item.model || item.id} value={item.model || item.id}>
                  {modelLabel(item)}
                </option>
              ))}
              {model &&
              !catalog.some((item) => (item.model || item.id) === model) ? (
                <option value={model}>{model}</option>
              ) : null}
            </select>
          ) : (
            <input
              className="settings-inline-input"
              value={model}
              onChange={(event) => setModel(event.target.value)}
            />
          )}
        </SettingRow>
        <ProviderKeyRow
          provider={provider}
          envKey={String(
            providerMap[provider]?.env_key ||
              providerMap[provider]?.envKey ||
              (provider === providerConfig.provider
                ? providerConfig.envKey
                : "") ||
              `${provider.toUpperCase()}_API_KEY`,
          )}
          onSave={onProviderKeySave}
        />
        <div className="settings-provider-actions">
          <button
            className="settings-primary"
            onClick={() =>
              provider &&
              baseUrl &&
              model &&
              onProviderSave(provider, baseUrl, model)
            }
          >
            保存并切换
          </button>
        </div>
      </div>
      <h2>执行策略</h2>
      <div className="settings-card">
        <SettingRow title="审批策略" description="控制工具调用何时需要你的确认">
          <SelectControl
            value={approval}
            options={["untrusted", "on-request", "never"]}
            onChange={(value) => {
              setApproval(value);
              onSave("approval_policy", value);
            }}
          />
        </SettingRow>
        <SettingRow
          title="沙箱模式"
          description="限制 Agent 对本地文件和进程的访问范围"
        >
          <SelectControl
            value={sandbox}
            options={["read-only", "workspace-write", "danger-full-access"]}
            onChange={(value) => {
              setSandbox(value);
              onSave("sandbox_mode", value);
            }}
          />
        </SettingRow>
        <SettingRow
          title="沙箱工具网络"
          description="控制 workspace-write 沙箱中的工具是否允许联网"
        >
          <Toggle
            checked={network}
            onChange={(value) => {
              setNetwork(value);
              onSave("sandbox_workspace_write.network_access", value);
            }}
          />
        </SettingRow>
      </div>
      <h2>Provider 能力</h2>
      <div className="settings-card">
        <RowCapability
          title="Responses API"
          enabled={providerCapabilities?.responses}
        />
        <RowCapability
          title="命名空间工具"
          enabled={providerCapabilities?.tools}
        />
        <RowCapability
          title="图片生成"
          enabled={providerCapabilities?.images}
        />
      </div>
      <h2>本地与隐私</h2>
      <div className="settings-card">
        <SettingRow
          title="应用数据目录"
          description="项目、偏好、自动化、插件和密钥由 Local Codex 自己维护；不会自动继承官方 ~/.codex，仅在你点击导入时读取"
        >
          <div className="settings-value">
            {appRoot || "由应用管理"}
          </div>
        </SettingRow>
        <SettingRow
          title="遥测"
          description="启动参数强制 analytics.enabled=false"
        >
          <span className="capability-badge supported">✓</span>
        </SettingRow>
        <SettingRow
          title="当前配置项"
          description="已从引擎运行时配置、app-server 和应用偏好读取"
        >
          <span className="settings-config-count">
            {Object.keys(config).length} 项
          </span>
        </SettingRow>
      </div>
      {dialog.node}
    </>
  );
}

function ProviderKeyRow({
  provider,
  envKey,
  onSave,
}: {
  provider: string;
  envKey: string;
  onSave?: SettingsViewProps["onProviderKeySave"];
}) {
  const [keyName, setKeyName] = React.useState(envKey);
  const [secret, setSecret] = React.useState("");
  const [status, setStatus] = React.useState("");
  React.useEffect(() => {
    setKeyName(envKey);
    void api.secrets
      .read(envKey)
      .then((result) =>
        setStatus(result.configured ? "已配置安全密钥" : "尚未配置密钥"),
      )
      .catch(() => setStatus("无法读取安全存储"));
  }, [envKey]);
  async function save() {
    if (!onSave || !secret) return;
    try {
      await onSave(provider, keyName, secret);
      setSecret("");
      setStatus("已保存并重启服务");
    } catch (error) {
      setStatus(String(error));
    }
  }
  return (
    <div className="settings-provider-key">
      <div>
        <strong>Provider 密钥</strong>
        <small>密钥写入系统安全存储，不进入 config.toml 或日志</small>
      </div>
      <input
        value={keyName}
        onChange={(event) => setKeyName(event.target.value)}
        placeholder="ENV_KEY"
      />
      <input
        type="password"
        value={secret}
        onChange={(event) => setSecret(event.target.value)}
        placeholder="API Key"
      />
      <button
        className="settings-action"
        disabled={!secret}
        onClick={() => void save()}
      >
        保存密钥
      </button>
      {status && <span>{status}</span>}
    </div>
  );
}

function RowCapability({
  title,
  enabled,
}: {
  title: string;
  enabled?: boolean;
}) {
  return (
    <div className="settings-row capability-row">
      <div className="settings-row-copy">
        <strong>{title}</strong>
        <small>
          {enabled == null ? "未检测" : enabled ? "支持" : "不支持"}
        </small>
      </div>
      <span
        className={`capability-badge ${enabled ? "supported" : enabled === false ? "unsupported" : ""}`}
      >
        {enabled == null ? "?" : enabled ? "✓" : "×"}
      </span>
    </div>
  );
}
