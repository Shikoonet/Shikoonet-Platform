/**
 * The receipt an operator is about to decide about, on their screen at last.
 *
 * The bot has stored these since it was written. `receiptFor()` was written to
 * read them back and had **zero callers**; the column was not even in the
 * `SELECT` behind «پرداخت‌ها». So a customer sent a picture of their transfer,
 * the bot said «رسید شما دریافت شد», and nobody could ever look at it. Sam
 * asked the question that found it — «ادمین عکس فیش را کجا می‌بیند؟» — and the
 * honest answer was: nowhere.
 *
 * ## Nothing is stored, and that is deliberate
 *
 * The column holds a Telegram `file_id`; Telegram holds the image. This route
 * fetches it on demand and streams it through. No bytes are written to disk, no
 * cache, no bucket — so receipts cost the shop no storage and no cleanup job,
 * and the operator sees Telegram's original rather than a copy of one.
 *
 * ## Why the bot token has to be here
 *
 * `getFile` is authenticated per bot. There is no way to read a `file_id`
 * without the token that received it, so the dashboard needs
 * `TELEGRAM_BOT_TOKEN` — the same value the bot already runs with, on the same
 * box. It is never logged, never returned, and never put in a redirect: the
 * download URL contains the token, so handing the browser a 302 would publish
 * it to every operator's history and to any proxy in between. The bytes are
 * proxied instead.
 *
 * ## What the browser is allowed to be told
 *
 * The `file_id` itself never reaches the client — the list carries a boolean.
 * A handle is a bearer capability for anyone holding the bot token, and there
 * is no reason for it to leave the server.
 */

import type { Hono } from 'hono';
import type { D1Database } from '@shikoo/database';
import { MIRZABOT_SOURCE, RECEIPT_FILE_ID, receiptRef } from '@shikoo/contracts';
import type { EnvName } from '@shikoo/contracts';
import { createLogger, resolveBotToken } from '@shikoo/domain';

const log = createLogger('dashboard');

type Ident = { email: string; role: import('@shikoo/contracts').AccessRole };

/** Telegram's own API host. Same base the bot uses. */
const TELEGRAM_API = 'https://api.telegram.org';

/**
 * What we are willing to hand back, keyed by the extension Telegram reports.
 *
 * An allow-list rather than Telegram's `Content-Type`, and rather than the
 * file's own claim about itself. Whatever arrives is put in front of an
 * authenticated operator inside our origin; if a customer can make the shop
 * serve `text/html` from a bank-receipt URL, the receipt is a stored-XSS
 * delivery mechanism. Anything not on this list is refused rather than guessed.
 */
const CONTENT_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  pdf: 'application/pdf',
};

function contentTypeFor(filePath: string): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return CONTENT_TYPES[ext] ?? null;
}

