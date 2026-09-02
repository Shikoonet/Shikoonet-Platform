/**
 * Continuity mode against a real Postgres.
 *
 * ## Why this exists next to the dashboard suite
 *
 * `apps/dashboard-worker/test/continuity.test.ts` drives this through the
 * route, and proves the screen: who may press the switch, what the dialog has
 * to have asked, what the banner says afterwards. It cannot prove the other
 * half of the contract, because that half has no route.
 *
 * `readContinuityMode` is asked by every caller that can fulfil an order —
 * the dashboard, and `apps/ingest-worker/src/integrations/mirzabot.ts` — and
 * what it does with a row *this code did not write* is the whole difference
 * between a shop that stops selling for an evening and a shop that sells
 * without evidence for ever. A hand edit, a restore from an older dump, a
 * column that lost its default: each of those is a real row that reaches this
 * function, and none of them can be produced by pressing the button.
 *
 * So the storage cases below are asserted against the `jsonb` column itself
 * rather than against a fake that returns whatever this file imagines the pg
 * driver returns. That is CLAUDE.md rule 6: the external truth here is
 * Postgres, so Postgres is what answers.
 *
 * Needs DATABASE_URL with the schema applied.
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPostgresD1 } from '@shikoo/db';
import {
  CONTINUITY_KEY,
  CONTINUITY_MAX_DURATION_MS,
  CONTINUITY_MIN_DURATION_MS,
  CONTINUITY_SCOPE,
  activateContinuityMode,
  deactivateContinuityMode,
  readContinuityMode,
} from '../../src/continuityMode.js';

const { db, pool } = createPostgresD1();

afterAll(async () => {
  await pool.end();
});

const NOW = 1_786_000_000_000;
const ACTOR = 'sam@example.com';
const REASON = 'the SMS relay phone is offline';

/**
 * Only this row.
 *
 * `settings` is `(scope, key)` for the whole shop — bot, panel and pricing all
 * live in it — so a TRUNCATE here would delete another suite's fixture to save
 * one line.
 */
async function clear(): Promise<void> {
  await db
    .prepare(`DELETE FROM settings WHERE scope = ?1 AND key = ?2`)
    .bind(CONTINUITY_SCOPE, CONTINUITY_KEY)
    .run();
}

/** A row this code did not write. `raw` is jsonb source, not a JS value. */
async function store(raw: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (scope, key, value, updated_at, updated_by)
       VALUES (?1, ?2, ?3::jsonb, now(), 'hand-edit')
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
    )
    .bind(CONTINUITY_SCOPE, CONTINUITY_KEY, raw)
    .run();
}

async function storedRow(): Promise<{ value: unknown; updated_by: string | null } | null> {
  return await db
    .prepare(`SELECT value, updated_by FROM settings WHERE scope = ?1 AND key = ?2`)
    .bind(CONTINUITY_SCOPE, CONTINUITY_KEY)
    .first<{ value: unknown; updated_by: string | null }>();
}

