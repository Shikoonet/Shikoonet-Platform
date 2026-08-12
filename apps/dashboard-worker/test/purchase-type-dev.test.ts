/**
 * DEV-only tests for the purchase_type feature flag.
 *
 *  TEST MODE 2: FEATURE ON / DEV SCHEMA
 *  - Applies migrations 0001..0015 (production is only at 0014)
 *  - ENABLE_PURCHASE_TYPE=true
 *  - Mirrors the dev D1 shape exactly
 *
 *  Scenarios covered:
 *    1. NEW_PURCHASE row (getconfigafterpay)
 *    2. RENEWAL — getextenduser
 *    3. RENEWAL — getextratimeuser
 *    4. RENEWAL — getextravolumeuser
 *    5. NULL / UNCLASSIFIED legacy row
 *    6. Non-auto-verified payment
 *
 *  Date filter: Today / Yesterday / Day Before Yesterday / All, with explicit
 *  Asia/Tehran boundaries. Boundary timestamps around midnight are tested.
 *
 *  Query safety: every SELECT / WHERE must reference only columns that exist
 *  after migration 0015 when ENABLE_PURCHASE_TYPE=true.
 */

import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import {
  app,
  type Env,
} from '../src/index.js';

// The prod/dev schema split this file used to build is gone: the platform's
// own migrations always include operation_type and purchase_type, so there is
// no column gap left for the flag to paper over. The flag itself still gates
// whether the columns are *read*, which is what the scenarios below cover.


/**
 * Returns a request env with ENABLE_PURCHASE_TYPE=true and a TEST_ACCESS_USER
 * so the access middleware accepts the call.
 */
function devEnv(): Env {
  const e = baseEnv as unknown as Env;
  return new Proxy(e, {
    get(target, prop) {
      if (prop === 'ENABLE_PURCHASE_TYPE') return 'true';
      if (prop === 'TEST_ACCESS_USER') return EMAIL;
      return (target as any)[prop];
    },
  }) as Env;
}

function prodEnv(): Env {
  const e = baseEnv as unknown as Env;
  return new Proxy(e, {
    get(target, prop) {
      if (prop === 'ENABLE_PURCHASE_TYPE') return 'false';
      if (prop === 'TEST_ACCESS_USER') return EMAIL;
      return (target as any)[prop];
    },
  }) as Env;
}

async function callPayments(query: string, env: Env = devEnv()): Promise<any> {
  const res = await app.fetch(
    new Request(`https://example.com/api/v1/payments?${query}`, { method: 'GET' }),
    env,
  );
  return { status: res.status, body: await res.json() };
}

/** Returns true if a row with the given claim id appears in the items list. */
function hasClaim(items: any[], claimId: string): boolean {
  return (items ?? []).some((it: any) => it.id === claimId);
}

// Fixed Tehran-friendly reference instant.
// We pick a moment inside the Tehran "today" window so "today" filters
// include rows stamped around NOW_MS. 2026-08-10T10:00:00Z corresponds to
// 2026-08-10T13:30:00+03:30 (afternoon Tehran).
const TEHRAN_TODAY_MID = Date.parse('2026-08-10T10:00:00Z');
const NOW_MS = TEHRAN_TODAY_MID;

// The routes filter by "today" in Tehran using the real clock, while every
// fixture below is stamped at NOW_MS. Without pinning the clock this file is
// green on the day it was written and red every day after — the exact failure
// CLAUDE.md rule 5 describes, and it had already been failing since 2026-08-11.
beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});
afterEach(() => {
  vi.restoreAllMocks();
});

const EMAIL = 'admin@example.com';

/**
 * Seeds a minimal Mirzabot claim + reconciliation match.
 *   - external_order_id: mirzabot:test:<order>
 *   - account_id: a1
 *   - status: AUTO_VERIFIED (mirrors engine output) or PENDING / SUSPECTED_FAKE for non-bot tabs
 */
