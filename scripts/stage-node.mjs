import { copyFileSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const destDir = join(root, "vendor", "node");
const dest = join(destDir, "node.exe");
const source = process.env.NODE_BINARY || process.execPath;

mkdirSync(destDir, { recursive: true });
try {
  if (statSync(dest).size === statSync(source).size) {
    process.stdout.write(`node sidecar already staged: ${dest}\n`);
    process.exit(0);
  }
} catch {
  /* copy */
}
copyFileSync(source, dest);
process.stdout.write(`staged node sidecar: ${source} -> ${dest}\n`);
