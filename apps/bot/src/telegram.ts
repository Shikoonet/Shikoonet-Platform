/**
 * The Telegram Bot API, narrowed to what this bot actually calls.
 *
 * Two things are deliberate here.
 *
 * The response is untrusted input and is validated, not cast. Mirzabot reads
 * `$update['message']['text']` straight off `json_decode` and has to guard every
 * access; here a malformed update is turned into a well-typed one at the door.
 *
 * A malformed update never wedges the poller. `message` carries `.catch()`, so a
 * shape we cannot read becomes `undefined` rather than an exception — the update
 * still gets an id, still gets claimed, and the offset still advances. Throwing
 * instead would make Telegram redeliver the same broken update forever.
 *
 * The token appears in the URL, which is why no error thrown here ever contains
 * the URL.
 */

import { z } from 'zod';
import { hasCustomEmoji, stripCustomEmoji, toTelegramHtml } from '@shikoo/contracts';

const TelegramUserSchema = z.object({
  id: z.number().int(),
  username: z.string().optional(),
  language_code: z.string().optional(),
});

/**
 * One rendition of a photo. Telegram sends several sizes; the last is the
 * largest, and the only one worth keeping for a receipt somebody has to read.
 *
 * `file_id` is not a URL and not a secret — it is an opaque handle that can be
 * handed straight back to `sendPhoto`, which is how an admin sees the receipt
 * without the image ever being downloaded or stored anywhere.
 */
const PhotoSizeSchema = z.object({ file_id: z.string() });

const MessageSchema = z.object({
  message_id: z.number().int(),
  from: TelegramUserSchema.optional(),
  chat: z.object({ id: z.number().int() }),
  text: z.string().optional(),
  photo: z.array(PhotoSizeSchema).optional(),
});

/**
 * A button press.
 *
 * `data` is whatever the client sent. Telegram does not sign it, does not
 * remember which buttons it offered, and does not check that this user was ever
 * shown this button — anyone can post any string with a plain API call. It is
 * user input in exactly the sense a URL query parameter is, and callback.ts
 * treats it that way.
 */
const CallbackQuerySchema = z.object({
  id: z.string(),
  from: TelegramUserSchema,
  message: MessageSchema.optional(),
  data: z.string().optional(),
});

const UpdateSchema = z.object({
  update_id: z.number().int(),
  message: MessageSchema.optional().catch(undefined),
  callback_query: CallbackQuerySchema.optional().catch(undefined),
});

export type TelegramUpdate = z.infer<typeof UpdateSchema>;
export type TelegramMessage = z.infer<typeof MessageSchema>;
export type TelegramCallbackQuery = z.infer<typeof CallbackQuerySchema>;

/**
 * One button, in Telegram's own shape: a label plus exactly one action field.
 *
 * `callback_data` is capped at 64 BYTES, not characters. `copy_text` puts its
 * payload on the clipboard instead of calling back, and is capped at 256
 * characters. Both are optional here because both are optional there — a button
 * carrying neither is refused by Telegram, which is why nothing builds one.
 */
export interface InlineButton {
  text: string;
  callback_data?: string;
  copy_text?: { text: string };
}

/** Telegram's cap on what a copy button may carry. */
export const MAX_COPY_TEXT_LENGTH = 256;

export type InlineKeyboard = InlineButton[][];

const EnvelopeSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
  result: z.unknown().optional(),
});

