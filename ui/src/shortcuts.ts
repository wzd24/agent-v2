export type ShortcutDef = {
  id: string;
  action: string;
  label: string;
  group: string;
  defaultKeys: string;
  aliases?: string[];
  pref?: string;
  requiresTurn?: boolean;
};

export const SHORTCUT_GROUPS = ["对话", "导航", "面板", "窗口"] as const;

export const APP_SHORTCUTS: ShortcutDef[] = [
  { id: "new-chat", action: "new-chat", label: "新聊天", group: "对话", defaultKeys: "Ctrl+N", pref: "shortcut_new_thread" },
  { id: "new-temporary-chat", action: "new-temporary-chat", label: "新建临时聊天", group: "对话", defaultKeys: "Ctrl+Shift+N", pref: "shortcut_new_temporary" },
  { id: "focus-input", action: "focus-input", label: "聚焦输入框", group: "对话", defaultKeys: "Ctrl+L", pref: "shortcut_focus_input" },
  { id: "stop-turn", action: "stop-turn", label: "停止当前回合", group: "对话", defaultKeys: "Esc", pref: "shortcut_stop_turn", requiresTurn: true },
  { id: "find", action: "find", label: "查找", group: "对话", defaultKeys: "Ctrl+F", pref: "shortcut_find" },
  { id: "search-threads", action: "search-threads", label: "搜索对话", group: "对话", defaultKeys: "Ctrl+K", pref: "shortcut_search_threads" },
  { id: "previous-chat", action: "previous-chat", label: "上一个聊天", group: "导航", defaultKeys: "Ctrl+Shift+[", pref: "shortcut_prev_chat" },
  { id: "next-chat", action: "next-chat", label: "下一个聊天", group: "导航", defaultKeys: "Ctrl+Shift+]", pref: "shortcut_next_chat" },
  { id: "back", action: "back", label: "返回", group: "导航", defaultKeys: "Ctrl+[", pref: "shortcut_back" },
  { id: "forward", action: "forward", label: "前进", group: "导航", defaultKeys: "Ctrl+]", pref: "shortcut_forward" },
  { id: "toggle-sidebar", action: "toggle-sidebar", label: "切换侧边栏", group: "面板", defaultKeys: "Ctrl+B", pref: "shortcut_toggle_sidebar" },
  { id: "toggle-bottom-panel", action: "toggle-bottom-panel", label: "切换底部面板", group: "面板", defaultKeys: "Ctrl+J", pref: "shortcut_toggle_bottom" },
  { id: "toggle-top-panel", action: "toggle-top-panel", label: "切换环境信息", group: "面板", defaultKeys: "Ctrl+Shift+J", pref: "shortcut_toggle_top" },
  { id: "open-terminal", action: "open-terminal", label: "打开终端", group: "面板", defaultKeys: "Ctrl+`", pref: "shortcut_open_terminal" },
  { id: "toggle-files", action: "toggle-files", label: "切换文件树", group: "面板", defaultKeys: "Ctrl+P", aliases: ["Ctrl+Shift+E"], pref: "shortcut_toggle_files" },
  { id: "toggle-review", action: "toggle-review", label: "切换审阅面板", group: "面板", defaultKeys: "Ctrl+Shift+G", aliases: ["Ctrl+Alt+B"], pref: "shortcut_toggle_review" },
  { id: "open-browser", action: "open-browser", label: "打开内置浏览器", group: "面板", defaultKeys: "Ctrl+T", pref: "shortcut_open_browser" },
  { id: "toggle-side-picker", action: "toggle-side-picker", label: "侧边面板选择", group: "面板", defaultKeys: "Ctrl+Shift+P", pref: "shortcut_side_picker" },
  { id: "open-folder", action: "open-folder", label: "打开文件夹", group: "窗口", defaultKeys: "Ctrl+O", pref: "shortcut_open_folder" },
  { id: "settings", action: "settings", label: "设置", group: "窗口", defaultKeys: "Ctrl+,", pref: "shortcut_settings" },
  { id: "shortcuts", action: "shortcuts", label: "显示键盘快捷键", group: "窗口", defaultKeys: "Ctrl+/", pref: "shortcut_shortcuts" },
  { id: "zoom-in", action: "zoom-in", label: "放大", group: "窗口", defaultKeys: "Ctrl+=", aliases: ["Ctrl+Shift+="], pref: "shortcut_zoom_in" },
  { id: "zoom-out", action: "zoom-out", label: "缩小", group: "窗口", defaultKeys: "Ctrl+-", pref: "shortcut_zoom_out" },
  { id: "zoom-reset", action: "zoom-reset", label: "实际大小", group: "窗口", defaultKeys: "Ctrl+0", pref: "shortcut_zoom_reset" },
  { id: "fullscreen", action: "fullscreen", label: "切换全屏", group: "窗口", defaultKeys: "F11", pref: "shortcut_fullscreen" },
  { id: "close-window", action: "close-window", label: "关闭窗口", group: "窗口", defaultKeys: "Ctrl+W", pref: "shortcut_close_window" },
  { id: "quit", action: "quit", label: "退出", group: "窗口", defaultKeys: "Ctrl+Q", pref: "shortcut_quit" },
];

