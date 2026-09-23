import assert from "node:assert/strict";

function findOccurrences(messages, term) {
  const query = String(term || "").trim();
  if (!query) return [];
  const needle = query.toLowerCase();
  const hits = [];
  for (const message of messages) {
    const text = String(message.text || "");
    const lower = text.toLowerCase();
    let from = 0;
    while (from < lower.length) {
      const at = lower.indexOf(needle, from);
      if (at < 0) break;
      hits.push({ turnId: String(message.turnId || ""), start: at });
      from = at + needle.length;
    }
  }
  return hits;
}

function nextIndex(current, total, offset) {
  if (!total) return -1;
  return (current + offset + total) % total;
}

const hits = findOccurrences(
  [
    { turnId: "t1", text: "第一行 hello" },
    { turnId: "t2", text: "HELLO again and hello" },
  ],
  "hello",
);
assert.equal(hits.length, 3);
assert.equal(hits[0].turnId, "t1");
assert.equal(hits[2].turnId, "t2");
assert.equal(findOccurrences([], "hello").length, 0);
assert.equal(nextIndex(0, 3, 1), 1);
assert.equal(nextIndex(2, 3, 1), 0);
assert.equal(nextIndex(0, 3, -1), 2);
assert.equal(nextIndex(0, 0, 1), -1);

console.log("conversation-find-smoke ok");
