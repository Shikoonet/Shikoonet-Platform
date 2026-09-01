/**
 * The rule that decides what a ledger row IS — asserted against Postgres,
 * because Postgres is where it lives.
 *
 * `expense_kind_of` and `expense_category_of` are SQL functions created by
 * `migrations/0040_expense_ledger.sql`, so that the migration's own backfill
 * and `packages/migrate` can share one definition instead of one each. This
 * file calls them the way both callers do, which is the only way to test them
 * that is not a second implementation.
 *
 * ## What is worth testing here
 *
 * Not "does the classifier agree with itself" — that is the failure this repo
 * has already paid for twice. Each case below is a real note from the 2026-08-29
 * production dump, and the expected answer was read off the row rather than
 * reasoned about. Where the two disagreed, the row won: `Reseller MohammadReza`
 * is English and an earlier rule that matched only «ریسلر» read two real sales
 * as corrections.
 *
 * The first test is the one that matters most. A classifier that mislabels a
 * row costs a filter that reads oddly and one click to fix. A classifier that
 * moves a Rial breaks `verify.ts`, which compares this table's sum against the
 * legacy panel's own printed total with exact equality — and it would break it
 * silently, because every row count would still match.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema, env } from './helpers/env.js';

const db = env.DB;

/** Rows this file owns, so it can clean up without touching the ledger. */
const MARK = 'classifier-fixture';

async function kindOf(note: string, amountIrr: number): Promise<string> {
  const row = await db
    .prepare(`SELECT expense_kind_of(?1, ?2::bigint) AS k`)
    .bind(note, amountIrr)
    .first<{ k: string }>();
  return row!.k;
}

