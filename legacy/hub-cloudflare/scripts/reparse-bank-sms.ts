#!/usr/bin/env -S pnpm exec tsx
/**
 * Re-run the current parser registry against every stored raw_sms_event and
 * report (or apply, with --write) the new parser_id, classification, and
 * matching transaction_candidate row.
 *
 * Usage:
 *   pnpm reparse:sms -- [--local | --remote] [--dry-run | --write]
 *                          [--event-id <uuid>]...
 *                          [--parser-status WARN|ERROR|UNKNOWN]
 *                          [--classification OTP|PROMOTIONAL|BANK_TRANSACTION|...]
 *                          [--limit N]
 *
 * Default: --local --dry-run.
 * --write actually mutates D1; --write --remote is the only way to touch
 * the production database. Dry-run never modifies D1.
 *
 * All DB access goes through `wrangler d1 execute` so we don't need a native
 * sqlite driver. The transaction-creation SQL is shared with the ingest
 * worker via `apps/ingest-worker/src/transaction-create.ts` so normal
 * ingestion and reparse produce identical rows.
 *
 * Bodies, API keys, credentials, OTP contents, and authentication headers
 * are NEVER printed.
 */
import { spawnSync } from 'node:child_process';
import { parseSms } from '@hub/sms-parser';
import type { NormalizedSms, ParseResult } from '@hub/contracts';
import {
  FIND_ACCOUNT_BY_HINT_SQL,
  FIND_TRANSACTION_BY_EVENT_SQL,
  INSERT_TRANSACTION_SQL,
  UPDATE_TRANSACTION_STATUS_SQL,
  annotateAccountWarning,
  buildEvidenceJson,
  initialStatus,
  shouldCreateTransaction,
} from '../apps/ingest-worker/src/transaction-create.ts';

type Mode = 'local' | 'remote';

interface CliArgs {
  mode: Mode;
  dryRun: boolean;
  write: boolean;
  eventIds: string[];
  parserStatus: string[];
  classification: string[];
  limit: number;
  fixture: string | null;
}

interface RawRow {
  id: string;
  device_id: string;
  sender: string;
  normalized_body: string | null;
  sms_timestamp: number;
  classification: string;
  parser_status: string;
  parser_id: string | null;
  parser_version: string | null;
}

interface Action {
  kind:
    | 'WOULD_UPDATE_EVENT'
    | 'WOULD_CREATE_TRANSACTION'
    | 'WOULD_ENRICH_TRANSACTION'
    | 'TRANSACTION_ALREADY_EXISTS'
    | 'KEPT_EXISTING_ACCOUNT'
    | 'SKIPPED_NOT_TRANSACTION'
    | 'PARSE_FAILED'
    | 'IDEMPOTENT_NO_CHANGE'
    | 'APPLIED';
  detail: string;
}

interface ReparseRow {
  id: string;
  oldParser: string;
  newParser: string;
  oldClassification: string;
  newClassification: string;
  amount: number | null;
  balance: number | null;
  direction: string;
  accountHint: string | null;
  financialAccountId: string | null;
  action: Action;
  warnings: string[];
}

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

/**
 * Six real Iranian bank SMS fixtures used for --fixture runs. The bodies are
 * the documented layouts (حساب:/مبلغ:/مانده:/date) used in the live
 * verification; this lets the reparse script be exercised without an
 * existing raw_sms_events row in D1.
 */
const FIXTURES: Record<string, string> = {
  'sample-1-account-transfer': [
    'انتقال اینترنت',
    'حساب:310057795083',
    'مبلغ:5,500,000+',
    'مانده:82,791,067',
    '05/14-11:30',
  ].join('\n'),
  'sample-2-compact': [
    '777.888.21654304.1',
    '+2,000,000',
    '05/14_17:04',
    'مانده: 134,760,000',
  ].join('\n'),
  'sample-3-compact': ['10.5718857.1', '+1,000,000', '05/14_20:30', 'مانده: 1,070,374,127'].join(
    '\n',
  ),
  'sample-4-melli': [
    'بانك ملي',
    'انتقال:+1,500,000',
    'حساب:17000',
    'مانده:78,159,809',
    '05/14-16:30',
  ].join('\n'),
  'sample-5-parsian-jalali': [
    '300432401476',
    '2,800,000+',
    'مانده:16,234,550',
    '1405/5/14-18:01',
  ].join('\n'),
  'sample-6-shahr': [
    '*بانک شهر*',
    'انتقال وجه کارتی',
    'واریز به:4003537814',
    'مبلغ:1,950,000 ریال',
    'موجودی:112,686,500 ریال',
    '1405/05/14 02:02:14',
  ].join('\n'),
};

