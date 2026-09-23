'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile, execFileSync } = require('node:child_process');

const policyFile = process.env.LOCAL_CODEX_COMPUTER_POLICY_FILE || '';
const powershell = process.env.LOCAL_CODEX_POWERSHELL || 'powershell.exe';
let preferredWindowPid = 0;

function reply(id, result, error) {
  process.stdout.write(`${JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result })}\n`);
}

function textResult(value, extra = {}) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }], ...extra };
}

function readPolicy() {
  let saved = {};
  try { if (policyFile && fs.existsSync(policyFile)) saved = JSON.parse(fs.readFileSync(policyFile, 'utf8')); } catch { saved = {}; }
  return {
    enabled: saved.computer_enabled !== false,
    allowAnyApp: saved.computer_allow_any_app !== false,
    screenshot: saved.computer_screenshot_enabled !== false,
    input: saved.computer_input_enabled !== false,
    apps: {
      msedge: saved.computer_edge_enabled !== false,
      chrome: saved.computer_chrome_enabled !== false,
      excel: saved.computer_excel_enabled !== false,
    },
  };
}

function psQuote(value) { return `'${String(value).replaceAll("'", "''")}'`; }

function runPowerShell(script, timeout = 20000) {
  const source = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $ErrorActionPreference='Stop'; ${script}`;
  const encoded = Buffer.from(source, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, timeout, maxBuffer: 32 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || stdout || error.message).trim()));
      resolve(String(stdout || '').trim());
    });
  });
}

function focusWindowScript(pid) {
  return `Add-Type -AssemblyName UIAutomationClient; $targetProcess=Get-Process -Id ${Number(pid)} -ErrorAction Stop; if([LocalCodexUser32]::IsIconic($targetProcess.MainWindowHandle)){[void][LocalCodexUser32]::ShowWindowAsync($targetProcess.MainWindowHandle,9)}; [void][LocalCodexUser32]::ShowWindowAsync($targetProcess.MainWindowHandle,5); $shell=New-Object -ComObject WScript.Shell; [void]$shell.AppActivate($targetProcess.Id); [void][LocalCodexUser32]::SetForegroundWindow($targetProcess.MainWindowHandle); $root=[System.Windows.Automation.AutomationElement]::FromHandle($targetProcess.MainWindowHandle); $document=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Document))); if(!$document){$document=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty,[System.Windows.Automation.ControlType]::Edit)))}; if($document -and $document.Current.IsKeyboardFocusable){$document.SetFocus()}; Start-Sleep -Milliseconds 80;`;
}

const user32Type = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class LocalCodexUser32 {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION data; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mouse; [FieldOffset(0)] public KEYBDINPUT keyboard; [FieldOffset(0)] public HARDWAREINPUT hardware; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint flags; public uint time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort virtualKey; public ushort scanCode; public uint flags; public uint time; public UIntPtr extra; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint message; public ushort low; public ushort high; }
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr window);
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
  public static void SendUnicode(string text) {
    foreach(char character in text) {
      if(character == '\r') continue;
      if(character == '\n' || character == '\t') {
        byte key = character == '\n' ? (byte)13 : (byte)9;
        keybd_event(key, 0, 0, UIntPtr.Zero); keybd_event(key, 0, 2, UIntPtr.Zero); continue;
      }
      INPUT down = new INPUT { type = 1, data = new INPUTUNION { keyboard = new KEYBDINPUT { virtualKey = 0, scanCode = character, flags = 4, time = 0, extra = UIntPtr.Zero } } };
      INPUT up = down; up.data.keyboard.flags = 6;
      INPUT[] inputs = new INPUT[] { down, up };
      if(SendInput(2, inputs, Marshal.SizeOf(typeof(INPUT))) != 2) throw new InvalidOperationException("SendInput failed");
    }
  }
}
'@
`;

async function foregroundAppWindows() {
  const output = await runPowerShell(`${user32Type} $h=[LocalCodexUser32]::GetForegroundWindow(); $pidValue=0; [void][LocalCodexUser32]::GetWindowThreadProcessId($h,[ref]$pidValue); $p=Get-Process -Id $pidValue -ErrorAction SilentlyContinue; [pscustomobject]@{pid=$pidValue;processName=$p.ProcessName;title=$p.MainWindowTitle}|ConvertTo-Json -Compress`);
  try { return JSON.parse(output); } catch { return { pid: 0, processName: '', title: '' }; }
}

