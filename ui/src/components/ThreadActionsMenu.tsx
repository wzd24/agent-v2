import React from "react";
import { api, CodexProject } from "../api";
import { AppDialog } from "./AppDialog";
import { icons, UiIcon } from "./UiIcon";

export function ThreadActionsMenu({
  threadId,
  busy = false,
  projects = [],
  onReloaded,
  onAssigned,
}: {
  threadId: string | null;
  busy?: boolean;
  projects?: CodexProject[];
  onReloaded: () => Promise<void>;
  onAssigned?: (project: CodexProject | null) => Promise<void> | void;
}) {
  const [open, setOpen] = React.useState(false);
  const [status, setStatus] = React.useState("");
  const [goal, setGoal] = React.useState("");
  const [dialog, setDialog] = React.useState<null | "goal" | "rollback" | "move" | "alert">(null);
  const [draft, setDraft] = React.useState("");
  const [error, setError] = React.useState("");
  const [alertText, setAlertText] = React.useState("");

  React.useEffect(() => {
    if (!threadId) {
      setGoal("");
      return undefined;
    }
    let cancelled = false;
    void api.appServer
      .request("thread/goal/get", { threadId })
      .then((result) => {
        if (cancelled) return;
        setGoal(String(result?.goal?.objective || result?.objective || ""));
      })
      .catch(() => {
        if (!cancelled) setGoal("");
      });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  if (!threadId) return null;

  function showAlert(text: string) {
    setAlertText(text);
    setDialog("alert");
  }

  async function saveGoal(objective: string) {
    setStatus(objective.trim() ? "正在保存目标…" : "正在清除目标…");
    try {
      if (!objective.trim()) {
        await api.appServer.request("thread/goal/clear", { threadId });
        setGoal("");
        setStatus("已清除目标");
      } else {
        await api.appServer.request("thread/goal/set", {
          threadId,
          objective: objective.trim(),
          status: "active",
        });
        setGoal(objective.trim());
        setStatus("已保存目标");
      }
      setDialog(null);
    } catch (err) {
      setStatus(String(err));
      setError(String(err));
    }
  }

  async function rollback(input: string) {
    const numTurns = Number(input);
    if (!Number.isInteger(numTurns) || numTurns < 1) {
      setError("回滚回合数必须是正整数");
      return;
    }
    setStatus(`正在回滚最近 ${numTurns} 个回合…`);
    try {
      await api.appServer.request("thread/rollback", { threadId, numTurns });
      setStatus(`已回滚 ${numTurns} 个回合`);
      setDialog(null);
      await onReloaded();
    } catch (err) {
      setStatus(String(err));
      setError(String(err));
    }
  }

  async function compact() {
    setStatus("正在压缩上下文…");
    try {
      await api.appServer.request("thread/compact/start", { threadId });
      setStatus("已开始压缩上下文");
      await onReloaded();
    } catch (err) {
      setStatus(String(err));
    }
  }

  async function moveToProject(projectId: string) {
    const project = projectId === "none" ? null : projects.find((item) => String(item.id || item.path) === projectId) || null;
    setStatus(project ? `正在移到 ${project.name}…` : "正在移出项目…");
    try {
      await onAssigned?.(project);
      setStatus(project ? `已移到 ${project.name}` : "已移出项目");
      setDialog(null);
    } catch (err) {
      setStatus(String(err));
      setError(String(err));
    }
  }

  return (
    <div className="thread-history-menu">
      <button
        type="button"
        className={`thread-panel-toggle ${open ? "active" : ""}`}
        title="线程操作"
        aria-label="线程操作"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <UiIcon icon={icons.more} />
      </button>
      {open && (
        <div className="thread-history-popup">
          {goal && <div className="thread-history-goal">{goal}</div>}
          <button type="button" disabled={busy} onClick={() => { setOpen(false); setError(""); setDraft(goal); setDialog("goal"); }}>
            {goal ? "编辑目标" : "设置目标"}
          </button>
          <button type="button" disabled={busy} onClick={() => { setOpen(false); void compact(); }}>
            压缩上下文
          </button>
          <button type="button" disabled={busy} onClick={() => { setOpen(false); setError(""); setDraft("1"); setDialog("rollback"); }}>
            回滚回合
          </button>
          <button type="button" disabled={busy} onClick={() => {
            setOpen(false);
            if (!projects.length) {
              showAlert("还没有可移动到的项目");
              return;
            }
            setError("");
            setDraft(projects[0]?.id || projects[0]?.path || "none");
            setDialog("move");
          }}>
            移动到项目
          </button>
          {status && <small>{status}</small>}
        </div>
      )}
      {dialog === "goal" && (
        <AppDialog
          title="线程目标"
          message="留空则清除当前目标。"
          value={draft}
          placeholder="例如：补齐本地 Git 工作流"
          confirmLabel="保存"
          multiline
          error={error}
          onChange={setDraft}
          onConfirm={(value) => void saveGoal(value)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "rollback" && (
        <AppDialog
          title="回滚回合"
          message="只改对话历史，不会撤销工作区文件。"
          value={draft}
          placeholder="1"
          confirmLabel="回滚"
          error={error}
          onChange={setDraft}
          onConfirm={(value) => void rollback(value)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "move" && (
        <AppDialog
          title="移动到项目"
          message="当前对话会归到所选项目。"
          value={draft}
          options={[
            { id: "none", label: "不在项目中", sub: "放到最近对话" },
            ...projects.map((project) => ({
              id: String(project.id || project.path),
              label: project.name,
              sub: project.path,
            })),
          ]}
          confirmLabel="移动"
          error={error}
          onChange={setDraft}
          onConfirm={(value) => void moveToProject(value)}
          onCancel={() => setDialog(null)}
        />
      )}
      {dialog === "alert" && (
        <AppDialog
          title="无法移动"
          message={alertText}
          hideCancel
          confirmLabel="知道了"
          onConfirm={() => setDialog(null)}
          onCancel={() => setDialog(null)}
        />
      )}
    </div>
  );
}
