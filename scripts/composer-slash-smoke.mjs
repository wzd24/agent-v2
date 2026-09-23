import assert from "node:assert/strict";

const SLASH_COMMANDS = [
  { id: "compact" },
  { id: "rollback" },
  { id: "goal" },
  { id: "rename" },
  { id: "archive" },
  { id: "new" },
];

function slashQueryAt(text, cursor) {
  const source = String(text || "");
  if (!source.startsWith("/")) return null;
  const at = Math.max(0, Math.min(source.length, Number(cursor) || 0));
  const newline = source.indexOf("\n");
  if (newline >= 0 && at > newline) return null;
  const line = newline < 0 ? source : source.slice(0, newline);
  const match = line.match(/^\/([a-z]*)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { command: String(match[1] || "").toLowerCase(), arg: String(match[2] || "").trim(), start: 0 };
}

function matchingSlashCommands(query) {
  const prefix = String(query || "").toLowerCase();
  return SLASH_COMMANDS.filter((item) => item.id.startsWith(prefix));
}

function parseSlashSubmit(text) {
  const source = String(text || "").trim();
  const match = source.match(/^\/(compact|rollback|goal|rename|archive|new)(?:\s+([\s\S]*))?$/i);
  if (!match) return null;
  return { command: match[1].toLowerCase(), arg: String(match[2] || "").trim() };
}

function applySlashCommand(text, cursor, command) {
  const slash = slashQueryAt(text, cursor);
  if (!slash) return { text, cursor };
  const replacement = ["rollback", "goal", "rename"].includes(command.id) ? `/${command.id} ` : `/${command.id}`;
  const newline = text.indexOf("\n");
  const after = newline < 0 ? "" : text.slice(newline);
  return { text: `${replacement}${after}`, cursor: replacement.length };
}

assert.equal(slashQueryAt("hello", 5), null);
assert.deepEqual(slashQueryAt("/", 1), { command: "", arg: "", start: 0 });
assert.equal(slashQueryAt("/compact\nmore", 10), null);
assert.equal(slashQueryAt("/compact", 8).command, "compact");
assert.deepEqual(matchingSlashCommands("c").map((item) => item.id), ["compact"]);
assert.deepEqual(parseSlashSubmit("/compact"), { command: "compact", arg: "" });
assert.deepEqual(parseSlashSubmit("/rollback 2"), { command: "rollback", arg: "2" });
assert.deepEqual(parseSlashSubmit("/goal 修复登录"), { command: "goal", arg: "修复登录" });
assert.deepEqual(parseSlashSubmit("/archive"), { command: "archive", arg: "" });
assert.deepEqual(parseSlashSubmit("/rename 登录修复"), { command: "rename", arg: "登录修复" });
assert.equal(parseSlashSubmit("不是命令"), null);

const applied = applySlashCommand("/r", 2, { id: "rollback" });
assert.equal(applied.text, "/rollback ");
assert.equal(applied.cursor, "/rollback ".length);

console.log("composer-slash-smoke ok");