export interface TelegramApi {
  /**
   * The bot's own @username.
   *
   * Needed for the referral link, and asked for rather than configured: an
   * operator who types the wrong username produces links that open somebody
   * else's bot, and nothing would ever tell them.
   */
  getMe(): Promise<{ username: string | null }>;
  /**
   * Long-polls. Returns updates with `update_id >= offset`.
   *
   * `signal` cancels the poll in flight. Without it a shutdown has to wait out
   * the full poll — 25 seconds of nothing on every restart.
   */
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<void>;
  /**
   * Re-sends a photo we were sent, by its `file_id`.
   *
   * Nothing is downloaded and nothing is stored: the receipt lives on
   * Telegram's servers and the claim keeps only the handle. The caption is
   * short on purpose — Telegram caps it at 1024 characters, well below a
   * message, so the screen that goes with the picture is sent separately.
   */
  sendPhoto(chatId: number, fileId: string, caption?: string): Promise<void>;
  /** Replaces a message in place, so a menu does not leave a trail behind it. */
  editMessageText(
    chatId: number,
    messageId: number,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void>;
  /**
   * Clears the client's spinner. Telegram leaves the button spinning for a few
   * seconds otherwise, which reads as a hung bot.
   */
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
}

export interface TelegramApiOptions {
  token: string;
  /** Points at the fake in tests and at api.telegram.org in production. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  /**
   * Called once when Telegram refuses a message that carried custom emoji.
   *
   * The bot cannot know whether its owner has Premium — there is no API that
   * says so — so it finds out by being told no. The caller uses this to switch
   * the feature off, so the shop stops paying a failed send and a retry for
   * every screen. An admin who turns it on without Premium must not be able to
   * stop their own bot answering.
   */
  onCustomEmojiRefused?: () => void | Promise<void>;
}

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Never let a token reach a log line or an exception message. */
function redact(message: string, token: string): string {
  return token === '' ? message : message.split(token).join('<token>');
}

/**
 * Telegram's hard limit on a message body. Beyond it the call is rejected
 * outright, so the customer gets nothing at all.
 */
export const MAX_MESSAGE_LENGTH = 4096;

/** Telegram's cap on a photo caption — a quarter of a message's. */
export const MAX_CAPTION_LENGTH = 1024;

/** What replaces the tail, so a cut screen reads as cut rather than as finished. */
export const TRUNCATION_MARK = '\n…';

/**
 * A message that is too long, shortened rather than refused.
 *
 * Each editable line is capped on its own, which used to be the same thing as
 * capping the message — a screen was one line. It is not any more: a screen is
 * now assembled from many lines an admin can lengthen independently, and their
 * sum is what gets sent. Nothing in the write path can see that sum, because it
 * depends on the data filling the slots.
 *
 * So the last guard sits here, at the one place every screen passes through. A
 * shop that writes an essay into every line gets a truncated screen; the
 * alternative is a bot that silently fails to answer, which is how the customer
 * would otherwise find out.
 *
 * The slice is by UTF-16 code unit, matching Telegram's own count.
 */
function clamp(text: string): string {
  if (text.length <= MAX_MESSAGE_LENGTH) return text;
  console.error(`[telegram] message of ${text.length} characters truncated to fit`);
  return text.slice(0, MAX_MESSAGE_LENGTH - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}

/** Omitted entirely when there is no keyboard, so a menu is never sent as `null`. */
function markup(keyboard?: InlineKeyboard): Record<string, unknown> {
  return keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } };
}

/** Telegram answered. `call()` says "failed" when we never reached it at all. */
function isRejection(err: unknown): boolean {
  return String(err).includes('rejected');
}

/**
 * Asking Telegram to replace a message with itself.
 *
 * It answers 400, so it reaches us as a rejection like any other — but nothing
 * was refused. The screen already says what we wanted it to say, and the only
 * thing that happened is that a customer pressed the same button twice.
 *
 * Named once and consulted from both places on purpose: while this test lived
 * only in `editMessageText`, `withEmojiFallback` ran first and read the same
 * error as "the owner has no Premium".
 */
function isNotModified(err: unknown): boolean {
  return String(err).includes('message is not modified');
}

