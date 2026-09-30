export function shouldNotifyTurn(input: {
  enabled?: boolean;
  focused?: boolean;
  currentThreadId?: string;
  eventThreadId?: string;
} = {}) {
  if (input.enabled === false) return false;
  const watching = Boolean(
    input.focused &&
      input.currentThreadId &&
      input.eventThreadId &&
      input.currentThreadId === input.eventThreadId,
  );
  return !watching;
}

export function turnCompleteNotice(input: {
  enabled?: boolean;
  focused?: boolean;
  watching?: boolean;
  title?: string;
  error?: boolean;
} = {}) {
  if (input.enabled === false || input.watching) return null;
  const name = String(input.title || "线程").trim() || "线程";
  return {
    title: "Scorpio Agent",
    body: input.error ? `回合失败：${name}` : `回合已完成：${name}`,
  };
}
