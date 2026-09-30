import React from "react";
import { DocxEditor } from "@eigenpal/docx-editor-react";
import { collectHeadings } from "@eigenpal/docx-editor-core/utils";
import "@eigenpal/docx-editor-react/styles.css";
import { useAppTheme } from "../../hooks/useAppTheme";
import { loadFileBytes } from "./loadFileBytes";

export default function WordPreview({ path, fallbackText }: { path: string; fallbackText?: string }) {
  const theme = useAppTheme();
  const [buffer, setBuffer] = React.useState<ArrayBuffer | null>(null);
  const [error, setError] = React.useState("");
  const [showOutline, setShowOutline] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setBuffer(null);
    setError("");
    setShowOutline(false);
    void loadFileBytes(path).then((bytes) => {
      if (!cancelled) setBuffer(bytes.slice(0));
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [path]);

  if (error) return <pre className="office-visual-fallback">{fallbackText || error}</pre>;
  if (!buffer) return <div className="office-visual-status">正在打开文档…</div>;
  return <div className="office-word-host" data-theme={theme}>
    <DocxEditor
      documentBuffer={buffer}
      mode="viewing"
      showToolbar
      showFileOpen={false}
      showHelpMenu={false}
      showOutline={showOutline}
      colorMode={theme}
      onEditorViewReady={(view) => {
        setShowOutline(collectHeadings(view.state.doc).length > 0);
      }}
    />
  </div>;
}
