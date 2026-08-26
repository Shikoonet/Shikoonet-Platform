/**
 * The shop's row breaks.
 *
 * The assertions worth having here are not «the validator rejects bad input».
 * They are the two properties this file was written to have and the keyboard
 * layout next door deliberately does not:
 *
 *   1. an arrangement SURVIVES a filter — six buttons arranged two-per-row,
 *      two of them not purchasable by this customer, still come out two-per-row
 *      rather than 1/1/2;
 *   2. the browser and the bot cannot disagree, because there is one function
 *      and they both call it.
 *
 * The second one cannot be tested here — a test that called `groupIntoRows`
 * twice and compared would pass with the whole rendering path deleted. It is
 * tested where it can fail: in `apps/bot`, against the keyboard the bot really
 * sent.
 */

import { describe, expect, it } from 'vitest';
import {
  checkCatalogLayout,
  groupIntoRows,
  MAX_CATALOG_ROWS,
  MAX_ROW_WIDTH,
  type CatalogPlacement,
} from '../src/catalogLayout.js';

/** `n` buttons, arranged into rows of the given widths. */
function arranged(...widths: number[]): CatalogPlacement[] {
  const out: CatalogPlacement[] = [];
  let id = 1;
  widths.forEach((width, row) => {
    for (let n = 0; n < width; n += 1) out.push({ id: id++, rowIndex: row });
  });
  return out;
}

const idsOf = (items: CatalogPlacement[]) => items.map((i) => i.id);
const shapeOf = (rows: CatalogPlacement[][]) => rows.map((r) => r.length);

describe('grouping a shop screen into rows', () => {
  it('gives every unarranged button a row of its own', () => {
    // The state every existing row is in the day this ships. If this ever
    // stops holding, every customer's shop rearranges itself on deploy.
    const items = [1, 2, 3].map((id) => ({ id, rowIndex: null }));
    expect(shapeOf(groupIntoRows(items))).toEqual([1, 1, 1]);
  });

  it('keeps two-per-row when a filter removed two of the six', () => {
    // The whole reason this is a reflow and not the absolute grid `buildMenu`
    // uses. Six plans arranged 2/2/2; the customer cannot buy #3 and #4 —
    // a resellers-only tier, or one they already used their single purchase on.
    //
    // Absolute placement with gaps closed answers 1/1/2 here: the admin said
    // «two per row» and the customer gets three ragged rows. Grouping
    // consecutive equal values answers 2/2, which is what was asked for.
    const all = arranged(2, 2, 2);
    const visible = all.filter((i) => i.id !== 3 && i.id !== 4);
    expect(shapeOf(groupIntoRows(visible))).toEqual([2, 2]);
  });

  it('cannot produce an empty row, because a row exists only for a button', () => {
    // `buildMenu` needs `rows.filter(row => row.length > 0)` at the end
    // (keyboard.ts:117) precisely because it places into a grid first. Here
    // there is nothing to filter — asserted by removing an entire row's worth.
    const all = arranged(2, 2, 2);
    const visible = all.filter((i) => i.rowIndex !== 1);
    const rows = groupIntoRows(visible);
    expect(shapeOf(rows)).toEqual([2, 2]);
    expect(rows.every((r) => r.length > 0)).toBe(true);
  });

  it('puts a newly added plan on its own line rather than hiding it', () => {
    // An admin arranges a category, then adds a plan a week later. It arrives
    // with a null `rowIndex`. The one thing it must not do is disappear.
    const items: CatalogPlacement[] = [...arranged(2), { id: 99, rowIndex: null }];
    const rows = groupIntoRows(items);
    expect(shapeOf(rows)).toEqual([2, 1]);
    expect(idsOf(rows[1]!)).toEqual([99]);
  });

  it('chunks a row too wide for Telegram, whatever the database says', () => {
    // NOT a duplicate of the ROW_TOO_WIDE check below. That one guards what may
    // be written; this guards what may be sent, and between them sit a psql
    // session and a migration. A keyboard Telegram refuses takes the whole
    // message down, not one button.
    const items = Array.from({ length: 12 }, (_, n) => ({ id: n + 1, rowIndex: 0 }));
    const rows = groupIntoRows(items);
    expect(shapeOf(rows)).toEqual([MAX_ROW_WIDTH, 4]);
    expect(idsOf(rows.flat())).toEqual(items.map((i) => i.id));
  });
});