export function registerReceiptRoutes(
  app: Hono<{
    Bindings: { DB: D1Database; ENV_NAME?: EnvName; TELEGRAM_BOT_TOKEN?: string };
    Variables: { identity: Ident };
  }>,
) {
  /**
   * Readable by every role, including READ_ONLY.
   *
   * Looking at the evidence is reading. A reviewer who may see that a payment
   * is suspected of being forged, and may not see the document it turns on, is
   * being asked to take somebody's word for it — which is the opposite of what
   * this screen is for.
   */
  app.get('/api/v1/payment-claims/:claimId/receipt', async (c) => {
    const claimId = c.req.param('claimId');

    const row = await c.env.DB.prepare(
      `SELECT receipt_url_or_r2_key AS handle
         FROM payment_claims
        WHERE id = ?1 AND source_system = ?2`,
    )
      .bind(claimId, MIRZABOT_SOURCE)
      .first<{ handle: string | null }>();

    if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
    // A claim with no receipt is the ordinary case, not an error in the system:
    // the customer pressed «پرداخت کردم» and sent nothing. Distinguished from a
    // missing claim so the screen can say which.
    if (!row.handle) return c.json({ ok: false, error: 'no_receipt' }, 404);

    const { fileId } = receiptRef(row.handle);
    // Re-validated here, BEFORE any network call, and this is the check that
    // matters most. The row was written by a handler reading an untrusted
    // update; this one is about to interpolate it into a request to a third
    // party. Rejecting the shape costs nothing and closes the gap between
    // "what was stored" and "what is safe to send".
    if (!RECEIPT_FILE_ID.test(fileId)) {
      // The handle is not logged — not even the malformed one. It is the whole
      // capability, and a log line is the wrong place for it.
      log.warn('receipt.handle_rejected', { claimId, consequence: 'receipt not shown' });
      return c.json({ ok: false, error: 'bad_handle' }, 422);
    }

    // The same resolution the bot boots with, rather than this worker's own
    // variable. Before this, an operator who connected a different bot from the
    // panel got a working shop and receipts that 404 for ever — `getFile` is
    // authenticated per bot, so the OLD token cannot read the NEW bot's files
    // and nothing would have said why.
    let token: string | undefined;
    try {
      token = (await resolveBotToken(c.env.DB, c.env.ENV_NAME ?? 'local', c.env))?.token;
    } catch (err) {
      // A stored row that will not open. Distinguished from "not set" because
      // the fix is a different one: the key, not the token.
      log.warn('receipt.token_unreadable', { claimId }, err);
      return c.json({ ok: false, error: 'bot_token_unreadable' }, 503);
    }
    if (!token) {
      // Said plainly rather than as a 500. This is a deployment that has not
      // been given the token yet, and an operator staring at a broken image
      // deserves to know it is configuration and not their claim.
      return c.json(
        {
          ok: false,
          error: 'no_bot_token',
          message:
            'هیچ رباتی وصل نیست، پس رسید خوانده نمی‌شود. از «پیکربندی › ربات تلگرام» یک ربات وصل کن ' +
            '(یا TELEGRAM_BOT_TOKEN را روی این سرویس بگذار).',
        },
        503,
      );
    }

    let filePath: string;
    try {
      const meta = await fetch(`${TELEGRAM_API}/bot${token}/getFile`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ file_id: fileId }),
      });
      const parsed = (await meta.json()) as {
        ok?: boolean;
        result?: { file_path?: string };
      };
      if (!parsed.ok || !parsed.result?.file_path) {
        // Telegram refused. The commonest cause is a handle that has aged out
        // of a bot's reach after a token change; either way there is nothing to
        // show and nothing we can do about it here.
        log.warn('receipt.unavailable', { claimId, consequence: 'receipt not shown' });
        return c.json({ ok: false, error: 'receipt_unavailable' }, 404);
      }
      filePath = parsed.result.file_path;
    } catch (err) {
      // Telegram being unreachable is a Tuesday in this country. It is not a
      // failure of the claim and must not read like one.
      log.error('receipt.fetch_failed', { claimId, will_retry: false }, err);
      return c.json({ ok: false, error: 'receipt_unreachable' }, 502);
    }

    const type = contentTypeFor(filePath);
    if (type === null) {
      log.warn('receipt.type_refused', { claimId, consequence: 'receipt not shown' });
      return c.json({ ok: false, error: 'unsupported_type' }, 415);
    }

    const file = await fetch(`${TELEGRAM_API}/file/bot${token}/${filePath}`);
    if (!file.ok || !file.body) {
      log.warn('receipt.download_failed', { claimId, status: file.status });
      return c.json({ ok: false, error: 'receipt_unavailable' }, 404);
    }

    return new Response(file.body, {
      status: 200,
      headers: {
        'content-type': type,
        // Never sniffed: the type is ours, from the allow-list above, and the
        // browser must not be allowed to reconsider it.
        'x-content-type-options': 'nosniff',
        // Not cached by anything in between. This is a customer's bank receipt
        // behind an operator's session, and a shared cache holding it would
        // outlive the session that was allowed to see it.
        'cache-control': 'private, no-store',
        // Belt and braces for the same reason as `nosniff`: even if the type
        // were ever wrong, nothing here executes as a document.
        'content-security-policy': "default-src 'none'; sandbox",
      },
    });
  });
}
