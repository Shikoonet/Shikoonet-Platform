/**
 * هزینه‌ها, from the panel.
 *
 * `revenue_adjustments` has been in the schema since 0005 and imported ever
 * since, and nothing had ever read or written a row of it. The assertions here
 * are about the two things that make a ledger a ledger rather than a list.
 *
 * **The sign is applied once.** The form takes a positive amount and a
 * direction, so a cost is negative in exactly one place. A route that trusted a
 * signed amount from the client would let «۵۰٬۰۰۰− هزینه» become a credit, and
 * the shop's own reporting is what reads the result.
 *
 * **The total is derived.** The legacy panel keeps a second copy in
 * `setting.revenue_adjustment` and holds the two together with a transaction on
 * every insert and delete. We sum the rows, so there is nothing to drift — and
 * the test for that is that voiding a row moves the total without anything else
 * being written.
 *
 * **A row is labelled, not only signed.** Since 2026-08-30 a line says what it
 * IS — هزینه, اصلاح درآمد, درآمد دستی — because a sign answers «which way» and
 * never «what», and the screen built on the sign alone reported 35.8 million
 * Toman of fake receipts as money the shop had spent.
 *
 * **Nothing is deleted.** Voiding leaves the row in the table and takes it out
 * of every total, which is what lets `verify.ts` keep counting it against the
 * legacy log while the panel stops counting it as money.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-revenue@example.com';
const REVIEWER = 'reviewer-revenue@example.com';
const READER = 'readonly-revenue@example.com';
/** Every note this file writes starts here, so the purge can find them all. */
const PREFIX = 'zz-revenue-';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

const post = (path: string, body: unknown, email = ADMIN) =>
  app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    envAs(email),
  );

const get = (path: string, email = ADMIN) => app.request(path, {}, envAs(email));

const patch = (path: string, body: unknown, email = ADMIN) =>
  app.request(
    path,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    envAs(email),
  );

type Kind = 'EXPENSE' | 'REVENUE_FIX' | 'MANUAL_INCOME';

function add(amountToman: number, kind: Kind, label: string, extra: object = {}) {
  return post('/api/v1/admin/revenue-adjustments', {
    amountToman,
    kind,
    note: `${PREFIX}${label}`,
    ...extra,
  });
}

/** The id of a row this file just wrote, for the tests that need one. */
async function addId(amountToman: number, kind: Kind, label: string, extra: object = {}) {
  const res = await add(amountToman, kind, label, extra);
  return ((await res.json()) as { id: number }).id;
}

const voidRow = (id: number, reason = 'اشتباه ثبت شده بود', email = ADMIN) =>
  post(`/api/v1/admin/revenue-adjustments/${id}/void`, { reason }, email);

const rowById = (id: number) =>
  baseEnv.DB.prepare(`SELECT amount_irr, note, created_by FROM revenue_adjustments WHERE id = ?1`)
    .bind(id)
    .first<{ amount_irr: string | number; note: string; created_by: string | null }>();

/**
 * The ledger rows only. The audit entries stay, because they cannot go: this
 * teardown was written with a `DELETE FROM audit_logs` in it and the database
 * refused it — «audit_logs is append-only (attempted DELETE)». Which is the
 * whole point of the table the deletion test above relies on, demonstrated by
 * accident on the first run.
 */
async function purge(): Promise<void> {
  await baseEnv.DB.prepare(`DELETE FROM revenue_adjustments WHERE note LIKE ?1`)
    .bind(`${PREFIX}%`)
    .run();
}

/**
 * The totals are over the WHOLE ledger by design, so a row this file did not
 * write would be counted in every assertion below. Emptying the table is the
 * only way those assertions mean anything — and it is safe here for the same
 * reason every other file in this suite truncates its own tables.
 */
async function emptyLedger(): Promise<void> {
  await baseEnv.DB.prepare(`DELETE FROM revenue_adjustments`).run();
}

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
    [READER, 'READ_ONLY'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }
});

