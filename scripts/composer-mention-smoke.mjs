import assert from "node:assert/strict";

function mentionQueryAt(text, cursor) {
  const source = String(text || "");
  const at = Math.max(0, Math.min(source.length, Number(cursor) || 0));
  const before = source.slice(0, at);
  const match = before.match(/(^|[\s([{（【「])@([^\s@]*)$/);
  if (!match) return null;
  return { start: before.length - match[2].length - 1, query: match[2] };
}

function applyMention(text, cursor, file) {
  const mention = mentionQueryAt(text, cursor);
  const name = String(file.name || "").trim();
  if (!mention || !name) return { text, cursor };
  const replacement = `@${name} `;
  return {
    text: `${text.slice(0, mention.start)}${replacement}${text.slice(Math.max(0, cursor))}`,
    cursor: mention.start + replacement.length,
  };
}

assert.equal(mentionQueryAt("hello", 5), null);
assert.deepEqual(mentionQueryAt("@", 1), { start: 0, query: "" });
assert.equal(mentionQueryAt("see @src", 8).query, "src");
assert.equal(mentionQueryAt("(@fi", 4).query, "fi");

const applied = applyMention("打开 @lo", 6, { name: "login.ts", path: "src/login.ts" });
assert.equal(applied.text, "打开 @login.ts ");
assert.equal(applied.cursor, "打开 @login.ts ".length);

console.log("composer-mention-smoke ok");
