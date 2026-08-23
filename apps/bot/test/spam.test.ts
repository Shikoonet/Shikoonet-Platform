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

import { existsSync, readFileSync } from 'node:fs';
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
  // Between tests, not between runs: `resetBot()` truncates `admins` once per
  // file now (see `helpers/env.ts`), which is what stops a row from a PREVIOUS
  // run making a plain customer an admin here. This line is the same guard for
  // the file's own earlier tests.
  await db.prepare(`DELETE FROM admins WHERE telegram_id BETWEEN 866000 AND 867000`).run();
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
async function spamReports(): Promise<{ chatId: number; text: string; markup: string | null }[]> {
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

/**
 * `legacy/` is in `.gitignore` and has never been part of a clone.
 *
 * The assertion below wanted the PHP itself rather than a comment quoting it,
 * which is right — but it read the file unconditionally, and on CI the file is
 * simply not there. Every run from 2026-08-20 died on
 * `ENOENT: legacy/mirzabot-php/index.php`, and since `pnpm -r` stops at the
 * first failing package, a great deal else stopped being checked behind it.
 *
 * The original comment anticipated half of this: "if `legacy/` is ever removed
 * this must be turned into a pinned literal deliberately". The case it missed
 * is that on a fresh checkout it was never present to begin with. So the check
 * runs where the reference exists and is reported as SKIPPED where it does not
 * — the same shape `packages/db/test/hub-sql.test.ts` already uses for the same
 * reason. A skip that vitest prints is a different thing from a check nobody
 * knows stopped happening.
 */
const PHP = fileURLToPath(new URL('../../../legacy/mirzabot-php/index.php', import.meta.url));
const phpPresent = existsSync(PHP);

describe('the threshold is the legacy’s', () => {
  it.skipIf(!phpPresent)('matches the two numbers hardcoded in index.php', () => {
    // Not a comment citing them — the file itself.
    const php = readFileSync(PHP, 'utf8');
    const marker = php.indexOf('#---------anti spam--------------#');
    // A missing marker would make both assertions below run against an empty
    // string and pass, which is exactly the silent green this file exists to
    // prevent.
    expect(marker, 'the anti-spam block is no longer in index.php').toBeGreaterThan(-1);
    const spam = php.slice(marker);
    expect(spam.slice(0, 900)).toContain(`>= "${SPAM_LIMIT}"`);
    // `floor($TimeLastMessage / 60) >= 1` — sixty seconds.
    expect(spam.slice(0, 900)).toMatch(/\/\s*60\)\s*>=\s*1/);
  });

  it('pins the window at sixty seconds', () => {
    // Kept outside the skip: this half needs no PHP, so letting it disappear
    // with `legacy/` would trade a check for nothing.
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

  it('charges one token for an update, however many times it is delivered', async () => {
    // The counter is in memory; the update's claim is in a transaction. A
    // handler that throws rolls the claim back, Telegram redelivers the same
    // update, and the claim succeeds again — but the token spent on the first
    // attempt is not given back. Up to MAX_UPDATE_ATTEMPTS, so one message
    // could cost three of thirty-five and a short database outage was enough to
    // block a customer for traffic they never sent.
    //
    // Deleting the claim row is exactly what that ROLLBACK leaves behind, which
    // is why the redelivery is simulated that way rather than by calling an
    // internal twice.
    const { telegramId } = ids();
    await makeCustomer(telegramId);
    await flood(telegramId, SPAM_LIMIT - 1);

    const retried = 991_900_000 + telegramId;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await handleUpdate(db, text(retried, telegramId));
      await db.prepare(`DELETE FROM telegram_updates WHERE update_id = ?1`).bind(retried).run();
    }

    // Thirty-four plus one message is thirty-five, which is the limit, not past
    // it. Three deliveries of that one message must not be thirty-seven.
    expect((await statusOf(telegramId)).status).toBe('ACTIVE');

    // And the counter is still counting: a genuinely new message is the
    // thirty-sixth and does end in a block.
    //
    // Numbered off `retried` rather than through `flood`, whose ids are
    // `telegramId * 100 + from` — customers here are seven apart, so only seven
    // hundred ids belong to each one and a large `from` lands inside another
    // customer's range. An id another test has already claimed returns
    // `duplicate` above the counter and charges nothing.
    await handleUpdate(db, text(retried + 1, telegramId));
    expect((await statusOf(telegramId)).status).toBe('BLOCKED');
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

  it('queues one report, naming the customer, with nothing to press', async () => {
    const { telegramId } = ids();
    await makeCustomer(telegramId);

    await flood(telegramId, SPAM_LIMIT + 1);

    const notes = await spamReports();
    expect(notes).toHaveLength(1);
    expect(notes[0]?.chatId).toBe(CHANNEL);
    // The id, because that is what an operator types into «کاربران» to find
    // them. The report used to carry an «open this user» button into the bot's
    // own admin panel; that panel is the dashboard now, and a button pointing
    // at a screen that no longer exists reads as a broken bot rather than as a
    // screen that moved.
    expect(notes[0]?.text).toContain(String(telegramId));
    expect(notes[0]?.markup ?? null).toBeNull();
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