async function foregroundApp() {
  if (process.platform === 'win32') return foregroundAppWindows();
  if (process.platform === 'darwin') return foregroundAppMac();
  return foregroundAppLinux();
}

function appAllowed(app, policy) {
  if (policy.allowAnyApp) return true;
  const name = String(app?.processName || '').toLowerCase();
  if (name === 'msedge' || name.includes('edge')) return policy.apps.msedge;
  if (name === 'chrome' || name.includes('chrome') || name.includes('chromium')) return policy.apps.chrome;
  if (name === 'excel' || name.includes('excel')) return policy.apps.excel;
  return false;
}

function runCommand(command, args = [], timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) return reject(new Error(String(stderr || stdout || error.message).trim()));
      resolve(String(stdout || '').trim());
    });
  });
}

function commandExists(name) {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { stdio: 'ignore', timeout: 3000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

const unixTools = {
  cliclick: commandExists('cliclick'),
  xdotool: commandExists('xdotool'),
  wmctrl: commandExists('wmctrl'),
  gnomeScreenshot: commandExists('gnome-screenshot'),
  scrot: commandExists('scrot'),
  import: commandExists('import'),
  grim: commandExists('grim'),
  xrandr: commandExists('xrandr'),
};

function parseKeyList(keys) {
  return (Array.isArray(keys) ? keys : String(keys || '').split('+')).map((key) => String(key).trim()).filter(Boolean);
}

async function foregroundAppMac() {
  const output = await runCommand('osascript', ['-e', 'tell application "System Events" to get {unix id, name} of first process whose frontmost is true']);
  const [pid, ...nameParts] = output.split(',').map((part) => part.trim());
  let title = '';
  try { title = await runCommand('osascript', ['-e', 'tell application "System Events" to get title of window 1 of first process whose frontmost is true']); } catch { title = ''; }
  return { pid: Number(pid) || 0, processName: nameParts.join(', ') || '', title };
}

async function foregroundAppLinux() {
  if (unixTools.xdotool) {
    const pid = Number(await runCommand('xdotool', ['getactivewindow', 'getwindowpid'])) || 0;
    let title = '';
    try { title = await runCommand('xdotool', ['getactivewindow', 'getwindowname']); } catch { title = ''; }
    return { pid, processName: title, title };
  }
  return { pid: 0, processName: '', title: '' };
}

async function listWindowsMac() {
  const script = 'tell application "System Events"\nset output to ""\nrepeat with proc in (every process whose visible is true and background only is false)\ntry\nset output to output & (unix id of proc) & tab & (name of proc) & tab & (title of window 1 of proc) & linefeed\nend try\nend repeat\nreturn output\nend tell';
  const output = await runCommand('osascript', ['-e', script]);
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [pid, processName, ...title] = line.split('\t');
    return { pid: Number(pid) || 0, processName: processName || '', title: title.join('\t') };
  });
}

async function listWindowsLinux() {
  if (unixTools.wmctrl) {
    const output = await runCommand('wmctrl', ['-lp']);
    return output.split(/\r?\n/).filter(Boolean).map((line) => {
      const parts = line.split(/\s+/);
      return { pid: Number(parts[2]) || 0, processName: parts.slice(4).join(' '), title: parts.slice(4).join(' ') };
    });
  }
  if (unixTools.xdotool) {
    const ids = String(await runCommand('xdotool', ['search', '--onlyvisible', '--name', '.'])).split(/\s+/).filter(Boolean);
    const windows = [];
    for (const id of ids) {
      try {
        const pid = Number(await runCommand('xdotool', ['getwindowpid', id])) || 0;
        const title = await runCommand('xdotool', ['getwindowname', id]);
        windows.push({ pid, processName: title, title, handle: id });
      } catch { /* skip unreadable windows */ }
    }
    return windows;
  }
  throw new Error('列出窗口需要 wmctrl 或 xdotool');
}

