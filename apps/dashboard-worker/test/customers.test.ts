/**
 * Customers and wallet adjustment from the dashboard.
 *
 * The assertions deliberately do not ask the route what the balance is and
 * then agree with it. Every balance claim here is re-derived from
 * `SUM(wallet_entries.amount_irr)` — the ledger the trigger reads — because the
 * one failure this whole design exists to prevent is a balance that no longer
 * equals its entries. A test that compared the route's answer to the route's
 * own `wallets` read would have passed even if the route assigned the balance
 * directly, which is exactly the bug (rule 6).
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';
import { MAX_SINGLE_PAYMENT_IRR } from '@shikoo/contracts';

const ADMIN = 'admin@example.com';
const REVIEWER = 'reviewer-customers@example.com';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

/** The balance according to the ledger, not according to `wallets`. */
async function ledgerSum(userId: number): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `SELECT COALESCE(SUM(amount_irr), 0)::bigint AS n FROM wallet_entries WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** The balance according to the derived column the trigger maintains. */
async function walletBalance(userId: number): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `SELECT COALESCE(balance_irr, 0)::bigint AS n FROM wallets WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function entryCount(userId: number): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `SELECT COUNT(*)::int AS n FROM wallet_entries WHERE user_id = ?1`,
  )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Telegram ids far above anything another suite seeds, so runs cannot collide. */
const TG_BASE = 990_000_000;
let seq = 0;

