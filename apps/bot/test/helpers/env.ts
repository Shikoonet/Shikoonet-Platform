/**
 * The bot's slice of the shared test database.
 *
 * Only the tables the bot writes are reset, and `users` is reset with CASCADE so
 * bot_sessions goes with it. The catalog is NOT reset: it is a fixture, seeded
 * once, and re-seeding is idempotent by design (packages/seed/src/catalog.ts).
 *
 * Needs DATABASE_URL and migrations 0001-0006 applied (`pnpm sim:up`).
 */

import { createPostgresD1 } from '@shikoo/db';

const { db, pool } = createPostgresD1();

export { db, pool };

const BOT_TABLES = ['telegram_updates', 'bot_sessions', 'users', 'bot_notifications'];

/**
 * What the sweeps decided a customer is owed.
 *
 * The sweeps used to return their messages and a test could read the return
 * value. They now write them into `bot_notifications` inside the transaction
 * that earns them, so this is where the assertion goes — and it is a stronger
 * one: it proves the message survived the commit rather than that a function
 * built the right string.
 */
export async function pendingNotifications(): Promise<
  { chatId: number; text: string; dedupeKey: string }[]
> {
  const { results } = await db
    .prepare(
      `SELECT chat_id, body, dedupe_key FROM bot_notifications
        WHERE status = 'PENDING' ORDER BY id`,
    )
    .all<{ chat_id: number; body: string; dedupe_key: string }>();
  return (results ?? []).map((r) => ({
    chatId: r.chat_id,
    text: r.body,
    dedupeKey: r.dedupe_key,
  }));
}

/** Confirms the schema is present, so an empty database cannot pass by default. */
export async function assertSchema(): Promise<void> {
  const row = await db
    .prepare(
      `SELECT COUNT(*)::int AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = ANY($1)`,
    )
    .bind(BOT_TABLES)
    .first<{ n: number }>();
  if ((row?.n ?? 0) < BOT_TABLES.length) {
    throw new Error(
      `expected ${BOT_TABLES.length} bot tables, found ${row?.n ?? 0}. ` +
        // `0*.sql`, not `000*.sql`: the latter stops at 0009 and leaves the
        // schema half applied, which reads as a different failure entirely.
        'Apply migrations/0*.sql to DATABASE_URL first (pnpm sim:up).',
    );
  }
}

export async function resetBot(): Promise<void> {
  await db.prepare(`TRUNCATE ${BOT_TABLES.join(', ')} RESTART IDENTITY CASCADE`).run();
}
