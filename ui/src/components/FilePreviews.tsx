import React from "react";
import hljs from "highlight.js/lib/common";
import { highlightLanguageForPath } from "../monacoLanguage";
import { officeViewerRoute } from "./office/officeViewerRoute";

function highlight(source: string, filePath: string) {
  try {
    const language = highlightLanguageForPath(filePath);
    if (language && hljs.getLanguage(language)) return hljs.highlight(source, { language, ignoreIllegals: true }).value;
  } catch {
    /* fall through */
  }
  return source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const OfficeViewerHost = React.lazy(() => import("./office/OfficeViewerHost"));
const ArchiveBrowser = React.lazy(() => import("./office/ArchivePreview"));

function Visual({ children }: { children: React.ReactNode }) {
  return <React.Suspense fallback={<div className="office-visual-status">正在打开预览…</div>}><div className="office-visual">{children}</div></React.Suspense>;
}

function textFallback(content: string, preview?: Record<string, any>) {
  return <pre className="office-visual-fallback">{String(preview?.text || content || "")}</pre>;
}

export function HtmlFilePreview({ content }: { content: string }) {
  return <iframe className="office-html-frame" sandbox="" srcDoc={content} title="HTML 预览" />;
}

export function StructuredPreview({ path: filePath, content, preview }: { path: string; content: string; preview?: Record<string, any> }) {
  const route = officeViewerRoute(filePath);
  if (route) return <Visual><OfficeViewerHost path={filePath} route={route} /></Visual>;
  if (preview?.kind === "presentation" || preview?.kind === "document") return textFallback(content, preview);
  if (preview?.kind === "archive") return <Visual><ArchiveBrowser path={filePath} preview={preview} /></Visual>;
  if (preview?.kind === "notebook" && Array.isArray(preview.cells)) {
    return <div className="office-preview notebook-preview">{preview.cells.map((cell: { index: number; type: string; source: string; executionCount?: number | null }) => <section className={`notebook-cell ${cell.type}`} key={cell.index}><header><span>{cell.type === "code" ? `In [${cell.executionCount ?? " "}]` : "Markdown"}</span></header><pre><code dangerouslySetInnerHTML={{ __html: highlight(cell.source || "", cell.type === "code" ? `${preview.language || "python"}.py` : "note.md") }} /></pre></section>)}</div>;
  }
  return <pre className="workspace-document-content"><code dangerouslySetInnerHTML={{ __html: highlight(content, filePath) }} /></pre>;
}
