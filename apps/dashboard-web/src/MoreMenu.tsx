/**
 * MoreMenu — portal-based action menu.
 *
 * Why a portal: the surrounding `.data-table-wrapper` clips
 * `position: absolute` descendants, so the existing inline
 * `<details><summary>More…</summary>` is partially cut off at the table
 * edge. Rendering through `createPortal(menu, document.body)` with
 * `position: fixed` lets the menu escape any clipping ancestor.
 *
 * Positioning: read the trigger's `getBoundingClientRect()` on open and
 * again on every `window` resize + scroll event (capture phase on
 * `window`, scroll bubbling through every ancestor). Flip above when
 * the menu would overflow the viewport, right-align when the trigger is
 * near the right edge. Recompute, don't predict.
 *
 * Closing: outside `mousedown`, `Escape`, action selection, or unmount.
 * Focus returns to the trigger on close (matches the existing Drawer +
 * NotificationBell ergonomics).
 *
 * Z-index: 200 — above `.notification-bell__dropdown` (100) and
 * `.modal-backdrop` / `.drawer-backdrop` (60).
 *
 * No external deps. `createPortal` comes from `react-dom` (already a
 * workspace dep).
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

const VIEWPORT_MARGIN = 8;
const MENU_MIN_WIDTH = 200;
const MENU_MAX_HEIGHT = 360;

export interface MoreMenuAction {
  key: string;
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface MoreMenuProps {
  /** Stable per-row label (e.g. "More actions for transaction <id>"). */
  ariaLabel?: string;
  actions: MoreMenuAction[];
  /** Visible label inside the trigger. Defaults to "More". */
  triggerLabel?: string;
  /** Allows the parent to mark the row seen on menu open (matches
   *  the "opening the More menu" rule in the spec). Optional. */
  onOpen?: () => void;
}

interface Position {
  top: number;
  left: number;
  flip: boolean;
}

function computePosition(trigger: HTMLElement, menu: HTMLElement): Position {
  const rect = trigger.getBoundingClientRect();
  const menuHeight = Math.min(menu.offsetHeight, MENU_MAX_HEIGHT) || MENU_MIN_WIDTH;
  const menuWidth = menu.offsetWidth || MENU_MIN_WIDTH;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // Default: below the trigger, right-aligned to its right edge.
  let top = rect.bottom + VIEWPORT_MARGIN;
  let left = rect.right - menuWidth;
  // Flip above when overflow.
  if (top + menuHeight > vh - VIEWPORT_MARGIN && rect.top - menuHeight - VIEWPORT_MARGIN >= 0) {
    top = rect.top - menuHeight - VIEWPORT_MARGIN;
  }
  // Clamp horizontally.
  if (left < VIEWPORT_MARGIN) left = VIEWPORT_MARGIN;
  if (left + menuWidth > vw - VIEWPORT_MARGIN) left = vw - VIEWPORT_MARGIN - menuWidth;

  return {
    top,
    left,
    flip: top < rect.top,
  };
}

export function MoreMenu({ ariaLabel, actions, triggerLabel = 'More', onOpen }: MoreMenuProps) {
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<Position | null>(null);
  const reactId = useId();
  const menuId = `more-menu-${reactId}`;

  const recompute = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;
    setPos(computePosition(trigger, menu));
  }, []);

  const close = useCallback((returnFocus = true) => {
    setOpen(false);
    setPos(null);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Click outside / Escape.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Recompute on open, window resize, scroll (capture so we catch
  // all ancestor scrolls, not just window). Re-runs after the portal
  // mounts so menuRef.current is non-null on the second pass.
  useLayoutEffect(() => {
    if (!open) return;
    recompute();
    const handler = () => recompute();
    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler, true);
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('scroll', handler, true);
    };
  }, [open, recompute, pos == null]);

  const openMenu = () => {
    if (open) {
      close();
      return;
    }
    setOpen(true);
    onOpen?.();
  };

  const onMenuAction = (a: MoreMenuAction) => {
    if (a.disabled) return;
    close(false);
    a.onSelect();
  };

  const cls = pos
    ? `more-menu-portal${pos.flip ? ' more-menu-portal--above' : ''}`
    : 'more-menu-portal';

  // Initial position is from the trigger alone (menu not yet measured).
  // useLayoutEffect above recalculates with the actual menu height once
  // the portal has mounted.
  const initialTop = pos?.top ?? 0;
  const initialLeft = pos?.left ?? 0;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="actions-more-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={ariaLabel ?? triggerLabel}
        onClick={openMenu}
      >
        {triggerLabel}
        <span aria-hidden="true" className="actions-more-trigger__caret">
          {open ? '▴' : '▾'}
        </span>
      </button>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            id={menuId}
            className={cls}
            style={{
              position: 'fixed',
              top: initialTop,
              left: initialLeft,
              visibility: pos ? 'visible' : 'hidden',
              zIndex: 1200,
            }}
          >
            <div role="menu" className="more-menu-panel" aria-labelledby={menuId}>
              {actions.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  role="menuitem"
                  disabled={a.disabled}
                  className={
                    a.danger
                      ? 'more-menu-portal__item more-menu-portal__item--danger'
                      : 'more-menu-portal__item'
                  }
                  onClick={() => onMenuAction(a)}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
