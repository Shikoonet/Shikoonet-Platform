/**
 * Notification bell — payment event unread counts.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { env as baseEnv } from 'cloudflare:test';
import SHA from '../../migrations/0001_init.sql?raw';
import SHA2 from '../../migrations/0002_bank_transaction.sql?raw';
import SHA3 from '../../migrations/0003_unique_account_identifier.sql?raw';
import SHA4 from '../../migrations/0004_detected_identifiers.sql?raw';
import SHA5 from '../../migrations/0005_transaction_reviews.sql?raw';
import SHA6 from '../../migrations/0006_assignment_history_and_notifications.sql?raw';
import SHA7 from '../../migrations/0007_transaction_reads.sql?raw';
import SHA8 from '../../migrations/0008_account_assignment_previews.sql?raw';
import SHA9 from '../../migrations/0009_credit_only.sql?raw';
import SHA10 from '../../migrations/0010_account_status.sql?raw';
import SHA11 from '../../migrations/0011_mirzabot_integration.sql?raw';
import SHA12 from '../../migrations/0012_claim_card_digits.sql?raw';
import SHA13 from '../../migrations/0013_resellers.sql?raw';
import SHA14 from '../../migrations/0014_income_declined.sql?raw';
import { app } from '../src/index.js';

const SCHEMA = [SHA, SHA2, SHA3, SHA4, SHA5, SHA6, SHA7, SHA8, SHA9, SHA10, SHA11, SHA12, SHA13, SHA14]
  .map((s) =>
    s
      .replace(/^\s*--[^\n]*\n/gm, '')
      .replace(/^PRAGMA\s+foreign_keys\s*=\s*ON\s*;?\s*$/gim, '')
      .trim(),
  )
  .join('\n\n');

function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  for (const raw of sql.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('--')) continue;
    buf += raw + '\n';
    if (line.endsWith(';')) {
      out.push(buf.trim());
      buf = '';
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

async function applySchema() {
  for (const stmt of splitStatements(SCHEMA)) {
    try {
      await baseEnv.DB.prepare(stmt).run();
    } catch (err) {
      const msg = String(err);
      if (msg.includes('already exists') || msg.includes('duplicate column name')) continue;
      throw err;
    }
  }
}

const EMAIL = 'admin@example.com';

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
  )
    .bind(crypto.randomUUID(), EMAIL, now)
    .run();
});

describe('notification counts with payment events', () => {
  it('includes bell-scoped unread fields in counts response', async () => {
    const resp = await app.fetch(
      new Request('https://example.com/api/v1/notifications/counts'),
      { ...baseEnv, TEST_ACCESS_USER: EMAIL },
    );
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as {
      counts: {
        unread: number;
        incomeUnread: number;
        botAutoVerifiedUnread: number;
        paymentEvents: { total: number };
      };
    };
    expect(body.counts.paymentEvents).toBeDefined();
    expect(typeof body.counts.incomeUnread).toBe('number');
    expect(typeof body.counts.botAutoVerifiedUnread).toBe('number');
    expect(body.counts.unread).toBe(
      body.counts.incomeUnread + body.counts.botAutoVerifiedUnread,
    );
  });
});
