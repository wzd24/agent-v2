'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LOCAL_ONLY_APP_SERVER_ARGS = [
  'app-server', '--stdio',
  '--disable', 'plugins',
  '--disable', 'remote_plugin',
  '--disable', 'recommended_plugins',
  '--disable', 'plugin_sharing',
  '--disable', 'apps',
  '--disable', 'enable_mcp_apps',
  '-c', 'marketplaces={}',
  '-c', 'notify=[]',
  '-c', 'analytics.enabled=false',
  '-c', 'sandbox_mode=workspace-write',
  '-c', 'sandbox_workspace_write.network_access=true',
];

function helpText(version) {
  return `Local Codex ${version}

用法:
  local-codex exec <提示词> [--cwd <目录>] [--model <模型>] [--yes] [--json] [--resume <线程>] [--last]
  local-codex resume <线程> <提示词> [--cwd <目录>] [--model <模型>] [--yes] [--json]
  local-codex threads [--json]
  local-codex projects [--json]
  local-codex clone <地址> [--parent <目录>] [--name <文件夹>] [--protocol https|ssh] [--shallow]
  local-codex show <线程> [--json]
  local-codex show --last [--json]
  local-codex export <线程> [--out <文件>] [--json]
  local-codex export --last [--out <文件>] [--json]
  local-codex import <文件> [--json]
  local-codex search <关键词> [--json]
  local-codex compact <线程> [--json]
  local-codex compact --last [--json]
  local-codex archive <线程> [--json]
  local-codex archive --last [--json]
  local-codex unarchive <线程> [--json]
  local-codex rename <线程> <名称> [--json]
  local-codex delete <线程> --yes [--json]
  local-codex models [--json]
  local-codex --help
  local-codex --version

exec 会启动独立 app-server、新建线程并打印最终回复。
resume / --resume 在已有本地线程上继续；--last 使用最近一条线程。
show 读取本地线程并打印最近一条代理回复，不发起新回合。
export 将线程写成可导入的 local-codex-thread JSON；不写 --out 时输出到标准输出。
import 从 JSON / TXT 恢复线程（与界面导入格式相同）。
search 按标题或预览搜索本地线程。
compact / archive / unarchive / rename / delete 管理本地线程。
delete 必须加 --yes。
--model 覆盖本回合及后续回合使用的模型。
projects 列出 Local Codex 自己登记的本地项目。
clone 在指定目录执行 git clone，不打开界面。
--yes 将审批策略设为 never，适合无人值守。
不连接 ChatGPT / OpenAI 云端。
`;
}

const THREAD_ID_COMMANDS = new Set(['resume', 'show', 'export', 'compact', 'archive', 'unarchive', 'rename', 'delete']);

function parseArgs(argv) {
  const args = [...argv];
  const options = {
    command: '',
    prompt: '',
    cwd: process.cwd(),
    yes: false,
    json: false,
    help: false,
    version: false,
    mock: false,
    resume: '',
    last: false,
    parent: '',
    protocol: 'https',
    shallow: false,
    folderName: '',
    model: '',
    out: '',
  };
  while (args.length) {
    const token = args.shift();
    if (token === '--help' || token === '-h') options.help = true;
    else if (token === '--version' || token === '-v') options.version = true;
    else if (token === '--yes' || token === '-y') options.yes = true;
    else if (token === '--json') options.json = true;
    else if (token === '--mock') options.mock = true;
    else if (token === '--last') options.last = true;
    else if (token === '--shallow') options.shallow = true;
    else if (token === '--resume') options.resume = String(args.shift() || '');
    else if (token.startsWith('--resume=')) options.resume = token.slice(9);
    else if (token === '--cwd') options.cwd = path.resolve(String(args.shift() || ''));
    else if (token.startsWith('--cwd=')) options.cwd = path.resolve(token.slice(6));
    else if (token === '--parent') options.parent = path.resolve(String(args.shift() || ''));
    else if (token.startsWith('--parent=')) options.parent = path.resolve(token.slice(9));
    else if (token === '--protocol') options.protocol = String(args.shift() || 'https');
    else if (token.startsWith('--protocol=')) options.protocol = token.slice(11);
    else if (token === '--name') options.folderName = String(args.shift() || '');
    else if (token.startsWith('--name=')) options.folderName = token.slice(7);
    else if (token === '--model') options.model = String(args.shift() || '');
    else if (token.startsWith('--model=')) options.model = token.slice(8);
    else if (token === '--out') options.out = path.resolve(String(args.shift() || ''));
    else if (token.startsWith('--out=')) options.out = path.resolve(token.slice(6));
    else if (!options.command && !token.startsWith('-')) options.command = token;
    else if (THREAD_ID_COMMANDS.has(options.command) && !options.resume && !token.startsWith('-')) options.resume = token;
    else if (options.command === 'exec' || options.command === 'resume') options.prompt = options.prompt ? `${options.prompt} ${token}` : token;
    else if (!token.startsWith('-')) options.prompt = options.prompt ? `${options.prompt} ${token}` : token;
    else throw new Error(`未知参数：${token}`);
  }
  if (options.command === 'resume') options.command = 'exec';
  if (!options.command && options.prompt) options.command = 'exec';
  return options;
}

