/**
 * «ربات» — which bot the shop is, and how to make it a different one.
 *
 * The dashboard could configure everything about the shop except the one thing
 * that makes it reachable. `TELEGRAM_BOT_TOKEN` lived only in the process
 * environment, so pointing the shop at a bot meant editing Coolify and
 * redeploying — and nothing in the panel even said which bot was answering.
 *
 * «تنظیمات» is not where this belongs and could not hold it if it were:
 * `SECRET_KEY_PATTERN` matches `token` and refuses both the read and the write,
 * which is the correct behaviour for a screen that lists rows into a browser.
 *
 * ## What this route will not do
 *
 * - **It never sends the token back.** Not masked, not truncated, not once. The
 *   GET answers with what Telegram said the token IS — the bot id, username and
 *   name — which is the question an operator actually has.
 * - **It never logs it.** Not on success, not in a validation failure, not in
 *   an error path. The one place it appears is the URL of a single outbound
 *   request to Telegram, and that request's failure is reported by its status.
 * - **It never stores one Telegram has not confirmed.** A token that does not
 *   answer `getMe` is a typo, and writing it would stop the shop the moment the
 *   bot restarts onto it — with no screen left that could tell you why.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import type { EnvName } from '@shikoo/contracts';
import {
  BOT_TOKEN_SHAPE,
  botIdFromToken,
  keyId,
  panelSecretKey,
  readBotCredential,
  seal,
  type BotIdentity,
} from '@shikoo/domain';
import { audit, type Ident } from './adminAudit.js';

const TELEGRAM_API = 'https://api.telegram.org';

const SetBody = z
  .object({
    // Bounded before the shape is even tested: a megabyte of text should be
    // refused by its size, not by a regex walking it.
    token: z.string().trim().min(20).max(200),
  })
  .strict();

/**
 * Asks Telegram what this token is.
 *
 * The only thing that decides whether a token is stored. A shape check cannot:
 * a revoked token, a token from a bot that has been deleted, and a token with
 * one character wrong all match the pattern perfectly.
 *
 * Returns null for "Telegram says no" and throws for "Telegram could not be
 * reached", because those are different sentences for the operator — one means
 * check your paste, the other means try again.
 */
async function verifyBotToken(token: string): Promise<BotIdentity | null> {
  // `globalThis.fetch`, resolved at call time rather than captured, so a test
  // can spy on it the same way `receipt.test.ts` does. A default parameter
  // would bind the original at module load and quietly ignore the spy.
  const res = await globalThis.fetch(`${TELEGRAM_API}/bot${token}/getMe`, { method: 'POST' });
  const body = (await res.json()) as {
    ok?: boolean;
    result?: {
      id?: number;
      username?: string | null;
      first_name?: string | null;
      is_bot?: boolean;
    };
  };
  if (!res.ok || body.ok !== true || !body.result?.id) return null;
  // Telegram only issues these to bots, so `is_bot: false` means the response
  // is not what this code thinks it is. Refusing an unrecognised answer is the
  // same rule the settings loader follows.
  if (body.result.is_bot === false) return null;
  return {
    botId: body.result.id,
    username: body.result.username ?? null,
    firstName: body.result.first_name ?? null,
  };
}

