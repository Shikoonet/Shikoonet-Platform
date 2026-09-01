/**
 * What an import report is allowed to keep, and to show.
 *
 * `result.samples` is not terminal output. `apps/dashboard-worker/src/importRoutes.ts`
 * writes it into `import_runs.samples` as JSON, where it stays, and the admin
 * panel renders it. So the projection in `SAMPLE_TABLE` is the boundary between
 * an import report and the data `CLAUDE.md` puts first on the list that never
 * leaves this machine.
 *
 * Until 2026-09-01 every sample was `SELECT *`. That copied customers' phone
 * numbers and Telegram ids out of `users`, panel usernames out of
 * `subscriptions`, the bot token's row out of `settings`, and — worst — full
 * card numbers out of `card_leases` and `payments`. CodeRabbit found the
 * `users` case on PR #42; reading the schemas found six more.
 *
 * This test is the guard on that boundary. It does not check that the samples
 * are useful — a human reads those. It checks that adding a column back is a
 * decision somebody has to make on purpose, in front of a red test.
 */

import { describe, expect, it } from 'vitest';
import { SAMPLE_TABLE } from '../src/migrate.js';

/**
 * Column names that may never appear in a sample projection.
 *
 * Taken from the schemas of the eleven tables `SAMPLE_TABLE` reads, not
 * invented: each one is a real column holding a customer's identity, a card, a
 * credential, or a blob that can contain any of the three.
 */
const NEVER_SAMPLED = [
  // who the customer is
  'phone',
  'username',
  'telegram_id',
  'legacy_telegram_id',
  'telegram_user_id',
  'holder_name',
  // their money instruments
  'card_number',
  'card_digits',
  'card_name',
  'assigned_card_number',
  'assigned_card_name',
  // credentials and secrets
  'remote_username',
  'remote_ref',
  'secret_ref',
  'base_url',
  'value',
  'legacy_step_token',
  'idempotency_key',
  // free-form blobs, which have held all of the above
  'legacy_attrs',
  'config',
  'attrs',
  'note',
  'reject_reason',
  'blocked_reason',
  'referral_code',
];

/** The projection, as a list of bare column names. */
const columnsOf = (spec: { columns: string }) => spec.columns.split(',').map((c) => c.trim());

describe('an import sample cannot carry a customer', () => {
  it.each(Object.entries(SAMPLE_TABLE))('%s projects no sensitive column', (_step, spec) => {
    const offending = columnsOf(spec).filter((c) => NEVER_SAMPLED.includes(c));
    expect(offending, `${spec.table} would store and display ${offending.join(', ')}`).toEqual([]);
  });

  it('never selects everything', () => {
    // `SELECT *` is how this went wrong the first time, and a new table added
    // to the map is the moment it would go wrong again.
    for (const [step, spec] of Object.entries(SAMPLE_TABLE)) {
      expect(spec.columns.includes('*'), `${step} uses a star`).toBe(false);
      expect(spec.columns.trim().length, `${step} has no projection`).toBeGreaterThan(0);
    }
  });

  it('asks for something from every table it names', () => {
    // A projection that is only `id` proves nothing landed correctly, which is
    // the whole reason samples exist.
    for (const [step, spec] of Object.entries(SAMPLE_TABLE)) {
      expect(columnsOf(spec).length, `${step} samples too little to be useful`).toBeGreaterThan(2);
    }
  });
});
