import { convertFileSrc } from "@tauri-apps/api/core";

export function assetSrc(filePath: string) {
  const variants = [filePath, filePath.replaceAll("\\", "/"), filePath.replaceAll("/", "\\")];
  for (const variant of [...new Set(variants)]) {
    try {
      const src = convertFileSrc(variant);
      if (src) return src;
    } catch {
      /* try the next path form */
    }
  }
  return "";
}

export async function loadFileBytes(filePath: string) {
  const src = assetSrc(filePath);
  if (!src) throw new Error("无法读取文件");
  const response = await fetch(src);
  if (!response.ok) throw new Error("无法读取文件");
  return response.arrayBuffer();
}

export function fileExtension(filePath: string) {
  const base = filePath.split(/[\\/]/).pop()?.toLowerCase() || "";
  if (base.endsWith(".tar.gz")) return "tar.gz";
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1) : "";
}
