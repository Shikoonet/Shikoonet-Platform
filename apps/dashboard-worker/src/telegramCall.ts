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
import { reportTopicKey, stripCustomEmoji } from '@shikoo/contracts';
import { createLogger, resolveBotToken } from '@shikoo/domain';

const log = createLogger('dashboard');

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

/**
 * Longer for a multipart body: the one caller uploading files sends up to
 * 48 MiB, and the bot's own `sendDocumentBytes` allows two minutes for less.
 */
const UPLOAD_TIMEOUT_MS = 120_000;

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
  result?: TelegramMessage;
}

/** A sent or forwarded message, narrowed to the file it may carry. */
export interface TelegramMessage {
  message_id?: number;
  is_forum?: boolean;
  message_thread_id?: number;
  chat?: { is_forum?: boolean };
  document?: TelegramFile;
  video?: TelegramFile;
  photo?: TelegramFile[];
}

interface TelegramFile {
  file_id: string;
  file_name?: string;
  file_size?: number;
}

export type AttachmentKind = 'document' | 'video' | 'photo';

/**
 * The one file a message carries, as a shelf attachment (#377) — or null for
 * a text, a sticker, an album's other members, anything that is not one of
 * the three kinds the bot can send back by `file_id`.
 *
 * A photo arrives as its sizes, largest last; the largest is the one kept.
 */
export function attachmentOf(
  message: TelegramMessage | undefined,
): { kind: AttachmentKind; fileId: string; fileName: string; sizeBytes: number } | null {
  if (!message) return null;
  const photo = message.photo?.at(-1);
  const pick: [AttachmentKind, TelegramFile | undefined][] = [
    ['document', message.document],
    ['video', message.video],
    ['photo', photo],
  ];
  for (const [kind, f] of pick) {
    if (f?.file_id) {
      return {
        kind,
        fileId: f.file_id,
        fileName: f.file_name ?? kind,
        sizeBytes: f.file_size ?? 0,
      };
    }
  }
  return null;
}

/**
 * Where the shop's own people watch: the reports group and its «سایر گزارشات»
 * topic. Read here so the broadcast rehearsal and the shelf's file upload
 * agree about it, rather than each spelling the settings keys again.
 *
 * Zero and negative are «not configured» — legacy's own sentinels, and what
 * the bot's settings reader treats as absent. An unset topic lands in the
 * group's General, which is a fine place for either.
 */
export async function reportsGroup(
  db: D1Database,
): Promise<{ chatId: number; threadId: number | null } | null> {
  const topicKey = reportTopicKey('otherreport');
  const rows = await db
    .prepare(
      `SELECT key, value FROM settings
        WHERE scope = 'bot' AND key IN ('Channel_Report', ?1)`,
    )
    .bind(topicKey)
    .all<{ key: string; value: unknown }>();
  const setting = new Map((rows.results ?? []).map((r) => [r.key, String(r.value ?? '').trim()]));
  const rawChat = setting.get('Channel_Report') ?? '';
  const chatId = /^-?[0-9]{1,19}$/.test(rawChat) ? Number(rawChat) : null;
  if (chatId === null || chatId === 0 || !Number.isSafeInteger(chatId)) return null;
  const rawTopic = Number(setting.get(topicKey) ?? '');
  return { chatId, threadId: Number.isSafeInteger(rawTopic) && rawTopic > 0 ? rawTopic : null };
}

export type TelegramCall = (method: string, payload: unknown) => Promise<TelegramReply>;

/**
 * An upload's body, read as it streams and refused past `maxBytes` — never
 * judged by a `content-length` the client chose. Held in memory: every caller
 * sends it straight back out to Telegram. A shelf's file and a channel post's
 * picture both arrive this way.
 */
export async function readCappedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array[] | 'empty' | 'too_large'> {
  if (body === null) return 'empty';
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) return 'too_large';
    chunks.push(chunk);
  }
  return bytes === 0 ? 'empty' : chunks;
}

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
    //
    // A `FormData` goes as multipart with NO content-type of ours: fetch writes
    // the header with the boundary it chose, and one set by hand names a
    // boundary the body does not have (the bot's client says the same at
    // `apps/bot/src/telegram.ts`, `callForm`).
    call: async (method, payload) => {
      const form = payload instanceof FormData;
      const res = await globalThis.fetch(`${TELEGRAM_API}/bot${token}/${method}`, {
        method: 'POST',
        ...(form
          ? { body: payload }
          : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
        signal: AbortSignal.timeout(form ? UPLOAD_TIMEOUT_MS : CALL_TIMEOUT_MS),
      });
      return (await res.json()) as TelegramReply;
    },
  };
}

