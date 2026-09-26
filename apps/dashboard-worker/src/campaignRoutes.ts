/**
 * «کمپین‌ها» (#471) — which link brought a customer, and what they bought.
 *
 * A campaign is a slug in a deep link, `t.me/<bot>?start=c_<slug>`. The bot
 * writes `campaign_starts` when somebody arrives on one (`handle.ts`, before
 * the channel gate); this screen counts what those people bought afterwards.
 *
 * It replaces a separate tool that counted landing-page visits and button
 * presses and never knew whether anybody started the bot. Its two screens also
 * disagreed about the same campaign — the list was all-time, the panel the last
 * 24 hours — which is where «the numbers jump» came from. Here the list and the
 * detail take the same range, and the daily chart adds up to the cards above
 * it, because all three come from the same definitions below.
 *
 * ## What counts as a sale
 *
 * A completed order of a paid kind, for more than nothing, by a customer who
 * started this campaign, within 30 days after that start, and completed inside
 * the chosen range.
 *
 * - The kinds are named rather than excluded. A wallet top-up is money moving
 *   into the customer's own wallet; counting it AND the purchase later paid
 *   from that wallet counts the same toman twice. A transfer is zero by
 *   construction and a trial is free. A kind added later stays out until
 *   somebody decides it belongs.
 * - The window is by completion, like every other sales figure here, so a
 *   closed range never changes afterwards.
 * - The 30 days stop a channel post that reached a loyal customer from claiming
 *   every renewal they make for ever.
 * - A customer reached by two campaigns counts in both. The screen says so.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { EnvName } from '@shikoo/contracts';
import type { D1Database } from '@shikoo/database';
import { parseStatsDay, parseStatsRange, statsRangeBounds, tehranDayFromUtc } from '@shikoo/domain';
import { audit, type Ident } from './adminAudit.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The same cap as «آمار»: past it a bar chart is a texture, not a chart. */
const CHART_DAYS_MAX = 120;

/**
 * The join from a start to the orders it earns. `s` is `campaign_starts`, `o`
 * is `orders`; the range is applied separately, to `o.completed_at`.
 */
// ponytail: fixed 30-day window; make it a setting if Sam asks for another.
const EARNED = `o.user_id = s.user_id
  AND o.status = 'COMPLETED'
  AND o.kind IN ('NEW_PURCHASE','RENEWAL','ADD_VOLUME','ADD_TIME')
  AND o.total_irr > 0
  AND o.completed_at >= s.first_at
  AND o.completed_at < s.first_at + interval '30 days'`;

/** Both ends always bound, so every statement below has one shape: ?1 and ?2. */
function windowOf(range: string | undefined, day: string | undefined, to: string | undefined) {
  const nowMs = Date.now();
  const bounds = statsRangeBounds(
    parseStatsRange(range),
    nowMs,
    parseStatsDay(day),
    parseStatsDay(to),
  );
  // «کل» is everything up to the end of Tehran's today — nothing a campaign
  // counts can be older than the table it lives in.
  return {
    start: bounds.start ?? 0,
    end: bounds.end ?? tehranDayFromUtc(nowMs).end,
    all: bounds.start === null,
  };
}

/**
 * A path id, or null. Digits only and within 2^53: `Number()` alone takes
 * «1e3» and «0x10», and an integer too large for `bigint` reaches Postgres and
 * comes back a 500 instead of a 404.
 */
export const idOf = (raw: string): number | null =>
  /^[1-9][0-9]{0,14}$/.test(raw) ? Number(raw) : null;

interface FunnelRow {
  id: number;
  slug: string;
  name: string;
  source: string;
  note: string;
  status: 'ACTIVE' | 'ARCHIVED';
  created_at: string;
  starts: number;
  new_users: number;
  buyers: number;
  new_buyers: number;
  revenue_irr: number;
  new_revenue_irr: number;
}

const shape = (r: FunnelRow) => ({
  id: Number(r.id),
  slug: r.slug,
  name: r.name,
  source: r.source,
  note: r.note,
  status: r.status,
  createdAt: new Date(r.created_at).getTime(),
  starts: Number(r.starts),
  newUsers: Number(r.new_users),
  buyers: Number(r.buyers),
  newBuyers: Number(r.new_buyers),
  revenueIrr: Number(r.revenue_irr),
  newRevenueIrr: Number(r.new_revenue_irr),
});

