/**
 * Calling Telegram as the shop's own bot, from the panel.
 *
 * Three routes here already needed this and each grew its own copy: the report
 * group builder, the sticker-set reader, and now the broadcast that forwards a
 * channel post. The fetch is four lines and was never the hard part — the hard
 * part is the two failure modes above it, which are different sentences for the
 * operator and were only ever written out once.
 *
 * ## Why `PANEL_SECRET_KEY` is passed through by hand
 *
 * `resolveBotToken`'s env argument REPLACES `process.env` rather than adding to
 * it, so handing it only the bot token leaves it unable to open the sealed row —
 * and the symptom is «no bot is connected» on a shop that has one. That cost
 * `botRoutes` a debugging round, and duplicating the workaround is how the next
 * caller pays for it again.
 *
 * ## Why "unreadable" and "absent" are not the same answer
 *
 * A stored token that will not decrypt is not a missing token. Saying «connect a
 * bot first» sends an operator to re-paste a token that was already correct,
 * when the real answer is a wrong `PANEL_SECRET_KEY` on this service.
 */

import type { D1Database } from '@shikoo/database';
import type { EnvName } from '@shikoo/contracts';
import { resolveBotToken } from '@shikoo/domain';

const TELEGRAM_API = 'https://api.telegram.org';

/**
 * A deadline on every call, because these run on an admin's request thread.
 *
 * Telegram accepting a connection and then never answering would otherwise hang
 * the route for as long as the platform allows. The same 15s the bot's own
 * client uses (`apps/bot/src/telegram.ts`), so the two do not disagree about
 * how long Telegram is allowed to think. Both callers already answer 502 on a
 * throw, so an abort arrives as the right sentence.
 */
const CALL_TIMEOUT_MS = 15_000;

/** The bindings any route needs before it can speak as the bot. */
export interface BotCallEnv {
  DB: D1Database;
  /**
   * Optional on the type because every `Bindings` in this worker declares it
   * so, and REFUSED below rather than defaulted. See `botTelegram`.
   */
  ENV_NAME?: EnvName;
  TELEGRAM_BOT_TOKEN?: string;
}

/**
 * What Telegram sends back, narrowed to what the panel's routes read.
 *
 * `description` is the field that matters most and is the easiest to drop:
 * «chat not found», «message to forward not found», «bot is not a member of the
 * channel chat» are three completely different things for an operator to do,
 * and without it they all arrive as «it did not work».
 */
export interface TelegramReply {
  ok?: boolean;
  description?: string;
  result?: { is_forum?: boolean; message_thread_id?: number };
}

export type TelegramCall = (method: string, payload: unknown) => Promise<TelegramReply>;

export type BotCall =
  | { ok: true; call: TelegramCall }
  | { ok: false; status: 409 | 503; error: string; detail: string };

/**
 * The bot's Telegram, or the reason there isn't one — never a throw.
 *
 * ## Why a missing `ENV_NAME` is refused rather than defaulted
 *
 * `resolveBotToken` compares the stored row's `env_name` against this value and
 * IGNORES the row when they differ. So `?? 'local'` — which is what every
 * caller in this worker wrote, and what this function was first written with —
 * would turn a missing binding into «no bot is connected» on a shop that has
 * one, and send the operator to re-paste a token that was already right.
 *
 * **It cannot actually happen, and that is worth writing down rather than
 * leaving to be re-derived.** `start()` builds the env through `buildEnv`,
 * which calls `parseEnvName`, which THROWS on absent and on a near-miss like
 * «prod» (`packages/contracts/src/env.ts:63`). The worker does not come up
 * without a valid `ENV_NAME`. `deploy/autodeploy.sh:825` refuses a container
 * that reports none, from the other side.
 *
 * So this refusal covers the one hole those two leave: the TYPE says
 * `ENV_NAME?`, so a caller — a test, a future route — can hand this an env
 * without one, and the compiler will not say so. A 503 naming the binding beats
 * «no bot is connected», which is the answer the `?? 'local'` gave.
 *
 * The four other `?? 'local'` in this worker were dead for the same reason and
 * read as live defaults; #91 deleted them by making `ENV_NAME` required on
 * every `Bindings` here. This refusal stays: `BotCallEnv` is a plain object
 * shape rather than one of those `Bindings`, so a test or a future caller can
 * still hand this an env without one and the compiler will not say so.
 */
export async function botTelegram(env: BotCallEnv): Promise<BotCall> {
  const envName = env.ENV_NAME;
  if (!envName) {
    return {
      ok: false,
      status: 503,
      error: 'no_env_name',
      detail: 'ENV_NAME روی این سرویس تنظیم نشده — تا تنظیم نشود، ربات پیدا نمی‌شود.',
    };
  }
  let resolved;
  try {
    resolved = await resolveBotToken(env.DB, envName, {
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      PANEL_SECRET_KEY: process.env['PANEL_SECRET_KEY'],
    });
  } catch (err) {
    return {
      ok: false,
      status: 503,
      error: 'bot_token_unreadable',
      detail: (err as Error).message,
    };
  }
  if (!resolved) {
    return {
      ok: false,
      status: 409,
      error: 'no_bot',
      detail: 'اول باید رباتی به پنل وصل باشد.',
    };
  }
  const token = resolved.token;
  return {
    ok: true,
    // `globalThis.fetch` read at call time rather than captured, so a test can
    // spy on it. A captured reference binds the original at module load and
    // quietly ignores the spy.
    call: async (method, payload) => {
      const res = await globalThis.fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
      return (await res.json()) as TelegramReply;
    },
  };
}