beforeEach(async () => {
  // Rule 5: the default-argument paths below read the real clock, so the clock
  // is pinned rather than the expectations being written around it.
  vi.spyOn(Date, 'now').mockReturnValue(NOW);
  await clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readContinuityMode: what the shop is allowed to conclude from a row', () => {
  it('no row at all is NORMAL', async () => {
    // No `now` argument either — the absent-row answer must not depend on the
    // clock, and this is the call every caller actually makes.
    expect(await readContinuityMode(db)).toEqual({
      mode: 'NORMAL',
      expiresAt: null,
      activatedAt: null,
      activatedBy: null,
      reason: null,
      expired: false,
    });
  });

  it('a live activation reads back the operator, the reason and the expiry', async () => {
    await activateContinuityMode(db, {
      actorEmail: ACTOR,
      reason: REASON,
      durationMs: CONTINUITY_MIN_DURATION_MS,
      confirmed: true,
      now: NOW,
    });

    expect(await readContinuityMode(db, NOW + 1_000)).toEqual({
      mode: 'CONTINUITY',
      expiresAt: NOW + CONTINUITY_MIN_DURATION_MS,
      activatedAt: NOW,
      activatedBy: ACTOR,
      reason: REASON,
      expired: false,
    });
  });

  it('turns itself off at the expiry, with nothing scheduled to run', async () => {
    await activateContinuityMode(db, {
      actorEmail: ACTOR,
      reason: REASON,
      durationMs: CONTINUITY_MIN_DURATION_MS,
      confirmed: true,
      now: NOW,
    });
    const expiry = NOW + CONTINUITY_MIN_DURATION_MS;

    // One millisecond before, and exactly on: the boundary is `now >= expiresAt`,
    // and an off-by-one here is a shop that sells for one more request.
    expect((await readContinuityMode(db, expiry - 1)).mode).toBe('CONTINUITY');

    const after = await readContinuityMode(db, expiry);
    expect(after.mode).toBe('NORMAL');
    // `expired` is the difference between «somebody turned it off» and «it ran
    // out», which is what the banner and the audit row each have to say.
    expect(after.expired).toBe(true);
    expect(after.expiresAt).toBe(expiry);
    expect(after.activatedBy).toBe(ACTOR);

    // And the stored row still says active — expiry is applied by the read, not
    // by a write nobody ran.
    expect((await storedRow())?.value).toMatchObject({ active: true });
  });

  it('an activation with no expiry is read as OFF, not as on for ever', async () => {
    await store(JSON.stringify({ active: true, activatedBy: ACTOR, reason: REASON }));
    expect((await readContinuityMode(db, NOW)).mode).toBe('NORMAL');
  });

  it('an expiry that is not a number is read as OFF', async () => {
    await store(JSON.stringify({ active: true, expiresAt: 'tomorrow' }));
    expect((await readContinuityMode(db, NOW)).mode).toBe('NORMAL');
  });

  it('a value that is not JSON at all is read as OFF', async () => {
    // A jsonb string, which is what the driver hands back as a JS string that
    // `JSON.parse` then refuses. Fail-closed: the failure this mode can cause
    // is selling without evidence.
    await store(JSON.stringify('active please'));
    expect((await readContinuityMode(db, NOW)).mode).toBe('NORMAL');
  });

  it('a value that is text CARRYING the json is still read', async () => {
    // The other half of the same branch: anything that stringifies on the way
    // out stores the object as a JSON string. It must still be understood.
    const inner = JSON.stringify({ active: true, expiresAt: NOW + 60_000, activatedBy: ACTOR });
    await store(JSON.stringify(inner));

    const state = await readContinuityMode(db, NOW);
    expect(state.mode).toBe('CONTINUITY');
    expect(state.expiresAt).toBe(NOW + 60_000);
    expect(state.activatedBy).toBe(ACTOR);
  });

  it('a value that is neither object nor string is read as OFF', async () => {
    await store('5');
    expect((await readContinuityMode(db, NOW)).mode).toBe('NORMAL');
  });

  it('a row that says inactive is NORMAL', async () => {
    await store(JSON.stringify({ active: false, expiresAt: NOW + 60_000 }));
    expect((await readContinuityMode(db, NOW)).mode).toBe('NORMAL');
  });

  it('an activation missing its optional fields reads them as null, not undefined', async () => {
    await store(JSON.stringify({ active: true, expiresAt: NOW + 60_000 }));
    expect(await readContinuityMode(db, NOW)).toEqual({
      mode: 'CONTINUITY',
      expiresAt: NOW + 60_000,
      activatedAt: null,
      activatedBy: null,
      reason: null,
      expired: false,
    });
  });
});

