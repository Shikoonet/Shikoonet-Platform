/**
 * The one reduction from «what somebody typed» to «a part of a name the panel
 * will take». Three readers, one rule: the bot builds account names from it,
 * the dashboard route refuses a panel prefix it reduces to nothing, and the
 * panel editor shows the admin the name their text will actually produce.
 *
 * The charset is legacy's own (`index.php:3030`) — must start with a letter,
 * three characters at least, `[a-z0-9_]` only. The cap is not legacy's: it
 * has none, and a long text plus a suffix passed forty characters and the
 * panel answered 422 in the middle of a paid order.
 *
 * Underscores are collapsed and trimmed since 2026-09-16. PasarGuard takes
 * letters and digits joined by SINGLE underscores, and the bot adds its own
 * `_` before the order id — so «firstbuy_» became `firstbuy__e484…`, a 422,
 * and a FAILED paid order (Sam, «firstbuy_»).
 */
export const USERNAME_PART_MAX = 32;

export function sanitiseUsernamePart(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '')
    .slice(0, USERNAME_PART_MAX)
    .replace(/_+$/, '');
  return cleaned.length >= 3 ? cleaned : null;
}
