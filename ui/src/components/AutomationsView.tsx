import React from "react";
import { api } from "../api";
import { useAppDialog } from "./AppDialog";
import { icons, UiIcon } from "./UiIcon";

type Automation = {
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
};

const emptyDraft = {
  id: "",
  name: "",
  prompt: "",
  cwd: "",
  enabled: true,
  kind: "daily",
  hour: "09",
  minute: "00",
  minutes: "60",
  at: "",
};

function formatWhen(value?: number | string | null) {
  if (value == null || value === "") return "尚未安排";
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return "尚未安排";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export function AutomationsView({
  workspaceRoot = "",
  onOpenThread,
  embedded = false,
}: {
  workspaceRoot?: string;
  onOpenThread?: (threadId: string) => void;
  embedded?: boolean;
}) {
  const [items, setItems] = React.useState<Automation[]>([]);
  const [file, setFile] = React.useState("");
  const [draft, setDraft] = React.useState(emptyDraft);
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState("");
  const dialog = useAppDialog();

  const refresh = React.useCallback(async () => {
    const result = await api.automations.list();
    setItems(result.automations);
    setFile(result.file);
  }, []);

  React.useEffect(() => { void refresh().catch((error) => setMessage(String(error))); }, [refresh]);
  React.useEffect(() => api.automations.onRan((event) => {
    setMessage(`「${event.name}」已开始`);
    void refresh();
  }), [refresh]);

  function edit(item: Automation) {
    setDraft({
      id: item.id,
      name: item.name,
      prompt: item.prompt,
      cwd: item.cwd,
      enabled: item.enabled,
      kind: item.schedule.kind || "daily",
      hour: String(item.schedule.hour ?? 9).padStart(2, "0"),
      minute: String(item.schedule.minute ?? 0).padStart(2, "0"),
      minutes: String(item.schedule.minutes ?? 60),
      at: item.schedule.at ? String(item.schedule.at).slice(0, 16) : "",
    });
  }

  async function save() {
    try {
      const schedule = draft.kind === "interval"
        ? { kind: "interval", minutes: Number(draft.minutes) || 60 }
        : draft.kind === "once"
          ? { kind: "once", at: draft.at }
          : { kind: "daily", hour: Number(draft.hour), minute: Number(draft.minute) };
      const result = await api.automations.upsert({
        id: draft.id || undefined,
        name: draft.name,
        prompt: draft.prompt,
        cwd: draft.cwd || workspaceRoot,
        enabled: draft.enabled,
        schedule,
      });
      setItems(result.automations);
      setDraft(emptyDraft);
      setMessage(draft.id ? "已更新自动化" : "已添加自动化");
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function toggle(item: Automation, enabled: boolean) {
    const result = await api.automations.upsert({ ...item, enabled });
    setItems(result.automations);
  }

  async function remove(item: Automation) {
    if (!(await dialog.confirm("删除自动化", `删除自动化「${item.name}」？`))) return;
    const result = await api.automations.remove(item.id);
    setItems(result.automations);
    if (draft.id === item.id) setDraft(emptyDraft);
  }

  async function run(item: Automation) {
    setBusy(item.id);
    try {
      const result = await api.automations.run(item.id);
      if (result.threadId) onOpenThread?.(result.threadId);
      setMessage(`已立即运行「${item.name}」`);
      await refresh();
    } catch (error) {
      setMessage(String(error));
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="plugins-view automations-view">
      <div className="plugins-content">
        {!embedded && <header className="plugins-heading">
          <h1>自动化</h1>
          <p>在应用运行时按计划启动本地线程。任务保存在 {file || "应用数据目录/automations.json"}，不会发到云端。</p>
        </header>}
        <div className="settings-card settings-mcp-form automations-form">
          <div className="settings-mcp-fields">
            <input className="settings-inline-input" value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="名称，例如 每日变更摘要" />
            <select className="settings-select" value={draft.kind} onChange={(event) => setDraft((current) => ({ ...current, kind: event.target.value }))}>
              <option value="daily">每天</option>
              <option value="interval">间隔</option>
              <option value="once">一次</option>
            </select>
            {draft.kind === "daily" && <>
              <input className="settings-inline-input" type="number" min={0} max={23} value={draft.hour} onChange={(event) => setDraft((current) => ({ ...current, hour: event.target.value }))} placeholder="时" />
              <input className="settings-inline-input" type="number" min={0} max={59} value={draft.minute} onChange={(event) => setDraft((current) => ({ ...current, minute: event.target.value }))} placeholder="分" />
            </>}
            {draft.kind === "interval" && <input className="settings-inline-input" type="number" min={1} value={draft.minutes} onChange={(event) => setDraft((current) => ({ ...current, minutes: event.target.value }))} placeholder="间隔分钟" />}
            {draft.kind === "once" && <input className="settings-inline-input" type="datetime-local" value={draft.at} onChange={(event) => setDraft((current) => ({ ...current, at: event.target.value }))} />}
            <input className="settings-inline-input" value={draft.cwd} onChange={(event) => setDraft((current) => ({ ...current, cwd: event.target.value }))} placeholder={workspaceRoot || "工作区路径，可留空"} />
            <textarea className="settings-multiline" value={draft.prompt} onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))} placeholder="到点后发送给 Agent 的提示词" />
            <button className="settings-primary" onClick={() => void save()}>{draft.id ? "保存修改" : "添加自动化"}</button>
            {draft.id && <button className="settings-action" onClick={() => setDraft(emptyDraft)}>取消编辑</button>}
          </div>
        </div>
        {items.length === 0 ? <div className="plugins-empty">还没有自动化。添加一条后，只要应用在运行（含托盘）就会按计划启动线程。</div> : <div className="plugins-skill-list">
          {items.map((item) => (
            <article className={`plugins-skill-card ${item.enabled ? "" : "disabled"}`} key={item.id}>
              <span className="plugins-icon" style={{ backgroundColor: "#4c8dff" }}><UiIcon icon={icons.clock} /></span>
              <div>
                <strong>{item.name}</strong>
                <small>{item.scheduleLabel || "未安排"} · 下次 {formatWhen(item.nextRunAt)}{item.lastRunAt ? ` · 上次 ${formatWhen(item.lastRunAt)}` : ""}{item.lastError ? ` · ${item.lastError}` : ""}</small>
              </div>
              <button className="settings-action" disabled={busy === item.id} onClick={() => void run(item)}>立即运行</button>
              <button className="settings-action" onClick={() => edit(item)}>编辑</button>
              <button className="settings-action" onClick={() => void toggle(item, !item.enabled)}>{item.enabled ? "停用" : "启用"}</button>
              {item.lastThreadId && <button className="settings-action" onClick={() => onOpenThread?.(item.lastThreadId!)}>打开线程</button>}
              <button className="settings-action" onClick={() => void remove(item)}>删除</button>
            </article>
          ))}
        </div>}
        {message && <div className="plugins-message">{message}</div>}
      </div>
      {dialog.node}
    </section>
  );
}
