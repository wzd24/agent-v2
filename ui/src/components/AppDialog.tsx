import React from "react";
import { useCoverBrowser } from "../coverBrowser";
import { icons, UiIcon } from "./UiIcon";

export type AppDialogOption = { id: string; label: string; sub?: string };

export function AppDialog({
  title,
  message,
  value,
  placeholder,
  confirmLabel = "确定",
  cancelLabel = "取消",
  multiline = false,
  options,
  error,
  busy = false,
  hideCancel = false,
  hideConfirm = false,
  progress = null,
  onChange,
  onConfirm,
  onCancel,
}: {
  title: string;
  message?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  multiline?: boolean;
  options?: AppDialogOption[];
  error?: string;
  busy?: boolean;
  hideCancel?: boolean;
  hideConfirm?: boolean;
  progress?: { downloaded: number; total: number } | null;
  onChange?: (value: string) => void;
  onConfirm: (value: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  const inputRef = React.useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  useCoverBrowser(true);
  React.useEffect(() => {
    inputRef.current?.focus();
    if (inputRef.current && "select" in inputRef.current) inputRef.current.select();
  }, []);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busy) onCancel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [busy, onCancel]);

  function submit(event?: React.FormEvent) {
    event?.preventDefault();
    if (busy) return;
    void onConfirm(value || options?.[0]?.id || "");
  }

  return (
    <div className="new-project-modal-backdrop" role="presentation" onMouseDown={() => { if (!busy) onCancel(); }}>
      <form
        className="new-project-modal app-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={submit}
      >
        <div className="new-project-modal-head">
          <h2 id="app-dialog-title">{title}</h2>
          <button type="button" title="关闭" disabled={busy} onClick={onCancel}><UiIcon icon={icons.close} /></button>
        </div>
        {message ? <p className="app-dialog-message">{message}</p> : null}
        {progress ? (
          <div
            className="app-dialog-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progress.total || 100}
            aria-valuenow={progress.total ? Math.min(progress.downloaded, progress.total) : undefined}
          >
            <span style={{ width: progress.total > 0 ? `${Math.min(100, Math.round((progress.downloaded / progress.total) * 100))}%` : undefined }} className={progress.total > 0 ? "" : "indeterminate"} />
          </div>
        ) : null}
        {options ? (
          <div className="app-dialog-options" role="listbox" aria-label={title}>
            {options.map((option) => (
              <button
                type="button"
                role="option"
                aria-selected={value === option.id}
                className={value === option.id ? "selected" : ""}
                key={option.id}
                onClick={() => onChange?.(option.id)}
              >
                <strong>{option.label}</strong>
                {option.sub ? <small>{option.sub}</small> : null}
              </button>
            ))}
          </div>
        ) : onChange ? (
          multiline ? (
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              className="app-dialog-input"
              value={value || ""}
              placeholder={placeholder}
              rows={4}
              onChange={(event) => onChange(event.target.value)}
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              className="app-dialog-input"
              value={value || ""}
              placeholder={placeholder}
              onChange={(event) => onChange(event.target.value)}
            />
          )
        ) : null}
        {error ? <div className="new-project-error">{error}</div> : null}
        <div className="new-project-modal-actions">
          {!hideCancel && <button type="button" className="new-project-cancel" disabled={busy} onClick={onCancel}>{cancelLabel}</button>}
          {!hideConfirm && <button type="submit" className="new-project-submit" disabled={busy || Boolean(options && !value)}>{busy ? "处理中…" : confirmLabel}</button>}
        </div>
      </form>
    </div>
  );
}

type DialogRequest = {
  kind: "alert" | "confirm" | "prompt";
  title: string;
  message?: string;
  value: string;
  placeholder?: string;
  multiline?: boolean;
  confirmLabel?: string;
  resolve: (value: string | null) => void;
};

export function useAppDialog() {
  const [state, setState] = React.useState<DialogRequest | null>(null);
  const stateRef = React.useRef(state);
  stateRef.current = state;

  const close = React.useCallback((value: string | null) => {
    const current = stateRef.current;
    setState(null);
    current?.resolve(value);
  }, []);

  const show = React.useCallback((next: Omit<DialogRequest, "resolve">) => {
    return new Promise<string | null>((resolve) => {
      stateRef.current?.resolve(null);
      setState({ ...next, resolve });
    });
  }, []);

  const alert = React.useCallback(async (title: string, message?: string) => {
    await show({ kind: "alert", title, message, value: "" });
  }, [show]);

  const confirm = React.useCallback(async (title: string, message?: string) => {
    const result = await show({
      kind: "confirm",
      title,
      message,
      value: "",
      confirmLabel: "确认",
    });
    return result !== null;
  }, [show]);

  const prompt = React.useCallback(async (
    title: string,
    initial = "",
    options?: { message?: string; placeholder?: string; multiline?: boolean },
  ) => {
    return show({
      kind: "prompt",
      title,
      message: options?.message,
      value: initial,
      placeholder: options?.placeholder,
      multiline: options?.multiline,
    });
  }, [show]);

  const node = state ? (
    <AppDialog
      title={state.title}
      message={state.message}
      value={state.value}
      placeholder={state.placeholder}
      multiline={state.multiline}
      hideCancel={state.kind === "alert"}
      confirmLabel={state.kind === "alert" ? "知道了" : state.confirmLabel || "确定"}
      onChange={state.kind === "prompt" ? (value) => setState((old) => (old ? { ...old, value } : old)) : undefined}
      onConfirm={(value) => close(state.kind === "prompt" ? value : "")}
      onCancel={() => close(null)}
    />
  ) : null;

  return { alert, confirm, prompt, node };
}
