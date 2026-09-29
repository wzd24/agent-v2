import React from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import Vditor from "vditor";
import "vditor/dist/index.css";
import { api } from "../../api";
import { assetSrc } from "./loadFileBytes";

const VDITOR_CDN = "./vditor";

function joinWorkspacePath(root: string, relative: string) {
  const parts = [...String(root || "").replace(/[\\/]+$/, "").split(/[\\/]/), ...String(relative || "").replace(/^[\\/]+/, "").split(/[\\/]/)].filter((part) => part && part !== ".");
  const stack: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      if (stack.length > 1 || (stack[0] && !/^[A-Za-z]:$/.test(stack[0]))) stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("\\");
}

function resolveBesideFile(filePath: string, href: string) {
  const raw = String(href || "").trim();
  if (!raw || /^(?:https?:|data:|mailto:|#)/i.test(raw)) return raw;
  let value = raw;
  try { value = decodeURIComponent(value); } catch { /* keep raw */ }
  value = value.replace(/^file:\/\/+?/i, "").replace(/^\/([A-Za-z]:[\\/])/, "$1").replace(/[?#].*$/, "");
  if (/^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")) return value;
  return joinWorkspacePath(filePath.replace(/[\\/][^\\/]+$/, ""), value);
}

function editorTheme() {
  const light = document.documentElement.getAttribute("data-theme") === "light";
  return light
    ? { theme: "classic" as const, content: "light", code: "github" }
    : { theme: "dark" as const, content: "dark", code: "native" };
}

function rewriteLocalImages(root: HTMLElement, filePath: string, resolveUrl?: (href: string) => string) {
  root.querySelectorAll("img").forEach((img) => {
    const raw = img.getAttribute("src") || "";
    if (!raw || /^(?:https?:|data:|blob:|asset:)/i.test(raw) || raw.includes("/vditor/")) return;
    if (img.dataset.rewritten === raw) return;
    const remote = resolveUrl?.(raw) || "";
    const src = /^https?:|^data:/i.test(remote) ? remote : assetSrc(resolveBesideFile(filePath, raw));
    if (!src) return;
    img.dataset.rewritten = raw;
    img.setAttribute("src", src);
  });
}

function MarkdownFallback({ path: filePath, content, onOpenFile }: { path: string; content: string; onOpenFile?: (path: string) => void }) {
  return <div className="workspace-markdown"><div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={(url) => (/^(?:https?:|mailto:|#)/i.test(url) ? defaultUrlTransform(url) : url)} components={{
    a: ({ href, children }) => {
      const local = resolveBesideFile(filePath, href || "");
      const remote = /^(?:https?:)/i.test(href || "");
      return <a href={href} onClick={(event) => {
        event.preventDefault();
        if (remote) void api.app.openExternalUrl(href || "");
        else if (local && onOpenFile) onOpenFile(local);
      }}>{children}</a>;
    },
    img: ({ src, alt }) => <MarkdownFallbackImage filePath={filePath} src={src} alt={alt} />,
  }}>{content}</ReactMarkdown></div></div>;
}

function MarkdownFallbackImage({ filePath, src, alt }: { filePath: string; src?: string; alt?: string }) {
  const remote = /^(?:https?:|data:)/i.test(src || "");
  const local = !remote && src ? assetSrc(resolveBesideFile(filePath, src)) : "";
  if (!src) return alt ? <span className="workspace-markdown-img-alt">{alt}</span> : null;
  if (remote) return <img src={src} alt={alt || ""} />;
  if (!local) return alt ? <span className="workspace-markdown-img-alt">{alt}</span> : null;
  return <img src={local} alt={alt || ""} />;
}

export default function MarkdownPreview({
  path: filePath,
  content,
  onOpenFile,
  onChange,
  onSave,
  resolveUrl,
  readOnly = false,
}: {
  path: string;
  content: string;
  onOpenFile?: (path: string) => void;
  onChange?: (value: string) => void;
  onSave?: (value: string) => void;
  resolveUrl?: (href: string) => string;
  readOnly?: boolean;
}) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const editorRef = React.useRef<Vditor | null>(null);
  const readyRef = React.useRef(false);
  const valueRef = React.useRef(content);
  const pathRef = React.useRef(filePath);
  const onChangeRef = React.useRef(onChange);
  const onSaveRef = React.useRef(onSave);
  const onOpenFileRef = React.useRef(onOpenFile);
  const resolveUrlRef = React.useRef(resolveUrl);
  const [failed, setFailed] = React.useState("");
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onOpenFileRef.current = onOpenFile;
  resolveUrlRef.current = resolveUrl;
  if (pathRef.current !== filePath) {
    pathRef.current = filePath;
    valueRef.current = content;
  }

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let editor: Vditor | null = null;
    let cancelled = false;
    readyRef.current = false;
    setFailed("");
    const initial = valueRef.current;
    const palette = editorTheme();
    const openHref = (href: string) => {
      if (!href || href.startsWith("#")) return;
      const resolved = resolveUrlRef.current?.(href) || href;
      if (/^https?:/i.test(resolved)) {
        void api.app.openExternalUrl(resolved);
        return;
      }
      const local = resolveBesideFile(filePath, resolved);
      if (local) onOpenFileRef.current?.(local);
    };
    try {
      editor = new Vditor(host, {
        value: initial,
        cdn: VDITOR_CDN,
        height: "100%",
        width: "100%",
        mode: "wysiwyg",
        lang: "zh_CN",
        theme: palette.theme,
        tab: "\t",
        cache: { enable: false },
        outline: { enable: true, position: "left" },
        toolbarConfig: { hide: readOnly, pin: true },
        counter: { enable: !readOnly, type: "markdown" },
        preview: {
          maxWidth: 920,
          theme: { current: palette.content },
          hljs: { style: palette.code },
          markdown: { footnotes: true, mark: true, toc: true, mathBlockPreview: true, codeBlockPreview: true },
          math: { engine: "KaTeX" },
        },
        link: {
          isOpen: false,
          click: (element) => openHref(element.getAttribute("href") || ""),
        },
        input: (value) => {
          valueRef.current = value;
          onChangeRef.current?.(value);
          rewriteLocalImages(host, filePath, resolveUrlRef.current);
        },
        keydown: (event) => {
          if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
            event.preventDefault();
            onSaveRef.current?.(editorRef.current?.getValue() || valueRef.current);
          }
        },
        after: () => {
          if (cancelled || !editor) return;
          readyRef.current = true;
          editorRef.current = editor;
          if (readOnly) editor.disabled();
          const pending = valueRef.current;
          if (pending !== editor.getValue()) editor.setValue(pending);
          rewriteLocalImages(host, filePath, resolveUrlRef.current);
        },
      });
      editorRef.current = editor;
    } catch (reason) {
      setFailed(reason instanceof Error ? reason.message : "无法打开 Markdown 预览");
      return undefined;
    }
    const images = new MutationObserver(() => rewriteLocalImages(host, filePath, resolveUrlRef.current));
    images.observe(host, { subtree: true, childList: true });
    const themes = new MutationObserver(() => {
      const next = editorTheme();
      if (editor && readyRef.current) editor.setTheme(next.theme, next.content, next.code);
    });
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => {
      cancelled = true;
      readyRef.current = false;
      images.disconnect();
      themes.disconnect();
      editorRef.current = null;
      try { editor?.destroy(); } catch { /* editor was still loading */ }
      host.innerHTML = "";
    };
  }, [filePath, readOnly]);

  React.useEffect(() => {
    const editor = editorRef.current;
    if (!readyRef.current || !editor) {
      valueRef.current = content;
      return;
    }
    if (content === editor.getValue()) return;
    valueRef.current = content;
    editor.setValue(content);
    const host = hostRef.current;
    if (host) rewriteLocalImages(host, filePath, resolveUrlRef.current);
  }, [content, filePath]);

  if (failed) return <MarkdownFallback path={filePath} content={content} onOpenFile={onOpenFile} />;
  return <div className="markdown-vditor"><div ref={hostRef} className="markdown-vditor-host" /></div>;
}
