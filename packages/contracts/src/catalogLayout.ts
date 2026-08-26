/**
 * Where the shop breaks its rows.
 *
 * The keyboard layout next door (`botKeyboard.ts`) positions a CLOSED set of
 * buttons declared in `MENUS`, and it can afford absolute `(row, col)` cells
 * because that set never changes underneath it. A shop screen cannot: the rows
 * are database rows, they come and go, and half of them are invisible to any
 * particular customer — a reseller tier, a once-per-user offer they already
 * took, a panel at capacity.
 *
 * So this stores one number, not two.
 *
 *   Buttons come out in the list's own order. Consecutive buttons carrying the
 *   same non-null `rowIndex` share a row. A null `rowIndex` gets a row to
 *   itself.
 *
 * That is a REFLOW, and the difference from the keyboard's absolute grid is the
 * whole reason this file exists. Six plans arranged two-per-row, two of them not
 * purchasable by this customer:
 *
 *   absolute placement, gaps closed   →   rows of 1, 1, 2
 *   consecutive grouping              →   rows of 2, 2
 *
 * The admin said «two per row». Only the second one still says it after the
 * filter runs. And an empty row is impossible here rather than filtered out
 * afterwards: a row exists only because a button is in it.
 */

/** Telegram refuses more than eight buttons in one inline row. */
export const MAX_ROW_WIDTH = 8;

/**
 * Telegram's own ceiling is a hundred rows. A shop screen stops being readable
 * on a phone long before that, and a screen this long is a catalogue that wants
 * splitting into categories rather than a layout that wants saving.
 */
export const MAX_CATALOG_ROWS = 20;

/** One button's place in a shop screen. */
export interface CatalogPlacement {
  id: number;
  /** Null means «not arranged» — this button gets a row of its own. */
  rowIndex: number | null;
}

export type CatalogLayoutProblem =
  | { kind: 'EMPTY' }
  | { kind: 'DUPLICATE_ID'; ids: number[] }
  | { kind: 'FOREIGN_ID'; ids: number[] }
  | { kind: 'MIXED_ARRANGEMENT' }
  | { kind: 'ROW_NOT_MONOTONIC'; ids: number[] }
  | { kind: 'ROW_GAP'; rows: number[] }
  | { kind: 'ROW_TOO_WIDE'; row: number; limit: number }
  | { kind: 'TOO_MANY_ROWS'; limit: number };

/**
 * Whether an arrangement may be saved.
 *
 * `MIXED_ARRANGEMENT` and the two ordering rules are the ones worth explaining.
 *
 * A save posts a WHOLE screen, so half-arranged is never something an operator
 * can mean — it is a bug in the page that sent it. Reading a mixed state is
 * fine and happens all the time: arrange a category today, add a plan next
 * week, and that plan arrives null and appears on its own line. Visible, at its
 * sort position, rather than hidden. So the mix is legal on the way out and
 * refused on the way in.
 *
 * `ROW_NOT_MONOTONIC` plus `ROW_GAP` do something subtler: together they make
 * «group consecutive equal values» and «group all equal values» the same
 * function. Without them a layout could name rows 0, 1, 0 and the two
 * definitions would disagree — one drawing three rows, the other two. Two
 * definitions that cannot disagree beat one definition and a comment.
 */
export function checkCatalogLayout(
  items: readonly CatalogPlacement[],
  scopeIds: readonly number[],
): CatalogLayoutProblem | null {
  if (items.length === 0) return { kind: 'EMPTY' };

  const seen = new Set<number>();
  const duplicated = new Set<number>();
  for (const item of items) {
    if (seen.has(item.id)) duplicated.add(item.id);
    seen.add(item.id);
  }
  if (duplicated.size > 0) return { kind: 'DUPLICATE_ID', ids: [...duplicated] };

  // The trust boundary. The caller supplies what this screen really contains,
  // read from the database rather than from the request, so a post to one
  // category cannot rewrite the order of another's.
  const belongs = new Set(scopeIds);
  const foreign = items.filter((i) => !belongs.has(i.id)).map((i) => i.id);
  if (foreign.length > 0) return { kind: 'FOREIGN_ID', ids: foreign };

  const arranged = items.filter((i) => i.rowIndex !== null);
  if (arranged.length === 0) return null;
  if (arranged.length !== items.length) return { kind: 'MIXED_ARRANGEMENT' };

  const rows = items.map((i) => i.rowIndex as number);

  const backwards = items.filter((item, at) => at > 0 && rows[at]! < rows[at - 1]!).map((i) => i.id);
  if (backwards.length > 0) return { kind: 'ROW_NOT_MONOTONIC', ids: backwards };

  const used = [...new Set(rows)].sort((a, b) => a - b);
  const missing = used.length === 0 ? [] : range(0, used[used.length - 1]!).filter((n) => !used.includes(n));
  if (missing.length > 0) return { kind: 'ROW_GAP', rows: missing };

  if (used.length > MAX_CATALOG_ROWS) return { kind: 'TOO_MANY_ROWS', limit: MAX_CATALOG_ROWS };

  for (const row of used) {
    const width = rows.filter((n) => n === row).length;
    if (width > MAX_ROW_WIDTH) return { kind: 'ROW_TOO_WIDE', row, limit: MAX_ROW_WIDTH };
  }

  return null;
}

function range(from: number, toInclusive: number): number[] {
  const out: number[] = [];
  for (let n = from; n <= toInclusive; n += 1) out.push(n);
  return out;
}

/**
 * The one grouping the browser's preview and the bot's keyboard both call.
 *
 * Not a validator — this is the READ path, and it is handed whatever survived
 * the customer's own visibility rules. It takes the list already in the order
 * it should be drawn.
 *
 * The width fence is deliberate and is NOT a duplicate of `ROW_TOO_WIDE`.
 * `checkCatalogLayout` guards what may be written; this guards what may be
 * sent. Between them sits a `psql` session, a migration, and a future route,
 * and a keyboard Telegram rejects takes the whole message down rather than one
 * button. The same reasoning `botContent.ts` gives for re-clamping what it
 * reads.
 */
export function groupIntoRows<T extends { rowIndex: number | null }>(
  items: readonly T[],
): T[][] {
  const rows: T[][] = [];
  let currentRow: number | null = null;

  for (const item of items) {
    const last = rows[rows.length - 1];
    const continues =
      item.rowIndex !== null && item.rowIndex === currentRow && last !== undefined && last.length < MAX_ROW_WIDTH;
    if (continues) {
      last.push(item);
    } else {
      rows.push([item]);
      currentRow = item.rowIndex;
    }
  }

  return rows;
}