describe('whether an arrangement may be saved', () => {
  const scope = [1, 2, 3, 4, 5, 6];

  it('accepts a plain arrangement, so the refusals below mean something', () => {
    expect(checkCatalogLayout(arranged(2, 2, 2), scope)).toBeNull();
  });

  it('accepts an all-null arrangement — that is «reset», not «broken»', () => {
    const items = scope.map((id) => ({ id, rowIndex: null }));
    expect(checkCatalogLayout(items, scope)).toBeNull();
  });

  it('refuses an id that belongs to another screen', () => {
    // The trust boundary. Without it a POST naming category 3 could rewrite
    // the order of category 7's plans, and the only symptom would be a shop
    // that reordered itself for no reason anybody could trace.
    const items = [...arranged(2), { id: 404, rowIndex: 1 }];
    expect(checkCatalogLayout(items, scope)).toEqual({ kind: 'FOREIGN_ID', ids: [404] });
  });

  it('refuses an id the screen has but the save left out', () => {
    // The other half of the trust boundary. A save writes the position of
    // every id it names and nothing else, so a save naming four of six leaves
    // the other two on yesterday's numbers and the two sets interleave —
    // neither the old order nor the new one, and no error anywhere. This is
    // the failure `apps/bot/test/catalog-layout.test.ts` cost two red runs to
    // find in its own fixture, before it was a rule.
    const items = arranged(2, 2);
    expect(checkCatalogLayout(items, scope)).toEqual({ kind: 'MISSING_ID', ids: [5, 6] });
  });

  it('refuses half an arrangement, because a save carries a whole screen', () => {
    const items: CatalogPlacement[] = [...arranged(2), { id: 3, rowIndex: null }];
    expect(checkCatalogLayout(items, [1, 2, 3])).toEqual({ kind: 'MIXED_ARRANGEMENT' });
  });

  it('refuses rows that go backwards', () => {
    // With 0,1,0 allowed, «group consecutive equal» draws three rows and
    // «group all equal» draws two — one rule, two answers. Refusing it is what
    // makes the two readings the same reading.
    const items: CatalogPlacement[] = [
      { id: 1, rowIndex: 0 },
      { id: 2, rowIndex: 1 },
      { id: 3, rowIndex: 0 },
    ];
    expect(checkCatalogLayout(items, [1, 2, 3])).toEqual({ kind: 'ROW_NOT_MONOTONIC', ids: [3] });
  });

  it('refuses a skipped row number', () => {
    const items: CatalogPlacement[] = [
      { id: 1, rowIndex: 0 },
      { id: 2, rowIndex: 2 },
    ];
    expect(checkCatalogLayout(items, [1, 2])).toEqual({ kind: 'ROW_GAP', rows: [1] });
  });

  it('refuses a row wider than Telegram accepts', () => {
    const items = Array.from({ length: MAX_ROW_WIDTH + 1 }, (_, n) => ({ id: n + 1, rowIndex: 0 }));
    expect(checkCatalogLayout(items, items.map((i) => i.id))).toEqual({
      kind: 'ROW_TOO_WIDE',
      row: 0,
      limit: MAX_ROW_WIDTH,
    });
  });

  it('refuses more rows than a phone can read', () => {
    const widths = Array.from({ length: MAX_CATALOG_ROWS + 1 }, () => 1);
    const items = arranged(...widths);
    expect(checkCatalogLayout(items, items.map((i) => i.id))).toEqual({
      kind: 'TOO_MANY_ROWS',
      limit: MAX_CATALOG_ROWS,
    });
  });

  it('refuses the same id twice', () => {
    const items: CatalogPlacement[] = [
      { id: 1, rowIndex: 0 },
      { id: 1, rowIndex: 1 },
    ];
    expect(checkCatalogLayout(items, [1])).toEqual({ kind: 'DUPLICATE_ID', ids: [1] });
  });

  it('refuses an empty screen', () => {
    expect(checkCatalogLayout([], scope)).toEqual({ kind: 'EMPTY' });
  });
});
