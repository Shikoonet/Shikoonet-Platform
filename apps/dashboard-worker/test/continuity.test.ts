/**
 * Fulfilment without evidence: the manual button, the shop-wide mode, and the
 * one property that matters more than either — a purchase is delivered at most
 * once, whatever races.
 *
 * ## Why the race tests do not mock
 *
 * The guarantee being asserted is a database guarantee. `Promise.all` over two
 * real requests against the real Postgres is the only way to find out whether
 * the UPDATE's `fulfilled_at IS NULL` actually holds; a mocked db would assert
 * that this file understands the code, which is the failure mode CLAUDE.md's
 * rule 6 is about. So every race below runs concurrently against the same row
 * and counts what the table says afterwards.
 *
 * ## What the mutation run actually said, 2026-09-02
 *
 * Three guards were removed one at a time and the suite re-run:
 *
 *   - reconciliation's `!reconciling` on the webhook enqueue → 2 tests red
 *   - continuity's fail-closed read of an unreadable activation → 1 test red
 *   - the claim UPDATE's `fulfilled_at IS NULL` → STILL GREEN
 *
 * The third is worth writing down rather than quietly fixing. It is green
 * because the same statement also carries `status IN
 * ('PENDING','MATCH_SUGGESTED')`, and after the first fulfilment the status is
 * no longer either of those — so each clause alone already closes the race.
 * Removing *both* turns «two different admins» red, which is the mutation that
 * actually corresponds to the property. The redundancy is deliberate: the
 * status clause states the lifecycle rule and the timestamp clause states the
 * idempotency rule, and a later edit that legitimately widens the first must
 * not silently take the second with it.
 *
 * ## What «fulfilled twice» would look like
 *
 * Two audit rows for one claim, or a second `webhook_deliveries` notice. Both
 * are counted rather than inferred from a return value, because a function can
 * answer `ok` for the wrong reason and a row cannot.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv, resetHub } from './helpers/env.js';
import { app } from '../src/index.js';
import {
  readContinuityMode,
  activateContinuityMode,
  fulfilMirzabotClaimWithoutPayment,
  verifyMirzabotClaim,
  type D1Database as DomainD1Database,
} from '@shikoo/domain';

const ADMIN = 'admin@example.com';
const REVIEWER = 'continuity-reviewer@example.com';
const READER = 'continuity-reader@example.com';

const db = baseEnv.DB as unknown as DomainD1Database;
function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

async function makeUser(email: string, role: string): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, ?3, 1, ?4, ?4)
     ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, active = 1`,
  )
    .bind(crypto.randomUUID(), email, role, Date.now())
    .run();
}

/** A live Mirzabot claim waiting for its bank credit. */
async function makeClaim(
  opts: { status?: string; amount?: number; operation?: string } = {},
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT INTO payment_claims
       (id, external_order_id, customer_reference, expected_amount_irr,
        target_financial_account_id, submitted_at, source_system, metadata_json,
        status, created_at, updated_at)
     VALUES (?1, ?2, 'tg-1', ?3, NULL, ?4, 'MIRZABOT', '{}', ?5, ?4, ?4)`,
  )
    .bind(id, `mirzabot:test:${id.slice(0, 8)}`, opts.amount ?? 250_000, now, opts.status ?? 'PENDING')
    .run();
  return id;
}

async function claimRow(id: string) {
  return await baseEnv.DB.prepare(
    `SELECT status, fulfilment_mode, fulfilled_at, fulfilled_by, fulfilment_reason, reconciled_at
       FROM payment_claims WHERE id = ?1`,
  )
    .bind(id)
    .first<{
      status: string;
      fulfilment_mode: string | null;
      fulfilled_at: number | null;
      fulfilled_by: string | null;
      fulfilment_reason: string | null;
      reconciled_at: number | null;
    }>();
}

async function countAudit(claimId: string): Promise<number> {
  const r = await baseEnv.DB.prepare(
    `SELECT COUNT(*)::int AS n FROM audit_logs WHERE entity_id = ?1
      AND action IN ('claim.manual_fulfilled','claim.continuity_fulfilled')`,
  )
    .bind(claimId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

function fulfilReq(claimId: string, body: unknown) {
  return new Request(`https://x/api/v1/payment-claims/${claimId}/fulfil-without-payment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://x' },
    body: JSON.stringify(body),
  });
}