beforeEach(emptyLedger);
afterAll(purge);

describe('writing a line', () => {
  it('stores a cost as a negative amount, from a positive one', async () => {
    // The whole design in one assertion. The client never sends a sign; if it
    // did, «−۵۰٬۰۰۰ هزینه» would be a credit and nothing would say so.
    const res = await add(50_000, 'EXPENSE', 'server');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: number; amountIrr: number };
    expect(body.ok).toBe(true);
    expect(body.amountIrr).toBe(-500_000);

    const row = await rowById(body.id);
    expect(Number(row?.amount_irr)).toBe(-500_000);
    expect(row?.created_by).toBe(ADMIN);
  });

  it('stores a hand-recorded sale as a positive one', async () => {
    const res = await add(50_000, 'MANUAL_INCOME', 'reseller');
    const body = (await res.json()) as { id: number; amountIrr: number };
    expect(body.amountIrr).toBe(500_000);
    expect(Number((await rowById(body.id))?.amount_irr)).toBe(500_000);
  });

  /**
   * A correction is the only kind that takes a direction, and it needs one.
   *
   * A clawback for a fake receipt is negative; reversing an over-deduction is
   * positive. Both correct the same figure, so the kind cannot decide the sign
   * on its own the way the other two can.
   */
  it('lets a correction go either way, on the direction it was given', async () => {
    const back = (await (
      await add(50_000, 'REVENUE_FIX', 'fake-receipt', { direction: 'expense' })
    ).json()) as { amountIrr: number };
    expect(back.amountIrr).toBe(-500_000);

    const forward = (await (
      await add(50_000, 'REVENUE_FIX', 'over-deducted', { direction: 'credit' })
    ).json()) as { amountIrr: number };
    expect(forward.amountIrr).toBe(500_000);
  });

  /**
   * A kind is required, with no default, and this is why.
   *
   * The old body took `{ amountToman, direction }` and nothing else. Defaulting
   * `kind` to EXPENSE would have read a caller's `direction: 'credit'` as a
   * cost and forced the sign negative — a credit silently becoming an expense,
   * with a 200 and no complaint anywhere. On a money route «you did not say
   * what this is» has to be a 400.
   */
  it('refuses a line that does not say what kind it is', async () => {
    const res = await post('/api/v1/admin/revenue-adjustments', {
      amountToman: 50_000,
      direction: 'credit',
      note: `${PREFIX}kindless`,
    });
    expect(res.status).toBe(400);
  });

  it('converts Toman to IRR exactly once', async () => {
    // The project's one conversion, and the one place a factor of ten hides.
    const res = await add(1, 'MANUAL_INCOME', 'one-toman');
    const body = (await res.json()) as { amountIrr: number };
    expect(body.amountIrr).toBe(10);
  });

  /**
   * The two dates a row carries, and why they are two.
   *
   * «هزینه یک ماهه سرور آلمان» typed today for last month belongs in last
   * month's total. `created_at` is when somebody typed it and never moves;
   * `spent_on` is when the money left and is what every filter and every
   * window on this screen measures.
   */
  it('records when the money left, separately from when it was typed', async () => {
    const id = await addId(50_000, 'EXPENSE', 'german-server', { spentOn: '2026-07-15' });
    const row = await baseEnv.DB.prepare(
      `SELECT spent_on::text AS spent_on,
              (created_at AT TIME ZONE 'Asia/Tehran')::date::text AS typed_on
         FROM revenue_adjustments WHERE id = ?1`,
    )
      .bind(id)
      .first<{ spent_on: string; typed_on: string }>();
    expect(row?.spent_on).toBe('2026-07-15');
    expect(row?.typed_on).not.toBe('2026-07-15');
  });

  it('defaults the spend date to today in Tehran, not to the server clock', async () => {
    const id = await addId(50_000, 'EXPENSE', 'undated');
    const row = await baseEnv.DB.prepare(
      `SELECT spent_on = (now() AT TIME ZONE 'Asia/Tehran')::date AS ok
         FROM revenue_adjustments WHERE id = ?1`,
    )
      .bind(id)
      .first<{ ok: boolean }>();
    expect(row?.ok).toBe(true);
  });

  it('refuses a signed amount rather than guessing what was meant', async () => {
    const res = await post('/api/v1/admin/revenue-adjustments', {
      amountToman: -50_000,
      kind: 'EXPENSE',
      note: `${PREFIX}signed`,
    });
    expect(res.status).toBe(400);
  });

  it('refuses zero', async () => {
    const res = await post('/api/v1/admin/revenue-adjustments', {
      amountToman: 0,
      kind: 'EXPENSE',
      note: `${PREFIX}zero`,
    });
    expect(res.status).toBe(400);
  });

  it('refuses a line with no explanation', async () => {
    // Required in the legacy form too (`panel/settings.php:14`). An unexplained
    // number in the books is the one thing nobody can reconstruct later.
    for (const note of ['', '   ']) {
      const res = await post('/api/v1/admin/revenue-adjustments', {
        amountToman: 50_000,
        kind: 'EXPENSE',
        note,
      });
      expect(res.status, JSON.stringify(note)).toBe(400);
    }
  });

  it('refuses an amount that can only be a slipped digit', async () => {
    const res = await post('/api/v1/admin/revenue-adjustments', {
      amountToman: 10_000_000_001,
      kind: 'EXPENSE',
      note: `${PREFIX}fat-finger`,
    });
    expect(res.status).toBe(400);
  });

  it('is closed to anyone but an ADMIN', async () => {
    const res = await post(
      '/api/v1/admin/revenue-adjustments',
      { amountToman: 50_000, kind: 'EXPENSE', note: `${PREFIX}reviewer` },
      REVIEWER,
    );
    expect(res.status).toBe(403);
    const n = await baseEnv.DB.prepare(`SELECT COUNT(*)::int AS n FROM revenue_adjustments`).first<{
      n: number;
    }>();
    expect(n?.n).toBe(0);
  });

  it('writes what it did to the audit log', async () => {
    const res = await add(50_000, 'EXPENSE', 'audited');
    const { id } = (await res.json()) as { id: number };
    const log = await baseEnv.DB.prepare(
      `SELECT action, after_json FROM audit_logs
        WHERE entity_type = 'REVENUE_ADJUSTMENT' AND entity_id = ?1`,
    )
      .bind(String(id))
      .first<{ action: string; after_json: unknown }>();
    expect(log?.action).toBe('revenue_adjustment.added');
  });
});

