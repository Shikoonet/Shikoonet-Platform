/**
 * Tests for the shared client-side sort utilities.
 *
 * Covers: numeric, date, text (locale-aware), identifier (segment-aware),
 * null-last, stable ordering.
 */
import { describe, it, expect } from 'vitest';
import { sortBy, chainComparator, stableBy, sortGlyph } from '../../src/hub/sort.js';

describe('sortBy numeric', () => {
  const rows = [
    { id: 'a', v: 100 },
    { id: 'b', v: 30 },
    { id: 'c', v: 200 },
  ];
  it('ascending: smallest first', () => {
    expect(sortBy(rows, { column: 'v', type: 'numeric' }, 'asc').map((r) => r.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });
  it('descending: largest first', () => {
    expect(sortBy(rows, { column: 'v', type: 'numeric' }, 'desc').map((r) => r.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });
});

describe('sortBy date (epoch)', () => {
  const rows = [
    { id: 'a', ts: 1000 },
    { id: 'b', ts: 3000 },
    { id: 'c', ts: 2000 },
  ];
  it('ascending by epoch', () => {
    expect(sortBy(rows, { column: 'ts', type: 'date' }, 'asc').map((r) => r.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
  });
  it('descending by epoch', () => {
    expect(sortBy(rows, { column: 'ts', type: 'date' }, 'desc').map((r) => r.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });
});

describe('sortBy text (locale-aware)', () => {
  const rows = [
    { id: 'a', name: 'Zeta' },
    { id: 'b', name: 'beta' },
    { id: 'c', name: 'Alpha' },
  ];
  it('case-insensitive, accent-light ordering', () => {
    // 'Alpha' < 'beta' < 'Zeta' regardless of case (sensitivity: 'base').
    expect(sortBy(rows, { column: 'name', type: 'text' }, 'asc').map((r) => r.id)).toEqual([
      'c',
      'b',
      'a',
    ]);
  });
});

describe('sortBy identifier (natural segments)', () => {
  const rows = [
    { id: 'a', n: '10.0.2377306.1' },
    { id: 'b', n: '110.7007.2377306.1' },
    { id: 'c', n: '9.5.1' },
    { id: 'd', n: '0017000' },
  ];
  it('segments numeric-aware; preserves raw display string', () => {
    const out = sortBy(rows, { column: 'n', type: 'identifier' }, 'asc').map((r) => r.n);
    // 9.5.1 < 10.0.2377306.1 < 110.7007.2377306.1 < 0017000 (17000)
    expect(out).toEqual(['9.5.1', '10.0.2377306.1', '110.7007.2377306.1', '0017000']);
  });

  it('preserves leading zeros in display (does not coerce to number)', () => {
    const out = sortBy(rows, { column: 'n', type: 'identifier' }, 'asc');
    // The "0017000" string must be preserved verbatim — never "17000".
    expect(out.find((r) => r.n === '0017000')).toBeTruthy();
  });
});

describe('null handling', () => {
  const rows = [
    { id: 'a', v: 1 },
    { id: 'b', v: null },
    { id: 'c', v: 2 },
  ];
  it('null sorts last when ascending', () => {
    expect(sortBy(rows, { column: 'v', type: 'numeric' }, 'asc').map((r) => r.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
  });
  it('null sorts last when descending', () => {
    expect(sortBy(rows, { column: 'v', type: 'numeric' }, 'desc').map((r) => r.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });
});

describe('stability', () => {
  it('preserves order for equal keys', () => {
    const rows = [
      { id: '1', v: 1 },
      { id: '2', v: 1 },
      { id: '3', v: 1 },
    ];
    expect(sortBy(rows, { column: 'v', type: 'numeric' }, 'asc').map((r) => r.id)).toEqual([
      '1',
      '2',
      '3',
    ]);
  });
});

describe('accessor fallback', () => {
  it('uses provided accessor', () => {
    const rows = [{ id: 'a' }, { id: 'b' }];
    const out = sortBy(
      rows,
      {
        column: 'computed',
        type: 'text',
        accessor: (r: { id: string }) => (r.id === 'a' ? 'Z' : 'A'),
      },
      'asc',
    ).map((r) => r.id);
    expect(out).toEqual(['b', 'a']);
  });
});

describe('chainComparator + stableBy', () => {
  it('falls through to secondary key when primary ties', () => {
    const rows = [
      { id: 'a', amount: 100, ts: 1000 },
      { id: 'b', amount: 100, ts: 3000 },
      { id: 'c', amount: 200, ts: 500 },
    ];
    const primary = (a: (typeof rows)[number], b: (typeof rows)[number]) => a.amount - b.amount;
    // Secondary uses stableBy with `rows` directly so its indices map keys
    // align with the comparator inputs.
    const secondary = stableBy(rows, (r) => r.ts, 'desc');
    const out = rows
      .slice()
      .sort(chainComparator(primary, secondary))
      .map((r) => r.id);
    // b (amount 100, ts 3000 desc) before a (amount 100, ts 1000).
    // c (amount 200) last.
    expect(out).toEqual(['b', 'a', 'c']);
  });

  it('chainComparator itself is stable on full tie', () => {
    const rows = [
      { id: 'a', amount: 100 },
      { id: 'b', amount: 100 },
    ];
    const primary = (a: (typeof rows)[number], b: (typeof rows)[number]) => a.amount - b.amount;
    const out = rows
      .slice()
      .sort(chainComparator(primary))
      .map((r) => r.id);
    expect(out).toEqual(['a', 'b']);
  });
});

describe('sortGlyph', () => {
  it('returns neutral glyph when column not active', () => {
    expect(sortGlyph({ column: 'other', direction: 'asc' }, 'time')).toBe('↕');
  });
  it('returns up arrow when asc on this column', () => {
    expect(sortGlyph({ column: 'time', direction: 'asc' }, 'time')).toBe('↑');
  });
  it('returns down arrow when desc on this column', () => {
    expect(sortGlyph({ column: 'time', direction: 'desc' }, 'time')).toBe('↓');
  });
});
