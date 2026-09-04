/**
 * What went out from «ارسال گروهی» last, and why the screen has to say it.
 *
 * The idempotency key `bulk:<batch>:<user>` stops one submission being applied
 * twice, and `bulk.test.ts` proves that. It cannot stop a second decision: a
 * fresh batch id is a new, legitimate charge, and the route is right to apply
 * it. An outside review in August 2026 called the double-charge a broken key;
 * it was not. What was actually missing had no guard at all — an operator who
 * cannot see that everyone was credited twenty minutes ago, and credits them
 * again by hand.
 *
 * Read out of `audit_logs`, which is append-only, so this cannot report a send
 * that did not happen or miss one that did.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv, deleteFixtureUsers } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'bulk-recent-admin@example.com';
const READER = 'bulk-recent-reader@example.com';
/**
 * This suite's own range, and it must not be anybody else's.
 *
 * It was 993,000,000 — the same base `bulk.test.ts` uses — so bounding the
 * cleanup to a million ids isolated both of them from everybody except each
 * other. Found by CodeRabbit on PR #93, which is what a second reader is for.
 * 992,000,000–992,999,999 sits between `customers.test.ts` and `bulk.test.ts`
 * and touches neither.
 */
const TG_BASE = 992_000_000;

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

let seq = 0;
async function makeCustomer(): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, status, registered_at)
     VALUES (?1, ?2, 'ACTIVE', now())`,
  )
    .bind(TG_BASE + ++seq, `recent-${seq}`)
    .run();
}

function uuid(): string {
  return crypto.randomUUID();
}

async function recent(as = ADMIN) {
  const res = await app.fetch(
    new Request('https://example.com/api/v1/admin/bulk/recent'),
    envAs(as),
  );
  return {
    status: res.status,
    body: (await res.json()) as {
      credit: { by: string; at: number; count: number; amountIrr: number | null } | null;
      broadcast: { by: string; at: number; count: number; amountIrr: number | null } | null;
    },
  };
}

async function credit(amountIrr: number, batchId: string) {
  return app.fetch(
    new Request('https://example.com/api/v1/admin/bulk/credit', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: JSON.stringify({ amountIrr, batchId }),
    }),
    envAs(ADMIN),
  );
}

beforeAll(applySchema);

beforeEach(async () => {
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [READER, 'READ_ONLY'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)
       ON CONFLICT (email) DO UPDATE SET role = excluded.role, active = 1`,
    )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }
  // `audit_logs` is deliberately not cleared here, and cannot be: the
  // append-only trigger refuses a DELETE, which is the invariant doing its job.
  // The first draft of this file tried, and the error it got is the reason
  // there is no "nothing has ever been sent" case below — a test cannot
  // manufacture an empty log, and the route's null branch is covered by
  // `bulk.test.ts` running against a database where no send has happened.
  //
  // Every assertion here is therefore about the NEWEST row, which is what the
  // route returns and what the screen shows.
  await baseEnv.DB.prepare(`TRUNCATE wallet_entries, wallets RESTART IDENTITY CASCADE`).run();
  await baseEnv.DB.prepare(`TRUNCATE broadcast_recipients, broadcasts CASCADE`).run();
  await deleteFixtureUsers(TG_BASE);
});

describe('the last send, so nobody repeats it by hand', () => {
  it('answers at all, with the shape the screen reads', async () => {
    const { status, body } = await recent();
    expect(status).toBe(200);
    // Null rather than a zeroed shape when there is nothing: "never" and
    // "nobody was reached" are different sentences and the screen draws
    // nothing for the first.
    expect(body.credit === null || typeof body.credit.by === 'string').toBe(true);
    expect(body.broadcast === null || typeof body.broadcast.by === 'string').toBe(true);
  });

  it('names the amount, the reach and the operator after a credit', async () => {
    await makeCustomer();
    await makeCustomer();
    const before = Date.now();
    expect((await credit(50_000, uuid())).status).toBe(200);

    const { body } = await recent();
    expect(body.credit?.by).toBe(ADMIN);
    expect(body.credit?.amountIrr).toBe(50_000);
    // The number of wallets actually written, checked against the ledger rather
    // than against the response that reported it.
    const rows = await baseEnv.DB.prepare(
      `SELECT count(*)::int AS n FROM wallet_entries WHERE idempotency_key LIKE 'bulk:%'`,
    ).first<{ n: number }>();
    expect(rows?.n).toBeGreaterThan(0);
    expect(body.credit?.count).toBe(rows?.n);
    expect(body.credit?.at).toBeGreaterThanOrEqual(before);
  });

  it('reports the newest send, not the first one', async () => {
    await makeCustomer();
    await credit(10_000, uuid());
    await credit(70_000, uuid());

    const { body } = await recent();
    // The whole point: an operator about to credit everyone needs the charge
    // that happened most recently, not the one that happened first.
    expect(body.credit?.amountIrr).toBe(70_000);
  });

  it('reports a retry as zero rather than hiding it', async () => {
    await makeCustomer();
    const batchId = uuid();
    await credit(50_000, batchId);
    await credit(50_000, batchId);

    const { body } = await recent();
    // 0 is the honest answer and is worth showing: it says the second press was
    // caught, which is different from the send having failed.
    expect(body.credit?.count).toBe(0);
  });

  it('keeps a credit and a broadcast apart', async () => {
    await makeCustomer();
    await credit(50_000, uuid());
    await app.fetch(
      new Request('https://example.com/api/v1/admin/bulk/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://example.com' },
        body: JSON.stringify({ body: 'سلام', broadcastId: uuid() }),
      }),
      envAs(ADMIN),
    );

    const { body } = await recent();
    expect(body.credit?.amountIrr).toBe(50_000);
    // A broadcast has no amount, and inventing a zero for it would read on the
    // screen as "everyone was sent nothing".
    expect(body.broadcast?.amountIrr).toBeNull();
    expect(body.broadcast?.count).toBeGreaterThan(0);
  });

  it('is readable by an operator who cannot send', async () => {
    await makeCustomer();
    await credit(50_000, uuid());
    // Deliberate. Seeing that a charge went out is not the power to make one,
    // and a reviewer who cannot see it is the person most likely to ask an
    // admin to send it a second time.
    const { status, body } = await recent(READER);
    expect(status).toBe(200);
    expect(body.credit?.amountIrr).toBe(50_000);
  });
});
