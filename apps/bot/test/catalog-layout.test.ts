/**
 * The rows the shop breaks, judged by the keyboard the customer is sent.
 *
 * Everything here drives a real update through `handleUpdate` and reads the
 * reply, for the reason `bot-keyboards.test.ts` gives about its own subject: a
 * test that read `product_plans.row_index` back after writing it would pass
 * with the entire rendering path deleted. What is being asserted is that a
 * number in a column reaches a customer's screen.
 *
 * Two properties earn most of the file:
 *
 *   1. **Nothing moves until somebody arranges it.** Every row ships with
 *      `row_index` NULL, and NULL has to draw exactly what the hardcoded
 *      one-button-per-row drew before this existed. If that ever stops
 *      holding, every shop in production rearranges itself on deploy.
 *   2. **An arrangement survives the customer's own filter.** Half a category
 *      is invisible to any given customer — a resellers-only tier, a
 *      once-per-user offer they already took — and the admin's «two per row»
 *      has to still be two per row afterwards.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertSchema, db } from './helpers/env.js';
import { ensureCatalog, planIdsIn, productId } from './helpers/shop.js';
import { handleUpdate } from '../src/handle.js';

let nextId = 0;
function ids(): { updateId: number; telegramId: number } {
  const n = ++nextId * 10;
  return { updateId: 731_000 + n, telegramId: 611_000 + n };
}

function press(updateId: number, telegramId: number, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `cl${telegramId}` },
      message: { message_id: 7171, chat: { id: telegramId } },
      data,
    },
  };
}

function startUpdate(updateId: number, telegramId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: telegramId, username: `cl${telegramId}` },
      chat: { id: telegramId },
      text: '/start',
    },
  };
}

/**
 * The keyboard a customer is sent for one SERVICE, as rows of callback data.
 *
 * It walked a CATEGORY until 2026-08-27, which is where the prices used to be
 * drawn. They moved one screen further in when the service level was connected
 * — a category now lists پلاتینیوم / طلایی / معمولی — and an arrangement is a
 * property of the screen the buttons land on, so this walks to that screen.
 */
async function serviceRows(productId: number): Promise<string[][]> {
  const { updateId, telegramId } = ids();
  await handleUpdate(db, startUpdate(updateId, telegramId));
  const shown = await handleUpdate(db, press(updateId + 1, telegramId, `prd:${productId}`));
  return (shown.replies[0]?.keyboard ?? []).map((row) =>
    row.map((b) => b.callback_data ?? ''),
  );
}

/** Only the rows that carry priced buttons — the chrome sits below them. */
function planRows(rows: string[][]): string[][] {
  return rows.filter((row) => row.every((d) => d.startsWith('plan:')));
}

/**
 * Arrange a WHOLE category, the way the save route does.
 *
 * The named plans go first, in the order given, carrying the row indexes given;
 * everything else in the category follows them on lines of its own. Arranging
 * three plans and leaving the rest of the screen at `sort_order = 0` is not a
 * state the route can produce — it posts the whole screen and
 * `checkCatalogLayout` refuses a mixed one — and it does not group, because
 * grouping is on CONSECUTIVE rows and the untouched plans sit between them.
 * Reproducing that here cost two red tests before the fixture was the thing
 * that was wrong.
 */
async function arrangeService(
  productId: number,
  first: number[],
  rowIndexes: (number | null)[],
): Promise<void> {
  const all = await db
    .prepare(
      `SELECT id FROM product_plans
        WHERE product_id = ?1
        ORDER BY sort_order, price_irr, id`,
    )
    .bind(productId)
    .all<{ id: number }>();

  const rest = all.results.map((r) => r.id).filter((id) => !first.includes(id));
  const ordered = [...first, ...rest];
  const rows = [...rowIndexes];
  // Every row after the named ones gets a line of its own, continuing the
  // numbering — a whole screen, with no gaps and never going backwards.
  let next = Math.max(-1, ...rows.filter((r): r is number => r !== null)) + 1;
  while (rows.length < ordered.length) rows.push(next++);

  for (const [at, id] of ordered.entries()) {
    await db
      .prepare(`UPDATE product_plans SET row_index = ?2, sort_order = ?3 WHERE id = ?1`)
      .bind(id, rows[at] ?? null, at)
      .run();
  }
}

