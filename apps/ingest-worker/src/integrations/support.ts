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
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { Texts } from '@shikoo/contracts';
import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import {
  claimTrial,
  clientIp,
  createLogger,
  MEMBERSHIP_TTL_MS,
  requiredChannels,
  trialPanels,
} from '@shikoo/domain';
import type { Env } from '../index.js';
import { readSubscriptionNames, type SubscriptionNames } from './subscriptionNames.js';

export const SUPPORT_BASE_PATH = '/api/v1/integrations/support';
const MAX_BODY_BYTES = 2048;
/** The whole `/servers` answer, however many panels are slow. */
const SERVERS_BUDGET_MS = 6_000;
/** A reseller can hold dozens of services; the newest few answer «which servers». */
const OWN_SERVICES_MAX = 5;

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
  const { results } = await db
    .prepare(`SELECT key, value FROM bot_texts`)
    .all<{ key: string; value: string }>();
  const text = new Texts(Object.fromEntries((results ?? []).map((r) => [r.key, r.value]))).raw(
    'GATE_RULES',
  );
  const placeholder = new Texts().raw('GATE_RULES');
  return c.json({
    ok: true,
    enabled: await rulesGateOn(db),
    text: text === placeholder ? null : text,
  });
});

/**
 * The answers the support bot may give, as written in «محتوا» → «پرسش و پاسخ
 * پشتیبانی» (0105). Only visible rows, in the panel's order, numbered and
 * joined into the one block the bot's prompt takes; the bot fetches it on every
 * message, so an edit is live on the next question.
 *
 * ponytail: the whole list goes into every prompt. Fine for tens of answers;
 * past ~100 the prompt cost says retrieve the few that match instead.
 */
support.post('/kb', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT question, answer FROM support_answers WHERE active ORDER BY sort_order, id`,
  ).all<{ question: string; answer: string }>();
  const rows = results ?? [];
  return c.json({
    ok: true,
    count: rows.length,
    text: rows.map((r, i) => `${i + 1}) ${r.question.trim()}\n${r.answer.trim()}`).join('\n\n'),
  });
});

/**
 * Every visible question with its number, and how customers have asked it: what
 * the bot reads to pick the answers that fit a message (0106). Answers are not
 * here: the bot asks `/kb/answers` for the few it picked, so the prompt stays
 * small however long the list grows.
 */
support.post('/kb/index', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, question, variants FROM support_answers WHERE active ORDER BY sort_order, id`,
  ).all<{ id: number; question: string; variants: string }>();
  const rows = results ?? [];
  const line = (r: { id: number; question: string; variants: string }) => {
    const also = r.variants
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean)
      .slice(0, KB_INDEX_VARIANTS);
    return `#${r.id} ${r.question.trim()}${also.length ? ` (یا: ${also.join(' | ')})` : ''}`;
  };
  return c.json({ ok: true, count: rows.length, text: rows.map(line).join('\n') });
});

/** How many customer phrasings each index line carries; the rest stay in the panel. */
const KB_INDEX_VARIANTS = 3;

const AnswersBody = z
  .object({ ids: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).max(8) })
  .strict();

/**
 * The answers for the numbers the bot picked from `/kb/index`, visible ones
 * only, in the order asked. A row an admin marked «به همکار بسپار» says so in
 * place of its text, so the bot passes the customer on instead of answering.
 */