async function screenshotUnix() {
  const file = path.join(os.tmpdir(), `local-codex-screen-${Date.now()}.png`);
  try {
    if (process.platform === 'darwin') await runCommand('screencapture', ['-x', '-t', 'png', file], 30000);
    else if (unixTools.grim) await runCommand('grim', [file], 30000);
    else if (unixTools.gnomeScreenshot) await runCommand('gnome-screenshot', ['-f', file], 30000);
    else if (unixTools.scrot) await runCommand('scrot', [file], 30000);
    else if (unixTools.import) await runCommand('import', ['-window', 'root', file], 30000);
    else throw new Error('截图需要 screencapture、grim、gnome-screenshot、scrot 或 ImageMagick import');
    const data = fs.readFileSync(file).toString('base64');
    return data;
  } finally {
    try { fs.unlinkSync(file); } catch { /* temp file can already be gone */ }
  }
}

async function screenSizeUnix() {
  if (process.platform === 'darwin') {
    const output = await runCommand('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop']);
    const parts = output.split(',').map((part) => Number(part.trim()));
    return { x: parts[0] || 0, y: parts[1] || 0, width: (parts[2] || 0) - (parts[0] || 0), height: (parts[3] || 0) - (parts[1] || 0) };
  }
  if (unixTools.xdotool) {
    const output = await runCommand('xdotool', ['getdisplaygeometry']);
    const [width, height] = output.split(/\s+/).map(Number);
    return { x: 0, y: 0, width: width || 0, height: height || 0 };
  }
  if (unixTools.xrandr) {
    const output = await runCommand('xrandr', ['--current']);
    const match = output.match(/current\s+(\d+)\s+x\s+(\d+)/);
    if (match) return { x: 0, y: 0, width: Number(match[1]), height: Number(match[2]) };
  }
  throw new Error('无法检测屏幕尺寸，请安装 xdotool 或 xrandr');
}

async function cursorUnix() {
  if (unixTools.cliclick) {
    const output = await runCommand('cliclick', ['p']);
    const match = output.match(/(\d+)\s*,\s*(\d+)/);
    if (match) return { x: Number(match[1]), y: Number(match[2]) };
  }
  if (unixTools.xdotool) {
    const output = await runCommand('xdotool', ['getmouselocation', '--shell']);
    return { x: Number(/X=(\d+)/.exec(output)?.[1] || 0), y: Number(/Y=(\d+)/.exec(output)?.[1] || 0) };
  }
  throw new Error(process.platform === 'darwin' ? '读取光标需要安装 cliclick' : '读取光标需要安装 xdotool');
}

async function moveClickUnix(name, args) {
  const x = Number(args.x);
  const y = Number(args.y);
  if (unixTools.cliclick) {
    if (name === 'computer_mouse_move') {
      await runCommand('cliclick', [`m:${x},${y}`]);
      return { x, y };
    }
    const button = { left: 'c', right: 'rc', middle: 'mc' }[String(args.button || 'left')] || 'c';
    const clicks = Math.max(1, Math.min(3, Number(args.clicks) || 1));
    for (let index = 0; index < clicks; index += 1) await runCommand('cliclick', [`${button}:${x},${y}`]);
    return { x, y, button: args.button || 'left', clicks };
  }
  if (unixTools.xdotool) {
    await runCommand('xdotool', ['mousemove', '--sync', String(x), String(y)]);
    if (name === 'computer_mouse_move') return { x, y };
    const button = { left: '1', right: '3', middle: '2' }[String(args.button || 'left')] || '1';
    const clicks = Math.max(1, Math.min(3, Number(args.clicks) || 1));
    await runCommand('xdotool', ['click', '--repeat', String(clicks), button]);
    return { x, y, button: args.button || 'left', clicks };
  }
  throw new Error(process.platform === 'darwin' ? '鼠标操作需要安装 cliclick' : '鼠标操作需要安装 xdotool');
}

async function typeUnix(text, pid) {
  if (pid) await focusUnix({ pid });
  if (unixTools.cliclick) {
    await runCommand('cliclick', [`t:${text}`]);
    return { typedCharacters: text.length };
  }
  if (process.platform === 'darwin') {
    const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    await runCommand('osascript', ['-e', `tell application "System Events" to keystroke "${escaped}"`]);
    return { typedCharacters: text.length };
  }
  if (unixTools.xdotool) {
    await runCommand('xdotool', ['type', '--delay', '12', '--', text]);
    return { typedCharacters: text.length };
  }
  throw new Error('文字输入需要 cliclick、osascript 或 xdotool');
}

