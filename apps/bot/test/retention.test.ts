/**
 * «یادآوری تمدید» — the operator's rule reaches the right person once.
 *
 * The rule lives in a settings row; the code lives in `discount_codes`; the
 * record of having spoken is the outbox row. Every assertion reads one of
 * those tables back rather than trusting a return value, and «once» is the
 * one that matters: a retention message sent every 25 seconds is the fastest
 * way to lose the customer it was meant to keep.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { remindToRenew } from '../src/retention.js';
import { db, pendingNotifications } from './helpers/env.js';
import { invalidateShopSettings, loadShopSettings, setReportChatIdFallback } from '../src/settings.js';
import { buildDailyReport } from '../src/report.js';
import { ensureCatalog, makeCustomer, providerId } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 8, 20, 12, 0, 0);
const DAY = 86_400_000;

let seq = 0;
function nextTelegramId(): number {
  seq += 1;
  return 740_000 + seq * 7;
}

interface Service {
  expiresInDays: number;
  provider?: string;
  status?: string;
  /** Written as a TRIAL order's delivery. */
  trial?: boolean;
}

async function makeService(userId: number, s: Service): Promise<number> {
  let orderId: number | null = null;
  if (s.trial) {
    const o = await db
      .prepare(
        `INSERT INTO orders
           (public_id, user_id, kind, provider_id, unit_price_irr, discount_irr, total_irr,
            quantity, status, completed_at)
         VALUES (?1, ?2, 'TRIAL', ?3, 0, 0, 0, 1, 'COMPLETED', now()) RETURNING id`,
      )
      .bind(`zz-ret-trial-${userId}-${seq}`, userId, await providerId(s.provider ?? 'sim-vip'))
      .first<{ id: number }>();
    orderId = o?.id ?? null;
  }
  seq += 1;
  const row = await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, plan_name_at_sale, price_irr, remote_username, status,
          purchased_at, expires_at, provider_id, order_id)
       VALUES (?1, ?2, 'یک‌ماهه-100.000ت', 1000000, ?3, ?4, ?5, ?6, ?7, ?8)
       RETURNING id`,
    )
    .bind(
      `zz-ret-${userId}-${seq}`,
      userId,
      `u_ret_${userId}_${seq}`,
      s.status ?? 'ACTIVE',
      new Date(NOW_MS - 30 * DAY).toISOString(),
      new Date(NOW_MS + s.expiresInDays * DAY).toISOString(),
      await providerId(s.provider ?? 'sim-vip'),
      orderId,
    )
    .first<{ id: number }>();
  if (!row) throw new Error('retention fixture failed');
  return row.id;
}

interface RuleInput {
  key?: string;
  name?: string;
  enabled?: boolean;
  provider?: string;
  daysBefore?: number;
  daysAfter?: number;
  onlyService?: boolean;
  codeId?: number | null;
  text?: string;
}

async function setRules(rules: RuleInput[]): Promise<void> {
  const items = await Promise.all(
    rules.map(async (r, i) => ({
      key: r.key ?? `rule_${i}`,
      name: r.name ?? `قانون ${i}`,
      enabled: r.enabled ?? true,
      providerId: await providerId(r.provider ?? 'sim-vip'),
      daysBefore: r.daysBefore ?? 1,
      daysAfter: r.daysAfter ?? 0,
      onlyService: r.onlyService ?? false,
      codeId: r.codeId ?? null,
      text: r.text ?? 'سرویس {service} — {days} روز — {username} — {code} — {renewButton}',
    })),
  );
  await db
    .prepare(
      `INSERT INTO settings (scope, key, value) VALUES ('bot', 'retention_rules', ?1::jsonb)
       ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value`,
    )
    .bind(JSON.stringify(items))
    .run();
}

async function makeCode(code: string, opts: { status?: string; expired?: boolean; maxUses?: number | null } = {}): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO discount_codes (code, kind, percent, status, expires_at, max_uses, applies_to)
       VALUES (?1, 'PERCENT_OFF', 30, ?2, ?3, ?4, 'RENEW') RETURNING id`,
    )
    .bind(
      code,
      opts.status ?? 'ACTIVE',
      opts.expired ? new Date(NOW_MS - DAY).toISOString() : null,
      opts.maxUses ?? null,
    )
    .first<{ id: number }>();
  if (!row) throw new Error('code fixture failed');
  return row.id;
}

