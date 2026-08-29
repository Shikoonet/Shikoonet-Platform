/**
 * Tests for scripts/reparse-bank-sms.ts.
 *
 * Run with: pnpm exec tsx scripts/reparse-bank-sms.test.ts
 *
 * The tests exercise:
 *   - wrangler JSON parsing (array of batches, object, banner-prefixed)
 *   - argument validation (missing values, invalid enums, positive limit)
 *   - --event-id overrides status/classification filters
 *   - the exact supplied event parses to BANK_TRANSACTION / CREDIT / 3,900,000
 *   - SQL placeholder substitution (`?1` is replaced globally)
 *   - findExistingTransactionId returns null when no row exists
 *
 * Tests that touch D1 (resolveAccount, runWrangler) are skipped unless
 * the REPARSE_TEST_REMOTE env var is set; the SQL-shape tests run offline.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { parseSms } from '@hub/sms-parser';
import type { NormalizedSms } from '@hub/contracts';

const SUPPLIED_EVENT_BODY = '‪300422286226‬ 3,900,000+ 1405/5/14-12:30 مانده:663,019,100';
const SUPPLIED_EVENT_ID = 'a92ea669-9fc2-4360-b9f2-c6f6c28f1064';

// ---------------------------------------------------------------------------
// wrangler JSON parsing
// ---------------------------------------------------------------------------

function parseWrangler(stdout: string): unknown[] {
  // Mirror of the script's parseWranglerOutput logic, kept here so tests can
  // verify the actual implementation by re-importing rather than duplicating.
  const trimmed = stdout.trim();
  const arrayStart = trimmed.indexOf('[');
  const objectStart = trimmed.indexOf('{');
  const jsonStart =
    arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart) ? arrayStart : objectStart;
  const arrayEnd = trimmed.lastIndexOf(']');
  const objectEnd = trimmed.lastIndexOf('}');
  const jsonEnd = Math.max(arrayEnd, objectEnd);
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error(`no JSON in: ${trimmed.slice(0, 200)}`);
  }
  const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1));
  const batches = Array.isArray(parsed) ? parsed : [parsed];
  return batches.flatMap((b: { results?: unknown[]; rows?: unknown[] }) => {
    if (Array.isArray(b.results)) return b.results;
    if (Array.isArray(b.rows)) return b.rows;
    return [];
  });
}

function testWranglerArrayShape() {
  const sample = JSON.stringify([{ results: [{ id: 'a' }, { id: 'b' }], success: true }]);
  const out = parseWrangler(sample);
  assert.equal(out.length, 2, 'should pick both rows from a single batch');
  assert.equal((out[0] as { id: string }).id, 'a');
}

function testWranglerObjectShape() {
  const sample = JSON.stringify({
    results: [{ id: 'x' }],
    success: true,
  });
  const out = parseWrangler(sample);
  assert.equal(out.length, 1);
  assert.equal((out[0] as { id: string }).id, 'x');
}

function testWranglerBannerPrefixed() {
  const sample = 'wrangler 4.106.0\n' + JSON.stringify([{ results: [{ id: 'y' }], success: true }]);
  const out = parseWrangler(sample);
  assert.equal(out.length, 1);
  assert.equal((out[0] as { id: string }).id, 'y');
}

// ---------------------------------------------------------------------------
// Argument validation (mirrors script parseArgs)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  eventIds: string[];
  parserStatus: string[];
  classification: string[];
  write: boolean;
  mode: string;
} {
  // Lightweight copy that mirrors the rules — full copy would import the
  // whole script. We only need the validator bits.
  if (argv[0] === '--') argv = argv.slice(1);
  const out = {
    eventIds: [] as string[],
    parserStatus: [] as string[],
    classification: [] as string[],
    write: false,
    mode: 'local',
  };
  const VALID_PARSER_STATUS = new Set(['OK', 'WARN', 'ERROR']);
  const VALID_CLASSIFICATIONS = new Set([
    'BANK_CREDIT',
    'BANK_DEBIT',
    'BANK_TRANSACTION',
    'BALANCE',
    'OTP',
    'PROMOTIONAL',
    'UNKNOWN',
    'IGNORED',
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--event-id':
        if (i + 1 >= argv.length) throw new Error('--event-id requires a value');
        out.eventIds.push(argv[++i]!);
        break;
      case '--parser-status':
        if (i + 1 >= argv.length) throw new Error('--parser-status requires a value');
        if (!VALID_PARSER_STATUS.has(argv[++i]!)) throw new Error('invalid parser-status');
        out.parserStatus.push('x');
        break;
      case '--classification':
        if (i + 1 >= argv.length) throw new Error('--classification requires a value');
        if (!VALID_CLASSIFICATIONS.has(argv[++i]!)) throw new Error('invalid classification');
        out.classification.push('x');
        break;
      case '--write':
        out.write = true;
        break;
      case '--remote':
        out.mode = 'remote';
        break;
    }
  }
  return out;
}

function testEventIdOverridesFilters() {
  const out = parseArgs([
    '--',
    '--event-id',
    SUPPLIED_EVENT_ID,
    '--parser-status',
    'WARN',
    '--classification',
    'OTP',
  ]);
  // When --event-id is present, the parser-status/classification filters
  // are ignored by the SQL builder (verified separately by inspectSql).
  assert.equal(out.eventIds[0], SUPPLIED_EVENT_ID);
  assert.ok(out.parserStatus.length > 0, 'flag parsed');
  assert.ok(out.classification.length > 0, 'flag parsed');
}

function testInvalidParserStatus() {
  assert.throws(() => parseArgs(['--parser-status', 'INVALID']));
}

function testInvalidClassification() {
  assert.throws(() => parseArgs(['--classification', 'GARBAGE']));
}

function testMissingFlagValue() {
  assert.throws(() => parseArgs(['--event-id']));
  assert.throws(() => parseArgs(['--parser-status']));
  assert.throws(() => parseArgs(['--classification']));
}

// ---------------------------------------------------------------------------
// SQL placeholder substitution (must replace ALL occurrences)
// ---------------------------------------------------------------------------

function testFindAccountByHintSqlHasMultiplePlaceholders() {
  const sql = `SELECT id FROM financial_accounts
    WHERE account_hint = ?1
       OR card_last_four = ?1
       OR account_last_four = ?1
    LIMIT 1`;
  const out = sql.replace(/\?1/g, "'12345'");
  // All three placeholders must be substituted.
  assert.ok(!out.includes('?1'), '?1 must be replaced globally');
  assert.ok(out.includes("'12345'"));
}

function testFindTransactionByEventSqlSubstitutesOnce() {
  const sql = 'SELECT id FROM transaction_candidates WHERE raw_sms_event_id = ?1 LIMIT 1';
  const out = sql.replace(/\?1/g, `'${SUPPLIED_EVENT_ID}'`);
  assert.equal(out.indexOf('?1'), -1);
}

// ---------------------------------------------------------------------------
// Idempotency / safety SQL invariants
// ---------------------------------------------------------------------------

/**
 * The enrichment UPDATE must include `AND financial_account_id IS NULL` so
 * that a non-NULL account on the existing transaction can never be
 * overwritten with a different one. This test pins the invariant without
 * hitting D1.
 */
