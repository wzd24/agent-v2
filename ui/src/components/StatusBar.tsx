import React from 'react';

export function StatusBar({ mock, model, tokens, tokenHistory = [], sandbox = 'workspace-write', network = '关' }: { mock: boolean; model: string; tokens: number; tokenHistory?: number[]; sandbox?: string; network?: string }) {
  const max = Math.max(...tokenHistory, tokens, 1);
  return <footer className="statusbar"><span><span className="dot" /> {mock ? 'Mock 服务' : '本地 app-server'}</span><span>模型: {model || '未配置'}</span><span>沙箱: {sandbox}</span><span>网络: {network}</span>{tokens > 0 && <span className="token-usage"><span>本地 token: {tokens.toLocaleString()}</span>{tokenHistory.length > 1 && <span className="token-spark" title="最近回合 token 用量">{tokenHistory.slice(-12).map((value, index) => <i key={`${value}-${index}`} style={{ height: `${Math.max(2, Math.round((value / max) * 16))}px` }} />)}</span>}</span>}</footer>;
}
