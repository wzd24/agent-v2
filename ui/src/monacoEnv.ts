import type * as Monaco from "monaco-editor";

let loading: Promise<typeof Monaco> | null = null;

export function ensureMonaco(): Promise<typeof Monaco> {
  if (!loading) loading = import("./monacoSetup").then((module) => module.monaco);
  return loading;
}

export function monacoTheme(): "vs" | "vs-dark" {
  return document.documentElement.getAttribute("data-theme") === "light" ? "vs" : "vs-dark";
}

export function monacoWordWrap(explicit?: boolean): "on" | "off" {
  if (explicit != null) return explicit ? "on" : "off";
  return document.documentElement.classList.contains("code-wrap") ? "on" : "off";
}
