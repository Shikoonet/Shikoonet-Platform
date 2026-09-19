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
import { applySchema, env as baseEnv, deleteFixtureUsers, FIXTURE_TG_BASE } from './helpers/env.js';
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
const TG_BASE = FIXTURE_TG_BASE + 990_000_000;
let seq = 0;

/**
 * Prefixes every fixture handle, because the searches below are assertions
 * about COUNTS.
 *
 * `?q=st_&status=BLOCKED` expecting exactly one row is true of an empty
 * database and false of a real one: the imported dump holds nine customers
 * whose handle contains `st_`, and one of them being BLOCKED turns this red on
 * a machine doing migration work. The telegram-id range being this suite's own
 * (issue #46) keeps its WRITES to itself; a handle nobody else could have is
 * what keeps its READS to itself.
 */
const HANDLE = 'zzcust-';

async function makeCustomer(
  username: string,
  opts: { status?: string } = {},
): Promise<{ id: number; telegramId: number }> {
  const telegramId = TG_BASE + ++seq;
  const row = await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, status, registered_at)
     VALUES (?1, ?2, ?3, now()) RETURNING id`,
  )
    .bind(telegramId, `${HANDLE}${username}`, opts.status ?? 'ACTIVE')
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
  await deleteFixtureUsers(TG_BASE);
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
      `/api/v1/admin/customers?q=${HANDLE}pager_&page=1&pageSize=2`,
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
      `/api/v1/admin/customers?q=${HANDLE}pager_&page=3&pageSize=2`,
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

    const byHandle = await app.request(`/api/v1/admin/customers?q=@${HANDLE}findme_one`, {}, envAs(ADMIN));
    const byHandleBody = (await byHandle.json()) as { items: { id: number }[] };
    expect(byHandleBody.items.map((i) => i.id)).toContain(id);
  });

  it('filters by status', async () => {
    await makeCustomer('st_active');
    const blocked = await makeCustomer('st_blocked', { status: 'BLOCKED' });

    const res = await app.request(`/api/v1/admin/customers?q=${HANDLE}st_&status=BLOCKED`, {}, envAs(ADMIN));
    const body = (await res.json()) as { total: number; items: { id: number }[] };
    expect(body.total).toBe(1);
    expect(body.items[0]!.id).toBe(blocked.id);
  });

  it('reports a customer who has never had an entry as zero, not missing', async () => {
    const { id } = await makeCustomer('nowallet');
    const res = await app.request(`/api/v1/admin/customers?q=${HANDLE}nowallet`, {}, envAs(ADMIN));
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

  it('refuses a second amount on the same key, and says so', async () => {
    // Issue #196, Sam's call. Two sequences reach the same database state and
    // differ only in intent: (a) a typo that landed, then a correction on the
    // same open form; (b) a lost response, then a retry with a corrected
    // figure. With the amount inside the key both credited twice — 5,500,000
    // for an operator who meant 5,000,000, silently. With it outside, the
    // second submit is refused and the operator is told something already
    // landed; the correction is a fresh decision and needs a fresh key.
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
    expect(fixed.applied).toBe(false);
    expect(await entryCount(id)).toBe(1);
    expect(await ledgerSum(id)).toBe(500_000);

    // A fresh key is a fresh decision, and goes through.
    const reopened = (await (
      await app.request(
        `/api/v1/admin/customers/${id}/wallet`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ amountIrr: 4_500_000, note: 'refund', idempotencyKey: 'form-open-9913' }),
        },
        envAs(ADMIN),
      )
    ).json()) as { applied: boolean };
    expect(reopened.applied).toBe(true);
    expect(await ledgerSum(id)).toBe(5_000_000);
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

  /**
   * The header the caller was handed and the `request_id` on the row are the
   * same string.
   *
   * `e2e/request-id.spec.ts` asserts exactly this through a browser, and it is
   * what caught the bug: moving the audit write into `setCustomerStatus` I
   * passed `cf-ray`, which is not what the worker generates — Cloudflare is not
   * in front of this any more, so the header is absent and the row recorded
   * null. Every unit suite stayed green because the pairing spans the HTTP
   * response and the database, and nothing below the browser walk looked at
   * both.
   *
   * This does, for a tenth of the cost. It does not replace the e2e — that one
   * proves a real browser is handed the header — it stops the same mistake
   * reaching it.
   */
  it('records the id the response was handled under, not a header nobody sets', async () => {
    const { id } = await makeCustomer('reqid');
    const res = await app.request(
      `/api/v1/admin/customers/${id}/status`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'BLOCKED', reason: 'request id' }),
      },
      envAs(ADMIN),
    );
    expect(res.status).toBe(200);

    const header = res.headers.get('x-request-id');
    expect(header).toBeTruthy();

    const log = await baseEnv.DB.prepare(
      `SELECT request_id FROM audit_logs WHERE entity_id = ?1 AND action = 'customer.blocked'`,
    )
      .bind(String(id))
      .first<{ request_id: string | null }>();
    expect(log?.request_id).toBe(header);
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

/**
 * «این آی‌دی چند بار و به کدام کارت‌ها واریز داشته» — plan item 1.6, and the
 * last question the money pass left unanswered on this screen.
 *
 * The detail drawer knew the wallet and the order count and said nothing about
 * claims or cards, so the one place an operator opens with a customer's name in
 * front of them could not answer what that customer actually paid.
 *
 * Counted exactly as «توازن کارت‌ها» counts it — `status = 'VERIFIED'`,
 * `source_system = MIRZABOT`, summing `expected_amount_irr` — so this customer's
 * rows are a subset of that card's takings rather than a second definition of
 * the same word.
 */
describe('the money on a customer’s own page', () => {
  async function claim(
    id: string,
    telegramId: number,
    card: string,
    amountIrr: number,
    status = 'VERIFIED',
  ) {
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT INTO payment_claims
         (id, external_order_id, customer_reference, expected_amount_irr,
          submitted_at, source_system, metadata_json, status, paid_clicked_at,
          card_digits, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'MIRZABOT', '{}', ?6, ?5, ?7, ?5, ?5)`,
    )
      .bind(id, `cust:${id}`, String(telegramId), amountIrr, now, status, card)
      .run();
  }

  it('says how much this id paid, to which cards, and how many times', async () => {
    const { id, telegramId } = await makeCustomer('payer');
    await claim(`pc-1-${telegramId}`, telegramId, '6037000000000095', 1_000_000);
    await claim(`pc-2-${telegramId}`, telegramId, '6037000000000095', 2_000_000);
    await claim(`pc-3-${telegramId}`, telegramId, '5054161706275678', 500_000);
    // Not settled, so not money: it is a claim nobody confirmed.
    await claim(`pc-4-${telegramId}`, telegramId, '5054161706275678', 9_000_000, 'PENDING');

    const r = await app.fetch(
      new Request(`https://x/api/v1/admin/customers/${id}`),
      envAs(ADMIN),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as {
      payments: {
        count: number;
        totalIrr: number;
        byCard: Array<{ cardMasked: string; payments: number; amountIrr: number }>;
      };
    };

    expect(body.payments.count).toBe(3);
    expect(body.payments.totalIrr).toBe(3_500_000);
    expect(body.payments.byCard.map((c) => c.amountIrr)).toEqual([3_000_000, 500_000]);
    expect(body.payments.byCard[0]!.payments).toBe(2);
    // The card is named, never in full.
    expect(JSON.stringify(body)).not.toContain('6037000000000095');
    expect(body.payments.byCard[0]!.cardMasked).toContain('0095');
  });

  it('says zero rather than nothing when the customer has never paid', async () => {
    const { id } = await makeCustomer('never-paid');
    const r = await app.fetch(
      new Request(`https://x/api/v1/admin/customers/${id}`),
      envAs(ADMIN),
    );
    const body = (await r.json()) as { payments: { count: number; byCard: unknown[] } };
    expect(body.payments.count).toBe(0);
    expect(body.payments.byCard).toEqual([]);
  });
});

