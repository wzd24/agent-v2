import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { parseArgs, serializeThreadExport, parseThreadImport, findAppServer } = require(
  path.join(root, "cli/cli.cjs"),
);

const parsed = parseArgs(["exec", "检查", "git", "状态", "--cwd", process.cwd(), "--yes", "--json"]);
assert.equal(parsed.command, "exec");
assert.equal(parsed.prompt, "检查 git 状态");
assert.equal(parsed.yes, true);
assert.equal(parsed.json, true);
assert.equal(parsed.cwd, path.resolve(process.cwd()));

const resumed = parseArgs(["resume", "thread-1", "继续", "--yes"]);
assert.equal(resumed.command, "exec");
assert.equal(resumed.resume, "thread-1");
assert.equal(resumed.prompt, "继续");
assert.equal(parseArgs(["exec", "接着做", "--resume", "abc"]).resume, "abc");
assert.equal(parseArgs(["exec", "接着做", "--last"]).last, true);
assert.equal(parseArgs(["show", "thread-1"]).command, "show");
assert.equal(parseArgs(["show", "thread-1"]).resume, "thread-1");
assert.equal(parseArgs(["show", "--last"]).last, true);
assert.equal(parseArgs(["exec", "提问", "--model", "deepseek-reasoner"]).model, "deepseek-reasoner");
assert.equal(parseArgs(["export", "thread-1", "--out", path.join(os.tmpdir(), "thread.json")]).command, "export");
assert.equal(parseArgs(["compact", "thread-1"]).command, "compact");
assert.equal(parseArgs(["rename", "thread-1", "新标题"]).resume, "thread-1");
assert.equal(parseArgs(["rename", "thread-1", "新标题"]).prompt, "新标题");
assert.equal(
  serializeThreadExport({ id: "thread-1", turns: [{ items: [{ type: "agentMessage", text: "ok" }] }] }).format,
  "local-codex-thread",
);
assert.deepEqual(
  parseThreadImport(
    JSON.stringify({
      format: "local-codex-thread",
      version: 1,
      thread: { title: "导入样例" },
      turns: [{ items: [{ type: "userMessage", text: "提问" }, { type: "agentMessage", text: "答复" }] }],
    }),
  ).messages,
  [
    { role: "user", text: "提问" },
    { role: "agent", text: "答复" },
  ],
);
assert.equal(parseArgs(["--version"]).version, true);
assert.ok(findAppServer(root));

console.log("cli-smoke ok");
