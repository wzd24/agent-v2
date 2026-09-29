import React from "react";
import { assetSrc, loadFileBytes } from "./loadFileBytes";

type Glyph = {
  name?: string;
  unicode?: number;
  getPath: (x: number, y: number, fontSize: number) => { draw: (ctx: CanvasRenderingContext2D) => void };
};

const PAGE_SIZE = 80;

function glyphImage(glyph: Glyph) {
  const size = 64;
  const ratio = window.devicePixelRatio || 1;
  const canvas = document.createElement("canvas");
  canvas.width = size * ratio;
  canvas.height = size * ratio;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  ctx.scale(ratio, ratio);
  ctx.fillStyle = "#222";
  try {
    glyph.getPath(8, 50, 44).draw(ctx);
  } catch {
    return "";
  }
  return canvas.toDataURL();
}

function labelFor(glyph: Glyph) {
  if (glyph.unicode && glyph.unicode > 32) {
    try { return String.fromCodePoint(glyph.unicode); } catch { /* use the name */ }
  }
  return glyph.name || "glyph";
}

export default function FontPreview({ path, preview }: { path: string; preview: Record<string, any> }) {
  const format = ["truetype", "opentype", "woff", "woff2"].includes(preview.format) ? preview.format : "truetype";
  const family = `office-font-${path.replace(/[^a-z0-9]+/gi, "-").slice(-48)}`;
  const src = assetSrc(path);
  const sample = "Aa Bb Cc 0123 永和九年，岁在癸丑。 The quick brown fox jumps over the lazy dog.";
  const [glyphs, setGlyphs] = React.useState<Glyph[]>([]);
  const [note, setNote] = React.useState("");
  const [query, setQuery] = React.useState("");
  const [page, setPage] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    setGlyphs([]);
    setNote("");
    setQuery("");
    setPage(0);
    void loadFileBytes(path).then(async (buffer) => {
      const { parse } = await import("opentype.js");
      const font = parse(buffer);
      if (cancelled) return;
      const items: Glyph[] = [];
      const total = Math.min(font.glyphs.length, 4096);
      for (let index = 0; index < total; index += 1) {
        const glyph = font.glyphs.get(index) as Glyph | undefined;
        if (!glyph || glyph.name === ".notdef") continue;
        items.push(glyph);
      }
      setGlyphs(items);
      if (font.glyphs.length > total) setNote(`显示前 ${total} 个字形`);
    }).catch(() => {
      if (!cancelled) setNote("当前格式无法展开字形表，仍可查看字样。");
    });
    return () => { cancelled = true; };
  }, [path]);

  const filtered = React.useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return glyphs;
    return glyphs.filter((glyph) => {
      if (glyph.name?.toLowerCase().includes(needle)) return true;
      if (!glyph.unicode) return false;
      if (needle === String.fromCodePoint(glyph.unicode).toLowerCase()) return true;
      return glyph.unicode.toString(16).includes(needle.replace(/^u\+/, ""));
    });
  }, [glyphs, query]);
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const current = Math.min(page, pages - 1);
  const cards = React.useMemo(() => filtered.slice(current * PAGE_SIZE, current * PAGE_SIZE + PAGE_SIZE).map((glyph, index) => ({
    key: `${current}-${index}-${glyph.unicode || glyph.name || "glyph"}`,
    label: labelFor(glyph),
    name: glyph.unicode ? `U+${glyph.unicode.toString(16).toUpperCase()}` : (glyph.name || ""),
    image: glyphImage(glyph),
  })), [filtered, current]);

  return <div className="font-viewer">
    {src && <style>{`@font-face{font-family:"${family}";src:url("${src}") format("${format}");font-display:swap;}`}</style>}
    <header>
      <strong>{preview.fullName || preview.family || "字体"}</strong>
      <div className="font-viewer-sample" style={{ fontFamily: `"${family}", sans-serif` }}>{sample}</div>
    </header>
    <div className="font-viewer-tools">
      <input value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="搜索字形名称或字符" />
      <span>{filtered.length} 个字形{note ? ` · ${note}` : ""}</span>
      <button type="button" disabled={current <= 0} onClick={() => setPage((value) => Math.max(0, value - 1))}>上一页</button>
      <button type="button" disabled={current >= pages - 1} onClick={() => setPage((value) => value + 1)}>下一页</button>
    </div>
    <div className="font-glyph-grid">
      {cards.map((card) => <figure key={card.key}>{card.image ? <img src={card.image} alt={card.label} /> : <span className="font-glyph-char" style={{ fontFamily: `"${family}", sans-serif` }}>{card.label}</span>}<figcaption>{card.name}</figcaption></figure>)}
    </div>
  </div>;
}