function parseArgs(argv: string[]): CliArgs {
  // pnpm appends `--` separator before script args — drop it.
  if (argv[0] === '--') argv = argv.slice(1);
  const args: CliArgs = {
    mode: 'local',
    dryRun: true,
    write: false,
    eventIds: [],
    parserStatus: [],
    classification: [],
    limit: 500,
    fixture: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--local':
        args.mode = 'local';
        break;
      case '--remote':
        args.mode = 'remote';
        break;
      case '--dry-run':
        args.dryRun = true;
        break;
      case '--write':
        args.write = true;
        args.dryRun = false;
        break;
      case '--event-id':
        if (i + 1 >= argv.length) throw new Error('--event-id requires a value');
        args.eventIds.push(argv[++i]!);
        break;
      case '--limit':
        if (i + 1 >= argv.length) throw new Error('--limit requires a value');
        {
          const v = Number.parseInt(argv[++i]!, 10);
          if (!Number.isFinite(v) || v <= 0) throw new Error('--limit must be a positive integer');
          args.limit = v;
        }
        break;
      case '--parser-status':
        if (i + 1 >= argv.length) throw new Error('--parser-status requires a value');
        {
          const v = argv[++i]!;
          if (!VALID_PARSER_STATUS.has(v)) {
            throw new Error(
              `--parser-status must be one of ${[...VALID_PARSER_STATUS].join(', ')}`,
            );
          }
          args.parserStatus.push(v);
        }
        break;
      case '--fixture':
        if (i + 1 >= argv.length) throw new Error('--fixture requires a value');
        args.fixture = argv[++i]!;
        break;
      case '--list-fixtures':
        process.stdout.write(Object.keys(FIXTURES).join('\n') + '\n');
        process.exit(0);
      case '--classification':
        if (i + 1 >= argv.length) throw new Error('--classification requires a value');
        {
          const v = argv[++i]!;
          if (!VALID_CLASSIFICATIONS.has(v)) {
            throw new Error(
              `--classification must be one of ${[...VALID_CLASSIFICATIONS].join(', ')}`,
            );
          }
          args.classification.push(v);
        }
        break;
      case '-h':
      case '--help':
        printHelp();
        process.exit(0);
      default:
        if (a.startsWith('--')) throw new Error(`Unknown flag: ${a}`);
    }
  }
  return args;
}

function printHelp(): void {
  process.stdout.write(
    [
      'reparse-bank-sms — re-run the parser registry against stored SMS rows.',
      '',
      'Flags:',
      '  --local / --remote       Where to read/write rows (default --local).',
      '  --dry-run                Print results without writing (default).',
      '  --write                  Persist results. --write --remote writes remote D1.',
      '  --event-id <uuid>        Restrict to one or more event IDs (repeatable).',
      '                          Overrides --parser-status / --classification filters.',
      '  --parser-status <s>      Filter by current parser_status (repeatable).',
      '  --classification <c>     Filter by current classification (repeatable).',
      '  --limit N                Max rows to process (default 500).',
      '  --fixture <name>         Run the parser against an inline fixture (no D1).',
      '  --list-fixtures          Print fixture names and exit.',
      '  -h, --help               Show this help.',
      '',
      'Bodies, API keys, credentials, and OTP contents are NEVER printed.',
    ].join('\n') + '\n',
  );
}

/**
 * Build the SELECT WHERE clause. Event-IDs always match regardless of the
 * other filters; status/classification filters only narrow when no event-id
 * is supplied.
 */
function buildWhere(args: CliArgs): string {
  if (args.eventIds.length) {
    const ids = args.eventIds.map((id) => `'${escapeSql(id)}'`).join(',');
    return `WHERE id IN (${ids})`;
  }
  const parts: string[] = [];
  if (args.parserStatus.length) {
    parts.push(`parser_status IN (${args.parserStatus.map((s) => `'${escapeSql(s)}'`).join(',')})`);
  }
  if (args.classification.length) {
    parts.push(
      `classification IN (${args.classification.map((s) => `'${escapeSql(s)}'`).join(',')})`,
    );
  }
  return parts.length ? `WHERE ${parts.join(' AND ')}` : '';
}

