import React from 'react';
import { MessageAttachment } from '../api';
import { AppDialog } from './AppDialog';
import { icons, UiIcon } from './UiIcon';

type EnvironmentPanelProps = {
  workspaceRoot?: string;
  gitBranch?: string;
  conversationSources?: MessageAttachment[];
  gitBusy?: boolean;
  gitStatus?: string;
  onWorkspaceOpen?: () => void;
  onOpenLatestChanges?: () => void;
  onCommit?: (message: string) => void | Promise<boolean | void>;
  onPush?: () => void;
  onCreateBranch?: (name: string) => void | Promise<boolean | void>;
  confirmCommit?: boolean;
  onOpenSources?: () => void;
  onClose?: () => void;
};

export function EnvironmentPanel({
  workspaceRoot = '',
  gitBranch = '无 Git',
  conversationSources = [],
  gitBusy = false,
  gitStatus = '',
  onWorkspaceOpen,
  onOpenLatestChanges,
  onCommit,
  onPush,
  onCreateBranch,
  confirmCommit = true,
  onOpenSources,
  onClose,
}: EnvironmentPanelProps) {
  const [dialog, setDialog] = React.useState<null | 'commit' | 'confirm' | 'branch'>(null);
  const [draft, setDraft] = React.useState('');
  const [error, setError] = React.useState('');

  function openCommit() {
    setError('');
    setDraft('');
    setDialog('commit');
  }

  function openBranch() {
    setError('');
    setDraft('');
    setDialog('branch');
  }

  async function submit() {
    try {
      if (dialog === 'commit') {
        if (!draft.trim()) {
          setError('提交说明不能为空');
          return;
        }
        if (confirmCommit) {
          setDialog('confirm');
          return;
        }
        const ok = await onCommit?.(draft.trim());
        if (ok === false) {
          setError('提交失败');
          return;
        }
        setDialog(null);
        return;
      }
      if (dialog === 'confirm') {
        const ok = await onCommit?.(draft.trim());
        if (ok === false) {
          setError('提交失败');
          setDialog('commit');
          return;
        }
        setDialog(null);
        return;
      }
      if (dialog === 'branch') {
        if (!/^[A-Za-z0-9._/-]+$/.test(draft.trim()) || draft.includes('..')) {
          setError('分支名无效');
          return;
        }
        const ok = await onCreateBranch?.(draft.trim());
        if (ok === false) {
          setError('创建分支失败');
          return;
        }
        setDialog(null);
      }
    } catch (err) {
      setError(String(err));
    }
  }

  return <aside className="environment-panel" aria-label="环境信息">
    <div className="environment-heading"><strong>环境信息</strong><button type="button" title="关闭" onClick={onClose}><UiIcon icon={icons.close} /></button></div>
    <button type="button" className="environment-row environment-action" onClick={onWorkspaceOpen}><span className="env-icon"><UiIcon icon={icons.folderOpen} /></span><span>打开工作区</span><small className="environment-path" title={workspaceRoot}>{workspaceRoot ? workspaceRoot.split(/[\\/]/).pop() : '未选择'}</small></button>
    <button type="button" className="environment-row environment-action" onClick={onOpenLatestChanges}><span className="env-icon"><UiIcon icon={icons.fileCode} /></span><span>变更</span></button>
    <button type="button" className="environment-row environment-action" onClick={openBranch}><span className="env-icon"><UiIcon icon={icons.branch} /></span><span>{gitBranch}</span><small>新建并检出分支</small></button>
    <button type="button" className="environment-row environment-action" disabled={gitBusy} onClick={openCommit}><span className="env-icon"><UiIcon icon={icons.check} /></span><span>提交</span></button>
    <button type="button" className="environment-row environment-action" disabled={gitBusy} onClick={onPush}><span className="env-icon"><UiIcon icon={icons.up} /></span><span>推送</span></button>
    {gitStatus ? <div className="source-empty">{gitStatus}</div> : null}
    <div className="environment-divider" />
    <div className="environment-heading"><strong>来源</strong><button type="button" title="查看全部来源" onClick={onOpenSources}><UiIcon icon={icons.plus} /></button></div>
    {conversationSources.length === 0 ? <div className="source-empty">当前线程没有附加资源</div> : <div className="conversation-sources">{conversationSources.slice(0, 3).map((source) => <div className="conversation-source" key={source.path} title={source.path}><span className="conversation-source-icon"><UiIcon icon={String(source.type || '').startsWith('image/') ? icons.image : icons.file} /></span><span>{source.name || source.path.split(/[\\/]/).pop() || source.path}</span></div>)}</div>}
    {conversationSources.length > 3 && <button type="button" className="source-view-all" onClick={onOpenSources}><UiIcon icon={icons.link} /> 查看全部</button>}
    {dialog && (
      <AppDialog
        title={dialog === 'branch' ? '新建并检出分支' : dialog === 'confirm' ? '确认提交' : '提交更改'}
        message={
          dialog === 'branch'
            ? '在当前工作区创建分支并立即检出。'
            : dialog === 'confirm'
              ? `将暂存全部更改并提交：“${draft.trim()}”`
              : '会暂存工作区全部更改后提交。'
        }
        value={dialog === 'confirm' ? undefined : draft}
        placeholder={dialog === 'commit' ? '提交说明' : '例如 feature/local-search'}
        confirmLabel={dialog === 'branch' ? '创建' : dialog === 'confirm' ? '确认提交' : '提交'}
        error={error}
        busy={gitBusy}
        multiline={dialog === 'commit'}
        onChange={dialog === 'confirm' ? undefined : (value) => { setDraft(value); setError(''); }}
        onConfirm={() => void submit()}
        onCancel={() => setDialog(dialog === 'confirm' ? 'commit' : null)}
      />
    )}
  </aside>;
}
