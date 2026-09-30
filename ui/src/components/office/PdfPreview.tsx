import React from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useAppTheme } from "../../hooks/useAppTheme";
import { loadFileBytes } from "./loadFileBytes";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

type OutlineItem = {
  title: string;
  dest?: string | unknown[] | null;
  items?: OutlineItem[];
};

type NavItem = {
  title: string;
  depth: number;
  dest?: OutlineItem["dest"];
  page?: number;
};

const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 2];

function flattenOutline(items: OutlineItem[] | undefined, depth = 0): NavItem[] {
  const rows: NavItem[] = [];
  for (const item of items || []) {
    const title = String(item.title || "").trim();
    if (title) rows.push({ title, dest: item.dest, depth });
    rows.push(...flattenOutline(item.items, depth + 1));
  }
  return rows;
}

function pageList(count: number): NavItem[] {
  return Array.from({ length: count }, (_, index) => ({ title: `第 ${index + 1} 页`, depth: 0, page: index + 1 }));
}

async function headingsFromText(pdf: PDFDocumentProxy): Promise<NavItem[]> {
  const lines: Array<{ text: string; size: number; bold: boolean; page: number }> = [];
  const sizes: number[] = [];
  for (let number = 1; number <= pdf.numPages; number += 1) {
    const pdfPage = await pdf.getPage(number);
    const content = await pdfPage.getTextContent();
    const styles = content.styles || {};
    const grouped = new Map<number, { text: string; size: number; bold: boolean }>();
    for (const item of content.items) {
      if (!("str" in item)) continue;
      const text = String(item.str || "");
      if (!text.trim()) continue;
      const transform = "transform" in item ? item.transform : [];
      const size = Math.abs(Number(transform?.[3] || ("height" in item ? item.height : 0) || 0));
      const y = Math.round(Number(transform?.[5] || 0) / 2) * 2;
      const fontName = "fontName" in item ? String(item.fontName || "") : "";
      const style = styles[fontName] as { fontFamily?: string; fontWeight?: string | number } | undefined;
      const weight = Number(style?.fontWeight || 0);
      const bold = weight >= 600 || /bold|black|heavy/i.test(`${style?.fontFamily || ""} ${fontName}`);
      const current = grouped.get(y);
      if (current) {
        current.text += text;
        current.size = Math.max(current.size, size);
        current.bold = current.bold || bold;
      } else {
        grouped.set(y, { text, size, bold });
      }
      if (size > 0) sizes.push(size);
    }
    for (const line of grouped.values()) {
      const text = line.text.replace(/\s+/g, " ").trim();
      if (text) lines.push({ text, size: line.size, bold: line.bold, page: number });
    }
  }
  sizes.sort((left, right) => left - right);
  const median = sizes[Math.floor(sizes.length / 2)] || 12;
  const rows: NavItem[] = [];
  for (const line of lines) {
    const short = line.text.length >= 2 && line.text.length <= 36;
    const large = line.size >= median * 1.18;
    const emphasized = line.bold && line.size >= median * 0.95 && line.text.length <= 28;
    if (!short || (!large && !emphasized)) continue;
    if (/^https?:|^\/\w|[{}[\]]/.test(line.text)) continue;
    const depth = line.size >= median * 1.55 ? 0 : line.size >= median * 1.3 ? 1 : 2;
    const previous = rows[rows.length - 1];
    if (previous && previous.title === line.text && previous.page === line.page) continue;
    rows.push({ title: line.text, depth, page: line.page });
    if (rows.length >= 80) break;
  }
  return rows;
}

function releasePdf(pdf: PDFDocumentProxy | null | undefined) {
  try {
    const task = pdf?.loadingTask;
    if (typeof task?.destroy === "function") void task.destroy().catch(() => {});
  } catch {
    /* document was already released */
  }
}

async function pageIndexForDest(pdf: PDFDocumentProxy, dest: OutlineItem["dest"]): Promise<number | null> {
  if (!dest) return null;
  let target = dest;
  if (typeof target === "string") {
    target = await pdf.getDestination(target);
  }
  if (!Array.isArray(target) || !target[0]) return null;
  try {
    return await pdf.getPageIndex(target[0] as Parameters<PDFDocumentProxy["getPageIndex"]>[0]);
  } catch {
    return null;
  }
}

