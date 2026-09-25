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
import { claimTrial, clientIp, createLogger, readTrialQuota, trialPanels } from '@shikoo/domain';
import type { Env } from '../index.js';
import { readSubscriptionNames } from './subscriptionNames.js';

export const SUPPORT_BASE_PATH = '/api/v1/integrations/support';
const MAX_BODY_BYTES = 2048;

const log = createLogger('ingest.support');

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
  // The token first, and only then the door's one bucket: charged before the
  // check, anybody could spend it and lock n8n out (security review,
  // 2026-09-26). A wrong token is charged to its own address instead, so a
  // guesser slows down without touching the caller that holds the token.
  if (!bearerMatches(c.req.header('Authorization'), token)) {
    const ip = clientIp((name) => c.req.header(name), c.env.TRUSTED_PROXY_IP_HEADER);
    if (c.env.IP_LIMIT && ip !== null) {
      const allowed = await c.env.IP_LIMIT.limit({ key: `support:${ip}` });
      if (!allowed.success) return c.json({ ok: false, error: 'rate_limited' }, 429);
    }
    return c.json({ ok: false, error: 'unauthorized' }, 401);
  }
  if (c.env.SUPPORT_LIMIT) {
    const allowed = await c.env.SUPPORT_LIMIT.limit({ key: 'support' });
    if (!allowed.success) return c.json({ ok: false, error: 'rate_limited' }, 429);
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

const TrialBody = z
  .object({
    telegram_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    panel_id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  })
  .strict();

/** The body as JSON, or null — a malformed body is `invalid_body`, never a 500. */
async function jsonOf(c: { req: { json: () => Promise<unknown> } }): Promise<unknown> {
  return c.req.json().catch(() => null);
}

/**
 * Which trials this person may have, and through which door.
 *
 * Each panel appears once: through the shop bot when its own trial is on
 * (the customer is sent there), otherwise through the support door when
 * «تست از پشتیبانی» is on. `quota_left` is the shared allowance: a trial
 * taken in the shop bot has already spent it.
 */
support.post('/trial/options', async (c) => {
  const who = WhoBody.safeParse(await jsonOf(c));
  if (!who.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const db = c.env.DB;
  const user = await customerOf(db, who.data.telegram_id);
  if (user === null) {
    return c.json({ ok: true, customer: 'not_started', quota_left: 0, services: [] });
  }
  if (user.status === 'BLOCKED') {
    return c.json({ ok: true, customer: 'blocked', quota_left: 0, services: [] });
  }
  const quota = await readTrialQuota(db);
  const services = (await trialPanels(db, user.id)).flatMap((p) => {
    const door = p.shop.enabled ? ('shop_bot' as const) : p.support.enabled ? ('support' as const) : null;
    if (door === null) return [];
    const t = door === 'shop_bot' ? p.shop : p.support;
    return [
      {
        panel_id: p.providerId,
        name: p.name,
        via: door,
        volume_gb: t.volumeGb,
        duration_hours: t.durationHours,
      },
    ];
  });
  return c.json({
    ok: true,
    customer: 'ok',
    quota_left: Math.max(0, quota - user.testQuotaUsed),
    services,
  });
});

type TrialResult =
  | { result: 'on_the_way' | 'use_shop_bot' | 'already_on_the_way'; service: string }
  | { result: 'already_used' | 'not_started' | 'blocked' | 'not_available' };

/**
 * Orders a trial through the shop bot's own path: a PAID TRIAL order that the
 * bot's provisioning sweep builds on the panel and delivers in the shop bot.
 * Nothing here talks to the panel.
 */
support.post('/trial', async (c) => {
  const body = TrialBody.safeParse(await jsonOf(c));
  if (!body.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const { telegram_id: telegramId, panel_id: panelId } = body.data;

  const out = await c.env.DB.withSession(async (tx): Promise<TrialResult> => {
    // The row lock serialises two requests for one person: the second waits
    // here, then sees the first one's order in the two-minute check below.
    const user = await tx
      .prepare(`SELECT id, status FROM users WHERE telegram_id = ?1 FOR UPDATE`)
      .bind(telegramId)
      .first<{ id: number; status: string }>();
    if (!user) return { result: 'not_started' };
    if (user.status === 'BLOCKED') return { result: 'blocked' };

    // Re-derived for THIS customer; the number from the request is only looked up.
    const panel = (await trialPanels(tx, user.id)).find((p) => p.providerId === panelId);
    if (!panel) return { result: 'not_available' };
    if (panel.shop.enabled) return { result: 'use_shop_bot', service: panel.name };
    if (!panel.support.enabled) return { result: 'not_available' };

    const recent = await tx
      .prepare(
        `SELECT 1 AS x FROM orders
          WHERE user_id = ?1 AND kind = 'TRIAL' AND created_at > now() - interval '2 minutes'
          LIMIT 1`,
      )
      .bind(user.id)
      .first<{ x: number }>();
    if (recent) return { result: 'already_on_the_way', service: panel.name };

    const claimed = await claimTrial(tx, user.id, panel.providerId, await readTrialQuota(tx));
    if (claimed === null) return { result: 'already_used' };
    log.info('support.trial_ordered', { ref: claimed.publicId, panel: panel.providerId });
    return { result: 'on_the_way', service: panel.name };
  });
  return c.json({ ok: true, ...out });
});

/**
 * Server names and the link version: the customer's own services, and one
 * company sample account per panel for someone who has none (Sam, 2026-09-25).
 * Names only — the subscription link never leaves this process.
 */
support.post('/servers', async (c) => {
  const who = WhoBody.safeParse(await jsonOf(c));
  if (!who.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const db = c.env.DB;
  const fetchImpl = c.env.SUBSCRIPTION_FETCH;
  const user = await customerOf(db, who.data.telegram_id);

  const own =
    user === null
      ? []
      : ((
          await db
            .prepare(
              `SELECT plan_name_at_sale AS service, subscription_url AS url
                 FROM subscriptions
                WHERE user_id = ?1 AND status IN ('ACTIVE', 'ON_HOLD')
                  AND subscription_url IS NOT NULL
                ORDER BY id`,
            )
            .bind(user.id)
            .all<{ service: string | null; url: string }>()
        ).results ?? []);
  const samples =
    (
      await db
        .prepare(
          `SELECT pr.name AS service, pr.config->>'support_sample_subscription_url' AS url
             FROM provisioning_providers pr
            WHERE pr.status = 'ACTIVE'
              AND NULLIF(pr.config->>'support_sample_subscription_url', '') IS NOT NULL
            ORDER BY pr.sort_order, pr.id`,
        )
        .all<{ service: string; url: string }>()
    ).results ?? [];

  const read = async (rows: { service: string | null; url: string }[]) =>
    (
      await Promise.all(
        rows.map(async (r) => {
          const names = await readSubscriptionNames(r.url, fetchImpl ? { fetchImpl } : {});
          return names === null ? null : { service: r.service ?? '', ...names };
        }),
      )
    ).filter((x): x is NonNullable<typeof x> => x !== null);

  return c.json({ ok: true, own: await read(own), catalog: await read(samples) });
});
