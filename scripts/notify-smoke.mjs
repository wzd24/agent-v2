import assert from "node:assert/strict";

function shouldNotifyTurn({ enabled, focused, currentThreadId, eventThreadId } = {}) {
  if (enabled === false) return false;
  const watching = Boolean(focused && currentThreadId && eventThreadId && currentThreadId === eventThreadId);
  return !watching;
}

function turnCompleteNotice({ enabled, focused, watching, title, error } = {}) {
  if (enabled === false || watching) return null;
  if (focused && watching) return null;
  const name = String(title || "线程").trim() || "线程";
  return {
    title: "Scorpio Agent",
    body: error ? `回合失败：${name}` : `回合已完成：${name}`,
  };
}

assert.equal(shouldNotifyTurn({ enabled: false, focused: false, currentThreadId: "a", eventThreadId: "a" }), false);
assert.equal(shouldNotifyTurn({ enabled: true, focused: true, currentThreadId: "a", eventThreadId: "a" }), false);
assert.equal(shouldNotifyTurn({ enabled: true, focused: true, currentThreadId: "a", eventThreadId: "b" }), true);
assert.equal(shouldNotifyTurn({ enabled: true, focused: false, currentThreadId: "a", eventThreadId: "a" }), true);

assert.equal(turnCompleteNotice({ enabled: false, title: "报告" }), null);
assert.equal(turnCompleteNotice({ watching: true, title: "报告" }), null);
assert.deepEqual(turnCompleteNotice({ title: "报告" }), { title: "Scorpio Agent", body: "回合已完成：报告" });
assert.deepEqual(turnCompleteNotice({ title: "报告", error: true }), { title: "Scorpio Agent", body: "回合失败：报告" });

console.log("notify-smoke ok");
