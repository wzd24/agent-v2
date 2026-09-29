import React from "react";
import MindElixir from "mind-elixir";
import "mind-elixir/style.css";

type MindNode = { id: string; topic: string; children?: MindNode[] };
type SourceNode = { title?: string; children?: SourceNode[] };
type MindMap = {
  init: (data: { nodeData: MindNode }) => Promise<void>;
  destroy: () => void;
};

let nodeSeq = 0;

function toMindNode(node: SourceNode | undefined): MindNode {
  const children = (node?.children || []).filter(Boolean).map(toMindNode);
  const next: MindNode = { id: `n${nodeSeq += 1}`, topic: node?.title || "未命名" };
  if (children.length) next.children = children;
  return next;
}

export default function XmindPreview({ path, sheets }: { path: string; sheets: Array<{ name?: string; root?: SourceNode }> }) {
  const hostRef = React.useRef<HTMLDivElement>(null);
  const [active, setActive] = React.useState(0);
  const [error, setError] = React.useState("");
  const sheet = sheets[Math.min(active, Math.max(sheets.length - 1, 0))];

  React.useEffect(() => {
    const host = hostRef.current;
    if (!host || !sheet) return undefined;
    let cancelled = false;
    let map: MindMap | null = null;
    setError("");
    host.innerHTML = "";
    const nodeData = toMindNode(sheet.root);
    const instance = new MindElixir({
      el: host,
      direction: MindElixir.RIGHT,
      editable: false,
      contextMenu: false,
      toolBar: true,
      keypress: false,
    }) as unknown as MindMap;
    void instance.init({ nodeData }).then(() => {
      if (cancelled) instance.destroy();
      else map = instance;
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "无法打开思维导图");
    });
    return () => {
      cancelled = true;
      try { (map || instance).destroy(); } catch { /* map was still loading */ }
      host.innerHTML = "";
    };
  }, [path, sheet]);

  return <div className="xmind-view">
    {sheets.length > 1 && <div className="xmind-tabs">{sheets.map((item, index) => <button type="button" key={`${item.name || "sheet"}-${index}`} className={index === active ? "active" : ""} onClick={() => setActive(index)}>{item.name || `画布 ${index + 1}`}</button>)}</div>}
    {error ? <pre className="office-visual-fallback">{error}</pre> : <div ref={hostRef} className="xmind-map" />}
  </div>;
}
