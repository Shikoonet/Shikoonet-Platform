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
import { createLogger } from '@shikoo/domain';

const log = createLogger('bot');

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

/**
 * The same receipt, sent with «Send as File».
 *
 * Telegram makes this a `document` rather than a `photo`, and it is what a
 * customer taps when they want the image to arrive uncompressed — which is
 * exactly what somebody sending a bank receipt wants, so it is common rather
 * than exotic. A banking app's PDF arrives the same way.
 *
 * `mime_type` is optional in the API and is therefore treated as unknown rather
 * than absent: what is done with it is decided in `handle.ts`, where the
 * decision is about what counts as a receipt.
 */
const DocumentSchema = z.object({
  file_id: z.string(),
  mime_type: z.string().optional(),
});

const MessageSchema = z.object({
  message_id: z.number().int(),
  from: TelegramUserSchema.optional(),
  chat: z.object({ id: z.number().int() }),
  text: z.string().optional(),
  photo: z.array(PhotoSizeSchema).optional(),
  document: DocumentSchema.optional(),
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
 * characters. `url` opens a link and never calls back at all — the only button
 * the bot draws that it will never hear about again, which is exactly right for
 * «join this channel»: what happened is asked of Telegram afterwards, not
 * reported by the client. All three are optional here because all three are
 * optional there — a button carrying none of them is refused by Telegram, which
 * is why nothing builds one.
 */
/** Telegram owns these three names; `productRoutes` and the CHECK in 0034
 *  spell them the same way, and the string travels unchanged from the column
 *  to the JSON. */
export type ButtonStyle = 'primary' | 'success' | 'danger';

export interface InlineButton {
  text: string;
  callback_data?: string;
  copy_text?: { text: string };
  url?: string;
  /**
   * The whole button's colour, added in Bot API 9.4 (9 February 2026).
   *
   * Omitted is not "no colour" — it is the client's own default, which is what
   * every button here drew before this field existed and what an old client
   * draws now. Nothing needs a fallback: a client that does not know the field
   * ignores it, and the label is unchanged either way.
   */
  style?: ButtonStyle;
}

/** Telegram's cap on what a copy button may carry. */
export const MAX_COPY_TEXT_LENGTH = 256;

export type InlineKeyboard = InlineButton[][];

const EnvelopeSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional(),
  error_code: z.number().optional(),
  result: z.unknown().optional(),
});

/**
 * A refusal from Telegram, carrying the code it refused with.
 *
 * The code used to be dropped on the floor and only the description survived,
 * which was enough while every caller did the same thing with a failure: log
 * it. It is not enough for the notification outbox, which has to tell "Telegram
 * is having a bad minute" from "this customer has blocked the bot" — the first
 * deserves eight retries and the second deserves none. Matching on the
 * description text would work today and break the day Telegram rewords it.
 *
 * `code` is absent for a transport failure, which is exactly right: no answer
 * came back, so nothing is known and retrying is the only sane reading.
 */
export class TelegramRejection extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = 'TelegramRejection';
  }
}

/**
 * Refusals that will still be refusals in an hour.
 *
 * 403 is the whole reason this exists: the customer blocked the bot, or deleted
 * the chat, and no number of retries reaches them. 400 covers a chat id that
 * does not resolve. Everything else — 429, 5xx, a socket that closed — is
 * assumed temporary, because assuming temporary costs a retry and assuming
 * permanent costs the message.
 */
export function isPermanentRejection(err: unknown): boolean {
  return err instanceof TelegramRejection && (err.code === 403 || err.code === 400);
}

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
  /**
   * Sends an image we generated ourselves, as bytes.
   *
   * Distinct from `sendPhoto` because there is no `file_id` to send: a QR code
   * exists only for the message it is attached to. The upload is multipart,
   * which is the one place in this file that is not JSON.
   */
  sendPhotoBytes(
    chatId: number,
    png: Uint8Array,
    caption?: string,
    keyboard?: InlineKeyboard,
  ): Promise<void>;
  /**
   * The same, for a receipt that arrived as a file.
   *
   * A separate call rather than a smarter `sendPhoto`, because Telegram refuses
   * a document's `file_id` given to `sendPhoto` and vice versa — the two id
   * spaces are distinct, and finding out which one you hold by being rejected
   * costs an API call and an error string to match on. Which to use is decided
   * from what was stored, not from what comes back.
   */
  sendDocument(chatId: number, fileId: string, caption?: string): Promise<void>;
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
  /**
   * This customer's standing in one chat, as Telegram's own word for it —
   * `creator`, `administrator`, `member`, `restricted`, `left` or `kicked`.
   *
   * Throws when Telegram refuses, and the distinction is the whole reason this
   * returns a status rather than a boolean. "Not a member" and "we could not
   * ask" look identical to a caller that only sees true/false, and they must not
   * be treated alike: the first closes a door on a customer, the second is our
   * problem and closing the shop over it would be the wrong way round. The
   * caller decides; see `gate.ts`.
   */
  getChatMember(chatRef: string, userId: number): Promise<string>;
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
  log.warn('telegram.message_truncated', { chars: text.length, limit: MAX_MESSAGE_LENGTH });
  return text.slice(0, MAX_MESSAGE_LENGTH - TRUNCATION_MARK.length) + TRUNCATION_MARK;
}