function escapeSql(s: string): string {
  return s.replace(/'/g, "''");
}

interface WranglerBatch {
  results?: unknown[];
  rows?: unknown[];
  result?: { results?: unknown[] };
  success?: boolean;
}

function parseWranglerOutput(stdout: string): RawRow[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  // Locate the outermost JSON document. Wrangler may emit a banner line
  // before the payload (e.g. `wrangler 4.x.x`) or prefix with deprecation
  // notices. The payload is either a `[ ... ]` array or `{ ... }` object.
  const arrayStart = trimmed.indexOf('[');
  const objectStart = trimmed.indexOf('{');
  const jsonStart =
    arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart) ? arrayStart : objectStart;
  const arrayEnd = trimmed.lastIndexOf(']');
  const objectEnd = trimmed.lastIndexOf('}');
  const jsonEnd = Math.max(arrayEnd, objectEnd);
  if (jsonStart < 0 || jsonEnd < jsonStart) {
    throw new Error(`wrangler produced no JSON output: ${trimmed.slice(0, 500)}`);
  }
  const parsed = JSON.parse(trimmed.slice(jsonStart, jsonEnd + 1)) as
    | WranglerBatch[]
    | WranglerBatch;
  const batches = Array.isArray(parsed) ? parsed : [parsed];
  return batches.flatMap((b) => {
    if (Array.isArray(b.results)) return b.results as RawRow[];
    if (Array.isArray(b.rows)) return b.rows as RawRow[];
    if (b.result && Array.isArray(b.result.results)) return b.result.results as RawRow[];
    return [];
  });
}