async function messagesTo(telegramId: number): Promise<{ text: string; dedupeKey: string }[]> {
  return (await pendingNotifications()).filter((n) => n.chatId === telegramId);
}

beforeAll(ensureCatalog);

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  await db.prepare(`DELETE FROM bot_notifications`).run();
  await db.prepare(`DELETE FROM subscriptions WHERE public_id LIKE 'zz-ret-%'`).run();
  await db.prepare(`DELETE FROM orders WHERE public_id LIKE 'zz-ret-%'`).run();
  await db.prepare(`DELETE FROM discount_codes WHERE code LIKE 'RET%'`).run();
  await db.prepare(`DELETE FROM users WHERE telegram_id BETWEEN 740000 AND 749999`).run();
  await db.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'retention_rules'`).run();
  invalidateShopSettings();
});

afterEach(async () => {
  vi.restoreAllMocks();
  setReportChatIdFallback(null);
  // The row is shared with every other bot suite on this database, and a
  // rule left on here is a fourth nightly message in `report.test.ts`.
  await db.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'retention_rules'`).run();
});

describe('nothing to do', () => {
  it('no row, empty list, or every rule off: sends nothing', async () => {
    const tg = nextTelegramId();
    const uid = await makeCustomer(tg);
    await makeService(uid, { expiresInDays: 0.5 });

    expect(await remindToRenew(db)).toBe(0);
    await setRules([]);
    expect(await remindToRenew(db)).toBe(0);
    await setRules([{ enabled: false }]);
    expect(await remindToRenew(db)).toBe(0);
    expect(await messagesTo(tg)).toHaveLength(0);
  });

  it('an unreadable row is «no rules», not half a list', async () => {
    await db
      .prepare(
        `INSERT INTO settings (scope, key, value) VALUES ('bot', 'retention_rules', '[{"key":"x"}]'::jsonb)`,
      )
      .run();
    expect(await remindToRenew(db)).toBe(0);
  });
});

