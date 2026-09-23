import React from 'react';
import { icons, UiIcon } from './UiIcon';

export type CollaborationModeOption = { name: string; sub?: string; mode?: string };

type AgentNode = { id: string; parent?: string; status: string; message?: string; children: string[] };

export function CollaborationPanel({
  modes,
  items,
  currentMode = '',
  onRefresh,
  onSelectMode,
}: {
  modes: CollaborationModeOption[];
  items: any[];
  currentMode?: string;
  onRefresh: () => void;
  onSelectMode?: (mode: CollaborationModeOption) => void;
}) {
  const nodes = React.useMemo(() => buildTree(items), [items]);
  const roots = [...nodes.values()].filter((node) => !node.parent || !nodes.has(node.parent));
  const activities = items.filter((item) => item.type === 'collabAgentToolCall' || item.type === 'subAgentActivity');
  return <div className="collaboration-panel">
    <div className="panel-refresh-row">
      <span>协作模式与子代理{currentMode ? ` · 当前 ${currentMode}` : ''}</span>
      <button className="btn small" onClick={onRefresh}><UiIcon icon={icons.refresh} /> 刷新</button>
    </div>
    <section className="collaboration-section">
      <h3>可用模式</h3>
      {modes.length === 0 ? <div className="collaboration-empty">没有可用协作模式</div> : modes.map((mode) => {
        const selected = currentMode === mode.name;
        return <button type="button" className={`collaboration-mode ${selected ? 'selected' : ''}`} key={`${mode.mode || ''}:${mode.name}`} onClick={() => onSelectMode?.(mode)}>
          <UiIcon icon={icons.nodes} />
          <span><strong>{mode.name}</strong><small>{mode.sub || '默认设置'}</small></span>
          {selected ? <em>当前</em> : null}
        </button>;
      })}
    </section>
    <section className="collaboration-section">
      <h3>代理任务树</h3>
      {roots.length === 0 ? <div className="collaboration-empty">当前线程没有子代理活动</div> : roots.map((node) => <AgentTree node={node} nodes={nodes} depth={0} key={node.id} />)}
    </section>
    {activities.length > 0 && <section className="collaboration-section">
      <h3>活动</h3>
      {activities.slice(-30).map((item, index) => <div className="collaboration-activity" key={`${item.id || item.type}-${index}`}><UiIcon icon={item.type === 'subAgentActivity' ? icons.activity : icons.nodes} /><span><strong>{item.type === 'subAgentActivity' ? item.kind : item.tool}</strong><small>{item.prompt || item.agentPath || `${(item.receiverThreadIds || []).length} 个目标`}</small></span><em>{item.status || ''}</em></div>)}
    </section>}
  </div>;
}

function buildTree(items: any[]): Map<string, AgentNode> {
  const nodes = new Map<string, AgentNode>();
  const ensure = (id: string) => { if (!nodes.has(id)) nodes.set(id, { id, status: 'unknown', children: [] }); return nodes.get(id)!; };
  for (const item of items) {
    if (item.type === 'collabAgentToolCall') {
      const sender = ensure(item.senderThreadId || 'root');
      for (const receiver of item.receiverThreadIds || []) {
        const child = ensure(receiver);
        child.parent = sender.id;
        const state = item.agentsStates?.[receiver];
        if (state) { child.status = state.status || child.status; child.message = state.message || child.message; }
        if (!sender.children.includes(receiver)) sender.children.push(receiver);
      }
    } else if (item.type === 'subAgentActivity') {
      const node = ensure(item.agentThreadId || item.agentPath || item.id);
      node.status = item.kind || node.status;
      node.message = item.agentPath || node.message;
    }
  }
  return nodes;
}

function AgentTree({ node, nodes, depth }: { node: AgentNode; nodes: Map<string, AgentNode>; depth: number }) {
  const [open, setOpen] = React.useState(true);
  return <div className="agent-tree"><button className="agent-tree-row" style={{ paddingLeft: `${8 + depth * 16}px` }} onClick={() => setOpen((value) => !value)}><UiIcon icon={node.children.length ? (open ? icons.down : icons.right) : icons.circle} /><span className={`agent-tree-state ${node.status}`} /><span><strong>{node.id}</strong><small>{node.status}{node.message ? ` · ${node.message}` : ''}</small></span></button>{open && node.children.map((id) => { const child = nodes.get(id); return child ? <AgentTree node={child} nodes={nodes} depth={depth + 1} key={id} /> : null; })}</div>;
}