describe('the totals', () => {
  it('separate the three kinds instead of netting them', async () => {
    // The whole complaint, in one assertion. A single «-300,000» is a quiet
    // month and a big month with bigger costs, and the admin cannot tell which
    // - but worse, the version of this screen that only knew signs reported
    // 35.8 million Toman of fake receipts as money the shop had spent, and
    // labelled its reseller income «برگشتی و اعتبار».
    await add(100_000, 'EXPENSE', 'a');
    await add(200_000, 'EXPENSE', 'b');
    await add(50_000, 'REVENUE_FIX', 'c', { direction: 'expense' });
    await add(80_000, 'MANUAL_INCOME', 'd');

    const body = (await (await get('/api/v1/admin/revenue-adjustments')).json()) as {
      total: number;
      totals: {
        expensesIrr: number;
        revenueFixIrr: number;
        manualIncomeIrr: number;
        netIrr: number;
      };
    };
    expect(body.total).toBe(4);
    expect(body.totals.expensesIrr).toBe(-3_000_000);
    expect(body.totals.revenueFixIrr).toBe(-500_000);
    expect(body.totals.manualIncomeIrr).toBe(800_000);
    // And the three still add back to the one figure the shop's net is built
    // from. This is the property that let the migration relabel 219 production
    // rows without moving a Rial, and `verify.ts` depends on it.
    expect(
      body.totals.expensesIrr + body.totals.revenueFixIrr + body.totals.manualIncomeIrr,
    ).toBe(body.totals.netIrr);
  });

  it('cover the whole filter, not the page being looked at', async () => {
    // A running total that changed when you turned the page would be worse than
    // no total at all.
    for (let i = 0; i < 5; i++) await add(10_000, 'EXPENSE', `page-${i}`);

    const body = (await (
      await get('/api/v1/admin/revenue-adjustments?page=1&pageSize=2')
    ).json()) as { items: unknown[]; totals: { netIrr: number } };
    expect(body.items).toHaveLength(2);
    expect(body.totals.netIrr).toBe(-500_000);
  });

  /**
   * The totals follow the filter, and `lifetime` does not. Both are returned.
   *
   * This reverses a deliberate decision, so it is worth saying why. The old
   * behaviour was totals over the whole ledger whatever the filter, on the
   * grounds that filtering to «هزینه» and watching the credits fall to zero
   * would read as the credits having gone somewhere. That is a real hazard, and
   * it is answered by naming the two figures rather than by picking one: Sam
   * asked to filter and to see what each category cost, and a headline that
   * refuses to move when you narrow the table cannot answer that at all.
   *
   * So the screen shows both, and this asserts both - the filtered figure is
   * the arithmetic of the rows on screen, and the lifetime figure is the shop's
   * position and never moves.
   */
  it('follow the filter, while the lifetime figure stays the shop position', async () => {
    await add(100_000, 'EXPENSE', 'w-a');
    await add(50_000, 'MANUAL_INCOME', 'w-b');

    const body = (await (await get('/api/v1/admin/revenue-adjustments?kind=EXPENSE')).json()) as {
      items: unknown[];
      totals: { expensesIrr: number; manualIncomeIrr: number; netIrr: number };
      lifetime: { expensesIrr: number; manualIncomeIrr: number; netIrr: number };
    };
    expect(body.items).toHaveLength(1);
    // The rows on screen, added up.
    expect(body.totals.expensesIrr).toBe(-1_000_000);
    expect(body.totals.manualIncomeIrr).toBe(0);
    // The books, unmoved by looking at them through a filter.
    expect(body.lifetime.manualIncomeIrr).toBe(500_000);
    expect(body.lifetime.netIrr).toBe(-500_000);
  });

  /**
   * «تفکیک» - the breakdown that did not exist anywhere.
   *
   * Neither this schema nor Mirzabot's had a category, so «what was the money
   * spent on» had no answer at all. The filtered total and the sum of this
   * breakdown are the same arithmetic, which is what makes the screen checkable
   * by the person reading it.
   */
  it('break spending down by category, and the parts add to the whole', async () => {
    const cat = await baseEnv.DB.prepare(
      `SELECT id FROM expense_categories WHERE name = 'تبلیغات'`,
    ).first<{ id: number }>();

    await add(100_000, 'EXPENSE', 'ads-1', { categoryId: Number(cat!.id) });
    await add(300_000, 'EXPENSE', 'ads-2', { categoryId: Number(cat!.id) });
    await add(70_000, 'EXPENSE', 'uncategorised');

    const body = (await (await get('/api/v1/admin/revenue-adjustments')).json()) as {
      totals: { expensesIrr: number };
      byCategory: { categoryId: number | null; name: string | null; count: number; irr: number }[];
    };

    const ads = body.byCategory.find((b) => b.name === 'تبلیغات');
    expect(ads?.count).toBe(2);
    expect(ads?.irr).toBe(-4_000_000);

    // The rows the classifier could not label are their own line, not folded
    // into «سایر» - «I have not looked at this yet» and «I looked, and it is
    // other» are different states.
    const none = body.byCategory.find((b) => b.categoryId === null);
    expect(none?.irr).toBe(-700_000);

    expect(body.byCategory.reduce((sum, b) => sum + b.irr, 0)).toBe(body.totals.expensesIrr);
  });

  it('are derived, so voiding a row moves them with nothing else written', async () => {
    // The legacy panel keeps `setting.revenue_adjustment` alongside the log and
    // rewrites it inside a transaction on every insert and delete. Two things
    // that must agree is one thing that can be wrong; this asserts there is only
    // ever one.
    const id = await addId(100_000, 'EXPENSE', 'derived');

    const before = (await (await get('/api/v1/admin/revenue-adjustments')).json()) as {
      totals: { netIrr: number };
    };
    expect(before.totals.netIrr).toBe(-1_000_000);

    expect((await voidRow(id)).status).toBe(200);

    const after = (await (await get('/api/v1/admin/revenue-adjustments')).json()) as {
      total: number;
      totals: { netIrr: number };
    };
    expect(after.total).toBe(0);
    expect(after.totals.netIrr).toBe(0);
  });
});

