import wasmUrl from "node-unrar-js/esm/js/unrar.wasm?url";
import { fileExtension } from "./loadFileBytes";

type Entry = { name: string; size: number; directory: boolean; encrypted: boolean };

type ArchiveNode = {
  name: string;
  isDirectory: boolean;
  entryName: string;
  fileSize?: string;
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
    directory: Boolean(header.flags?.directory),
    encrypted: Boolean(header.flags?.encrypted),
  }));
}

async function list7z(buffer: ArrayBuffer, extension: string): Promise<Entry[]> {
  const sevenZipFactory = (await import("7z-wasm")).default;
  const lines: string[] = [];
  const sevenZip = await sevenZipFactory({
    print: (text: string) => lines.push(text),
    printErr: () => undefined,
  });
  const name = extension === "tgz" || extension === "tar.gz" ? "archive.tar.gz" : `archive.${extension || "zip"}`;
  sevenZip.FS.writeFile(name, new Uint8Array(buffer));
  sevenZip.callMain(["l", "-slt", name]);
  const entries: Entry[] = [];
  for (const block of lines.join("\n").split(/\n\s*\n/)) {
    const path = /^Path = (.+)$/m.exec(block)?.[1]?.trim();
    if (!path || path === name) continue;
    const size = Number(/^Size = (\d+)$/m.exec(block)?.[1] || 0);
    const directory = /^Folder = \+$/m.test(block) || path.endsWith("/");
    const encrypted = /^Encrypted = \+$/m.test(block);
    entries.push({ name: path, size, directory, encrypted });
  }
  return entries;
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

export async function describeArchive(filePath: string, buffer: ArrayBuffer) {
  const extension = fileExtension(filePath);
  const payload = extension === "crx" ? zipBytes(buffer) : buffer;
  const entries = extension === "rar" ? await listRar(payload) : await list7z(payload, extension);
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
