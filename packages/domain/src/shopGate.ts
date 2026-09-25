/**
 * The half of the shop bot's channel gate that another door has to respect
 * too: which channels are required, and how long a confirmed membership is
 * trusted. Asking Telegram stays in `apps/bot/src/gate.ts` — only the shop bot
 * holds the token that can.
 */
import type { D1Database, D1DatabaseSession } from '@shikoo/database';

/**
 * How long a confirmed membership is trusted before Telegram is asked again.
 *
 * An hour, and the trade is legible in both directions: at one call per customer
 * per hour a busy day is a few thousand calls rather than one per button press,
 * and a customer who leaves the channel keeps their access for at most that long.
 * Legacy pays the full per-update cost and gets zero staleness; this is the same
 * property with a bounded price.
 */
export const MEMBERSHIP_TTL_MS = 60 * 60 * 1000;

export interface RequiredChannel {
  title: string;
  chat_ref: string;
  join_link: string;
}

/** The active required channels, in a stable order. */
export async function requiredChannels(
  db: D1Database | D1DatabaseSession,
): Promise<RequiredChannel[]> {
  const { results } = await db
    .prepare(
      `SELECT title, chat_ref, join_link FROM required_channels
        WHERE active ORDER BY id`,
    )
    .all<RequiredChannel>();
  return results;
}
