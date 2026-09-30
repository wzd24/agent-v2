import wasmUrl from "node-unrar-js/esm/js/unrar.wasm?url";
import { fileExtension } from "./loadFileBytes";

type Entry = {
  name: string;
  size: number;
  packedSize: number;
  directory: boolean;
  encrypted: boolean;
  modified: string;
};

type ArchiveNode = {
  name: string;
  isDirectory: boolean;
  entryName: string;
  fileSize?: string;
  fileSizeOrigin?: number;
  compressedSize?: string;
  compressedSizeOrigin?: number;
  modifyDateTime?: string;
  children?: ArchiveNode[];
};

function formatBytes(size: number) {
  if (!Number.isFinite(size) || size < 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function cleanName(name: string) {
  return String(name || "").replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

function zipBytes(buffer: ArrayBuffer) {
  const bytes = new Uint8Array(buffer);
  const limit = Math.min(bytes.length - 4, 4096);
  for (let index = 0; index <= limit; index += 1) {
    if (bytes[index] === 0x50 && bytes[index + 1] === 0x4b && bytes[index + 2] === 0x03 && bytes[index + 3] === 0x04) {
      return bytes.slice(index).buffer;
    }
  }
  return buffer;
}

async function listRar(buffer: ArrayBuffer): Promise<Entry[]> {
  const { createExtractorFromData } = await import("node-unrar-js");
  const wasmBinary = await fetch(wasmUrl).then((response) => response.arrayBuffer());
  const extractor = await createExtractorFromData({ wasmBinary, data: buffer });
  return [...extractor.getFileList().fileHeaders].map((header) => ({
    name: header.name,
    size: header.unpSize,
    packedSize: header.packSize,
    directory: Boolean(header.flags?.directory),
    encrypted: Boolean(header.flags?.encrypted),
    modified: "",
  }));
}

async function gunzip(buffer: ArrayBuffer) {
  const stream = new Blob([buffer]).stream().pipeThrough(new DecompressionStream("gzip"));
  return await new Response(stream).arrayBuffer();
}

async function list7z(buffer: ArrayBuffer, extension: string): Promise<Entry[]> {
  const sevenZipFactory = (await import("7z-wasm")).default;
  const lines: string[] = [];
  const sevenZip = await sevenZipFactory({
    print: (text: string) => lines.push(text),
    printErr: () => undefined,
  });
  const archiveName = `archive.${extension || "zip"}`;
  sevenZip.FS.writeFile(archiveName, new Uint8Array(buffer));
  sevenZip.callMain(["l", "-slt", archiveName]);
  const entries: Entry[] = [];
  for (const block of lines.join("\n").split(/\n\s*\n/)) {
    const path = /^Path = (.+)$/m.exec(block)?.[1]?.trim();
    if (!path || path === archiveName) continue;
    const size = Number(/^Size = (\d+)$/m.exec(block)?.[1] || 0);
    const packedSize = Number(/^Packed Size = (\d+)$/m.exec(block)?.[1] || 0);
    const directory = /^Folder = \+$/m.test(block) || path.endsWith("/");
    const encrypted = /^Encrypted = \+$/m.test(block);
    const modified = /^Modified = (.+)$/m.exec(block)?.[1]?.trim() || "";
    entries.push({ name: path, size, packedSize, directory, encrypted, modified });
  }
  return entries;
}

function isGzipTar(extension: string) {
  return extension === "tgz" || extension === "tar.gz";
}

function archiveTree(entries: Entry[]) {
  const folderMap: Record<string, ArchiveNode> = {};
  const files: ArchiveNode[] = [];

  const ensureDir = (entryName: string): ArchiveNode => {
    const existing = folderMap[entryName];
    if (existing) return existing;
    const node: ArchiveNode = {
      name: entryName.split("/").pop() || entryName,
      isDirectory: true,
      entryName,
      children: [],
    };
    folderMap[entryName] = node;
    const slash = entryName.lastIndexOf("/");
    if (slash < 0) files.push(node);
    else ensureDir(entryName.slice(0, slash)).children?.push(node);
    return node;
  };

  for (const entry of entries) {
    const entryName = cleanName(entry.name);
    if (!entryName) continue;
    if (entry.directory) {
      ensureDir(entryName);
      continue;
    }
    const node: ArchiveNode = {
      name: entryName.split("/").pop() || entryName,
      isDirectory: false,
      entryName,
      fileSize: formatBytes(entry.size),
      fileSizeOrigin: entry.size,
      compressedSize: entry.packedSize > 0 ? formatBytes(entry.packedSize) : "",
      compressedSizeOrigin: entry.packedSize,
      modifyDateTime: entry.modified,
    };
    const slash = entryName.lastIndexOf("/");
    if (slash < 0) files.push(node);
    else ensureDir(entryName.slice(0, slash)).children?.push(node);
  }

  const sortNodes = (nodes: ArchiveNode[]) => {
    nodes.sort((left, right) => {
      if (left.isDirectory !== right.isDirectory) return left.isDirectory ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    for (const node of nodes) {
      if (node.children) sortNodes(node.children);
    }
  };
  sortNodes(files);
  for (const folder of Object.values(folderMap)) {
    if (folder.children) sortNodes(folder.children);
  }
  return { files, folderMap };
}

const MAX_EXTRACT_BYTES = 8 * 1024 * 1024;

export class ArchiveExtractError extends Error {
  readonly password: boolean;

  constructor(message: string, password = false) {
    super(message);
    this.name = "ArchiveExtractError";
    this.password = password;
  }
}

function safeEntry(name: string) {
  const cleaned = cleanName(name);
  if (!cleaned || cleaned.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new ArchiveExtractError("压缩包内路径无效");
  }
  return cleaned;
}

function passwordFailed(error: unknown) {
  const reason = String((error as { reason?: string })?.reason || error || "");
  return /password/i.test(reason);
}

async function extractRar(buffer: ArrayBuffer, entryName: string, password?: string) {
  const { createExtractorFromData } = await import("node-unrar-js");
  const wasmBinary = await fetch(wasmUrl).then((response) => response.arrayBuffer());
  const extractor = await createExtractorFromData({ wasmBinary, data: buffer, ...(password ? { password } : {}) });
  const wanted = new Set([entryName, entryName.replaceAll("/", "\\")]);
  let extracted;
  try {
    extracted = extractor.extract({
      files: (header) => wanted.has(cleanName(header.name)) || wanted.has(header.name),
      ...(password ? { password } : {}),
    });
  } catch (error) {
    throw new ArchiveExtractError(passwordFailed(error) ? "密码不正确" : "无法解压该文件", passwordFailed(error));
  }
  for (const file of extracted.files) {
    const bytes = file.extraction;
    if (!bytes || file.fileHeader.flags.directory) continue;
    if (bytes.byteLength > MAX_EXTRACT_BYTES) throw new ArchiveExtractError("文件超过 8MB，暂不支持预览");
    return bytes.slice();
  }
  throw new ArchiveExtractError(password ? "密码不正确" : "无法解压该文件", Boolean(password));
}

function readExtracted(fs: {
  readFile: (path: string) => Uint8Array;
  readdir: (path: string) => string[];
  stat: (path: string) => { mode: number };
  isDir: (mode: number) => boolean;
}, entryName: string) {
  const direct = `/out/${entryName}`;
  try {
    return fs.readFile(direct);
  } catch {
    /* 7-Zip may normalize the stored path */
  }
  const target = entryName.toLowerCase();
  const walk = (dir: string): Uint8Array | null => {
    let names: string[] = [];
    try {
      names = fs.readdir(dir);
    } catch {
      return null;
    }
    for (const name of names) {
      if (name === "." || name === "..") continue;
      const child = `${dir}/${name}`;
      let directory = false;
      try {
        directory = fs.isDir(fs.stat(child).mode);
      } catch {
        continue;
      }
      if (directory) {
        const found = walk(child);
        if (found) return found;
        continue;
      }
      const relative = child.slice("/out/".length).replaceAll("\\", "/").toLowerCase();
      if (relative === target) return fs.readFile(child);
    }
    return null;
  };
  return walk("/out");
}

async function extract7z(buffer: ArrayBuffer, extension: string, entryName: string, password?: string) {
  const sevenZipFactory = (await import("7z-wasm")).default;
  const errors: string[] = [];
  const sevenZip = await sevenZipFactory({
    noExitRuntime: true,
    print: () => undefined,
    printErr: (text: string) => {
      if (text) errors.push(text);
    },
  });
  const archiveName = `archive.${extension || "bin"}`;
  sevenZip.FS.writeFile(archiveName, new Uint8Array(buffer));
  const args = ["x", archiveName, "-o/out", "-y", `-i!${entryName}`];
  if (password) args.push(`-p${password}`);
  try {
    sevenZip.callMain(args);
  } catch {
    /* a successful extract can still exit the wasm runtime */
  }
  const bytes = readExtracted(sevenZip.FS, entryName);
  if (!bytes) {
    const failedPassword = passwordFailed(errors.join("\n"));
    throw new ArchiveExtractError(failedPassword ? "密码不正确" : "无法解压该文件", failedPassword);
  }
  if (bytes.byteLength > MAX_EXTRACT_BYTES) throw new ArchiveExtractError("文件超过 8MB，暂不支持预览");
  return bytes.slice();
}

export function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

export async function extractArchiveEntry(filePath: string, buffer: ArrayBuffer, entryName: string, password?: string) {
  const extension = fileExtension(filePath);
  const payload = extension === "crx" ? zipBytes(buffer) : buffer;
  const relative = safeEntry(entryName);
  if (extension === "rar") return extractRar(payload, relative, password);
  const archiveBytes = isGzipTar(extension) ? await gunzip(payload) : payload;
  const archiveExtension = extension === "crx" || isGzipTar(extension) ? (isGzipTar(extension) ? "tar" : "zip") : extension;
  return extract7z(archiveBytes, archiveExtension, relative, password);
}

export async function describeArchive(filePath: string, buffer: ArrayBuffer) {
  const extension = fileExtension(filePath);
  const payload = extension === "crx" ? zipBytes(buffer) : buffer;
  const entries = extension === "rar"
    ? await listRar(payload)
    : await list7z(isGzipTar(extension) ? await gunzip(payload) : payload, isGzipTar(extension) ? "tar" : extension);
  const tree = archiveTree(entries);
  return {
    extension: extension === "tgz" ? "tar.gz" : extension,
    size: formatBytes(payload.byteLength),
    encrypted: entries.some((entry) => entry.encrypted),
    data: {
      fileName: filePath.split(/[\\/]/).pop() || filePath,
      files: tree.files,
      folderMap: tree.folderMap,
    },
  };
}
