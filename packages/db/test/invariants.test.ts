/**
 * Runs `migrations/verify_invariants.sql` as part of every test run.
 *
 * The file is excellent and it was orphaned. It proves the guarantees this
 * platform chose Postgres for — one bank transaction cannot verify two claims,
 * one claim does not settle twice, a delivered notification does not release
 * its dedupe key — and the only thing that executed it was
 * `deploy/restore-drill.sh`, against a restored backup, on the server. A
 * migration that dropped `idx_match_one_confirmed_per_claim` would leave the
 * whole suite green and be caught only by a drill nobody runs weekly.
 *
 * CLAUDE.md's rule is that these guarantees live in the schema and are never
 * moved into application code. A rule with no daily check is a comment, which
 * is the lesson rule 8 was written from — so it runs here now, on every
 * `pnpm test`.
 *
 * Executing the file rather than reimplementing its assertions is the point:
 * two copies of an invariant drift, and the copy that drifts is the one nobody
 * is reading during an incident.
 *
 * Safe to run against a populated database. The whole script is one
 * transaction that ends in ROLLBACK, and its fixtures use `__inv-` ids and
 * negative `telegram_id`s precisely so they cannot collide with seeded rows.
 */

import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Runs a command with `sql` on its standard input.
 *
 * `spawn` rather than `promisify(execFile)`: that pair takes no `input`
 * option, so stdin was never written and never closed, and psql waited for a
 * statement that would not come until the test timed out at sixty seconds.
 */
function run(command: string, args: readonly string[], sql: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args]);
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c: string) => (out += c));
    child.stderr.on('data', (c: string) => (err += c));
    child.on('error', reject);
    // Both streams, joined. Every `PASS` line comes from `RAISE NOTICE`, which
    // psql writes to stderr — reading stdout alone found the closing «All
    // invariants hold.» and not one of the assertions that earned it.
    child.on('close', (code) =>
      code === 0 ? resolve(`${out}\n${err}`) : reject(new Error(`exit ${code}\n${out}\n${err}`)),
    );
    child.stdin.end(sql);
  });
}

const SQL_PATH = fileURLToPath(new URL('../../../migrations/verify_invariants.sql', import.meta.url));

/**
 * The sim's container name, which is stable in `sim/docker-compose.yml` — this
 * is a local-and-CI check against the simulation database, not something that
 * runs on the server.
 */
const CONTAINER = 'shikoo-sim-postgres-1';

/**
 * The guarantees named one by one, so that deleting one from the SQL is a red
 * test here rather than a quieter «All invariants hold.»
 *
 * These are the ones CLAUDE.md calls unbreakable and the ones a migration is
 * most likely to cost by accident. The list is a floor, not the whole file —
 * the script proves thirty-two and adding to it needs no change here.
 */
const MUST_HOLD = [
  // The four partial unique indexes the payment system rests on.
  'one transaction cannot verify a second claim',
  'CONFIRMED and AUTO_VERIFIED share one slot per transaction',
  'one claim cannot be settled twice',
  'a REJECTED match does not occupy the settled slot',
  // The wallet is a ledger and the balance is derived from it.
  'wallet balance follows its entries',
  'a replayed wallet entry is rejected by its idempotency key',
  'wallet history cannot be edited',
  'wallet history cannot be deleted',
  // Mirzabot's unexplained −5,940,000 Toman account. It must survive the
  // migration untouched, which is also why the dashboard reports what the shop
  // owes separately from what it is owed.
  'a negative legacy balance survives migration unchanged',
  'audit_logs cannot be deleted',
  // One config, one order, in both directions.
  'one order cannot take a second config from the shelf',
  'a config cannot be marked sold without naming the order that took it',
  'one order cannot be paid twice',
  // A customer is never told twice that their payment landed.
  'one event cannot owe a customer two messages',
  'a delivered message does not release its key',
] as const;

describe('the schema still keeps its promises', () => {
  it('passes every assertion in verify_invariants.sql', async () => {
    const sql = readFileSync(SQL_PATH, 'utf8');

    // The header's own instruction, verbatim: psql with ON_ERROR_STOP, so an
    // assertion that raises exits non-zero rather than printing and carrying on.
    const stdout = await run(
      'docker',
      ['exec', '-i', CONTAINER, 'psql', '-U', 'shikoo', '-d', 'shikoo', '-v', 'ON_ERROR_STOP=1', '-q'],
      sql,
    );

    // Not merely a zero exit: a file that asserted nothing would also exit
    // zero. Each guarantee is checked by name rather than by counting, because
    // counting `assert_` call sites in the source measures the regular
    // expression doing the counting — it came out 32 against 34 real passes
    // and would have been "fixed" by loosening the number rather than by
    // saying which invariants matter.
    for (const claim of MUST_HOLD) {
      expect(stdout, `verify_invariants.sql no longer proves: ${claim}`).toContain(`PASS  ${claim}`);
    }
    expect(stdout).toContain('All invariants hold.');
  }, 60_000);

  it('is still wired to the drill it was written for', () => {
    // The file's other reader. Running it here does not replace the restore
    // drill — that one proves a *restored backup* still keeps these promises,
    // which is a different claim — so this asserts the drill has not quietly
    // stopped calling it while the suite took over.
    const drill = readFileSync(
      fileURLToPath(new URL('../../../deploy/restore-drill.sh', import.meta.url)),
      'utf8',
    );
    expect(drill).toContain('verify_invariants.sql');
  });
});
