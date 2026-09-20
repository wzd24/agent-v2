import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const binaryName = process.platform === "win32" ? "codex.exe" : "codex";
const command = process.env.CODEX_APP_SERVER_CMD || path.join(root, "vendor", "app-server", binaryName);
if (!fs.existsSync(command)) {
  throw new Error(`找不到引擎：${command}`);
}
const home =
  process.env.CODEX_HOME ||
  path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "local-codex", "codex-home");
fs.mkdirSync(home, { recursive: true });

const child = spawn(
  command,
  [
    "app-server",
    "--stdio",
    "--disable",
    "plugins",
    "--disable",
    "remote_plugin",
    "--disable",
    "recommended_plugins",
    "--disable",
    "plugin_sharing",
    "--disable",
    "apps",
    "--disable",
    "enable_mcp_apps",
    "-c",
    "marketplaces={}",
    "-c",
    "notify=[]",
    "-c",
    "analytics.enabled=false",
  ],
  {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, CODEX_HOME: home },
    windowsHide: true,
  },
);

let buf = "";
const timer = setTimeout(() => {
  console.error("initialize smoke timed out");
  child.kill();
  process.exit(2);
}, 20000);

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  for (;;) {
    const idx = buf.indexOf("\n");
    if (idx < 0) break;
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    if (msg.id === 1) {
      if (msg.error) {
        console.error("initialize failed", msg.error);
        child.kill();
        process.exit(1);
      }
      console.log("initialize ok", msg.result?.serverInfo || msg.result?.userAgent || "connected");
      child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      child.stdin.write(`${JSON.stringify({ id: 2, method: "thread/list", params: { limit: 5 } })}\n`);
    }
    if (msg.id === 2) {
      const count = Array.isArray(msg.result?.data) ? msg.result.data.length : -1;
      console.log(`thread/list ok count=${count}`);
      clearTimeout(timer);
      child.kill();
      process.exit(0);
    }
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  const text = String(chunk).trim();
  if (text) console.error(text.slice(0, 400));
});
child.on("exit", (code) => {
  clearTimeout(timer);
  if (code) process.exit(code);
});

child.stdin.write(
  `${JSON.stringify({
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "local-codex", title: "Local Codex", version: "0.1.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    },
  })}\n`,
);