describe('editing a line', () => {
  /**
   * The history is the feature, not the edit.
   *
   * Sam asked for editing and for «who did it, what was it». An edit with no
   * record is exactly what «the books get messed up» means: the figure moves
   * and nothing anywhere says it used to be different. `audit_logs` is
   * append-only in Postgres, so the record cannot be edited by the person
   * editing the row.
   */
  it('records what changed, from what, by whom - and only what changed', async () => {
    const id = await addId(100_000, 'EXPENSE', 'edit-me');

    const res = await patch(`/api/v1/admin/revenue-adjustments/${id}`, {
      amountToman: 120_000,
      reason: 'فاکتور درست‌تر رسید',
    });
    expect(res.status).toBe(200);
    expect(Number((await rowById(id))?.amount_irr)).toBe(-1_200_000);

    const log = await baseEnv.DB.prepare(
      `SELECT actor_email, before_json, after_json, reason FROM audit_logs
        WHERE entity_type = 'REVENUE_ADJUSTMENT' AND entity_id = ?1
          AND action = 'revenue_adjustment.edited'`,
    )
      .bind(String(id))
      .first<{ actor_email: string; before_json: string; after_json: string; reason: string }>();

    const before = JSON.parse(log!.before_json) as Record<string, unknown>;
    const after = JSON.parse(log!.after_json) as Record<string, unknown>;
    expect(log!.actor_email).toBe(ADMIN);
    expect(log!.reason).toBe('فاکتور درست‌تر رسید');
    expect(before['amount_irr']).toBe(-1_000_000);
    expect(after['amount_irr']).toBe(-1_200_000);
    // Only the field that moved, and the same keys on both sides - a diff where
    // ten of twelve keys are identical is a diff nobody reads, and matching key
    // sets let the screen render it by zipping them.
    expect(Object.keys(before)).toEqual(['amount_irr']);
    expect(Object.keys(after)).toEqual(['amount_irr']);
  });

  /**
   * Changing the kind changes the sign, once.
   *
   * A row moving from «هزینه» to «درآمد دستی» has to cross zero, and the
   * magnitude must survive it exactly. Getting this wrong is invisible: the
   * screen shows a plausible number of the wrong sign.
   */
  it('flips the sign when the kind changes, keeping the magnitude exact', async () => {
    const id = await addId(37_500, 'EXPENSE', 'was-a-cost');
    expect(Number((await rowById(id))?.amount_irr)).toBe(-375_000);

    const res = await patch(`/api/v1/admin/revenue-adjustments/${id}`, { kind: 'MANUAL_INCOME' });
    expect(res.status).toBe(200);
    expect(Number((await rowById(id))?.amount_irr)).toBe(375_000);
  });

  it('writes nothing when nothing changed', async () => {
    const id = await addId(50_000, 'EXPENSE', 'unchanged');
    const res = await patch(`/api/v1/admin/revenue-adjustments/${id}`, { amountToman: 50_000 });
    expect(res.status).toBe(200);
    expect((await res.json()) as { changed: boolean }).toMatchObject({ changed: false });

    const n = await baseEnv.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM audit_logs
        WHERE entity_type = 'REVENUE_ADJUSTMENT' AND entity_id = ?1
          AND action = 'revenue_adjustment.edited'`,
    )
      .bind(String(id))
      .first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('refuses to edit a voided row, and says which of the two it is', async () => {
    const id = await addId(50_000, 'EXPENSE', 'voided-then-edited');
    await voidRow(id);
    // 409 and not 400: the request was well formed, the state refused it.
    const voided = await patch(`/api/v1/admin/revenue-adjustments/${id}`, { amountToman: 1 });
    expect(voided.status).toBe(409);
    const missing = await patch('/api/v1/admin/revenue-adjustments/99999999', { amountToman: 1 });
    expect(missing.status).toBe(404);
  });

  it('is closed to anyone but an ADMIN', async () => {
    const id = await addId(50_000, 'EXPENSE', 'edit-guarded');
    const res = await patch(
      `/api/v1/admin/revenue-adjustments/${id}`,
      { amountToman: 1 },
      REVIEWER,
    );
    expect(res.status).toBe(403);
    expect(Number((await rowById(id))?.amount_irr)).toBe(-500_000);
  });
});

describe('voiding a line', () => {
  /**
   * Voiding replaces deleting, and it fixes a bug nobody had noticed.
   *
   * `verify.ts` compares `COUNT(*) FROM revenue_adjustment_log` against
   * `COUNT(*) FROM revenue_adjustments`, so one admin deleting one line made
   * the migration's own check red for ever with nothing saying why. A voided
   * row stays in the table for that check and leaves `shop_books` for the
   * panel.
   */
  it('leaves the books and stays in the table', async () => {
    const id = await addId(75_000, 'EXPENSE', 'voided');
    expect((await voidRow(id, 'دو بار ثبت شده بود')).status).toBe(200);

    // Gone from what the panel adds up...
    const books = await baseEnv.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM shop_books WHERE id = ?1`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(books?.n).toBe(0);

    // ...and still there for the importer's check, with its reason attached.
    const row = await baseEnv.DB.prepare(
      `SELECT amount_irr, voided_by, void_reason FROM revenue_adjustments WHERE id = ?1`,
    )
      .bind(id)
      .first<{ amount_irr: string | number; voided_by: string; void_reason: string }>();
    expect(Number(row?.amount_irr)).toBe(-750_000);
    expect(row?.voided_by).toBe(ADMIN);
    expect(row?.void_reason).toBe('دو بار ثبت شده بود');
  });

  it('keeps the whole row in a table that cannot be deleted from', async () => {
    const id = await addId(75_000, 'EXPENSE', 'void-audited');
    await voidRow(id);

    const log = await baseEnv.DB.prepare(
      `SELECT before_json FROM audit_logs
        WHERE entity_type = 'REVENUE_ADJUSTMENT' AND entity_id = ?1
          AND action = 'revenue_adjustment.voided'`,
    )
      .bind(String(id))
      .first<{ before_json: string }>();
    const before = JSON.parse(log!.before_json) as { amount_irr: number; note: string };
    // The amount AND the note. Either one alone leaves a history nobody can read.
    expect(Number(before.amount_irr)).toBe(-750_000);
    expect(before.note).toBe(`${PREFIX}void-audited`);
  });

  it('demands a reason, because that is the point of not deleting', async () => {
    const id = await addId(50_000, 'EXPENSE', 'no-reason');
    const res = await post(`/api/v1/admin/revenue-adjustments/${id}/void`, { reason: '' });
    expect(res.status).toBe(400);
  });

  it('is closed to anyone but an ADMIN', async () => {
    const id = await addId(50_000, 'EXPENSE', 'void-guarded');
    expect((await voidRow(id, 'nope', REVIEWER)).status).toBe(403);
    const row = await baseEnv.DB.prepare(`SELECT voided_at FROM revenue_adjustments WHERE id = ?1`)
      .bind(id)
      .first<{ voided_at: string | null }>();
    expect(row?.voided_at).toBeNull();
  });

  it('tells a second void apart from a row that never existed', async () => {
    const id = await addId(50_000, 'EXPENSE', 'twice');
    expect((await voidRow(id)).status).toBe(200);
    expect((await voidRow(id)).status).toBe(409);
    expect((await voidRow(99_999_999)).status).toBe(404);
  });
});

