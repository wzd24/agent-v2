import React, { useState } from 'react';
import { Message } from '../api';
import { ActivityRow } from './ActivityRow';
import { icons, UiIcon } from './UiIcon';

export function TurnView({ messages, running, index }: { messages: Message[]; running: boolean; index: number }) {
  const [collapsed, setCollapsed] = useState(false);
  const user = messages.find((message) => message.role === 'user');
  const agent = messages.find((message) => message.role === 'agent');
  const activities = messages.filter((message) => message.role === 'activity' && message.item);
  return <article className={`turn-view ${collapsed ? 'collapsed' : ''}`}>
    <button className="turn-meta" onClick={() => setCollapsed((value) => !value)} aria-expanded={!collapsed}><span className="turn-chevron"><UiIcon icon={collapsed ? icons.right : icons.down} /></span><span className={`activity-dot ${running ? 'run' : 'ok'}`} /><span>{running ? '处理中' : '已完成'}</span><span className="turn-index">#{index + 1}</span></button>
    {!collapsed && <>
    {user && <div className="prompt-row"><div className="prompt-marker"><UiIcon icon={icons.right} /></div><div className="prompt-text">{user.text}</div></div>}
    {(agent || activities.length > 0) && <div className="agent-row"><div className="agent-mark"><UiIcon icon={icons.activity} /></div><div className="agent-content">{agent && <div className={`agent-text ${running ? 'streaming' : ''}`}>{agent.text || '处理中…'}</div>}{activities.length > 0 && <div className="activity-list">{activities.map((message, activityIndex) => <ActivityRow key={`${message.item?.id || message.item?.type}-${activityIndex}`} item={message.item!} />)}</div>}</div></div>}
    </>}
  </article>;
}