async function makeCustomer(
  username: string,
  opts: { status?: string } = {},
): Promise<{ id: number; telegramId: number }> {
  const telegramId = TG_BASE + ++seq;
  const row = await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, status, registered_at)
     VALUES (?1, ?2, ?3, now()) RETURNING id`,
  )
    .bind(telegramId, username, opts.status ?? 'ACTIVE')
    .first<{ id: number }>();
  return { id: Number(row!.id), telegramId };
}

/**
 * Clears the wallet and this suite's own customers — `users` is not in
 * resetHub's list, so it has to be done here.
 *
 * The ledger is emptied with TRUNCATE rather than DELETE, and that is the
 * schema talking, not a shortcut: `trg_wallet_entries_append_only` is a
 * row-level BEFORE UPDATE OR DELETE trigger, so a DELETE raises
 * `wallet_entries is append-only` — which is the guarantee working, and the
 * first version of this helper was refused by it. TRUNCATE does not fire
 * row-level triggers, so it is the only reset the table allows.
 *
 * Wholesale rather than scoped for the same reason: with ON DELETE RESTRICT
 * from wallet_entries, users cannot be removed while their entries exist. It
 * costs nothing here — no other suite in this package touches the wallet, and
 * the root suite runs packages serially (`--workspace-concurrency=1`), so the
 * bot's tests are not live at the same time.
 */
async function purgeOurCustomers(): Promise<void> {
  await baseEnv.DB.prepare(`TRUNCATE wallet_entries, wallets RESTART IDENTITY CASCADE`).run();
  await baseEnv.DB.prepare(`DELETE FROM users WHERE telegram_id >= ?1`).bind(TG_BASE).run();
}

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }
});

beforeEach(async () => {
  await purgeOurCustomers();
  await baseEnv.DB.prepare(`TRUNCATE audit_logs CASCADE`).run();
});

afterAll(purgeOurCustomers);

describe('GET /api/v1/admin/customers', () => {
  it('pages in SQL and reports the full total', async () => {
    for (let i = 0; i < 5; i++) await makeCustomer(`pager_${i}`);

    const res = await app.request(
      '/api/v1/admin/customers?q=pager_&page=1&pageSize=2',
      {},
      envAs(ADMIN),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; total: number; items: unknown[] };
    expect(body.ok).toBe(true);
    // The point of the route: 5 matched, 2 came back. The PHP panel this
    // replaces returns all 11,241 rows and pages them in the browser.
    expect(body.total).toBe(5);
    expect(body.items).toHaveLength(2);

    const page3 = await app.request(
      '/api/v1/admin/customers?q=pager_&page=3&pageSize=2',
      {},
      envAs(ADMIN),
    );
    expect(((await page3.json()) as { items: unknown[] }).items).toHaveLength(1);
  });

  it('finds a customer by telegram id and by @handle', async () => {
    const { id, telegramId } = await makeCustomer('findme_one');

    const byId = await app.request(`/api/v1/admin/customers?q=${telegramId}`, {}, envAs(ADMIN));
    const byIdBody = (await byId.json()) as { items: { id: number }[] };
    expect(byIdBody.items.map((i) => i.id)).toContain(id);

    const byHandle = await app.request('/api/v1/admin/customers?q=@findme_one', {}, envAs(ADMIN));
    const byHandleBody = (await byHandle.json()) as { items: { id: number }[] };
    expect(byHandleBody.items.map((i) => i.id)).toContain(id);
  });

  it('filters by status', async () => {
    await makeCustomer('st_active');
    const blocked = await makeCustomer('st_blocked', { status: 'BLOCKED' });

    const res = await app.request('/api/v1/admin/customers?q=st_&status=BLOCKED', {}, envAs(ADMIN));
    const body = (await res.json()) as { total: number; items: { id: number }[] };
    expect(body.total).toBe(1);
    expect(body.items[0]!.id).toBe(blocked.id);
  });

  it('reports a customer who has never had an entry as zero, not missing', async () => {
    const { id } = await makeCustomer('nowallet');
    const res = await app.request('/api/v1/admin/customers?q=nowallet', {}, envAs(ADMIN));
    const body = (await res.json()) as { items: { id: number; balanceIrr: number }[] };
    expect(body.items.find((i) => i.id === id)!.balanceIrr).toBe(0);
    // And there is genuinely no wallets row yet — the trigger writes it on the
    // first entry, so this is the missing-row case and not a zeroed one.
    expect(await entryCount(id)).toBe(0);
  });

  it('rejects a page size above the ceiling instead of honouring it', async () => {
    const res = await app.request('/api/v1/admin/customers?pageSize=5000', {}, envAs(ADMIN));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/admin/customers/:id/wallet', () => {
  it('moves the balance by writing an entry, and the ledger agrees', async () => {
    const { id } = await makeCustomer('adj_credit');

    const res = await app.request(
      `/api/v1/admin/customers/${id}/wallet`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          amountIrr: 2_500_000,
          note: 'goodwill after a failed delivery',
          idempotencyKey: 'case-4181-credit',
        }),
      },
      envAs(ADMIN),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { applied: boolean; balanceIrr: number };
    expect(body.applied).toBe(true);

    // Outside truth: the sum of the entries, the derived column, and the
    // route's answer must all be the same number.
    expect(await ledgerSum(id)).toBe(2_500_000);
    expect(await walletBalance(id)).toBe(2_500_000);
    expect(body.balanceIrr).toBe(2_500_000);

    const entry = await baseEnv.DB.prepare(
      `SELECT kind, actor, note FROM wallet_entries WHERE user_id = ?1`,
    )
      .bind(id)
      .first<{ kind: string; actor: string; note: string }>();
    expect(entry).toMatchObject({
      kind: 'ADMIN_ADJUST',
      actor: ADMIN,
      note: 'goodwill after a failed delivery',
    });
  });

  it('applies a debit once even when the form is submitted twice', async () => {
    const { id } = await makeCustomer('adj_double');
    const send = () =>
      app.request(
        `/api/v1/admin/customers/${id}/wallet`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            amountIrr: -1_000_000,
            note: 'reversal of a duplicate top-up',
            idempotencyKey: 'reversal-77',
          }),
        },
        envAs(ADMIN),
      );

    const first = (await (await send()).json()) as { applied: boolean; balanceIrr: number };
    const second = (await (await send()).json()) as { applied: boolean; balanceIrr: number };

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.balanceIrr).toBe(first.balanceIrr);
    // One row, one movement. This is the guarantee `idempotency_key UNIQUE`
    // makes in the database rather than in this route.
    expect(await entryCount(id)).toBe(1);
    expect(await ledgerSum(id)).toBe(-1_000_000);
  });

  it('lets a corrected amount through instead of swallowing it', async () => {
    // The failure this catches: an admin types 500,000, sees the mistake before
    // it lands, corrects it to 5,000,000 and submits again. The form keeps the
    // key it generated when it opened, so with the amount outside the key the
    // second submit is a silent no-op — the response says the money moved, and
    // it did, at the wrong number. Nothing anywhere reports a problem.
    const { id } = await makeCustomer('adj_corrected');
    const send = (amountIrr: number) =>
      app.request(
        `/api/v1/admin/customers/${id}/wallet`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amountIrr, note: 'refund', idempotencyKey: 'form-open-9912' }),
        },
        envAs(ADMIN),
      );

    const typo = (await (await send(500_000)).json()) as { applied: boolean };
    const fixed = (await (await send(5_000_000)).json()) as { applied: boolean };
    expect(typo.applied).toBe(true);
    expect(fixed.applied).toBe(true);
    expect(await entryCount(id)).toBe(2);

    // And the double-submit this key exists for still collapses.
    const again = (await (await send(5_000_000)).json()) as { applied: boolean };
    expect(again.applied).toBe(false);
    expect(await entryCount(id)).toBe(2);
    expect(await ledgerSum(id)).toBe(5_500_000);
  });

  it('writes down the balance its own entry produced, not a passer-by’s', async () => {
    // `wallets.balance_irr` is derived by a trigger, and the INSERT and the
    // read-back used to be two statements with no transaction around them. The
    // window between them is not theoretical: the trigger's
    // `INSERT … ON CONFLICT DO UPDATE` takes a row lock on the wallet and holds
    // it until COMMIT, so with the two in one transaction nobody else can move
    // that balance in between — and without it, the lock is released the moment
    // the entry lands and the next writer's total is what gets written down.
    //
    // Eight adjustments at once, on one wallet. Every audit row must satisfy
    // after = before + amount; a row that recorded somebody else's total will
    // not. The failing rows are named rather than counted, because "some row is
    // wrong" is not a useful thing to read at 3am.
    const { id } = await makeCustomer('adj_interleaved');
    const amounts = [100_000, 200_000, 300_000, 400_000, 500_000, 600_000, 700_000, 800_000];

    await Promise.all(
      amounts.map((amountIrr, i) =>
        app.request(
          `/api/v1/admin/customers/${id}/wallet`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              amountIrr,
              note: `concurrent ${i}`,
              idempotencyKey: `interleaved-${i}`,
            }),
          },
          envAs(ADMIN),
        ),
      ),
    );

    const logs = await baseEnv.DB.prepare(
      `SELECT before_json, after_json FROM audit_logs
        WHERE entity_type = 'CUSTOMER' AND entity_id = ?1 AND action = 'customer.wallet_adjusted'`,
    )
      .bind(String(id))
      .all<{ before_json: string; after_json: string }>();

    expect(logs.results).toHaveLength(amounts.length);
    const wrong = (logs.results ?? [])
      .map((row) => ({ before: JSON.parse(row.before_json), after: JSON.parse(row.after_json) }))
      .filter((r) => r.before.balance_irr + r.after.amount_irr !== r.after.balance_irr);
    expect(wrong).toEqual([]);

    // And the ledger still adds up, which is the outer guarantee.
    expect(await ledgerSum(id)).toBe(3_600_000);
    expect(await walletBalance(id)).toBe(3_600_000);
  });

  it('keeps two admins editing the same wallet from overwriting each other', async () => {
    const { id } = await makeCustomer('adj_concurrent');
    const adjust = (amount: number, key: string) =>
      app.request(
        `/api/v1/admin/customers/${id}/wallet`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amountIrr: amount, note: 'concurrent', idempotencyKey: key }),
        },
        envAs(ADMIN),
      );

    await Promise.all([adjust(300_000, 'concurrent-a'), adjust(700_000, 'concurrent-b')]);

    // Both survive. Mirzabot's `Balance = Balance ± x` read-modify-write loses
    // one of these, which is why the balance is derived here.
    expect(await entryCount(id)).toBe(2);
    expect(await ledgerSum(id)).toBe(1_000_000);
    expect(await walletBalance(id)).toBe(1_000_000);
  });

  it('lets a correction go negative and says so', async () => {
    const { id } = await makeCustomer('adj_negative');
    const res = await app.request(
      `/api/v1/admin/customers/${id}/wallet`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          amountIrr: -500_000,
          note: 'credit already spent, correcting',
          idempotencyKey: 'negative-1',
        }),
      },
      envAs(ADMIN),
    );
    const body = (await res.json()) as { balanceIrr: number; negative: boolean };
    expect(body.balanceIrr).toBe(-500_000);
    expect(body.negative).toBe(true);
  });

  it('refuses zero, and an amount past the ceiling', async () => {
    const { id } = await makeCustomer('adj_bounds');
    for (const amountIrr of [0, MAX_SINGLE_PAYMENT_IRR + 1, -(MAX_SINGLE_PAYMENT_IRR + 1)]) {
      const res = await app.request(
        `/api/v1/admin/customers/${id}/wallet`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amountIrr, note: 'nope', idempotencyKey: `bound-${amountIrr}` }),
        },
        envAs(ADMIN),
      );
      expect(res.status).toBe(400);
    }
    expect(await entryCount(id)).toBe(0);
  });

  it('writes an audit row carrying the balance before and after', async () => {
    const { id } = await makeCustomer('adj_audit');
    await app.request(
      `/api/v1/admin/customers/${id}/wallet`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          amountIrr: 1_200_000,
          note: 'compensation for ticket 88',
          idempotencyKey: 'audit-88',
        }),
      },
      envAs(ADMIN),
    );

    const log = await baseEnv.DB.prepare(
      `SELECT actor_email, actor_role, action, entity_type, entity_id, before_json, after_json, reason
         FROM audit_logs WHERE action = 'customer.wallet_adjusted'`,
    ).first<{
      actor_email: string;
      actor_role: string;
      action: string;
      entity_type: string;
      entity_id: string;
      before_json: string;
      after_json: string;
      reason: string;
    }>();
    expect(log).toBeTruthy();
    expect(log!.actor_email).toBe(ADMIN);
    expect(log!.actor_role).toBe('ADMIN');
    expect(log!.entity_type).toBe('CUSTOMER');
    expect(log!.entity_id).toBe(String(id));
    expect(log!.reason).toBe('compensation for ticket 88');
    expect(JSON.parse(log!.before_json)).toEqual({ balance_irr: 0 });
    expect(JSON.parse(log!.after_json)).toEqual({
      balance_irr: 1_200_000,
      amount_irr: 1_200_000,
    });
  });

  it('does not audit a replayed key, because nothing moved', async () => {
    const { id } = await makeCustomer('adj_replay_audit');
    const send = () =>
      app.request(
        `/api/v1/admin/customers/${id}/wallet`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amountIrr: 100_000, note: 'once', idempotencyKey: 'replay-1' }),
        },
        envAs(ADMIN),
      );
    await send();
    await send();

    const n = await baseEnv.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'customer.wallet_adjusted'`,
    ).first<{ n: number }>();
    expect(n?.n).toBe(1);
  });

  it('refuses a reviewer, and moves nothing', async () => {
    const { id } = await makeCustomer('adj_reviewer');
    const res = await app.request(
      `/api/v1/admin/customers/${id}/wallet`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountIrr: 999_000, note: 'nope', idempotencyKey: 'rev-1' }),
      },
      envAs(REVIEWER),
    );
    expect(res.status).toBe(403);
    expect(await entryCount(id)).toBe(0);
    expect(await ledgerSum(id)).toBe(0);
  });

  it('404s on a customer that does not exist, without writing an entry', async () => {
    const res = await app.request(
      '/api/v1/admin/customers/99999999/wallet',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountIrr: 100_000, note: 'ghost', idempotencyKey: 'ghost-user-1' }),
      },
      envAs(ADMIN),
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /api/v1/admin/customers/:id/status', () => {
  it('blocks with a reason and audits it', async () => {
    const { id } = await makeCustomer('blockme');
    const res = await app.request(
      `/api/v1/admin/customers/${id}/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'BLOCKED', reason: 'chargeback fraud' }),
      },
      envAs(ADMIN),
    );
    expect(res.status).toBe(200);

    const row = await baseEnv.DB.prepare(`SELECT status, blocked_reason FROM users WHERE id = ?1`)
      .bind(id)
      .first<{ status: string; blocked_reason: string }>();
    expect(row).toMatchObject({ status: 'BLOCKED', blocked_reason: 'chargeback fraud' });

    const log = await baseEnv.DB.prepare(
      `SELECT action, reason FROM audit_logs WHERE entity_id = ?1`,
    )
      .bind(String(id))
      .first<{ action: string; reason: string }>();
    expect(log).toMatchObject({ action: 'customer.blocked', reason: 'chargeback fraud' });
  });

  it('clears the reason on unblock', async () => {
    const { id } = await makeCustomer('unblockme', { status: 'BLOCKED' });
    await baseEnv.DB.prepare(`UPDATE users SET blocked_reason = 'old' WHERE id = ?1`)
      .bind(id)
      .run();

    await app.request(
      `/api/v1/admin/customers/${id}/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ACTIVE', reason: null }),
      },
      envAs(ADMIN),
    );
    const row = await baseEnv.DB.prepare(`SELECT blocked_reason FROM users WHERE id = ?1`)
      .bind(id)
      .first<{ blocked_reason: string | null }>();
    expect(row?.blocked_reason).toBeNull();
  });

  it('is a no-op when the status already matches, and audits nothing', async () => {
    const { id } = await makeCustomer('already_active');
    const res = await app.request(
      `/api/v1/admin/customers/${id}/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'ACTIVE', reason: null }),
      },
      envAs(ADMIN),
    );
    expect(((await res.json()) as { changed: boolean }).changed).toBe(false);
    const n = await baseEnv.DB.prepare(`SELECT COUNT(*)::int AS n FROM audit_logs`).first<{
      n: number;
    }>();
    expect(n?.n).toBe(0);
  });

  it('refuses a reviewer', async () => {
    const { id } = await makeCustomer('status_reviewer');
    const res = await app.request(
      `/api/v1/admin/customers/${id}/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'BLOCKED', reason: null }),
      },
      envAs(REVIEWER),
    );
    expect(res.status).toBe(403);
    const row = await baseEnv.DB.prepare(`SELECT status FROM users WHERE id = ?1`)
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe('ACTIVE');
  });
});

describe('GET /api/v1/admin/customers/:id', () => {
  it('returns the customer with the ledger behind the balance', async () => {
    const { id, telegramId } = await makeCustomer('detail_one');
    await app.request(
      `/api/v1/admin/customers/${id}/wallet`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountIrr: 750_000, note: 'first', idempotencyKey: 'detail-1' }),
      },
      envAs(ADMIN),
    );

    const res = await app.request(`/api/v1/admin/customers/${id}`, {}, envAs(ADMIN));
    const body = (await res.json()) as {
      customer: { telegramId: number; balanceIrr: number; orderCount: number };
      entries: { amountIrr: number; kind: string; actor: string }[];
    };
    expect(body.customer.telegramId).toBe(telegramId);
    expect(body.customer.balanceIrr).toBe(await ledgerSum(id));
    expect(body.customer.orderCount).toBe(0);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      amountIrr: 750_000,
      kind: 'ADMIN_ADJUST',
      actor: ADMIN,
    });
  });

  it('404s on an unknown id', async () => {
    const res = await app.request('/api/v1/admin/customers/99999999', {}, envAs(ADMIN));
    expect(res.status).toBe(404);
  });
});
