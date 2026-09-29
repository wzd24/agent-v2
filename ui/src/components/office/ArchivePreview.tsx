import React from "react";
import { fileExtension, loadFileBytes } from "./loadFileBytes";
import wasmUrl from "node-unrar-js/esm/js/unrar.wasm?url";

type Entry = { name: string; size: number; directory: boolean };

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function cleanName(name: string) {
  return String(name || "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function listing(entries: Entry[], dir: string) {
  const prefix = dir ? `${dir}/` : "";
  const folders = new Map<string, Entry>();
  const files: Entry[] = [];
  for (const entry of entries) {
    const name = cleanName(entry.name);
    if (!name || name === dir) continue;
    if (prefix && !name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    const slash = rest.indexOf("/");
    if (slash >= 0) {
      const folder = rest.slice(0, slash);
      if (!folders.has(folder)) folders.set(folder, { name: folder, size: 0, directory: true });
    } else if (entry.directory) {
      folders.set(rest, { name: rest, size: 0, directory: true });
    } else {
      files.push({ name: rest, size: Number(entry.size || 0), directory: false });
    }
  }
  const sortByName = (left: Entry, right: Entry) => left.name.localeCompare(right.name);
  return [...folders.values()].sort(sortByName).concat(files.sort(sortByName));
}

async function listRar(buffer: ArrayBuffer): Promise<Entry[]> {
  const { createExtractorFromData } = await import("node-unrar-js");
  const wasmBinary = await fetch(wasmUrl).then((response) => response.arrayBuffer());
  const extractor = await createExtractorFromData({ wasmBinary, data: buffer });
  return [...extractor.getFileList().fileHeaders].map((header) => ({
    name: header.name,
    size: header.unpSize,
    directory: Boolean(header.flags?.directory),
  }));
}

async function list7z(buffer: ArrayBuffer): Promise<Entry[]> {
  const sevenZipFactory = (await import("7z-wasm")).default;
  const lines: string[] = [];
  const sevenZip = await sevenZipFactory({
    print: (text: string) => lines.push(text),
    printErr: () => undefined,
  });
  const name = "archive.7z";
  sevenZip.FS.writeFile(name, new Uint8Array(buffer));
  sevenZip.callMain(["l", "-slt", name]);
  const entries: Entry[] = [];
  for (const block of lines.join("\n").split(/\n\s*\n/)) {
    const path = /^Path = (.+)$/m.exec(block)?.[1]?.trim();
    if (!path || path === name) continue;
    const size = Number(/^Size = (\d+)$/m.exec(block)?.[1] || 0);
    const directory = /^Folder = \+$/m.test(block) || path.endsWith("/");
    entries.push({ name: path, size, directory });
  }
  return entries;
}

export default function ArchivePreview({ path, preview }: { path: string; preview: Record<string, any> }) {
  const provided = Array.isArray(preview.entries) ? preview.entries as Entry[] : [];
  const [entries, setEntries] = React.useState<Entry[]>(provided);
  const [dir, setDir] = React.useState("");
  const [error, setError] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const format = String(preview.format || fileExtension(path) || "archive");

  React.useEffect(() => {
    const known = Array.isArray(preview.entries) ? preview.entries as Entry[] : [];
    setDir("");
    setError("");
    if (known.length || (format !== "rar" && format !== "7z")) {
      setEntries(known);
      setLoading(false);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setEntries([]);
    void loadFileBytes(path).then((buffer) => format === "rar" ? listRar(buffer) : list7z(buffer)).then((next) => {
      if (!cancelled) setEntries(next);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "无法读取压缩包");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [path, format, preview.entries]);

  const rows = listing(entries, dir);
  const crumbs = dir ? dir.split("/") : [];
  return <div className="archive-browser">
    <header>
      <strong>{format}</strong>
      <span>{entries.length} 项{preview.truncated ? " · 仅显示前一部分" : ""}</span>
    </header>
    <nav>
      <button type="button" onClick={() => setDir("")}>根目录</button>
      {crumbs.map((crumb, index) => <button type="button" key={`${crumb}-${index}`} onClick={() => setDir(crumbs.slice(0, index + 1).join("/"))}>{crumb}</button>)}
    </nav>
    {error ? <pre className="office-visual-fallback">{error}</pre> : loading ? <div className="office-visual-status">正在读取压缩包…</div> : <div className="archive-list">
      {dir && <button type="button" className="archive-row" onClick={() => setDir(dir.split("/").slice(0, -1).join("/"))}><span>..</span><span /></button>}
      {rows.map((row) => <button type="button" className="archive-row" key={`${row.directory ? "d" : "f"}-${row.name}`} onClick={() => { if (row.directory) setDir(dir ? `${dir}/${row.name}` : row.name); }}><span>{row.directory ? `${row.name}/` : row.name}</span><span>{row.directory ? "文件夹" : formatBytes(row.size)}</span></button>)}
      {!rows.length && !dir && <div className="office-visual-status">压缩包是空的</div>}
    </div>}
    {format === "gzip" && preview.text && <pre className="archive-gzip">{preview.text}</pre>}
  </div>;
}
