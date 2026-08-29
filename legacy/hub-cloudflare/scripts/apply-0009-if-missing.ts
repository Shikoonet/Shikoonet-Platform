/**
 * Idempotent applier for migration 0009_credit_only.
 *
 * Why this exists:
 *   The migration file is plain SQL. D1's wrangler apply runs every
 *   numbered .sql file in the migrations dir, in order, exactly once per
 *   database. But when running locally with `wrangler d1 execute` —
 *   which is what makes the column-add survive a re-rerun after a
 *   half-applied state — SQLite raises `duplicate column name` on the
 *   second ALTER.
 *
 * What it does:
 *   1. Probe `processing_disposition` existence via `pragma_table_info`.
 *   2. If missing, run the migration SQL via `wrangler d1 execute --file`.
 *   3. If present, no-op.
 *
 * Usage:
 *   pnpm --filter @hub/dashboard-worker exec \
 *     wrangler d1 execute payment-hub-staging --remote \
 *     --command "$(cat ../../scripts/apply-0009-if-missing.ts | head -1 skipped)"
 *
 *   The simplest path is just:
 *     wrangler d1 execute payment-hub-staging --remote \
 *       --command "SELECT name FROM pragma_table_info('transaction_candidates') WHERE name = 'processing_disposition'"
 *
 *   If the result is one row, migration 0009 already ran. If empty,
 *   apply the SQL file:
 *     wrangler d1 execute payment-hub-staging --remote --file ../../migrations/0009_credit_only.sql
 *
 * This script wraps that workflow so an operator can run a single
 * command and have it do the right thing.
 */

import { execSync } from 'node:child_process';

const DB = 'payment-hub-staging';
const migrations = new URL('../migrations/0009_credit_only.sql', import.meta.url);

function wrangler(args: string): string {
  const cmd = `pnpm -s exec wrangler d1 execute ${DB} --remote ${args}`;
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const probe = wrangler(
  `--command "SELECT name FROM pragma_table_info('transaction_candidates') WHERE name = 'processing_disposition'"`,
);

if (probe.includes('processing_disposition')) {
  console.log('[apply-0009] processing_disposition already present — nothing to do.');
  process.exit(0);
}

console.log('[apply-0009] column missing — applying 0009_credit_only.sql');
wrangler(`--file "${migrations.pathname}"`);
console.log('[apply-0009] applied. Verify with:');
console.log('          pnpm -s exec wrangler d1 execute payment-hub-staging --remote \\');
console.log("            --command \"SELECT name FROM pragma_table_info('transaction_candidates') WHERE name = 'processing_disposition'\"");
