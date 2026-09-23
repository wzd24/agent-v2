import React, { useRef } from "react";
import { Model, api, modelLabel } from "../api";
import { icons, UiIcon } from "./UiIcon";
import { useAppDialog } from "./AppDialog";

function uniqueFiles(files: Array<File | null | undefined>): File[] {
  return [
    ...new Map(
      files
        .filter((file): file is File => Boolean(file))
        .map((file, index) => {
          const named = file.name
            ? file
            : new File([file], `pasted-file-${Date.now()}-${index + 1}`, {
                type: file.type || "application/octet-stream",
              });
          return [`${named.name}:${named.size}:${named.type}:${named.lastModified}`, named] as const;
        }),
    ).values(),
  ];
}

type MentionFile = { name: string; path: string };
type SlashCommand = { id: string; label: string; hint: string };

const SLASH_COMMANDS: SlashCommand[] = [
  { id: "compact", label: "压缩上下文", hint: "缩短当前线程的模型可见历史" },
  { id: "rollback", label: "回滚回合", hint: "/rollback 1" },
  { id: "goal", label: "设置目标", hint: "/goal 修复登录" },
  { id: "rename", label: "重命名线程", hint: "/rename 新标题" },
  { id: "archive", label: "归档线程", hint: "从侧栏隐藏当前线程" },
  { id: "new", label: "新对话", hint: "开始一条新线程" },
];

