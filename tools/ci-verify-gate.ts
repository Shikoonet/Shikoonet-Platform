/**
 * The half of `Required Quality Gate` that a job result cannot tell you.
 *
 * `needs.<job>.result` says whether a job went green. It does not say whether
 * the job ran the tests it was supposed to run — and once the suite is split
 * across a matrix, that gap is the whole risk. A shard whose filter matched
 * nothing exits 0. A matrix trimmed from two entries to one leaves the
 * aggregator with nothing to notice. A `describe.skip` around a payment suite
 * is a green run with a smaller number in it.
 *
 * So the aggregator downloads what every shard produced and checks it against
 * `.github/ci-baseline.json`:
 *
 *   - every expected suite reported, and its report parses;
 *   - no suite's discovered test count went DOWN;
 *   - no suite's skipped count went UP;
 *   - every coverage-gated package produced a summary that still clears the
 *     floor in `vitest.coverage.ts`;
 *   - the Playwright report exists, has no unexpected result, and carries at
 *     least the scenario count the baseline records;
 *   - the migration and invariant counts the schema job measured are the ones
 *     the baseline expects.
 *
 * The baseline numbers are FLOORS, in the same sense as the coverage file: a
 * branch that adds tests raises the real number and passes, a branch that
 * removes them fails and has to say why in the diff that lowers the file.
 *
 * Every failure is collected before exiting, so a broken run takes one round
 * trip to diagnose rather than five.
 */

import { readFileSync, existsSync, readdirSync, statSync, appendFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { COVERAGE_FLOORS } from '../vitest.coverage.js';

interface BaselineSuite {
  name: string;
  shard: string;
  total: number;
  skipped: number;
}

interface Baseline {
  suites: Record<string, BaselineSuite>;
  coverage: string[];
  playwright: { scenarios: number };
  schema: { migrations: number; invariants: number };
}

/** Where the aggregator's `download-artifact` step put every shard's upload. */
const ROOT = process.argv[2] ?? 'ci-reports';

const baseline: Baseline = JSON.parse(
  readFileSync(new URL('../.github/ci-baseline.json', import.meta.url), 'utf8'),
) as Baseline;

const failures: string[] = [];
const summary: string[] = [];

const fail = (message: string): void => {
  failures.push(message);
  console.error(`::error::${message}`);
};

/** Every file called `name` anywhere under `dir`. */
function findAll(dir: string, name: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...findAll(path, name));
    else if (entry === name) out.push(path);
  }
  return out;
}

function readJson(path: string): unknown {
  const raw = readFileSync(path, 'utf8');
  if (raw.trim() === '') throw new Error('file is empty');
  return JSON.parse(raw);
}

/**
 * Which workspace package a downloaded report belongs to.
 *
 * The artifact preserves the path the file had in the workspace, under one
 * directory per artifact — so `ci-reports/reports-db-hub/apps/bot/vitest-report.json`
 * is `apps/bot`. Matching on the baseline's own keys rather than parsing
 * positionally means a change to the artifact layout shows up as "suite not
 * reported" rather than as a silently mismatched number.
 */
