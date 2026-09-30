import React from "react";
import { useAppTheme } from "../../hooks/useAppTheme";
import { loadFileBytes, fileExtension } from "./loadFileBytes";
import { imageMime, type OfficeRoute } from "./officeViewerRoute";

const VIEWER_ROOT = "/office-viewer";
const pdfTemplate = loadTemplate(`${VIEWER_ROOT}/pdf/viewer.html`);
const appTemplate = loadTemplate(`${VIEWER_ROOT}/webview/index.html`);

function loadTemplate(url: string) {
  return fetch(url).then((response) => {
    if (!response.ok) throw new Error("缺少 Office Viewer 预览资源");
    return response.text();
  });
}

function appHasBackgroundImage() {
  return Boolean(document.querySelector(".app-frame.background-images-enabled"));
}

function vscodeThemeCss(theme: "light" | "dark") {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  const light = theme === "light";
  const panel = read("--panel", light ? "#f3f3f3" : "#1e1e1e");
  const panel2 = read("--panel-2", light ? "#e8e8e8" : "#2a2d2e");
  const text = read("--text", light ? "#1f1f1f" : "#e8e8e8");
  const muted = read("--muted", light ? "#616161" : "#9d9d9d");
  const border = read("--border", light ? "#d0d0d0" : "#2b2b2b");
  const seeThrough = !light && appHasBackgroundImage();
  const paper = seeThrough ? "color-mix(in srgb, #101010 42%, transparent)" : light ? "#ffffff" : panel;
  const chrome = seeThrough ? `color-mix(in srgb, ${panel} 74%, transparent)` : panel;
  const editorBg = seeThrough ? "transparent" : read("--bg", light ? "#f7f7f5" : "#1a1a1a");
  const hover = light ? "rgba(0,0,0,0.06)" : "rgba(255,255,255,0.08)";
  const selected = light ? "#cce5ff" : "#094771";
  const input = light ? "#ffffff" : "#3c3c3c";
  return [
    `color-scheme:${light ? "light" : "dark"}`,
    `--vscode-font-family:var(--font,Segoe WPC,Segoe UI,sans-serif)`,
    `--vscode-font-size:13px`,
    `--vscode-foreground:${text}`,
    `--vscode-editor-foreground:${text}`,
    `--vscode-descriptionForeground:${muted}`,
    `--vscode-input-placeholderForeground:${muted}`,
    `--vscode-editor-background:${editorBg}`,
    `--vscode-tab-inactiveBackground:${paper}`,
    `--vscode-editorGroupHeader-tabsBackground:${chrome}`,
    `--vscode-editorWidget-background:${chrome}`,
    `--vscode-sideBar-background:${chrome}`,
    `--vscode-sideBarSectionHeader-background:${chrome}`,
    `--vscode-sideBar-foreground:${text}`,
    `--vscode-dropdown-background:${input}`,
    `--vscode-input-background:${input}`,
    `--vscode-input-foreground:${text}`,
    `--vscode-menu-background:${panel}`,
    `--vscode-menu-selectionBackground:${selected}`,
    `--vscode-menu-selectionForeground:${text}`,
    `--vscode-menu-separatorBackground:${border}`,
    `--vscode-focusBorder:#007fd4`,
    `--vscode-textLink-foreground:#4ea1ff`,
    `--vscode-button-foreground:${light ? text : "#ffffff"}`,
    `--vscode-list-hoverBackground:${hover}`,
    `--vscode-list-activeSelectionBackground:${selected}`,
    `--vscode-list-activeSelectionForeground:${light ? text : "#ffffff"}`,
    `--vscode-toolbar-hoverBackground:${hover}`,
    `--vscode-panel-border:${border}`,
    `--vscode-editorWidget-border:${border}`,
    `--vscode-input-border:${border}`,
    `--vscode-widget-border:${border}`,
    `--vscode-scrollbarSlider-background:${light ? "#64646433" : "#79797966"}`,
    `--vscode-scrollbarSlider-hoverBackground:${light ? "#64646466" : "#646464b3"}`,
    `--vscode-button-secondaryBackground:${panel2}`,
    `--vscode-button-secondaryHoverBackground:${hover}`,
    `--vscode-progressBar-background:#0078d4`,
    `--vscode-inputValidation-errorBackground:#5a1d1d`,
  ].join(";");
}

