/**
 * The support door's trial questions: which trials a person may have, and
 * ordering one through the shop bot's own path.
 *
 * Sam, 2026-09-26: the support bot gives a trial itself, whatever the shop
 * bot's own trial switch says, and only to a newcomer — nobody who has had a
 * trial or a service. «تست از پشتیبانی» on each panel is the only switch.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { app, type Env } from '../src/index.js';
import { env } from './helpers/env.js';

const TOKEN = 'support-test-token-that-is-long-enough-000';
// Far above any real telegram id this suite could meet on a shared database.
const TG = 8_800_000_000;
const TG_END = TG + 999_999;
let n = 0;

async function call(path: string, body: unknown): Promise<Response> {
  return await app.fetch(
    new Request(`https://example.com/api/v1/integrations/support${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(body),
    }),
    { ...env, SUPPORT_INTEGRATION_ENABLED: 'true', SUPPORT_INTEGRATION_TOKEN: TOKEN } as Env,
  );
}

async function ask(path: string, body: unknown): Promise<Record<string, unknown>> {
  return (await (await call(path, body)).json()) as Record<string, unknown>;
}

async function panel(code: string, config: Record<string, unknown>): Promise<number> {
  const row = await env.DB.prepare(
    `INSERT INTO provisioning_providers (code, name, kind, status, base_url, secret_ref, config)
     VALUES (?1, ?2, 'pasarguard', 'ACTIVE', 'https://panel.test', 'SUPPORT_TEST', ?3::jsonb)
     RETURNING id`,
  )
    .bind(`support-test-${code}`, code, JSON.stringify(config))
    .first<{ id: number }>();
  return row!.id;
}

async function product(
  code: string,
  providerId: number,
  description: string,
  status = 'ACTIVE',
  resellersOnly = false,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO product_categories (name) VALUES ('support-test') ON CONFLICT (name) DO NOTHING`,
  ).run();
  await env.DB.prepare(
    `INSERT INTO products (code, name, kind, provider_id, status, description, resellers_only, category_id)
     VALUES (?1, ?1, 'vpn', ?2, ?3, ?4, ?5,
             (SELECT id FROM product_categories WHERE name = 'support-test'))`,
  )
    .bind(`support-test-${code}`, providerId, status, description, resellersOnly)
    .run();
}

/**
 * A customer who, unless told otherwise, has passed the shop bot's doors: the
 * rules accepted and channel membership confirmed just now. `checkedAgo` is how
 * long ago the shop bot last confirmed it, or null for never.
 */
async function customer(
  opts: { used?: number; blocked?: boolean; rulesAccepted?: boolean; checkedAgo?: string | null } = {},
): Promise<{ tg: number; id: number }> {
  n += 1;
  const tg = TG + n;
  const row = await env.DB.prepare(
    `INSERT INTO users (telegram_id, registered_at, test_quota_used, status, rules_accepted,
                        channels_checked_at)
     VALUES (?1, now(), ?2, ?3, ?4, now() - ?5::interval) RETURNING id`,
  )
    .bind(
      tg,
      opts.used ?? 0,
      opts.blocked ? 'BLOCKED' : 'ACTIVE',
      opts.rulesAccepted ?? true,
      opts.checkedAgo === undefined ? '0 seconds' : opts.checkedAgo,
    )
    .first<{ id: number }>();
  return { tg, id: row!.id };
}

async function subscription(userId: number, status: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO subscriptions (public_id, user_id, plan_name_at_sale, price_irr, status, purchased_at)
     VALUES (?1, ?2, 'a service', 0, ?3, now())`,
  )
    .bind(`suptr${userId}${status}`.slice(0, 40), userId, status)
    .run();
}

async function order(userId: number, kind: string, status: string, providerId?: number): Promise<void> {
  const price = kind === 'TRIAL' ? 0 : 1_000_000;
  await env.DB.prepare(
    `INSERT INTO orders (public_id, user_id, kind, provider_id, unit_price_irr, total_irr, status)
     VALUES (?1, ?2, ?3, ?4, ?5, ?5, ?6)`,
  )
    .bind(`sto${userId}${kind}${status}`.slice(0, 40), userId, kind, providerId ?? null, price, status)
    .run();
}

async function setQuota(value: number | null): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM settings WHERE scope = 'bot' AND key = 'limit_usertest_all'`,
  ).run();
  if (value !== null) {
    await env.DB.prepare(
      `INSERT INTO settings (scope, key, value) VALUES ('bot', 'limit_usertest_all', to_jsonb(?1::int))`,
    )
      .bind(value)
      .run();
  }
}