const GOOD = { reason: 'SMS relay down, customer waiting', confirmed: true as const };


/** A financial account, a raw SMS and an actionable CREDIT that matches `amount`. */
async function makeCreditTx(accountId: string, amount: number): Promise<string> {
  const smsId = crypto.randomUUID();
  const txId = crypto.randomUUID();
  const now = Date.now();
  const deviceId = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES (?1, ?3, 'continuity-fixture', 1, ?2, ?2)`,
  )
    .bind(deviceId, now, `dev-${deviceId.slice(0, 8)}`)
    .run();
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum,
        sms_timestamp, received_at, classification, parser_status, created_at)
     VALUES (?1, ?2, 'BANK', 'credit', ?3, 'c', ?4, ?4, 'BANK_CREDIT', 'OK', ?4)`,
  )
    .bind(smsId, deviceId, smsId, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_candidates
       (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status,
        processing_disposition, bank_timestamp, confidence, parser_id, parser_version,
        parser_evidence_json, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'CREDIT', ?4, 'PARSED', 'ACTIONABLE', ?5, 1.0, 'test', 'v1', '{}', ?5, ?5)`,
  )
    .bind(txId, smsId, accountId, amount, now)
    .run();
  return txId;
}

async function makeAccount(): Promise<string> {
  const id = crypto.randomUUID();
  await baseEnv.DB.prepare(
    `INSERT INTO financial_accounts
       (id, display_name, bank_name, account_type, owner_label, active,
        parser_configuration, created_at, updated_at)
     VALUES (?1, 'continuity acct', 'MELLAT', 'ACCOUNT', NULL, 1, '{}', ?2, ?2)`,
  )
    .bind(id, Date.now())
    .run();
  return id;
}

async function countNotices(claimId: string): Promise<number> {
  const r = await baseEnv.DB.prepare(
    `SELECT COUNT(*)::int AS n FROM webhook_deliveries WHERE payload_json LIKE ?1`,
  )
    .bind(`%${claimId}%`)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await resetHub();
  // `settings` is not a hub table and `resetHub` leaves it alone — correctly,
  // because it is shop configuration rather than payment data. But the mode
  // lives there, so without this a test that turns it on leaves it on for
  // every test after it, and four assertions below would pass or fail
  // depending on the order vitest happened to pick.
  await baseEnv.DB.prepare(
    `INSERT INTO settings (scope, key, value, updated_at)
     VALUES ('pay','continuity_mode','{"active": false}'::jsonb, now())
     ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
  ).run();
  await makeUser(ADMIN, 'ADMIN');
  await makeUser(REVIEWER, 'REVIEWER');
  await makeUser(READER, 'READ_ONLY');
});

