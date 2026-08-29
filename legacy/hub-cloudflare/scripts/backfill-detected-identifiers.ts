#!/usr/bin/env -S pnpm exec tsx
/**
 * Backfill transaction_detected_identifiers for transactions already in D1.
 *
 * For every transaction_candidate, look at its parser_evidence_json — if
 * the parser emitted `detectedIdentifiers`, insert them with INSERT OR
 * IGNORE on the UNIQUE(tx, type, value) index. As a fallback for older
 * rows whose evidence only carries `accountHint`, synthesize a single
 * ACCOUNT_NUMBER identifier from that hint.
 *
 * Usage:
 *   pnpm backfill:identifiers -- [--local | --remote] [--dry-run | --write]
 *                                    [--limit N]
 *
 * Default: --local --dry-run.
 *
 * No raw SMS body is printed. No API keys are touched.
 */
import { spawnSync } from 'node:child_process';
import { normalizeIdentifier } from '../packages/sms-parser/src/identifier.ts';

type Mode = 'local' | 'remote';

interface CliArgs {
  mode: Mode;
  dryRun: boolean;
  write: boolean;
  limit: number;
  ids: string[];
}

interface TxRow {
  id: string;
  parser_id: string;
  parser_evidence_json: string;
}

interface DetectedIdentifier {
  type: 'ACCOUNT_NUMBER' | 'CARD_LAST_FOUR' | 'IBAN' | 'ACCOUNT_HINT';
  normalizedValue: string;
  maskedValue: string;
  confidence: number;
  parserId: string;
}

function parseArgs(): CliArgs {
  const argv = process.argv.slice(2);
  const mode: Mode = argv.includes('--remote') ? 'remote' : 'local';
  const dryRun = argv.includes('--dry-run') || !argv.includes('--write');
  const write = !dryRun && argv.includes('--write');
  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx > -1 ? Number.parseInt(argv[limitIdx + 1] ?? '5000', 10) : 5000;
  // Optional `--ids a,b,c` filter narrows the loop to a whitelist.
  const idsIdx = argv.indexOf('--ids');
  const ids =
    idsIdx > -1
      ? (argv[idsIdx + 1] ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  if (mode === 'remote' && write && !argv.includes('--confirmed')) {
    console.error(
      'refusing to --write to --remote without explicit intent; pass --confirmed to enable remote writes',
    );
    process.exit(2);
  }
  return { mode, dryRun, write, limit, ids };
}

function wranglerExecute(args: { sql: string; mode: Mode }): { rows: unknown[] } {
  const flag = args.mode === 'remote' ? '--remote' : '--local';
  // Use the wrangler binary that ships in apps/dashboard-worker — it's
  // pinned to the same wrangler version we use for deployments.
  const wranglerBin = 'apps/dashboard-worker/node_modules/.bin/wrangler';
  const r = spawnSync(
    wranglerBin,
    ['d1', 'execute', 'payment-hub-staging', flag, '--json', '--command', args.sql],
    { encoding: 'utf-8', cwd: process.cwd() },
  );
  if (r.status !== 0) {
    throw new Error(`wrangler failed (${r.status}): ${r.stderr || r.stdout}`);
  }
  // wrangler --json prints either a JSON array, or a single object with
  // `results`. Some wrangler versions append preview text after the JSON.
  const raw = r.stdout.trim();
  const start = raw.indexOf('[');
  const objStart = raw.indexOf('{');
  let slice: string;
  if (start === -1 && objStart === -1) return { rows: [] };
  if (start === -1) {
    slice = raw.slice(objStart);
  } else if (objStart === -1) {
    slice = raw.slice(start);
  } else {
    slice = start < objStart ? raw.slice(start) : raw.slice(objStart);
  }
  // Truncate at the first balanced bracket.
  const parser = new Function('s', `try { return JSON.parse(s); } catch (_) { return null; }`);
  let parsed: unknown = parser(slice);
  if (!parsed) {
    // fall back: try each line
    for (const line of raw.split('\n')) {
      const p = parser(line.trim());
      if (p) {
        parsed = p;
        break;
      }
    }
  }
  if (!parsed) return { rows: [] };
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { rows: [] };
    const head = parsed[0] as { results?: unknown[] };
    const rows = (head?.results ?? []) as unknown[];
    return { rows };
  }
  const obj = parsed as { results?: unknown[] };
  return { rows: (obj.results ?? []) as unknown[] };
}