async function trialOrders(userId: number): Promise<{ provider_id: number; status: string }[]> {
  const { results } = await env.DB.prepare(
    `SELECT provider_id::int AS provider_id, status FROM orders
      WHERE user_id = ?1 AND kind = 'TRIAL' ORDER BY id`,
  )
    .bind(userId)
    .all<{ provider_id: number; status: string }>();
  return results ?? [];
}

const NUMBERS = { trial_volume_gb: 0.2, trial_duration_hours: 2 };
const DIAMOND_WORDS = 'بدون قطعی - بسیار با کیفیت';
let savedQuota: string | null = null;
let diamond: number; // support door only
let both: number; // the shop's trial and the support door
let titanium: number; // shop trial only
let gold: number; // neither door

beforeAll(async () => {
  savedQuota =
    (
      await env.DB.prepare(
        `SELECT value #>> '{}' AS v FROM settings WHERE scope = 'bot' AND key = 'limit_usertest_all'`,
      ).first<{ v: string | null }>()
    )?.v ?? null;
  diamond = await panel('diamond', { ...NUMBERS, support_trial_enabled: true });
  both = await panel('both', { ...NUMBERS, trial_enabled: true, support_trial_enabled: true });
  titanium = await panel('titanium', { ...NUMBERS, trial_enabled: true });
  gold = await panel('gold', NUMBERS);
  await product('diamond-1', diamond, DIAMOND_WORDS);
  await product('diamond-off', diamond, 'a product the shop took down', 'DISABLED');
  await product('diamond-resellers', diamond, 'for resellers only', 'ACTIVE', true);
});
beforeEach(() => setQuota(1));
afterAll(async () => {
  const mine = `(SELECT id FROM users WHERE telegram_id BETWEEN ${TG} AND ${TG_END})`;
  await env.DB.prepare(`DELETE FROM orders WHERE user_id IN ${mine}`).run();
  await env.DB.prepare(`DELETE FROM subscriptions WHERE user_id IN ${mine}`).run();
  await env.DB.prepare(`DELETE FROM users WHERE telegram_id BETWEEN ?1 AND ?2`)
    .bind(TG, TG_END)
    .run();
  await env.DB.prepare(`DELETE FROM products WHERE code LIKE 'support-test-%'`).run();
  await env.DB.prepare(`DELETE FROM product_categories WHERE name = 'support-test'`).run();
  await env.DB.prepare(`DELETE FROM provisioning_providers WHERE code LIKE 'support-test-%'`).run();
  await setQuota(savedQuota === null ? null : Number(savedQuota));
});

