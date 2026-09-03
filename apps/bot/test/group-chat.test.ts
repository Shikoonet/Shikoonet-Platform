/**
 * The bot answers one-to-one chats and nothing else.
 *
 * This is not a preference, it is what makes the report topics safe to build.
 * `handleUpdate` reads `chat.id` the same way whatever the chat is, `upsertUser`
 * writes a customer row for whoever sent the update, and every reply is
 * addressed back to the chat it came from. Put this bot in a group and, without
 * the guard, the group's members become customers and the group gets the buy
 * menu drawn into it.
 *
 * The assertions are therefore about the DATABASE, not about the reply: a test
 * that only checked `replies` would pass against a guard that still wrote the
 * user row.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 8, 3, 9, 0, 0);

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 970_000 + n, telegramId: 990_000 + n };
}

function says(
  updateId: number,
  telegramId: number,
  chatType: string | undefined,
  chatId = telegramId,
): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: chatId, ...(chatType === undefined ? {} : { type: chatType }) },
      from: { id: telegramId, username: `grp${telegramId}` },
      text: '/start',
    },
  };
}

function presses(updateId: number, telegramId: number, chatType: string, chatId: number): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `grp${telegramId}` },
      message: { message_id: 3, chat: { id: chatId, type: chatType } },
      data: 'menu',
    },
  };
}

async function userExists(telegramId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS hit FROM users WHERE telegram_id = ?1`)
    .bind(telegramId)
    .first<{ hit: number }>();
  return row !== null;
}

async function updateClaimed(updateId: number): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS hit FROM telegram_updates WHERE update_id = ?1`)
    .bind(updateId)
    .first<{ hit: number }>();
  return row !== null;
}

beforeAll(async () => {
  await ensureCatalog();
});

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a chat that is not private', () => {
  // The group id is deliberately not the sender's: that is the shape a real
  // group message has, and the shape that would have been replied INTO.
  for (const type of ['group', 'supergroup', 'channel']) {
    it(`ignores a message from a ${type} without writing anything`, async () => {
      const { updateId, telegramId } = ids();

      const out = await handleUpdate(db, says(updateId, telegramId, type, -100_500 - updateId));

      expect(out.status).toBe('ignored');
      expect(out.replies).toEqual([]);
      // The two rows the unguarded path would have written.
      expect(await userExists(telegramId)).toBe(false);
      expect(await updateClaimed(updateId)).toBe(false);
    });
  }

  it('ignores a button pressed on a message the bot posted into a group', async () => {
    const { updateId, telegramId } = ids();

    const out = await handleUpdate(db, presses(updateId, telegramId, 'supergroup', -100_777));

    expect(out.status).toBe('ignored');
    expect(out.replies).toEqual([]);
    expect(await userExists(telegramId)).toBe(false);
  });
});

describe('a private chat', () => {
  it('is answered, and is what every other fixture in this suite relies on', async () => {
    const { updateId, telegramId } = ids();

    const out = await handleUpdate(db, says(updateId, telegramId, 'private'));

    expect(out.status).toBe('processed');
    expect(out.replies.length).toBeGreaterThan(0);
    expect(await userExists(telegramId)).toBe(true);
  });

  /**
   * Absent is private. Telegram always sends `chat.type`, so this case does not
   * arise in production — it is here because the fifty fixtures written before
   * the field existed depend on it, and a change that made absent mean "public"
   * would turn all of them into silently ignored updates rather than failures.
   */
  it('is what a fixture with no chat.type at all still gets', async () => {
    const { updateId, telegramId } = ids();

    const out = await handleUpdate(db, says(updateId, telegramId, undefined));

    expect(out.status).toBe('processed');
    expect(await userExists(telegramId)).toBe(true);
  });
});