support.post('/kb/answers', async (c) => {
  const body = AnswersBody.safeParse(await jsonOf(c));
  if (!body.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  if (body.data.ids.length === 0) return c.json({ ok: true, count: 0, text: '' });
  const { results } = await c.env.DB.prepare(
    `SELECT id, question, answer, hand_off FROM support_answers
      WHERE active AND id = ANY(?1::bigint[])`,
  )
    .bind(body.data.ids)
    .all<{ id: number; question: string; answer: string; hand_off: boolean }>();
  const byId = new Map((results ?? []).map((r) => [Number(r.id), r]));
  const rows = body.data.ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const block = (r: { id: number; question: string; answer: string; hand_off: boolean }) =>
    `#${r.id} ${r.question.trim()}\n` +
    (r.hand_off ? HAND_OFF : r.answer.trim());
  return c.json({ ok: true, count: rows.length, text: rows.map(block).join('\n\n') });
});

/** What the bot reads in place of a hand-off row's text. */
const HAND_OFF = '[به همکار بسپار] این مورد را فقط همکار انجام می‌دهد؛ فقط ESCALATE بنویس.';

/** Whether the shop bot asks for its rules: `bot/roll_Status = rolleon`. */
async function rulesGateOn(db: Db): Promise<boolean> {
  const gate = await db
    .prepare(`SELECT value #>> '{}' AS v FROM settings WHERE scope = 'bot' AND key = 'roll_Status'`)
    .first<{ v: string | null }>();
  return (gate?.v ?? '').trim() === 'rolleon';
}

type ShopGate =
  | { gate: 'join_channels'; channels: { title: string; join_link: string }[] }
  | { gate: 'accept_rules' };

/**
 * The shop bot's own two doors, which a support trial passes too (Sam,
 * 2026-09-26). Only the shop bot holds the token that can ask Telegram about a
 * channel, so this reads what it last recorded and trusts it for as long as
 * the shop bot does; anything older sends the customer to join and press start
 * there, which asks again. Channels before rules, the order the shop bot asks.
 *
 * An active admin passes both, because the shop bot waves them past both
 * (`isActiveAdmin` in apps/bot/src/handle.ts) and so never asks Telegram about
 * them: their stamp stays empty for good, and pressing start cannot fill it.
 * Before this, every admin who tried a support trial was sent to join a channel
 * they were already in (Arshia, 2026-09-26).
 */
async function shopGateFor(db: Db, userId: number): Promise<ShopGate | null> {
  const user = await db
    .prepare(
      `SELECT u.rules_accepted,
              COALESCE(u.channels_checked_at > now() - ?2::float8 * interval '1 millisecond', false)
                AS confirmed,
              EXISTS (SELECT 1 FROM admins a WHERE a.telegram_id = u.telegram_id AND a.active) AS admin
         FROM users u WHERE u.id = ?1`,
    )
    .bind(userId, MEMBERSHIP_TTL_MS)
    .first<{ rules_accepted: boolean; confirmed: boolean; admin: boolean }>();
  if (user?.admin) return null;
  if (!user?.confirmed) {
    const channels = await requiredChannels(db);
    if (channels.length > 0) {
      return {
        gate: 'join_channels',
        channels: channels.map(({ title, join_link }) => ({ title, join_link })),
      };
    }
  }
  if (!user?.rules_accepted && (await rulesGateOn(db))) return { gate: 'accept_rules' };
  return null;
}

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
 * A support trial is for someone new, and once (Sam, 2026-09-26: «اکانت تست
 * فقط و فقط برای افرادی هست که تازه به مجموعه اضافه شدن و هیچ سرویسی از ما
 * ندارن»).
 *
 * «Had a trial» is the shared counter OR a TRIAL order that did not fail: a
 * counter the dashboard reset forgets the trial, the order does not. «Had a
 * service» is any subscription that was delivered — an imported PHP trial is
 * one; an unpaid or failed one is not — or a sale paid for and not yet
 * delivered. A wallet top-up alone is not a service.
 */
async function newcomerRefusal(db: Db, userId: number): Promise<'already_used' | 'not_new' | null> {
  const row = await db
    .prepare(
      `SELECT u.test_quota_used > 0
                OR EXISTS (SELECT 1 FROM orders o
                            WHERE o.user_id = u.id AND o.kind = 'TRIAL'
                              AND o.status NOT IN ('FAILED', 'CANCELLED')) AS had_trial,
              EXISTS (SELECT 1 FROM subscriptions s
                       WHERE s.user_id = u.id AND s.status NOT IN ('PENDING_PAYMENT', 'FAILED'))
                OR EXISTS (SELECT 1 FROM orders o
                            WHERE o.user_id = u.id AND o.kind NOT IN ('TRIAL', 'WALLET_TOPUP')
                              AND o.status IN ('PAID', 'PROVISIONING', 'COMPLETED')) AS had_service
         FROM users u WHERE u.id = ?1`,
    )
    .bind(userId)
    .first<{ had_trial: boolean; had_service: boolean }>();
  if (row?.had_trial) return 'already_used';
  if (row?.had_service) return 'not_new';
  return null;
}

/**
 * The shop's own words for each panel's products — what the plan screen shows
 * under its title, edited in «محصولات» — so the bot explains the difference
 * between two services in the shop's words, never its own.
 */
async function productWords(db: Db): Promise<Map<number, string[]>> {
  const { results } = await db
    .prepare(
      `SELECT provider_id::int AS provider_id, btrim(description) AS description FROM products
        WHERE status = 'ACTIVE' AND NOT resellers_only AND provider_id IS NOT NULL
          AND NULLIF(btrim(description), '') IS NOT NULL
        ORDER BY sort_order, id`,
    )
    .all<{ provider_id: number; description: string }>();
  const out = new Map<number, string[]>();
  for (const r of results ?? []) out.set(r.provider_id, [...(out.get(r.provider_id) ?? []), r.description]);
  return out;
}

/**
 * Whether this person may have a support trial, and on which services.
 *
 * Only «تست از پشتیبانی» decides the list. The shop bot's own trial switch is
 * not asked: it is often off, and this door exists to give a newcomer a trial
 * exactly then (Sam, 2026-09-26). The newcomer rule comes before the channel
 * and the rules, so nobody is sent to join a channel for a trial they cannot
 * have.
 */
support.post('/trial/options', async (c) => {
  const who = WhoBody.safeParse(await jsonOf(c));
  if (!who.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const db = c.env.DB;
  const user = await customerOf(db, who.data.telegram_id);
  if (user === null) return c.json({ ok: true, customer: 'not_started', services: [] });
  if (user.status === 'BLOCKED') return c.json({ ok: true, customer: 'blocked', services: [] });
  const refused = await newcomerRefusal(db, user.id);
  if (refused !== null) return c.json({ ok: true, customer: refused, services: [] });
  const gated = await shopGateFor(db, user.id);
  if (gated !== null) {
    const { gate, ...rest } = gated;
    return c.json({ ok: true, customer: gate, ...rest, services: [] });
  }
  const panels = (await trialPanels(db, user.id)).filter((p) => p.support.enabled);
  const words = panels.length > 0 ? await productWords(db) : new Map<number, string[]>();
  return c.json({
    ok: true,
    customer: 'ok',
    services: panels.map((p) => ({
      panel_id: p.providerId,
      name: p.name,
      about: words.get(p.providerId) ?? [],
      volume_gb: p.support.volumeGb,
      duration_hours: p.support.durationHours,
    })),
  });
});

type TrialResult =
  | { result: 'on_the_way'; service: string; ref: string }
  | { result: 'already_on_the_way'; service: string }
  | { result: 'join_channels'; channels: { title: string; join_link: string }[] }
  | {
      result: 'accept_rules' | 'already_used' | 'not_new' | 'not_started' | 'blocked' | 'not_available';
    };

/**
 * Orders a trial through the shop bot's own path: a PAID TRIAL order that the
 * bot's provisioning sweep builds on the panel and delivers in the shop bot.
 * Nothing here talks to the panel.
 *
 * `ref` is the order's public id, so whoever reads the support chat can find
 * the order; `audit_logs` keeps which door it came through.
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

    // Before the newcomer rule: the first of two requests has just made this
    // person «had a trial», and the second must hear «on the way», not «used».
    // A trial the panel refused is not «on the way»: `fail()` has already
    // given the quota back and told the customer (final review, 2026-09-26).
    const recent = await tx
      .prepare(
        `SELECT pr.name FROM orders o JOIN provisioning_providers pr ON pr.id = o.provider_id
          WHERE o.user_id = ?1 AND o.kind = 'TRIAL' AND o.status <> 'FAILED'
            AND o.created_at > now() - interval '2 minutes'
          ORDER BY o.id DESC LIMIT 1`,
      )
      .bind(user.id)
      .first<{ name: string }>();
    if (recent) return { result: 'already_on_the_way', service: recent.name };

    const refused = await newcomerRefusal(tx, user.id);
    if (refused !== null) return { result: refused };
    const gated = await shopGateFor(tx, user.id);
    if (gated !== null) {
      return gated.gate === 'join_channels'
        ? { result: 'join_channels', channels: gated.channels }
        : { result: 'accept_rules' };
    }

    // Re-derived for THIS customer; the number from the request is only looked up.
    const panel = (await trialPanels(tx, user.id)).find(
      (p) => p.providerId === panelId && p.support.enabled,
    );
    if (!panel) return { result: 'not_available' };

    // One per person whatever the shop's own allowance is — the shop may close
    // its trials while this door stays open. The newcomer rule above is the
    // rule; the 1 keeps the counter's guard inside the UPDATE.
    const claimed = await claimTrial(tx, user.id, panel.providerId, 1);
    if (claimed === null) return { result: 'already_used' };
    await tx
      .prepare(
        `INSERT INTO audit_logs
           (id, actor_email, actor_role, action, entity_type, entity_id, after_json, reason, created_at)
         VALUES (?1, NULL, 'SYSTEM', 'support.trial_ordered', 'ORDER', ?2, ?3,
                 'the support bot gave a newcomer a trial', ?4)`,
      )
      .bind(
        randomUUID(),
        claimed.publicId,
        JSON.stringify({ telegram_id: telegramId, panel_id: panel.providerId, service: panel.name }),
        Date.now(),
      )
      .run();
    log.info('support.trial_ordered', { ref: claimed.publicId, panel: panel.providerId });
    return { result: 'on_the_way', service: panel.name, ref: claimed.publicId };
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
                ORDER BY id DESC
                LIMIT ?2`,
            )
            .bind(user.id, OWN_SERVICES_MAX)
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

  // Every read at once, and one budget for the whole answer: the support bot
  // is waiting with a customer on the line. A read still running at the
  // budget is left to finish on its own timeout and fill the cache for the
  // next question (final review, 2026-09-26: a few dead panels held this
  // request for 10–50 seconds).
  const rows = [
    ...own.map((r) => ({ group: 'own' as const, ...r })),
    ...samples.map((r) => ({ group: 'catalog' as const, ...r })),
  ];
  const got: ({ service: string } & SubscriptionNames)[] = [];
  const done = new Set<number>();
  const reads = rows.map((r, i) =>
    readSubscriptionNames(r.url, fetchImpl ? { fetchImpl } : {}).then((names) => {
      if (names !== null) got[i] = { service: r.service ?? '', ...names };
      done.add(i);
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.all(reads),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, c.env.SUPPORT_SERVERS_BUDGET_MS ?? SERVERS_BUDGET_MS);
    }),
  ]);
  clearTimeout(timer);
  const pick = (group: 'own' | 'catalog') =>
    rows.flatMap((r, i) => (r.group === group && done.has(i) && got[i] ? [got[i]!] : []));

  return c.json({ ok: true, own: pick('own'), catalog: pick('catalog') });
});
