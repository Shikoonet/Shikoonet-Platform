/**
 * «برگرداندن» — giving back what a renewal burned (0096).
 *
 * Sam, 2026-09-23: some customers renew by mistake, early, and a RESET panel
 * throws away the volume and days they had left. The renewal's snapshot says
 * how much; this route adds it back onto the account.
 *
 * The expected numbers are the PANEL's own plus the snapshot's, never the
 * route's answer read back (rule 6): the PUT body is what the panel was told,
 * and it must equal what the panel held plus what burned.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { panelSecretKey, seal } from '@shikoo/domain';
import { applySchema, env as baseEnv, deleteFixtureUsers, FIXTURE_TG_BASE } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin@example.com';
const REVIEWER = 'reviewer-restore@example.com';
const KEY = 'ab'.repeat(32);
const TG_BASE = FIXTURE_TG_BASE + 997_000_000;
const PANEL_CODE = 'zz-restore-panel';
const GIB = 1024 ** 3;
const DAY = 86_400_000;
/** The clock, pinned: the route's `renewFrom` and every panel date below read it. */
const NOW = Date.UTC(2026, 8, 23, 12, 0, 0);

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

async function restore(snapshotId: number, email = ADMIN): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost/api/v1/admin/renewals/${snapshotId}/restore`, {
      method: 'POST',
      headers: { origin: 'http://localhost' },
    }),
    envAs(email),
  );
}

/** A panel holding one account; every PUT it is sent is kept, and it may refuse them. */
function fakePanel(account: { expire: number; data_limit: number }, refuse = false) {
  const puts: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = init?.method ?? 'GET';
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        });
      if (url.endsWith('/api/admin/token')) return json({ access_token: 'tok' });
      if (method === 'GET' && url.includes('/api/user/')) {
        return json({ username: 'ali_42', status: 'active', used_traffic: 0, ...account });
      }
      if (method === 'PUT' && url.includes('/api/user/')) {
        if (refuse) return json({ detail: 'no' }, 400);
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        puts.push(body);
        return json({ username: 'ali_42' });
      }
      return json({}, 500);
    },
  );
  return puts;
}

let seq = 0;
let panelId: number;

/** A customer with one service that was renewed, and the snapshot that renewal left. */
async function renewed(
  lost: { bytes: number; ms: number },
  status: 'ACTIVE' | 'DISABLED' = 'ACTIVE',
) {
  const telegramId = TG_BASE + ++seq;
  const user = await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, status, registered_at)
     VALUES (?1, 'zzrestore', 'ACTIVE', now()) RETURNING id`,
  )
    .bind(telegramId)
    .first<{ id: number }>();
  const sub = await baseEnv.DB.prepare(
    `INSERT INTO subscriptions (public_id, user_id, provider_id, plan_name_at_sale, price_irr,
                                remote_username, volume_gb, used_bytes, status, purchased_at, expires_at)
     VALUES (?1, ?2, ?3, 'الماس ۱ ماهه', 1000000, 'ali_42', 50, 0, ?4, now(), ?5::timestamptz)
     RETURNING id`,
  )
    // Our row's expiry from the pinned clock, not the database's `now()`: the
    // route keeps the later of ours and the panel's, and a real clock that has
    // passed NOW would win that comparison.
    .bind(`zzrestore-${telegramId}`, user!.id, panelId, status, new Date(NOW - DAY).toISOString())
    .first<{ id: number }>();
  const order = await baseEnv.DB.prepare(
    `INSERT INTO orders (public_id, user_id, kind, unit_price_irr, total_irr, status, target_subscription_id, plan_name_at_sale)
     VALUES (?1, ?2, 'RENEWAL', 1000000, 1000000, 'COMPLETED', ?3, 'الماس ۱ ماهه') RETURNING id`,
  )
    .bind(`zzrestore-o-${telegramId}`, user!.id, sub!.id)
    .first<{ id: number }>();
  const snap = await baseEnv.DB.prepare(
    `INSERT INTO renewal_snapshots (order_id, subscription_id, mode, plan_name_before,
                                    used_bytes_before, limit_bytes_before, expires_at_before, lost_bytes, lost_ms)
     VALUES (?1, ?2, 'RESET', 'الماس ۱ ماهه', ?3, ?4, now(), ?5, ?6) RETURNING id`,
  )
    .bind(order!.id, sub!.id, 50 * GIB - lost.bytes, 50 * GIB, lost.bytes, lost.ms)
    .first<{ id: number }>();
  return { userId: Number(user!.id), subId: Number(sub!.id), snapshotId: Number(snap!.id) };
}

async function snapshot(id: number) {
  return baseEnv.DB.prepare(`SELECT restored_at, restored_by FROM renewal_snapshots WHERE id = ?1`)
    .bind(id)
    .first<{ restored_at: string | null; restored_by: string | null }>();
}