export function registerBotRoutes(
  app: Hono<{
    Bindings: { DB: D1Database; ENV_NAME?: EnvName; TELEGRAM_BOT_TOKEN?: string };
    Variables: { identity: Ident };
  }>,
) {
  /**
   * Which bot is connected, and from where.
   *
   * Readable by any signed-in operator: this names a bot, not a customer, and
   * a READ_ONLY reviewer looking at a claim benefits from knowing which shop
   * they are looking at. Nothing here is a secret — the token is not in it.
   */
  app.get('/api/v1/admin/bot', async (c) => {
    const envName = c.env.ENV_NAME ?? 'local';
    const stored = await readBotCredential(c.env.DB, envName);
    // What the RUNNING bot said about itself at its last boot. Written by
    // `server.ts` from `getMe`, and until now read by nobody — so the panel
    // could not answer "which bot is this" even though the answer was in the
    // database. It is the evidence half: `stored` is what an operator chose,
    // this is what actually started.
    const live = await c.env.DB.prepare(
      `SELECT value FROM settings WHERE scope = 'bot' AND key = 'username'`,
    ).first<{ value: unknown }>();
    const liveUsername = typeof live?.value === 'string' ? live.value : null;

    return c.json({
      ok: true,
      // `dashboard` when a row of this environment's exists, `environment` when
      // the service is still running on its variable, `none` when neither — and
      // `none` is a shop with no bot, which the screen says in those words.
      source: stored ? 'dashboard' : c.env.TELEGRAM_BOT_TOKEN?.trim() ? 'environment' : 'none',
      envName,
      connected: stored,
      liveUsername,
      // Said by the server so the screen and the API cannot drift apart about
      // what happens next. This is the half an operator gets wrong.
      appliesAfter:
        'ربات تا نیم دقیقه بعد از ذخیره خودش را می‌بندد و کانتینر با ربات تازه بالا می‌آید.',
    });
  });

  /**
   * Connect a bot.
   *
   * ADMIN only. This decides who answers every customer of the shop, which is
   * not a thing a payment reviewer does.
   */
  app.post('/api/v1/admin/bot/token', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = SetBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ ok: false, error: 'bad_body' }, 400);
    }
    const token = body.data.token;
    if (!BOT_TOKEN_SHAPE.test(token)) {
      // The token is not echoed, not even the rejected one. A wrong paste is
      // still somebody's live token more often than it is nonsense.
      return c.json(
        {
          ok: false,
          error: 'bad_shape',
          detail: 'توکن باید به شکل «۱۲۳۴۵۶۷۸:AA…» باشد — همان چیزی که BotFather می‌دهد.',
        },
        422,
      );
    }

    // Before the network call, because a server without the key cannot store
    // what it is about to be told and should say so instead of asking Telegram
    // a question it will throw away.
    let key: Buffer;
    try {
      key = panelSecretKey();
    } catch (err) {
      return c.json({ ok: false, error: 'secret_key_missing', detail: (err as Error).message }, 503);
    }

    let identity: BotIdentity | null;
    try {
      identity = await verifyBotToken(token);
    } catch {
      return c.json(
        {
          ok: false,
          error: 'telegram_unreachable',
          detail: 'تلگرام جواب نداد. توکن ذخیره نشد — دوباره امتحان کن.',
        },
        502,
      );
    }
    if (identity === null) {
      return c.json(
        {
          ok: false,
          error: 'rejected_by_telegram',
          detail: 'تلگرام این توکن را نشناخت. از BotFather دوباره بگیرش.',
        },
        422,
      );
    }
    // The id is in the token and also in the answer. They disagreeing means the
    // response did not come from the token that was sent, which is the shape of
    // a proxy or a mistake worth stopping on rather than storing.
    if (botIdFromToken(token) !== identity.botId) {
      return c.json({ ok: false, error: 'identity_mismatch' }, 502);
    }

    const envName = c.env.ENV_NAME ?? 'local';
    const before = await readBotCredential(c.env.DB, envName);

    await c.env.DB.prepare(
      `INSERT INTO bot_credentials (id, env_name, sealed, key_id, bot_id, username, first_name, set_by)
       VALUES (1, ?1, ?2, ?3, ?4, ?5, ?6, ?7)
       ON CONFLICT (id) DO UPDATE
         SET env_name = EXCLUDED.env_name,
             sealed = EXCLUDED.sealed,
             key_id = EXCLUDED.key_id,
             bot_id = EXCLUDED.bot_id,
             username = EXCLUDED.username,
             first_name = EXCLUDED.first_name,
             set_by = EXCLUDED.set_by,
             updated_at = now()`,
    )
      .bind(
        envName,
        seal(token, key),
        keyId(key),
        identity.botId,
        identity.username,
        identity.firstName,
        ident.email,
      )
      .run();

    // The identity, never the token — `audit_logs` is append-only and read by
    // people, which makes it the last place a secret should be able to reach.
    await audit(
      c.env.DB,
      ident,
      'bot.token_set',
      'bot',
      String(identity.botId),
      before ? { botId: before.botId, username: before.username } : null,
      { botId: identity.botId, username: identity.username },
      null,
    );

    return c.json({ ok: true, connected: { ...identity, envName } });
  });
}
