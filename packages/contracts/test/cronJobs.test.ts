/**
 * The registry is only worth having if it cannot lie about the sweeps.
 *
 * Three things can drift and each one is silent when it does: a job that names
 * a text key nobody wrote, two jobs claiming the same `settings` row, and a
 * bound the panel enforces that the bot has never heard of. None of them throw
 * at runtime — the panel just draws a link to nothing, or refuses a number the
 * bot would have accepted — so they are asserted here.
 */

import { describe, it, expect } from 'vitest';
import {
  CRON_JOBS,
  CRON_JOB_KEYS,
  CRON_SETTING_KEYS,
  CRON_TOGGLES,
  CRON_DRY_RUN,
  cronJob,
} from '../src/cronJobs.js';
import { TEXTS } from '../src/botTexts.js';

describe('the cron job registry', () => {
  it('names only texts that exist, on the screen an operator would look for them', () => {
    for (const job of CRON_JOBS) {
      for (const key of job.texts) {
        expect(TEXTS[key], `${job.key} names a missing text: ${key}`).toBeDefined();
        // Every one of these is a message a sweep sends unprompted, which is
        // exactly what «هشدارهای خودکار» is. A job whose text sits under
        // «خرید» would be editable from a screen nobody would think to open.
        expect(TEXTS[key].screen, `${key} is not on the warnings screen`).toBe('warnings');
      }
    }
  });

  it('gives every job a distinct key', () => {
    expect(new Set(CRON_JOB_KEYS).size).toBe(CRON_JOB_KEYS.length);
  });

  it('never points two jobs at one settings row', () => {
    const seen = CRON_SETTING_KEYS.map(([scope, key]) => `${scope}.${key}`);
    expect(new Set(seen).size, `duplicate settings rows: ${seen.join(', ')}`).toBe(seen.length);
  });

  it('lists every toggle and every number in CRON_SETTING_KEYS', () => {
    // The migration inserts exactly this list. A job whose switch is missing
    // from it gets no row, and `settingsRoutes` refuses to create one — so the
    // switch would be un-settable with nothing on any screen saying why.
    const listed = new Set(CRON_SETTING_KEYS.map(([s, k]) => `${s}.${k}`));
    for (const job of CRON_JOBS) {
      if (job.toggle) expect(listed).toContain(`${job.toggle.scope}.${job.toggle.key}`);
      for (const n of job.numbers) expect(listed).toContain(`${n.scope}.${n.key}`);
    }
    expect(listed).toContain(`${CRON_DRY_RUN.scope}.${CRON_DRY_RUN.key}`);
  });

  it('gives every number a usable range', () => {
    for (const job of CRON_JOBS) {
      for (const n of job.numbers) {
        expect(n.min, `${job.key}.${n.key} min`).toBeGreaterThan(0);
        expect(n.max, `${job.key}.${n.key} max`).toBeGreaterThan(n.min);
      }
    }
  });

  it('marks exactly the two jobs that delete a customer account', () => {
    const destructive = CRON_JOBS.filter((j) => j.destructive).map((j) => j.key);
    // Named rather than counted. If a third one is ever added this test is
    // where somebody has to say so out loud, which is the point: these are the
    // only sweeps in the project that remove something we cannot put back.
    expect(destructive).toEqual(['remove_expired', 'remove_volume']);
  });

  it('gives both destructive jobs a switch, so neither can be always-on', () => {
    for (const job of CRON_JOBS.filter((j) => j.destructive)) {
      expect(job.toggle, `${job.key} has no off switch`).not.toBeNull();
    }
    expect(CRON_TOGGLES.remove_expired.key).toBe('cron_remove_expired');
    expect(CRON_TOGGLES.remove_volume.key).toBe('cron_remove_volume');
  });

  it('refuses an unknown key rather than returning undefined', () => {
    expect(() => cronJob('no_such_job' as never)).toThrow(/unknown cron job/);
    expect(cronJob('warn_time').name).toBe('هشدار نزدیک‌شدن انقضا');
  });
});
