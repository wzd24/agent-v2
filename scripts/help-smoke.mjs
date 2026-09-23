import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const pages = JSON.parse(fs.readFileSync(path.join(root, "ui/src/helpPages.json"), "utf8"));
const ids = Object.keys(pages);
assert.deepEqual(ids, [
  "docs",
  "conversation",
  "safety",
  "tools",
  "git",
  "settings",
  "cli",
  "whats-new",
  "troubleshooting",
]);
for (const id of ids) {
  const page = pages[id];
  assert.match(page.body, /Local Codex|本地|线程|审批|MCP|Git|local-codex/);
  assert.doesNotMatch(page.body, /developers\.openai\.com|status\.openai\.com/);
  assert.ok(page.body.length > 1000, `${id} should be detailed`);
}
assert.equal(pages.docs.title, "开始使用");
assert.match(pages.docs.body, /不登录 ChatGPT/);
assert.match(pages.conversation.body, /\/compact/);
assert.match(pages.safety.body, /danger-full-access/);
assert.match(pages.tools.body, /DuckDuckGo/);
assert.match(pages.git.body, /GitLab/);
assert.match(pages.settings.body, /前景透明度/);
assert.match(pages.settings.body, /SessionStart/);
assert.match(pages.conversation.body, /Steer/);
assert.match(pages.cli.body, /--yes/);
assert.ok(!pages.chatgpt, "chatgpt help page must not exist");

console.log("help-smoke ok");