export function shortcutPref(item: ShortcutDef): string {
  return item.pref || `shortcut_${item.id.replace(/-/g, "_")}`;
}

export function bindingFor(item: ShortcutDef, config: Record<string, any> = {}): string {
  const saved = String(config[shortcutPref(item)] || "").trim();
  return saved || item.defaultKeys;
}

export function resolvedShortcutMap(config: Record<string, any> = {}): Record<string, string> {
  const map: Record<string, string> = {};
  for (const item of APP_SHORTCUTS) map[item.action] = bindingFor(item, config);
  return map;
}

function normalizeHotkey(value: string): string {
  const key = String(value || "").toLowerCase();
  if (key === "esc" || key === "escape") return "escape";
  if (key === " ") return "space";
  if (key === "control") return "ctrl";
  if (key === "meta" || key === "cmd" || key === "command" || key === "os") return "ctrl";
  if (key === "arrowleft") return "left";
  if (key === "arrowright") return "right";
  return key;
}

function physicalKey(event: KeyboardEvent): string {
  const code = String(event.code || "").toLowerCase();
  const byCode: Record<string, string> = {
    escape: "escape",
    backquote: "`",
    comma: ",",
    period: ".",
    slash: "/",
    backslash: "\\",
    bracketleft: "[",
    bracketright: "]",
    minus: "-",
    equal: "=",
    digit0: "0",
    numpad0: "0",
    f11: "f11",
    space: "space",
  };
  if (byCode[code]) return byCode[code];
  if (code.startsWith("key") && code.length === 4) return code.slice(3);
  if (code.startsWith("digit") && code.length === 6) return code.slice(5);
  return normalizeHotkey(event.key);
}

export function formatShortcutEvent(event: KeyboardEvent): string {
  const key = physicalKey(event);
  if (!key || key === "control" || key === "ctrl" || key === "shift" || key === "alt" || key === "meta") return "";
  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey && key !== "shift") parts.push("Shift");
  const label = key === "escape" ? "Esc" : key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1);
  parts.push(key === "," ? "," : key === "`" ? "`" : key === "/" ? "/" : key === "[" ? "[" : key === "]" ? "]" : key === "=" ? "=" : key === "-" ? "-" : label);
  return parts.join("+");
}

export function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parts = String(shortcut || "")
    .toLowerCase()
    .split("+")
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return false;
  const key = normalizeHotkey(parts[parts.length - 1]);
  const wantCtrl = parts.includes("ctrl") || parts.includes("cmd") || parts.includes("meta");
  const wantAlt = parts.includes("alt");
  const wantShift = parts.includes("shift");
  const hasCtrl = event.ctrlKey || event.metaKey;
  return (
    physicalKey(event) === key &&
    hasCtrl === wantCtrl &&
    event.altKey === wantAlt &&
    event.shiftKey === wantShift
  );
}

export function shortcutMatches(event: KeyboardEvent, item: ShortcutDef, config: Record<string, any> = {}): boolean {
  const keys = [bindingFor(item, config), ...(item.aliases || [])];
  return keys.some((shortcut) => matchesShortcut(event, shortcut));
}

export function typingTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node) return false;
  if (node.isContentEditable) return true;
  const tag = node.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

export function dialogOpen(): boolean {
  return Boolean(document.querySelector(".app-dialog, .new-project-modal-backdrop, .new-project-modal, .window-titlebar-menu-popup"));
}
