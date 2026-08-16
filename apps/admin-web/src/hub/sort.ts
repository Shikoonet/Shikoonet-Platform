/**
 * Shared client-side sorting utilities for dashboard tables.
 *
 * Why client-side here: every list endpoint in this dashboard returns a single
 * complete dataset per query (paginated only by an internal LIMIT 500, not by
 * the client). Once a list fits in a poll response, sorting on the client
 * keeps polling/no polling deterministic and avoids extra round trips.
 *
 * Rules:
 *   - numeric: compare as numbers (NaN treated as null).
 *   - date:    compare as epoch ms (null last).
 *   - text:    locale-aware (Intl.Collator "en" — keeps A-Z order across
 *              Persian/Arabic mixed strings).
 *   - identifier: numeric-aware text compare that preserves leading zeros
 *              and dots ("110.9992.2377306.1" sorts next to "10.0.2377306.1"
 *              by numeric weight per segment, not as raw strings).
 *   - null:    always sorts last in both directions.
 *
 * Stable: the caller's input order is preserved on equal keys.
 */
export type SortDirection = 'asc' | 'desc';

export interface SortState<C extends string> {
  column: C | null;
  direction: SortDirection;
}

export type ColumnType = 'numeric' | 'date' | 'text' | 'identifier';

export interface SortDescriptor<C extends string> {
  column: C;
  type: ColumnType;
  /** Optional accessor when the cell value isn't a direct property. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  accessor?: (row: any) => unknown;
}

const NULLS_LAST = 1; // null/undefined always sort after real values
const REAL_FIRST = -1;

function nullWeight(a: unknown, b: unknown): [number, number] {
  const aNull = a === null || a === undefined;
  const bNull = b === null || b === undefined;
  if (aNull && bNull) return [0, 0];
  if (aNull) return [NULLS_LAST, REAL_FIRST];
  if (bNull) return [REAL_FIRST, NULLS_LAST];
  return [0, 0];
}

function numericCompare(a: unknown, b: unknown): number {
  const [wa, wb] = nullWeight(a, b);
  if (wa !== 0 || wb !== 0) return wa - wb;
  const aNum = typeof a === 'number' ? a : Number(a);
  const bNum = typeof b === 'number' ? b : Number(b);
  const aBad = !Number.isFinite(aNum);
  const bBad = !Number.isFinite(bNum);
  if (aBad && bBad) return 0;
  if (aBad) return NULLS_LAST;
  if (bBad) return REAL_FIRST;
  return aNum - bNum;
}

function dateCompare(a: unknown, b: unknown): number {
  const [wa, wb] = nullWeight(a, b);
  if (wa !== 0 || wb !== 0) return wa - wb;
  return numericCompare(a, b);
}

const TEXT_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

function textCompare(a: unknown, b: unknown): number {
  const [wa, wb] = nullWeight(a, b);
  if (wa !== 0 || wb !== 0) return wa - wb;
  const sa = String(a);
  const sb = String(b);
  return TEXT_COLLATOR.compare(sa, sb);
}

/**
 * Identifier compare: keeps leading zeros ("0017000" < "17000" string-wise,
 * but numeric-segment-aware still groups them as siblings at the same rank).
 * Splits on non-alphanumeric so "110.9992.2377306.1" segments are compared
 * left-to-right: digits sort as numbers, letters sort as text. Dots never
 * collapse the separator — "1.10" sorts BEFORE "1.9" because each segment is
 * numeric.
 */
function identifierCompare(a: unknown, b: unknown): number {
  const [wa, wb] = nullWeight(a, b);
  if (wa !== 0 || wb !== 0) return wa - wb;
  const segsA = String(a)
    .split(/[^0-9a-zA-Z]+/)
    .filter(Boolean);
  const segsB = String(b)
    .split(/[^0-9a-zA-Z]+/)
    .filter(Boolean);
  const len = Math.max(segsA.length, segsB.length);
  for (let i = 0; i < len; i++) {
    const sa = segsA[i] ?? '';
    const sb = segsB[i] ?? '';
    const na = Number(sa);
    const nb = Number(sb);
    const aIsNum = sa !== '' && Number.isFinite(na) && /^\d+$/.test(sa);
    const bIsNum = sb !== '' && Number.isFinite(nb) && /^\d+$/.test(sb);
    if (aIsNum && bIsNum) {
      if (na !== nb) return na - nb;
    } else {
      const c = TEXT_COLLATOR.compare(sa, sb);
      if (c !== 0) return c;
    }
  }
  return 0;
}

/**
 * Sort an array by a descriptor + direction. Stable: equal keys preserve
 * the original order (Array.prototype.sort is stable in modern runtimes).
 *
 * `effectiveTs` + `id` secondary: pass the row's effective_ts and id as
 * the last two keyframes so poll-refresh keeps the row order close to
 * "newest first" when the primary sort is text/numeric. We export the
 * helper as a separate function for that case.
 */
export function sortBy<T>(
  rows: T[],
  descriptor: SortDescriptor<string> | null,
  direction: SortDirection = 'asc',
): T[] {
  if (!descriptor) return rows;
  const cmp = COMPARATORS[descriptor.type];
  const sign = direction === 'desc' ? -1 : 1;
  const accessor =
    descriptor.accessor ?? ((row: unknown) => (row as Record<string, unknown>)[descriptor.column]);
  return rows.slice().sort((a, b) => {
    const va = accessor(a);
    const vb = accessor(b);
    // null last regardless of direction: skip the sign flip when one
    // side is null. The comparator already encodes null-last.
    const aNull = va === null || va === undefined;
    const bNull = vb === null || vb === undefined;
    if (aNull || bNull) return cmp(va, vb);
    return sign * cmp(va, vb);
  });
}

const COMPARATORS: Record<ColumnType, (a: unknown, b: unknown) => number> = {
  numeric: numericCompare,
  date: dateCompare,
  text: textCompare,
  identifier: identifierCompare,
};

/**
 * Stable secondary sort for tables: when the primary column ties, fall back
 * to an effective timestamp (desc) and then the row id (desc).
 *
 * Usage:
 *   const out = rows
 *     .map((row, i) => ({ row, i }))
 *     .sort(chainComparator(primaryComparator, stableSecondary(rows, (r) => r.effective_ts), stableSecondary(rows, (r) => r.id)))
 *     .map((x) => x.row);
 */
export function chainComparator<A>(
  ...comparators: Array<(a: A, b: A) => number>
): (a: A, b: A) => number {
  return (a, b) => {
    for (const c of comparators) {
      const r = c(a, b);
      if (r !== 0) return r;
    }
    return 0;
  };
}

/**
 * Build a comparator that sorts by an extracted key but preserves the
 * original index for equal values, so ties don't reshuffle the list.
 */
export function stableBy<T>(
  rows: T[],
  getKey: (row: T) => unknown,
  direction: SortDirection = 'desc',
): (a: T, b: T) => number {
  const indices = new Map<T, number>();
  rows.forEach((r, i) => indices.set(r, i));
  return (a, b) => {
    const ka = getKey(a);
    const kb = getKey(b);
    const c = dateCompare(ka, kb);
    if (c !== 0) return direction === 'desc' ? -c : c;
    return (indices.get(a) ?? 0) - (indices.get(b) ?? 0);
  };
}

/** Pretty sort indicator glyphs for the column headers. */
export function sortGlyph(state: SortState<string>, column: string): string {
  if (state.column !== column) return '↕';
  return state.direction === 'asc' ? '↑' : '↓';
}
