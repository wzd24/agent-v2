import React from "react";
import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentProxy } from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { useAppTheme } from "../../hooks/useAppTheme";
import { loadFileBytes } from "./loadFileBytes";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 2];
const THUMB_WIDTH = 112;

function releasePdf(pdf: PDFDocumentProxy | null | undefined) {
  try {
    const task = pdf?.loadingTask;
    if (typeof task?.destroy === "function") void task.destroy().catch(() => {});
  } catch {
    /* document was already released */
  }
}

export default function PdfPreview({ path, fallbackText }: { path: string; fallbackText?: string }) {
  const theme = useAppTheme();
  const hostRef = React.useRef<HTMLDivElement>(null);
  const stageRef = React.useRef<HTMLDivElement>(null);
  const thumbRef = React.useRef<HTMLElement>(null);
  const pdfRef = React.useRef<PDFDocumentProxy | null>(null);
  const paintingRef = React.useRef(false);
  const [error, setError] = React.useState("");
  const [pages, setPages] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [zoom, setZoom] = React.useState(1);
  const [thumbsOpen, setThumbsOpen] = React.useState(true);
  const [rendering, setRendering] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    setError("");
    setPages(0);
    setPage(1);
    setThumbsOpen(true);
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
      setThumbsOpen(pdf.numPages > 1);
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
    paintingRef.current = true;
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
        const frame = document.createElement("figure");
        frame.id = `pdf-page-${number}`;
        frame.append(canvas);
        host.append(frame);
        const task = pdfPage.render({ canvas, viewport });
        tasks.push(task);
        await task.promise;
      }
      if (!cancelled) {
        paintingRef.current = false;
        setRendering(false);
      }
    })().catch((reason) => {
      if (!cancelled) {
        paintingRef.current = false;
        setError(reason instanceof Error ? reason.message : String(reason));
        setRendering(false);
      }
    });
    return () => {
      cancelled = true;
      paintingRef.current = false;
      for (const task of tasks) {
        try { task.cancel(); } catch { /* page already finished */ }
      }
      host.innerHTML = "";
    };
  }, [path, pages, zoom]);

  React.useEffect(() => {
    const rail = thumbRef.current;
    const pdf = pdfRef.current;
    if (!rail || !pdf || pages < 2 || !thumbsOpen || rendering || paintingRef.current) return;
    let cancelled = false;
    const tasks: Array<{ cancel: () => void }> = [];
    void (async () => {
      for (let number = 1; number <= pdf.numPages; number += 1) {
        if (cancelled) return;
        const canvas = rail.querySelector(`canvas[data-thumb-canvas="${number}"]`);
        if (!(canvas instanceof HTMLCanvasElement)) continue;
        const pdfPage = await pdf.getPage(number);
        const base = pdfPage.getViewport({ scale: 1 });
        const viewport = pdfPage.getViewport({ scale: THUMB_WIDTH / base.width });
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const task = pdfPage.render({ canvas, viewport });
        tasks.push(task);
        await task.promise;
      }
    })().catch(() => {
      /* cancelled renders reject after the sidebar closes */
    });
    return () => {
      cancelled = true;
      for (const task of tasks) {
        try { task.cancel(); } catch { /* page already finished */ }
      }
    };
  }, [path, pages, thumbsOpen, rendering]);

  const scrollToPage = React.useCallback((number: number) => {
    const next = Math.min(Math.max(1, number), pages || 1);
    setPage(next);
    document.getElementById(`pdf-page-${next}`)?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [pages]);

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

  React.useEffect(() => {
    thumbRef.current?.querySelector(`[data-thumb="${page}"]`)?.scrollIntoView({ block: "nearest" });
  }, [page, pages, thumbsOpen]);

  const zoomLabel = `${Math.round(zoom * 100)}%`;
  const zoomIndex = ZOOM_STEPS.indexOf(zoom);
  const showThumbs = thumbsOpen && pages > 1;

  return <div className="office-pdfjs" data-theme={theme}>
    <header className="office-pdfjs-toolbar">
      <div className="office-pdfjs-toolbar-group">
        {pages > 1 && <button type="button" className={showThumbs ? "active" : ""} onClick={() => setThumbsOpen((open) => !open)} title="缩略图">缩略图</button>}
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
      {showThumbs && <aside ref={thumbRef} className="office-pdfjs-thumbs">
        {Array.from({ length: pages }, (_, index) => {
          const number = index + 1;
          return <button type="button" key={number} data-thumb={number} className={page === number ? "active" : ""} onClick={() => scrollToPage(number)}>
            <span className="office-pdfjs-thumb-frame"><canvas data-thumb-canvas={number} /></span>
            <span>{number}</span>
          </button>;
        })}
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
