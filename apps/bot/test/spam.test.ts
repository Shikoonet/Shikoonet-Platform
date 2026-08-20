/**
 * The flood guard, against the database and against the PHP.
 *
 * Two things are worth proving and they are not the same. That 35 messages in
 * a minute ends in a block — and that 34 does not, that an admin is exempt, and
 * that the minute really is a window rather than a running total. A guard that
 * blocks too eagerly is worse than none: it cuts a paying customer off from the
 * only way they can reach the shop.
 *
 * The threshold itself is measured against `legacy/mirzabot-php/index.php`,
 * because that is where the number lives — there is no column for it in
 * `setting`, so the PHP source IS the outside truth and a constant asserted
 * against a comment would agree with itself for ever (rule 6).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import { SPAM_LIMIT, SPAM_WINDOW_MS, resetSpamWindows } from '../src/spam.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer } from './helpers/shop.js';
import { invalidateShopSettings } from '../src/settings.js';

const NOW_MS = Date.UTC(2026, 7, 20, 9, 0, 0);

let seq = 0;
function ids(): { updateId: number; telegramId: number } {
  seq += 1;
  return { updateId: 991_000 + seq * 4, telegramId: 866_000 + seq * 7 };
}

function text(updateId: number, telegramId: number, body = 'سلام') {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: telegramId, username: `sp${telegramId}` },
      chat: { id: telegramId },
      text: body,
    },
  };
}

async function makeAdmin(telegramId: number): Promise<void> {
  await makeCustomer(telegramId);
  await db
    .prepare(
      `INSERT INTO admins (telegram_id, username, role, permissions, active)
       VALUES (?1, ?2, 'ADMIN', '{}'::jsonb, true)
       ON CONFLICT (telegram_id) DO UPDATE SET active = true`,
    )
    .bind(telegramId, `adm${telegramId}`)
    .run();
}

/** Sends `count` ordinary messages and returns the outcome of the last one. */
async function flood(telegramId: number, count: number, from = 0) {
  let last;
  for (let i = 0; i < count; i += 1) {
    last = await handleUpdate(db, text(991_500_000 + telegramId * 100 + from + i, telegramId));
  }
  return last!;
}

async function statusOf(telegramId: number): Promise<{ status: string; reason: string | null }> {
  const row = await db
    .prepare(`SELECT status, blocked_reason AS reason FROM users WHERE telegram_id = ?1`)
    .bind(telegramId)
    .first<{ status: string; reason: string | null }>();
  return row ?? { status: 'missing', reason: null };
}

beforeAll(async () => {
  await ensureCatalog();
});