describe('which trials a person may have', () => {
  it('asks a stranger to start the shop bot first', async () => {
    expect(await ask('/trial/options', { telegram_id: TG_END })).toMatchObject({
      ok: true,
      customer: 'not_started',
      services: [],
    });
  });

  it('says blocked for a blocked customer', async () => {
    const c = await customer({ blocked: true });
    expect(await ask('/trial/options', { telegram_id: c.tg })).toMatchObject({
      customer: 'blocked',
      services: [],
    });
  });

  it('lists only the panels with «تست از پشتیبانی» on, each with the shop’s own words', async () => {
    const c = await customer();
    const json = (await ask('/trial/options', { telegram_id: c.tg })) as {
      customer: string;
      services: { panel_id: number }[];
    };
    expect(json.customer).toBe('ok');
    const mine = json.services.filter((s) => [diamond, both, titanium, gold].includes(s.panel_id));
    expect(mine).toEqual([
      {
        panel_id: diamond,
        name: 'diamond',
        about: [DIAMOND_WORDS],
        volume_gb: 0.2,
        duration_hours: 2,
      },
      expect.objectContaining({ panel_id: both, about: [] }),
    ]);
  });

  it('hides a panel hidden from this customer', async () => {
    const c = await customer();
    await env.DB.prepare(`INSERT INTO provider_hidden_users (provider_id, user_id) VALUES (?1, ?2)`)
      .bind(diamond, c.id)
      .run();
    const json = (await ask('/trial/options', { telegram_id: c.tg })) as {
      services: { panel_id: number }[];
    };
    expect(json.services.map((s) => s.panel_id)).not.toContain(diamond);
  });

  it('turns away anyone who has had a service: running, ended, or paid and not yet delivered', async () => {
    for (const had of [
      (id: number) => subscription(id, 'ACTIVE'),
      (id: number) => subscription(id, 'DISABLED'),
      (id: number) => order(id, 'NEW_PURCHASE', 'PAID'),
    ]) {
      const c = await customer();
      await had(c.id);
      expect(await ask('/trial/options', { telegram_id: c.tg })).toEqual({
        ok: true,
        customer: 'not_new',
        services: [],
      });
    }
  });

  it('still counts as new: an unpaid invoice, a failed delivery, a wallet top-up', async () => {
    for (const had of [
      (id: number) => subscription(id, 'PENDING_PAYMENT'),
      (id: number) => subscription(id, 'FAILED'),
      (id: number) => order(id, 'WALLET_TOPUP', 'COMPLETED'),
    ]) {
      const c = await customer();
      await had(c.id);
      expect(await ask('/trial/options', { telegram_id: c.tg })).toMatchObject({ customer: 'ok' });
    }
  });

  it('turns away anyone who has had a trial, even after the counter was reset', async () => {
    const counted = await customer({ used: 1 });
    expect(await ask('/trial/options', { telegram_id: counted.tg })).toMatchObject({
      customer: 'already_used',
    });
    const reset = await customer();
    await order(reset.id, 'TRIAL', 'COMPLETED', diamond);
    expect(await ask('/trial/options', { telegram_id: reset.tg })).toMatchObject({
      customer: 'already_used',
    });
  });
});