async function unarrange(): Promise<void> {
  await db.prepare(`UPDATE product_plans SET row_index = NULL`).run();
}

/** The SERVICE whose price screen these rows are drawn on. */
let PLATINUM_SERVICE = 0;
let PLATINUM: number[] = [];

beforeAll(async () => {
  await assertSchema();
  await ensureCatalog();
  PLATINUM_SERVICE = await productId('sim-vip-platinum');
  PLATINUM = await planIdsIn('sim-vip-platinum');
  expect(PLATINUM, 'the fixture must offer three sizes to arrange').toHaveLength(3);
});

beforeEach(unarrange);

describe('a shop screen nobody has arranged', () => {
  it('draws one button per row, exactly as it did before this existed', async () => {
    // The day-one guarantee. `row_index` is NULL on every row after the
    // migration, and NULL must reproduce the hardcoded `plans.map(p => [p])`
    // this replaced — or every shop's keyboard rearranges itself on deploy.
    const rows = planRows(await serviceRows(PLATINUM_SERVICE));
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expect(row).toHaveLength(1);
  });
});

describe('a shop screen the admin arranged', () => {
  it('sends the rows the columns describe', async () => {
    // Two, then one. Asserted on the reply rather than on the column, because
    // the column is what a broken renderer would still have right.
    await arrangeService(PLATINUM_SERVICE, PLATINUM, [0, 0, 1]);
    const rows = planRows(await serviceRows(PLATINUM_SERVICE));
    const mine = rows.filter((row) => row.some((d) => d === `plan:${PLATINUM[0]}`));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toEqual([`plan:${PLATINUM[0]}`, `plan:${PLATINUM[1]}`]);
    expect(rows.some((row) => row.length === 1 && row[0] === `plan:${PLATINUM[2]}`)).toBe(true);
  });

  it('keeps two-per-row when the customer cannot see one of them', async () => {
    // The reason this is a reflow and not the absolute grid `buildMenu` uses.
    // Three sizes on one line; the middle one goes away, so the customer sees
    // sizes one and three. Absolute placement with the gap closed answers a row
    // of two here too — but numbered 0 and 2, so the NEXT arranged row merges
    // into it. Grouping consecutive equal values keeps the line at two and the
    // rest where the admin put them.
    //
    // Hidden per PLAN, not per product: all three sizes belong to one service,
    // so `resellers_only` on the product takes the whole row away and the test
    // passes for the wrong reason. That cost a red run to notice.
    await arrangeService(PLATINUM_SERVICE, PLATINUM, [0, 0, 0]);
    await db
      .prepare(`UPDATE product_plans SET status = 'HIDDEN' WHERE id = ?1`)
      .bind(PLATINUM[1])
      .run();
    try {
      const rows = planRows(await serviceRows(PLATINUM_SERVICE));
      const withFirst = rows.find((row) => row.includes(`plan:${PLATINUM[0]}`));
      expect(withFirst, 'the first size is still offered').toBeDefined();
      expect(withFirst).toEqual([`plan:${PLATINUM[0]}`, `plan:${PLATINUM[2]}`]);
      expect(rows.every((row) => row.length > 0)).toBe(true);
      expect(rows.flat()).not.toContain(`plan:${PLATINUM[1]}`);
    } finally {
      await db
        .prepare(`UPDATE product_plans SET status = 'ACTIVE' WHERE id = ?1`)
        .bind(PLATINUM[1])
        .run();
    }
  });

  it('never sends a row wider than Telegram accepts, whatever the column says', async () => {
    // Written by hand, past the route's own refusal — a psql session, a
    // migration, a future route. A keyboard Telegram rejects takes the whole
    // message down rather than one button, so the read path has its own fence.
    await db.prepare(`UPDATE product_plans SET row_index = 0, sort_order = id`).run();
    const rows = planRows(await serviceRows(PLATINUM_SERVICE));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.length).toBeLessThanOrEqual(8);
  });

  it('puts a plan added after the arrangement on its own line, not out of sight', async () => {
    await arrangeService(PLATINUM_SERVICE, [PLATINUM[0]!, PLATINUM[1]!], [0, 0]);
    // …then the third size arrives afterwards and has no place yet, which is
    // the state a plan created after the screen was arranged is in.
    await db
      .prepare(`UPDATE product_plans SET row_index = NULL WHERE id = ?1`)
      .bind(PLATINUM[2])
      .run();
    const rows = planRows(await serviceRows(PLATINUM_SERVICE));
    expect(rows.some((row) => row.length === 1 && row[0] === `plan:${PLATINUM[2]}`)).toBe(true);
  });
});

