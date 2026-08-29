/**
 * Where the bot's token comes from, decided in one place.
 *
 * Until now there was one answer — `TELEGRAM_BOT_TOKEN` in the environment —
 * and it had a consequence nobody had written down: the dashboard could not
 * point the shop at a bot. Everything else an operator decides moved into the
 * database and grew a screen; the identity of the bot itself was the one thing
 * that still needed Coolify and a redeploy.
 *
 * Now there are two sources, which is exactly the shape that has bitten this
 * project before: `Channel_Report` had a column and an environment variable and
 * nothing made them agree, so the nightly report and the flood-block report
 * answered differently on the same box. That is why this file exists and why
 * every consumer — the bot's poller, the dashboard's receipt fetch — calls it
 * rather than reading `process.env` itself. One resolution, three callers.
 *
 * ## The order, and why
 *
 * 1. **The stored row wins.** It is what an operator explicitly chose, in a
 *    screen, after Telegram confirmed the token belongs to a bot.
 * 2. **The environment is the fallback.** Every deployment alive today is
 *    configured that way, so nothing changes until somebody uses the screen.
 * 3. **A row from another environment is refused, loudly, and the environment
 *    takes over.** This is the one that matters. A token is not a panel
 *    password: whoever holds it answers customers. If this database is ever
 *    cloned — a restore that grows a second step, a laptop copy, a staging box
 *    seeded from a dump — the copy must not start replying to real people as
 *    the real shop. The row names the environment that wrote it and a process
 *    with a different `ENV_NAME` will not touch it.
 *
 * ## What is NOT here
 *
 * No caching. The bot resolves once at boot and then watches for change; the
 * dashboard resolves per receipt, which is a request that is about to make a
 * network call to Telegram anyway. A cache would only add a window in which
 * the two disagree, which is the thing this file is for.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import { open, panelSecretKey } from './secretBox.js';
import { createLogger } from './log.js';

type Db = D1Database | D1DatabaseSession;

const log = createLogger('bot-token');

/**
 * What a BotFather token looks like: `<bot id>:<35-ish url-safe characters>`.
 *
 * Checked before the token is ever sent anywhere. Not a substitute for asking
 * Telegram — `verifyBotToken` does that and is what actually decides — but a
 * string of the wrong shape must not reach a URL, and refusing it here gives
 * the operator a sentence about their paste rather than a Telegram error code.
 *
 * Deliberately loose on the length of the second half: Telegram has changed it
 * before, and a regex that is stricter than the thing it describes is a
 * rejection of a working token.
 */
export const BOT_TOKEN_SHAPE = /^[1-9]\d{4,}:[A-Za-z0-9_-]{20,}$/;

/** The bot id, which is the part of the token before the colon. */
export function botIdFromToken(token: string): number | null {
  const id = Number(token.slice(0, token.indexOf(':')));
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** What Telegram says a token is. Not a secret — this is what the screen draws. */
export interface BotIdentity {
  botId: number;
  username: string | null;
  firstName: string | null;
}

/** The stored row, without the thing that makes it a secret. */
export interface BotCredentialRow extends BotIdentity {
  envName: string;
  keyId: string;
  setBy: string | null;
  updatedAt: string;
}

export interface ResolvedBotToken {
  token: string;
  /** Where it came from, so a screen and a log line can say. */
  source: 'dashboard' | 'environment';
  /** What Telegram said when the token was accepted. Null for `environment`. */
  identity: BotIdentity | null;
}

interface Row {
  env_name: string;
  sealed: string;
  key_id: string;
  bot_id: number;
  username: string | null;
  first_name: string | null;
  set_by: string | null;
  updated_at: string;
}

const SELECT = `SELECT env_name, sealed, key_id, bot_id, username, first_name, set_by,
                       updated_at::text AS updated_at
                  FROM bot_credentials WHERE id = 1`;

/**
 * The stored row for display. Never the token.
 *
 * Returns null when nothing is stored, including when the row belongs to
 * another environment: a screen that drew somebody else's bot as «connected»
 * would be worse than drawing nothing.
 */
export async function readBotCredential(
  db: Db,
  envName: string,
): Promise<BotCredentialRow | null> {
  const row = await db.prepare(SELECT).first<Row>();
  if (!row || row.env_name !== envName) return null;
  return {
    envName: row.env_name,
    keyId: row.key_id,
    botId: Number(row.bot_id),
    username: row.username,
    firstName: row.first_name,
    setBy: row.set_by,
    updatedAt: row.updated_at,
  };
}

/**
 * The token this process should run with, or null if it has none.
 *
 * Throws only when a row exists, belongs here, and cannot be opened. That is
 * not a missing token and must not be treated as one: falling back to the
 * environment there would silently run a DIFFERENT bot from the one the
 * operator chose, which is the same class of failure as two disagreeing report
 * channels — except the visible symptom is customers talking to the wrong shop.
 */
export async function resolveBotToken(
  db: Db,
  envName: string,
  env: { TELEGRAM_BOT_TOKEN?: string | undefined; PANEL_SECRET_KEY?: string | undefined } = process
    .env as never,
): Promise<ResolvedBotToken | null> {
  const fallback = env.TELEGRAM_BOT_TOKEN?.trim();
  const fromEnv: ResolvedBotToken | null = fallback
    ? { token: fallback, source: 'environment', identity: null }
    : null;

  let row: Row | null;
  try {
    row = await db.prepare(SELECT).first<Row>();
  } catch (err) {
    // A database that cannot be asked is not a database that says "no bot".
    // The environment is what this process ran with yesterday, and running is
    // better than not — the same call `loadShopSettings` makes.
    log.warn('bot_token.read_failed', { using: fromEnv ? 'the environment' : 'nothing' }, err);
    return fromEnv;
  }
  if (!row) return fromEnv;

  if (row.env_name !== envName) {
    // The loud half of the guarantee in `migrations/0038`. Not an error: this
    // is a copied database behaving correctly, and the operator needs to see
    // it once rather than have the process refuse to start.
    log.warn('bot_token.foreign_environment', {
      storedFor: row.env_name,
      runningAs: envName,
      using: fromEnv ? 'the environment' : 'nothing',
      consequence: 'the stored token is ignored so this copy cannot answer the real shop',
    });
    return fromEnv;
  }

  const token = open(row.sealed, panelSecretKey(env), 'the stored bot token');
  return {
    token,
    source: 'dashboard',
    identity: {
      botId: Number(row.bot_id),
      username: row.username,
      firstName: row.first_name,
    },
  };
}