function suiteOf(path: string): string | null {
  const normalised = relative(ROOT, path).split(sep).join('/');
  for (const dir of Object.keys(baseline.suites)) {
    if (normalised.endsWith(`${dir}/vitest-report.json`)) return dir;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 1. Vitest reports — one per expected suite, none of them shrinking.
// ---------------------------------------------------------------------------
const seen = new Map<string, { total: number; skipped: number; passed: number; failed: number }>();

for (const path of findAll(ROOT, 'vitest-report.json')) {
  const dir = suiteOf(path);
  if (dir === null) {
    fail(`${path} does not belong to any suite named in the baseline`);
    continue;
  }
  let report: Record<string, number>;
  try {
    report = readJson(path) as Record<string, number>;
  } catch (error) {
    fail(`${dir}: report is malformed — ${(error as Error).message}`);
    continue;
  }
  const total = report.numTotalTests ?? -1;
  if (total < 0) {
    fail(`${dir}: report carries no numTotalTests — it is not a vitest json report`);
    continue;
  }
  if (seen.has(dir)) {
    fail(`${dir}: reported twice — two shards ran the same suite`);
    continue;
  }
  seen.set(dir, {
    total,
    skipped: (report.numPendingTests ?? 0) + (report.numTodoTests ?? 0),
    passed: report.numPassedTests ?? 0,
    failed: report.numFailedTests ?? 0,
  });
}

let discovered = 0;
let skippedTotal = 0;

summary.push('| Suite | Shard | Tests | Baseline | Skipped | Baseline |');
summary.push('| --- | --- | --- | --- | --- | --- |');

for (const [dir, want] of Object.entries(baseline.suites)) {
  const got = seen.get(dir);
  if (got === undefined) {
    fail(`${want.name} (${dir}) produced no test report — shard \`${want.shard}\` did not run it`);
    summary.push(`| ${want.name} | ${want.shard} | **MISSING** | ${want.total} | — | ${want.skipped} |`);
    continue;
  }
  discovered += got.total;
  skippedTotal += got.skipped;
  summary.push(
    `| ${want.name} | ${want.shard} | ${got.total} | ${want.total} | ${got.skipped} | ${want.skipped} |`,
  );
  if (got.failed > 0) fail(`${want.name}: ${got.failed} test(s) failed`);
  if (got.total < want.total) {
    fail(
      `${want.name}: discovered ${got.total} tests, baseline is ${want.total} — ` +
        'tests disappeared. Lower the baseline in the same commit that removes them, with a reason.',
    );
  }
  if (got.skipped > want.skipped) {
    fail(
      `${want.name}: ${got.skipped} skipped, baseline allows ${want.skipped} — ` +
        'a test became a skip.',
    );
  }
}

// ---------------------------------------------------------------------------
// 2. Coverage — every gated package produced a summary, and it still clears.
// ---------------------------------------------------------------------------
summary.push('');
summary.push('| Coverage | Statements | Branches | Functions |');
summary.push('| --- | --- | --- | --- |');

for (const dir of baseline.coverage) {
  const name = baseline.suites[dir]?.name ?? dir;
  const floor = COVERAGE_FLOORS[name];
  if (floor === undefined) {
    fail(`${name}: named as coverage-gated in the baseline but has no floor in vitest.coverage.ts`);
    continue;
  }
  const found = findAll(ROOT, 'coverage-summary.json').filter((p) =>
    relative(ROOT, p).split(sep).join('/').includes(`${dir}/coverage/`),
  );
  if (found.length === 0) {
    fail(`${name}: no coverage summary was uploaded — the coverage floor was not enforced`);
    summary.push(`| ${name} | **MISSING** | | |`);
    continue;
  }
  if (found.length > 1) {
    // Two shards measuring one package would mean two different numbers and an
    // arbitrary choice between them. Exactly one shard owns each gated package.
    fail(`${name}: ${found.length} coverage summaries uploaded — two shards measured it`);
    continue;
  }
  let pct: Record<string, { pct: number }>;
  try {
    pct = (readJson(found[0]!) as { total: Record<string, { pct: number }> }).total;
    if (typeof pct?.statements?.pct !== 'number') throw new Error('no total.statements.pct');
  } catch (error) {
    fail(`${name}: coverage summary is malformed — ${(error as Error).message}`);
    continue;
  }
  const cells: string[] = [];
  for (const metric of ['statements', 'branches', 'functions'] as const) {
    const value = pct[metric]?.pct ?? -1;
    const want = floor[metric];
    cells.push(want === null ? `${value.toFixed(2)} (ungated)` : `${value.toFixed(2)} / ${want}`);
    if (want !== null && value < want) {
      fail(`${name}: ${metric} coverage ${value.toFixed(2)}% is under the ${want}% floor`);
    }
  }
  summary.push(`| ${name} | ${cells.join(' | ')} |`);
}

// ---------------------------------------------------------------------------
// 3. Playwright — the browser walk is complete, not merely green.
// ---------------------------------------------------------------------------
const pw = findAll(ROOT, 'playwright-report.json');
if (pw.length === 0) {
  fail('no Playwright report was uploaded — the browser walk cannot be shown to have run');
} else {
  let scenarios = 0;
  let unexpected = 0;
  let pwSkipped = 0;
  let broken = false;
  for (const path of pw) {
    try {
      const stats = (readJson(path) as { stats: Record<string, number> }).stats;
      if (typeof stats?.expected !== 'number') throw new Error('no stats.expected');
      scenarios += stats.expected + (stats.unexpected ?? 0) + (stats.flaky ?? 0) + (stats.skipped ?? 0);
      unexpected += stats.unexpected ?? 0;
      pwSkipped += stats.skipped ?? 0;
    } catch (error) {
      fail(`${path}: Playwright report is malformed — ${(error as Error).message}`);
      broken = true;
    }
  }
  if (!broken) {
    summary.push('');
    summary.push(
      `Playwright: **${scenarios}** scenarios across ${pw.length} shard(s), ` +
        `baseline ${baseline.playwright.scenarios}, ${pwSkipped} skipped, ${unexpected} unexpected.`,
    );
    if (unexpected > 0) fail(`Playwright: ${unexpected} scenario(s) did not pass`);
    if (scenarios < baseline.playwright.scenarios) {
      fail(
        `Playwright: ran ${scenarios} scenarios, baseline is ${baseline.playwright.scenarios} — ` +
          'a shard is missing or scenarios were removed.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Schema — the counts the migration job measured against an empty database.
// ---------------------------------------------------------------------------
const schemaFound = findAll(ROOT, 'schema-counts.json');
if (schemaFound.length === 0) {
  fail('the migration job published no migration/invariant counts');
} else {
  try {
    const got = readJson(schemaFound[0]!) as { migrations: number; invariants: number };
    if (typeof got?.migrations !== 'number' || typeof got?.invariants !== 'number') {
      throw new Error('migrations/invariants are not both numbers');
    }
    summary.push('');
    summary.push(
      `Schema: **${got.migrations}** migrations applied (baseline ${baseline.schema.migrations}), ` +
        `**${got.invariants}** invariants proved (baseline ${baseline.schema.invariants}).`,
    );
    if (got.migrations < baseline.schema.migrations) {
      fail(`only ${got.migrations} migrations applied, baseline is ${baseline.schema.migrations}`);
    }
    if (got.invariants < baseline.schema.invariants) {
      fail(`only ${got.invariants} invariants proved, baseline is ${baseline.schema.invariants}`);
    }
  } catch (error) {
    fail(`schema counts are malformed — ${(error as Error).message}`);
  }
}

// ---------------------------------------------------------------------------
summary.push('');
summary.push(
  `**${discovered}** tests discovered, **${skippedTotal}** skipped, across ` +
    `${seen.size}/${Object.keys(baseline.suites).length} suites.`,
);

console.log(summary.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY !== undefined) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${summary.join('\n')}\n`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} integrity failure(s).`);
  process.exit(1);
}
console.log('\ntest integrity: intact');