describe('the price list', () => {
  it('shows only what this customer could actually walk in and buy', async () => {
    // The one thing a price list can get wrong that no screen shows: it is the
    // only place in the shop that reads the WHOLE catalogue at once, so a
    // predicate missing here advertises a hidden tier, a disabled panel, or a
    // resellers-only service to everybody. Asserted through `handleUpdate` and
    // not against `tariffForUser`, for this file's own stated reason — what is
    // being defended is that a row reaches, or does not reach, a screen.
    const { updateId, telegramId } = ids();
    await handleUpdate(db, startUpdate(updateId, telegramId));

    const before = await handleUpdate(db, press(updateId + 1, telegramId, 'tar'));
    const listed = before.replies[0]?.text ?? '';
    expect(listed, 'the fixture must sell something').not.toBe('');

    // Judged against the DATABASE, not against the list's own earlier self.
    //
    // The first version of this compared the rendering before and after and
    // asserted one line had gone. It passed with a filter that dropped the
    // WRONG plan — because a filter that is wrong in both snapshots cancels
    // out. That is rule 6 in this repo's own words: a test that only agrees
    // with itself proves nothing. Proven by mutation, not by reading.
    //
    // So the outside truth is `product_plans`: every plan this customer may buy
    // has its price on the list, and nothing else does.
    const priced = (text: string) =>
      text.split('\n').filter((l) => l.startsWith(' ')).map((l) => l.trim().split(/ {2,}/).pop());

    const payable = async (): Promise<string[]> => {
      const rows = await db
        .prepare(
          `SELECT pl.price_irr FROM product_plans pl
             JOIN products p ON p.id = pl.product_id
             JOIN provisioning_providers pr ON pr.id = p.provider_id
            WHERE pl.status = 'ACTIVE' AND p.status = 'ACTIVE' AND pr.status = 'ACTIVE'
              AND p.resellers_only = false`,
        )
        .all<{ price_irr: number }>();
      return rows.results
        .map((r) => `${Math.round(Number(r.price_irr) / 10).toLocaleString('en-US')} تومان`)
        .sort();
    };

    expect(priced(listed).sort(), 'every purchasable plan is on the list').toEqual(await payable());

    await db
      .prepare(`UPDATE product_plans SET status = 'HIDDEN' WHERE id = ?1`)
      .bind(PLATINUM[0])
      .run();
    try {
      const after = await handleUpdate(db, press(updateId + 2, telegramId, 'tar'));
      // The same claim again, against a catalogue that now has one fewer row.
      // Hiding a plan has to take that plan off the list and leave the rest.
      expect(priced(after.replies[0]?.text ?? '').sort()).toEqual(await payable());
    } finally {
      await db
        .prepare(`UPDATE product_plans SET status = 'ACTIVE' WHERE id = ?1`)
        .bind(PLATINUM[0])
        .run();
    }
  });
});