function xdotoolKey(keys) {
  const map = { CTRL: 'ctrl', CONTROL: 'ctrl', ALT: 'alt', SHIFT: 'shift', WIN: 'super', META: 'super', ENTER: 'Return', RETURN: 'Return', ESC: 'Escape', ESCAPE: 'Escape', BACKSPACE: 'BackSpace', DELETE: 'Delete', SPACE: 'space', LEFT: 'Left', UP: 'Up', RIGHT: 'Right', DOWN: 'Down', PAGEUP: 'Page_Up', PAGEDOWN: 'Page_Down' };
  return keys.map((key) => map[key.toUpperCase()] || key).join('+');
}

async function keyUnix(keys, pid) {
  if (pid) await focusUnix({ pid });
  if (process.platform === 'darwin') {
    const map = { CTRL: 'control', CONTROL: 'control', ALT: 'option', SHIFT: 'shift', WIN: 'command', META: 'command', ENTER: 'return', RETURN: 'return', ESC: 'escape', ESCAPE: 'escape', TAB: 'tab', SPACE: 'space' };
    const mapped = keys.map((key) => map[key.toUpperCase()] || key.toLowerCase());
    const using = mapped.slice(0, -1);
    const key = mapped[mapped.length - 1];
    const usingClause = using.length ? ` using {${using.map((item) => `${item} down`).join(', ')}}` : '';
    await runCommand('osascript', ['-e', `tell application "System Events" to keystroke "${key}"${usingClause}`]);
    return { keys };
  }
  if (unixTools.xdotool) {
    await runCommand('xdotool', ['key', xdotoolKey(keys)]);
    return { keys };
  }
  throw new Error('快捷键需要 osascript 或 xdotool');
}

async function focusUnix(args) {
  if (process.platform === 'darwin') {
    if (args.pid != null) {
      await runCommand('osascript', ['-e', `tell application "System Events" to set frontmost of first process whose unix id is ${Number(args.pid)} to true`]);
      preferredWindowPid = Number(args.pid);
      return { pid: Number(args.pid) };
    }
    const title = String(args.title || '');
    await runCommand('osascript', ['-e', `tell application "System Events" to set frontmost of first process whose name contains "${title.replace(/"/g, '\\"')}" to true`]);
    return { title };
  }
  if (unixTools.xdotool) {
    if (args.pid != null) {
      const id = await runCommand('xdotool', ['search', '--pid', String(args.pid), '--limit', '1']);
      if (!id) throw new Error('未找到窗口');
      await runCommand('xdotool', ['windowactivate', '--sync', id.split(/\s+/)[0]]);
      preferredWindowPid = Number(args.pid);
      return { pid: Number(args.pid) };
    }
    const id = await runCommand('xdotool', ['search', '--name', String(args.title || ''), '--limit', '1']);
    if (!id) throw new Error('未找到窗口');
    await runCommand('xdotool', ['windowactivate', '--sync', id.split(/\s+/)[0]]);
    return { title: args.title };
  }
  if (unixTools.wmctrl && args.title) {
    await runCommand('wmctrl', ['-a', String(args.title)]);
    return { title: args.title };
  }
  throw new Error('聚焦窗口需要 osascript、xdotool 或 wmctrl');
}

async function requireAccess({ input = false, screenshot = false } = {}) {
  const policy = readPolicy();
  if (!policy.enabled) throw new Error('电脑操控已在设置中停用');
  if (input && !policy.input) throw new Error('鼠标和键盘输入已在设置中停用');
  if (screenshot && !policy.screenshot) throw new Error('屏幕截图已在设置中停用');
  const foreground = await foregroundApp();
  if (!appAllowed(foreground, policy)) throw new Error(`当前应用未获授权：${foreground.processName || foreground.title || '未知应用'}`);
  return foreground;
}

