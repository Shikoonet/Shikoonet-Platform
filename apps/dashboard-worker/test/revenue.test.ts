/**
 * هزینه‌ها و تعدیل‌ها, from the panel.
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
 * the test for that is that a delete moves the total without anything else
 * being written.
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

const del = (path: string, email = ADMIN) =>
  app.request(path, { method: 'DELETE' }, envAs(email));

const get = (path: string, email = ADMIN) => app.request(path, {}, envAs(email));

function add(amountToman: number, direction: 'expense' | 'credit', label: string) {
  return post('/api/v1/admin/revenue-adjustments', {
    amountToman,
    direction,
    note: `${PREFIX}${label}`,
  });
}

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
    const res = await add(50_000, 'expense', 'server');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; id: number; amountIrr: number };
    expect(body.ok).toBe(true);
    expect(body.amountIrr).toBe(-500_000);

    const row = await rowById(body.id);
    expect(Number(row?.amount_irr)).toBe(-500_000);
    expect(row?.created_by).toBe(ADMIN);
  });

  it('stores a credit as a positive one', async () => {
    const res = await add(50_000, 'credit', 'refund');
    const body = (await res.json()) as { id: number; amountIrr: number };
    expect(body.amountIrr).toBe(500_000);
    expect(Number((await rowById(body.id))?.amount_irr)).toBe(500_000);
  });

  it('converts Toman to IRR exactly once', async () => {
    // The project's one conversion, and the one place a factor of ten hides.
    const res = await add(1, 'credit', 'one-toman');
    const body = (await res.json()) as { amountIrr: number };
    expect(body.amountIrr).toBe(10);
  });

  it('refuses a signed amount rather than guessing what was meant', async () => {
    const res = await post('/api/v1/admin/revenue-adjustments', {
      amountToman: -50_000,
      direction: 'expense',
      note: `${PREFIX}signed`,
    });
    expect(res.status).toBe(400);
  });

  it('refuses zero', async () => {
    const res = await post('/api/v1/admin/revenue-adjustments', {
      amountToman: 0,
      direction: 'expense',
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
        direction: 'expense',
        note,
      });
      expect(res.status, JSON.stringify(note)).toBe(400);
    }
  });

  it('refuses an amount that can only be a slipped digit', async () => {
    const res = await post('/api/v1/admin/revenue-adjustments', {
      amountToman: 10_000_000_001,
      direction: 'expense',
      note: `${PREFIX}fat-finger`,
    });
    expect(res.status).toBe(400);
  });

  it('is closed to anyone but an ADMIN', async () => {
    const res = await post(
      '/api/v1/admin/revenue-adjustments',
      { amountToman: 50_000, direction: 'expense', note: `${PREFIX}reviewer` },
      REVIEWER,
    );
    expect(res.status).toBe(403);
    const n = await baseEnv.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM revenue_adjustments`,
    ).first<{ n: number }>();
    expect(n?.n).toBe(0);
  });

  it('writes what it did to the audit log', async () => {
    const res = await add(50_000, 'expense', 'audited');
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
  it('separate what was spent from what came back', async () => {
    // A net figure alone hides both halves: the same «−۳۰۰٬۰۰۰» is a quiet month
    // and a big month with bigger costs, and the admin cannot tell which.
    await add(100_000, 'expense', 'a');
    await add(200_000, 'expense', 'b');
    await add(50_000, 'credit', 'c');

    const body = (await (await get('/api/v1/admin/revenue-adjustments')).json()) as {
      total: number;
      totals: { expensesIrr: number; creditsIrr: number; netIrr: number };
    };
    expect(body.total).toBe(3);
    expect(body.totals.expensesIrr).toBe(-3_000_000);
    expect(body.totals.creditsIrr).toBe(500_000);
    expect(body.totals.netIrr).toBe(-2_500_000);
  });

  it('cover the whole ledger, not the page being looked at', async () => {
    // A running total that changed when you turned the page would be worse than
    // no total at all.
    for (let i = 0; i < 5; i++) await add(10_000, 'expense', `page-${i}`);

    const body = (await (
      await get('/api/v1/admin/revenue-adjustments?page=1&pageSize=2')
    ).json()) as { items: unknown[]; totals: { netIrr: number } };
    expect(body.items).toHaveLength(2);
    expect(body.totals.netIrr).toBe(-500_000);
  });

  it('ignore the filter, so narrowing the list does not rewrite the books', async () => {
    // Deliberate, and the opposite is the plausible reading: the three numbers
    // are the shop's position, not a description of the rows on screen.
    // Filtering to «هزینه» and watching «مجموع بستانکاری‌ها» drop to zero would
    // read as the credits having gone somewhere.
    await add(100_000, 'expense', 'w-a');
    await add(50_000, 'credit', 'w-b');

    const body = (await (
      await get('/api/v1/admin/revenue-adjustments?direction=expense')
    ).json()) as {
      items: unknown[];
      totals: { expensesIrr: number; creditsIrr: number; netIrr: number };
    };
    expect(body.items).toHaveLength(1);
    expect(body.totals.creditsIrr).toBe(500_000);
    expect(body.totals.netIrr).toBe(-500_000);
  });

  it('are derived, so a delete moves them with nothing else written', async () => {
    // The legacy panel keeps `setting.revenue_adjustment` alongside the log and
    // rewrites it inside a transaction on every insert and delete. Two things
    // that must agree is one thing that can be wrong; this asserts there is only
    // ever one.
    const res = await add(100_000, 'expense', 'derived');
    const { id } = (await res.json()) as { id: number };

    const before = (await (await get('/api/v1/admin/revenue-adjustments')).json()) as {
      totals: { netIrr: number };
    };
    expect(before.totals.netIrr).toBe(-1_000_000);

    expect((await del(`/api/v1/admin/revenue-adjustments/${id}`)).status).toBe(200);

    const after = (await (await get('/api/v1/admin/revenue-adjustments')).json()) as {
      total: number;
      totals: { netIrr: number };
    };
    expect(after.total).toBe(0);
    expect(after.totals.netIrr).toBe(0);
  });
});

describe('removing a line', () => {
  it('keeps what it removed, in a table that cannot be deleted from', async () => {
    // Deletion is real here, unlike `wallet_entries`, because this is the
    // admin's own note about the shop's own books. What it must not do is erase
    // the fact that the line existed.
    const res = await add(75_000, 'expense', 'removed');
    const { id } = (await res.json()) as { id: number };
    await del(`/api/v1/admin/revenue-adjustments/${id}`);

    const log = await baseEnv.DB.prepare(
      `SELECT action, before_json FROM audit_logs
        WHERE entity_type = 'REVENUE_ADJUSTMENT' AND entity_id = ?1
          AND action = 'revenue_adjustment.deleted'`,
    )
      .bind(String(id))
      .first<{ action: string; before_json: unknown }>();
    expect(log?.action).toBe('revenue_adjustment.deleted');
    const before =
      typeof log?.before_json === 'string'
        ? (JSON.parse(log.before_json) as { amount_irr: number; note: string })
        : (log?.before_json as { amount_irr: number; note: string });
    // The amount AND the note. Either one alone leaves a history nobody can read.
    expect(Number(before.amount_irr)).toBe(-750_000);
    expect(before.note).toBe(`${PREFIX}removed`);
  });

  it('is closed to anyone but an ADMIN', async () => {
    const res = await add(50_000, 'expense', 'guarded');
    const { id } = (await res.json()) as { id: number };

    expect((await del(`/api/v1/admin/revenue-adjustments/${id}`, REVIEWER)).status).toBe(403);
    expect(await rowById(id)).not.toBeNull();
  });

  it('answers 404 for a row that is already gone', async () => {
    const res = await add(50_000, 'expense', 'twice');
    const { id } = (await res.json()) as { id: number };
    expect((await del(`/api/v1/admin/revenue-adjustments/${id}`)).status).toBe(200);
    expect((await del(`/api/v1/admin/revenue-adjustments/${id}`)).status).toBe(404);
  });
});

describe('reading the ledger', () => {
  it('filters by direction using the sign, because that is where it lives', async () => {
    await add(100_000, 'expense', 'f-a');
    await add(50_000, 'credit', 'f-b');

    const expenses = (await (
      await get('/api/v1/admin/revenue-adjustments?direction=expense')
    ).json()) as { items: { amountIrr: number }[] };
    expect(expenses.items).toHaveLength(1);
    expect(expenses.items[0]!.amountIrr).toBeLessThan(0);

    const credits = (await (
      await get('/api/v1/admin/revenue-adjustments?direction=credit')
    ).json()) as { items: { amountIrr: number }[] };
    expect(credits.items).toHaveLength(1);
    expect(credits.items[0]!.amountIrr).toBeGreaterThan(0);
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
    await add(100_000, 'expense', 'overview');

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
    await add(50_000, 'expense', 'reviewer-read');
    expect((await get('/api/v1/admin/revenue-adjustments', REVIEWER)).status).toBe(200);
  });

  it('is closed to a READ_ONLY operator, in the server and not only the sidebar', async () => {
    // `nav.ts` leaves the section out of `READABLE_BY_READER`, and that alone
    // would be decoration: the file's own header says the server is the guard.
    // What the shop spends is not personal data — the usual reason a path is
    // withheld — but it is the same answer as «دسترسی‌ها», which is on that list
    // for exactly this reason.
    await add(50_000, 'expense', 'reader');
    expect((await get('/api/v1/admin/revenue-adjustments', READER)).status).toBe(403);
  });
});
