import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function ok(label, pass, detail = "") {
  process.stdout.write(`${pass ? "ok" : "FAIL"}  ${label}${detail ? `  (${detail})` : ""}\n`);
  if (!pass) failures.push(label);
}

function exists(rel) {
  return fs.existsSync(path.join(root, rel));
}

ok("@playwright/mcp cli.js", exists("node_modules/@playwright/mcp/cli.js"));
ok("playwright", exists("node_modules/playwright"));
ok("playwright-core", exists("node_modules/playwright-core"));
ok("ui dist", exists("ui/dist/index.html"));
ok("debug exe", exists("src-tauri/target/debug/local-codex.exe"));
ok(
  "app-server",
  exists("vendor/app-server/codex.exe") || exists("src-tauri/target/debug/resources/app-server/codex.exe"),
);

const which = spawnSync("where.exe", ["node.exe"], { encoding: "utf8" });
const nodeLine = String(which.stdout || "")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .find(Boolean);
ok("node.exe on PATH or nvm", Boolean(nodeLine) || exists("vendor/node/node.exe") || fs.existsSync("C:\\nvm4w\\nodejs\\node.exe"), nodeLine || "vendor/nvm");

const shortcuts = fs.readFileSync(path.join(root, "ui/src/shortcuts.ts"), "utf8");
const shortcutCount = (shortcuts.match(/id: "/g) || []).length;
ok("APP_SHORTCUTS 27", shortcutCount === 27, String(shortcutCount));

const help = JSON.parse(fs.readFileSync(path.join(root, "ui/src/helpPages.json"), "utf8"));
ok("help pages 9", Object.keys(help).length === 9, Object.keys(help).join(","));
ok("help uses .local-codex/hooks", JSON.stringify(help).includes(".local-codex/hooks.json"));
ok("help does not send users to .codex/hooks", !JSON.stringify(help).includes(".codex/hooks.json"));

const elicitation = fs.readFileSync(path.join(root, "ui/src/mcpElicitation.ts"), "utf8");
ok(
  "MCP grant ignores integration toggles",
  !elicitation.includes("computer_enabled !== false") && elicitation.includes('remembered[name] === "*"'),
);

const browser = fs.readFileSync(path.join(root, "src-tauri/src/browser.rs"), "utf8");
ok("browser uses WebView2 Find for cross-frame search", browser.includes("ICoreWebView2_28") && browser.includes("CreateFindOptions"));

const main = fs.readFileSync(path.join(root, "ui/src/main.tsx"), "utf8");
ok("thread/list retries while engine is not ready", main.includes("尚未就绪") && main.includes("150 * (attempt + 1)"));

for (const rel of [
  "scripts/office-smoke.mjs",
  "scripts/preview-smoke.mjs",
  "scripts/help-smoke.mjs",
  "scripts/cli-smoke.mjs",
  "scripts/composer-slash-smoke.mjs",
  "scripts/composer-mention-smoke.mjs",
  "scripts/conversation-find-smoke.mjs",
  "scripts/notify-smoke.mjs",
  "scripts/updates-smoke.mjs",
]) {
  ok(rel, exists(rel));
}

ok(
  "listAllThreads does not persist inferred assignments",
  !main.includes("void api.codex.assignThread(thread.id") && main.includes("assignment?.projectId"),
);
ok(
  "new thread start matches v1 (no auto assign / no turnPolicy)",
  !main.includes("persistThreadAssignment(threadId, currentProject") &&
    !main.includes("...turnPolicy()") &&
    main.includes("projectId: null"),
);
ok("config.openFile uses v1 error text", fs.readFileSync(path.join(root, "src-tauri/src/host.rs"), "utf8").includes('Err("config.toml 不存在"'));
ok("update feed rejects non-semver", fs.readFileSync(path.join(root, "src-tauri/src/updates.rs"), "utf8").includes("parse_version(&latest)"));

const components = fs.readdirSync(path.join(root, "ui/src/components")).sort();
ok(
  "UI components include v1 set plus ApprovalCard",
  components.length === 30 && components.includes("ApprovalCard.tsx"),
  components.length + " " + components.join(","),
);

if (failures.length) {
  process.stderr.write(`\n${failures.length} parity smoke checks failed\n`);
  process.exitCode = 1;
} else {
  process.stdout.write("\nparity smoke ok\n");
}
