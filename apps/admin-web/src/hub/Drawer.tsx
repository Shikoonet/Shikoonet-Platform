/** Slide-in drawer for navigation (mobile) or right-side panel (tablet +
 *  compact desktop). Keyboard friendly. */

import { useEffect, useRef } from 'react';

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  label: string;
  children: React.ReactNode;
  /** 'left' (default) for nav, 'right' for content panels like Comments. */
  side?: 'left' | 'right';
}

export function Drawer({ open, onClose, label, children, side = 'left' }: DrawerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Focus the container so screen-readers land inside the drawer.
    containerRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  const className = side === 'right' ? 'drawer drawer--right' : 'drawer';
  return (
    <div
      className="drawer-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={containerRef} className={className} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