function deriveDetected(row: TxRow): DetectedIdentifier[] {
  // 1. New shape: parser emitted detectedIdentifiers.
  let ev: {
    accountHint?: string;
    detectedIdentifiers?: Array<Partial<DetectedIdentifier>>;
  };
  try {
    ev = JSON.parse(row.parser_evidence_json);
  } catch {
    return [];
  }
  if (Array.isArray(ev.detectedIdentifiers)) {
    const out: DetectedIdentifier[] = [];
    for (const d of ev.detectedIdentifiers) {
      if (!d || typeof d.normalizedValue !== 'string' || typeof d.type !== 'string') continue;
      out.push({
        type: d.type as DetectedIdentifier['type'],
        normalizedValue: d.normalizedValue,
        maskedValue:
          typeof d.maskedValue === 'string'
            ? d.maskedValue
            : normalizeIdentifier(d.normalizedValue).displayValueMasked,
        confidence:
          typeof d.confidence === 'number' ? Math.max(0, Math.min(1, d.confidence)) : 0.95,
        parserId: typeof d.parserId === 'string' ? d.parserId : row.parser_id || 'unknown',
      });
    }
    return out;
  }
  // 2. Legacy fallback: synthesize from accountHint.
  if (typeof ev.accountHint === 'string' && ev.accountHint.length > 0) {
    const n = normalizeIdentifier(ev.accountHint);
    if (!n.normalizedValue) return [];
    return [
      {
        type: 'ACCOUNT_NUMBER',
        normalizedValue: n.normalizedValue,
        maskedValue: n.displayValueMasked,
        confidence: 0.95,
        parserId: row.parser_id || 'unknown',
      },
    ];
  }
  return [];
}

function main() {
  const args = parseArgs();
  console.log(
    `mode=${args.mode} dryRun=${args.dryRun} write=${args.write} limit=${args.limit} ids=${args.ids.length}`,
  );
  const idFilter =
    args.ids.length > 0
      ? `AND id IN (${args.ids.map((s) => `'${s.replace(/'/g, "''")}'`).join(',')})`
      : '';
  const { rows } = wranglerExecute({
    mode: args.mode,
    sql: `SELECT id, parser_id, parser_evidence_json
            FROM transaction_candidates
            WHERE 1=1 ${idFilter}
            ORDER BY created_at DESC
            LIMIT ${args.limit}`,
  });
  const txs = rows as TxRow[];
  let insertedOrKnown = 0;
  let skipped = 0;
  for (const tx of txs) {
    const detected = deriveDetected(tx);
    if (detected.length === 0) {
      skipped++;
      continue;
    }
    if (!args.write) {
      insertedOrKnown += detected.length;
      continue;
    }
    for (const d of detected) {
      const id = crypto.randomUUID();
      const created = Date.now();
      // INSERT OR IGNORE on UNIQUE(tx, type, normalized_value).
      wranglerExecute({
        mode: args.mode,
        sql: `INSERT OR IGNORE INTO transaction_detected_identifiers
              (id, transaction_candidate_id, identifier_type, normalized_value,
               display_value_masked, parser_id, confidence, created_at)
              VALUES ('${id}', '${tx.id}', '${d.type}', '${d.normalizedValue.replace(/'/g, "''")}',
                      '${d.maskedValue.replace(/'/g, "''")}', '${d.parserId.replace(/'/g, "''")}',
                      ${d.confidence}, ${created})`,
      });
      insertedOrKnown++;
    }
  }
  console.log(
    `processed ${txs.length} txs; inserted/note ${insertedOrKnown} identifiers; skipped ${skipped}`,
  );
}

main();