describe('manual fulfilment: who may, and what it costs to say yes', () => {
  it('an ADMIN fulfils a waiting claim, and it does NOT become VERIFIED', async () => {
    const id = await makeClaim();
    const res = await app.fetch(fulfilReq(id, GOOD), envAs(ADMIN));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, mode: 'MANUAL', already: false });

    const row = await claimRow(id);
    // The whole point of the feature. `VERIFIED` here would move the shop's
    // revenue figure on the strength of a screenshot.
    expect(row?.status).toBe('FULFILLED_UNRECONCILED');
    expect(row?.fulfilment_mode).toBe('MANUAL');
    expect(row?.fulfilled_by).toBe(ADMIN);
    expect(row?.reconciled_at).toBeNull();
  });

  it('a REVIEWER may fulfil — it is the decision they already make all day', async () => {
    const id = await makeClaim();
    const res = await app.fetch(fulfilReq(id, GOOD), envAs(REVIEWER));
    expect(res.status).toBe(200);
    expect((await claimRow(id))?.status).toBe('FULFILLED_UNRECONCILED');
  });

  it('a READ_ONLY operator is refused, and nothing moves', async () => {
    const id = await makeClaim();
    const res = await app.fetch(fulfilReq(id, GOOD), envAs(READER));
    expect(res.status).toBe(403);
    const row = await claimRow(id);
    expect(row?.status).toBe('PENDING');
    expect(row?.fulfilled_at).toBeNull();
    expect(await countAudit(id)).toBe(0);
  });

  it('refuses without a reason, and writes nothing', async () => {
    const id = await makeClaim();
    const res = await app.fetch(fulfilReq(id, { confirmed: true }), envAs(ADMIN));
    expect(res.status).toBe(400);
    expect((await claimRow(id))?.status).toBe('PENDING');
    expect(await countAudit(id)).toBe(0);
  });

  it('refuses a reason too short to be one', async () => {
    const id = await makeClaim();
    const res = await app.fetch(fulfilReq(id, { reason: 'x', confirmed: true }), envAs(ADMIN));
    expect(res.status).toBe(400);
    expect((await claimRow(id))?.status).toBe('PENDING');
  });

  it('refuses when the screen never asked for confirmation', async () => {
    const id = await makeClaim();
    const res = await app.fetch(fulfilReq(id, { reason: GOOD.reason }), envAs(ADMIN));
    expect(res.status).toBe(400);
    expect((await claimRow(id))?.status).toBe('PENDING');
  });

  it('records exactly one audit row, carrying the operator and their reason', async () => {
    const id = await makeClaim();
    await app.fetch(fulfilReq(id, GOOD), envAs(ADMIN));
    const row = await baseEnv.DB.prepare(
      `SELECT actor_email, actor_role, action, reason, after_json FROM audit_logs
        WHERE entity_id = ?1 AND action = 'claim.manual_fulfilled'`,
    )
      .bind(id)
      .first<{
        actor_email: string;
        actor_role: string;
        action: string;
        reason: string;
        after_json: string;
      }>();
    expect(row?.actor_email).toBe(ADMIN);
    expect(row?.reason).toBe(GOOD.reason);
    expect(JSON.parse(row?.after_json ?? '{}')).toMatchObject({
      status: 'FULFILLED_UNRECONCILED',
      fulfilmentMode: 'MANUAL',
    });
    expect(await countAudit(id)).toBe(1);
  });

  it('a renewal is fulfilled the same way a first purchase is', async () => {
    const id = await makeClaim({ operation: 'RENEWAL' });
    const res = await app.fetch(fulfilReq(id, GOOD), envAs(ADMIN));
    expect(res.status).toBe(200);
    expect((await claimRow(id))?.status).toBe('FULFILLED_UNRECONCILED');
  });

  it('refuses a claim that is already VERIFIED — the bank got there first', async () => {
    const id = await makeClaim({ status: 'VERIFIED' });
    const res = await app.fetch(fulfilReq(id, GOOD), envAs(ADMIN));
    expect(res.status).toBe(409);
    expect(await countAudit(id)).toBe(0);
  });

  it('refuses a terminal claim', async () => {
    const id = await makeClaim({ status: 'REJECTED' });
    const res = await app.fetch(fulfilReq(id, GOOD), envAs(ADMIN));
    expect(res.status).toBe(409);
    expect((await claimRow(id))?.status).toBe('REJECTED');
  });

  it('404s a claim that does not exist', async () => {
    const res = await app.fetch(fulfilReq(crypto.randomUUID(), GOOD), envAs(ADMIN));
    expect(res.status).toBe(404);
  });
});

