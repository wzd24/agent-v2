import React from 'react';
import { useAppDialog } from './AppDialog';
import { icons, UiIcon } from './UiIcon';

export function McpPanel({ servers, onReload, onCallTool, onReadResource }: { servers: any[]; onReload: () => Promise<void>; onCallTool: (server: string, tool: string, args: any) => Promise<any>; onReadResource: (server: string, uri: string) => Promise<any> }) {
  const dialog = useAppDialog();
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [result, setResult] = React.useState('');
  const toggle = (name: string) => setOpen((old) => { const next = new Set(old); next.has(name) ? next.delete(name) : next.add(name); return next; });
  async function callTool(server: string, tool: string) {
    const raw = await dialog.prompt(`调用 ${server}/${tool}`, '{}', { message: 'JSON 参数', multiline: true });
    if (raw == null) return;
    try {
      const args = raw.trim() ? JSON.parse(raw) : {};
      setResult(JSON.stringify(await onCallTool(server, tool, args), null, 2));
    } catch (error) {
      setResult(String(error));
    }
  }
  async function readResource(server: string, uri: string) { try { setResult(JSON.stringify(await onReadResource(server, uri), null, 2)); } catch (error) { setResult(String(error)); } }
  return <div className="mcp-panel"><div className="panel-refresh-row"><span>本地 MCP 服务</span><button className="btn small" onClick={() => void onReload()}><UiIcon icon={icons.refresh} /> 重载</button></div>{servers.length === 0 ? <div className="mcp-empty">未配置 MCP 服务</div> : servers.map((server) => { const tools = Object.entries(server.tools || {}) as Array<[string, any]>; const resources = Array.isArray(server.resources) ? server.resources : []; const templates = Array.isArray(server.resourceTemplates) ? server.resourceTemplates : []; const expanded = open.has(server.name); return <section className="mcp-server" key={server.name}><button className="mcp-server-head" onClick={() => toggle(server.name)} aria-expanded={expanded}><span className={`mcp-state ${server.runtimeStatus || 'notStarted'}`} /><span><strong>{server.name}</strong><small>{server.runtimeStatus || 'notStarted'} · {tools.length} 工具 · {resources.length} 资源</small></span><UiIcon icon={expanded ? icons.down : icons.right} /></button>{expanded && <div className="mcp-server-body">{tools.length > 0 && <div className="mcp-group"><b>工具</b>{tools.map(([name, tool]) => <button key={name} onClick={() => void callTool(server.name, name)}><UiIcon icon={icons.terminal} /><span><strong>{tool.title || tool.name || name}</strong><small>{tool.description || name}</small></span></button>)}</div>}{resources.length > 0 && <div className="mcp-group"><b>资源</b>{resources.map((resource: any) => <button key={resource.uri} onClick={() => void readResource(server.name, resource.uri)}><UiIcon icon={icons.file} /><span><strong>{resource.title || resource.name}</strong><small>{resource.uri}</small></span></button>)}</div>}{templates.length > 0 && <div className="mcp-group"><b>资源模板</b>{templates.map((template: any) => <div className="mcp-template" key={template.uriTemplate}><UiIcon icon={icons.code} /><span><strong>{template.title || template.name}</strong><small>{template.uriTemplate}</small></span></div>)}</div>}{tools.length === 0 && resources.length === 0 && templates.length === 0 && <div className="mcp-empty">服务尚未公布工具或资源</div>}</div>}</section>; })}{result && <div className="mcp-result"><div><strong>调用结果</strong><button title="清除" onClick={() => setResult('')}><UiIcon icon={icons.close} /></button></div><pre>{result}</pre></div>}{dialog.node}</div>;
}