function hostShim(theme: "light" | "dark") {
  const page = ".word-viewer--vscode-theme .layout-page{background-color:var(--vscode-tab-inactiveBackground)!important}";
  return `<script>window.acquireVsCodeApi=function(){return{postMessage:function(message){parent.postMessage(message,"*")},getState:function(){return{}},setState:function(){}}}</script><style id="scorpio-office-theme">:root{${vscodeThemeCss(theme)}}${page}</style>`;
}

function injectHost(html: string, theme: "light" | "dark") {
  const head = hostShim(theme);
  if (html.includes("<head>")) return html.replace("<head>", `<head>${head}`);
  return `${head}${html}`;
}

function syncOfficeTheme(theme: "light" | "dark") {
  const mode = theme === "dark" ? "adaptive" : "light";
  try {
    localStorage.setItem("office-dark-mode", theme === "dark" ? "1" : "0");
    localStorage.setItem("office-word-color-mode", mode);
    localStorage.setItem("office-excel-color-mode", mode);
    localStorage.setItem("office-pdf-adaptive-theme", "1");
    localStorage.setItem("office-pdf-dark-mode", theme === "dark" ? "1" : "0");
    if (localStorage.getItem("vscode-office.pdf.sidebarOpen") == null) {
      localStorage.setItem("vscode-office.pdf.sidebarOpen", "1");
    }
  } catch {
    /* private mode can reject storage */
  }
}

function jsonAttr(value: unknown) {
  return JSON.stringify(value).replaceAll("&", "\\u0026").replaceAll("<", "\\u003c").replaceAll("'", "\\u0027");
}

async function viewerHtml(route: OfficeRoute, fileName: string, theme: "light" | "dark") {
  if (route === "pdf") {
    const html = await pdfTemplate;
    return injectHost(html.replace("{{baseUrl}}", `${VIEWER_ROOT}/pdf`), theme);
  }
  const html = await appTemplate;
  const configs = jsonAttr({
    route,
    fileName,
    language: "zh-cn",
    config: {},
  });
  return injectHost(
    html
      .replace('<base href="/">', `<base href="${VIEWER_ROOT}/webview/">`)
      .replace("{{configs}}", configs),
    theme,
  );
}

export default function OfficeViewerHost({ path, route }: { path: string; route: OfficeRoute }) {
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const theme = useAppTheme();
  const [error, setError] = React.useState("");

  React.useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return undefined;
    let cancelled = false;
    let bytesPromise: Promise<ArrayBuffer> | null = null;
    const fileName = path.split(/[\\/]/).pop() || path;
    const bytes = () => {
      bytesPromise ??= loadFileBytes(path);
      return bytesPromise;
    };
    const post = (type: string, content: unknown) => {
      frame.contentWindow?.postMessage({ type, content }, "*");
    };
    const fail = (reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "无法打开 Office Viewer");
    };
    const deliver = async () => {
      try {
        if (route === "svg") {
          post("open", { path: fileName, content: new TextDecoder().decode(await bytes()), readOnly: true });
          return;
        }
        if (route === "image") {
          const extension = fileExtension(path);
          post("images", {
            current: 0,
            images: [{
              title: fileName,
              src: fileName,
              ext: extension,
              mime: imageMime(extension),
              buffer: new Uint8Array(await bytes()),
            }],
          });
          return;
        }
        if (route === "zip") {
          const { describeArchive } = await import("./officeArchive");
          const archive = await describeArchive(path, await bytes());
          post("extension", archive.extension);
          post("size", archive.size);
          post("encrypted", archive.encrypted);
          post("data", archive.data);
          return;
        }
        post("open", {
          buffer: new Uint8Array(await bytes()),
          fileName,
          path: fileName,
          ext: fileExtension(path),
          readOnly: true,
          documentCacheId: path,
        });
      } catch (reason) {
        fail(reason);
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const type = event.data?.type;
      if (type === "init" || type === "images") void deliver();
      if (type === "openPath") {
        const entry = event.data?.content?.entry ?? event.data?.content;
        if (entry?.isDirectory) post("openDir", entry.entryName ?? "");
      }
    };

    setError("");
    syncOfficeTheme(theme);
    window.addEventListener("message", onMessage);
    void viewerHtml(route, fileName, theme).then((html) => {
      if (!cancelled) frame.srcdoc = html;
    }).catch(fail);

    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
      frame.srcdoc = "";
    };
  }, [path, route, theme]);

  return <>
    {error ? <div className="office-visual-status">{error}</div> : null}
    <iframe ref={frameRef} className="office-viewer-frame" title={path} hidden={Boolean(error) || undefined} />
  </>;
}