beforeEach(async () => {
  resetSpamWindows();
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  await db.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'Channel_Report'`).run();
  // The loader caches for thirty seconds, so a row written by a test is
  // invisible to the very update that test is about.
  invalidateShopSettings();
  // Another file's outbox rows are none of this file's business, but its own
  // from a previous test are: every count below is scoped to `spam:`.
  await db.prepare(`DELETE FROM bot_notifications WHERE dedupe_key LIKE 'spam:%'`).run();
});

/** The queued reports, with the keyboard `pendingNotifications` does not carry. */
async function spamReports(): Promise<
  { chatId: number; text: string; markup: string | null }[]
> {
  const { results } = await db
    .prepare(
      `SELECT chat_id, body, reply_markup::text AS markup FROM bot_notifications
        WHERE dedupe_key LIKE 'spam:%' ORDER BY id`,
    )
    .all<{ chat_id: number; body: string; markup: string | null }>();
  return (results ?? []).map((r) => ({ chatId: r.chat_id, text: r.body, markup: r.markup }));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the threshold is the legacy’s', () => {
  it('matches the two numbers hardcoded in index.php', () => {
    // Not a comment citing them — the file itself. If `legacy/` is ever removed
    // this must be turned into a pinned literal deliberately, not discovered
    // when the guard has quietly drifted.
    const php = readFileSync(
      fileURLToPath(new URL('../../../legacy/mirzabot-php/index.php', import.meta.url)),
      'utf8',
    );
    const spam = php.slice(php.indexOf('#---------anti spam--------------#'));
    expect(spam.slice(0, 900)).toContain(`>= "${SPAM_LIMIT}"`);
    // `floor($TimeLastMessage / 60) >= 1` — sixty seconds.
    expect(spam.slice(0, 900)).toMatch(/\/\s*60\)\s*>=\s*1/);
    expect(SPAM_WINDOW_MS).toBe(60 * 1000);
  });
});

describe('flooding the bot', () => {
  it('lets the limit through and blocks the one after it', async () => {
    const { telegramId } = ids();
    await makeCustomer(telegramId);

    await flood(telegramId, SPAM_LIMIT);
    // Exactly at the limit the customer is still a customer. This is the half
    // that matters commercially — the other half only costs a spammer.
    expect((await statusOf(telegramId)).status).toBe('ACTIVE');

    const over = await flood(telegramId, 1, SPAM_LIMIT);
    const after = await statusOf(telegramId);
    expect(after.status).toBe('BLOCKED');
    expect(after.reason).toContain('flooding');
    // Told once, at the moment it happens.
    expect(over.replies[0]?.text).toContain('مسدود');
  });

  it('forgets the count once the window has passed', async () => {
    const { telegramId } = ids();
    await makeCustomer(telegramId);

    await flood(telegramId, SPAM_LIMIT, 0);
    // A minute later, measured on the clock the guard reads rather than by
    // waiting: the same customer starts from nothing.
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS + SPAM_WINDOW_MS + 1);
    await flood(telegramId, SPAM_LIMIT, 1_000);

    expect((await statusOf(telegramId)).status).toBe('ACTIVE');
  });

  it('does not count an admin walking the panel fast', async () => {
    const { telegramId } = ids();
    await makeAdmin(telegramId);

    await flood(telegramId, SPAM_LIMIT * 2);

    expect((await statusOf(telegramId)).status).toBe('ACTIVE');
  });
});

describe('telling the shop', () => {
  const CHANNEL = -1001999888777;

  beforeEach(async () => {
    await db
      .prepare(
        `INSERT INTO settings (scope, key, value) VALUES ('bot', 'Channel_Report', ?1::jsonb)
         ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
      )
      .bind(JSON.stringify(String(CHANNEL)))
      .run();
    invalidateShopSettings();
  });

  it('queues one report, naming the customer and carrying a way to reach them', async () => {
    const { telegramId } = ids();
    const userId = await makeCustomer(telegramId);

    await flood(telegramId, SPAM_LIMIT + 1);

    const notes = await spamReports();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.chatId).toBe(CHANNEL);
    expect(notes[0]?.text).toContain(String(telegramId));
    // The button opens OUR admin user screen, by internal id — the same action
    // an operator would reach by searching, so it re-checks their permission.
    expect(notes[0]?.markup).toContain(`usr:${userId}`);
  });

  it('says nothing more about a customer who is already blocked', async () => {
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    await db
      .prepare(`UPDATE users SET status = 'BLOCKED' WHERE telegram_id = ?1`)
      .bind(telegramId)
      .run();

    await flood(telegramId, SPAM_LIMIT + 1);

    // An operator who unblocks somebody must not be told again on the next
    // message that they were blocked.
    expect(await spamReports()).toHaveLength(0);
  });

  it('blocks with no report channel configured, rather than not blocking', async () => {
    await db.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'Channel_Report'`).run();
    invalidateShopSettings();
    const { telegramId } = ids();
    await makeCustomer(telegramId);

    await flood(telegramId, SPAM_LIMIT + 1);

    expect((await statusOf(telegramId)).status).toBe('BLOCKED');
    expect(await spamReports()).toEqual([]);
  });
});