function mentionQueryAt(text: string, cursor: number) {
  const source = String(text || "");
  const at = Math.max(0, Math.min(source.length, Number(cursor) || 0));
  const before = source.slice(0, at);
  const match = before.match(/(^|[\s([{（【「])@([^\s@]*)$/);
  if (!match) return null;
  return { start: before.length - match[2].length - 1, query: match[2] };
}

function applyMention(text: string, cursor: number, file: MentionFile) {
  const mention = mentionQueryAt(text, cursor);
  const name = String(file.name || "").trim();
  if (!mention || !name) return { text, cursor };
  const replacement = `@${name} `;
  return {
    text: `${text.slice(0, mention.start)}${replacement}${text.slice(Math.max(0, cursor))}`,
    cursor: mention.start + replacement.length,
  };
}

function slashQueryAt(text: string, cursor: number) {
  const source = String(text || "");
  if (!source.startsWith("/")) return null;
  const at = Math.max(0, Math.min(source.length, Number(cursor) || 0));
  const newline = source.indexOf("\n");
  if (newline >= 0 && at > newline) return null;
  const line = newline < 0 ? source : source.slice(0, newline);
  const match = line.match(/^\/([a-z]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { command: String(match[1] || "").toLowerCase(), arg: String(match[2] || "").trim(), start: 0 };
}

function matchingSlashCommands(query: string) {
  const prefix = String(query || "").toLowerCase();
  return SLASH_COMMANDS.filter((item) => item.id.startsWith(prefix));
}

function parseSlashSubmit(text: string) {
  const source = String(text || "").trim();
  const match = source.match(/^\/(compact|rollback|goal|rename|archive|new)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { command: match[1].toLowerCase(), arg: String(match[2] || "").trim() };
}

function applySlashCommand(text: string, cursor: number, command: SlashCommand) {
  const slash = slashQueryAt(text, cursor);
  if (!slash) return { text, cursor };
  const replacement = ["rollback", "goal", "rename"].includes(command.id) ? `/${command.id} ` : `/${command.id}`;
  const newline = text.indexOf("\n");
  const after = newline < 0 ? "" : text.slice(newline);
  return { text: `${replacement}${after}`, cursor: replacement.length };
}

function filesFromTransfer(transfer: DataTransfer | null | undefined): File[] {
  if (!transfer) return [];
  const listed = Array.from(transfer.files || []);
  if (listed.length > 0) return uniqueFiles(listed);
  return uniqueFiles(
    Array.from(transfer.items || [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile()),
  );
}

export function Composer({
  value,
  onChange,
  onSend,
  models,
  model,
  onModelChange,
  mode,
  onModeChange,
  reasoningEffort,
  onReasoningEffortChange,
  activeTurn,
  onInterrupt,
  attachments,
  onAttach,
  onRemoveAttachment,
  voiceEnabled = false,
  disabled = false,
  submitBehavior,
  onSubmitBehaviorChange,
  queued = [],
  queueError = "",
  onSteerQueued,
  onEditQueued,
  onDeleteQueued,
  workspacePicker,
  onSearchMentions,
  onMention,
  onSlash,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: (behavior?: "queue" | "steer") => void;
  models: Model[];
  model: string;
  onModelChange: (value: string) => void;
  mode: string;
  onModeChange: (value: string) => void;
  reasoningEffort: string;
  onReasoningEffortChange: (value: string) => void;
  activeTurn: string | null;
  onInterrupt: () => void;
  attachments: Array<{ name: string; path?: string }>;
  onAttach: (files: FileList | File[] | null) => void;
  onRemoveAttachment: (name: string) => void;
  voiceEnabled?: boolean;
  disabled?: boolean;
  submitBehavior: "queue" | "steer";
  onSubmitBehaviorChange: (behavior: "queue" | "steer") => void;
  queued?: Array<{ id: string; text: string }>;
  queueError?: string;
  onSteerQueued: (id: string) => void;
  onEditQueued: (id: string) => void;
  onDeleteQueued: (id: string) => void;
  workspacePicker?: React.ReactNode;
  onSearchMentions?: (query: string) => Promise<MentionFile[]>;
  onMention?: (file: MentionFile) => void;
  onSlash?: (command: { command: string; arg: string }) => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const dialog = useAppDialog();
  const [listening, setListening] = React.useState(false);
  const [dragging, setDragging] = React.useState(false);
  const [queuedMenuId, setQueuedMenuId] = React.useState<string | null>(null);
  const [cursor, setCursor] = React.useState(0);
  const [mentionIndex, setMentionIndex] = React.useState(0);
  const [mentionFiles, setMentionFiles] = React.useState<MentionFile[]>([]);
  const canSteer = Boolean(activeTurn) && Boolean(value.trim() || attachments.length > 0);
  const mention = onSearchMentions ? mentionQueryAt(value, cursor) : null;
  const slash = !mention && onSlash ? slashQueryAt(value, cursor) : null;
  const slashCommands = slash ? matchingSlashCommands(slash.command) : [];
  const [slashIndex, setSlashIndex] = React.useState(0);
  React.useEffect(() => { setSlashIndex(0); }, [slash?.command]);
  React.useEffect(() => {
    if (!mention || !onSearchMentions) {
      setMentionFiles([]);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void onSearchMentions(mention.query).then((files) => {
        if (cancelled) return;
        setMentionFiles(files.slice(0, 8));
        setMentionIndex(0);
      }).catch(() => {
        if (!cancelled) setMentionFiles([]);
      });
    }, 80);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [mention?.query, mention?.start, onSearchMentions]);
  function submitSlash(command = parseSlashSubmit(value)) {
    if (!command || !onSlash) return false;
    onSlash(command);
    onChange("");
    setCursor(0);
    return true;
  }
  function chooseSlash(command: SlashCommand) {
    const next = applySlashCommand(value, cursor, command);
    onChange(next.text);
    setCursor(next.cursor);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(next.cursor, next.cursor);
    });
  }
  function chooseMention(file: MentionFile) {
    const next = applyMention(value, cursor, file);
    onChange(next.text);
    setCursor(next.cursor);
    onMention?.(file);
    setMentionFiles([]);
    window.requestAnimationFrame(() => {
      const input = inputRef.current;
      if (!input) return;
      input.focus();
      input.setSelectionRange(next.cursor, next.cursor);
    });
  }
  function listenHost() {
    if (!api.voice?.listen) {
      void dialog.alert("语音输入", "当前环境不支持语音输入");
      return;
    }
    setListening(true);
    void api.voice
      .listen("zh-CN")
      .then((result) => {
        const transcript = String(result?.text || "").trim();
        if (transcript) onChange(`${value}${value ? " " : ""}${transcript}`);
        else void dialog.alert("语音输入", "没有识别到语音");
      })
      .catch((error) => {
        void dialog.alert("语音输入", String(error || "语音识别失败"));
      })
      .finally(() => setListening(false));
  }
  function startVoice() {
    const Recognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition;
    if (Recognition) {
      const recognition = new Recognition();
      recognition.lang = "zh-CN";
      recognition.interimResults = false;
      recognition.onstart = () => setListening(true);
      recognition.onend = () => setListening(false);
      recognition.onerror = (event: any) => {
        setListening(false);
        const reason = String(event?.error || "");
        if (reason === "aborted" || reason === "no-speech") return;
        listenHost();
      };
      recognition.onresult = (event: any) => {
        const transcript = event.results?.[0]?.[0]?.transcript || "";
        if (transcript) onChange(`${value}${value ? " " : ""}${transcript}`);
      };
      try {
        recognition.start();
      } catch {
        listenHost();
      }
      return;
    }
    listenHost();
  }
  return (
    <div className="composer composer-v2">
      {dialog.node}
      {queued.length > 0 && (
        <div className="queued-submissions">
          {queued.map((submission) => (
            <div className="queued-submission" key={submission.id}>
              <span className="queued-message-icon"><UiIcon icon={icons.comments} /></span>
              <span className="queued-message-text">{submission.text}</span>
              <button type="button" className="queued-steer" title="Steer" onClick={() => onSteerQueued(submission.id)}>
                Steer
              </button>
              <span className="queued-actions">
                <button title="待处理消息菜单" onClick={() => setQueuedMenuId((current) => current === submission.id ? null : submission.id)}>
                  <UiIcon icon={icons.more} />
                </button>
                {queuedMenuId === submission.id && (
                  <div className="queued-message-menu">
                    <button type="button" onClick={() => { setQueuedMenuId(null); onEditQueued(submission.id); }}>
                      <UiIcon icon={icons.compose} /> 编辑消息
                    </button>
                    <button type="button" onClick={() => { setQueuedMenuId(null); onDeleteQueued(submission.id); }}>
                      <UiIcon icon={icons.close} /> 关闭排队
                    </button>
                  </div>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
      {queueError && <div className="queue-error" role="alert">{queueError}</div>}
      <div
        className={`composer-shell ${workspacePicker ? "has-workspace-picker" : ""} ${dragging ? "dragging" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          dragDepthRef.current += 1;
          setDragging(true);
        }}
        onDragOver={(event) => {
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={(event) => {
          event.preventDefault();
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) setDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          dragDepthRef.current = 0;
          setDragging(false);
          if (!disabled) onAttach(filesFromTransfer(event.dataTransfer));
        }}
      >
        {dragging && <div className="composer-drop-hint" aria-hidden="true">释放文件以添加附件</div>}
        {workspacePicker}
        {attachments.length > 0 && (
          <div className="composer-attachments">
            {attachments.map((file, index) => (
              <span className="composer-attachment" key={`${file.path || file.name}-${index}`} title={file.path || file.name}>
                <UiIcon icon={file.path ? icons.file : icons.paperclip} />
                {file.name}
                <button
                  title="移除附件"
                  onClick={() => onRemoveAttachment(file.name)}
                >
                  <UiIcon icon={icons.close} />
                </button>
              </span>
            ))}
          </div>
        )}
        {mention && mentionFiles.length > 0 && (
          <div className="composer-mentions" role="listbox" aria-label="引用工作区文件">
            {mentionFiles.map((file, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === mentionIndex}
                className={index === mentionIndex ? "active" : ""}
                key={file.path}
                title={file.path}
                onMouseDown={(event) => {
                  event.preventDefault();
                  chooseMention(file);
                }}
              >
                <strong>{file.name}</strong>
                <span>{file.path}</span>
              </button>
            ))}
          </div>
        )}
        {slash && slashCommands.length > 0 && (
          <div className="composer-mentions" role="listbox" aria-label="斜杠命令">
            {slashCommands.map((command, index) => (
              <button
                type="button"
                role="option"
                aria-selected={index === slashIndex}
                className={index === slashIndex ? "active" : ""}
                key={command.id}
                onMouseDown={(event) => {
                  event.preventDefault();
                  if (command.id === "compact" || command.id === "new" || command.id === "archive") submitSlash({ command: command.id, arg: "" });
                  else chooseSlash(command);
                }}
              >
                <strong>/{command.id}</strong>
                <span>{command.hint}</span>
              </button>
            ))}
          </div>
        )}
        <textarea
          id="composer-input"
          ref={inputRef}
          rows={3}
          value={value}
          disabled={disabled}
          onChange={(event) => {
            onChange(event.target.value);
            setCursor(event.target.selectionStart || 0);
          }}
          onClick={(event) => setCursor(event.currentTarget.selectionStart || 0)}
          onKeyUp={(event) => setCursor(event.currentTarget.selectionStart || 0)}
          onPaste={(event) => {
            const pastedFiles = filesFromTransfer(event.clipboardData);
            if (pastedFiles.length > 0) {
              event.preventDefault();
              onAttach(pastedFiles);
            }
          }}
          onKeyDown={(event) => {
            if (mention && mentionFiles.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setMentionIndex((current) => (current + 1) % mentionFiles.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setMentionIndex((current) => (current - 1 + mentionFiles.length) % mentionFiles.length);
                return;
              }
              if (event.key === "Enter" || event.key === "Tab") {
                event.preventDefault();
                chooseMention(mentionFiles[mentionIndex] || mentionFiles[0]);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                setMentionFiles([]);
                return;
              }
            }
            if (slash && slashCommands.length > 0) {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSlashIndex((current) => (current + 1) % slashCommands.length);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setSlashIndex((current) => (current - 1 + slashCommands.length) % slashCommands.length);
                return;
              }
              if (event.key === "Tab") {
                event.preventDefault();
                chooseSlash(slashCommands[slashIndex] || slashCommands[0]);
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                const selected = slashCommands[slashIndex] || slashCommands[0];
                const parsed = parseSlashSubmit(value);
                if (parsed) {
                  submitSlash(parsed);
                  return;
                }
                if (selected.id === "compact" || selected.id === "new" || selected.id === "archive") submitSlash({ command: selected.id, arg: "" });
                else chooseSlash(selected);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                onChange("");
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (submitSlash()) return;
              onSend(activeTurn ? "steer" : undefined);
            }
          }}
            placeholder={disabled ? "正在加载线程…" : "描述要让 Agent 做的事… 输入 @ 引用文件，/ 使用命令"}
        />
        <div className="composer-toolbar">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(event) => onAttach(event.target.files)}
          />
          <button
            className="composer-icon"
            title="添加上下文"
            disabled={disabled}
            onClick={() => fileRef.current?.click()}
          >
            <UiIcon icon={icons.plus} />
          </button>
          <button
            className="composer-tool"
            disabled={disabled}
            onClick={() => fileRef.current?.click()}
          >
            添加上下文
          </button>
          <button
            className={`composer-icon ${listening ? "listening" : ""}`}
            title={voiceEnabled ? "语音输入" : "在设置中启用语音"}
            disabled={disabled || !voiceEnabled}
            onClick={startVoice}
          >
            <UiIcon icon={icons.microphone} />
          </button>
          <span className="toolbar-divider" />
          <label className="toolbar-select">
            <span>模式</span>
            <select
              value={mode}
              disabled={disabled}
              onChange={(event) => onModeChange(event.target.value)}
            >
              <option>普通</option>
              <option>计划</option>
              <option>协作</option>
            </select>
          </label>
          <label className="toolbar-select">
            <span>模型</span>
            <select
              value={model}
              disabled={disabled}
              onChange={(event) => onModelChange(event.target.value)}
            >
              {models.map((item) => (
                <option
                  key={item.id || item.model}
                  value={item.model || item.id}
                >
                  {modelLabel(item)}
                </option>
              ))}
            </select>
          </label>
          <label className="toolbar-select reasoning-select">
            <span>推理强度</span>
            <select value={reasoningEffort} disabled={disabled} onChange={(event) => onReasoningEffortChange(event.target.value)}>
              <option value="low">低</option>
              <option value="medium">中</option>
              <option value="high">高</option>
              <option value="xhigh">极高</option>
              <option value="ultra">Ultra</option>
            </select>
          </label>
          <span className="toolbar-spacer" />
          {canSteer && (
            <button
              type="button"
              className="btn composer-stop-active"
              title="停止当前回合"
              disabled={disabled}
              onClick={onInterrupt}
            >
              <UiIcon icon={icons.stop} /> 停止
            </button>
          )}
          <button
            id="send"
            className={`btn ${activeTurn && !canSteer ? "composer-stop-active" : "primary composer-send"}`}
            disabled={disabled || (!activeTurn && !value.trim() && attachments.length === 0)}
            title={canSteer ? "Steer" : activeTurn ? "停止当前回合" : "发送消息"}
            onClick={() => {
              if (submitSlash()) return;
              if (canSteer) onSend("steer");
              else if (activeTurn) onInterrupt();
              else onSend(undefined);
            }}
          >
            {canSteer ? <>Steer <UiIcon icon={icons.arrowRight} /></> : activeTurn ? <><UiIcon icon={icons.stop} /> 停止</> : <>发送 <UiIcon icon={icons.arrowRight} /></>}
          </button>
        </div>
      </div>
    </div>
  );
}
