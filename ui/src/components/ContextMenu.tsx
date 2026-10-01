import React from 'react';
import { createPortal } from 'react-dom';
import { useCoverBrowser } from '../coverBrowser';

export type ContextMenuAction = {
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  children?: ContextMenuItem[];
};
export type ContextMenuItem = ContextMenuAction | { separator: true };

export function hasContextActions(items: ContextMenuItem[]): boolean {
  return items.some((item) => {
    if ("separator" in item) return false;
    if (item.children?.length) return hasContextActions(item.children);
    return true;
  });
}

type Props = {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onSelect: (id: string) => void;
  onClose: () => void;
};

export function ContextMenu({ x, y, items, onSelect, onClose }: Props) {
  const ref = React.useRef<HTMLDivElement>(null);
  const actionable = hasContextActions(items);
  useCoverBrowser(actionable);
  const [pos, setPos] = React.useState({ left: x, top: y });
  const [openId, setOpenId] = React.useState("");
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
  if (!actionable) return null;
  return createPortal(
    <div ref={ref} className="app-context-menu" role="menu" style={{ left: pos.left, top: pos.top }} onContextMenu={(event) => event.preventDefault()}>
      {items.map((item, index) => {
        if ('separator' in item) return <div className="app-context-menu-separator" key={`sep-${index}`} />;
        const hasChildren = Boolean(item.children?.length);
        if (!hasChildren) {
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
        }
        const opened = openId === item.id;
        return (
          <div
            className={`app-context-submenu-item ${opened ? 'open' : ''}`}
            key={item.id}
            onMouseEnter={() => { if (!item.disabled) setOpenId(item.id); }}
            onMouseLeave={() => setOpenId((current) => (current === item.id ? '' : current))}
          >
            <button
              type="button"
              role="menuitem"
              disabled={item.disabled}
              aria-haspopup="menu"
              aria-expanded={opened}
              className={item.danger ? 'danger' : undefined}
              onClick={(event) => {
                event.preventDefault();
                if (item.disabled) return;
                setOpenId((current) => (current === item.id ? '' : item.id));
              }}
            >
              <span>{item.label}</span>
              <em>›</em>
            </button>
            {opened && (
              <div className="app-context-menu app-context-submenu" role="menu">
                {(item.children || []).map((child, childIndex) => {
                  if ('separator' in child) return <div className="app-context-menu-separator" key={`sep-${item.id}-${childIndex}`} />;
                  return (
                    <button
                      type="button"
                      role="menuitem"
                      key={child.id}
                      disabled={child.disabled}
                      className={child.danger ? 'danger' : undefined}
                      onClick={() => {
                        if (child.disabled) return;
                        onSelect(child.id);
                        onClose();
                      }}
                    >
                      {child.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