const tools = [
  { name: 'computer_get_screen_size', description: 'Get the current desktop bounds.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'computer_get_cursor_position', description: 'Get the current mouse cursor coordinates.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'computer_screenshot', description: 'Capture the current desktop and return a PNG image.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'computer_mouse_move', description: 'Move the mouse cursor to absolute screen coordinates.', inputSchema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' } }, required: ['x', 'y'], additionalProperties: false } },
  { name: 'computer_click', description: 'Click at absolute screen coordinates.', inputSchema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'integer' }, button: { type: 'string', enum: ['left', 'right', 'middle'], default: 'left' }, clicks: { type: 'integer', minimum: 1, maximum: 3, default: 1 } }, required: ['x', 'y'], additionalProperties: false } },
  { name: 'computer_scroll', description: 'Scroll the mouse wheel at optional screen coordinates.', inputSchema: { type: 'object', properties: { delta: { type: 'integer', description: 'Positive scrolls up, negative scrolls down.' }, x: { type: 'integer' }, y: { type: 'integer' } }, required: ['delta'], additionalProperties: false } },
  { name: 'computer_type', description: 'Type Unicode text into the focused or most recently selected application.', inputSchema: { type: 'object', properties: { text: { type: 'string' }, pid: { type: 'integer', description: 'Optional target window process id.' } }, required: ['text'], additionalProperties: false } },
  { name: 'computer_key', description: 'Press a key or shortcut such as CTRL+L, ALT+TAB, ENTER, or ESCAPE.', inputSchema: { type: 'object', properties: { keys: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }] }, pid: { type: 'integer', description: 'Optional target window process id.' } }, required: ['keys'], additionalProperties: false } },
  { name: 'computer_list_windows', description: 'List visible top-level application windows.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'computer_focus_window', description: 'Focus a visible window by process id or title substring.', inputSchema: { type: 'object', properties: { pid: { type: 'integer' }, title: { type: 'string' } }, anyOf: [{ required: ['pid'] }, { required: ['title'] }], additionalProperties: false } },
  { name: 'computer_wait', description: 'Wait briefly for a desktop application to update.', inputSchema: { type: 'object', properties: { milliseconds: { type: 'integer', minimum: 0, maximum: 10000, default: 1000 } }, additionalProperties: false } },
];

async function callToolUnix(name, args = {}) {
  if (name === 'computer_get_screen_size') return textResult(await screenSizeUnix());
  if (name === 'computer_get_cursor_position') return textResult(await cursorUnix());
  if (name === 'computer_list_windows') return textResult(process.platform === 'darwin' ? await listWindowsMac() : await listWindowsLinux());
  if (name === 'computer_wait') {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(10000, Number(args.milliseconds) || 1000))));
    return textResult('完成等待');
  }
  if (name === 'computer_screenshot') {
    const foreground = await requireAccess({ screenshot: true });
    return { content: [{ type: 'image', data: await screenshotUnix(), mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ foreground }) }] };
  }
  if (name === 'computer_focus_window') {
    const policy = readPolicy();
    if (!policy.enabled) throw new Error('电脑操控已在设置中停用');
    const result = await focusUnix(args);
    return textResult(result);
  }
  await requireAccess({ input: true });
  if (name === 'computer_mouse_move' || name === 'computer_click') return textResult(await moveClickUnix(name, args));
  if (name === 'computer_scroll') {
    if (unixTools.xdotool) {
      if (Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y))) await runCommand('xdotool', ['mousemove', '--sync', String(args.x), String(args.y)]);
      const clicks = Math.max(1, Math.abs(Number(args.delta) || 1));
      await runCommand('xdotool', ['click', '--repeat', String(clicks), Number(args.delta) > 0 ? '4' : '5']);
      return textResult({ delta: Number(args.delta) || 0 });
    }
    throw new Error('滚动需要 xdotool');
  }
  if (name === 'computer_type') return textResult(await typeUnix(String(args.text || ''), Number(args.pid) || preferredWindowPid));
  if (name === 'computer_key') return textResult(await keyUnix(parseKeyList(args.keys), Number(args.pid) || preferredWindowPid));
  throw new Error(`未知工具：${name}`);
}