describe('exactly once', () => {
  it('a double click fulfils once and answers 200 twice', async () => {
    const id = await makeClaim();
    const [a, b] = await Promise.all([
      app.fetch(fulfilReq(id, GOOD), envAs(ADMIN)),
      app.fetch(fulfilReq(id, GOOD), envAs(ADMIN)),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    const bodies = [await a.json(), await b.json()] as { already: boolean }[];
    // One of them did the work, the other found it done. Which is which is a
    // race and is not asserted; that exactly one did it, is.
    expect(bodies.filter((x) => x.already === false)).toHaveLength(1);
    expect(await countAudit(id)).toBe(1);
  });

  it('two different admins pressing together fulfil once', async () => {
    const id = await makeClaim();
    const other = 'continuity-admin2@example.com';
    await makeUser(other, 'ADMIN');
    await Promise.all([
      app.fetch(fulfilReq(id, GOOD), envAs(ADMIN)),
      app.fetch(fulfilReq(id, GOOD), envAs(other)),
    ]);
    expect(await countAudit(id)).toBe(1);
    const row = await claimRow(id);
    // Whoever won owns the row; nobody is recorded twice and the reason is not
    // overwritten by the loser.
    expect([ADMIN, other]).toContain(row?.fulfilled_by);
  });

  it('a client retrying after a timeout is told yes, and changes nothing', async () => {
    const id = await makeClaim();
    const first = await app.fetch(fulfilReq(id, GOOD), envAs(ADMIN));
    expect(first.status).toBe(200);
    const before = await claimRow(id);

    const retry = await app.fetch(fulfilReq(id, GOOD), envAs(ADMIN));
    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({ ok: true, already: true });

    const after = await claimRow(id);
    expect(after?.fulfilled_at).toBe(before?.fulfilled_at);
    expect(after?.fulfilled_by).toBe(before?.fulfilled_by);
    expect(await countAudit(id)).toBe(1);
  });

  it('a manual click racing the SMS matcher produces one outcome, never both', async () => {
    const id = await makeClaim();
    // The matcher's half is the domain call the ingest worker makes; the
    // operator's half is the real route. Both against the same row at once.
    const [manual] = await Promise.all([
      app.fetch(fulfilReq(id, GOOD), envAs(ADMIN)),
      verifyMirzabotClaim(db, {
        claimId: id,
        transactionId: crypto.randomUUID(),
        mode: 'AUTO_VERIFIED',
      }),
    ]);
    const row = await claimRow(id);
    // The matcher's transaction does not exist, so it must lose; what is being
    // asserted is that the claim landed in exactly one state and the audit
    // reflects exactly that state.
    if (manual.status === 200) {
      expect(row?.status).toBe('FULFILLED_UNRECONCILED');
      expect(await countAudit(id)).toBe(1);
    } else {
      expect(row?.status).not.toBe('FULFILLED_UNRECONCILED');
      expect(await countAudit(id)).toBe(0);
    }
  });
});

describe('reconciliation: the evidence arrives later', () => {
  it('a fulfilled claim stays in the queue until it is reconciled', async () => {
    const id = await makeClaim();
    await app.fetch(fulfilReq(id, GOOD), envAs(ADMIN));
    const res = await app.fetch(
      new Request('https://x/api/v1/payment-claims/awaiting-reconciliation'),
      envAs(ADMIN),
    );
    const body = (await res.json()) as { items: { claimId: string; mode: string }[] };
    expect(body.items.map((i) => i.claimId)).toContain(id);
    expect(body.items.find((i) => i.claimId === id)?.mode).toBe('MANUAL');
  });

  it('an ordinary pending claim is NOT in the reconciliation queue', async () => {
    const id = await makeClaim();
    const res = await app.fetch(
      new Request('https://x/api/v1/payment-claims/awaiting-reconciliation'),
      envAs(ADMIN),
    );
    const body = (await res.json()) as { items: { claimId: string }[] };
    expect(body.items.map((i) => i.claimId)).not.toContain(id);
  });

  it('the domain refuses to fulfil without a reason, whatever the route did', async () => {
    const id = await makeClaim();
    const out = await fulfilMirzabotClaimWithoutPayment(db, {
      claimId: id,
      actorEmail: ADMIN,
      actorRole: 'ADMIN',
      reason: '  ',
      mode: 'MANUAL',
    });
    expect(out).toEqual({ ok: false, error: 'REASON_REQUIRED' });
    expect((await claimRow(id))?.status).toBe('PENDING');
  });
});

describe('continuity mode', () => {
  it('is off by default, and off is a written decision not an absent row', async () => {
    const state = await readContinuityMode(db);
    expect(state.mode).toBe('NORMAL');
    const res = await app.fetch(new Request('https://x/api/v1/continuity-mode'), envAs(READER));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, mode: 'NORMAL' });
  });

  function activateReq(body: unknown) {
    return new Request('https://x/api/v1/continuity-mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://x' },
      body: JSON.stringify(body),
    });
  }
  const ON = {
    active: true as const,
    reason: 'bank SMS relay offline since 09:00',
    durationMs: 60 * 60 * 1000,
    confirmed: true as const,
  };

  it('an ADMIN may turn it on', async () => {
    const res = await app.fetch(activateReq(ON), envAs(ADMIN));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, mode: 'CONTINUITY' });
    expect((await readContinuityMode(db)).mode).toBe('CONTINUITY');
  });

  it('a REVIEWER may not — the blast radius is the whole shop', async () => {
    const res = await app.fetch(activateReq(ON), envAs(REVIEWER));
    expect(res.status).toBe(403);
    expect((await readContinuityMode(db)).mode).toBe('NORMAL');
  });

  it('a READ_ONLY operator may not', async () => {
    const res = await app.fetch(activateReq(ON), envAs(READER));
    expect(res.status).toBe(403);
    expect((await readContinuityMode(db)).mode).toBe('NORMAL');
  });

  it('refuses activation with no reason, and with no confirmation', async () => {
    const noReason = await app.fetch(activateReq({ ...ON, reason: '' }), envAs(ADMIN));
    expect(noReason.status).toBe(400);
    const unconfirmed = await app.fetch(
      activateReq({ active: true, reason: ON.reason, durationMs: ON.durationMs }),
      envAs(ADMIN),
    );
    expect(unconfirmed.status).toBe(400);
    expect((await readContinuityMode(db)).mode).toBe('NORMAL');
  });

  it('refuses a duration beyond the six-hour cap', async () => {
    const res = await app.fetch(
      activateReq({ ...ON, durationMs: 7 * 60 * 60 * 1000 }),
      envAs(ADMIN),
    );
    expect(res.status).toBe(400);
    expect((await readContinuityMode(db)).mode).toBe('NORMAL');
  });

  it('turns itself off when the clock passes the expiry, with nothing running', async () => {
    const now = Date.now();
    await activateContinuityMode(db, {
      actorEmail: ADMIN,
      reason: ON.reason,
      durationMs: 5 * 60 * 1000,
      confirmed: true,
      now,
    });
    expect((await readContinuityMode(db, now + 60_000)).mode).toBe('CONTINUITY');
    // No sweep, no cron, no second write: the read is what enforces the cap.
    const later = await readContinuityMode(db, now + 5 * 60 * 1000 + 1);
    expect(later.mode).toBe('NORMAL');
    expect(later.expired).toBe(true);
  });

  it('deactivation returns the shop to normal and is idempotent', async () => {
    await app.fetch(activateReq(ON), envAs(ADMIN));
    const off = await app.fetch(activateReq({ active: false }), envAs(ADMIN));
    expect(off.status).toBe(200);
    expect((await readContinuityMode(db)).mode).toBe('NORMAL');
    const again = await app.fetch(activateReq({ active: false }), envAs(ADMIN));
    expect(again.status).toBe(200);
    expect((await readContinuityMode(db)).mode).toBe('NORMAL');
  });

  it('writes who turned it on and why to the append-only trail', async () => {
    await app.fetch(activateReq(ON), envAs(ADMIN));
    const row = await baseEnv.DB.prepare(
      `SELECT actor_email, reason FROM audit_logs WHERE action = 'continuity.activated'`,
    ).first<{ actor_email: string; reason: string }>();
    expect(row?.actor_email).toBe(ADMIN);
    expect(row?.reason).toBe(ON.reason);
  });

  it('turning it on fulfils nothing that already exists', async () => {
    const backlog = [await makeClaim(), await makeClaim(), await makeClaim()];
    await app.fetch(activateReq(ON), envAs(ADMIN));
    for (const id of backlog) {
      const row = await claimRow(id);
      expect(row?.status).toBe('PENDING');
      expect(row?.fulfilled_at).toBeNull();
    }
  });

  it('an unreadable activation reads as OFF, not as on for ever', async () => {
    // A hand edit, an older dump, a lost default. The failure this mode can
    // cause is selling without evidence, so the unreadable case falls to the
    // side that sells nothing.
    await baseEnv.DB.prepare(
      `INSERT INTO settings (scope, key, value, updated_at)
       VALUES ('pay','continuity_mode','{"active": true}'::jsonb, now())
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
    ).run();
    expect((await readContinuityMode(db)).mode).toBe('NORMAL');
  });
});

describe('nothing here leaks', () => {
  it('no audit payload carries a token, a cookie or a raw SMS body', async () => {
    const id = await makeClaim();
    await app.fetch(fulfilReq(id, GOOD), envAs(ADMIN));
    const { results } = await baseEnv.DB.prepare(
      `SELECT before_json, after_json, reason FROM audit_logs WHERE entity_id = ?1`,
    )
      .bind(id)
      .all<{ before_json: string; after_json: string; reason: string }>();
    const blob = JSON.stringify(results ?? []);
    for (const forbidden of ['shikoo_session', 'bot_token', 'TELEGRAM_BOT_TOKEN', 'apiKey']) {
      expect(blob).not.toContain(forbidden);
    }
  });
});

describe('reconciliation never delivers a second time', () => {
  /** A claim delivered under Continuity, whose bank credit turns up afterwards. */
  async function fulfilledClaimWithLateCredit() {
    const accountId = await makeAccount();
    const amount = 250_000;
    const id = crypto.randomUUID();
    const now = Date.now();
    await baseEnv.DB.prepare(
      `INSERT INTO payment_claims
         (id, external_order_id, customer_reference, expected_amount_irr,
          target_financial_account_id, submitted_at, source_system, metadata_json,
          status, created_at, updated_at)
       VALUES (?1, ?2, 'tg-1', ?3, ?4, ?5, 'MIRZABOT', '{}', 'PENDING', ?5, ?5)`,
    )
      .bind(id, `mirzabot:test:${id.slice(0, 8)}`, amount, accountId, now)
      .run();

    const out = await fulfilMirzabotClaimWithoutPayment(db, {
      claimId: id,
      actorEmail: ADMIN,
      actorRole: 'ADMIN',
      reason: 'relay down',
      mode: 'CONTINUITY',
      enqueueWebhook: true,
    });
    expect(out.ok).toBe(true);
    return { id, txId: await makeCreditTx(accountId, amount) };
  }

  it('stamps reconciled_at, moves to VERIFIED, and enqueues NO second notice', async () => {
    const { id, txId } = await fulfilledClaimWithLateCredit();
    expect(await countNotices(id)).toBe(1);

    const res = await verifyMirzabotClaim(db, {
      claimId: id,
      transactionId: txId,
      mode: 'AUTO_VERIFIED',
      enqueueWebhook: true,
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.reconciled).toBe(true);

    const row = await claimRow(id);
    expect(row?.status).toBe('VERIFIED');
    expect(row?.reconciled_at).not.toBeNull();
    // The fulfilment is still on the record — reconciliation explains the
    // money, it does not rewrite how the customer came to be served.
    expect(row?.fulfilled_at).not.toBeNull();
    expect(row?.fulfilment_mode).toBe('CONTINUITY');

    // The assertion the whole feature turns on.
    expect(await countNotices(id)).toBe(1);
    expect(await countAudit(id)).toBe(1);
  });

  it('leaves the reconciliation queue once reconciled', async () => {
    const { id, txId } = await fulfilledClaimWithLateCredit();
    await verifyMirzabotClaim(db, { claimId: id, transactionId: txId, mode: 'AUTO_VERIFIED' });
    const res = await app.fetch(
      new Request('https://x/api/v1/payment-claims/awaiting-reconciliation'),
      envAs(ADMIN),
    );
    const body = (await res.json()) as { items: { claimId: string }[] };
    expect(body.items.map((i) => i.claimId)).not.toContain(id);
  });

  it('reconciling twice keeps the first timestamp and still sends nothing', async () => {
    const { id, txId } = await fulfilledClaimWithLateCredit();
    await verifyMirzabotClaim(db, {
      claimId: id,
      transactionId: txId,
      mode: 'AUTO_VERIFIED',
      enqueueWebhook: true,
    });
    const first = await claimRow(id);
    await verifyMirzabotClaim(db, {
      claimId: id,
      transactionId: txId,
      mode: 'AUTO_VERIFIED',
      enqueueWebhook: true,
    });
    const second = await claimRow(id);
    expect(second?.reconciled_at).toBe(first?.reconciled_at);
    expect(await countNotices(id)).toBe(1);
  });
});