/**
 * A service's own topic in the reports group. Sam, 2026-09-20: beside the ten
 * topics per KIND, one per service and per shelf — «سرویس تیتانیوم», «قفسهٔ
 * OpenVPN» — and when the service goes, its topic goes with it.
 *
 * The thread id is written onto the product row (0091); the bot reads it
 * there and sends the order's report to it instead of the kind's topic.
 *
 * Telegram's name limit is 128 characters, and a name may carry a custom-emoji
 * tag that a topic title cannot render — the fallback emoji is what it gets.
 */
export async function makeProductTopic(
  db: D1Database,
  call: TelegramCall,
  chatId: number,
  product: { id: number; name: string },
): Promise<number | null> {
  const name = stripCustomEmoji(product.name).slice(0, 128);
  let made: TelegramReply;
  try {
    made = await call('createForumTopic', { chat_id: chatId, name });
  } catch (err) {
    log.warn('reports.product_topic_failed', { product_id: product.id }, err);
    return null;
  }
  const threadId = made.result?.message_thread_id;
  if (made.ok !== true || typeof threadId !== 'number') {
    log.warn('reports.product_topic_failed', { product_id: product.id, reason: made.description });
    return null;
  }
  // The topic exists on Telegram only once the row remembers it. A product
  // deleted between the SELECT and here, or a write that fails, would leave
  // a topic nothing points at — and the next run would make a second one.
  const kept = await db
    .prepare(`UPDATE products SET report_thread_id = ?2 WHERE id = ?1`)
    .bind(product.id, threadId)
    .run()
    .then((r) => r.meta.changes === 1)
    .catch(() => false);
  if (!kept) {
    log.warn('reports.product_topic_failed', { product_id: product.id, reason: 'row not written' });
    await call('deleteForumTopic', { chat_id: chatId, message_thread_id: threadId }).catch(
      () => undefined,
    );
    return null;
  }
  return threadId;
}

/**
 * Makes the topic for a product just born — or does nothing, quietly, when
 * the shop has no reports group. A topic is a side effect of the product and
 * must not be able to fail its creation; the missing ones are made on the
 * next run of «گروه گزارش‌ها».
 */
export async function openProductTopic(
  env: BotCallEnv,
  product: { id: number; name: string },
): Promise<void> {
  const group = await reportsGroup(env.DB);
  if (!group) return;
  const bot = await botTelegram(env);
  if (!bot.ok) return;
  await makeProductTopic(env.DB, bot.call, group.chatId, product);
}

/** The topic follows a renamed product. Best effort, like the delete below. */
export async function renameProductTopic(
  env: BotCallEnv,
  threadId: number | null,
  name: string,
): Promise<void> {
  if (threadId === null) return;
  const group = await reportsGroup(env.DB);
  if (!group) return;
  const bot = await botTelegram(env);
  if (!bot.ok) return;
  try {
    const done = await bot.call('editForumTopic', {
      chat_id: group.chatId,
      message_thread_id: threadId,
      name: stripCustomEmoji(name).slice(0, 128),
    });
    if (done.ok !== true) {
      log.warn('reports.product_topic_not_renamed', { thread_id: threadId, reason: done.description });
    }
  } catch (err) {
    log.warn('reports.product_topic_not_renamed', { thread_id: threadId }, err);
  }
}

/**
 * Deletes a gone product's topic. Best effort, after the row is already
 * gone: a topic the bot cannot delete (it needs «can_delete_messages» in the
 * group) is one the operator removes by hand, not a product that stays.
 */
export async function closeProductTopic(env: BotCallEnv, threadId: number | null): Promise<void> {
  if (threadId === null) return;
  const group = await reportsGroup(env.DB);
  if (!group) return;
  const bot = await botTelegram(env);
  if (!bot.ok) return;
  try {
    const gone = await bot.call('deleteForumTopic', {
      chat_id: group.chatId,
      message_thread_id: threadId,
    });
    if (gone.ok !== true) {
      log.warn('reports.product_topic_not_deleted', { thread_id: threadId, reason: gone.description });
    }
  } catch (err) {
    log.warn('reports.product_topic_not_deleted', { thread_id: threadId }, err);
  }
}