function runWrangler(mode: Mode, sql: string): RawRow[] {
  const flag = mode === 'remote' ? '--remote' : '--local';
  const result = spawnSync(
    'pnpm',
    [
      '--filter',
      '@hub/ingest-worker',
      'exec',
      'wrangler',
      'd1',
      'execute',
      'DB',
      flag,
      '--json',
      `--command=${sql}`,
    ],
    { encoding: 'utf8', cwd: process.cwd() },
  );
  if (result.status !== 0) {
    throw new Error(
      `wrangler d1 execute failed (exit ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  return parseWranglerOutput(result.stdout);
}

/** Run an UPDATE/INSERT and return the number of affected rows when reported. */
function runWranglerMutation(mode: Mode, sql: string): { ok: boolean; error?: string } {
  const flag = mode === 'remote' ? '--remote' : '--local';
  const result = spawnSync(
    'pnpm',
    [
      '--filter',
      '@hub/ingest-worker',
      'exec',
      'wrangler',
      'd1',
      'execute',
      'DB',
      flag,
      '--json',
      `--command=${sql}`,
    ],
    { encoding: 'utf8', cwd: process.cwd() },
  );
  if (result.status !== 0) {
    return {
      ok: false,
      error: (result.stderr || result.stdout || '').trim().slice(0, 500),
    };
  }
  return { ok: true };
}

function fetchRows(args: CliArgs): RawRow[] {
  const where = buildWhere(args);
  const sql = `SELECT id, device_id, sender, normalized_body, sms_timestamp,
                      classification, parser_status, parser_id, parser_version
                 FROM raw_sms_events
                 ${where}
                 ORDER BY sms_timestamp DESC
                 LIMIT ${args.limit}`;
  return runWrangler(args.mode, sql);
}

function parseRow(row: RawRow): ParseResult {
  const body = row.normalized_body ?? '';
  // sms_timestamp in D1 is seconds for some seeds and ms for others.
  const smsMs = row.sms_timestamp < 1e12 ? row.sms_timestamp * 1000 : row.sms_timestamp;
  const normalized: NormalizedSms = {
    raw: body,
    text: body,
    sender: row.sender,
    timestamp: smsMs,
    deviceId: row.device_id,
  };
  return parseSms(normalized);
}

interface ResolvedAccount {
  accountId: string | null;
  warnings: string[];
}

function resolveAccount(mode: Mode, hint: string | null): ResolvedAccount {
  if (!hint) return { accountId: null, warnings: [] };
  const sql = `${FIND_ACCOUNT_BY_HINT_SQL}`.replace(/\?1/g, `'${escapeSql(hint)}'`);
  const rows = runWrangler(mode, sql);
  const accountId = (rows[0]?.id as string | undefined) ?? null;
  const warnings: string[] = [];
  if (!accountId) warnings.push('ACCOUNT_HINT_NOT_CONFIGURED');
  return { accountId, warnings };
}

function findExistingTransactionId(mode: Mode, rawSmsEventId: string): string | null {
  const sql = `${FIND_TRANSACTION_BY_EVENT_SQL}`.replace(/\?1/g, `'${escapeSql(rawSmsEventId)}'`);
  const rows = runWrangler(mode, sql);
  return (rows[0]?.id as string | undefined) ?? null;
}

/** Fetch the existing transaction's current financial_account_id. */
function getExistingTransactionAccountId(mode: Mode, txId: string): string | null {
  const sql =
    `SELECT financial_account_id AS aid FROM transaction_candidates WHERE id = ?1 LIMIT 1`.replace(
      /\?1/g,
      `'${escapeSql(txId)}'`,
    );
  const rows = runWrangler(mode, sql);
  const aid = rows[0]?.aid;
  return typeof aid === 'string' ? aid : null;
}

interface PersistPlan {
  updateEventSql: string;
  insertTransactionSql: string | null;
}

function buildPersistPlan(
  row: RawRow,
  result: ParseResult,
  accountId: string | null,
  warnings: string[],
): PersistPlan {
  // raw_sms_events update: classification, parser_status, parser_id,
  // parser_version, processing_error.
  const isRedactable = ['OTP', 'PROMOTIONAL', 'IGNORED'].includes(result.classification);
  const updateEventSql = `UPDATE raw_sms_events
                             SET classification = '${escapeSql(result.classification)}',
                                 parser_status = '${escapeSql(isRedactable ? 'OK' : resultMatched(result))}',
                                 parser_id = ${isRedactable ? 'NULL' : `'${escapeSql(result.parserId)}'`},
                                 parser_version = ${isRedactable ? 'NULL' : `'${escapeSql(result.parserVersion ?? '0.0.0')}'`}
                           WHERE id = '${escapeSql(row.id)}'`;

  // transaction_candidate insert: skip when parser says this isn't a tx.
  if (!shouldCreateTransaction(result) || isRedactable) {
    return { updateEventSql, insertTransactionSql: null };
  }

  const txId = crypto.randomUUID();
  const created = Date.now();
  const status = warnings.includes('AMBIGUOUS_CURRENCY')
    ? 'NEEDS_REVIEW'
    : initialStatus({ ...result, warnings });
  const evidenceJson = buildEvidenceJson({ ...result, warnings });
  const bankTs = extractBankTimestamp(result);
  const values = [
    txId,
    row.id,
    accountId,
    result.direction,
    result.amountIrr,
    result.balanceIrr,
    result.transactionReference,
    bankTs,
    result.confidence,
    result.parserId ?? 'unknown',
    result.parserVersion ?? '0.0.0',
    evidenceJson,
    status,
    created,
    created,
  ];
  const sql = `${INSERT_TRANSACTION_SQL}`.replace(/\?(\d+)/g, (_, n) => {
    const v = values[Number.parseInt(n, 10) - 1];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    return `'${escapeSql(String(v))}'`;
  });
  return { updateEventSql, insertTransactionSql: sql };
}

function resultMatched(r: ParseResult): 'OK' | 'WARN' | 'ERROR' {
  if (r.matched) return 'OK';
  if (r.warnings.length > 0) return 'WARN';
  return 'ERROR';
}

function extractBankTimestamp(r: ParseResult): number | null {
  const ev = (r.evidence ?? {}) as { bankTimestamp?: number };
  return typeof ev.bankTimestamp === 'number' ? ev.bankTimestamp : null;
}

function planReparse(args: CliArgs, rows: RawRow[]): ReparseRow[] {
  const plans: ReparseRow[] = [];
  for (const row of rows) {
    const result = parseRow(row);
    const isRedactable = ['OTP', 'PROMOTIONAL', 'IGNORED'].includes(result.classification);
    const baseWarnings = [...result.warnings];

    let accountId: string | null = null;
    let accountWarning: string[] = [];
    if (!isRedactable && result.accountHint) {
      const resolved = resolveAccount(args.mode, result.accountHint);
      accountId = resolved.accountId;
      accountWarning = resolved.warnings;
    }
    const finalWarnings = annotateAccountWarning({ ...result, warnings: baseWarnings }, accountId);
    finalWarnings.push(...accountWarning);
    const dedup = [...new Set(finalWarnings)];

    let action: Action;
    if (!result.matched && result.classification === 'UNKNOWN') {
      action = { kind: 'PARSE_FAILED', detail: result.evidence.reason ?? '' };
    } else if (isRedactable) {
      action = {
        kind: 'SKIPPED_NOT_TRANSACTION',
        detail: `classification=${result.classification}`,
      };
    } else if (!shouldCreateTransaction(result)) {
      action = {
        kind: 'SKIPPED_NOT_TRANSACTION',
        detail: 'no amount/balance/direction',
      };
    } else {
      // Check if transaction_candidate already exists. If it does and the
      // account was previously NULL but now resolves, we can enrich it.
      const existingId = findExistingTransactionId(args.mode, row.id);
      if (existingId) {
        const existingAid = getExistingTransactionAccountId(args.mode, existingId);
        if (!existingAid && accountId) {
          action = {
            kind: args.dryRun ? 'WOULD_ENRICH_TRANSACTION' : 'APPLIED',
            detail: `transaction_candidates.id=${existingId.slice(0, 8)} → financial_account_id=${accountId.slice(0, 8)}`,
          };
        } else if (existingAid && accountId && existingAid !== accountId) {
          action = {
            kind: 'KEPT_EXISTING_ACCOUNT',
            detail: `existing=${existingAid.slice(0, 8)} != parsed=${accountId.slice(0, 8)}`,
          };
        } else {
          action = {
            kind: 'TRANSACTION_ALREADY_EXISTS',
            detail: `transaction_candidates.id=${existingId.slice(0, 8)}`,
          };
        }
      } else {
        action = {
          kind: args.dryRun ? 'WOULD_CREATE_TRANSACTION' : 'APPLIED',
          detail: '',
        };
      }
    }

    plans.push({
      id: row.id,
      oldParser: row.parser_id ?? '-',
      newParser: result.parserId,
      oldClassification: row.classification,
      newClassification: result.classification,
      amount: result.amountIrr,
      balance: result.balanceIrr,
      direction: result.direction,
      accountHint: result.accountHint,
      financialAccountId: accountId,
      action,
      warnings: dedup,
    });
  }
  return plans;
}

function applyPlans(args: CliArgs, plans: ReparseRow[]): ReparseRow[] {
  if (args.dryRun) return plans;
  const rows = fetchRows(args);
  return plans.map((p, idx) => {
    const row = rows[idx];
    if (!row) return p;
    const result = parseRow(row);
    const isRedactable = ['OTP', 'PROMOTIONAL', 'IGNORED'].includes(result.classification);
    let accountId: string | null = null;
    let accountWarning: string[] = [];
    if (!isRedactable && result.accountHint) {
      const resolved = resolveAccount(args.mode, result.accountHint);
      accountId = resolved.accountId;
      accountWarning = resolved.warnings;
    }
    const baseWarnings = [...result.warnings];
    const finalWarnings = annotateAccountWarning({ ...result, warnings: baseWarnings }, accountId);
    finalWarnings.push(...accountWarning);
    const dedup = [...new Set(finalWarnings)];

    // Idempotency: if a transaction_candidate already exists for this
    // raw_sms_event_id, do NOT insert another. Re-update the raw event so
    // its parser metadata stays in sync, but report existing.
    const existingTxId = findExistingTransactionId(args.mode, row.id);
    const plan = buildPersistPlan(row, result, accountId, dedup);
    const eventUpdate = runWranglerMutation(args.mode, plan.updateEventSql);
    if (!eventUpdate.ok) {
      return { ...p, action: { kind: 'PARSE_FAILED', detail: eventUpdate.error ?? '' } };
    }
    if (!plan.insertTransactionSql) {
      const skipped: Action = {
        kind: 'SKIPPED_NOT_TRANSACTION',
        detail: isRedactable
          ? `classification=${result.classification}`
          : 'no amount/balance/direction',
      };
      return { ...p, action: skipped };
    }
    if (existingTxId) {
      const existingAid = getExistingTransactionAccountId(args.mode, existingTxId);
      if (!existingAid && accountId) {
        // Enrichment path: previous run could not resolve the account, but
        // now a financial_accounts row exists with this hint. UPDATE only
        // the financial_account_id; never touch other fields.
        const enrichSql = `UPDATE transaction_candidates
                              SET financial_account_id = '${escapeSql(accountId)}',
                                  updated_at = ${Date.now()}
                            WHERE id = '${escapeSql(existingTxId)}'
                              AND financial_account_id IS NULL`;
        const r = runWranglerMutation(args.mode, enrichSql);
        if (!r.ok) {
          return { ...p, action: { kind: 'PARSE_FAILED', detail: r.error ?? '' } };
        }
        return {
          ...p,
          action: {
            kind: 'APPLIED',
            detail: `transaction_candidates.id=${existingTxId.slice(0, 8)} enriched with financial_account_id=${accountId.slice(0, 8)}`,
          },
        };
      }
      if (existingAid && accountId && existingAid !== accountId) {
        // Never overwrite a non-NULL with a different account.
        return {
          ...p,
          action: {
            kind: 'KEPT_EXISTING_ACCOUNT',
            detail: `existing=${existingAid.slice(0, 8)} != parsed=${accountId.slice(0, 8)}`,
          },
        };
      }
      return {
        ...p,
        action: {
          kind: 'TRANSACTION_ALREADY_EXISTS',
          detail: `transaction_candidates.id=${existingTxId.slice(0, 8)}`,
        },
      };
    }
    const txInsert = runWranglerMutation(args.mode, plan.insertTransactionSql);
    if (!txInsert.ok) {
      return { ...p, action: { kind: 'PARSE_FAILED', detail: txInsert.error ?? '' } };
    }
    return {
      ...p,
      action: { kind: 'APPLIED', detail: 'event updated + transaction_candidate inserted' },
    };
  });
}

function renderTable(plans: ReparseRow[], dryRun: boolean): void {
  const header = [
    'eventId',
    'oldParser',
    'newParser',
    'oldCls',
    'newCls',
    'amount',
    'balance',
    'dir',
    'account',
    'action',
    'warnings',
  ];
  const rows = plans.map((p) => [
    p.id.slice(0, 8),
    p.oldParser,
    p.newParser,
    p.oldClassification,
    p.newClassification,
    p.amount === null ? '-' : p.amount.toLocaleString('en-US'),
    p.balance === null ? '-' : p.balance.toLocaleString('en-US'),
    p.direction,
    p.financialAccountId ? p.financialAccountId.slice(0, 8) : (p.accountHint ?? '-'),
    p.action.kind + (p.action.detail ? ` (${p.action.detail})` : ''),
    p.warnings.join(',') || '-',
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!)).join('  ');
  process.stdout.write(`Mode: ${dryRun ? 'DRY-RUN' : 'WRITE'}\n`);
  process.stdout.write(fmt(header) + '\n');
  process.stdout.write(widths.map((w) => '-'.repeat(w)).join('  ') + '\n');
  for (const row of rows) process.stdout.write(fmt(row) + '\n');
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(2);
  }

  // Fixture mode: run the parser against an inline fixture body and print
  // the result without touching D1.
  if (args.fixture !== null) {
    const body = FIXTURES[args.fixture];
    if (!body) {
      process.stderr.write(
        `Unknown fixture: ${args.fixture}. Use --list-fixtures to see valid names.\n`,
      );
      process.exit(2);
    }
    const smsMs = Date.now();
    const result = parseSms({
      raw: body,
      text: body,
      sender: 'BANK',
      timestamp: smsMs,
      deviceId: 'fixture',
    });
    const identifiers = (result.evidence?.detectedIdentifiers ?? []) as Array<{
      type: string;
      normalizedValue: string;
      parserId: string;
    }>;
    process.stdout.write(`fixture: ${args.fixture}\n`);
    process.stdout.write(`parser: ${result.parserId ?? '-'}\n`);
    process.stdout.write(`classification: ${result.classification}\n`);
    process.stdout.write(`direction: ${result.direction}\n`);
    process.stdout.write(`amount: ${result.amountIrr?.toLocaleString('en-US') ?? '-'}\n`);
    process.stdout.write(`balance: ${result.balanceIrr?.toLocaleString('en-US') ?? '-'}\n`);
    process.stdout.write(`account_hint: ${result.accountHint ?? '-'}\n`);
    process.stdout.write(
      `detected_identifiers: ${
        identifiers.length
          ? identifiers.map((i) => `${i.type}=${i.normalizedValue}`).join(', ')
          : '-'
      }\n`,
    );
    process.stdout.write(`warnings: ${result.warnings.join(',') || '-'}\n`);
    return;
  }

  let rows: RawRow[];
  try {
    rows = fetchRows(args);
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  }

  if (rows.length === 0) {
    process.stdout.write(`No matching rows in ${args.mode} D1. Check the event id / filters.\n`);
    return;
  }

  const plans = planReparse(args, rows);
  const finalPlans = args.dryRun ? plans : applyPlans(args, plans);
  renderTable(finalPlans, args.dryRun);
}

main();
