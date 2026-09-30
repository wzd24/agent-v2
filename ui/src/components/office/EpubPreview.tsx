import React from "react";
import ePub from "epubjs";
import { useAppTheme } from "../../hooks/useAppTheme";
import { loadFileBytes } from "./loadFileBytes";

type TocItem = { href?: string; label?: string; subitems?: TocItem[] };

type EpubRendition = {
  display: (target?: string) => Promise<void>;
  prev: () => Promise<void>;
  next: () => Promise<void>;
  resize: (width: number, height: number) => void;
  destroy: () => void;
  themes?: { default: (rules: Record<string, Record<string, string>>) => void };
};

type EpubBook = {
  ready: Promise<void>;
  destroy: () => void;
  loaded: {
    navigation: Promise<{ toc?: TocItem[] }>;
    metadata: Promise<{ title?: string; creator?: string }>;
  };
  renderTo: (element: HTMLElement, options: Record<string, unknown>) => EpubRendition;
};

function flattenToc(items: TocItem[] | undefined, depth = 0): Array<{ href: string; label: string; depth: number }> {
  const rows: Array<{ href: string; label: string; depth: number }> = [];
  for (const item of items || []) {
    const href = String(item.href || "").trim();
    if (href) rows.push({ href, label: item.label || "未命名章节", depth });
    rows.push(...flattenToc(item.subitems, depth + 1));
  }
  return rows;
}

function bodyTheme(theme: "light" | "dark") {
  return theme === "light"
    ? { background: "#fff", color: "#222" }
    : { background: "#1c1c1c", color: "#e8e8e8" };
}

export default function EpubPreview({ path, preview }: { path: string; preview?: Record<string, any> }) {
  const theme = useAppTheme();
  const viewRef = React.useRef<HTMLDivElement>(null);
  const [title, setTitle] = React.useState(String(preview?.title || "EPUB"));
  const [creator, setCreator] = React.useState(String(preview?.creator || ""));
  const [toc, setToc] = React.useState<Array<{ href: string; label: string; depth: number }>>([]);
  const [active, setActive] = React.useState("");
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(true);
  const renditionRef = React.useRef<EpubRendition | null>(null);

  React.useEffect(() => {
    const view = viewRef.current;
    if (!view) return undefined;
    let cancelled = false;
    let book: EpubBook | null = null;
    let rendition: EpubRendition | null = null;
    setLoading(true);
    setError("");
    void (async () => {
      const bytes = await loadFileBytes(path);
      if (cancelled) return;
      book = ePub(bytes, { replacements: "blobUrl" }) as unknown as EpubBook;
      await book.ready;
      if (cancelled) return;
      const [metadata, navigation] = await Promise.all([book.loaded.metadata, book.loaded.navigation]);
      if (cancelled) return;
      if (metadata?.title) setTitle(metadata.title);
      if (metadata?.creator) setCreator(metadata.creator);
      const rows = flattenToc(navigation?.toc);
      setToc(rows);
      rendition = book.renderTo(view, {
        width: "100%",
        height: "100%",
        flow: "paginated",
        spread: "none",
      });
      rendition.themes?.default?.({ body: bodyTheme(readAppTheme()) });
      renditionRef.current = rendition;
      await rendition.display(rows[0]?.href);
      if (rows[0]) setActive(rows[0].href);
      const rect = view.getBoundingClientRect();
      rendition.resize(Math.max(1, Math.floor(rect.width)), Math.max(1, Math.floor(rect.height)));
      setLoading(false);
    })().catch((reason) => {
      if (cancelled) return;
      setLoading(false);
      setError(reason instanceof Error ? reason.message : "无法打开 EPUB");
    });
    const observer = new ResizeObserver(() => {
      const current = renditionRef.current;
      const rect = view.getBoundingClientRect();
      if (!current || rect.width < 2 || rect.height < 2) return;
      current.resize(Math.floor(rect.width), Math.floor(rect.height));
    });
    observer.observe(view);
    return () => {
      cancelled = true;
      observer.disconnect();
      renditionRef.current = null;
      try { rendition?.destroy(); } catch { /* already gone */ }
      try { book?.destroy(); } catch { /* already gone */ }
    };
  }, [path]);

  React.useEffect(() => {
    renditionRef.current?.themes?.default?.({ body: bodyTheme(theme) });
  }, [theme]);

  const chapters = Array.isArray(preview?.chapters) ? preview.chapters as Array<{ title?: string; text?: string }> : [];
  return <div className="epub-reader" data-theme={theme} data-outline={toc.length > 0 ? "true" : "false"}>
    <aside>
      <header><strong>{title}</strong>{creator && <small>{creator}</small>}</header>
      <nav>
        {toc.map((item) => <button type="button" key={`${item.href}-${item.depth}`} className={item.href === active ? "active" : ""} style={{ paddingLeft: 10 + item.depth * 12 }} onClick={() => { setActive(item.href); void renditionRef.current?.display(item.href); }}>{item.label}</button>)}
      </nav>
    </aside>
    <div className="epub-stage">
      {error ? <pre className="epub-fallback">{chapters.map((chapter) => `${chapter.title || ""}\n${chapter.text || ""}`).join("\n\n") || preview?.text || error}</pre> : <div ref={viewRef} className="epub-view" />}
      {!error && <footer>
        <button type="button" onClick={() => void renditionRef.current?.prev()}>上一页</button>
        <span>{loading ? "正在打开…" : title}</span>
        <button type="button" onClick={() => void renditionRef.current?.next()}>下一页</button>
      </footer>}
    </div>
  </div>;
}

function readAppTheme(): "light" | "dark" {
  return document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
}
