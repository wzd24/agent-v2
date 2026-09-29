import React from "react";
import hljs from "highlight.js/lib/common";
import { highlightLanguageForPath } from "../monacoLanguage";
import { fileExtension } from "./office/loadFileBytes";

function highlight(source: string, filePath: string) {
  try {
    const language = highlightLanguageForPath(filePath);
    if (language && hljs.getLanguage(language)) return hljs.highlight(source, { language, ignoreIllegals: true }).value;
  } catch {
    /* fall through */
  }
  return source.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const WordPreview = React.lazy(() => import("./office/WordPreview"));
const ExcelPreview = React.lazy(() => import("./office/ExcelPreview"));
const PowerPointPreview = React.lazy(() => import("./office/PowerPointPreview"));
const PdfJsPreview = React.lazy(() => import("./office/PdfPreview"));
const EpubReader = React.lazy(() => import("./office/EpubPreview"));
const FontGlyphs = React.lazy(() => import("./office/FontPreview"));
const XmindMap = React.lazy(() => import("./office/XmindPreview"));
const RasterPreview = React.lazy(() => import("./office/RasterPreview"));
const ParquetTable = React.lazy(() => import("./office/ParquetPreview"));
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
  const extension = fileExtension(filePath);
  if (preview?.kind === "spreadsheet" && Array.isArray(preview.sheets)) {
    return <Visual><ExcelPreview path={filePath} sheets={preview.sheets} /></Visual>;
  }
  if (preview?.kind === "presentation") {
    if (extension === "pptx" || extension === "pptm") return <Visual><PowerPointPreview path={filePath} fallbackText={String(preview.text || content || "")} /></Visual>;
    return textFallback(content, preview);
  }
  if (preview?.kind === "pdf") return <Visual><PdfJsPreview path={filePath} fallbackText={String(preview.text || content || "")} /></Visual>;
  if (preview?.kind === "document") {
    if (extension === "docx" || extension === "dotx") return <Visual><WordPreview path={filePath} fallbackText={String(preview.text || content || "")} /></Visual>;
    return textFallback(content, preview);
  }
  if (preview?.kind === "archive") return <Visual><ArchiveBrowser path={filePath} preview={preview} /></Visual>;
  if (preview?.kind === "epub") return <Visual><EpubReader path={filePath} preview={preview} /></Visual>;
  if (preview?.kind === "font") return <Visual><FontGlyphs path={filePath} preview={preview} /></Visual>;
  if (preview?.kind === "xmind" && Array.isArray(preview.sheets)) return <Visual><XmindMap path={filePath} sheets={preview.sheets} /></Visual>;
  if (preview?.kind === "psd" || preview?.kind === "icns" || preview?.kind === "tiff" || preview?.kind === "heic") return <Visual><RasterPreview path={filePath} /></Visual>;
  if (preview?.kind === "parquet") return <Visual><ParquetTable path={filePath} /></Visual>;
  if (preview?.kind === "notebook" && Array.isArray(preview.cells)) {
    return <div className="office-preview notebook-preview">{preview.cells.map((cell: { index: number; type: string; source: string; executionCount?: number | null }) => <section className={`notebook-cell ${cell.type}`} key={cell.index}><header><span>{cell.type === "code" ? `In [${cell.executionCount ?? " "}]` : "Markdown"}</span></header><pre><code dangerouslySetInnerHTML={{ __html: highlight(cell.source || "", cell.type === "code" ? `${preview.language || "python"}.py` : "note.md") }} /></pre></section>)}</div>;
  }
  return <pre className="workspace-document-content"><code dangerouslySetInnerHTML={{ __html: highlight(content, filePath) }} /></pre>;
}
