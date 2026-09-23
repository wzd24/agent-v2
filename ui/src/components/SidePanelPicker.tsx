import React from 'react';
import { useCoverBrowser } from '../coverBrowser';
import { icons, UiIcon } from './UiIcon';

type SidePanelPickerProps = { onSelect: (panel: string) => void; onClose: () => void };

const options = [
  { panel: 'review', label: '审查', shortcut: 'Ctrl+Shift+G', icon: icons.fileCode },
  { panel: 'browser', label: '浏览器', shortcut: 'Ctrl+T', icon: icons.globe },
  { panel: 'files', label: '文件', shortcut: 'Ctrl+P', icon: icons.file },
];

export function SidePanelPicker({ onSelect, onClose }: SidePanelPickerProps) {
  useCoverBrowser(true);
  return <aside className="side-panel-picker" aria-label="侧边面板">
    <button type="button" className="side-panel-picker-close" title="关闭侧边面板" onClick={onClose}><UiIcon icon={icons.close} /></button>
    <div className="side-panel-picker-list">
      {options.map((option) => <button type="button" className="side-panel-picker-option" key={option.panel} onClick={() => onSelect(option.panel)}>
        <UiIcon icon={option.icon} /><span>{option.label}</span><kbd>{option.shortcut}</kbd>
      </button>)}
    </div>
  </aside>;
}