/** Every campaign's funnel in the window, or one campaign's when `id` is set. */
async function funnels(
  db: D1Database,
  w: { start: number; end: number },
  id: number | null,
): Promise<FunnelRow[]> {
  const { results } = await db
    .prepare(
      `WITH st AS (
         SELECT campaign_id,
                count(*)::int                                  AS starts,
                (count(*) FILTER (WHERE is_new_user))::int     AS new_users
           FROM campaign_starts
          WHERE first_at >= to_timestamp(?1 / 1000.0) AND first_at < to_timestamp(?2 / 1000.0)
            AND (?3::bigint IS NULL OR campaign_id = ?3)
          GROUP BY campaign_id
       ), sa AS (
         SELECT s.campaign_id,
                count(DISTINCT s.user_id)::int                                   AS buyers,
                (count(DISTINCT s.user_id) FILTER (WHERE s.is_new_user))::int    AS new_buyers,
                sum(o.total_irr)::bigint                                         AS revenue_irr,
                COALESCE(sum(o.total_irr) FILTER (WHERE s.is_new_user), 0)::bigint AS new_revenue_irr
           FROM campaign_starts s
           JOIN orders o ON ${EARNED}
          WHERE o.completed_at >= to_timestamp(?1 / 1000.0) AND o.completed_at < to_timestamp(?2 / 1000.0)
            AND (?3::bigint IS NULL OR s.campaign_id = ?3)
          GROUP BY s.campaign_id
       )
       SELECT c.id, c.slug, c.name, c.source, c.note, c.status, c.created_at,
              COALESCE(st.starts, 0)              AS starts,
              COALESCE(st.new_users, 0)           AS new_users,
              COALESCE(sa.buyers, 0)              AS buyers,
              COALESCE(sa.new_buyers, 0)          AS new_buyers,
              COALESCE(sa.revenue_irr, 0)::bigint AS revenue_irr,
              COALESCE(sa.new_revenue_irr, 0)::bigint AS new_revenue_irr
         FROM campaigns c
         LEFT JOIN st ON st.campaign_id = c.id
         LEFT JOIN sa ON sa.campaign_id = c.id
        WHERE ?3::bigint IS NULL OR c.id = ?3
        ORDER BY (c.status = 'ARCHIVED'), c.created_at DESC, c.id DESC`,
    )
    .bind(w.start, w.end, id)
    .all<FunnelRow>();
  return results ?? [];
}

/**
 * One bar per Tehran day, empty days included — the shape `shopReport`'s
 * `byDay` has, for the reason it gives: three starts on three consecutive days
 * and three spread over a month are different campaigns.
 *
 * Capped at the same 120 days, and SAYS so: past the cap the bars cover the
 * window's last 120 days while the cards cover all of it, and a chart that
 * silently adds up to less than the cards above it is the disagreement this
 * screen exists to remove.
 */
async function byDay(
  db: D1Database,
  id: number,
  w: { start: number; end: number; all: boolean },
  createdMs: number,
) {
  const from = w.all ? createdMs : w.start;
  const chartStart = Math.max(from, w.end - CHART_DAYS_MAX * DAY_MS);
  const { results } = await db
    .prepare(
      `WITH days AS (
         SELECT generate_series(
           date_trunc('day', to_timestamp(?4 / 1000.0) AT TIME ZONE 'Asia/Tehran'),
           date_trunc('day', to_timestamp((?2::bigint - 1) / 1000.0) AT TIME ZONE 'Asia/Tehran'),
           interval '1 day'
         )::date AS d
       ), st AS (
         SELECT (first_at AT TIME ZONE 'Asia/Tehran')::date AS d, count(*)::int AS starts
           FROM campaign_starts
          WHERE campaign_id = ?3
            AND first_at >= to_timestamp(?1 / 1000.0) AND first_at < to_timestamp(?2 / 1000.0)
          GROUP BY 1
       ), sa AS (
         SELECT (o.completed_at AT TIME ZONE 'Asia/Tehran')::date AS d,
                sum(o.total_irr)::bigint AS revenue_irr
           FROM campaign_starts s
           JOIN orders o ON ${EARNED}
          WHERE s.campaign_id = ?3
            AND o.completed_at >= to_timestamp(?1 / 1000.0) AND o.completed_at < to_timestamp(?2 / 1000.0)
          GROUP BY 1
       )
       SELECT to_char(d, 'YYYY-MM-DD') AS day,
              COALESCE(st.starts, 0)              AS starts,
              COALESCE(sa.revenue_irr, 0)::bigint AS revenue_irr
         FROM days
         LEFT JOIN st USING (d)
         LEFT JOIN sa USING (d)
        ORDER BY d`,
    )
    .bind(w.start, w.end, id, chartStart)
    .all<{ day: string; starts: number; revenue_irr: number }>();
  return {
    capped: chartStart > from,
    days: (results ?? []).map((r) => ({
      day: r.day,
      starts: Number(r.starts),
      revenueIrr: Number(r.revenue_irr),
    })),
  };
}