describe('activateContinuityMode: what it refuses, and what it refuses to write', () => {
  it('writes the row, and stamps who and why', async () => {
    const res = await activateContinuityMode(db, {
      actorEmail: ACTOR,
      reason: `  ${REASON}  `,
      durationMs: CONTINUITY_MAX_DURATION_MS,
      confirmed: true,
      now: NOW,
    });

    expect(res).toEqual({
      ok: true,
      state: {
        mode: 'CONTINUITY',
        expiresAt: NOW + CONTINUITY_MAX_DURATION_MS,
        activatedAt: NOW,
        activatedBy: ACTOR,
        reason: REASON,
        expired: false,
      },
    });

    const row = await storedRow();
    expect(row?.updated_by).toBe(ACTOR);
    expect(row?.value).toMatchObject({
      active: true,
      expiresAt: NOW + CONTINUITY_MAX_DURATION_MS,
      reason: REASON,
    });
  });

  it('without an explicit clock it uses the current one', async () => {
    const res = await activateContinuityMode(db, {
      actorEmail: ACTOR,
      reason: REASON,
      durationMs: CONTINUITY_MIN_DURATION_MS,
      confirmed: true,
    });
    expect(res.ok && res.state.expiresAt).toBe(NOW + CONTINUITY_MIN_DURATION_MS);
  });

  it('accepts exactly the floor and exactly the cap', async () => {
    for (const durationMs of [CONTINUITY_MIN_DURATION_MS, CONTINUITY_MAX_DURATION_MS]) {
      const res = await activateContinuityMode(db, {
        actorEmail: ACTOR,
        reason: REASON,
        durationMs,
        confirmed: true,
        now: NOW,
      });
      expect(res.ok).toBe(true);
    }
  });

  it('refuses a reason too short to be one, and writes nothing', async () => {
    for (const reason of ['', '   ', ' ab ']) {
      const res = await activateContinuityMode(db, {
        actorEmail: ACTOR,
        reason,
        durationMs: CONTINUITY_MIN_DURATION_MS,
        confirmed: true,
        now: NOW,
      });
      expect(res).toEqual({ ok: false, error: 'REASON_REQUIRED' });
    }
    expect(await storedRow()).toBeNull();
  });

  it('refuses when the screen never asked for confirmation, and writes nothing', async () => {
    const res = await activateContinuityMode(db, {
      actorEmail: ACTOR,
      reason: REASON,
      durationMs: CONTINUITY_MIN_DURATION_MS,
      confirmed: false,
      now: NOW,
    });
    expect(res).toEqual({ ok: false, error: 'NOT_CONFIRMED' });
    expect(await storedRow()).toBeNull();
  });

  it('refuses a duration outside the bounds, and writes nothing', async () => {
    for (const durationMs of [
      CONTINUITY_MIN_DURATION_MS - 1,
      CONTINUITY_MAX_DURATION_MS + 1,
      0,
      -60_000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      const res = await activateContinuityMode(db, {
        actorEmail: ACTOR,
        reason: REASON,
        durationMs,
        confirmed: true,
        now: NOW,
      });
      expect(res).toEqual({ ok: false, error: 'DURATION_OUT_OF_RANGE' });
    }
    expect(await storedRow()).toBeNull();
  });

  it('answers about the reason before it answers about the dialog', async () => {
    // Both are wrong here. Which one the operator is told about decides which
    // field the screen highlights, so the precedence is asserted rather than
    // left to whichever check is written first.
    const res = await activateContinuityMode(db, {
      actorEmail: ACTOR,
      reason: '',
      durationMs: 0,
      confirmed: false,
      now: NOW,
    });
    expect(res).toEqual({ ok: false, error: 'REASON_REQUIRED' });
  });
});

describe('deactivateContinuityMode', () => {
  it('returns the shop to normal, and off is a written decision not an absent row', async () => {
    await activateContinuityMode(db, {
      actorEmail: ACTOR,
      reason: REASON,
      durationMs: CONTINUITY_MIN_DURATION_MS,
      confirmed: true,
      now: NOW,
    });

    expect(await deactivateContinuityMode(db, { actorEmail: 'other@example.com' })).toEqual({
      mode: 'NORMAL',
      expiresAt: null,
      activatedAt: null,
      activatedBy: null,
      reason: null,
      expired: false,
    });
    expect((await readContinuityMode(db, NOW)).mode).toBe('NORMAL');

    // The row survives and names whoever turned it off — «no row» and «somebody
    // decided» are not the same fact, and only one of them has an operator.
    const row = await storedRow();
    expect(row?.updated_by).toBe('other@example.com');
    expect(row?.value).toMatchObject({ active: false });
  });

  it('is idempotent — turning off an off mode is not an error', async () => {
    await deactivateContinuityMode(db, { actorEmail: ACTOR });
    await deactivateContinuityMode(db, { actorEmail: ACTOR });
    expect((await readContinuityMode(db, NOW)).mode).toBe('NORMAL');
  });
});
