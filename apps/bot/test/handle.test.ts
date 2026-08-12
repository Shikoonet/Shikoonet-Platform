import { describe, expect, it } from 'vitest';
import type { D1Database, D1DatabaseSession, D1PreparedStatement } from '@shikoo/database';
import { handleUpdate } from '../src/handle.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';

/**
 * Ids are unique per test rather than reset between them: the suite shares one
 * Postgres with every other package, and a test that depends on an empty table
 * is a test that fails for someone else's reason.
 */
let nextId = 1;
/** Blocks of 10, because several tests use `updateId + 1` as a second delivery. */
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 900_000 + n, telegramId: 500_000 + n };
}

function startUpdate(updateId: number, telegramId: number, text = '/start'): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: telegramId, username: `user${telegramId}` },
      chat: { id: telegramId },
      text,
    },
  };
}

async function countUpdate(updateId: number): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*)::int AS n FROM telegram_updates WHERE update_id = ?1`)
    .bind(updateId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function userRow(telegramId: number) {
  return db
    .prepare(`SELECT id, username, status, lang, last_seen_at FROM users WHERE telegram_id = ?1`)
    .bind(telegramId)
    .first<{
      id: number;
      username: string | null;
      status: string;
      lang: string;
      last_seen_at: string;
    }>();
}

describe('/start', () => {
  it('creates the customer, resets the session, and greets them', async () => {
    const { updateId, telegramId } = ids();

    const outcome = await handleUpdate(db, startUpdate(updateId, telegramId));

    expect(outcome.status).toBe('processed');
    expect(outcome.replies).toHaveLength(1);
    expect(outcome.replies[0]?.chatId).toBe(telegramId);
    expect(outcome.replies[0]?.text).toContain('شیکو');

    const user = await userRow(telegramId);
    expect(user?.username).toBe(`user${telegramId}`);
    expect(user?.status).toBe('ACTIVE');

    const session = await db
      .prepare(`SELECT step, data FROM bot_sessions WHERE user_id = ?1`)
      .bind(user?.id)
      .first<{ step: string | null; data: unknown }>();
    expect(session).not.toBeNull();
    expect(session?.step).toBeNull();
  });

  it('abandons a half-finished flow', async () => {
    const { updateId, telegramId } = ids();
    await handleUpdate(db, startUpdate(updateId, telegramId));
    const user = await userRow(telegramId);

    await db
      .prepare(
        `UPDATE bot_sessions SET step = 'AWAITING_RECEIPT', data = '{"orderId":7}'::jsonb WHERE user_id = ?1`,
      )
      .bind(user?.id)
      .run();

    await handleUpdate(db, startUpdate(updateId + 100_000, telegramId));

    const session = await db
      .prepare(`SELECT step, data::text AS data FROM bot_sessions WHERE user_id = ?1`)
      .bind(user?.id)
      .first<{ step: string | null; data: string }>();
    expect(session?.step).toBeNull();
    expect(session?.data).toBe('{}');
  });

  it('accepts the /start@botname form', async () => {
    const { updateId, telegramId } = ids();
    const outcome = await handleUpdate(db, startUpdate(updateId, telegramId, '/start@shikoo_bot'));
    expect(outcome.status).toBe('processed');
  });

  it('keeps one row for one telegram_id and refreshes the username', async () => {
    const { updateId, telegramId } = ids();
    await handleUpdate(db, startUpdate(updateId, telegramId));

    const renamed = startUpdate(updateId + 1, telegramId);
    renamed.message!.from!.username = 'renamed';
    await handleUpdate(db, renamed);

    const rows = await db
      .prepare(`SELECT COUNT(*)::int AS n FROM users WHERE telegram_id = ?1`)
      .bind(telegramId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
    expect((await userRow(telegramId))?.username).toBe('renamed');
  });

  it('records a blocked customer as seen but answers nothing', async () => {
    const { updateId, telegramId } = ids();
    await handleUpdate(db, startUpdate(updateId, telegramId));
    await db
      .prepare(`UPDATE users SET status = 'BLOCKED' WHERE telegram_id = ?1`)
      .bind(telegramId)
      .run();
    await db
      .prepare(`UPDATE users SET last_seen_at = now() - interval '1 day' WHERE telegram_id = ?1`)
      .bind(telegramId)
      .run();
    const before = await userRow(telegramId);

    const outcome = await handleUpdate(db, startUpdate(updateId + 1, telegramId));

    expect(outcome.status).toBe('ignored');
    expect(outcome.replies).toEqual([]);
    const after = await userRow(telegramId);
    expect(new Date(after!.last_seen_at).getTime()).toBeGreaterThan(
      new Date(before!.last_seen_at).getTime(),
    );
  });
});

describe('updates we do not act on', () => {
  it('claims an unknown command without replying', async () => {
    const { updateId, telegramId } = ids();
    const outcome = await handleUpdate(db, startUpdate(updateId, telegramId, '/nonsense'));
    expect(outcome.status).toBe('ignored');
    expect(outcome.replies).toEqual([]);
    expect(await countUpdate(updateId)).toBe(1);
  });

  it('claims an update carrying no message', async () => {
    const { updateId } = ids();
    const outcome = await handleUpdate(db, { update_id: updateId });
    expect(outcome.status).toBe('ignored');
    expect(await countUpdate(updateId)).toBe(1);
  });
});

describe('exactly-once', () => {
  it('runs a redelivered update_id zero times', async () => {
    const { updateId, telegramId } = ids();

    const first = await handleUpdate(db, startUpdate(updateId, telegramId));
    expect(first.status).toBe('processed');

    // Telegram redelivers because the offset was never confirmed.
    const second = await handleUpdate(db, startUpdate(updateId, telegramId));
    expect(second.status).toBe('duplicate');
    expect(second.replies).toEqual([]);
    expect(await countUpdate(updateId)).toBe(1);
  });

  it('does not re-run the handler for a duplicate', async () => {
    const { updateId, telegramId } = ids();
    await handleUpdate(db, startUpdate(updateId, telegramId));
    const user = await userRow(telegramId);
    await db
      .prepare(`UPDATE bot_sessions SET step = 'AWAITING_RECEIPT' WHERE user_id = ?1`)
      .bind(user?.id)
      .run();

    await handleUpdate(db, startUpdate(updateId, telegramId));

    // If the duplicate had re-run /start, this would be NULL again.
    const session = await db
      .prepare(`SELECT step FROM bot_sessions WHERE user_id = ?1`)
      .bind(user?.id)
      .first<{ step: string | null }>();
    expect(session?.step).toBe('AWAITING_RECEIPT');
  });

  it('rolls the claim back when the handler throws, so redelivery still works', async () => {
    const { updateId, telegramId } = ids();

    await expect(
      handleUpdate(failAfterClaim(db), startUpdate(updateId, telegramId)),
    ).rejects.toThrow('injected failure');

    // The whole point of claiming inside the transaction: a failed update is not
    // marked as handled, so Telegram's next delivery gets a real attempt.
    expect(await countUpdate(updateId)).toBe(0);
    expect(await userRow(telegramId)).toBeNull();

    const retry = await handleUpdate(db, startUpdate(updateId, telegramId));
    expect(retry.status).toBe('processed');
    expect(await countUpdate(updateId)).toBe(1);
  });
});

/**
 * Wraps the real database so the users upsert throws — after the claim has been
 * written inside the same transaction. Nothing else is faked: the transaction,
 * the claim and the rollback are all the real ones.
 */
function failAfterClaim(real: D1Database): D1Database {
  const wrapped: D1Database = {
    prepare: (sql) => real.prepare(sql),
    batch: (statements) => real.batch(statements),
    exec: (sql) => real.exec(sql),
    dump: () => real.dump(),
    withSession: (fn) =>
      real.withSession((tx) => {
        const session: D1DatabaseSession = {
          prepare: (sql) => {
            if (!sql.includes('INSERT INTO users')) return tx.prepare(sql);
            const boom = (): never => {
              throw new Error('injected failure');
            };
            const statement: D1PreparedStatement = {
              bind: () => statement,
              first: boom,
              all: boom,
              run: boom,
            };
            return statement;
          },
          batch: (statements) => tx.batch(statements),
        };
        return fn(session);
      }),
  };
  return wrapped;
}