describe('ordering a trial', () => {
  it('writes one PAID TRIAL order, spends the counter, and records that the support bot gave it', async () => {
    const c = await customer();
    const json = await ask('/trial', { telegram_id: c.tg, panel_id: diamond });
    expect(json).toEqual({
      ok: true,
      result: 'on_the_way',
      service: 'diamond',
      ref: expect.stringMatching(/^[0-9a-f]{10}$/),
    });
    expect(await trialOrders(c.id)).toEqual([{ provider_id: diamond, status: 'PAID' }]);
    const used = await env.DB.prepare(`SELECT test_quota_used FROM users WHERE id = ?1`)
      .bind(c.id)
      .first<{ test_quota_used: number }>();
    expect(used?.test_quota_used).toBe(1);
    const audit = await env.DB.prepare(
      `SELECT actor_role, after_json FROM audit_logs
        WHERE action = 'support.trial_ordered' AND entity_type = 'ORDER' AND entity_id = ?1`,
    )
      .bind(json['ref'])
      .first<{ actor_role: string; after_json: string }>();
    expect(audit?.actor_role).toBe('SYSTEM');
    expect(JSON.parse(audit!.after_json)).toEqual({
      telegram_id: c.tg,
      panel_id: diamond,
      service: 'diamond',
    });
  });

  it('gives the trial itself where the shop bot’s own trial is on too', async () => {
    const c = await customer();
    expect(await ask('/trial', { telegram_id: c.tg, panel_id: both })).toMatchObject({
      result: 'on_the_way',
      service: 'both',
    });
    expect(await trialOrders(c.id)).toEqual([{ provider_id: both, status: 'PAID' }]);
  });

  it('refuses a panel without «تست از پشتیبانی»: shop-only, closed, and one not on the list', async () => {
    const c = await customer();
    for (const panelId of [titanium, gold, 999_999_999]) {
      expect(await ask('/trial', { telegram_id: c.tg, panel_id: panelId })).toEqual({
        ok: true,
        result: 'not_available',
      });
    }
    expect(await trialOrders(c.id)).toEqual([]);
  });

  it('refuses a stranger and a blocked customer without writing anything', async () => {
    expect(await ask('/trial', { telegram_id: TG_END, panel_id: diamond })).toMatchObject({
      result: 'not_started',
    });
    const b = await customer({ blocked: true });
    expect(await ask('/trial', { telegram_id: b.tg, panel_id: diamond })).toMatchObject({
      result: 'blocked',
    });
    expect(await trialOrders(b.id)).toEqual([]);
  });

  it('refuses someone who has had a service, and writes nothing', async () => {
    const c = await customer();
    await subscription(c.id, 'ACTIVE');
    expect(await ask('/trial', { telegram_id: c.tg, panel_id: diamond })).toEqual({
      ok: true,
      result: 'not_new',
    });
    expect(await trialOrders(c.id)).toEqual([]);
  });

  it('counts a trial already taken in the shop bot — one per person across both doors', async () => {
    const c = await customer({ used: 1 });
    expect(await ask('/trial', { telegram_id: c.tg, panel_id: diamond })).toMatchObject({
      result: 'already_used',
    });
    expect(await trialOrders(c.id)).toEqual([]);
  });

  it('stays open when the shop has closed its own trials', async () => {
    await setQuota(0);
    const c = await customer();
    expect(await ask('/trial', { telegram_id: c.tg, panel_id: diamond })).toMatchObject({
      result: 'on_the_way',
    });
  });

  it('says «on the way» to a repeat within two minutes, and «used» after', async () => {
    const c = await customer();
    await ask('/trial', { telegram_id: c.tg, panel_id: diamond });
    expect(await ask('/trial', { telegram_id: c.tg, panel_id: both })).toEqual({
      ok: true,
      result: 'already_on_the_way',
      service: 'diamond',
    });
    await env.DB.prepare(
      `UPDATE orders SET created_at = created_at - interval '3 minutes' WHERE user_id = ?1`,
    )
      .bind(c.id)
      .run();
    expect(await ask('/trial', { telegram_id: c.tg, panel_id: diamond })).toMatchObject({
      result: 'already_used',
    });
    expect(await trialOrders(c.id)).toHaveLength(1);
  });

  it('does not call a trial that already failed «on the way»', async () => {
    // Final review, 2026-09-26: a trial the panel refused counted as «in the
    // last two minutes», so the customer was told it was coming. `fail()`
    // gives the counter back, as here.
    const c = await customer();
    await ask('/trial', { telegram_id: c.tg, panel_id: diamond });
    await env.DB.prepare(
      `UPDATE orders SET status = 'FAILED', failure_reason = 'panel refused'
        WHERE user_id = ?1 AND kind = 'TRIAL'`,
    )
      .bind(c.id)
      .run();
    await env.DB.prepare(`UPDATE users SET test_quota_used = 0 WHERE id = ?1`).bind(c.id).run();
    expect(await ask('/trial', { telegram_id: c.tg, panel_id: diamond })).toMatchObject({
      result: 'on_the_way',
    });
  });

  it('writes one order when several requests for one person arrive together', async () => {
    // Without the row lock the others would not wait for the first order, and
    // the counter's own guard would turn them into «used» — so «on the way»
    // four times is the lock's doing. The pool is warmed first — a request
    // that has to open a fresh connection starts after the other has already
    // committed, and then nothing overlaps and the test proves nothing (it
    // passed with the lock removed until this was added). Remove `FOR UPDATE`
    // from the route and this goes red.
    const c = await customer();
    await Promise.all(
      Array.from({ length: 6 }, () => env.DB.prepare(`SELECT pg_sleep(0.05)`).run()),
    );
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ask('/trial', { telegram_id: c.tg, panel_id: diamond })),
    );
    expect(results.filter((r) => r['result'] === 'on_the_way')).toHaveLength(1);
    expect(results.filter((r) => r['result'] === 'already_on_the_way')).toHaveLength(4);
    expect(await trialOrders(c.id)).toHaveLength(1);
  });
});