/**
 * A button label whose leading number stays attached to the word it belongs to.
 *
 * Telegram lays inline-button labels out LEFT-TO-RIGHT. Measured in the real
 * client on 2026-08-23: the button element resolves to `direction: ltr`,
 * `unicode-bidi: normal`, and no `dir` attribute anywhere above it. In an
 * LTR paragraph the first strong character decides where a leading NUMBER
 * lands, and a label that starts with a number has no strong character before
 * it — so the number is resolved as left-to-right and rendered at the far end,
 * detached from the word it belongs to:
 *
 *     sent      ۳۰ گیگ - یک‌ماهه — 150,000 تومان
 *     drawn     ۳۰ | تومان 150,000 — یک‌ماهه - گیگ
 *
 * A U+200F RIGHT-TO-LEFT MARK in front gives it that strong character. Both
 * orders above were measured by laying the string out in the browser's own bidi
 * engine, in a box with the button's exact properties, and reading back where
 * each token actually landed — not by reasoning about the algorithm.
 *
 * ONLY a leading digit, and only when the label has Arabic-script letters in it
 * to be torn away from. An emoji-led label — «🟢 پلاتینیوم» — renders correctly
 * as it is, because a neutral takes the paragraph's own direction and stays
 * put; anchoring that one moves the emoji to the far end instead. Measured too.
 *
 * Here rather than where the labels are built, for the same reason `clamp` is
 * here: it is the one place every screen passes through, so a screen written
 * later cannot forget it. The menu functions keep returning the plain string,
 * which is what their tests read.
 */
// Escapes, not the characters themselves. RTL_MARK is zero-width: written
// literally it is an invisible byte in the middle of a line, which is how it
// gets deleted by a hand that cannot see it. The ranges are spelled out for the
// same reason — `٠-٩` and `۰-۹` are two different digit blocks that look alike,
// and both appear in this shop's product names.
const RTL_MARK = '\u200F';
const LEADING_DIGIT = /^[\d\u0660-\u0669\u06F0-\u06F9]/;
const ARABIC_LETTER = /[\u0621-\u064A\u066E-\u06D3\u06FA-\u06FF]/;

export function anchorLabel(text: string): string {
  return LEADING_DIGIT.test(text) && ARABIC_LETTER.test(text) ? RTL_MARK + text : text;
}

/** The same, applied to every label in a keyboard. `copy_text` is left alone:
 *  that one goes on the clipboard and then into a banking app. */
function anchorKeyboard(keyboard: InlineKeyboard): InlineKeyboard {
  return keyboard.map((row) => row.map((b) => ({ ...b, text: anchorLabel(b.text) })));
}

/** Omitted entirely when there is no keyboard, so a menu is never sent as `null`. */
function markup(keyboard?: InlineKeyboard): Record<string, unknown> {
  return keyboard === undefined ? {} : { reply_markup: { inline_keyboard: anchorKeyboard(keyboard) } };
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
    return readEnvelope(method, response);
  }

  /**
   * The same call with a multipart body, for the one method that uploads bytes.
   *
   * `content-type` is deliberately not set: `fetch` derives it from the
   * `FormData`, and it has to carry the boundary it generated. Setting it by
   * hand is how a multipart upload becomes an unparseable one.
   */
  async function callForm(method: string, form: FormData, timeoutMs: number): Promise<unknown> {
    let response: Response;
    try {
      response = await doFetch(`${base}/bot${token}/${method}`, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new Error(`telegram ${method} failed: ${redact(String(err), token)}`);
    }
    return readEnvelope(method, response);
  }

  async function readEnvelope(method: string, response: Response): Promise<unknown> {
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
      throw new TelegramRejection(
        `telegram ${method} rejected: ${redact(envelope.data.description ?? 'no description', token)}`,
        envelope.data.error_code,
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
      log.warn('telegram.custom_emoji_refused');
    }
    await send({ text: stripCustomEmoji(clamped) });
    await options.onCustomEmojiRefused?.();
  }

  return {
    async getMe() {
      const result = await call('getMe', {}, 15_000);
      const parsed = z.object({ username: z.string().optional() }).safeParse(result);
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
          log.error('telegram.update_without_id');
        }
      }
      return updates;
    },

    async getChatMember(chatRef, userId) {
      const result = await call('getChatMember', { chat_id: chatRef, user_id: userId }, 10_000);
      const parsed = z.object({ status: z.string() }).safeParse(result);
      // An answer we cannot read is not "left". It goes back as a throw so the
      // caller treats it as "we could not ask", which is what it is.
      if (!parsed.success) {
        throw new Error('telegram getChatMember returned no status');
      }
      return parsed.data.status;
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

    async sendPhotoBytes(chatId, png, caption, keyboard) {
      const form = new FormData();
      form.set('chat_id', String(chatId));
      // Copied into a fresh ArrayBuffer: `Buffer` is a view onto a shared pool,
      // and handing that view to Blob can send whatever else is in the pool.
      const bytes = new Uint8Array(png.byteLength);
      bytes.set(png);
      form.set('photo', new Blob([bytes], { type: 'image/png' }), 'qr.png');
      if (caption !== undefined) form.set('caption', caption.slice(0, MAX_CAPTION_LENGTH));
      if (keyboard !== undefined) {
        form.set('reply_markup', JSON.stringify({ inline_keyboard: anchorKeyboard(keyboard) }));
      }
      await callForm('sendPhoto', form, 30_000);
    },

    async sendDocument(chatId, fileId, caption) {
      await call(
        'sendDocument',
        {
          chat_id: chatId,
          document: fileId,
          // Not run through `withEmojiFallback`, for the same reason `sendPhoto`
          // is not: a caption here is one short line the bot writes itself.
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
