/**
 * NewBadge — compact, accessible "تازه" indicator for unread transactions.
 *
 * Renders nothing when `isNew` is false. Renders a compact pill with an
 * `aria-label="تراکنش تازه"` (the visible "تازه" is the same word) and
 * no animation when `prefers-reduced-motion: reduce` is set.
 *
 * Designed for use in both desktop tables and mobile cards. Pair with
 * the `transaction-row--new` class on the row for a subtle left accent
 * (see `apps/dashboard-web/src/styles.css`).
 */

interface NewBadgeProps {
  isNew: boolean | undefined | null;
  className?: string;
}

export function NewBadge({ isNew, className }: NewBadgeProps) {
  if (!isNew) return null;
  const cls = className ? `new-badge ${className}` : 'new-badge';
  return (
    <span className={cls} aria-label="تراکنش تازه">
      تازه
    </span>
  );
}