export default function PdfPreview({ path, fallbackText }: { path: string; fallbackText?: string }) {
  const theme = useAppTheme();
  const hostRef = React.useRef<HTMLDivElement>(null);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const pdfRef = React.useRef<PDFDocumentProxy | null>(null);
  const [error, setError] = React.useState("");
  const [pages, setPages] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [zoom, setZoom] = React.useState(1);
  const [outline, setOutline] = React.useState<NavItem[]>([]);
  const [outlineKind, setOutlineKind] = React.useState<"outline" | "pages">("outline");
  const [outlineOpen, setOutlineOpen] = React.useState(false);
  const [rendering, setRendering] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setError("");
    setPages(0);
    setPage(1);
    setOutline([]);
    setOutlineKind("outline");
    setOutlineOpen(false);
    pdfRef.current = null;
    void (async () => {
      const data = new Uint8Array(await loadFileBytes(path));
      const pdf = await pdfjs.getDocument({ data }).promise;
      if (cancelled) {
        releasePdf(pdf);
        return;
      }
      pdfRef.current = pdf;
      setPages(pdf.numPages);
      const tree = await pdf.getOutline() as OutlineItem[] | null;
      let rows = flattenOutline(tree || undefined);
      let kind: "outline" | "pages" = "outline";
      if (!rows.length) rows = await headingsFromText(pdf);
      if (!rows.length && pdf.numPages > 1) {
        rows = pageList(pdf.numPages);
        kind = "pages";
      }
      if (cancelled) return;
      setOutline(rows);
      setOutlineKind(kind);
      setOutlineOpen(rows.length > 0);
    })().catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
      const current = pdfRef.current;
      pdfRef.current = null;
      releasePdf(current);
    };
  }, [path]);

  React.useEffect(() => {
    const host = hostRef.current;
    const pdf = pdfRef.current;
    if (!host || !pdf || pages === 0) return;
    let cancelled = false;
    setRendering(true);
    host.innerHTML = "";
    const tasks: Array<{ cancel: () => void }> = [];
    void (async () => {
      const scale = 1.35 * zoom;
      for (let number = 1; number <= pdf.numPages; number += 1) {
        if (cancelled) return;
        const pdfPage = await pdf.getPage(number);
        const viewport = pdfPage.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.dataset.page = String(number);
        const frame = document.createElement("figure");
        frame.id = `pdf-page-${number}`;
        frame.append(canvas);
        const caption = document.createElement("figcaption");
        caption.textContent = String(number);
        frame.append(caption);
        host.append(frame);
        const task = pdfPage.render({ canvas, viewport });
        tasks.push(task);
        await task.promise;
      }
      if (!cancelled) setRendering(false);
    })().catch((reason) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setRendering(false);
      }
    });
    return () => {
      cancelled = true;
      for (const task of tasks) {
        try { task.cancel(); } catch { /* page already finished */ }
      }
      host.innerHTML = "";
    };
  }, [path, pages, zoom]);

  const scrollToPage = React.useCallback((number: number) => {
    const next = Math.min(Math.max(1, number), pages || 1);
    setPage(next);
    document.getElementById(`pdf-page-${next}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [pages]);

  const jumpOutline = React.useCallback(async (item: NavItem) => {
    if (item.page) {
      scrollToPage(item.page);
      return;
    }
    const pdf = pdfRef.current;
    if (!pdf) return;
    const index = await pageIndexForDest(pdf, item.dest);
    if (index == null) return;
    scrollToPage(index + 1);
  }, [scrollToPage]);

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || !pages) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
      const number = Number((visible?.target as HTMLElement | undefined)?.id?.replace("pdf-page-", "") || 0);
      if (number > 0) setPage(number);
    }, { root: stageRef.current, threshold: [0.35, 0.55, 0.75] });
    host.querySelectorAll("figure").forEach((frame) => observer.observe(frame));
    return () => observer.disconnect();
  }, [pages, zoom, rendering]);

  const zoomLabel = `${Math.round(zoom * 100)}%`;
  const zoomIndex = ZOOM_STEPS.indexOf(zoom);

  return <div className="office-pdfjs" data-theme={theme}>
    <header className="office-pdfjs-toolbar">
      <div className="office-pdfjs-toolbar-group">
        {outline.length > 0 && <button type="button" className={outlineOpen ? "active" : ""} onClick={() => setOutlineOpen((open) => !open)} title={outlineKind === "pages" ? "页面" : "大纲"}>{outlineKind === "pages" ? "页面" : "大纲"}</button>}
        <button type="button" disabled={page <= 1} onClick={() => scrollToPage(page - 1)}>上一页</button>
        <span>{pages ? `${page} / ${pages}` : "…"}</span>
        <button type="button" disabled={!pages || page >= pages} onClick={() => scrollToPage(page + 1)}>下一页</button>
      </div>
      <div className="office-pdfjs-toolbar-group">
        <button type="button" disabled={zoomIndex <= 0} onClick={() => setZoom(ZOOM_STEPS[Math.max(0, zoomIndex - 1)])}>缩小</button>
        <span>{zoomLabel}</span>
        <button type="button" disabled={zoomIndex < 0 || zoomIndex >= ZOOM_STEPS.length - 1} onClick={() => setZoom(ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, zoomIndex + 1)])}>放大</button>
      </div>
    </header>
    <div className="office-pdfjs-body">
      {outlineOpen && outline.length > 0 && <aside className="office-pdfjs-outline">
        <header>{outlineKind === "pages" ? "页面" : "大纲"}</header>
        <nav>{outline.map((item, index) => <button type="button" key={`${item.title}-${item.page || index}`} className={item.page === page ? "active" : ""} style={{ paddingLeft: 10 + item.depth * 12 }} onClick={() => void jumpOutline(item)}>{item.title}</button>)}</nav>
      </aside>}
      <div ref={stageRef} className="office-pdfjs-stage">
        {error && <pre className="office-visual-fallback">{fallbackText || error}</pre>}
        {!error && pages === 0 && <div className="office-visual-status">正在打开 PDF…</div>}
        {!error && pages > 0 && rendering && <div className="office-visual-status office-pdfjs-rendering">正在渲染…</div>}
        <div ref={hostRef} className="office-pdfjs-pages" />
      </div>
    </div>
  </div>;
}