describe('reading the ledger', () => {
  it('filters by kind, by category, and by the day the money left', async () => {
    const cat = await baseEnv.DB.prepare(
      `SELECT id FROM expense_categories WHERE name = 'سرور و زیرساخت'`,
    ).first<{ id: number }>();

    await add(100_000, 'EXPENSE', 'f-server', {
      categoryId: Number(cat!.id),
      spentOn: '2026-07-10',
    });
    await add(50_000, 'MANUAL_INCOME', 'f-sale', { spentOn: '2026-08-10' });

    const one = async (query: string) =>
      (
        (await (await get(`/api/v1/admin/revenue-adjustments?${query}`)).json()) as {
          items: { note: string }[];
        }
      ).items;

    expect(await one('kind=EXPENSE')).toHaveLength(1);
    expect(await one(`categoryId=${Number(cat!.id)}`)).toHaveLength(1);
    // The window is on `spent_on`, so a row typed today for July answers to July.
    expect(await one('from=2026-07-01&to=2026-07-31')).toHaveLength(1);
    expect(await one('q=f-server')).toHaveLength(1);
    expect(await one('uncategorised=true')).toHaveLength(0);
  });

  it('hides voided rows by default and can be asked for them', async () => {
    const id = await addId(50_000, 'EXPENSE', 'v-filter');
    await voidRow(id);

    const count = async (query: string) =>
      (
        (await (await get(`/api/v1/admin/revenue-adjustments?${query}`)).json()) as {
          items: unknown[];
        }
      ).items.length;

    expect(await count('')).toBe(0);
    expect(await count('voided=show')).toBe(1);
    expect(await count('voided=only')).toBe(1);
  });

  it('carries the edit history onto the row, without a query per row', async () => {
    const id = await addId(50_000, 'EXPENSE', 'edited-badge');
    await patch(`/api/v1/admin/revenue-adjustments/${id}`, { amountToman: 60_000 });
    await patch(`/api/v1/admin/revenue-adjustments/${id}`, { note: `${PREFIX}renamed` });

    const body = (await (await get('/api/v1/admin/revenue-adjustments')).json()) as {
      items: { id: number; editCount: number; lastEditedBy: string | null }[];
    };
    const row = body.items.find((i) => i.id === id);
    expect(row?.editCount).toBe(2);
    expect(row?.lastEditedBy).toBe(ADMIN);
  });

  it('answers what was done to one row, in order', async () => {
    const id = await addId(50_000, 'EXPENSE', 'history');
    await patch(`/api/v1/admin/revenue-adjustments/${id}`, { amountToman: 60_000 });
    await voidRow(id, 'اشتباه بود');

    const body = (await (
      await get(`/api/v1/admin/revenue-adjustments/${id}/history`)
    ).json()) as { items: { action: string; reason: string | null }[] };

    expect(body.items.map((i) => i.action)).toEqual([
      'revenue_adjustment.added',
      'revenue_adjustment.edited',
      'revenue_adjustment.voided',
    ]);
    expect(body.items[2]!.reason).toBe('اشتباه بود');
  });

  it('exports the filtered set as a file Excel can read', async () => {
    await add(100_000, 'EXPENSE', 'csv-a');
    await add(50_000, 'MANUAL_INCOME', 'csv-b');

    const res = await get('/api/v1/admin/revenue-adjustments/export.csv?kind=EXPENSE');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');

    /**
     * The BOM, asserted on the BYTES.
     *
     * Without it Excel reads a UTF-8 file as the local codepage and every
     * Persian note becomes mojibake. It cannot be asserted through
     * `res.text()`: `TextDecoder` strips a leading BOM by specification, so
     * that assertion reads false whether or not the bytes are right \u2014 it
     * failed here first, against a response that was already correct.
     */
    const bytes = new Uint8Array(await res.clone().arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    const text = await res.text();
    // The filter applied, and the note round-tripped.
    expect(text).toContain(`${PREFIX}csv-a`);
    expect(text).not.toContain(`${PREFIX}csv-b`);
    // Toman, like every other figure an admin reads on this panel.
    expect(text).toContain('-100000');
  });

  it('reaches the dashboard beside the revenue, not folded into it', async () => {
    // The number the admin reads every morning. Production carries
    // −309,070,750 Toman of adjustment, so a dashboard that dropped it would
    // show a revenue figure 309 million higher than yesterday's on the first
    // morning after the cutover, with nothing on the screen saying why.
    //
    // Beside, not inside: `shopStats.revenueIrr` is the bot's «آمار» screen as
    // well, and it means completed sales on both. The legacy panel splits it
    // the same way (`panel/index.php:28`).
    await add(100_000, 'EXPENSE', 'overview');

    const body = (await (await get('/api/v1/admin/overview')).json()) as {
      revenueIrr: number;
      revenueAdjustmentIrr: number;
    };
    expect(body.revenueAdjustmentIrr).toBe(-1_000_000);
    // Whatever the sales figure is, the adjustment is not already in it.
    const sales = await baseEnv.DB.prepare(
      `SELECT COALESCE(SUM(total_irr), 0) AS n FROM orders WHERE status = 'COMPLETED'`,
    ).first<{ n: string | number }>();
    expect(body.revenueIrr).toBe(Number(sales?.n ?? 0));
  });

  it('is readable by a REVIEWER, who has to reconcile against it', async () => {
    await add(50_000, 'EXPENSE', 'reviewer-read');
    expect((await get('/api/v1/admin/revenue-adjustments', REVIEWER)).status).toBe(200);
  });

  it('is closed to a READ_ONLY operator, in the server and not only the sidebar', async () => {
    // `nav.ts` leaves the section out of `READABLE_BY_READER`, and that alone
    // would be decoration: the file's own header says the server is the guard.
    // What the shop spends is not personal data — the usual reason a path is
    // withheld — but it is the same answer as «دسترسی‌ها», which is on that list
    // for exactly this reason.
    await add(50_000, 'EXPENSE', 'reader');
    expect((await get('/api/v1/admin/revenue-adjustments', READER)).status).toBe(403);
  });

  /**
   * Every path under this screen, not only the one the list uses.
   *
   * This test exists because the export was written at
   * `/api/v1/admin/revenue-adjustments.csv` and that answered 200 to a
   * READ_ONLY operator. `mayRead` matches a prefix as `path === p ||
   * path.startsWith(p + '/')`, so a sibling ending in `.csv` matched neither
   * and handed a reader the whole of the shop's spending as a file — the one
   * thing that list is there to withhold. A suffix is not a child.
   *
   * Asserted per path rather than once, so the next route added beside these
   * has somewhere obvious to be added and a red test if it is not.
   */
  it.each([
    '/api/v1/admin/revenue-adjustments/export.csv',
    '/api/v1/admin/revenue-adjustments/categories',
    '/api/v1/admin/revenue-adjustments/1/history',
  ])('withholds %s from a READ_ONLY operator too', async (path) => {
    expect((await get(path, READER)).status).toBe(403);
  });
});
