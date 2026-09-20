/**
 * «یادآوری تمدید», from the panel.
 *
 * The write replaces a list the bot will act on, so what matters is what it
 * refuses: a shape the bot could not read, a panel that is not there, and a
 * code the customer could not use for the renewal the rule is selling.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-retention@example.com';
const REVIEWER = 'reviewer-retention@example.com';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

const post = (email: string, items: unknown) =>
  app.request(
    '/api/v1/admin/retention/rules',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ items }) },
    envAs(email),
  );

let panelId = 0;
let codeId = 0;
let firstOnlyCodeId = 0;

function rule(change: Record<string, unknown> = {}) {
  return {
    key: 'r_test1',
    name: 'خرید اولی‌ها',
    enabled: true,
    providerId: panelId,
    daysBefore: 1,
    daysAfter: 0,
    onlyService: true,
    codeId: null,
    text: 'سلام {code}',
    ...change,
  };
}

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT INTO access_users (id, email, display_name, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?2, ?3, 1, ?4, ?4)
       ON CONFLICT (id) DO UPDATE SET role = excluded.role, active = 1`,
    )
      .bind(`retention-${role}`, email, role, now)
      .run();
  }
  const panel = await baseEnv.DB.prepare(
    `INSERT INTO provisioning_providers (code, name, kind, status)
     VALUES ('ret-test-panel', 'ret-test-panel', 'marzban', 'ACTIVE')
     ON CONFLICT (code) DO UPDATE SET name = excluded.name RETURNING id`,
  ).first<{ id: number }>();
  panelId = Number(panel!.id);
  await baseEnv.DB.prepare(`DELETE FROM discount_codes WHERE code LIKE 'RETW%'`).run();
  const code = await baseEnv.DB.prepare(
    `INSERT INTO discount_codes (code, kind, percent, status, applies_to)
     VALUES ('RETW30', 'PERCENT_OFF', 30, 'ACTIVE', 'RENEW') RETURNING id`,
  ).first<{ id: number }>();
  codeId = Number(code!.id);
  const firstOnly = await baseEnv.DB.prepare(
    `INSERT INTO discount_codes (code, kind, percent, status, first_purchase_only)
     VALUES ('RETWFIRST', 'PERCENT_OFF', 30, 'ACTIVE', true) RETURNING id`,
  ).first<{ id: number }>();
  firstOnlyCodeId = Number(firstOnly!.id);
});

beforeEach(async () => {
  await baseEnv.DB.prepare(
    `INSERT INTO settings (scope, key, value) VALUES ('bot', 'retention_rules', '[]'::jsonb)
     ON CONFLICT (scope, key) DO UPDATE SET value = '[]'::jsonb`,
  ).run();
  await baseEnv.DB.prepare(`DELETE FROM bot_notifications WHERE dedupe_key LIKE 'retention:r_test%'`).run();
});

describe('reading', () => {
  it('a reviewer sees the rules, the panels and the codes', async () => {
    expect((await post(ADMIN, [rule({ codeId })])).status).toBe(200);
    const res = await app.request('/api/v1/admin/retention', {}, envAs(REVIEWER));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      installed: boolean;
      items: { key: string; codeId: number; funnel: { sent: number }; lastActed: unknown }[];
      panels: { id: number }[];
      codes: { id: number; firstPurchaseOnly: boolean }[];
    };
    expect(body.installed).toBe(true);
    expect(body.items.map((i) => i.key)).toEqual(['r_test1']);
    expect(body.items[0]?.funnel).toEqual({ sent: 0, usedCode: 0, stayed: 0, left: 0, pending: 0 });
    expect(body.items[0]?.lastActed).toBeNull();
    expect(body.panels.some((p) => Number(p.id) === panelId)).toBe(true);
    expect(body.codes.find((c) => Number(c.id) === firstOnlyCodeId)?.firstPurchaseOnly).toBe(true);
  });
});

describe('writing', () => {
  it('a reviewer may not', async () => {
    expect((await post(REVIEWER, [rule()])).status).toBe(403);
  });

  it('stores the list and audits it under the screen\'s name', async () => {
    expect((await post(ADMIN, [rule({ codeId })])).status).toBe(200);
    const row = await baseEnv.DB.prepare(
      `SELECT value FROM settings WHERE scope = 'bot' AND key = 'retention_rules'`,
    ).first<{ value: { key: string; codeId: number }[] }>();
    expect(row?.value).toHaveLength(1);
    expect(row?.value[0]?.codeId).toBe(codeId);

    const audit = await baseEnv.DB.prepare(
      `SELECT action, reason FROM audit_logs
        WHERE entity_id = 'bot:retention_rules' ORDER BY created_at DESC LIMIT 1`,
    ).first<{ action: string; reason: string }>();
    expect(audit?.action).toBe('settings.update');
    expect(audit?.reason).toBe('retention');
  });

  it('refuses a shape the bot could not read', async () => {
    const res = await post(ADMIN, [rule({ daysBefore: 0, daysAfter: 0 })]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_rules');
  });

  it('refuses a panel that is not there', async () => {
    const res = await post(ADMIN, [rule({ providerId: 999_999_999 })]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('unknown_panel');
  });

  it('refuses a code the customer could not use to renew', async () => {
    const first = await post(ADMIN, [rule({ codeId: firstOnlyCodeId })]);
    expect(first.status).toBe(400);
    expect(((await first.json()) as { error: string }).error).toBe('unusable_code');
    const missing = await post(ADMIN, [rule({ codeId: 999_999_999 })]);
    expect(missing.status).toBe(400);
  });

  it('says so when the migration has not run', async () => {
    await baseEnv.DB.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'retention_rules'`).run();
    const res = await post(ADMIN, [rule()]);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('setting_not_installed');
  });
});