async function categoryOf(note: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT expense_category_of(?1) AS c`)
    .bind(note)
    .first<{ c: string | null }>();
  return row!.c;
}

beforeAll(applySchema);
afterAll(async () => {
  await db.prepare(`DELETE FROM revenue_adjustments WHERE note LIKE ?1`).bind(`${MARK}%`).run();
});

describe('the backfill moves no money', () => {
  /**
   * The catastrophe test.
   *
   * `verify.ts` asserts `SUM(amount_irr)` here against
   * `setting.revenue_adjustment` — the number the legacy panel prints — to the
   * Rial, and its comment says the check exists to catch a sign flip. Running
   * the classifier over a ledger must therefore be a pure labelling: same rows,
   * same total, three buckets that add back to one.
   *
   * Amounts are deliberately awkward (a lone Rial, a nine-digit sum, both
   * signs) rather than round: a bug that truncates or re-derives an amount from
   * a Toman figure survives round numbers and dies here.
   */
  it('labels every row and changes no amount', async () => {
    const fixture: Array<[string, number]> = [
      [`${MARK} تبلیغ ۴ تا پیج نیتروژن`, -155_000_001],
      [`${MARK} هزینه سرور - خرید Ton`, -115_000_000],
      [`${MARK} تسویه حساب با حسام`, -650_000_000],
      [`${MARK} فیک 8847433508`, -14_480_000],
      [`${MARK} Reseller MohammadReza`, 20_000_000],
      [`${MARK} اختلاف حساب`, 20_500_003],
      [`${MARK} خرید پلاس ChatGpt`, -1],
    ];
    for (const [note, amount] of fixture) {
      await db
        .prepare(
          `INSERT INTO revenue_adjustments (amount_irr, note, created_by, created_at,
                                            kind, spent_on)
           VALUES (?1, ?2, 'test', now(), expense_kind_of(?2, ?1::bigint), current_date)`,
        )
        .bind(amount, note)
        .run();
    }

    const row = await db
      .prepare(
        `SELECT count(*)::int                                   AS n,
                COALESCE(SUM(amount_irr), 0)::bigint            AS total,
                COALESCE(SUM(amount_irr) FILTER (WHERE kind = 'EXPENSE'), 0)::bigint       AS expense,
                COALESCE(SUM(amount_irr) FILTER (WHERE kind = 'REVENUE_FIX'), 0)::bigint   AS fix,
                COALESCE(SUM(amount_irr) FILTER (WHERE kind = 'MANUAL_INCOME'), 0)::bigint AS income,
                count(*) FILTER (WHERE kind IS NULL)::int       AS unlabelled
           FROM revenue_adjustments WHERE note LIKE ?1`,
      )
      .bind(`${MARK}%`)
      .first<{
        n: number;
        total: number;
        expense: number;
        fix: number;
        income: number;
        unlabelled: number;
      }>();

    const source = fixture.reduce((sum, [, amount]) => sum + amount, 0);

    expect(row!.n).toBe(fixture.length);
    // Against the sum computed on this side, not against a number typed here:
    // the assertion is «what went in came out», which is what `verify.ts` asks.
    expect(Number(row!.total)).toBe(source);
    // The partition is total. Without this a classifier returning NULL for some
    // shape would pass the line above and drop rows out of all three columns.
    expect(row!.unlabelled).toBe(0);
    expect(Number(row!.expense) + Number(row!.fix) + Number(row!.income)).toBe(source);
  });
});

describe('what a row is', () => {
  /**
   * The correction words beat the sale words, and they have to.
   *
   * This note carries both vocabularies — a customer id, the word `buy`, and
   * «تکراری». It is a duplicate charge being returned, not a purchase.
   */
  it('reads a returned duplicate as a correction, not a sale', async () => {
    expect(await kindOf('5960227227 | Hamidreza_abbasi00 | buy تکراری', 3_900_000)).toBe(
      'REVENUE_FIX',
    );
  });

  it('reads a reseller sale as income in either spelling', async () => {
    expect(await kindOf('ریسلر زارع', 50_000_000)).toBe('MANUAL_INCOME');
    // English, and in the dump. A rule matching only «ریسلر» lost this one.
    expect(await kindOf('Reseller MohammadReza', 20_000_000)).toBe('MANUAL_INCOME');
  });

  /**
   * The conservative direction, asserted so it cannot drift.
   *
   * A positive row naming no sale is an adjustment. Calling it income would put
   * money in the revenue column that nobody sold anything for — a book that
   * lies, where the other mistake is only a filter that reads oddly.
   */
  it('never invents a sale from a bare credit', async () => {
    expect(await kindOf('اختلاف حساب', 20_500_000)).toBe('REVENUE_FIX');
    expect(await kindOf('درست کردن حساب', 9_500_000)).toBe('REVENUE_FIX');
  });

  it('reads a plain negative row as spending', async () => {
    expect(await kindOf('خرید پلاس ChatGpt', -40_000_000)).toBe('EXPENSE');
  });
});

describe('what an expense was for', () => {
  /**
   * «خرید Ton» is a rail, not a purpose, and the classifier has no rule for it.
   *
   * That absence is the whole design: each of these three notes falls past the
   * crypto wording onto the noun that says what the money actually bought. A
   * `Ton` rule would have swallowed all three into one meaningless bucket.
   */
  it.each([
    ['هزینه سرور - خرید Ton', 'سرور و زیرساخت'],
    ['خرید ۲۰ عدد Ton جهت تبلیغات', 'تبلیغات'],
    ['حسام - خرید TON', 'سهم شرکا و تسویه'],
  ])('%s → %s', async (note, expected) => {
    expect(await categoryOf(note)).toBe(expected);
  });

  /**
   * And when there is genuinely nothing to go on, it says so.
   *
   * NULL rather than «سایر», because «I have not looked at this yet» and «I
   * looked, and it is other» are different states and the screen offers a
   * «دسته‌بندی‌نشده» filter for exactly the first one. A classifier that always
   * answers is a classifier whose answers mean nothing.
   */
  it('returns nothing rather than guessing', async () => {
    expect(await categoryOf('خرید Ton')).toBeNull();
    expect(await categoryOf('test')).toBeNull();
  });
});

describe('the database refuses a kind that contradicts its sign', () => {
  /**
   * Proving the guard by trying to break it.
   *
   * EXPENSE means money out and MANUAL_INCOME means money in; a row claiming
   * one while carrying the other sign is what a mis-typed edit looks like, and
   * the CHECK is what stops it reaching a total. REVENUE_FIX is deliberately
   * unconstrained — a clawback is negative, a reversed over-deduction is
   * positive, and both are corrections to the same figure.
   */
  it.each([
    ['MANUAL_INCOME', -1],
    ['EXPENSE', 1],
  ])('rejects %s carrying %d', async (kind, amount) => {
    await expect(
      db
        .prepare(
          `INSERT INTO revenue_adjustments (amount_irr, note, created_by, created_at, kind, spent_on)
           VALUES (?1, ?2, 'test', now(), ?3, current_date)`,
        )
        .bind(amount, `${MARK} contradiction`, kind)
        .run(),
    ).rejects.toThrow();
  });

  it('lets a correction go either way', async () => {
    for (const amount of [-1, 1]) {
      await db
        .prepare(
          `INSERT INTO revenue_adjustments (amount_irr, note, created_by, created_at, kind, spent_on)
           VALUES (?1, ?2, 'test', now(), 'REVENUE_FIX', current_date)`,
        )
        .bind(amount, `${MARK} either way`)
        .run();
    }
  });
});

describe('a voided row leaves the books and stays in the table', () => {
  /**
   * The contract `verify.ts` depends on, asserted from this side so nobody
   * "helpfully" adds the void filter to the base table.
   *
   * The app reads `shop_books` and asks «what is in the books». `verify.ts`
   * reads `revenue_adjustments` and asks «did the import land every Rial the
   * legacy panel printed» — and a voided row still came out of the legacy log,
   * so it still has to be counted there.
   */
  it('drops out of the view and out of neither sum on the table', async () => {
    const created = await db
      .prepare(
        `INSERT INTO revenue_adjustments (amount_irr, note, created_by, created_at, kind, spent_on)
         VALUES (-7_000_000, ?1, 'test', now(), 'EXPENSE', current_date) RETURNING id`,
      )
      .bind(`${MARK} to be voided`)
      .first<{ id: number }>();

    const read = async (from: string) =>
      Number(
        (
          await db
            .prepare(
              `SELECT COALESCE(SUM(amount_irr), 0)::bigint AS s FROM ${from} WHERE note LIKE ?1`,
            )
            .bind(`${MARK} to be voided`)
            .first<{ s: number }>()
        )!.s,
      );

    expect(await read('shop_books')).toBe(-7_000_000);

    await db
      .prepare(
        `UPDATE revenue_adjustments SET voided_at = now(), voided_by = 'test',
                void_reason = 'مبلغ اشتباه بود' WHERE id = ?1`,
      )
      .bind(created!.id)
      .run();

    expect(await read('shop_books')).toBe(0);
    expect(await read('revenue_adjustments')).toBe(-7_000_000);
  });

  it('will not record a void with nobody attached to it', async () => {
    // A fresh row, not the one above: that one is already voided and already
    // carries a `voided_by`, so setting the timestamp again would leave the
    // pair complete and the CHECK would have nothing to refuse. The first
    // version of this test did exactly that and passed for the wrong reason.
    await db
      .prepare(
        `INSERT INTO revenue_adjustments (amount_irr, note, created_by, created_at, kind, spent_on)
         VALUES (-1, ?1, 'test', now(), 'EXPENSE', current_date)`,
      )
      .bind(`${MARK} anonymous void`)
      .run();

    await expect(
      db
        .prepare(`UPDATE revenue_adjustments SET voided_at = now() WHERE note LIKE ?1`)
        .bind(`${MARK} anonymous void`)
        .run(),
    ).rejects.toThrow();
  });
});