/** `bot/username`, which the link on the screen is built from. Null says so. */
export async function botUsername(db: D1Database): Promise<string | null> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE scope = 'bot' AND key = 'username'`)
    .first<{ value: unknown }>();
  const handle = typeof row?.value === 'string' ? row.value.trim().replace(/^@/, '') : '';
  return handle === '' ? null : handle;
}

/**
 * The slug is what gets printed on an ad, so it is fixed at creation — there
 * is no route that changes it. `post-` belongs to channel posts (#473), which
 * make their own campaign; a hand-made slug cannot take it.
 */
const CampaignCreate = z
  .object({
    slug: z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        /^[a-z0-9][a-z0-9-]{2,61}$/,
        'شناسه ۳ تا ۶۲ کاراکتر: حروف کوچک انگلیسی، عدد و خط تیره، و با حرف یا عدد شروع شود',
      )
      .refine((s) => !s.startsWith('post-'), 'پیشوند post- مال پست‌های کانال است'),
    name: z.string().trim().min(1).max(100),
    source: z.string().trim().max(100).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .strict();

const CampaignPatch = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    source: z.string().trim().max(100).optional(),
    note: z.string().trim().max(1000).optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'چیزی برای تغییر نیست');

export function registerCampaignRoutes(
  app: Hono<{ Bindings: { DB: D1Database; ENV_NAME: EnvName }; Variables: { identity: Ident } }>,
) {
  app.get('/api/v1/admin/campaigns', async (c) => {
    const w = windowOf(c.req.query('range'), c.req.query('day'), c.req.query('to'));
    const [rows, bot] = await Promise.all([funnels(c.env.DB, w, null), botUsername(c.env.DB)]);
    return c.json({
      ok: true,
      startMs: w.all ? null : w.start,
      endMs: w.all ? null : w.end,
      botUsername: bot,
      items: rows.map(shape),
    });
  });

  app.get('/api/v1/admin/campaigns/:id', async (c) => {
    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ ok: false, error: 'invalid_id' }, 400);
    const w = windowOf(c.req.query('range'), c.req.query('day'), c.req.query('to'));
    const [row] = await funnels(c.env.DB, w, id);
    if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
    const campaign = shape(row);
    const chart = await byDay(c.env.DB, id, w, campaign.createdAt);
    return c.json({ ok: true, campaign, byDay: chart.days, chartCapped: chart.capped });
  });

  app.post('/api/v1/admin/campaigns', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = CampaignCreate.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    // The unique index answers, not a read first: two admins typing the same
    // slug at once is exactly what a look-then-insert misses. The audit row is
    // in the same transaction, so a campaign never exists without the record
    // of who made it — a failed audit insert rolls the campaign back.
    const id = await c.env.DB.withSession(async (tx) => {
      const row = await tx
        .prepare(
          `INSERT INTO campaigns (slug, name, source, note, created_by)
           VALUES (?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (slug) DO NOTHING
           RETURNING id`,
        )
        .bind(
          body.data.slug,
          body.data.name,
          body.data.source ?? '',
          body.data.note ?? '',
          ident.email,
        )
        .first<{ id: number }>();
      if (!row) return null;
      await audit(tx, ident, 'campaign.created', 'CAMPAIGN', String(row.id), null, body.data, null);
      return Number(row.id);
    });
    if (id === null) {
      return c.json(
        { ok: false, error: 'slug_taken', detail: 'این شناسه قبلاً برای کمپین دیگری استفاده شده.' },
        409,
      );
    }
    return c.json({ ok: true, id });
  });

  /**
   * Name, where it runs, a note, and archiving. Never the slug. PATCH, like
   * every other partial edit on this surface: an omitted field is kept.
   */
  app.patch('/api/v1/admin/campaigns/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = idOf(c.req.param('id'));
    if (id === null) return c.json({ ok: false, error: 'invalid_id' }, 400);
    const body = CampaignPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    // One statement, so the «before» in the audit row is the row this UPDATE
    // actually replaced — a separate read first could log a state another
    // admin had already changed. And one transaction with the audit row, so the
    // edit and its record stand or fall together.
    const before = await c.env.DB.withSession(async (tx) => {
      const old = await tx
        .prepare(
          `WITH old AS (
             SELECT id, name, source, note, status FROM campaigns WHERE id = ?1 FOR UPDATE
           )
           UPDATE campaigns c
              SET name = COALESCE(?2, c.name), source = COALESCE(?3, c.source),
                  note = COALESCE(?4, c.note), status = COALESCE(?5, c.status), updated_at = now()
             FROM old
            WHERE c.id = old.id
           RETURNING old.name, old.source, old.note, old.status`,
        )
        .bind(
          id,
          body.data.name ?? null,
          body.data.source ?? null,
          body.data.note ?? null,
          body.data.status ?? null,
        )
        .first<{ name: string; source: string; note: string; status: string }>();
      if (!old) return null;
      await audit(tx, ident, 'campaign.updated', 'CAMPAIGN', String(id), old, body.data, null);
      return old;
    });
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);
    return c.json({ ok: true });
  });
}
