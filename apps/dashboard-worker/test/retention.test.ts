/**
 * «یادآوری تمدید», from the panel.
 *
 * The write replaces a list the bot will act on, so what matters is what it
 * refuses: a shape the bot could not read, a panel that is not there, and a
 * code the customer could not use for the renewal the rule is selling.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
    providerId: null,
    panelAdmin: 'firstbuy',
    daysBefore: 1,
    daysAfter: 0,
    onlyService: true,
    codeId: null,
    text: 'سلام',
    textAfter: '',
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

// Empty before AND after: the row is shared with the bot's suites on this
// database, and a rule left enabled here is a fourth message in the bot's
// nightly report test (`report.test.ts` counts three).
async function emptyRules(): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO settings (scope, key, value) VALUES ('bot', 'retention_rules', '[]'::jsonb)
     ON CONFLICT (scope, key) DO UPDATE SET value = '[]'::jsonb`,
  ).run();
}

afterAll(emptyRules);

beforeEach(async () => {
  await emptyRules();
  // Fixture rows from a run that failed before its own cleanup.
  await baseEnv.DB.prepare(`DELETE FROM subscriptions WHERE public_id LIKE 'zz-aud-%' OR public_id = 'zz-retw-1'`).run();
  await baseEnv.DB.prepare(`DELETE FROM users WHERE telegram_id IN (749900, 749901)`).run();
  await baseEnv.DB.prepare(`DELETE FROM bot_notifications WHERE dedupe_key LIKE 'retention:r_test%'`).run();
});

describe('reading', () => {
  it('a reviewer sees the rules, the panels and the codes', async () => {
    expect((await post(ADMIN, [rule({ codeId })])).status).toBe(200);
    const res = await app.request('/api/v1/admin/retention', {}, envAs(REVIEWER));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { key: string; codeId: number; funnel: { sent: number }; lastActed: unknown }[];
      panels: { id: number }[];
      admins: { admin: string; accounts: number }[];
      codes: { id: number; firstPurchaseOnly: boolean }[];
    };
    expect(body.items.map((i) => i.key)).toEqual(['r_test1']);
    expect(body.items[0]?.funnel).toEqual({ sent: 0, usedCode: 0, usedOutside: 0, stayed: 0, left: 0, pending: 0 });
    expect(body.items[0]?.lastActed).toBeNull();
    expect(body.panels.some((p) => Number(p.id) === panelId)).toBe(true);
    expect(Array.isArray(body.admins)).toBe(true);
    expect(body.codes.find((c) => Number(c.id) === firstOnlyCodeId)?.firstPurchaseOnly).toBe(true);
  });
});

describe('the audience count', () => {
  const ask = (email: string, q: Record<string, string>) =>
    app.request(`/api/v1/admin/retention/audience?${new URLSearchParams(q).toString()}`, {}, envAs(email));

  it('counts the sweep\'s own window, and a reviewer may ask', async () => {
    const user = await baseEnv.DB.prepare(
      `INSERT INTO users (telegram_id, username, registered_at) VALUES (749901, 'ret_aud', now())
       ON CONFLICT (telegram_id) DO UPDATE SET username = excluded.username RETURNING id`,
    ).first<{ id: number }>();
    const mk = (pub: string, days: number) =>
      baseEnv.DB.prepare(
        `INSERT INTO subscriptions (public_id, user_id, plan_name_at_sale, price_irr, remote_username, status, purchased_at, expires_at, provider_id, panel_admin)
         VALUES (?1, ?2, 'p', 1, ?1, 'ACTIVE', now(), now() + make_interval(hours => ?3), ?4, 'aud-admin')
         ON CONFLICT (public_id) DO UPDATE SET expires_at = excluded.expires_at, panel_admin = 'aud-admin'`,
      ).bind(pub, user!.id, days, panelId).run();
    await mk('zz-aud-1', 12); // half a day left
    await mk('zz-aud-2', 108); // 4.5 days left
    await mk('zz-aud-3', -36); // 1.5 days gone

    const count = async (q: Record<string, string>) =>
      ((await (await ask(REVIEWER, q)).json()) as { count: number }).count;
    const base = { panelAdmin: 'aud-admin', onlyService: 'false' };
    expect(await count({ ...base, daysBefore: '1', daysAfter: '0' })).toBe(1);
    // By the provider row instead — the pre-picker shape — the same three.
    expect(await count({ providerId: String(panelId), onlyService: 'false', daysBefore: '5', daysAfter: '3' })).toBe(3);
    // Another admin on the same row: none of them.
    expect(await count({ panelAdmin: 'somebody-else', onlyService: 'false', daysBefore: '5', daysAfter: '3' })).toBe(0);
    // And the picker's list knows the admin now.
    const listed = (await (await app.request('/api/v1/admin/retention', {}, envAs(REVIEWER))).json()) as {
      admins: { admin: string; accounts: number }[];
    };
    expect(listed.admins.find((a) => a.admin === 'aud-admin')?.accounts).toBe(3);
    expect(await count({ ...base, daysBefore: '5', daysAfter: '0' })).toBe(2);
    expect(await count({ ...base, daysBefore: '0', daysAfter: '3' })).toBe(1);
    expect(await count({ ...base, daysBefore: '5', daysAfter: '3' })).toBe(3);
    // «only one service»: this customer owns three, so none of them counts.
    expect(await count({ ...base, daysBefore: '5', daysAfter: '3', onlyService: 'true' })).toBe(0);
    expect((await ask(REVIEWER, { providerId: 'x', daysBefore: '1', daysAfter: '0', onlyService: 'false' })).status).toBe(400);
    expect((await ask(REVIEWER, { daysBefore: '1', daysAfter: '0', onlyService: 'false' })).status).toBe(400);

    await baseEnv.DB.prepare(`DELETE FROM subscriptions WHERE public_id LIKE 'zz-aud-%'`).run();
    await baseEnv.DB.prepare(`DELETE FROM users WHERE telegram_id = 749901`).run();
  });
});

describe('«تست»', () => {
  // The sim carries the shop's own group and topics; put them back afterwards
  // or `report.test.ts` in the bot loses its channel.
  let saved: { key: string; value: unknown }[] = [];
  beforeAll(async () => {
    saved = (
      await baseEnv.DB.prepare(
        `SELECT key, value FROM settings WHERE scope = 'bot' AND key IN ('Channel_Report', 'topic_reportcron')`,
      ).all<{ key: string; value: unknown }>()
    ).results ?? [];
  });
  afterAll(async () => {
    await baseEnv.DB.prepare(
      `DELETE FROM settings WHERE scope = 'bot' AND key IN ('Channel_Report', 'topic_reportcron')`,
    ).run();
    for (const r of saved) {
      await baseEnv.DB.prepare(`INSERT INTO settings (scope, key, value) VALUES ('bot', ?1, ?2::jsonb)`)
        .bind(r.key, JSON.stringify(r.value))
        .run();
    }
  });
  const testPost = (email: string, r: unknown) =>
    app.request(
      '/api/v1/admin/retention/test',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rule: r }) },
      envAs(email),
    );

  it('renders the draft for a real service on that panel and queues it to the reports topic, never to a customer', async () => {
    await baseEnv.DB.prepare(
      `INSERT INTO settings (scope, key, value) VALUES ('bot', 'Channel_Report', '"-1009900110"'::jsonb), ('bot', 'topic_reportcron', '"77"'::jsonb)
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
    ).run();
    const user = await baseEnv.DB.prepare(
      `INSERT INTO users (telegram_id, username, registered_at) VALUES (749900, 'ret_w', now())
       ON CONFLICT (telegram_id) DO UPDATE SET username = excluded.username RETURNING id`,
    ).first<{ id: number }>();
    await baseEnv.DB.prepare(
      `INSERT INTO subscriptions (public_id, user_id, plan_name_at_sale, price_irr, remote_username, status, purchased_at, expires_at, provider_id, panel_admin)
       VALUES ('zz-retw-1', ?1, 'یک‌ماهه-100.000ت', 1000000, 'firstbuy_w1', 'ACTIVE', now(), now() + interval '1 day', ?2, 'firstbuy')
       ON CONFLICT (public_id) DO NOTHING`,
    ).bind(user!.id, panelId).run();

    const res = await testPost(ADMIN, rule({ codeId, text: 'سرویس {service} · {username} · {days} روز · کد {code} · {discount} · {renewButton}' }));
    expect(res.status).toBe(200);
    const { text } = (await res.json()) as { text: string };
    expect(text).toBe('سرویس یک‌ماهه · firstbuy_w1 · 1 روز · کد RETW30 · 30٪ · تمدید سرویس');

    const queued = await baseEnv.DB.prepare(
      `SELECT chat_id, message_thread_id, body, reply_markup FROM bot_notifications WHERE dedupe_key LIKE 'retention-test:r_test1:%' ORDER BY id DESC LIMIT 1`,
    ).first<{ chat_id: number; message_thread_id: number; body: string; reply_markup: { url: string; style: string }[][] }>();
    expect(Number(queued?.chat_id)).toBe(-1009900110);
    expect(Number(queued?.message_thread_id)).toBe(77);
    expect(queued?.body).toContain('🧪 تست');
    // The group gets the code tap-to-copy, exactly as the customer would.
    expect(queued?.body).toContain('کد <code>RETW30</code>');
    expect(queued?.reply_markup[0]?.[0]?.url).toBe('https://t.me/Test_Shikoo_bot?start=renew');
    expect(queued?.reply_markup[0]?.[0]?.style).toBe('success');
    // A rule with only an «after» side tests its after-text, on the FIRST
    // day past expiry — the message a customer meets first, not the last.
    const afterRes = await testPost(ADMIN, rule({ daysBefore: 0, daysAfter: 2, text: 'B {days}', textAfter: 'A {days}' }));
    expect(((await afterRes.json()) as { text: string }).text).toBe('A 1');

    const toCustomer = await baseEnv.DB.prepare(
      `SELECT count(*)::int AS n FROM bot_notifications WHERE chat_id = 749900`,
    ).first<{ n: number }>();
    expect(toCustomer?.n).toBe(0);

    await baseEnv.DB.prepare(`DELETE FROM subscriptions WHERE public_id = 'zz-retw-1'`).run();
    await baseEnv.DB.prepare(`DELETE FROM users WHERE telegram_id = 749900`).run();
  });

  it('says so when there is no reports group, and refuses a reviewer and a bad rule', async () => {
    expect((await testPost(REVIEWER, rule())).status).toBe(403);
    expect((await testPost(ADMIN, rule({ daysBefore: 0, daysAfter: 0 }))).status).toBe(400);
    await baseEnv.DB.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'Channel_Report'`).run();
    const res = await testPost(ADMIN, rule());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe('no_report_group');
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
    // The default text promises a code; an enabled rule without one is refused too.
    expect((await post(ADMIN, [rule({ text: 'با کد {code}', codeId: null, enabled: true })])).status).toBe(400);
    expect((await post(ADMIN, [rule({ text: 'با کد {code}', codeId: null, enabled: false })])).status).toBe(200);
  });

  it('refuses a panel that is not there', async () => {
    const res = await post(ADMIN, [rule({ providerId: 999_999_999, panelAdmin: null })]);
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

  it('creates the row when nothing installed it — an absent list is an empty one', async () => {
    // `seed:sim` truncates `settings`; the browser walk opens this screen on
    // that database. The bot reads absent and empty the same way.
    await baseEnv.DB.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'retention_rules'`).run();
    const read = await app.request('/api/v1/admin/retention', {}, envAs(REVIEWER));
    expect(((await read.json()) as { items: unknown[] }).items).toEqual([]);
    expect((await post(ADMIN, [rule()])).status).toBe(200);
    const row = await baseEnv.DB.prepare(
      `SELECT value FROM settings WHERE scope = 'bot' AND key = 'retention_rules'`,
    ).first<{ value: unknown[] }>();
    expect(row?.value).toHaveLength(1);
  });
});
