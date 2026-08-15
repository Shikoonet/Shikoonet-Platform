/**
 * The two doors a customer passes before the shop will talk to them: membership
 * of the required channels, and acceptance of the shop's rules.
 *
 * Both are switched ON in production today and neither exists in this bot yet.
 * With the token carried across unchanged the customer sees no announcement, so
 * anything the live bot does today and ours does not is, to them, the shop
 * silently changing its mind — which is why these are cutover blockers rather
 * than growth features.
 *
 * ## Where it fires, and why not only on `/start`
 *
 * `index.php:393` and `:410` sit above the dispatch, not inside the `/start`
 * branch, so the live bot re-asks on every single update. Ours does the same, at
 * the one point `handleUpdate` already guards with the closed sign. A gate a
 * forged `callback_data` walks past is not a gate, and `callback_data` is a field
 * anyone can post.
 *
 * ## Why it fails open
 *
 * `function.php:622` only records a customer as missing from a channel when
 * `$response['ok']` — an error is skipped, so a Telegram that will not answer
 * lets everyone through. Deliberate there and kept here. The alternative is a
 * shop that stops selling because one API call timed out, and the loss is
 * asymmetric: letting a non-member browse for an hour costs nothing, refusing
 * every paying customer costs the day.
 *
 * It has one failure mode, and it is silent by construction: a shop whose
 * channel row is wrong, or whose bot was never made an admin of the channel,
 * gets an error on every call and a gate that never fires. Nothing here can
 * tell that from a shop where everybody happens to be a member — the two differ
 * only in what Telegram says, and neither leaves a mark on a screen. It is the
 * price of not closing the shop over an outage, and the only thing that
 * detects it is an operator making one `getChatMember` call before the cutover.
 *
 * ## Why a timestamp and not a flag
 *
 * Legacy keeps `user.joinchannel` and, in the path that matters, never writes it
 * — so it pays one `getChatMember` per channel per update, for ever. A flag
 * would be the cheap fix and it is the wrong one: channel membership lives at
 * Telegram, and a customer can leave a minute after joining. The only honest
 * thing we can store is WHEN we last asked, which is what
 * `users.channels_checked_at` is. Between asks the door stands open, and how
 * long that is, is a number rather than for ever.
 */

import type { D1DatabaseSession } from '@shikoo/database';

/** Just the piece of `TelegramApi` this needs, so a test can pass a stub. */
export interface MembershipApi {
  getChatMember(chatRef: string, userId: number): Promise<string>;
}

export interface RequiredChannel {
  title: string;
  chat_ref: string;
  join_link: string;
}

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

/**
 * The statuses Telegram uses for somebody who is in the chat.
 *
 * Exactly the three `function.php:623` accepts. `restricted` is deliberately not
 * among them even though a restricted user technically holds `is_member` — it is
 * a group concept, the required chats are broadcast channels, and matching the
 * live bot's list is worth more than covering a case that cannot arise.
 */
const JOINED = new Set(['creator', 'administrator', 'member']);

/** The gate a customer is standing behind, or null if they are through. */
export type GateVerdict =
  | { kind: 'channels'; missing: RequiredChannel[] }
  | { kind: 'rules' }
  | null;

/** The active required channels, in a stable order. */
export async function requiredChannels(tx: D1DatabaseSession): Promise<RequiredChannel[]> {
  const { results } = await tx
    .prepare(
      `SELECT title, chat_ref, join_link FROM required_channels
        WHERE active ORDER BY id`,
    )
    .all<RequiredChannel>();
  return results;
}

interface GateUser {
  id: number;
  rules_accepted: boolean;
  channels_checked_at: string | null;
}

/**
 * Which door, if any, this customer is still behind.
 *
 * Channels first and rules second, matching the order a customer meets them, and
 * it matters for one case: somebody who has done neither is asked to join before
 * being asked to agree, so «قوانین را می‌پذیرم» cannot be used to skip the
 * channel. The rules flag is written the moment they press it; the gate re-runs
 * afterwards and the channel screen comes back.
 *
 * Returns null — through — for an unknown telegram id. Nothing else in this bot
 * answers a customer with no row either, and creating one here would take the
 * decision away from `/start`, which is the only thing that should make it.
 */
export async function gateFor(
  tx: D1DatabaseSession,
  api: MembershipApi | undefined,
  telegramId: number,
  requiresRules: boolean,
  now = Date.now(),
): Promise<GateVerdict> {
  const user = await tx
    .prepare(
      `SELECT id, rules_accepted, channels_checked_at FROM users WHERE telegram_id = ?1`,
    )
    .bind(telegramId)
    .first<GateUser>();
  if (!user) return null;

  const missing = await missingChannels(tx, api, user, telegramId, now);
  if (missing.length > 0) return { kind: 'channels', missing };

  if (requiresRules && !user.rules_accepted) return { kind: 'rules' };
  return null;
}

/**
 * Records that this customer has accepted the rules.
 *
 * Idempotent by shape rather than by a read: a second press writes the same
 * `true` over a `true`.
 */
export async function acceptRules(tx: D1DatabaseSession, telegramId: number): Promise<void> {
  await tx
    .prepare(`UPDATE users SET rules_accepted = true, updated_at = now() WHERE telegram_id = ?1`)
    .bind(telegramId)
    .run();
}

async function missingChannels(
  tx: D1DatabaseSession,
  api: MembershipApi | undefined,
  user: GateUser,
  telegramId: number,
  now: number,
): Promise<RequiredChannel[]> {
  // Confirmed recently enough. This is the branch that runs for almost every
  // update, and it costs one column of a row that was going to be read anyway.
  const checked = user.channels_checked_at === null ? 0 : Date.parse(user.channels_checked_at);
  if (Number.isFinite(checked) && now - checked < MEMBERSHIP_TTL_MS) return [];

  const channels = await requiredChannels(tx);
  // No channel is required, so there is nothing to be missing from. Deliberately
  // not stamped as checked: the day an admin adds the first channel, every
  // customer should be asked, not held open by a timestamp that answered a
  // different question.
  if (channels.length === 0) return [];

  // No api means the caller has none to give — the sweeps, and every test that
  // does not care. Failing open here is the same decision as failing open on an
  // error below, for the same reason.
  if (!api) return [];

  // Three outcomes, not two. "In" and "out" are answers about this customer;
  // "unanswered" is about us, and collapsing it into either one is how this
  // goes wrong in both directions at once.
  const verdicts = await Promise.all(
    channels.map(async (channel) => {
      try {
        return JOINED.has(await api.getChatMember(channel.chat_ref, telegramId)) ? 'in' : 'out';
      } catch (err) {
        // A channel the bot is not an admin of, a `chat_ref` with a typo in it,
        // and a Telegram that timed out all land here, and none of them is
        // evidence about this customer.
        console.error(`[bot] could not check membership of ${channel.chat_ref}`, err);
        return 'unanswered';
      }
    }),
  );
  const missing = channels.filter((_, i) => verdicts[i] === 'out');

  // Stamped only when every channel actually answered "in".
  //
  // The first version stamped whenever `missing` was empty, which folded an
  // unanswered channel into a confirmed membership — so a Telegram that was
  // refusing calls did not merely let customers through for that update, it
  // wrote them an hour's pass each. Failing open is a decision about one
  // request; latching it open for an hour is a different, worse one, and
  // nothing in the log would have distinguished them.
  if (verdicts.every((v) => v === 'in')) {
    await tx
      .prepare(`UPDATE users SET channels_checked_at = now() WHERE id = ?1`)
      .bind(user.id)
      .run();
  }
  return missing;
}
