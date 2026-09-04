/**
 * Continuity mode at the boundary where it actually fires.
 *
 * `continuity.test.ts` in the dashboard covers the switch and the domain
 * function. Neither of them is the feature: the feature is
 * `handleMirzabotClaim` deciding, for a claim arriving right now, whether to
 * deliver it without waiting for a bank credit. That decision had no test at
 * all, which on a money route means the OFF case was resting on nothing.
 *
 * These drive the real signed HTTP endpoint, so the mode is read by the same
 * code path production runs, and every assertion is made against the row the
 * database ended up holding rather than against a return value.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema, env } from './helpers/env.js';
import { app } from '../src/index.js';
import { runMirzabotMatching } from '../src/integrations/mirzabot.js';
import { MIRZABOT_CLAIMS_PATH } from '@shikoo/contracts';

const SECRET = 'test-hmac-secret-32chars-minimum!!';
const INTEGRATION_ID = 'mirzabot-test';
const BASE_MS = 1_786_091_200_000;

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function submitClaim(
  over: Record<string, unknown> = {},
  envOver: Record<string, string> = {},
): Promise<Response> {
  const body = {
    eventId: `evt-${crypto.randomUUID()}`,
    source: 'MIRZABOT',
    orderId: `ord-${crypto.randomUUID().slice(0, 8)}`,
    telegramUserId: '12345',
    telegramUsername: 'testuser',
    amountToman: 100_000,
    expectedAmountIrr: 1_000_000,
    cardNumber: '6037-9975-1234-5678',
    paidClickedAt: BASE_MS,
    receiptSubmittedAt: BASE_MS + 5000,
    receipt: { telegramFileUniqueId: 'file-abc' },
    ...over,
  };
  const rawBody = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000).toString();
  const signature = `sha256=${await hmacSha256Hex(
    SECRET,
    `${ts}\nPOST\n${MIRZABOT_CLAIMS_PATH}\n${await sha256Hex(rawBody)}`,
  )}`;
  return app.fetch(
    new Request(`https://example.com${MIRZABOT_CLAIMS_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Integration-Id': INTEGRATION_ID,
        'X-Event-Id': String(body.eventId),
        'X-Timestamp': ts,
        'X-Signature': signature,
      },
      body: rawBody,
    }),
    {
      ...env,
      MIRZABOT_INTEGRATION_ENABLED: 'true',
      MIRZABOT_INTEGRATION_HMAC_SECRET: SECRET,
      MIRZABOT_INTEGRATION_ID: INTEGRATION_ID,
      AUTO_MATCH_ENABLED: 'true',
      ...envOver,
    },
  );
}

async function setContinuity(active: boolean, expiresAt?: number): Promise<void> {
  const value = active
    ? JSON.stringify({
        active: true,
        expiresAt: expiresAt ?? Date.now() + 60 * 60 * 1000,
        activatedAt: Date.now(),
        activatedBy: 'op@example.com',
        reason: 'relay down',
      })
    : JSON.stringify({ active: false });
  await env.DB.prepare(
    `INSERT INTO settings (scope, key, value, updated_at)
     VALUES ('pay','continuity_mode', ?1::jsonb, now())
     ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
  )
    .bind(value)
    .run();
}

async function claimFor(orderId: string) {
  return await env.DB.prepare(
    `SELECT status, fulfilment_mode, fulfilled_at, fulfilled_by, fulfilment_reason, reconciled_at
       FROM payment_claims WHERE external_order_id LIKE ?1`,
  )
    .bind(`%${orderId}%`)
    .first<{
      status: string;
      fulfilment_mode: string | null;
      fulfilled_at: number | null;
      fulfilled_by: string | null;
      fulfilment_reason: string | null;
      reconciled_at: number | null;
    }>();
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await env.DB.prepare(
    `DELETE FROM settings WHERE scope = 'pay' AND key = 'continuity_mode'`,
  ).run();
  await env.DB.prepare(`DELETE FROM webhook_deliveries`).run();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a claim arriving while the shop is in NORMAL mode', () => {
  it('is not fulfilled — with no row at all, which is the real production default', async () => {
    // The seeded row is deleted in beforeEach on purpose. «No row» is what a
    // database that has never had 0043's INSERT run looks like, and it must
    // read as OFF rather than as unset-therefore-permissive.
    const orderId = `ord-${crypto.randomUUID().slice(0, 8)}`;
    const res = await submitClaim({ orderId });
    expect(res.status).toBe(200);

    const claim = await claimFor(orderId);
    expect(claim).toBeTruthy();
    expect(claim?.status).not.toBe('FULFILLED_UNRECONCILED');
    expect(claim?.fulfilled_at).toBeNull();
    expect(claim?.fulfilment_mode).toBeNull();
  });

  it('is not fulfilled when the mode is explicitly off', async () => {
    await setContinuity(false);
    const orderId = `ord-${crypto.randomUUID().slice(0, 8)}`;
    expect((await submitClaim({ orderId })).status).toBe(200);

    const claim = await claimFor(orderId);
    expect(claim?.fulfilled_at).toBeNull();
    expect(claim?.status).not.toBe('FULFILLED_UNRECONCILED');
  });

  it('is not fulfilled when the activation has expired', async () => {
    // Expiry is applied by the READ, so a mode nobody turned off still has to
    // stop delivering. No sweep runs here — that is the point.
    await setContinuity(true, Date.now() - 1000);
    const orderId = `ord-${crypto.randomUUID().slice(0, 8)}`;
    expect((await submitClaim({ orderId })).status).toBe(200);
    expect((await claimFor(orderId))?.fulfilled_at).toBeNull();
  });

  it('is not fulfilled when the stored row is unreadable', async () => {
    // active:true with no expiry — a hand edit, an older dump, a lost default.
    await env.DB.prepare(
      `INSERT INTO settings (scope, key, value, updated_at)
       VALUES ('pay','continuity_mode','{"active": true}'::jsonb, now())
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
    ).run();
    const orderId = `ord-${crypto.randomUUID().slice(0, 8)}`;
    expect((await submitClaim({ orderId })).status).toBe(200);
    expect((await claimFor(orderId))?.fulfilled_at).toBeNull();
  });
});

describe('a claim arriving while Continuity is on', () => {
  it('is delivered, recorded as CONTINUITY, and never called VERIFIED', async () => {
    await setContinuity(true);
    const orderId = `ord-${crypto.randomUUID().slice(0, 8)}`;
    expect((await submitClaim({ orderId })).status).toBe(200);

    const claim = await claimFor(orderId);
    expect(claim?.status).toBe('FULFILLED_UNRECONCILED');
    expect(claim?.fulfilment_mode).toBe('CONTINUITY');
    expect(claim?.fulfilled_at).not.toBeNull();
    expect(claim?.fulfilled_by).toBe('op@example.com');
    expect(claim?.fulfilment_reason).toBe('relay down');
  });

  it('writes exactly one audit row, attributed to whoever turned the mode on', async () => {
    await setContinuity(true);
    const orderId = `ord-${crypto.randomUUID().slice(0, 8)}`;
    await submitClaim({ orderId });
    const claim = await env.DB.prepare(
      `SELECT id FROM payment_claims WHERE external_order_id LIKE ?1`,
    )
      .bind(`%${orderId}%`)
      .first<{ id: string }>();

    const rows = await env.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM audit_logs
        WHERE entity_id = ?1 AND action = 'claim.continuity_fulfilled'`,
    )
      .bind(claim!.id)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it('notifies the legacy bot before the claim request returns', async () => {
    await setContinuity(true);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    const orderId = `ord-${crypto.randomUUID().slice(0, 8)}`;

    const res = await submitClaim(
      { orderId },
      {
        AUTO_FULFILLMENT_ENABLED: 'true',
        MIRZABOT_WEBHOOK_URL: 'https://legacy.example.com/api/v1/integrations/payment-hub/verified',
      },
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ continuityFulfilled: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const delivery = await env.DB
      .prepare(
        `SELECT w.status, w.attempt_count
           FROM webhook_deliveries w
           JOIN payment_claims c ON w.id = 'fulfilled-' || c.id
          WHERE c.external_order_id LIKE ?1`,
      )
      .bind(`%${orderId}%`)
      .first<{ status: string; attempt_count: number }>();
    expect(delivery).toEqual({ status: 'DELIVERED', attempt_count: 1 });
  });

  it('reconciles the delivered claim when its bank credit arrives later', async () => {
    await setContinuity(true);
    const suffix = crypto.randomUUID().slice(0, 8);
    const accountId = `acc-cont-${suffix}`;
    const cardDigits = `60379975${[...suffix].map((c) => parseInt(c, 16) % 10).join('')}`;
    await env.DB.prepare(
      `INSERT INTO financial_accounts
         (id, bank_name, display_name, owner_label, account_type, active,
          status, parser_configuration, created_at, updated_at)
       VALUES (?1, 'TEST', 'Continuity account', NULL, 'CARD', 1,
               'ACTIVE', '{}', ?2, ?2)`,
    )
      .bind(accountId, BASE_MS)
      .run();
    await env.DB.prepare(
      `INSERT INTO payment_cards
         (id, financial_account_id, card_digits, label, created_at)
       VALUES (?1, ?2, ?3, 'Continuity card', ?4)`,
    )
      .bind(`card-cont-${suffix}`, accountId, cardDigits, BASE_MS)
      .run();
    const orderId = `ord-${crypto.randomUUID().slice(0, 8)}`;
    const amountToman = 123_457;
    const amountIrr = amountToman * 10;
    expect(
      (
        await submitClaim({
          orderId,
          amountToman,
          expectedAmountIrr: amountIrr,
          cardNumber: cardDigits,
        })
      ).status,
    ).toBe(200);
    expect((await claimFor(orderId))?.status).toBe('FULFILLED_UNRECONCILED');

    const claim = await env.DB
      .prepare(
        `SELECT id, target_financial_account_id, paid_clicked_at
           FROM payment_claims WHERE external_order_id LIKE ?1`,
      )
      .bind(`%${orderId}%`)
      .first<{
        id: string;
        target_financial_account_id: string;
        paid_clicked_at: number;
      }>();
    expect(claim?.target_financial_account_id).toBeTruthy();

    const deviceId = `dev-cont-${suffix}`;
    const smsId = `sms-cont-${suffix}`;
    const txId = `tx-cont-${suffix}`;
    await env.DB.prepare(
      `INSERT INTO devices
         (id, device_code, display_name, active, created_at, updated_at)
       VALUES (?1, ?2, 'Continuity test', 1, ?3, ?3)`,
    )
      .bind(deviceId, deviceId, BASE_MS)
      .run();
    await env.DB.prepare(
      `INSERT INTO raw_sms_events
         (id, device_id, sender, normalized_body, body_sha256, app_checksum,
          sms_timestamp, received_at, classification, parser_status,
          parser_id, parser_version, created_at)
       VALUES (?1, ?2, 'TEST', 'seed', ?3, ?3, ?4, ?4,
               'BANK_CREDIT', 'OK', 'test', 'v1', ?4)`,
    )
      .bind(smsId, deviceId, `hash-${suffix}`, claim!.paid_clicked_at + 20_000)
      .run();
    await env.DB.prepare(
      `INSERT INTO transaction_candidates
         (id, raw_sms_event_id, financial_account_id, direction, amount_irr,
          status, bank_timestamp, confidence, parser_id, parser_version,
          parser_evidence_json, processing_disposition, created_at, updated_at)
       VALUES (?1, ?2, ?3, 'CREDIT', ?4, 'PARSED', ?5, 1.0,
               'test', 'v1', '{}', 'ACTIONABLE', ?5, ?5)`,
    )
      .bind(
        txId,
        smsId,
        claim!.target_financial_account_id,
        amountIrr,
        claim!.paid_clicked_at + 20_000,
      )
      .run();

    const matched = await runMirzabotMatching(
      env.DB,
      { accountId: claim!.target_financial_account_id, amountIrr },
      { autoMatchEnabled: true, now: claim!.paid_clicked_at + 30_000 },
    );

    expect(matched.autoVerifiedClaimIds).toEqual([claim!.id]);
    const after = await claimFor(orderId);
    expect(after?.status).toBe('VERIFIED');
    expect(after?.reconciled_at).not.toBeNull();
  });

  it('does not touch the backlog that was already waiting', async () => {
    // Turning the mode on delivers nothing retroactively. The claim opened
    // BEFORE the switch stays exactly where it was.
    const before = `ord-${crypto.randomUUID().slice(0, 8)}`;
    await submitClaim({ orderId: before });
    const beforeRow = await claimFor(before);
    expect(beforeRow?.fulfilled_at).toBeNull();

    await setContinuity(true);
    const after = `ord-${crypto.randomUUID().slice(0, 8)}`;
    await submitClaim({ orderId: after });

    // The new one is delivered; the old one is untouched.
    expect((await claimFor(after))?.status).toBe('FULFILLED_UNRECONCILED');
    const stillWaiting = await claimFor(before);
    expect(stillWaiting?.fulfilled_at).toBeNull();
    expect(stillWaiting?.status).toBe(beforeRow?.status);
  });

  it('an existing claim re-submitted while the mode is on is still NOT fulfilled', async () => {
    /*
     * The case `isNewClaim` actually guards, and the one the previous version of
     * this file missed.
     *
     * The bot re-posts a claim for an order it has already opened — a new
     * eventId, the same orderId — and `handleMirzabotClaim` takes the
     * `existingClaim` branch and UPDATES the row rather than inserting one. If
     * the Continuity hook did not ask whether the claim was new, that ordinary
     * re-post would deliver a backlog claim the operator never decided about,
     * simply because a switch was flipped after it arrived.
     *
     * Dropping `isNewClaim` leaves every other test in this file green. This is
     * the one that turns red.
     */
    const orderId = `ord-${crypto.randomUUID().slice(0, 8)}`;
    expect((await submitClaim({ orderId })).status).toBe(200);
    const before = await claimFor(orderId);
    expect(before?.fulfilled_at).toBeNull();

    await setContinuity(true);

    // Same order, different event: the update path, not the insert path.
    expect((await submitClaim({ orderId })).status).toBe(200);

    const after = await claimFor(orderId);
    expect(after?.fulfilled_at).toBeNull();
    expect(after?.fulfilment_mode).toBeNull();
    expect(after?.status).not.toBe('FULFILLED_UNRECONCILED');
  });

  it('a replayed event does not fulfil the same order a second time', async () => {
    await setContinuity(true);
    const orderId = `ord-${crypto.randomUUID().slice(0, 8)}`;
    const eventId = `evt-${crypto.randomUUID()}`;
    await submitClaim({ orderId, eventId });
    const first = await claimFor(orderId);
    expect(first?.status).toBe('FULFILLED_UNRECONCILED');

    await submitClaim({ orderId, eventId });

    const second = await claimFor(orderId);
    expect(second?.fulfilled_at).toBe(first?.fulfilled_at);
    const claim = await env.DB.prepare(
      `SELECT id FROM payment_claims WHERE external_order_id LIKE ?1`,
    )
      .bind(`%${orderId}%`)
      .first<{ id: string }>();
    const audits = await env.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM audit_logs
        WHERE entity_id = ?1 AND action = 'claim.continuity_fulfilled'`,
    )
      .bind(claim!.id)
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });
});
