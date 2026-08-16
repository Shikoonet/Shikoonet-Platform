/**
 * Sortable <th> header.
 *
 * - Renders a <button> inside the <th> so screen readers announce the role
 *   and keyboard users can activate with Enter / Space (the button's default
 *   behavior). The wrapper still gets `aria-sort` on the <th>.
 * - Three click states: asc → desc → none. The "none" state is optional; we
 *   keep it (clicks off) so the user can return to the polled default.
 *
 * Pair with `useTableSortState` for URL persistence.
 */
import type { ReactNode } from 'react';
import type { SortDirection, SortState } from './sort.js';

export interface SortableHeaderProps {
  column: string;
  label: ReactNode;
  state: SortState<string>;
  onChange: (state: SortState<string>) => void;
  /** Default direction when going from "none" → asc. Defaults to 'asc'. */
  defaultDirection?: SortDirection;
  className?: string;
}

export function SortableHeader({
  column,
  label,
  state,
  onChange,
  defaultDirection = 'asc',
  className,
}: SortableHeaderProps) {
  const active = state.column === column;
  const direction = active ? state.direction : null;
  const ariaSort = direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none';
  const indicator = !active ? '↕' : direction === 'asc' ? '↑' : '↓';

  function onClick() {
    if (!active) {
      onChange({ column, direction: defaultDirection });
    } else if (state.direction === 'asc') {
      onChange({ column, direction: 'desc' });
    } else {
      onChange({ column: null, direction: 'asc' });
    }
  }

  function onKey(e: React.KeyboardEvent<HTMLButtonElement>) {
    // Buttons already handle Enter/Space; click is the canonical activation.
    if (e.key === 'Enter' || e.key === ' ') e.preventDefault();
  }

  return (
    <th aria-sort={ariaSort} className={className}>
      <button
        type="button"
        className="th-button"
        onClick={onClick}
        onKeyDown={onKey}
        aria-label={
          active
            ? `${label}، مرتب‌شده ${ariaSort === 'ascending' ? 'صعودی' : 'نزولی'}، برای ${
                state.direction === 'asc' ? 'مرتب‌سازی نزولی' : 'برداشتن مرتب‌سازی'
              } کلیک کنید`
            : `${label}، برای مرتب‌سازی صعودی کلیک کنید`
        }
      >
        <span className="th-label">{label}</span>
        <span className="th-sort" aria-hidden="true">
          {indicator}
        </span>
      </button>
    </th>
  );
}