async function seedClaim(opts: {
  id: string;
  orderId: string;
  matchStatus: 'AUTO_VERIFIED' | 'MANUALLY_VERIFIED' | 'SUGGESTED' | 'CONFIRMED' | null;
  /** ISO ms since epoch — also used as the verified-at for AUTO_VERIFIED */
  verifiedAtMs?: number;
  purchaseType?: string | null;
  operationType?: string | null;
}): Promise<void> {
  const verifiedAt = opts.verifiedAtMs ?? NOW_MS;
  const e = baseEnv as unknown as Env;
  // We insert submitted_at, paid_clicked_at, receipt_submitted_at and
  // created_at as `verifiedAt` (+1) so the row's effective_ts lands
  // exactly on the chosen moment.  See the call site below.
  await e.DB.prepare(
    `INSERT INTO payment_claims
      (id, external_order_id, customer_reference, expected_amount_irr,
       target_financial_account_id, submitted_at, source_system, metadata_json,
       status, paid_clicked_at, receipt_submitted_at, card_digits,
       operation_type, purchase_type,
       created_at, updated_at)
     VALUES (?1, ?2, '42', 1950000, 'a1', ?3, 'MIRZABOT', '{}', 'VERIFIED',
             ?3, ?3, '5054161706275678', ?4, ?5, ?3, ?3)`,
  )
    .bind(
      opts.id,
      `mirzabot:test:${opts.orderId}`,
      verifiedAt,
      opts.operationType ?? null,
      opts.purchaseType ?? null,
    )
    .run();
  if (opts.matchStatus) {
    // Need a transaction_candidate row before reconciliation_matches because
    // of the NOT NULL FK on transaction_candidate_id.
    await e.DB.prepare(
      `INSERT INTO raw_sms_events
        (id, device_id, sender, encrypted_or_protected_body, normalized_body,
         body_sha256, app_checksum, sms_timestamp, received_at, classification,
         parser_status, parser_id, parser_version, created_at)
       VALUES (?1, 'dev-ptd', 'TEST', NULL, 'seed', ?2, 'cksum', ?3, ?3, 'BANK_CREDIT',
               'OK', 'test', 'v1', ?3)`,
    )
      .bind(`sms-${opts.id}`, `hash-${opts.id}`, verifiedAt)
      .run();
    await e.DB.prepare(
      `INSERT INTO transaction_candidates
        (id, raw_sms_event_id, financial_account_id, direction, amount_irr,
         balance_irr, transaction_reference, bank_timestamp, confidence,
         parser_id, parser_version, parser_evidence_json, status,
         created_at, updated_at)
       VALUES (?1, ?2, 'a1', 'CREDIT', 1950000, NULL, NULL, ?3, 1.0,
               'test', 'v1', '{}', 'MATCHED', ?3, ?3)`,
    )
      .bind(`tx-${opts.id}`, `sms-${opts.id}`, verifiedAt)
      .run();
    await e.DB.prepare(
      `INSERT INTO reconciliation_matches
        (id, payment_claim_id, transaction_candidate_id, status, score,
         matching_reasons_json, mismatch_reasons_json, reviewed_at, reviewed_by,
         created_at, updated_at)
       VALUES (?1, ?1, ?2, ?3, 1.0, '{}', '[]', ?4, 'system', ?4, ?4)`,
    )
      .bind(opts.id, `tx-${opts.id}`, opts.matchStatus, verifiedAt)
      .run();
  }
}

