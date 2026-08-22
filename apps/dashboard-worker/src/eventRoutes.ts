/**
 * رویدادها — what the three services noticed, readable without an SSH key.
 *
 * `app_events` (migration 0030) has existed since 2026-08-22 and the only way
 * to read it was `psql` on the box. That is a log nobody looks at, which is the
 * same place the platform started: an admin who sees «سفارش تحویل نشد» has to
 * ask a developer what happened, and by the time they do the container has been
 * replaced.
 *
 * ## Why this reads and never writes
 *
 * There is no delete, no acknowledge, no severity edit. Rows leave by the
 * thirty-day prune in `poll.ts` and by nothing else — an operator who could
 * clear an event could clear the record of the thing that cost a customer
 * money, and «مشکل حل شد» is a sentence about the fault, not about the log.
 *
 * ## ADMIN only, and refused twice
 *
 * A stack trace names internals, and a `ref` names an order. The rule is the
 * shop's owner reads this, not a payment reviewer — so the path is on
 * `PERSONAL_DATA_PREFIXES` (which stops READ_ONLY in the middleware) and every
 * handler here checks ADMIN again. Two checks because they answer different
 * questions: one keeps the section out of a reader's sidebar, the other is what
 * a REVIEWER's `curl` meets.
 */

import type { Hono } from 'hono';
import type { D1Database } from '@shikoo/database';
import type { Ident } from './adminAudit.js';

/** One row as Postgres holds it. */
interface EventRow {
  id: number;
  at: string;
  level: string;
  svc: string;
  evt: string;
  trace: string | null;
  ref: string | null;
  fields: unknown;
  err: string | null;
}

const PAGE_SIZE_MAX = 100;

/**
 * How far back «۲۴ ساعت» and friends look.
 *
 * Named windows rather than a free number, because the question an operator has
 * is «امروز» or «این هفته» and a text box asking for hours invites `24h`, which
 * parses as NaN. `all` is here because thirty days is the whole table anyway.
 */
const WINDOWS: Record<string, number | null> = {
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
  all: null,
};

/**
 * The window's hours, or `null` for «همه».
 *
 * `WINDOWS[name] ?? WINDOWS['7d']` is what this replaced, and it was wrong in
 * the one case that matters: `all` IS `null`, so `??` treated «show me
 * everything» as «name not found» and quietly clamped it back to seven days.
 * The distinction is between a key that is absent and a key whose value is no
 * limit, and only `hasOwn` can see it.
 */
function windowHours(name: string): number | null {
  const hours = Object.hasOwn(WINDOWS, name) ? WINDOWS[name] : WINDOWS['7d'];
  return hours ?? null;
}

function positiveInt(raw: string | undefined, fallback: number, max: number): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return fallback;
  return Math.min(n, max);
}

export function registerEventRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  app.get('/api/v1/admin/events', async (c) => {
    if (c.get('identity').role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const q = (c.req.query('q') ?? '').trim();
    const level = c.req.query('level') ?? '';
    const svc = c.req.query('svc') ?? '';
    const trace = (c.req.query('trace') ?? '').trim();
    const window = c.req.query('window') ?? '7d';
    const page = positiveInt(c.req.query('page'), 1, 10_000);
    const pageSize = positiveInt(c.req.query('pageSize'), 25, PAGE_SIZE_MAX);

    const where: string[] = [];
    const params: unknown[] = [];

    // A named window, and an unknown name falls back to the default rather than
    // to «everything» — a typo in a query string should not quietly widen what
    // is being read.
    const hours = windowHours(window);
    if (hours !== null) {
      params.push(hours);
      where.push(`at > now() - make_interval(hours => ?${params.length})`);
    }
    if (level === 'info' || level === 'warn' || level === 'error') {
      params.push(level);
      where.push(`level = ?${params.length}`);
    }
    if (svc !== '') {
      params.push(svc);
      where.push(`svc = ?${params.length}`);
    }
    // Exact, not a search: a trace is copied from another row, and a LIKE on it
    // would fold `u42` into `u421`.
    if (trace !== '') {
      params.push(trace);
      where.push(`trace = ?${params.length}`);
    }
    if (q !== '') {
      params.push(`%${q}%`);
      const n = params.length;
      // `fields::text` and `err` are in the search on purpose: what an operator
      // has in front of them is an order id or a sentence from a stack, not an
      // event name they have never seen.
      where.push(
        `(evt ILIKE ?${n} OR ref ILIKE ?${n} OR trace ILIKE ?${n} OR err ILIKE ?${n} OR fields::text ILIKE ?${n})`,
      );
    }

    const filter = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const totals = await c.env.DB.prepare(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE level = 'error')::int AS errors,
              count(*) FILTER (WHERE level = 'warn')::int  AS warns
         FROM app_events ${filter}`,
    )
      .bind(...params)
      .first<{ total: number; errors: number; warns: number }>();

    const rows = await c.env.DB.prepare(
      // `at DESC, id DESC`, and the second half is not decoration: two events in
      // the same millisecond are ordinary inside one sweep, and `id` is the only
      // total order the table has.
      //
      // `id DESC` alone was what this said until it was looked at in a browser.
      // Insertion order and event order are the same thing while every row comes
      // from a live process — and they come apart the moment anything is
      // backfilled, which is exactly when someone is reading this screen. The
      // rows appeared shuffled against their own timestamps.
      `SELECT id, at, level, svc, evt, trace, ref, fields, err
         FROM app_events ${filter}
        ORDER BY at DESC, id DESC
        LIMIT ?${params.length + 1} OFFSET ?${params.length + 2}`,
    )
      .bind(...params, pageSize, (page - 1) * pageSize)
      .all<EventRow>();

    return c.json({
      ok: true,
      total: totals?.total ?? 0,
      errors: totals?.errors ?? 0,
      warns: totals?.warns ?? 0,
      page,
      pageSize,
      items: (rows.results ?? []).map((r) => ({
        id: r.id,
        at: r.at,
        level: r.level,
        svc: r.svc,
        evt: r.evt,
        trace: r.trace,
        ref: r.ref,
        fields: r.fields ?? {},
        // Raw, not reshaped. The whole point of the copy button is that what an
        // admin sends is what the process wrote.
        err: r.err,
      })),
    });
  });

  /**
   * The distinct values in the current window, for the filter dropdowns.
   *
   * Read from the data rather than hard-coded: the event names are declared
   * across three services and a list written here would be out of date the
   * first time somebody adds one.
   */
  app.get('/api/v1/admin/events/facets', async (c) => {
    if (c.get('identity').role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const hours = windowHours(c.req.query('window') ?? '7d');
    const filter = hours === null ? '' : `WHERE at > now() - make_interval(hours => ?1)`;
    const params = hours === null ? [] : [hours];

    const rows = await c.env.DB.prepare(
      `SELECT svc, evt, count(*)::int AS n FROM app_events ${filter} GROUP BY svc, evt ORDER BY n DESC`,
    )
      .bind(...params)
      .all<{ svc: string; evt: string; n: number }>();

    const services = [...new Set((rows.results ?? []).map((r) => r.svc))].sort();
    return c.json({
      ok: true,
      services,
      events: (rows.results ?? []).map((r) => ({ evt: r.evt, svc: r.svc, count: r.n })),
    });
  });
}
