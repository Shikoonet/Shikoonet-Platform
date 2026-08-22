/**
 * Notification bell — payment event unread counts.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

// Schema now comes from migrations/000*.sql, applied to the test database.

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
    const resp = await app.fetch(new Request('https://example.com/api/v1/notifications/counts'), {
      ...baseEnv,
      TEST_ACCESS_USER: EMAIL,
    });
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
    expect(body.counts.unread).toBe(body.counts.incomeUnread + body.counts.botAutoVerifiedUnread);
  });
});
