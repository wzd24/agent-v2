import { fileExtension } from "./loadFileBytes";

export type OfficeRoute =
  | "pdf"
  | "image"
  | "svg"
  | "excel"
  | "word"
  | "ppt"
  | "font"
  | "epub"
  | "icns"
  | "psd"
  | "xmind"
  | "parquet"
  | "zip";

const images = new Set([
  "png", "apng", "jpg", "jpeg", "jfif", "pjpeg", "pjp", "gif", "bmp", "ico", "cur", "webp", "tif", "tiff", "heic", "heif",
]);
const archives = new Set(["zip", "jar", "apk", "vsix", "crx", "7z", "rar", "tar", "tgz", "tar.gz"]);

/** Route used by cweijan/vscode-office 4.2.0 for this file, or null when it has no viewer. */
export function officeViewerRoute(filePath: string): OfficeRoute | null {
  const extension = fileExtension(filePath);
  if (extension === "pdf") return "pdf";
  if (extension === "svg") return "svg";
  if (images.has(extension)) return "image";
  if (extension === "xlsx" || extension === "xlsm" || extension === "xls" || extension === "csv" || extension === "tsv" || extension === "ods") return "excel";
  if (extension === "docx" || extension === "dotx") return "word";
  if (extension === "pptx" || extension === "pptm") return "ppt";
  if (extension === "ttf" || extension === "woff" || extension === "woff2" || extension === "otf") return "font";
  if (extension === "epub") return "epub";
  if (extension === "icns") return "icns";
  if (extension === "psd") return "psd";
  if (extension === "xmind") return "xmind";
  if (extension === "parquet") return "parquet";
  if (archives.has(extension)) return "zip";
  return null;
}

export function imageMime(extension: string) {
  switch (extension) {
    case "png":
    case "apng":
      return "image/png";
    case "jpg":
    case "jpeg":
    case "jfif":
    case "pjpeg":
    case "pjp":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "bmp":
      return "image/bmp";
    case "webp":
      return "image/webp";
    case "ico":
    case "cur":
      return "image/x-icon";
    case "tif":
    case "tiff":
      return "image/tiff";
    case "heic":
    case "heif":
      return "image/heic";
    default:
      return "application/octet-stream";
  }
}