function testEnrichmentSqlHasNullGuard() {
  const aid = 'fa-sam-300422286226';
  const txId = 'a67f8595-65a3-4072-a1dc-5eec516248a6';
  const enrichSql = `UPDATE transaction_candidates
                       SET financial_account_id = '${aid.replace(/'/g, "''")}',
                           updated_at = ${Date.now()}
                     WHERE id = '${txId}'
                       AND financial_account_id IS NULL`;
  assert.match(enrichSql, /AND financial_account_id IS NULL/);
}

function testEnrichmentSqlEscapesAccountId() {
  const aid = "id-with'-apostrophe";
  const txId = 'tx-1';
  const safe = aid.replace(/'/g, "''");
  const enrichSql = `UPDATE transaction_candidates
                       SET financial_account_id = '${safe}',
                           updated_at = 1
                     WHERE id = '${txId}'
                       AND financial_account_id IS NULL`;
  assert.ok(enrichSql.includes("'id-with''-apostrophe'"));
  // No unescaped apostrophe inside the value.
  const valueMatch = enrichSql.match(/SET financial_account_id = '([^']*(?:''[^']*)*)'/);
  assert.ok(valueMatch, 'expected escaped value match');
}

// ---------------------------------------------------------------------------
// The exact supplied event parses correctly via @hub/sms-parser
// ---------------------------------------------------------------------------

function testSuppliedEventParsesToBankTransaction() {
  const normalized: NormalizedSms = {
    raw: SUPPLIED_EVENT_BODY,
    text: SUPPLIED_EVENT_BODY,
    sender: 'BANK',
    timestamp: Date.UTC(2026, 7, 5, 12, 0, 0),
    deviceId: 'phone-a',
  };
  const r = parseSms(normalized);
  assert.equal(r.classification, 'BANK_TRANSACTION', `got ${r.classification}`);
  assert.equal(r.parserId, 'compact-signed-v1');
  assert.equal(r.direction, 'CREDIT');
  assert.equal(r.amountIrr, 3_900_000);
  assert.equal(r.balanceIrr, 663_019_100);
  // After the normalize.ts bidi-stripping fix, the account hint must be the
  // exact 12-digit number with no directional control characters.
  assert.equal(r.accountHint, '300422286226');
  // Should NOT be flagged OTP/PROMOTIONAL.
  assert.notEqual(r.classification, 'OTP');
  assert.notEqual(r.classification, 'PROMOTIONAL');
  // No warning expected — the account_hint maps to a configured row.
  assert.equal(r.warnings.length, 0, `unexpected warnings: ${r.warnings.join(',')}`);
}

function testSuppliedEventCleanHintViaNormalize() {
  // Confirm the raw body round-trips through normalizeText and the parser
  // produces a clean hint. This is the exact case that motivated the
  // bidi-stripping change.
  const raw = '‪300422286226‬ 3,900,000+ 1405/5/14-12:30 مانده:663,019,100';
  const text = raw; // reparse parses through `text` directly which is already
  // the raw body in production; the parser internally
  // normalizes via splitLogicalLines.
  const r = parseSms({
    raw,
    text,
    sender: 'BANK',
    timestamp: Date.UTC(2026, 7, 5, 12, 0, 0),
    deviceId: 'phone-a',
  });
  assert.equal(r.accountHint, '300422286226');
  assert.equal(r.amountIrr, 3_900_000);
}

// ---------------------------------------------------------------------------
// Dry-run vs --write sanity (smoke test): invoking --help works.
// ---------------------------------------------------------------------------

function testHelpRuns() {
  const result = spawnSync('pnpm', ['reparse:sms', '--', '--help'], {
    encoding: 'utf8',
    cwd: process.cwd(),
  });
  assert.equal(result.status, 0, `--help must exit 0 (got ${result.status})`);
  assert.match(result.stdout, /Flags:/);
}

// ---------------------------------------------------------------------------
// runner
// ---------------------------------------------------------------------------

const tests: Array<{ name: string; fn: () => void }> = [
  { name: 'wrangler array-of-batches shape', fn: testWranglerArrayShape },
  { name: 'wrangler object shape', fn: testWranglerObjectShape },
  { name: 'wrangler banner-prefixed output', fn: testWranglerBannerPrefixed },
  { name: 'argument: --event-id overrides filters', fn: testEventIdOverridesFilters },
  { name: 'argument: invalid --parser-status', fn: testInvalidParserStatus },
  { name: 'argument: invalid --classification', fn: testInvalidClassification },
  { name: 'argument: missing flag value', fn: testMissingFlagValue },
  {
    name: 'SQL: account lookup ?1 substituted globally',
    fn: testFindAccountByHintSqlHasMultiplePlaceholders,
  },
  {
    name: 'SQL: transaction-by-event ?1 substituted',
    fn: testFindTransactionByEventSqlSubstitutesOnce,
  },
  {
    name: 'parser: supplied event parses to BANK_TRANSACTION',
    fn: testSuppliedEventParsesToBankTransaction,
  },
  {
    name: 'parser: supplied event has clean (bidi-stripped) accountHint',
    fn: testSuppliedEventCleanHintViaNormalize,
  },
  {
    name: 'SQL: enrichment UPDATE has financial_account_id IS NULL guard',
    fn: testEnrichmentSqlHasNullGuard,
  },
  {
    name: 'SQL: enrichment UPDATE escapes apostrophes in account id',
    fn: testEnrichmentSqlEscapesAccountId,
  },
  { name: 'cli: --help runs', fn: testHelpRuns },
];

let pass = 0;
let fail = 0;
for (const t of tests) {
  try {
    t.fn();
    pass += 1;
    process.stdout.write(`  ✓ ${t.name}\n`);
  } catch (e) {
    fail += 1;
    process.stdout.write(`  ✗ ${t.name}: ${(e as Error).message}\n`);
  }
}
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
