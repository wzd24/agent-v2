import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function findInstalledCodex() {
  if (process.env.CODEX_APP_SERVER_CMD && fs.existsSync(process.env.CODEX_APP_SERVER_CMD)) {
    return process.env.CODEX_APP_SERVER_CMD;
  }
  if (process.platform === "win32") {
    const root = path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "OpenAI",
      "Codex",
      "bin",
    );
    if (fs.existsSync(root)) {
      const candidates = fs
        .readdirSync(root)
        .map((dir) => path.join(root, dir, "codex.exe"))
        .filter((file) => fs.existsSync(file))
        .map((file) => ({ file, mtime: fs.statSync(file).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime);
      if (candidates[0]) return candidates[0].file;
    }
  }
  for (const candidate of [
    "/usr/local/bin/codex",
    "/opt/homebrew/bin/codex",
    path.join(os.homedir(), ".local", "bin", "codex"),
  ]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error("未找到当前平台的 codex 二进制；请设置 CODEX_APP_SERVER_CMD");
}

const source = path.resolve(findInstalledCodex());
const targetDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "vendor", "app-server");
const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
const target = path.join(targetDir, binaryName);
fs.mkdirSync(targetDir, { recursive: true });
if (
  !fs.existsSync(target) ||
  fs.statSync(target).size !== fs.statSync(source).size ||
  fs.statSync(target).mtimeMs < fs.statSync(source).mtimeMs
) {
  fs.copyFileSync(source, target);
}
if (process.platform !== "win32") fs.chmodSync(target, 0o755);
console.log(`Staged ${source} -> ${target}`);

if (process.platform === "win32") {
  const hostSource = path.join(path.dirname(source), "codex-code-mode-host.exe");
  const hostTarget = path.join(targetDir, "codex-code-mode-host.exe");
  if (!fs.existsSync(hostSource)) throw new Error(`未找到 code-mode host：${hostSource}`);
  if (
    !fs.existsSync(hostTarget) ||
    fs.statSync(hostTarget).size !== fs.statSync(hostSource).size ||
    fs.statSync(hostTarget).mtimeMs < fs.statSync(hostSource).mtimeMs
  ) {
    fs.copyFileSync(hostSource, hostTarget);
  }
  console.log(`Staged ${hostSource} -> ${hostTarget}`);
}
