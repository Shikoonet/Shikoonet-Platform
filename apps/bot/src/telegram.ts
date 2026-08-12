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

const TelegramUserSchema = z.object({
  id: z.number().int(),
  username: z.string().optional(),
  language_code: z.string().optional(),
});

const MessageSchema = z.object({
  message_id: z.number().int(),
  from: TelegramUserSchema.optional(),
  chat: z.object({ id: z.number().int() }),
  text: z.string().optional(),
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

/** One button. `callback_data` is capped at 64 BYTES by Telegram, not characters. */
export interface InlineButton {
  text: string;
  callback_data: string;
}

export type InlineKeyboard = InlineButton[][];

const EnvelopeSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
  result: z.unknown().optional(),
});

export interface TelegramApi {
  /**
   * Long-polls. Returns updates with `update_id >= offset`.
   *
   * `signal` cancels the poll in flight. Without it a shutdown has to wait out
   * the full poll — 25 seconds of nothing on every restart.
   */
  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<void>;
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
}

export const TELEGRAM_API_BASE = 'https://api.telegram.org';

/** Never let a token reach a log line or an exception message. */
function redact(message: string, token: string): string {
  return token === '' ? message : message.split(token).join('<token>');
}

/** Omitted entirely when there is no keyboard, so a menu is never sent as `null`. */
function markup(keyboard?: InlineKeyboard): Record<string, unknown> {
  return keyboard === undefined ? {} : { reply_markup: { inline_keyboard: keyboard } };
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

  return {
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
      await call('sendMessage', { chat_id: chatId, text, ...markup(keyboard) }, 15_000);
    },

    async editMessageText(chatId, messageId, text, keyboard) {
      try {
        await call(
          'editMessageText',
          { chat_id: chatId, message_id: messageId, text, ...markup(keyboard) },
          15_000,
        );
      } catch (err) {
        // Pressing the same button twice asks Telegram to replace a message
        // with itself, and it answers 400. The screen already says what we
        // wanted it to say, so this is the success case wearing an error's
        // clothes — and treating it as a failure fills the log during ordinary
        // use. Seen on the first live run of the menu.
        if (String(err).includes('message is not modified')) return;
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
