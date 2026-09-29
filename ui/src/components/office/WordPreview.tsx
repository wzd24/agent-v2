import React from "react";
import { DocxEditor } from "@eigenpal/docx-editor-react";
import "@eigenpal/docx-editor-react/styles.css";
import { loadFileBytes } from "./loadFileBytes";

export default function WordPreview({ path, fallbackText }: { path: string; fallbackText?: string }) {
  const [buffer, setBuffer] = React.useState<ArrayBuffer | null>(null);
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    let cancelled = false;
    setBuffer(null);
    setError("");
    void loadFileBytes(path).then((bytes) => {
      if (!cancelled) setBuffer(bytes.slice(0));
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [path]);
  if (error) return <pre className="office-visual-fallback">{fallbackText || error}</pre>;
  if (!buffer) return <div className="office-visual-status">正在打开文档…</div>;
  return <div className="office-word-host">
    <DocxEditor documentBuffer={buffer} readOnly showFileOpen={false} showHelpMenu={false} showOutline={false} colorMode="light" />
  </div>;
}
