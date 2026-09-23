import React from "react";
import { icons, UiIcon } from "./UiIcon";

export function OutputSchemaEditor({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = React.useState(Boolean(value.trim()));
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    if (value.trim()) setOpen(true);
  }, [value]);
  function validate(next: string) {
    onChange(next);
    if (!next.trim()) {
      setError("");
      return;
    }
    try {
      const parsed = JSON.parse(next);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      setError("");
    } catch {
      setError("输出 Schema 必须是 JSON 对象");
    }
  }
  return (
    <div className={`output-schema-editor${open ? " open" : ""}${value.trim() ? " active" : ""}`}>
      <button
        type="button"
        className="output-schema-toggle"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        title="约束本回合最终回复的 JSON Schema"
      >
        <UiIcon icon={icons.code} />
        输出 Schema
        {value.trim() ? <span>已启用</span> : null}
      </button>
      {open && (
        <div className="output-schema-body">
          <textarea
            value={value}
            disabled={disabled}
            rows={6}
            spellCheck={false}
            placeholder={'{\n  "type": "object",\n  "properties": {\n    "summary": { "type": "string" }\n  },\n  "required": ["summary"]\n}'}
            onChange={(event) => validate(event.target.value)}
          />
          <small>{error || "发送时会校验 JSON，并作为 turn/start 的 outputSchema。清空则不约束。"}</small>
        </div>
      )}
    </div>
  );
}
