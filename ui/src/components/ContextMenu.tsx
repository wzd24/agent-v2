import React from 'react';
import { useCoverBrowser } from '../coverBrowser';

export type ContextMenuItem = {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
} | { separator: true };

type Props = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
};

export function ContextMenu({ x, y, items, onSelect, onClose }: Props) {
  const ref = React.useRef<HTMLDivElement>(null);
  useCoverBrowser(true);
  const [pos, setPos] = React.useState({ left: x, top: y });
  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const left = Math.min(x, Math.max(6, window.innerWidth - rect.width - 6));
    const top = Math.min(y, Math.max(6, window.innerHeight - rect.height - 6));
    setPos({ left, top });
  }, [x, y, items]);
  React.useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };
    const onPointer = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointer, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointer, true);
    };
  }, [onClose]);
  return (
    <div ref={ref} className="app-context-menu" role="menu" style={{ left: pos.left, top: pos.top }} onContextMenu={(event) => event.preventDefault()}>
      {items.map((item, index) => {
        if ('separator' in item) return <div className="app-context-menu-separator" key={`sep-${index}`} />;
        return (
          <button
            type="button"
            role="menuitem"
            key={item.id}
            disabled={item.disabled}
            className={item.danger ? 'danger' : undefined}
            onClick={() => {
              if (item.disabled) return;
              onSelect(item.id);
              onClose();
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
