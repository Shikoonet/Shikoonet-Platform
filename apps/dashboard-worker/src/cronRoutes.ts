/**
 * «کرون‌جاب‌ها» — the sweeps, and the switches that stop them.
 *
 * There is no scheduler to show. Everything the bot does automatically runs
 * inside the poll loop, every cycle, and what decides whether a customer is due
 * is a threshold rather than a cadence. So this screen is not a crontab: it is
 * the list of jobs, whether each is on, the numbers it reads, and when it last
 * actually did something.
 *
 * ## Why the values are written through the settings route's rules, not around them
 *
 * Every value here is an ordinary `settings` row, and `settingsRoutes` already
 * refuses to create one that does not exist. This route keeps that refusal —
 * a key not in the registry is rejected before any write — because the reason
 * behind it has not changed: a row the bot does not read is a switch that looks
 * like it works.
 *
 * ## «آخرین اجرا» is «last time it acted»
 *
 * The honest number. Recording every run would be a row every 25 seconds per
 * job, most of them saying «nothing was due», so `poll.ts` logs `sweep.acted`
 * only when a sweep produced something. The screen says so in its own words
 * rather than showing a run time it does not have.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import {
  CRON_JOBS,
  CRON_DRY_RUN,
  type CronJob,
  type CronJobKey,
  type EnvName,
} from '@shikoo/contracts';
import { audit, type Ident } from './adminAudit.js';

/**
 * Every `settings` row this screen may write, and how to check its value.
 *
 * Built from the registry rather than listed again, so a job added there is
 * writable here without a second edit — and, more importantly, a key NOT there
 * cannot be written through this route at all.
 */
const WRITABLE = new Map<string, { kind: 'switch' } | { kind: 'number'; min: number; max: number }>(
  [
    ...CRON_JOBS.flatMap((j) =>
      j.toggle ? ([[j.toggle.key, { kind: 'switch' as const }] as const]) : [],
    ),
    ...CRON_JOBS.flatMap((j) =>
      j.numbers.map((n) => [n.key, { kind: 'number' as const, min: n.min, max: n.max }] as const),
    ),
    [CRON_DRY_RUN.key, { kind: 'switch' as const }] as const,
  ],
);

const UpdateBody = z.object({
  key: z.string().min(1).max(64),
  value: z.union([z.boolean(), z.number()]),
});

interface SettingRow {
  key: string;
  value: unknown;
}

interface ActedRow {
  job: string;
  at: string;
  count: number;
}

/**
 * A stored value as the panel should see it.
 *
 * Mirrors the bot's own reader (`settings.ts`) rather than reimplementing it:
 * a jsonb boolean and the string `"true"` both mean on, and anything else
 * means «the row is not readable», which the screen shows as the default
 * rather than as a value the admin chose.
 */
function asSwitch(value: unknown): boolean | null {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function asNumber(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

export function registerCronRoutes(
  app: Hono<{ Bindings: { DB: D1Database; ENV_NAME: EnvName }; Variables: { identity: Ident } }>,
) {
  app.get('/api/v1/admin/cron', async (c) => {
    const { results: rows } = await c.env.DB.prepare(
      `SELECT key, value FROM settings WHERE scope = 'bot'`,
    ).all<SettingRow>();
    const stored = new Map((rows ?? []).map((r) => [r.key, r.value]));

    // One row per job, most recent first. `DISTINCT ON` rather than a
    // correlated subquery per job: eight round trips to say «nothing yet» is
    // eight round trips.
    const { results: acted } = await c.env.DB.prepare(
      `SELECT DISTINCT ON (fields->>'job')
              fields->>'job' AS job,
              at::text AS at,
              COALESCE((fields->>'count')::int, 0) AS count
         FROM app_events
        WHERE evt = 'sweep.acted'
        ORDER BY fields->>'job', at DESC`,
    ).all<ActedRow>();
    const lastActed = new Map((acted ?? []).map((r) => [r.job, r]));

    const items = CRON_JOBS.map((job: CronJob) => {
      const last = lastActed.get(job.key);
      return {
        key: job.key,
        name: job.name,
        what: job.what,
        destructive: job.destructive,
        texts: job.texts,
        toggle: job.toggle
          ? { key: job.toggle.key, on: asSwitch(stored.get(job.toggle.key)) }
          : null,
        numbers: job.numbers.map((n) => ({
          key: n.key,
          label: n.label,
          unit: n.unit,
          min: n.min,
          max: n.max,
          value: asNumber(stored.get(n.key)),
        })),
        // Null means «has not acted since the events were pruned», which is
        // thirty days. Not «has never run» — the screen must not say that.
        lastActed: last ? { at: last.at, count: last.count } : null,
      };
    });

    return c.json({
      ok: true,
      items,
      // Its own field rather than a job, because it applies to both removal
      // jobs at once and belongs above them on the screen.
      dryRun: {
        key: CRON_DRY_RUN.key,
        on: asSwitch(stored.get(CRON_DRY_RUN.key)),
      },
    });
  });

  app.post('/api/v1/admin/cron', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const parsed = UpdateBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const { key, value } = parsed.data;

    const spec = WRITABLE.get(key);
    // Not in the registry, so not a row the bot reads. Refused rather than
    // written, for the same reason `settingsRoutes` refuses to invent keys.
    if (!spec) return c.json({ ok: false, error: 'unknown_setting' }, 404);

    if (spec.kind === 'switch') {
      if (typeof value !== 'boolean') return c.json({ ok: false, error: 'expected_boolean' }, 400);
    } else {
      // Bounded HERE as well as in the bot, and the bounds come from the same
      // registry the bot's reader is checked against. A number the bot would
      // silently ignore must not be saveable: the admin would type 0, see
      // «ذخیره شد», and watch the shop keep using 30.
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return c.json({ ok: false, error: 'expected_whole_number' }, 400);
      }
      if (value < spec.min || value > spec.max) {
        return c.json({ ok: false, error: 'out_of_range', min: spec.min, max: spec.max }, 400);
      }
    }

    const before = await c.env.DB.prepare(
      `SELECT key, value FROM settings WHERE scope = 'bot' AND key = ?1`,
    )
      .bind(key)
      .first<SettingRow>();
    // The migration inserts every row in the registry. A missing one means the
    // migration has not run on this database, which is worth saying rather
    // than papering over with an INSERT that would hide it.
    if (!before) return c.json({ ok: false, error: 'setting_not_installed' }, 404);

    await c.env.DB.prepare(
      `UPDATE settings SET value = ?1::jsonb, updated_at = now(), updated_by = ?2
        WHERE scope = 'bot' AND key = ?3`,
    )
      .bind(JSON.stringify(value), ident.email, key)
      .run();

    await audit(
      c.env.DB,
      ident,
      'settings.update',
      'setting',
      `bot:${key}`,
      before.value,
      value,
      // The reason field says WHICH screen moved it. Turning a removal job on
      // is the most consequential thing this panel can do, and «somebody
      // changed a setting» is not enough to reconstruct that later.
      'cron',
    );

    return c.json({ ok: true, key, value });
  });
}

export type { CronJobKey };
