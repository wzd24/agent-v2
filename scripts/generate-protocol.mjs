import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
const staged = path.join(root, "vendor", "app-server", binaryName);
const command = process.env.CODEX_APP_SERVER_CMD || staged;
if (!fs.existsSync(command)) {
  throw new Error(`找不到引擎二进制：${command}。请先运行 npm run stage-app-server`);
}
const out = path.join(root, "ui", "src", "generated", "app-server");
fs.mkdirSync(out, { recursive: true });
const result = spawnSync(command, ["app-server", "generate-ts", "--experimental", "--out", out], {
  stdio: "inherit",
});
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
console.log(`Generated protocol TypeScript -> ${out}`);