/**
 * «زیرمجموعه‌هاش کیا هستن، کی اومدن، چقدر خریدن» — Sam, 2026-09-19.
 *
 * The bot's own screen says two numbers (how many, how much earned) and the
 * dashboard said nothing at all: `referred_by` was not even in the API. The
 * only way to answer was SQL on the server.
 *
 * A «purchase» here is what `apps/bot/src/referral.ts` pays commission on —
 * PAID or later, not a top-up, not a trial — so the count beside a referral
 * is the count the commission rule saw, not a third definition of «bought».
 */
describe('a customer’s referrals on their own page', () => {
  async function order(userId: number, kind: string, totalIrr: number, status = 'COMPLETED') {
    // `orders_trial_is_free` wants a provider on a trial; nothing else does.
    const provider =
      kind === 'TRIAL'
        ? await baseEnv.DB.prepare(
            `INSERT INTO provisioning_providers (code, name, kind, status)
             VALUES ('zzref-panel', 'zzref-panel', 'manual', 'ACTIVE')
             ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
          ).first<{ id: number }>()
        : null;
    const row = await baseEnv.DB.prepare(
      `INSERT INTO orders (public_id, user_id, kind, provider_id, unit_price_irr, total_irr, status, completed_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6, now()) RETURNING id`,
    )
      .bind(`zzref-${userId}-${++seq}`, userId, kind, provider?.id ?? null, totalIrr, status)
      .first<{ id: number }>();
    return Number(row!.id);
  }

  async function detail(id: number) {
    const res = await app.request(`/api/v1/admin/customers/${id}`, {}, envAs(ADMIN));
    expect(res.status).toBe(200);
    return (await res.json()) as {
      referral: {
        referredBy: { id: number; telegramId: number; username: string | null } | null;
        invited: number;
        earnedIrr: number;
        referrals: {
          id: number;
          telegramId: number;
          username: string | null;
          joinedAt: string;
          purchases: number;
          boughtIrr: number;
          commissionIrr: number;
        }[];
      };
    };
  }

  it('lists who this customer brought, what each bought, and what each paid them', async () => {
    const referrer = await makeCustomer('ref_parent');
    const buyer = await makeCustomer('ref_buyer');
    const idle = await makeCustomer('ref_idle');
    await baseEnv.DB.prepare(`UPDATE users SET referred_by = ?1 WHERE id IN (?2, ?3)`)
      .bind(referrer.id, buyer.id, idle.id)
      .run();

    // Two real purchases, a top-up and a trial: only the two count.
    const first = await order(buyer.id, 'NEW_PURCHASE', 1_000_000);
    await order(buyer.id, 'RENEWAL', 500_000, 'PAID');
    await order(buyer.id, 'WALLET_TOPUP', 2_000_000);
    await order(buyer.id, 'TRIAL', 0);
    await order(buyer.id, 'NEW_PURCHASE', 9_000_000, 'AWAITING_PAYMENT');
    await baseEnv.DB.prepare(
      `INSERT INTO wallet_entries (user_id, amount_irr, kind, order_id, idempotency_key)
       VALUES (?1, 100000, 'REFERRAL_BONUS', ?2, ?3)`,
    )
      .bind(referrer.id, first, `referral:${first}`)
      .run();

    const parent = await detail(referrer.id);
    expect(parent.referral.referredBy).toBeNull();
    expect(parent.referral.invited).toBe(2);
    expect(parent.referral.earnedIrr).toBe(100_000);
    expect(parent.referral.referrals).toHaveLength(2);
    expect(parent.referral.referrals.map((r) => r.id)).toEqual([buyer.id, idle.id]);
    expect(parent.referral.referrals[0]).toMatchObject({
      telegramId: buyer.telegramId,
      purchases: 2,
      boughtIrr: 1_500_000,
      commissionIrr: 100_000,
    });
    expect(parent.referral.referrals[1]).toMatchObject({
      telegramId: idle.telegramId,
      purchases: 0,
      boughtIrr: 0,
      commissionIrr: 0,
    });
    expect(typeof parent.referral.referrals[0]!.joinedAt).toBe('string');

    // The child's page names the parent, and has no referrals of its own.
    const child = await detail(buyer.id);
    expect(child.referral.referredBy).toMatchObject({
      id: referrer.id,
      telegramId: referrer.telegramId,
    });
    expect(child.referral.invited).toBe(0);
    expect(child.referral.referrals).toEqual([]);
  });

  /**
   * «زیرمجموعه‌ها» as a screen: every referrer in one list, with the sums the
   * card shows per person. The fixture is three referrers of different shapes
   * so each filter and each sort has something to separate.
   */
  it('lists every referrer with their sums, and the filters narrow the same set the totals count', async () => {
    const big = await makeCustomer('rf_big'); // 3 referrals, 2 of them buyers
    const one = await makeCustomer('rf_one'); // 1 referral, a buyer, 2 bonuses
    const idle = await makeCustomer('rf_idle'); // 2 referrals, nobody bought
    const nobody = await makeCustomer('rf_nobody'); // no referrals: not a row
    const kids: Record<string, { id: number; telegramId: number }> = {};
    for (const [parent, names] of [
      [big, ['b1', 'b2', 'b3']],
      [one, ['o1']],
      [idle, ['i1', 'i2']],
    ] as const) {
      for (const n of names) {
        kids[n] = await makeCustomer(`rf_${n}`);
        await baseEnv.DB.prepare(`UPDATE users SET referred_by = ?1 WHERE id = ?2`)
          .bind(parent.id, kids[n].id)
          .run();
      }
    }
    // One referral joined «last month» so `since` has something to exclude.
    await baseEnv.DB.prepare(
      `UPDATE users SET registered_at = now() - interval '40 days' WHERE id = ?1`,
    )
      .bind(kids.b3!.id)
      .run();

    const b1first = await order(kids.b1!.id, 'NEW_PURCHASE', 1_000_000);
    await order(kids.b1!.id, 'RENEWAL', 500_000, 'PAID');
    await order(kids.b2!.id, 'NEW_PURCHASE', 300_000);
    await order(kids.b2!.id, 'WALLET_TOPUP', 9_000_000); // not a purchase
    await order(kids.b3!.id, 'TRIAL', 0); // not a purchase
    const o1first = await order(kids.o1!.id, 'NEW_PURCHASE', 2_000_000);
    const o1second = await order(kids.o1!.id, 'RENEWAL', 2_000_000);
    for (const [uid, oid, amt] of [
      [big.id, b1first, 100_000],
      [one.id, o1first, 200_000],
      [one.id, o1second, 200_000],
    ] as const) {
      await baseEnv.DB.prepare(
        `INSERT INTO wallet_entries (user_id, amount_irr, kind, order_id, idempotency_key)
         VALUES (?1, ?2, 'REFERRAL_BONUS', ?3, ?4)`,
      )
        .bind(uid, amt, oid, `referral:${oid}`)
        .run();
    }

    type Row = {
      id: number;
      telegramId: number;
      username: string | null;
      invited: number;
      buyers: number;
      boughtIrr: number;
      commissionIrr: number;
      lastJoinedAt: string;
    };
    type Body = {
      total: number;
      totals: { referrers: number; invited: number; buyers: number; boughtIrr: number; commissionIrr: number };
      items: Row[];
    };
    // `q` scopes every call to this suite's handles: the database this runs on
    // may hold other suites' referrers, and the assertion is about ours.
    async function list(qs: string): Promise<Body> {
      const res = await app.request(`/api/v1/admin/referrers?q=${HANDLE}rf_&${qs}`, {}, envAs(ADMIN));
      expect(res.status).toBe(200);
      return (await res.json()) as Body;
    }
    const byId = (b: Body) => new Map(b.items.map((r) => [r.id, r]));

    // Default: every referrer, most referrals first. The one with none is absent.
    const all = await list('');
    expect(all.items.map((r) => r.id)).toEqual([big.id, idle.id, one.id]);
    expect(all.items.map((r) => r.id)).not.toContain(nobody.id);
    expect(byId(all).get(big.id)).toMatchObject({
      invited: 3,
      buyers: 2,
      boughtIrr: 1_800_000,
      commissionIrr: 100_000,
      username: `${HANDLE}rf_big`,
    });
    expect(byId(all).get(one.id)).toMatchObject({ invited: 1, buyers: 1, boughtIrr: 4_000_000, commissionIrr: 400_000 });
    expect(byId(all).get(idle.id)).toMatchObject({ invited: 2, buyers: 0, boughtIrr: 0, commissionIrr: 0 });
    expect(all.total).toBe(3);
    expect(all.totals).toEqual({ referrers: 3, invited: 6, buyers: 3, boughtIrr: 5_800_000, commissionIrr: 500_000 });

    // Sorts: by what they earned, by what their people spent, by who joined last.
    expect((await list('sort=commission')).items.map((r) => r.id)).toEqual([one.id, big.id, idle.id]);
    expect((await list('sort=bought')).items.map((r) => r.id)).toEqual([one.id, big.id, idle.id]);
    expect((await list('sort=buyers')).items.map((r) => r.id)).toEqual([big.id, one.id, idle.id]);

    // Filters narrow the rows AND the totals.
    const buyersOnly = await list('buyers=yes');
    expect(buyersOnly.items.map((r) => r.id).sort()).toEqual([big.id, one.id].sort());
    expect(buyersOnly.totals).toMatchObject({ referrers: 2, invited: 4 });
    expect((await list('buyers=no')).items.map((r) => r.id)).toEqual([idle.id]);
    expect((await list('min=2')).items.map((r) => r.id)).toEqual([big.id, idle.id]);

    // `since` drops b3 (joined 40 days ago) and re-counts big's row: 2 of 2 bought.
    const since = new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);
    const recent = await list(`since=${since}`);
    expect(byId(recent).get(big.id)).toMatchObject({ invited: 2, buyers: 2 });
    expect(recent.totals.invited).toBe(5);

    // Search by telegram id finds exactly that referrer.
    const res = await app.request(`/api/v1/admin/referrers?q=${one.telegramId}`, {}, envAs(ADMIN));
    expect(((await res.json()) as Body).items.map((r) => r.id)).toEqual([one.id]);

    // Pagination is over referrers, not referrals.
    const p2 = await list('pageSize=2&page=2');
    expect(p2.items).toHaveLength(1);
    expect(p2.total).toBe(3);

    // Nonsense is refused, not guessed.
    expect((await app.request('/api/v1/admin/referrers?sort=balance', {}, envAs(ADMIN))).status).toBe(400);
    expect((await app.request('/api/v1/admin/referrers?since=yesterday', {}, envAs(ADMIN))).status).toBe(400);
  });
});
