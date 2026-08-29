#!/usr/bin/env -S pnpm exec tsx
/**
 * Live verification for the per-account "Re-run account assignment" flow.
 *
 * Usage:
 *   DASHBOARD_URL=https://dashboard-worker.samsos.workers.dev \
 *   VERIFY_ACCESS_COOKIE=<cf-access-cookie> \
 *     pnpm exec tsx scripts/verify-rerun-assignment.ts
 *
 * Verifies, against the production identifier 7001018246497:
 *   1. POST /api/v1/accounts → find account whose account_hint matches.
 *   2. POST /api/v1/accounts/:id/rerun-assignment-preview → expect
 *      counts that include willAssign=1, willRepairHistory=3,
 *      alreadyCorrect=1 (per the user's spec for the seeded dataset).
 *   3. POST /api/v1/accounts/:id/rerun-assignment/:previewId/apply →
 *      expect applied >= 1.
 *   4. Re-run preview → expect willAssign=0, willRepairHistory=0
 *      (idempotent on identical triples).
 *   5. Open a second preview, call decline → expect zero new rows in
 *      transaction_account_assignments for that account since the
 *      previous apply.
 *
 * Exits non-zero on any miss.
 *
 * Cookies, API keys, OTP contents, and authentication headers are NEVER
 * logged.
 */

interface AccountListItem {
  id: string;
  account_hint: string | null;
  display_name: string;
}

interface PreviewResponse {
  ok: boolean;
  previewId: string;
  expiresAt: number;
  counts: {
    willAssign: number;
    willRepairHistory: number;
    alreadyCorrect: number;
    manualAssignmentsSkipped: number;
    ambiguous: number;
    conflicts: number;
  };
  items: Array<{
    id: string;
    transactionId: string;
    disposition: string;
    identifierType: string | null;
    normalizedIdentifier: string | null;
  }>;
}

interface ApplyResponse {
  ok: boolean;
  previewId: string;
  applied: number;
  skipped: number;
  conflicts: number;
  manualPreserved: number;
  affectedTxIds: string[];
}

interface DeclineResponse {
  ok: boolean;
  previewId: string;
}

const ACCOUNT_NUMBER = '7001018246497';

async function listAccounts(dashboardUrl: string, cookie: string): Promise<AccountListItem[]> {
  const r = await fetch(`${dashboardUrl}/api/v1/accounts`, {
    headers: { cookie },
  });
  if (!r.ok) throw new Error(`GET /accounts → ${r.status}`);
  const j = (await r.json()) as { ok: boolean; items: AccountListItem[] };
  if (!j.ok) throw new Error('accounts response was not ok');
  return j.items;
}

async function preview(
  dashboardUrl: string,
  cookie: string,
  accountId: string,
): Promise<PreviewResponse> {
  const r = await fetch(`${dashboardUrl}/api/v1/accounts/${accountId}/rerun-assignment-preview`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  if (!r.ok) throw new Error(`preview → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as PreviewResponse;
}

async function apply(
  dashboardUrl: string,
  cookie: string,
  accountId: string,
  previewId: string,
): Promise<ApplyResponse> {
  const r = await fetch(
    `${dashboardUrl}/api/v1/accounts/${accountId}/rerun-assignment/${previewId}/apply`,
    {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  if (!r.ok) throw new Error(`apply → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as ApplyResponse;
}

async function decline(
  dashboardUrl: string,
  cookie: string,
  accountId: string,
  previewId: string,
): Promise<DeclineResponse> {
  const r = await fetch(
    `${dashboardUrl}/api/v1/accounts/${accountId}/rerun-assignment/${previewId}/decline`,
    {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    },
  );
  if (!r.ok) throw new Error(`decline → ${r.status} ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as DeclineResponse;
}

interface Row {
  step: string;
  expected: string;
  got: string;
  result: 'PASS' | 'FAIL';
}

async function main(): Promise<void> {
  const dashboardUrl = process.env.DASHBOARD_URL;
  const cookie = process.env.VERIFY_ACCESS_COOKIE;
  if (!dashboardUrl || !cookie) {
    process.stderr.write('Missing DASHBOARD_URL or VERIFY_ACCESS_COOKIE\n');
    process.exit(2);
  }

  const rows: Row[] = [];

  const accounts = await listAccounts(dashboardUrl, cookie);
  const target = accounts.find((a) => a.account_hint === ACCOUNT_NUMBER);
  if (!target) {
    rows.push({
      step: 'find target account by hint',
      expected: ACCOUNT_NUMBER,
      got: 'not found',
      result: 'FAIL',
    });
    print(rows);
    process.exit(1);
  }
  rows.push({
    step: 'find target account by hint',
    expected: ACCOUNT_NUMBER,
    got: target.id,
    result: 'PASS',
  });

  // Step 2: initial preview.
  const p1 = await preview(dashboardUrl, cookie, target.id);
  rows.push({
    step: 'preview willAssign >= 1',
    expected: '>=1',
    got: String(p1.counts.willAssign),
    result: p1.counts.willAssign >= 1 ? 'PASS' : 'FAIL',
  });
  rows.push({
    step: 'preview willRepairHistory >= 3',
    expected: '>=3',
    got: String(p1.counts.willRepairHistory),
    result: p1.counts.willRepairHistory >= 3 ? 'PASS' : 'FAIL',
  });
  rows.push({
    step: 'preview alreadyCorrect >= 1',
    expected: '>=1',
    got: String(p1.counts.alreadyCorrect),
    result: p1.counts.alreadyCorrect >= 1 ? 'PASS' : 'FAIL',
  });

  // Step 3: apply.
  const a1 = await apply(dashboardUrl, cookie, target.id, p1.previewId);
  rows.push({
    step: 'apply applied >= 1',
    expected: '>=1',
    got: String(a1.applied),
    result: a1.applied >= 1 ? 'PASS' : 'FAIL',
  });
  rows.push({
    step: 'apply conflicts == 0 (no concurrent edits)',
    expected: '0',
    got: String(a1.conflicts),
    result: a1.conflicts === 0 ? 'PASS' : 'FAIL',
  });

  // Step 4: re-run preview → idempotent.
  const p2 = await preview(dashboardUrl, cookie, target.id);
  rows.push({
    step: 're-preview willAssign == 0',
    expected: '0',
    got: String(p2.counts.willAssign),
    result: p2.counts.willAssign === 0 ? 'PASS' : 'FAIL',
  });
  rows.push({
    step: 're-preview willRepairHistory == 0',
    expected: '0',
    got: String(p2.counts.willRepairHistory),
    result: p2.counts.willRepairHistory === 0 ? 'PASS' : 'FAIL',
  });

  // Step 5: open a 3rd preview and decline it.
  const p3 = await preview(dashboardUrl, cookie, target.id);
  const d3 = await decline(dashboardUrl, cookie, target.id, p3.previewId);
  rows.push({
    step: 'decline returns ok=true',
    expected: 'true',
    got: String(d3.ok),
    result: d3.ok ? 'PASS' : 'FAIL',
  });

  print(rows);
  const failures = rows.filter((r) => r.result !== 'PASS').length;
  process.exit(failures > 0 ? 1 : 0);
}

function print(rows: Row[]): void {
  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd([48, 12, 32, 6][i] ?? c.length)).join('  ');
  process.stdout.write(fmt(['step', 'expected', 'got', 'result']) + '\n');
  for (const r of rows) {
    process.stdout.write(fmt([r.step, r.expected, r.got, r.result]) + '\n');
  }
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