export function createTelegramApi(options: TelegramApiOptions): TelegramApi {
  const base = (options.baseUrl ?? TELEGRAM_API_BASE).replace(/\/+$/, '');
  const doFetch = options.fetch ?? globalThis.fetch;
  const token = options.token;

  async function call(
    method: string,
    body: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    let response: Response;
    const deadline = AbortSignal.timeout(timeoutMs);
    try {
      response = await doFetch(`${base}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([deadline, signal]) : deadline,
      });
    } catch (err) {
      // A network error's message can carry the URL, and the URL carries the token.
      throw new Error(`telegram ${method} failed: ${redact(String(err), token)}`);
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`telegram ${method} returned non-JSON (HTTP ${response.status})`);
    }
    const envelope = EnvelopeSchema.safeParse(parsed);
    if (!envelope.success) {
      throw new Error(`telegram ${method} returned an unrecognised envelope`);
    }
    if (!envelope.data.ok) {
      throw new Error(
        `telegram ${method} rejected: ${redact(envelope.data.description ?? 'no description', token)}`,
      );
    }
    return envelope.data.result;
  }

  /**
   * Sends a body, and lands safely if it carried custom emoji Telegram refused.
   *
   * Plain text is the ordinary path and is untouched — `parse_mode` is still set
   * nowhere for a message with no markup in it, so a Persian sentence full of
   * `<` and `&` is as safe as it was before this feature existed.
   *
   * A message that does carry markup goes as HTML with everything outside the
   * tags escaped. If Telegram *rejects* it — which is what happens when the
   * bot's owner has no Premium, and there is no API that would have told us
   * beforehand — the tags become their own fallback emoji and the message is
   * sent once more as plain text. The customer gets the screen; the shop gets
   * the feature switched off rather than a bot that has stopped answering.
   *
   * A network failure is not a refusal and is rethrown. `call()` says which is
   * which: "rejected" is Telegram answering, "failed" is not reaching it. Auto
   * disabling on a dropped connection would turn a blip into a setting change.
   */
  async function withEmojiFallback(
    text: string,
    send: (body: Record<string, unknown>) => Promise<unknown>,
  ): Promise<void> {
    const clamped = clamp(text);
    if (!hasCustomEmoji(clamped)) {
      await send({ text: clamped });
      return;
    }
    try {
      await send({ text: toTelegramHtml(clamped), parse_mode: 'HTML' });
      return;
    } catch (err) {
      // Two ways this is not a refusal. A network error means Telegram never
      // answered, and a "not modified" means it answered about something else
      // entirely — the caller knows what to do with that one, so it goes back
      // up untouched rather than being read here as a verdict on Premium.
      if (!isRejection(err) || isNotModified(err)) throw err;
      console.error('[telegram] custom emoji refused, falling back to plain text');
    }
    await send({ text: stripCustomEmoji(clamped) });
    await options.onCustomEmojiRefused?.();
  }

  return {
    async getMe() {
      const result = await call('getMe', {}, 15_000);
      const parsed = z
        .object({ username: z.string().optional() })
        .safeParse(result);
      return { username: parsed.success ? (parsed.data.username ?? null) : null };
    },

    async getUpdates(offset, timeoutSec, signal) {
      // The HTTP timeout must outlast the long poll or every poll aborts.
      const result = await call(
        'getUpdates',
        { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] },
        (timeoutSec + 10) * 1000,
        signal,
      );
      if (!Array.isArray(result)) {
        throw new Error('telegram getUpdates did not return a list');
      }
      const updates: TelegramUpdate[] = [];
      for (const item of result) {
        const parsed = UpdateSchema.safeParse(item);
        if (parsed.success) {
          updates.push(parsed.data);
        } else {
          // No update_id means nothing can be claimed or acknowledged for it.
          // Dropping it is the only option that does not stall the offset.
          console.error('[telegram] dropped an update with no usable update_id');
        }
      }
      return updates;
    },

    async sendMessage(chatId, text, keyboard) {
      await withEmojiFallback(text, (body) =>
        call('sendMessage', { chat_id: chatId, ...body, ...markup(keyboard) }, 15_000),
      );
    },

    async sendPhoto(chatId, fileId, caption) {
      await call(
        'sendPhoto',
        {
          chat_id: chatId,
          photo: fileId,
          // Not run through `withEmojiFallback`: a caption is one short line the
          // bot writes itself, never an admin's override, so there is no markup
          // here to escape and nothing to land back from.
          ...(caption === undefined ? {} : { caption: caption.slice(0, MAX_CAPTION_LENGTH) }),
        },
        15_000,
      );
    },

    async editMessageText(chatId, messageId, text, keyboard) {
      try {
        await withEmojiFallback(text, (body) =>
          call(
            'editMessageText',
            { chat_id: chatId, message_id: messageId, ...body, ...markup(keyboard) },
            15_000,
          ),
        );
      } catch (err) {
        // Pressing the same button twice asks Telegram to replace a message
        // with itself, and it answers 400. The screen already says what we
        // wanted it to say, so this is the success case wearing an error's
        // clothes — and treating it as a failure fills the log during ordinary
        // use. Seen on the first live run of the menu.
        if (isNotModified(err)) return;
        throw err;
      }
    },

    async answerCallbackQuery(callbackQueryId, text) {
      await call(
        'answerCallbackQuery',
        { callback_query_id: callbackQueryId, ...(text === undefined ? {} : { text }) },
        15_000,
      );
    },
  };
}
