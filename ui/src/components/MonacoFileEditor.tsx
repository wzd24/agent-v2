import React from "react";
import { ensureMonaco, monacoTheme, monacoWordWrap } from "../monacoEnv";
import { languageForPath } from "../monacoLanguage";

type Props = {
  path: string;
  value: string;
  onChange?: (value: string) => void;
  readOnly?: boolean;
  onSave?: () => void;
  wordWrap?: boolean;
  onContextMenu?: (event: { x: number; y: number; editor: import("monaco-editor").editor.IStandaloneCodeEditor }) => void;
};

export function MonacoFileEditor({ path, value, onChange, readOnly = false, onSave, wordWrap, onContextMenu }: Props) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const editorRef = React.useRef<import("monaco-editor").editor.IStandaloneCodeEditor | null>(null);
  const valueRef = React.useRef(value);
  const pathRef = React.useRef(path);
  const onChangeRef = React.useRef(onChange);
  const onSaveRef = React.useRef(onSave);
  const onContextMenuRef = React.useRef(onContextMenu);
  const readOnlyRef = React.useRef(readOnly);
  const wordWrapRef = React.useRef(wordWrap);
  valueRef.current = value;
  pathRef.current = path;
  onChangeRef.current = onChange;
  onSaveRef.current = onSave;
  onContextMenuRef.current = onContextMenu;
  readOnlyRef.current = readOnly;
  wordWrapRef.current = wordWrap;

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    let cancelled = false;
    let resize: ResizeObserver | undefined;
    let themeWatch: MutationObserver | undefined;
    void ensureMonaco().then((monaco) => {
      if (cancelled || !hostRef.current) return;
      const font = getComputedStyle(document.documentElement);
      const editor = monaco.editor.create(hostRef.current, {
        value: valueRef.current,
        language: languageForPath(pathRef.current),
        theme: monacoTheme(),
        readOnly: readOnlyRef.current,
        automaticLayout: false,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        fontSize: Number.parseFloat(font.getPropertyValue("--code-font-size")) || 12,
        fontFamily: font.getPropertyValue("--code-font-family").trim() || "Consolas, ui-monospace, monospace",
        fontWeight: font.getPropertyValue("--code-font-weight").trim() || "400",
        wordWrap: monacoWordWrap(wordWrapRef.current),
        lineNumbers: "on",
        renderLineHighlight: readOnlyRef.current ? "none" : "line",
        folding: true,
        padding: { top: 8, bottom: 16 },
        contextmenu: false,
        tabSize: 2,
        detectIndentation: true,
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
        overviewRulerLanes: 0,
        hideCursorInOverviewRuler: true,
        fixedOverflowWidgets: true,
        ariaLabel: pathRef.current,
      });
      editorRef.current = editor;
      editor.onDidChangeModelContent(() => {
        const next = editor.getValue();
        if (next !== valueRef.current) onChangeRef.current?.(next);
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
        if (!readOnlyRef.current) onSaveRef.current?.();
      });
      editor.onContextMenu((event) => {
        event.event.preventDefault();
        event.event.stopPropagation();
        onContextMenuRef.current?.({ x: event.event.posx, y: event.event.posy, editor });
      });
      resize = new ResizeObserver(() => editor.layout());
      resize.observe(hostRef.current);
      themeWatch = new MutationObserver(() => monaco.editor.setTheme(monacoTheme()));
      themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class"] });
    });
    return () => {
      cancelled = true;
      resize?.disconnect();
      themeWatch?.disconnect();
      editorRef.current?.dispose();
      editorRef.current = null;
    };
  }, []);

  React.useEffect(() => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model) return;
    void ensureMonaco().then((monaco) => {
      monaco.editor.setModelLanguage(model, languageForPath(path));
      if (model.getValue() !== value) {
        const position = editor.getPosition();
        const scroll = editor.getScrollTop();
        model.setValue(value);
        if (position) editor.setPosition(position);
        editor.setScrollTop(scroll);
      }
    });
  }, [path, value]);

  React.useEffect(() => {
    editorRef.current?.updateOptions({
      readOnly,
      renderLineHighlight: readOnly ? "none" : "line",
      wordWrap: monacoWordWrap(wordWrap),
    });
  }, [readOnly, wordWrap]);

  return <div className="monaco-file-editor" ref={hostRef} data-path={path} data-readonly={readOnly ? "true" : "false"} />;
}
