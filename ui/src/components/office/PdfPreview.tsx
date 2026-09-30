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

const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 2];

function flattenOutline(items: OutlineItem[] | undefined, depth = 0): Array<{ title: string; dest?: OutlineItem["dest"]; depth: number }> {
  const rows: Array<{ title: string; dest?: OutlineItem["dest"]; depth: number }> = [];
  for (const item of items || []) {
    rows.push({ title: item.title || "未命名", dest: item.dest, depth });
    rows.push(...flattenOutline(item.items, depth + 1));
  }
  return rows;
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
  const [outline, setOutline] = React.useState<Array<{ title: string; dest?: OutlineItem["dest"]; depth: number }>>([]);
  const [outlineOpen, setOutlineOpen] = React.useState(false);
  const [rendering, setRendering] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setError("");
    setPages(0);
    setPage(1);
    setOutline([]);
    setOutlineOpen(false);
    pdfRef.current = null;
    void (async () => {
      const data = new Uint8Array(await loadFileBytes(path));
      const pdf = await pdfjs.getDocument({ data }).promise;
      if (cancelled) {
        void pdf.destroy();
        return;
      }
      pdfRef.current = pdf;
      setPages(pdf.numPages);
      const tree = await pdf.getOutline() as OutlineItem[] | null;
      const rows = flattenOutline(tree || undefined);
      setOutline(rows);
      setOutlineOpen(rows.length > 0);
    })().catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => {
      cancelled = true;
      const current = pdfRef.current;
      pdfRef.current = null;
      void current?.destroy();
    };
  }, [path]);

  React.useEffect(() => {
    const host = hostRef.current;
    const pdf = pdfRef.current;
    if (!host || !pdf || pages === 0) return;
    let cancelled = false;
    setRendering(true);
    host.innerHTML = "";
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
        await pdfPage.render({ canvas, viewport }).promise;
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
      host.innerHTML = "";
    };
  }, [path, pages, zoom]);

  const scrollToPage = React.useCallback((number: number) => {
    const next = Math.min(Math.max(1, number), pages || 1);
    setPage(next);
    document.getElementById(`pdf-page-${next}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [pages]);

  const jumpOutline = React.useCallback(async (dest: OutlineItem["dest"]) => {
    const pdf = pdfRef.current;
    if (!pdf) return;
    const index = await pageIndexForDest(pdf, dest);
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
        {outline.length > 0 && <button type="button" className={outlineOpen ? "active" : ""} onClick={() => setOutlineOpen((open) => !open)} title="大纲">大纲</button>}
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
        <header>大纲</header>
        <nav>{outline.map((item, index) => <button type="button" key={`${item.title}-${index}`} style={{ paddingLeft: 10 + item.depth * 12 }} onClick={() => void jumpOutline(item.dest)}>{item.title}</button>)}</nav>
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