beforeAll(async () => {
  await applySchema();
  process.env['PANEL_SECRET_KEY'] = KEY;
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
  await deleteFixtureUsers(TG_BASE);
  await baseEnv.DB.prepare(`DELETE FROM provisioning_providers WHERE code = ?1`)
    .bind(PANEL_CODE)
    .run();
  const panel = await baseEnv.DB.prepare(
    `INSERT INTO provisioning_providers (code, name, kind, status, base_url, config)
     VALUES (?1, 'سرویس الماس', 'pasarguard', 'ACTIVE', 'https://panel.invalid', '{}'::jsonb)
     RETURNING id`,
  )
    .bind(PANEL_CODE)
    .first<{ id: number }>();
  panelId = Number(panel!.id);
  await baseEnv.DB.prepare(
    `INSERT INTO provider_secrets (provider_id, sealed, key_id, set_by) VALUES (?1, ?2, 'test', 'test')`,
  )
    .bind(panelId, seal('admin:hunter2', panelSecretKey()))
    .run();
});

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  await deleteFixtureUsers(TG_BASE);
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await deleteFixtureUsers(TG_BASE);
  await baseEnv.DB.prepare(`DELETE FROM provider_secrets WHERE provider_id = ?1`)
    .bind(panelId)
    .run();
  await baseEnv.DB.prepare(`DELETE FROM provisioning_providers WHERE id = ?1`).bind(panelId).run();
  delete process.env['PANEL_SECRET_KEY'];
});

describe('POST /api/v1/admin/renewals/:id/restore', () => {
  it('adds the burned volume and days onto the account as the panel holds it — once', async () => {
    // Switched off by the customer (#366): the restore wakes it on the panel,
    // so the row must say so too.
    const r = await renewed({ bytes: 30 * GIB, ms: 5 * DAY }, 'DISABLED');
    const expire = Math.floor((NOW + 30 * DAY) / 1000);
    const puts = fakePanel({ expire, data_limit: 50 * GIB });

    const res = await restore(r.snapshotId);
    expect(res.status).toBe(200);

    // What the panel held, plus what the snapshot says burned.
    expect(puts).toHaveLength(1);
    expect(puts[0]?.['data_limit']).toBe(80 * GIB);
    expect(puts[0]?.['expire']).toBe(expire + 5 * 86_400);
    const sub = await baseEnv.DB.prepare(
      `SELECT volume_gb::float8 AS gb, expires_at, status FROM subscriptions WHERE id = ?1`,
    )
      .bind(r.subId)
      .first<{ gb: number; expires_at: string; status: string }>();
    expect(sub?.gb).toBe(80);
    expect(sub?.status).toBe('ACTIVE');
    expect(Date.parse(sub!.expires_at)).toBe((expire + 5 * 86_400) * 1000);
    expect(await snapshot(r.snapshotId)).toMatchObject({ restored_by: ADMIN });
    const audit = await baseEnv.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM audit_logs WHERE action = 'RENEWAL_RESTORED' AND entity_id = ?1`,
    )
      .bind(String(r.subId))
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);

    // A second press gives nothing twice.
    const again = await restore(r.snapshotId);
    expect(again.status).toBe(409);
    expect(((await again.json()) as { error: string }).error).toBe('already_restored');
    expect(puts).toHaveLength(1);

    // And the customer's card shows it as done.
    const card = await app.fetch(
      new Request(`http://localhost/api/v1/admin/customers/${r.userId}`),
      envAs(ADMIN),
    );
    const body = (await card.json()) as {
      renewals: { id: number; lostBytes: number; restoredAt: string | null }[];
    };
    expect(body.renewals).toEqual([
      expect.objectContaining({
        id: r.snapshotId,
        lostBytes: 30 * GIB,
        restoredAt: expect.any(String),
      }),
    ]);
  });

  it('is refused for a reviewer, and nothing is claimed', async () => {
    const r = await renewed({ bytes: GIB, ms: DAY });
    const puts = fakePanel({
      expire: Math.floor(NOW / 1000) + 86_400,
      data_limit: 50 * GIB,
    });

    expect((await restore(r.snapshotId, REVIEWER)).status).toBe(403);
    expect(puts).toHaveLength(0);
    expect((await snapshot(r.snapshotId))?.restored_at).toBeNull();
  });

  it('releases the claim when the panel refuses, so the button works again', async () => {
    const r = await renewed({ bytes: GIB, ms: DAY });
    fakePanel({ expire: Math.floor(NOW / 1000) + 86_400, data_limit: 50 * GIB }, true);

    expect((await restore(r.snapshotId)).status).toBe(502);
    expect((await snapshot(r.snapshotId))?.restored_at).toBeNull();
  });

  it('has nothing to give back for a renewal that burned nothing', async () => {
    const r = await renewed({ bytes: 0, ms: 0 });
    const puts = fakePanel({
      expire: Math.floor(NOW / 1000) + 86_400,
      data_limit: 50 * GIB,
    });

    const res = await restore(r.snapshotId);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('nothing_to_restore');
    expect(puts).toHaveLength(0);
  });
});
