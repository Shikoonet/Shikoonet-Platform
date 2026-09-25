/**
 * The support bot's door (n8n, Telegram Business). Four questions it may ask
 * about the person it is talking to: which trials they may have, order one,
 * which servers and link version their service has, and the shop's rules.
 *
 * A bearer token, not the HMAC the Mirzabot door uses: n8n can hold a token in
 * its encrypted credential store, while an HMAC would have to be computed in a
 * Code node whose text — secret included — shows in the editor and in every
 * saved version. A replayed request cannot hurt: reads change nothing, and a
 * trial is spent once (quota + a two-minute guard).
 *
 * The telegram id is the SENDER of the message, taken by n8n from Telegram's
 * update; the model only ever chooses a panel from the options list.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { Texts } from '@shikoo/contracts';
import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import type { Env } from '../index.js';

export const SUPPORT_BASE_PATH = '/api/v1/integrations/support';
const MAX_BODY_BYTES = 2048;

type Db = D1Database | D1DatabaseSession;

export const WhoBody = z
  .object({ telegram_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
  .strict();

/** The customer behind a telegram id, or null when they never started the shop bot. */
export async function customerOf(
  db: Db,
  telegramId: number,
): Promise<{ id: number; status: string; testQuotaUsed: number } | null> {
  const row = await db
    .prepare(`SELECT id, status, test_quota_used FROM users WHERE telegram_id = ?1`)
    .bind(telegramId)
    .first<{ id: number; status: string; test_quota_used: number }>();
  return row ? { id: row.id, status: row.status, testQuotaUsed: row.test_quota_used } : null;
}

/** Hashed first so unequal lengths compare in the same time as equal ones. */
function bearerMatches(header: string | undefined, token: string): boolean {
  if (header === undefined || !header.startsWith('Bearer ')) return false;
  const given = createHash('sha256').update(header.slice('Bearer '.length)).digest();
  const wanted = createHash('sha256').update(token).digest();
  return timingSafeEqual(given, wanted);
}

export const support = new Hono<{ Bindings: Env }>();

support.use('*', async (c, next) => {
  if (c.env.SUPPORT_INTEGRATION_ENABLED !== 'true') {
    return c.json({ ok: false, error: 'not_found' }, 404);
  }
  const token = c.env.SUPPORT_INTEGRATION_TOKEN;
  if (!token) return c.json({ ok: false, error: 'integration_not_configured' }, 503);
  if (c.env.SUPPORT_LIMIT) {
    const allowed = await c.env.SUPPORT_LIMIT.limit({ key: 'support' });
    if (!allowed.success) return c.json({ ok: false, error: 'rate_limited' }, 429);
  }
  if (!bearerMatches(c.req.header('Authorization'), token)) {
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  return next();
});

support.use(
  '*',
  bodyLimit({
    maxSize: MAX_BODY_BYTES,
    onError: (c) => c.json({ ok: false, error: 'too_large' }, 413),
  }),
);

/**
 * The rules gate and its text. The gate is `bot/roll_Status = rolleon`; the
 * text is what the bot would show, through the same `Texts` the bot uses, so
 * an override the bot would drop is dropped here too. The code's own
 * placeholder («…از پنل مدیریت اینجا بنویسید») is «no rules written».
 */
support.post('/rules', async (c) => {
  const db = c.env.DB;
  const gate = await db
    .prepare(`SELECT value #>> '{}' AS v FROM settings WHERE scope = 'bot' AND key = 'roll_Status'`)
    .first<{ v: string | null }>();
  const { results } = await db
    .prepare(`SELECT key, value FROM bot_texts`)
    .all<{ key: string; value: string }>();
  const text = new Texts(Object.fromEntries((results ?? []).map((r) => [r.key, r.value]))).raw(
    'GATE_RULES',
  );
  const placeholder = new Texts().raw('GATE_RULES');
  return c.json({
    ok: true,
    enabled: (gate?.v ?? '').trim() === 'rolleon',
    text: text === placeholder ? null : text,
  });
});
