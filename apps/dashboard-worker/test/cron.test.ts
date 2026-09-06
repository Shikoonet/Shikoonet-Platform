/**
 * «کرون‌جاب‌ها», from the panel.
 *
 * Two of the switches on this screen delete a paying customer's account from a
 * panel and cannot be undone, which is what every assertion here is really
 * about: a value that reaches the bot must be one the bot will act on, and a
 * value the bot would ignore must never be saveable.
 *
 * The bot's side — that a switch actually stops its branch — is held by
 * `apps/bot/test/warn.test.ts` against the same rows. This file is only about
 * what the panel is allowed to write.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';
import { CRON_JOBS, CRON_DRY_RUN } from '@shikoo/contracts';

const ADMIN = 'admin-cron@example.com';
const REVIEWER = 'reviewer-cron@example.com';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

const post = (email: string, body: unknown) =>
  app.request(
    '/api/v1/admin/cron',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    envAs(email),
  );

async function stored(key: string): Promise<unknown> {
  const row = await baseEnv.DB.prepare(
    `SELECT value FROM settings WHERE scope = 'bot' AND key = ?1`,
  )
    .bind(key)
    .first<{ value: unknown }>();
  return row?.value ?? null;
}

/**
 * The rows migration 0057 inserts, put back before each test.
 *
 * Written here rather than relied on from the migration, because the suite
 * shares one database and a test that turns a deletion switch on must not
 * leave it on for the next file. The values are the migration's own defaults.
 */
