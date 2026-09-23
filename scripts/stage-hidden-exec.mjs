import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "scripts", "hidden-exec.rs");
const outDir = join(root, "src-tauri", "bundled");
const out = join(outDir, process.platform === "win32" ? "hidden-exec.exe" : "hidden-exec");

mkdirSync(outDir, { recursive: true });
const result = spawnSync(
  "rustc",
  [src, "--edition", "2021", "-O", "-C", "opt-level=s", "--crate-type", "bin", "-o", out],
  { stdio: "inherit", windowsHide: true },
);
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
process.stdout.write(`staged hidden-exec: ${out}\n`);
