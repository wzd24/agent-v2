import React from "react";
import * as pdfjs from "pdfjs-dist";
import pdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { loadFileBytes } from "./loadFileBytes";

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;

export default function PdfPreview({ path, fallbackText }: { path: string; fallbackText?: string }) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [error, setError] = React.useState("");
  const [pages, setPages] = React.useState(0);
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    setError("");
    setPages(0);
    host.innerHTML = "";
    void (async () => {
      const data = new Uint8Array(await loadFileBytes(path));
      const pdf = await pdfjs.getDocument({ data }).promise;
      if (cancelled) return;
      setPages(pdf.numPages);
      for (let number = 1; number <= pdf.numPages; number += 1) {
        if (cancelled) return;
        const page = await pdf.getPage(number);
        const viewport = page.getViewport({ scale: 1.35 });
        const canvas = document.createElement("canvas");
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const frame = document.createElement("figure");
        frame.append(canvas);
        const caption = document.createElement("figcaption");
        caption.textContent = String(number);
        frame.append(caption);
        host.append(frame);
        await page.render({ canvas, viewport }).promise;
      }
    })().catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { cancelled = true; };
  }, [path]);
  return <div className="office-pdfjs">
    {error && <pre className="office-visual-fallback">{fallbackText || error}</pre>}
    {!error && pages === 0 && <div className="office-visual-status">正在打开 PDF…</div>}
    <div ref={hostRef} className="office-pdfjs-pages" />
  </div>;
}