async function callTool(name, args = {}) {
  if (process.platform !== 'win32') return callToolUnix(name, args);
  if (name === 'computer_get_screen_size') {
    const output = await runPowerShell(`${user32Type} [void][LocalCodexUser32]::SetProcessDPIAware(); Add-Type -AssemblyName System.Windows.Forms; $r=[System.Windows.Forms.SystemInformation]::VirtualScreen; [pscustomobject]@{x=$r.X;y=$r.Y;width=$r.Width;height=$r.Height}|ConvertTo-Json -Compress`);
    return textResult(JSON.parse(output));
  }
  if (name === 'computer_get_cursor_position') {
    const output = await runPowerShell(`${user32Type} [void][LocalCodexUser32]::SetProcessDPIAware(); $p=New-Object LocalCodexUser32+POINT; [void][LocalCodexUser32]::GetCursorPos([ref]$p); [pscustomobject]@{x=$p.X;y=$p.Y}|ConvertTo-Json -Compress`);
    return textResult(JSON.parse(output));
  }
  if (name === 'computer_list_windows') {
    const output = await runPowerShell(`${user32Type} [void][LocalCodexUser32]::SetProcessDPIAware(); Get-Process | Where-Object {$_.MainWindowHandle -ne 0 -and $_.MainWindowTitle} | Sort-Object ProcessName | ForEach-Object {$r=New-Object LocalCodexUser32+RECT; [void][LocalCodexUser32]::GetWindowRect($_.MainWindowHandle,[ref]$r); [pscustomobject]@{pid=$_.Id;processName=$_.ProcessName;title=$_.MainWindowTitle;handle=$_.MainWindowHandle.ToInt64();minimized=[LocalCodexUser32]::IsIconic($_.MainWindowHandle);bounds=[pscustomobject]@{x=$r.Left;y=$r.Top;width=$r.Right-$r.Left;height=$r.Bottom-$r.Top}}} | ConvertTo-Json -Depth 3 -Compress`);
    return textResult(output ? JSON.parse(output) : []);
  }
  if (name === 'computer_wait') {
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, Math.min(10000, Number(args.milliseconds) || 1000))));
    return textResult('完成等待');
  }
  if (name === 'computer_screenshot') {
    const foreground = await requireAccess({ screenshot: true });
    const output = await runPowerShell(`${user32Type} [void][LocalCodexUser32]::SetProcessDPIAware(); Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $r=[System.Windows.Forms.SystemInformation]::VirtualScreen; $b=New-Object System.Drawing.Bitmap($r.Width,$r.Height); $g=[System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen($r.X,$r.Y,0,0,$b.Size); $m=New-Object System.IO.MemoryStream; $b.Save($m,[System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose(); [Convert]::ToBase64String($m.ToArray()); $m.Dispose()`, 30000);
    return { content: [{ type: 'image', data: output, mimeType: 'image/png' }, { type: 'text', text: JSON.stringify({ foreground }) }] };
  }
  if (name === 'computer_focus_window') {
    const policy = readPolicy();
    if (!policy.enabled) throw new Error('电脑操控已在设置中停用');
    const selector = args.pid != null ? `$_.Id -eq ${Number(args.pid)}` : `$_.MainWindowTitle -like ${psQuote(`*${String(args.title || '')}*`)}`;
    const output = await runPowerShell(`$p=Get-Process | Where-Object {$_.MainWindowHandle -ne 0 -and (${selector})} | Select-Object -First 1; if(!$p){throw '未找到窗口'}; [pscustomobject]@{pid=$p.Id;processName=$p.ProcessName;title=$p.MainWindowTitle}|ConvertTo-Json -Compress`);
    const target = JSON.parse(output);
    if (!appAllowed(target, policy)) throw new Error(`应用未获授权：${target.processName}`);
    await runPowerShell(`${user32Type} ${focusWindowScript(target.pid)}`);
    preferredWindowPid = Number(target.pid);
    return textResult(target);
  }
  await requireAccess({ input: true });
  if (name === 'computer_mouse_move') {
    await runPowerShell(`${user32Type} [void][LocalCodexUser32]::SetProcessDPIAware(); if(-not [LocalCodexUser32]::SetCursorPos(${Number(args.x)},${Number(args.y)})){throw '移动鼠标失败'}`);
    return textResult({ x: Number(args.x), y: Number(args.y) });
  }
  if (name === 'computer_click') {
    const flags = { left: [2, 4], right: [8, 16], middle: [32, 64] }[String(args.button || 'left')] || [2, 4];
    const clicks = Math.max(1, Math.min(3, Number(args.clicks) || 1));
    await runPowerShell(`${user32Type} [void][LocalCodexUser32]::SetProcessDPIAware(); [void][LocalCodexUser32]::SetCursorPos(${Number(args.x)},${Number(args.y)}); 1..${clicks} | ForEach-Object {[LocalCodexUser32]::mouse_event(${flags[0]},0,0,0,[UIntPtr]::Zero); [LocalCodexUser32]::mouse_event(${flags[1]},0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 80}`);
    return textResult({ x: Number(args.x), y: Number(args.y), button: args.button || 'left', clicks });
  }
  if (name === 'computer_scroll') {
    const move = Number.isFinite(Number(args.x)) && Number.isFinite(Number(args.y)) ? `[void][LocalCodexUser32]::SetCursorPos(${Number(args.x)},${Number(args.y)});` : '';
    await runPowerShell(`${user32Type} [void][LocalCodexUser32]::SetProcessDPIAware(); ${move} [LocalCodexUser32]::mouse_event(2048,0,0,${Number(args.delta) || 0},[UIntPtr]::Zero)`);
    return textResult({ delta: Number(args.delta) || 0 });
  }
  if (name === 'computer_type') {
    const encodedText = Buffer.from(String(args.text || ''), 'utf8').toString('base64');
    const targetPid = Number(args.pid) || preferredWindowPid;
    const focus = targetPid ? focusWindowScript(targetPid) : '';
    await runPowerShell(`${user32Type} ${focus} Add-Type -AssemblyName System.Windows.Forms; $bytes=[Convert]::FromBase64String(${psQuote(encodedText)}); $text=[Text.Encoding]::UTF8.GetString($bytes); $previous=[System.Windows.Forms.Clipboard]::GetDataObject(); try {[System.Windows.Forms.Clipboard]::SetText($text); $ctrlScan=[LocalCodexUser32]::MapVirtualKey(17,0); $vScan=[LocalCodexUser32]::MapVirtualKey(86,0); [LocalCodexUser32]::keybd_event(17,[byte]$ctrlScan,0,[UIntPtr]::Zero); [LocalCodexUser32]::keybd_event(86,[byte]$vScan,0,[UIntPtr]::Zero); [LocalCodexUser32]::keybd_event(86,[byte]$vScan,2,[UIntPtr]::Zero); [LocalCodexUser32]::keybd_event(17,[byte]$ctrlScan,2,[UIntPtr]::Zero); Start-Sleep -Milliseconds 180} finally {if($previous){[System.Windows.Forms.Clipboard]::SetDataObject($previous,$true)}else{[System.Windows.Forms.Clipboard]::Clear()}}`);
    return textResult({ typedCharacters: String(args.text || '').length });
  }
  if (name === 'computer_key') {
    const keys = (Array.isArray(args.keys) ? args.keys : String(args.keys || '').split('+')).map((key) => String(key).trim().toUpperCase()).filter(Boolean);
    const vk = { CTRL: 17, CONTROL: 17, ALT: 18, SHIFT: 16, WIN: 91, META: 91, ENTER: 13, RETURN: 13, ESC: 27, ESCAPE: 27, TAB: 9, BACKSPACE: 8, DELETE: 46, SPACE: 32, LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, HOME: 36, END: 35, PAGEUP: 33, PAGEDOWN: 34 };
    const codes = keys.map((key) => vk[key] || (/^F([1-9]|1[0-2])$/.test(key) ? 111 + Number(key.slice(1)) : key.length === 1 ? key.charCodeAt(0) : 0)).filter(Boolean);
    if (!codes.length) throw new Error('没有可识别的按键');
    const array = codes.join(',');
    const targetPid = Number(args.pid) || preferredWindowPid;
    const focus = targetPid ? focusWindowScript(targetPid) : '';
    await runPowerShell(`${user32Type} ${focus} $codes=@(${array}); foreach($code in $codes){$scan=[LocalCodexUser32]::MapVirtualKey($code,0); [LocalCodexUser32]::keybd_event([byte]$code,[byte]$scan,0,[UIntPtr]::Zero)}; [array]::Reverse($codes); foreach($code in $codes){$scan=[LocalCodexUser32]::MapVirtualKey($code,0); [LocalCodexUser32]::keybd_event([byte]$code,[byte]$scan,2,[UIntPtr]::Zero)}`);
    return textResult({ keys });
  }
  throw new Error(`未知工具：${name}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop() || '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id == null) continue;
    if (message.method === 'initialize') reply(message.id, { protocolVersion: message.params?.protocolVersion || '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'local-codex-computer', version: '0.1.0' } });
    else if (message.method === 'tools/list') reply(message.id, { tools });
    else if (message.method === 'resources/list') reply(message.id, { resources: [] });
    else if (message.method === 'resources/templates/list') reply(message.id, { resourceTemplates: [] });
    else if (message.method === 'ping') reply(message.id, {});
    else if (message.method === 'tools/call') callTool(String(message.params?.name || ''), message.params?.arguments || {}).then((result) => reply(message.id, result)).catch((error) => reply(message.id, textResult(error.message, { isError: true })));
    else reply(message.id, null, { code: -32601, message: `Method not found: ${message.method}` });
  }
});