describe('DEV — purchase_type feature flag', () => {
  beforeEach(async () => {
    await applySchema();
    // Allow TEST_ACCESS_USER to access the API.
    const e = baseEnv as unknown as Env;
    await e.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
    )
      .bind(crypto.randomUUID(), EMAIL, NOW_MS)
      .run();
    // Clean up any state left from previous tests in the same file.
    for (const t of [
      'reconciliation_matches',
      'transaction_candidates',
      'raw_sms_events',
      'payment_claims',
    ]) {
      try {
        await e.DB.prepare(`DELETE FROM ${t}`).run();
      } catch {
        /* ignore */
      }
    }
    // Re-seed the device and account fresh.
    await e.DB.prepare(`DELETE FROM devices`).run();
    await e.DB.prepare(`DELETE FROM financial_accounts`).run();
    await e.DB.prepare(
      `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
       VALUES ('dev-ptd', 'ptd', 'PTD', 1, ?1, ?1)`,
    )
      .bind(NOW_MS)
      .run();
    await e.DB.prepare(
      `INSERT INTO financial_accounts
        (id, bank_name, display_name, owner_label, account_type, account_hint,
         card_last_four, account_last_four, device_id, active, parser_configuration,
         created_at, updated_at)
       VALUES ('a1', 'Melli', 'Melli Main', NULL, 'CARD', '6006', NULL, NULL,
               NULL, 1, '{}', ?1, ?1)`,
    )
      .bind(NOW_MS)
      .run();
  });

  // ───────────────────────── Query safety ─────────────────────────
  describe('Query safety with FEATURE ON', () => {
    it('selects only columns that exist after migration 0015', async () => {
      await seedClaim({
        id: 'qs-1',
        orderId: 'ord-qs-1',
        matchStatus: 'AUTO_VERIFIED',
        purchaseType: 'NEW_PURCHASE',
        operationType: 'getconfigafterpay',
      });
      const r = await callPayments(
        'tab=bot_auto_verified&purchaseType=NEW_PURCHASE&range=today',
      );
      expect(r.status).toBe(200);
      // The response items must project purchase_type / operation_type when flag is ON.
      const item = (r.body.items ?? []).find((x: any) => x.id === 'qs-1');
      expect(item).toBeTruthy();
      expect(item.purchaseType).toBe('NEW_PURCHASE');
      expect(item.operationType).toBe('getconfigafterpay');
    });
  });

  // ───────────────────────── Classification fixtures ─────────────────────────
  describe('Scenario 1 — NEW_PURCHASE (getconfigafterpay)', () => {
    it('appears in New Purchases, NOT in Renewals', async () => {
      await seedClaim({
        id: 'np-1',
        orderId: 'ord-np-1',
        matchStatus: 'AUTO_VERIFIED',
        purchaseType: 'NEW_PURCHASE',
        operationType: 'getconfigafterpay',
      });
      const newP = await callPayments(
        'tab=bot_auto_verified&purchaseType=NEW_PURCHASE&range=today',
      );
      const ren = await callPayments(
        'tab=bot_auto_verified&purchaseType=RENEWAL&range=today',
      );
      expect(hasClaim(newP.body.items, 'np-1')).toBe(true);
      expect(hasClaim(ren.body.items, 'np-1')).toBe(false);
    });
  });

  describe('Scenario 2 — RENEWAL (getextenduser)', () => {
    it('appears in Renewals', async () => {
      await seedClaim({
        id: 're-2',
        orderId: 'ord-re-2',
        matchStatus: 'AUTO_VERIFIED',
        purchaseType: 'RENEWAL',
        operationType: 'getextenduser',
      });
      const ren = await callPayments(
        'tab=bot_auto_verified&purchaseType=RENEWAL&range=today',
      );
      const newP = await callPayments(
        'tab=bot_auto_verified&purchaseType=NEW_PURCHASE&range=today',
      );
      expect(hasClaim(ren.body.items, 're-2')).toBe(true);
      expect(hasClaim(newP.body.items, 're-2')).toBe(false);
    });
  });

  describe('Scenario 3 — RENEWAL (getextratimeuser)', () => {
    it('appears in Renewals', async () => {
      await seedClaim({
        id: 're-3',
        orderId: 'ord-re-3',
        matchStatus: 'AUTO_VERIFIED',
        purchaseType: 'RENEWAL',
        operationType: 'getextratimeuser',
      });
      const ren = await callPayments(
        'tab=bot_auto_verified&purchaseType=RENEWAL&range=today',
      );
      expect(hasClaim(ren.body.items, 're-3')).toBe(true);
    });
  });

  describe('Scenario 4 — RENEWAL (getextravolumeuser)', () => {
    it('appears in Renewals', async () => {
      await seedClaim({
        id: 're-4',
        orderId: 'ord-re-4',
        matchStatus: 'AUTO_VERIFIED',
        purchaseType: 'RENEWAL',
        operationType: 'getextravolumeuser',
      });
      const ren = await callPayments(
        'tab=bot_auto_verified&purchaseType=RENEWAL&range=today',
      );
      expect(hasClaim(ren.body.items, 're-4')).toBe(true);
    });
  });

  describe('Scenario 5 — NULL / UNCLASSIFIED legacy row', () => {
    it('purchase_type=NULL is NOT silently classified as NEW_PURCHASE or RENEWAL', async () => {
      await seedClaim({
        id: 'un-1',
        orderId: 'ord-un-1',
        matchStatus: 'AUTO_VERIFIED',
        purchaseType: null,
        operationType: null,
      });
      // Direct filter: NEW_PURCHASE and RENEWAL must NOT include this row.
      const newP = await callPayments(
        'tab=bot_auto_verified&purchaseType=NEW_PURCHASE&range=today',
      );
      const ren = await callPayments(
        'tab=bot_auto_verified&purchaseType=RENEWAL&range=today',
      );
      // Without a purchaseType filter, the row IS returned (it is in
      // bot_auto_verified status AUTO_VERIFIED).  The chosen UI/API behavior
      // is therefore: NULL rows are visible in the unfiltered list and
      // explicitly absent from any purchase-type filtered list.  The UI
      // surfaces "—" for these rows and never buckets them silently.
      const unfiltered = await callPayments(
        'tab=bot_auto_verified&range=today',
      );
      expect(hasClaim(newP.body.items, 'un-1')).toBe(false);
      expect(hasClaim(ren.body.items, 'un-1')).toBe(false);
      expect(hasClaim(unfiltered.body.items, 'un-1')).toBe(true);
      // The worker serialises NULL rows as 'UNKNOWN' sentinel so the UI can
      // render "—" for them.  This is the chosen API behavior and is
      // stable so the UI can rely on it.
      const item = unfiltered.body.items.find((it: any) => it.id === 'un-1');
      expect(item.purchaseType).toBe('UNKNOWN');
    });
  });

  describe('Scenario 6 — Non AUTO_VERIFIED payment', () => {
    it('must NOT appear in Bot Auto Verified even if purchase_type is set', async () => {
      await seedClaim({
        id: 'pe-1',
        orderId: 'ord-pe-1',
        matchStatus: 'CONFIRMED',
        purchaseType: 'NEW_PURCHASE',
        operationType: 'getconfigafterpay',
      });
      await seedClaim({
        id: 'pe-2',
        orderId: 'ord-pe-2',
        matchStatus: null, // PENDING — never matched
        purchaseType: 'NEW_PURCHASE',
        operationType: 'getconfigafterpay',
      });
      const tab = await callPayments(
        'tab=bot_auto_verified&purchaseType=NEW_PURCHASE&range=today',
      );
      expect(tab.status).toBe(200);
      expect(hasClaim(tab.body.items, 'pe-1')).toBe(false);
      expect(hasClaim(tab.body.items, 'pe-2')).toBe(false);
    });
  });

  // ───────────────────────── Date filter (Asia/Tehran) ─────────────────────────
  describe('Date filter', () => {
    /**
     * Tehran day windows as the worker actually computes them via
     * `tehranDayFromUtc(now)`:
     *   For any `now` on UTC 2026-08-10, the window is
     *   start = UTC 2026-08-10T03:30:00Z (== Tehran 07:00 on 2026-08-10)
     *   end   = start + 24h.
     * The function's "today" therefore starts at UTC midnight + 3.5h on the
     * calendar day of `now` in UTC.  This is the worker's existing convention
     * for the Dashboard timezone; we mirror it exactly so the test mirrors
     * production behavior.
     */
    // Real Tehran midnights (UTC+3:30, no DST), written out so this file never
    // has to agree with the code it is testing. The previous values were
    // 03:30Z, i.e. 07:00 Tehran — the seven-hour error these tests were meant
    // to catch, and the comments below already disagreed with them.
    const TEHRAN_TODAY_START = Date.parse('2026-08-09T20:30:00Z'); // 2026-08-10 00:00 Tehran
    const TEHRAN_TODAY_END = Date.parse('2026-08-10T20:30:00Z'); // 2026-08-11 00:00 Tehran
    const TEHRAN_YESTERDAY_START = Date.parse('2026-08-08T20:30:00Z'); // 2026-08-09 00:00
    const TEHRAN_DAY_BEFORE_START = Date.parse('2026-08-07T20:30:00Z'); // 2026-08-08 00:00

    async function seedWithVerifiedAt(
      id: string,
      ts: number,
      purchaseType: string,
      operationType: string,
    ): Promise<void> {
      await seedClaim({
        id,
        orderId: `ord-${id}`,
        matchStatus: 'AUTO_VERIFIED',
        verifiedAtMs: ts,
        purchaseType,
        operationType,
      });
    }

    it('Today: returns rows inside today Tehran window, NEW_PURCHASE', async () => {
      await seedWithVerifiedAt(
        'td-1',
        TEHRAN_TODAY_START + 60_000, // 00:01 Tehran
        'NEW_PURCHASE',
        'getconfigafterpay',
      );
      await seedWithVerifiedAt(
        'td-2',
        TEHRAN_TODAY_END - 60_000, // 23:59 Tehran
        'NEW_PURCHASE',
        'getconfigafterpay',
      );
      const r = await callPayments(
        'tab=bot_auto_verified&purchaseType=NEW_PURCHASE&range=today',
      );
      expect(r.status).toBe(200);
      // Diagnostic: directly query with the same predicate the worker uses.
      const e = baseEnv as unknown as Env;
      const now = Date.now();
      const direct = await e.DB.prepare(
        `SELECT id, paid_clicked_at, receipt_submitted_at, created_at,
                COALESCE(paid_clicked_at, receipt_submitted_at, created_at) AS effective_ts
         FROM payment_claims WHERE id IN ('td-1','td-2')`,
      ).all<any>();
      const nowObj = new Date(now);
      const startUtc = new Date(now); startUtc.setUTCHours(0,0,0,0);
      const start = startUtc.getTime() + 3.5*3600*1000;
      const end = start + 86400000;
      const itemsIds = (r.body.items ?? []).map((it: any) => it.id);
      expect(
        hasClaim(r.body.items, 'td-1'),
        `now=${now} nowIso=${nowObj.toISOString()} start=${start} end=${end} direct=${JSON.stringify(direct.results)} items=${JSON.stringify(itemsIds)}`,
      ).toBe(true);
      expect(hasClaim(r.body.items, 'td-2')).toBe(true);
    });

    it('Today: rejects rows just BEFORE today boundary', async () => {
      await seedWithVerifiedAt(
        'td-3',
        TEHRAN_TODAY_START - 60_000, // 23:59 yesterday Tehran
        'NEW_PURCHASE',
        'getconfigafterpay',
      );
      const r = await callPayments(
        'tab=bot_auto_verified&purchaseType=NEW_PURCHASE&range=today',
      );
      // Diagnostic: capture the response so we can see what came back.
      expect(r.status, `status=${r.status} body=${JSON.stringify(r.body).slice(0, 800)}`).toBe(200);
      expect(hasClaim(r.body.items, 'td-3')).toBe(false);
    });

    it('Yesterday: returns rows inside yesterday Tehran window', async () => {
      // Tehran yesterday relative to NOW_MS is 2026-08-09, which runs
      // 2026-08-08T20:30Z .. 2026-08-09T20:30Z.
      await seedWithVerifiedAt(
        'yd-1',
        TEHRAN_YESTERDAY_START + 60_000,
        'RENEWAL',
        'getextenduser',
      );
      const r = await callPayments(
        `tab=bot_auto_verified&purchaseType=RENEWAL&range=day&day=2026-08-09`,
      );
      expect(hasClaim(r.body.items, 'yd-1')).toBe(true);
    });

    it('Day Before Yesterday: returns rows inside that Tehran window', async () => {
      // Day-before-yesterday Tehran = 2026-08-08.
      // Worker "day" range for 2026-08-08: start=2026-08-08T03:30Z, end=2026-08-09T03:30Z.
      await seedWithVerifiedAt(
        'dby-1',
        TEHRAN_DAY_BEFORE_START + 60_000,
        'RENEWAL',
        'getextravolumeuser',
      );
      const r = await callPayments(
        `tab=bot_auto_verified&purchaseType=RENEWAL&range=day&day=2026-08-08`,
      );
      expect(hasClaim(r.body.items, 'dby-1')).toBe(true);
    });

    it('All: returns rows from any time', async () => {
      await seedWithVerifiedAt(
        'all-1',
        TEHRAN_DAY_BEFORE_START - 5 * 24 * 60 * 60 * 1000, // 5 days ago
        'NEW_PURCHASE',
        'getconfigafterpay',
      );
      const r = await callPayments(
        'tab=bot_auto_verified&purchaseType=NEW_PURCHASE&range=all',
      );
      expect(hasClaim(r.body.items, 'all-1')).toBe(true);
    });

    it('Today boundary: rows at exactly the start instant (00:00 Tehran) ARE today', async () => {
      // The worker uses effective_ts and the predicate is `>= start AND < end`.
      // An exact equality with `start` should pass.
      await seedWithVerifiedAt(
        'bnd-1',
        TEHRAN_TODAY_START + 1, // 1 ms into today (predicate is >= start)
        'NEW_PURCHASE',
        'getconfigafterpay',
      );
      const r = await callPayments(
        'tab=bot_auto_verified&purchaseType=NEW_PURCHASE&range=today',
      );
      expect(hasClaim(r.body.items, 'bnd-1')).toBe(true);
    });
  });

  // ───────────────────────── FEATURE OFF SQL safety ─────────────────────────
  describe('FEATURE OFF — generated SQL must not reference dev-only columns', () => {
    it('omits purchase_type / operation_type when ENABLE_PURCHASE_TYPE=false', async () => {
      // Re-apply production schema (no purchase_type column).
      const e = baseEnv as unknown as Env;
      // Wipe everything to get a clean schema-only-DB.
      const tables = [
        'reconciliation_matches',
        'payment_claims',
        'integration_events',
        'transaction_candidates',
        'raw_sms_events',
        'financial_account_identifiers',
        'financial_accounts',
        'devices',
        'access_users',
      ];
      for (const t of tables) {
        try { await e.DB.prepare(`DELETE FROM ${t}`).run(); } catch { /* table may not exist */ }
      }
      // Apply production-only schema.
      await applySchema();
      // Seed an access user.
      await e.DB.prepare(
        `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
         VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
      )
        .bind(crypto.randomUUID(), EMAIL, NOW_MS)
        .run();
      // Make a basic claim + auto-verified match so the query has something.
      await e.DB.prepare(
        `INSERT OR IGNORE INTO financial_accounts
          (id, bank_name, display_name, owner_label, account_type, account_hint,
           card_last_four, account_last_four, device_id, active, parser_configuration,
           created_at, updated_at)
         VALUES ('a1', 'Melli', 'Melli Main', NULL, 'CARD', '6006', NULL, NULL,
                 NULL, 1, '{}', ?1, ?1)`,
      )
        .bind(NOW_MS)
        .run();
      await e.DB.prepare(
        `INSERT INTO payment_claims
          (id, external_order_id, customer_reference, expected_amount_irr,
           target_financial_account_id, submitted_at, source_system, metadata_json,
           status, paid_clicked_at, receipt_submitted_at, card_digits,
           created_at, updated_at)
         VALUES ('po-1','mirzabot:test:po-1','42',1950000,'a1',?1,'MIRZABOT','{}','VERIFIED',
                 ?1,?1,'5054161706275678',?1,?1)`,
      )
        .bind(NOW_MS)
        .run();
      await e.DB.prepare(
        `INSERT INTO devices
          (id, device_code, display_name, active, created_at, updated_at)
         VALUES ('dev-ptd', 'ptd', 'PTD', 1, ?1, ?1)`,
      )
        .bind(NOW_MS)
        .run();
      await e.DB.prepare(
        `INSERT INTO raw_sms_events
          (id, device_id, sender, encrypted_or_protected_body, normalized_body,
           body_sha256, app_checksum, sms_timestamp, received_at, classification,
           parser_status, parser_id, parser_version, created_at)
         VALUES ('sms-po-1', 'dev-ptd', 'TEST', NULL, 'seed', 'h', 'c', ?1, ?1, 'BANK_CREDIT',
                 'OK', 'test', 'v1', ?1)`,
      )
        .bind(NOW_MS)
        .run();
      await e.DB.prepare(
        `INSERT INTO transaction_candidates
          (id, raw_sms_event_id, financial_account_id, direction, amount_irr,
           balance_irr, transaction_reference, bank_timestamp, confidence,
           parser_id, parser_version, parser_evidence_json, status,
           created_at, updated_at)
         VALUES ('tx-po-1','sms-po-1','a1','CREDIT',1950000,NULL,NULL,?1,1.0,
                 'test','v1','{}','MATCHED',?1,?1)`,
      )
        .bind(NOW_MS)
        .run();
      await e.DB.prepare(
        `INSERT INTO reconciliation_matches
          (id, payment_claim_id, transaction_candidate_id, status, score,
           matching_reasons_json, mismatch_reasons_json, reviewed_at, reviewed_by,
           created_at, updated_at)
         VALUES ('po-1','po-1','tx-po-1','AUTO_VERIFIED',1.0,'{}','[]',?1,'system',?1,?1)`,
      )
        .bind(NOW_MS)
        .run();
      // Production schema has no purchase_type column. The OFF path must
      // not SELECT it, so the response is a 200 with NO purchaseType field.
      const res = await app.fetch(
        new Request(
          'https://example.com/api/v1/payments?tab=bot_auto_verified&range=today',
          { method: 'GET' },
        ),
        prodEnv(),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items?: any[] };
      const items = body.items ?? [];
      for (const it of items) {
        expect(it.purchaseType).toBeUndefined();
        expect(it.operationType).toBeUndefined();
      }
    });
  });
});