describe('who is due', () => {
  it('the window before expiry, on the named panel only', async () => {
    const inWindow = nextTelegramId();
    const tooEarly = nextTelegramId();
    const otherPanel = nextTelegramId();
    await makeService(await makeCustomer(inWindow), { expiresInDays: 0.5 });
    await makeService(await makeCustomer(tooEarly), { expiresInDays: 3 });
    await makeService(await makeCustomer(otherPanel), { expiresInDays: 0.5, provider: 'sim-gold' });
    await setRules([{ daysBefore: 1 }]);

    expect(await remindToRenew(db)).toBe(1);
    expect(await messagesTo(inWindow)).toHaveLength(1);
    expect(await messagesTo(tooEarly)).toHaveLength(0);
    expect(await messagesTo(otherPanel)).toHaveLength(0);
  });

  it('«days after» reaches a service that already ran out', async () => {
    const lapsed = nextTelegramId();
    const longGone = nextTelegramId();
    await makeService(await makeCustomer(lapsed), { expiresInDays: -2 });
    await makeService(await makeCustomer(longGone), { expiresInDays: -10 });
    await setRules([{ daysBefore: 0, daysAfter: 3 }]);

    expect(await remindToRenew(db)).toBe(1);
    const [m] = await messagesTo(lapsed);
    expect(m?.text).toContain('2 روز');
    expect(await messagesTo(longGone)).toHaveLength(0);
  });

  it('«only one service»: a second paid service excludes, a trial does not', async () => {
    const solo = nextTelegramId();
    const repeat = nextTelegramId();
    const triedFirst = nextTelegramId();
    await makeService(await makeCustomer(solo), { expiresInDays: 0.5 });
    const repeatId = await makeCustomer(repeat);
    await makeService(repeatId, { expiresInDays: 0.5 });
    await makeService(repeatId, { expiresInDays: 20, provider: 'sim-gold' });
    const triedId = await makeCustomer(triedFirst);
    await makeService(triedId, { expiresInDays: 0.5 });
    await makeService(triedId, { expiresInDays: 20, trial: true });
    await setRules([{ onlyService: true }]);

    expect(await remindToRenew(db)).toBe(2);
    expect(await messagesTo(solo)).toHaveLength(1);
    expect(await messagesTo(repeat)).toHaveLength(0);
    expect(await messagesTo(triedFirst)).toHaveLength(1);

    // And without the tick, the repeat buyer is in.
    await db.prepare(`DELETE FROM bot_notifications`).run();
    await setRules([{ onlyService: false }]);
    expect(await remindToRenew(db)).toBe(3);
  });

  it('respects the customer\'s own notify switch', async () => {
    const tg = nextTelegramId();
    const uid = await makeCustomer(tg);
    await db.prepare(`UPDATE users SET notify_enabled = false WHERE id = ?1`).bind(uid).run();
    await makeService(uid, { expiresInDays: 0.5 });
    await setRules([{}]);
    expect(await remindToRenew(db)).toBe(0);
  });
});

describe('once per expiry', () => {
  it('a second sweep sends nothing; a renewal earns a new message', async () => {
    const tg = nextTelegramId();
    const subId = await makeService(await makeCustomer(tg), { expiresInDays: 0.5 });
    await setRules([{ key: 'k1' }]);

    expect(await remindToRenew(db)).toBe(1);
    expect(await remindToRenew(db)).toBe(0);
    expect(await messagesTo(tg)).toHaveLength(1);

    // The outbox row is the record even after it was sent.
    await db.prepare(`UPDATE bot_notifications SET status = 'SENT', sent_at = now()`).run();
    expect(await remindToRenew(db)).toBe(0);

    // Renewed: 30 more days. Out of the window now, then back in it later.
    await db
      .prepare(`UPDATE subscriptions SET expires_at = ?2 WHERE id = ?1`)
      .bind(subId, new Date(NOW_MS + 30.5 * DAY).toISOString())
      .run();
    expect(await remindToRenew(db)).toBe(0);
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + 30 * DAY);
    expect(await remindToRenew(db, NOW_MS + 30 * DAY)).toBe(1);
    const keys = (await db.prepare(`SELECT dedupe_key FROM bot_notifications WHERE dedupe_key LIKE 'retention:k1:%' ORDER BY id`).all<{ dedupe_key: string }>()).results ?? [];
    expect(keys).toHaveLength(2);
    expect(keys[0]?.dedupe_key).not.toBe(keys[1]?.dedupe_key);
  });
});

describe('the text', () => {
  it('fills every placeholder and leaves an unknown one literal', async () => {
    const tg = nextTelegramId();
    const uid = await makeCustomer(tg);
    await makeService(uid, { expiresInDays: 0.5 });
    const codeId = await makeCode('RET30');
    await setRules([{ codeId, text: '{service}|{days}|{username}|{code}|{renewButton}|{nope}' }]);

    expect(await remindToRenew(db)).toBe(1);
    const [m] = await messagesTo(tg);
    const parts = m!.text.split('|');
    expect(parts[0]).toBe('یک‌ماهه');
    expect(parts[1]).toBe('1');
    expect(parts[2]).toMatch(/^u_ret_/);
    expect(parts[3]).toBe('RET30');
    expect(parts[4]).not.toBe('');
    expect(parts[5]).toBe('{nope}');
  });

  it('a code the customer could not use stops the rule, loudly, and sends nothing', async () => {
    const tg = nextTelegramId();
    await makeService(await makeCustomer(tg), { expiresInDays: 0.5 });
    const disabled = await makeCode('RETOFF', { status: 'DISABLED' });
    await setRules([{ codeId: disabled }]);
    expect(await remindToRenew(db)).toBe(0);
    expect(await messagesTo(tg)).toHaveLength(0);

    const expired = await makeCode('RETOLD', { expired: true });
    await setRules([{ codeId: expired }]);
    expect(await remindToRenew(db)).toBe(0);

    const gone = await makeCode('RETGONE');
    await setRules([{ codeId: gone + 1_000_000 }]);
    expect(await remindToRenew(db)).toBe(0);
  });
});

