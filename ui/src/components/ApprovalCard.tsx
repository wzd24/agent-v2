import React from "react";
import { api } from "../api";

export type ApprovalRequest = {
  id: number | string;
  title: string;
  detail: string;
  kind?: "decision" | "input" | "mcp" | "permissions";
  canRemember?: boolean;
  params?: { url?: string; mode?: string; requestedSchema?: any };
};

export function ApprovalCard({
  approval,
  onApproval,
}: {
  approval: ApprovalRequest;
  onApproval: (decision: string, answer?: string) => void;
}) {
  const [answer, setAnswer] = React.useState("");
  const needsText =
    approval.kind === "input" ||
    (approval.kind === "mcp" && !approval.canRemember && !approval.params?.url);
  React.useEffect(() => {
    setAnswer("");
  }, [approval.id]);
  return (
    <div className="approval-inline" role="dialog" aria-label={approval.title}>
      <strong>
        {needsText ? approval.title : `需要批准 · ${approval.title}`}
      </strong>
      <span>{approval.detail}</span>
      {approval.kind === "mcp" && approval.params?.url ? (
        <button
          type="button"
          className="btn"
          onClick={() => void api.app.openExternalUrl(String(approval.params?.url))}
        >
          在浏览器打开
        </button>
      ) : null}
      {needsText ? (
        <div className="approval-input-row">
          <input
            value={answer}
            onChange={(event) => setAnswer(event.target.value)}
            placeholder={approval.kind === "mcp" ? "输入文本或 JSON…" : "输入回答…"}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                onApproval("submit", answer);
              }
            }}
          />
          <button
            type="button"
            className="btn primary"
            onClick={() => onApproval("submit", answer)}
          >
            提交
          </button>
          <button
            type="button"
            className="btn danger"
            onClick={() => onApproval("cancel")}
          >
            取消
          </button>
        </div>
      ) : (
        <div>
          <button
            type="button"
            className="btn primary"
            onClick={() => onApproval("accept")}
          >
            允许一次
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => onApproval("acceptForSession")}
          >
            本会话
          </button>
          {approval.canRemember ? (
            <button
              type="button"
              className="btn"
              onClick={() => onApproval("remember")}
            >
              记住
            </button>
          ) : null}
          <button
            type="button"
            className="btn danger"
            onClick={() => onApproval("decline")}
          >
            拒绝
          </button>
        </div>
      )}
    </div>
  );
}