async function resetRows(): Promise<void> {
  const defaults: [string, string][] = [
    ['cron_warn_time', 'true'],
    ['cron_warn_volume', 'true'],
    ['cron_warn_unused', 'true'],
    ['cron_remove_expired', 'false'],
    ['cron_remove_volume', 'false'],
    ['cron_remove_dry_run', 'true'],
    ['cron_nudge_never_bought', 'false'],
    ['nudge_after_days', '3'],
    ['order_ttl_hours', '24'],
    ['removedayc', '30'],
    ['cronvolumere', '17'],
    ['daywarn', '2'],
    ['volumewarn', '1'],
    ['on_hold_day', '1'],
  ];
  for (const [key, value] of defaults) {
    await baseEnv.DB.prepare(
      `INSERT INTO settings (scope, key, value) VALUES ('bot', ?1, ?2::jsonb)
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_by = NULL`,
    )
      .bind(key, value)
      .run();
  }
}

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT INTO access_users (id, email, display_name, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?2, ?3, 1, ?4, ?4)
       ON CONFLICT (id) DO UPDATE SET role = excluded.role, active = 1`,
    )
      .bind(`cron-${role}`, email, role, now)
      .run();
  }
});

beforeEach(resetRows);

describe('reading the sweeps', () => {
  it('returns every job in the registry, with what is stored against it', async () => {
    const res = await app.request('/api/v1/admin/cron', {}, envAs(REVIEWER));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { key: string; toggle: { on: boolean | null } | null; numbers: { value: number | null }[] }[];
      dryRun: { on: boolean | null };
    };

    // Against the registry rather than a number written here: a job added
    // there and forgotten in the route is a sweep an operator cannot see.
    expect(body.items.map((i) => i.key)).toEqual(CRON_JOBS.map((j) => j.key));
    expect(body.items.find((i) => i.key === 'warn_time')?.toggle?.on).toBe(true);
    expect(body.items.find((i) => i.key === 'remove_expired')?.toggle?.on).toBe(false);
    expect(body.dryRun.on).toBe(true);
    expect(body.items.find((i) => i.key === 'remove_expired')?.numbers[0]?.value).toBe(30);
  });

  it('reports an unreadable row as null rather than as a value somebody chose', async () => {
    // The distinction that matters on a deletion switch: «the row says
    // something we do not understand» must not render as «off», because an
    // operator would then believe the shop is not deleting when the bot's own
    // fallback is what decides.
    await baseEnv.DB.prepare(
      `UPDATE settings SET value = '"maybe"'::jsonb WHERE scope = 'bot' AND key = 'cron_remove_expired'`,
    ).run();

    const res = await app.request('/api/v1/admin/cron', {}, envAs(ADMIN));
    const body = (await res.json()) as { items: { key: string; toggle: { on: boolean | null } | null }[] };
    expect(body.items.find((i) => i.key === 'remove_expired')?.toggle?.on).toBeNull();
  });
});

describe('writing a switch', () => {
  it('lets an admin turn a warning off and records who did it', async () => {
    const res = await post(ADMIN, { key: 'cron_warn_volume', value: false });
    expect(res.status).toBe(200);
    expect(await stored('cron_warn_volume')).toBe(false);

    const row = await baseEnv.DB.prepare(
      `SELECT updated_by FROM settings WHERE scope = 'bot' AND key = 'cron_warn_volume'`,
    ).first<{ updated_by: string }>();
    expect(row?.updated_by).toBe(ADMIN);
  });

  it('refuses a reviewer', async () => {
    const res = await post(REVIEWER, { key: 'cron_remove_expired', value: true });
    expect(res.status).toBe(403);
    // And the switch has not moved. A 403 that wrote anyway is the failure
    // this is really checking for.
    expect(await stored('cron_remove_expired')).toBe(false);
  });

  it('writes the reason so the audit log says which screen moved it', async () => {
    expect((await post(ADMIN, { key: 'cron_remove_expired', value: true })).status).toBe(200);
    // By entity, not by «the newest row». `audit_logs.id` is a random text id,
    // so ordering by it is lexicographic and means nothing — a mistake this
    // test made first, and one that would have passed by accident on a
    // different id.
    const audit = await baseEnv.DB.prepare(
      `SELECT action, reason, after_json FROM audit_logs
        WHERE entity_id = 'bot:cron_remove_expired'
        ORDER BY created_at DESC LIMIT 1`,
    ).first<{ action: string; reason: string; after_json: string }>();
    expect(audit?.action).toBe('settings.update');
    expect(audit?.reason).toBe('cron');
    expect(audit?.after_json).toContain('true');
  });

  it('refuses a number where a switch belongs', async () => {
    const res = await post(ADMIN, { key: 'cron_remove_volume', value: 1 });
    expect(res.status).toBe(400);
    expect(await stored('cron_remove_volume')).toBe(false);
  });
});

describe('writing a number', () => {
  it('takes one inside the range', async () => {
    const res = await post(ADMIN, { key: 'removedayc', value: 45 });
    expect(res.status).toBe(200);
    expect(await stored('removedayc')).toBe(45);
  });

  it('refuses one the bot would silently ignore', async () => {
    // 900 is past `removedayc`'s max of 365, which is also the ceiling
    // `wholeCount` enforces in the bot. Saving it would leave an admin looking
    // at «۹۰۰» on the screen while the shop went on using 30 — the exact
    // failure the bounds exist to prevent, and the reason they are checked
    // here as well as there.
    const res = await post(ADMIN, { key: 'removedayc', value: 900 });
    expect(res.status).toBe(400);
    expect((await res.json()) as { error: string; max: number }).toMatchObject({
      error: 'out_of_range',
      max: 365,
    });
    expect(await stored('removedayc')).toBe(30);
  });

  it('refuses zero and negatives', async () => {
    for (const value of [0, -1]) {
      const res = await post(ADMIN, { key: 'daywarn', value });
      expect(res.status, `${value} should be refused`).toBe(400);
    }
    expect(await stored('daywarn')).toBe(2);
  });

  it('refuses a fraction', async () => {
    const res = await post(ADMIN, { key: 'daywarn', value: 2.5 });
    expect(res.status).toBe(400);
    expect(await stored('daywarn')).toBe(2);
  });

  it('lets the invoice deadline past 365, because it is hours', async () => {
    // The one number on this screen that is not a count of days. A shared
    // 365 ceiling would have made a thirty-day hold unsaveable while looking
    // like an ordinary refusal.
    const res = await post(ADMIN, { key: 'order_ttl_hours', value: 720 });
    expect(res.status).toBe(200);
    expect(await stored('order_ttl_hours')).toBe(720);
  });
});

describe('the keys this screen may not touch', () => {
  it('refuses a settings key that is not a cron job', async () => {
    // `Bot_Status` closes the shop. It is a real row and `settingsRoutes` can
    // write it; this route must not, or a screen about sweeps becomes a second
    // door onto every setting in the table.
    const res = await post(ADMIN, { key: 'Bot_Status', value: false });
    expect(res.status).toBe(404);
  });

  it('refuses a key that does not exist at all', async () => {
    const res = await post(ADMIN, { key: 'cron_invented', value: true });
    expect(res.status).toBe(404);
  });

  it('says so when the migration has not run, rather than inventing the row', async () => {
    await baseEnv.DB.prepare(
      `DELETE FROM settings WHERE scope = 'bot' AND key = ?1`,
    )
      .bind(CRON_DRY_RUN.key)
      .run();

    const res = await post(ADMIN, { key: CRON_DRY_RUN.key, value: false });
    expect(res.status).toBe(404);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: 'setting_not_installed',
    });
    // And nothing was created. An INSERT here would hide a database that is
    // behind its migrations, which is the thing worth being told about.
    expect(await stored(CRON_DRY_RUN.key)).toBeNull();
  });
});
