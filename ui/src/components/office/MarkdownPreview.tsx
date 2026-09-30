import React from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../../api";
import { assetSrc } from "./loadFileBytes";

const OFFICE_MARKDOWN_CDN = "./office-markdown";

const MARKDOWN_TOOLBAR = [
  "outline",
  "headings",
  "bold",
  "italic",
  "strike",
  "link",
  "|",
  "editor-theme",
  "editor-theme-toggle",
  "|",
  "list",
  "ordered-list",
  "check",
  "table",
  "|",
  "quote",
  "code",
  "inline-code",
  "|",
  "undo",
  "redo",
  "|",
  "find",
  "settings",
];

type OfficeVditorInstance = {
  getValue: () => string;
  setValue: (value: string) => void;
  destroy: () => void;
  disabled: () => void;
  setEditorTheme?: (theme: string) => void;
  setMermaidTheme?: (theme: string) => void;
  setTheme?: (theme: string, content: string, code: string) => void;
  scrollToBlock?: (fragment: string) => void;
  vditor?: { element?: HTMLElement };
};

type OfficeVditor = {
  new (element: HTMLElement, options: Record<string, unknown>): OfficeVditorInstance;
  setCodeTheme?: (theme: string, element?: HTMLElement) => void;
};

let officeVditorLoad: Promise<OfficeVditor> | undefined;

function loadOfficeVditor() {
  const current = (window as unknown as { Vditor?: OfficeVditor }).Vditor;
  if (current) return Promise.resolve(current);
  officeVditorLoad ??= new Promise((resolve, reject) => {
    for (const href of [`${OFFICE_MARKDOWN_CDN}/dist/index.css`, `${OFFICE_MARKDOWN_CDN}/index.css`]) {
      if (document.querySelector(`link[href="${href}"]`)) continue;
      const link = document.createElement("link");
      link.rel = "stylesheet";
      link.href = href;
      document.head.appendChild(link);
    }
    const script = document.createElement("script");
    script.src = `${OFFICE_MARKDOWN_CDN}/dist/index.min.js`;
    script.onload = () => {
      const loaded = (window as unknown as { Vditor?: OfficeVditor }).Vditor;
      if (loaded) resolve(loaded);
      else reject(new Error("无法加载 Markdown 编辑器"));
    };
    script.onerror = () => reject(new Error("无法加载 Markdown 编辑器"));
    document.head.appendChild(script);
  });
  return officeVditorLoad;
}

function officeThemes() {
  const light = document.documentElement.getAttribute("data-theme") === "light";
  return light
    ? { editor: "Light", code: "Github", mermaid: "Light" }
    : { editor: "One Dark", code: "One Dark", mermaid: "Dark" };
}

function applyOfficeThemes(editor: OfficeVditorInstance, Vditor: OfficeVditor) {
  const themes = officeThemes();
  editor.setEditorTheme?.(themes.editor);
  editor.setMermaidTheme?.(themes.mermaid);
  Vditor.setCodeTheme?.(themes.code, editor.vditor?.element);
}

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
  const editorRef = React.useRef<OfficeVditorInstance | null>(null);
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
    let editor: OfficeVditorInstance | null = null;
    let vditorApi: OfficeVditor | null = null;
    let cancelled = false;
    readyRef.current = false;
    setFailed("");
    const initial = valueRef.current;
    const themes = officeThemes();
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
    const images = new MutationObserver(() => rewriteLocalImages(host, filePath, resolveUrlRef.current));
    images.observe(host, { subtree: true, childList: true });
    const themeWatcher = new MutationObserver(() => {
      if (editor && vditorApi && readyRef.current) applyOfficeThemes(editor, vditorApi);
    });
    themeWatcher.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    void loadOfficeVditor().then((Vditor) => {
      if (cancelled) return;
      vditorApi = Vditor;
      try {
        editor = new Vditor(host, {
          value: initial,
          cdn: OFFICE_MARKDOWN_CDN,
          height: "100%",
          width: "100%",
          mode: "wysiwyg",
          lang: "zh_CN",
          editorTheme: themes.editor,
          codeMirrorTheme: themes.code,
          mermaidTheme: themes.mermaid,
          tab: "\t",
          cache: { enable: false },
          toolbar: MARKDOWN_TOOLBAR,
          outline: { enable: true, position: "left" },
          toolbarConfig: { hide: readOnly, pin: true },
          onLinkClick(payload: { action?: string; href?: string }, event: MouseEvent) {
            const compose = event.metaKey || event.ctrlKey;
            if (payload.action !== "dblclick" && !(payload.action === "click" && compose)) return;
            const href = payload.href || "";
            if (href.startsWith("#")) {
              editor?.scrollToBlock?.(href);
              return;
            }
            openHref(href);
          },
          input: (value: string) => {
            valueRef.current = value;
            onChangeRef.current?.(value);
            rewriteLocalImages(host, filePath, resolveUrlRef.current);
          },
          keydown: (event: KeyboardEvent) => {
            if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
              event.preventDefault();
              onSaveRef.current?.(editorRef.current?.getValue() || valueRef.current);
            }
          },
          after: () => {
            if (cancelled || !editor) return;
            readyRef.current = true;
            editorRef.current = editor;
            applyOfficeThemes(editor, Vditor);
            if (readOnly) editor.disabled();
            const pending = valueRef.current;
            if (pending !== editor.getValue()) editor.setValue(pending);
            rewriteLocalImages(host, filePath, resolveUrlRef.current);
          },
        });
        editorRef.current = editor;
      } catch (reason) {
        setFailed(reason instanceof Error ? reason.message : "无法打开 Markdown 预览");
      }
    }).catch((reason: unknown) => {
      if (!cancelled) setFailed(reason instanceof Error ? reason.message : "无法打开 Markdown 预览");
    });
    return () => {
      cancelled = true;
      readyRef.current = false;
      images.disconnect();
      themeWatcher.disconnect();
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
