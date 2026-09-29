import React from "react";
import { PPTXViewer } from "pptxviewjs";
import { loadFileBytes } from "./loadFileBytes";

const THUMB_WIDTH = 192;
const THUMB_HEIGHT = 108;

export default function PowerPointPreview({ path, fallbackText }: { path: string; fallbackText?: string }) {
  const canvasRef = React.useRef<HTMLCanvasElement>(null);
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const viewerRef = React.useRef<PPTXViewer | null>(null);
  const [thumbs, setThumbs] = React.useState<string[]>([]);
  const [index, setIndex] = React.useState(0);
  const [count, setCount] = React.useState(0);
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);

  const renderSlide = React.useCallback(async (viewer: PPTXViewer, slide: number) => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    canvas.style.width = `${wrap.clientWidth}px`;
    canvas.style.height = `${wrap.clientHeight}px`;
    await viewer.goToSlide(slide, canvas);
    await viewer.render(canvas);
  }, []);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setThumbs([]);
    setIndex(0);
    setCount(0);
    void (async () => {
      const buffer = await loadFileBytes(path);
      if (cancelled) return;
      viewerRef.current?.destroy();
      const viewer = new PPTXViewer({ canvas, slideSizeMode: "fit", backgroundColor: "#ffffff" });
      await viewer.loadFile(buffer);
      if (cancelled) {
        viewer.destroy();
        return;
      }
      canvas.style.width = `${Math.max(wrap.clientWidth, 320)}px`;
      canvas.style.height = `${Math.max(wrap.clientHeight, 180)}px`;
      await viewer.render(canvas);
      const total = viewer.getSlideCount();
      viewerRef.current = viewer;
      setCount(total);
      setIndex(viewer.getCurrentSlideIndex());
      setLoading(false);
      const offscreen = document.createElement("canvas");
      offscreen.width = THUMB_WIDTH;
      offscreen.height = THUMB_HEIGHT;
      const urls: string[] = [];
      for (let slide = 0; slide < total; slide += 1) {
        if (cancelled) return;
        await viewer.renderSlide(slide, offscreen);
        urls.push(offscreen.toDataURL("image/jpeg", 0.85));
      }
      if (!cancelled) {
        setThumbs(urls);
        await renderSlide(viewer, viewer.getCurrentSlideIndex());
      }
    })().catch((reason) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
      viewerRef.current?.destroy();
      viewerRef.current = null;
    };
  }, [path, renderSlide]);

  React.useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const observer = new ResizeObserver(() => {
      const viewer = viewerRef.current;
      if (viewer) void renderSlide(viewer, viewer.getCurrentSlideIndex());
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [renderSlide]);

  return <div className="office-ppt">
    <aside>
      <header>{count ? `${count} 张幻灯片` : "幻灯片"}</header>
      <div>{thumbs.map((url, slide) => <button type="button" className={slide === index ? "active" : ""} key={url.slice(-12) + slide} onClick={() => {
        const viewer = viewerRef.current;
        if (!viewer) return;
        setIndex(slide);
        void renderSlide(viewer, slide);
      }}><img src={url} alt="" /><span>{slide + 1}</span></button>)}</div>
    </aside>
    <div className="office-ppt-main">
      {loading && <div className="office-visual-status">正在打开演示文稿…</div>}
      {error && <pre className="office-visual-fallback">{fallbackText || error}</pre>}
      <div ref={wrapRef} className="office-ppt-canvas"><canvas ref={canvasRef} /></div>
      {count > 0 && <footer>幻灯片 {index + 1} / {count}</footer>}
    </div>
  </div>;
}