describe('the shop bot’s channel and rules come first', () => {
  // Sam, 2026-09-26: a trial from support passes the same two doors as the
  // shop bot. Only the shop bot can ask Telegram, so the door reads what it
  // last recorded and trusts it for as long as the shop bot does.
  const CHANNEL = {
    title: 'کانال آزمون پشتیبانی',
    chat_ref: '@support_test_channel',
    join_link: 'https://t.me/support_test_channel',
  };
  const SHOWN = { title: CHANNEL.title, join_link: CHANNEL.join_link };
  let savedRulesGate: string | null = null;

  async function setRulesGate(value: string | null): Promise<void> {
    await env.DB.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'roll_Status'`).run();
    if (value !== null) {
      await env.DB.prepare(
        `INSERT INTO settings (scope, key, value) VALUES ('bot', 'roll_Status', to_jsonb(?1::text))`,
      )
        .bind(value)
        .run();
    }
  }
  async function addChannel(): Promise<void> {
    await env.DB.prepare(
      `INSERT INTO required_channels (title, chat_ref, join_link) VALUES (?1, ?2, ?3)`,
    )
      .bind(CHANNEL.title, CHANNEL.chat_ref, CHANNEL.join_link)
      .run();
  }

  beforeAll(async () => {
    savedRulesGate =
      (
        await env.DB.prepare(
          `SELECT value #>> '{}' AS v FROM settings WHERE scope = 'bot' AND key = 'roll_Status'`,
        ).first<{ v: string | null }>()
      )?.v ?? null;
  });
  afterEach(async () => {
    await env.DB.prepare(`DELETE FROM required_channels WHERE chat_ref = ?1`)
      .bind(CHANNEL.chat_ref)
      .run();
    await setRulesGate(null);
  });
  afterAll(() => setRulesGate(savedRulesGate));

  it('sends someone the shop bot never confirmed to the channel, and orders nothing', async () => {
    await addChannel();
    const c = await customer({ checkedAgo: null });
    const options = await ask('/trial/options', { telegram_id: c.tg });
    expect(options).toMatchObject({ customer: 'join_channels', services: [] });
    expect(options['channels']).toContainEqual(SHOWN);
    const trial = await ask('/trial', { telegram_id: c.tg, panel_id: diamond });
    expect(trial).toMatchObject({ ok: true, result: 'join_channels' });
    expect(trial['channels']).toContainEqual(SHOWN);
    expect(await trialOrders(c.id)).toEqual([]);
  });

  it('does not send someone to a channel for a trial they cannot have', async () => {
    await addChannel();
    const c = await customer({ checkedAgo: null });
    await subscription(c.id, 'ACTIVE');
    expect(await ask('/trial/options', { telegram_id: c.tg })).toMatchObject({
      customer: 'not_new',
    });
    expect(await ask('/trial', { telegram_id: c.tg, panel_id: diamond })).toEqual({
      ok: true,
      result: 'not_new',
    });
  });

  it('trusts the shop bot’s confirmation for an hour, as the shop bot does', async () => {
    await addChannel();
    const stale = await customer({ checkedAgo: '61 minutes' });
    expect(await ask('/trial', { telegram_id: stale.tg, panel_id: diamond })).toMatchObject({
      result: 'join_channels',
    });
    const fresh = await customer({ checkedAgo: '59 minutes' });
    expect(await ask('/trial', { telegram_id: fresh.tg, panel_id: diamond })).toMatchObject({
      result: 'on_the_way',
    });
  });

  it('asks for the rules while the shop bot asks for them, and not after they are accepted', async () => {
    await setRulesGate('rolleon');
    const c = await customer({ rulesAccepted: false });
    expect(await ask('/trial/options', { telegram_id: c.tg })).toMatchObject({
      customer: 'accept_rules',
      services: [],
    });
    expect(await ask('/trial', { telegram_id: c.tg, panel_id: diamond })).toEqual({
      ok: true,
      result: 'accept_rules',
    });
    expect(await trialOrders(c.id)).toEqual([]);
    await env.DB.prepare(`UPDATE users SET rules_accepted = true WHERE id = ?1`).bind(c.id).run();
    expect(await ask('/trial', { telegram_id: c.tg, panel_id: diamond })).toMatchObject({
      result: 'on_the_way',
    });
  });

  it('does not ask for rules the shop has switched off', async () => {
    const c = await customer({ rulesAccepted: false });
    expect(await ask('/trial/options', { telegram_id: c.tg })).toMatchObject({ customer: 'ok' });
  });

  it('asks for the channel before the rules, as the shop bot does', async () => {
    await addChannel();
    await setRulesGate('rolleon');
    const c = await customer({ rulesAccepted: false, checkedAgo: null });
    expect(await ask('/trial/options', { telegram_id: c.tg })).toMatchObject({
      customer: 'join_channels',
    });
  });
});