function findAppServer(repoRoot) {
  const explicit = process.env.CODEX_APP_SERVER_CMD;
  if (explicit) return { command: explicit, args: [], source: 'env' };
  const name = process.platform === 'win32' ? 'codex.exe' : 'codex';
  const candidates = [
    path.join(repoRoot, 'vendor', 'app-server', name),
    path.join(repoRoot, 'src-tauri', 'target', 'debug', 'resources', 'app-server', name),
    path.join(repoRoot, 'src-tauri', 'target', 'release', 'resources', 'app-server', name),
    process.resourcesPath ? path.join(process.resourcesPath, 'app-server', name) : '',
  ].filter(Boolean);
  for (const vendor of candidates) {
    if (fs.existsSync(vendor)) return { command: vendor, args: LOCAL_ONLY_APP_SERVER_ARGS, source: 'vendor' };
  }
  const binRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OpenAI', 'Codex', 'bin');
  if (fs.existsSync(binRoot)) {
    const listed = fs.readdirSync(binRoot).map((dir) => {
      const file = path.join(binRoot, dir, name);
      return fs.existsSync(file) ? { path: file, mtime: fs.statSync(file).mtimeMs } : null;
    }).filter(Boolean).sort((left, right) => right.mtime - left.mtime);
    if (listed[0]) return { command: listed[0].path, args: LOCAL_ONLY_APP_SERVER_ARGS, source: 'codex-bin' };
  }
  return null;
}

function collectAgentText(items) {
  return (Array.isArray(items) ? items : []).flatMap((item) => {
    if (!item) return [];
    if (item.type === 'agentMessage' || item.type === 'message') {
      return [String(item.text || item.content?.map?.((part) => part.text).filter(Boolean).join('\n') || '')];
    }
    if (typeof item.text === 'string' && item.text.trim()) return [item.text];
    return [];
  }).filter((text) => text.trim()).join('\n\n');
}

function collectThreadText(thread) {
  const turns = Array.isArray(thread?.turns) ? thread.turns : [];
  return collectAgentText(turns.flatMap((turn) => Array.isArray(turn.items) ? turn.items : []));
}

function serializeThreadExport(thread, threadId) {
  const payload = thread && typeof thread === 'object' ? thread : {};
  return {
    format: 'local-codex-thread',
    version: 1,
    thread: payload,
    turns: Array.isArray(payload.turns) ? payload.turns : [],
    threadId: String(threadId || payload.id || ''),
  };
}

function itemPlainText(item) {
  if (!item) return '';
  if (typeof item.text === 'string' && item.text.trim()) return item.text;
  if (Array.isArray(item.content)) {
    return item.content.map((part) => String(part?.text || '')).filter(Boolean).join('\n');
  }
  return '';
}

function parseThreadImport(content, fallbackTitle = '导入的线程') {
  const source = String(content || '');
  const titleFromPath = String(fallbackTitle || '导入的线程');
  try {
    const parsed = JSON.parse(source);
    const thread = parsed?.thread && typeof parsed.thread === 'object' ? parsed.thread : {};
    const title = String(thread.title || thread.name || parsed?.title || titleFromPath);
    const roleTurns = Array.isArray(parsed?.turns)
      ? parsed.turns.filter((item) => (item?.role === 'user' || item?.role === 'agent') && item.text)
      : [];
    const listedMessages = Array.isArray(parsed?.messages) ? parsed.messages : [];
    const importedMessages = (roleTurns.length || listedMessages.length)
      ? [...roleTurns, ...listedMessages]
        .filter((item) => (item?.role === 'user' || item?.role === 'agent') && item.text)
        .map((item) => ({ role: item.role, text: String(item.text) }))
      : (Array.isArray(parsed?.turns) ? parsed.turns : []).flatMap((turn) => (Array.isArray(turn?.items) ? turn.items : []).flatMap((item) => {
        const text = itemPlainText(item);
        if (!text.trim()) return [];
        if (item.type === 'userMessage') return [{ role: 'user', text }];
        if (item.type === 'agentMessage' || item.type === 'message') return [{ role: 'agent', text }];
        return [];
      }));
    return { title, messages: importedMessages };
  } catch {
    return { title: titleFromPath, messages: source.trim() ? [{ role: 'user', text: source }] : [] };
  }
}

function injectItemsFromMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => (
    message.role === 'user'
      ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: message.text }] }
      : { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: message.text }] }
  ));
}

module.exports = {
  LOCAL_ONLY_APP_SERVER_ARGS,
  helpText,
  parseArgs,
  findAppServer,
  collectAgentText,
  collectThreadText,
  serializeThreadExport,
  parseThreadImport,
  injectItemsFromMessages,
  THREAD_ID_COMMANDS,
};
