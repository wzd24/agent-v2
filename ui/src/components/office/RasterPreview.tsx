import React from "react";
import { fileExtension, loadFileBytes } from "./loadFileBytes";

function pngFromIcns(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  const magic = String.fromCharCode(bytes[0] || 0, bytes[1] || 0, bytes[2] || 0, bytes[3] || 0);
  if (magic !== "icns" || bytes.length < 8) throw new Error("不是有效的 ICNS 图标");
  const chunks: Uint8Array[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset + 4);
    if (length < 8 || offset + length > bytes.length) break;
    chunks.push(bytes.subarray(offset + 8, offset + length));
    offset += length;
  }
  const pngs = chunks.filter((chunk) => chunk[0] === 0x89 && chunk[1] === 0x50 && chunk[2] === 0x4e && chunk[3] === 0x47);
  const image = pngs.sort((left, right) => right.length - left.length)[0];
  if (!image) throw new Error("这个图标没有浏览器能显示的 PNG 图像");
  const copy = new Uint8Array(image.byteLength);
  copy.set(image);
  return [URL.createObjectURL(new Blob([copy.buffer], { type: "image/png" }))];
}

async function pagesFromTiff(buffer: ArrayBuffer) {
  const UTIF = (await import("utif")).default;
  const frames = UTIF.decode(buffer);
  if (!frames.length) throw new Error("TIFF 里没有图像");
  return frames.map((frame) => {
    UTIF.decodeImage(buffer, frame);
    const rgba = UTIF.toRGBA8(frame);
    const canvas = document.createElement("canvas");
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("无法绘制 TIFF");
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), frame.width, frame.height), 0, 0);
    return canvas.toDataURL("image/png");
  });
}

async function pagesFromHeic(buffer: ArrayBuffer) {
  const heic2any = (await import("heic2any")).default;
  const converted = await heic2any({ blob: new Blob([buffer]), toType: "image/jpeg", quality: 0.92, multiple: true });
  const blobs = Array.isArray(converted) ? converted : [converted];
  return blobs.map((blob) => URL.createObjectURL(blob));
}

async function pagesFromPsd(buffer: ArrayBuffer) {
  const { initializeCanvas, readPsd } = await import("ag-psd");
  initializeCanvas(
    (width, height) => {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      return canvas;
    },
    (width, height) => new ImageData(width, height),
  );
  const psd = readPsd(buffer);
  const source = psd.canvas;
  if (!source) throw new Error("这个 PSD 没有可显示的合成图像");
  return [source.toDataURL("image/png")];
}

export default function RasterPreview({ path }: { path: string }) {
  const [pages, setPages] = React.useState<string[]>([]);
  const [error, setError] = React.useState("");
  const extension = fileExtension(path);

  React.useEffect(() => {
    let cancelled = false;
    const created: string[] = [];
    setPages([]);
    setError("");
    void loadFileBytes(path).then(async (buffer) => {
      const next = extension === "icns"
        ? pngFromIcns(buffer)
        : extension === "tif" || extension === "tiff"
          ? await pagesFromTiff(buffer)
          : extension === "heic" || extension === "heif"
            ? await pagesFromHeic(buffer)
            : await pagesFromPsd(buffer);
      created.push(...next.filter((url) => url.startsWith("blob:")));
      if (!cancelled) setPages(next);
    }).catch((reason) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : "无法打开图像");
    });
    return () => {
      cancelled = true;
      for (const url of created) URL.revokeObjectURL(url);
    };
  }, [path, extension]);

  if (error) return <pre className="office-visual-fallback">{error}</pre>;
  if (!pages.length) return <div className="office-visual-status">正在打开图像…</div>;
  return <div className="raster-view">{pages.map((src, index) => <figure key={`${src}-${index}`}><img src={src} alt="" />{pages.length > 1 && <figcaption>{index + 1} / {pages.length}</figcaption>}</figure>)}</div>;
}