describe('the button', () => {
  it('opens this service\'s renewal — the rnw callback with the subscription id', async () => {
    const tg = nextTelegramId();
    const subId = await makeService(await makeCustomer(tg), { expiresInDays: 0.5 });
    await setRules([{}]);
    expect(await remindToRenew(db)).toBe(1);
    const row = await db
      .prepare(`SELECT reply_markup FROM bot_notifications WHERE chat_id = ?1`)
      .bind(tg)
      // The bare keyboard, as `notify.ts` stores it — the envelope is sendMessage's.
      .first<{ reply_markup: { text: string; callback_data: string }[][] }>();
    expect(row?.reply_markup).toHaveLength(1);
    expect(row?.reply_markup[0]?.[0]?.callback_data).toBe(`rnw:${subId}`);
    expect(row?.reply_markup[0]?.[0]?.text).not.toBe('');
  });
});

describe('the group hears about it', () => {
  const CHANNEL = -1_009_900_770;

  it('every send is one notice in «📝 گزارش اطلاع رسانی ها», keyed like the send', async () => {
    // The sim carries the shop's own `Channel_Report`; the fallback only
    // fills in when it does not. Ask the settings which one wins.
    setReportChatIdFallback(CHANNEL);
    const channel = (await loadShopSettings(db)).reportChatId;
    expect(channel).not.toBeNull();
    const tg = nextTelegramId();
    await makeService(await makeCustomer(tg), { expiresInDays: 0.5 });
    const codeId = await makeCode('RETRPT');
    await setRules([{ key: 'rk', name: 'قانون گزارش', codeId }]);

    expect(await remindToRenew(db)).toBe(1);
    const toGroup = (await pendingNotifications()).filter((n) => n.chatId === channel);
    expect(toGroup).toHaveLength(1);
    expect(toGroup[0]?.dedupeKey).toMatch(/^report:reportcron:retention:rk:\d+:\d+$/);
    expect(toGroup[0]?.text).toContain('قانون گزارش');
    expect(toGroup[0]?.text).toContain('RETRPT');
    expect(toGroup[0]?.text).toContain('1 روز مانده');
  });

  it('the nightly report grows a fourth message only while a rule is on', async () => {
    expect(await buildDailyReport(db, '2026-09-19')).toHaveLength(3);
    await setRules([{ key: 'rn', name: 'قانون شب', enabled: false }]);
    expect(await buildDailyReport(db, '2026-09-19')).toHaveLength(3);

    await setRules([{ key: 'rn', name: 'قانون شب' }]);
    const tg = nextTelegramId();
    await makeService(await makeCustomer(tg), { expiresInDays: 0.5 });
    await remindToRenew(db);
    await db.prepare(`UPDATE bot_notifications SET status = 'SENT', sent_at = now()`).run();

    const parts = await buildDailyReport(db, '2026-09-19');
    expect(parts).toHaveLength(4);
    expect(parts[3]).toContain('قانون شب');
    expect(parts[3]).toContain('فرستاده 1');
    expect(parts[3]).toContain('هنوز 1');
  });
});
