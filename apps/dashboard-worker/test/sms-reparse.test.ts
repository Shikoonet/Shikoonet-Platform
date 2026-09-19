/**
 * «بازخوانی» at the routes. A Melli bill that arrived before its parser
 * existed sits in raw_sms_events with no row; the dry-run lists it, apply
 * makes the DEBIT row through ingest's own path, and a second apply makes
 * nothing. A text still nobody reads stays out. ADMIN-only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-rep@example.com';
const REVIEWER = 'reviewer-rep@example.com';
const P = 'zz-rep-';
const DEVICE = `${P}device`;
const ACCT = `${P}acct`;

const envAs = (email: string) => ({ ...baseEnv, TEST_ACCESS_USER: email });
const post = (path: string, body: unknown, email = ADMIN) =>
  app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, envAs(email));

async function raw(id: string, sender: string, body: string, classification: string, parserId: string, at = Date.now() - 3_600_000): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp,
        received_at, classification, parser_status, parser_id, parser_version, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'c', ?6, ?6, ?7, 'WARN', ?8, 'v1', ?6)`,
  )
    .bind(id, DEVICE, sender, body, `${P}hash-${id}`, at, classification, parserId)
    .run();
}

const BILL = `${P}melli-bill`;
const NOBODY = `${P}nobody`;
const FIRST = `${P}melli-first`;
const RESENT = `${P}melli-resent`;

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  for (const [email, role] of [[ADMIN, 'ADMIN'], [REVIEWER, 'REVIEWER']]) {
    await baseEnv.DB.prepare(
      `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4) ON CONFLICT (email) DO UPDATE SET role = EXCLUDED.role, active = 1`,
    )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }
  await baseEnv.DB.prepare(
    `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES (?1, ?1, 'Reparse Phone', 1, ?2, ?2) ON CONFLICT (id) DO NOTHING`,
  )
    .bind(DEVICE, now)
    .run();
  // The Melli account the bill belongs to, keyed by its hint, so the row lands on it.
  await baseEnv.DB.prepare(
    `INSERT INTO financial_accounts (id, bank_name, display_name, account_type, account_hint, active, status, parser_configuration, created_at, updated_at)
     VALUES (?1, 'Meli', 'ملی بازخوانی', 'ACCOUNT', '06006', 1, 'ACTIVE', '{}', ?2, ?2)
     ON CONFLICT (id) DO UPDATE SET active = 1, status = 'ACTIVE', account_hint = '06006'`,
  )
    .bind(ACCT, now)
    .run();
  await purge();
  await raw(BILL, '+98700717', 'بانک ملی ایران\nقبض:107,000,000-\nحساب:06006\nمانده:26,481,206\n0627-00:16', 'BALANCE', 'generic-balance');
  await raw(NOBODY, 'SOMEBANK', 'سلام، این پیام هیچ عددی ندارد', 'UNKNOWN', 'fallback-unknown');
});

async function purge(): Promise<void> {
  await baseEnv.DB.prepare(`DELETE FROM transaction_candidates WHERE raw_sms_event_id LIKE ?1`).bind(`${P}%`).run();
  await baseEnv.DB.prepare(`DELETE FROM raw_sms_events WHERE id LIKE ?1`).bind(`${P}%`).run();
}

afterAll(async () => {
  await purge();
});

describe('POST /api/v1/admin/sms/reparse', () => {
  it('is ADMIN-only', async () => {
    expect((await post('/api/v1/admin/sms/reparse/dry-run', {}, REVIEWER)).status).toBe(403);
    expect((await post('/api/v1/admin/sms/reparse/apply', { eventIds: [BILL], confirm: true }, REVIEWER)).status).toBe(403);
  });

  it('dry-run lists the bill as readable now and leaves the unreadable one out; apply makes one DEBIT row on the account, once', async () => {
    const dr = (await (await post('/api/v1/admin/sms/reparse/dry-run', { days: 7 })).json()) as {
      report: { candidates: { eventId: string; was: { parserId: string }; now: { parserId: string; direction: string; amountIrr: number } }[]; stillUnread: number };
    };
    const bill = dr.report.candidates.find((x) => x.eventId === BILL);
    expect(bill).toMatchObject({ was: { parserId: 'generic-balance' }, now: { parserId: 'melli-transfer-v1', direction: 'DEBIT', amountIrr: 107_000_000 } });
    expect(dr.report.candidates.find((x) => x.eventId === NOBODY)).toBeUndefined();
    expect(dr.report.stillUnread).toBeGreaterThanOrEqual(1);

    const ap = (await (await post('/api/v1/admin/sms/reparse/apply', { eventIds: [BILL, NOBODY], confirm: true })).json()) as {
      made: { eventId: string; transactionId: string; direction: string }[];
      skipped: { eventId: string; why: string }[];
    };
    expect(ap.made.map((m) => m.eventId)).toEqual([BILL]);
    expect(ap.skipped).toEqual([{ eventId: NOBODY, why: 'no_longer_readable' }]);

    const row = await baseEnv.DB.prepare(
      `SELECT t.direction, t.amount_irr, t.balance_irr, t.financial_account_id, t.processing_disposition, t.parser_id,
              (SELECT COUNT(*)::int FROM reconciliation_matches m WHERE m.transaction_candidate_id = t.id) AS matches,
              r.classification, r.parser_id AS raw_parser
         FROM transaction_candidates t JOIN raw_sms_events r ON r.id = t.raw_sms_event_id
        WHERE t.raw_sms_event_id = ?1`,
    )
      .bind(BILL)
      .first<Record<string, unknown>>();
    expect(row).toMatchObject({
      direction: 'DEBIT',
      amount_irr: 107_000_000,
      balance_irr: 26_481_206,
      financial_account_id: ACCT,
      processing_disposition: 'OUTGOING_IGNORED',
      parser_id: 'melli-transfer-v1',
      matches: 0,
      classification: 'BANK_TRANSACTION',
      raw_parser: 'melli-transfer-v1',
    });

    const again = (await (await post('/api/v1/admin/sms/reparse/apply', { eventIds: [BILL], confirm: true })).json()) as {
      made: unknown[];
      skipped: { eventId: string; why: string }[];
    };
    expect(again.made).toEqual([]);
    expect(again.skipped).toEqual([{ eventId: BILL, why: 'already_has_row' }]);

    const audits = await baseEnv.DB.prepare(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'sms.reparsed' AND entity_id = ?1`)
      .bind(ap.made[0]!.transactionId)
      .first<{ n: number }>();
    expect(audits?.n).toBe(1);
  });

  it('a text the bank sent twice makes one row; the re-send is marked duplicate_of, as ingest would have', async () => {
    // The real Melli night: the same text at 20:46 and again at 21:12.
    const body = 'بانک ملی ایران\nخریداینترنتی:39,900,000-\nحساب:06006\nمانده:12,140\n0627-20:45';
    const at = Date.now() - 2 * 3_600_000;
    await raw(FIRST, '+989830009417', body, 'BANK_DEBIT', 'generic-debit', at);
    await raw(RESENT, '+989830009417', body, 'BANK_DEBIT', 'generic-debit', at + 26 * 60_000);

    const dr = (await (await post('/api/v1/admin/sms/reparse/dry-run', { days: 7 })).json()) as {
      report: { candidates: { eventId: string; redeliveryOf: string | null }[] };
    };
    expect(dr.report.candidates.find((x) => x.eventId === FIRST)).toMatchObject({ redeliveryOf: null });
    expect(dr.report.candidates.find((x) => x.eventId === RESENT)).toMatchObject({ redeliveryOf: FIRST });

    const ap = (await (await post('/api/v1/admin/sms/reparse/apply', { eventIds: [FIRST, RESENT], confirm: true })).json()) as {
      made: { eventId: string }[];
      skipped: { eventId: string; why: string }[];
      failed: unknown[];
    };
    expect(ap.made.map((m) => m.eventId)).toEqual([FIRST]);
    expect(ap.skipped).toEqual([{ eventId: RESENT, why: 'redelivery' }]);
    expect(ap.failed).toEqual([]);
    const rows = await baseEnv.DB.prepare(`SELECT COUNT(*)::int AS n FROM transaction_candidates WHERE raw_sms_event_id IN (?1, ?2)`)
      .bind(FIRST, RESENT)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    const dup = await baseEnv.DB.prepare(`SELECT duplicate_of FROM raw_sms_events WHERE id = ?1`).bind(RESENT).first<{ duplicate_of: string | null }>();
    expect(dup?.duplicate_of).toBe(FIRST);
  });
});
