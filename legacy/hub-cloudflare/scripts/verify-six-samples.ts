#!/usr/bin/env -S pnpm exec tsx
/**
 * Live verification for the 6 real Iranian bank SMS samples.
 *
 * Usage:
 *   INGEST_URL=https://ingest.example.workers.dev \
 *   DASHBOARD_URL=https://dashboard.example.workers.dev \
 *   VERIFY_API_KEY=<device-api-key> VERIFY_DEVICE_ID=<device-code> \
 *   VERIFY_DEVICE_NAME='Test Phone' \
 *     pnpm exec tsx scripts/verify-six-samples.ts
 *
 * For each of the 6 documented sample bodies:
 *   1. POST /api/v1/sms with sender='BANK' + the device api key
 *   2. Wait briefly so D1 finalizes the write
 *   3. GET /api/v1/today  and  /api/v1/matches/unmatched
 *   4. Confirm the row's parser_id / account_hint / detected_identifiers match expectations
 *   5. Dump a verification table
 *
 * Exits non-zero if any sample is missing or doesn't match expectations.
 *
 * Bodies, API keys, credentials, OTP contents, and authentication headers
 * are NEVER logged.
 */

interface Fixture {
  name: string;
  message: string;
  expectedParser: string;
  accountHint: string;
}

const FIXTURES: Fixture[] = [
  {
    name: 'sample-1-account-transfer',
    message: [
      'انتقال اینترنت',
      'حساب:310057795083',
      'مبلغ:5,500,000+',
      'مانده:82,791,067',
      '05/14-11:30',
    ].join('\n'),
    expectedParser: 'account-transfer-signed-v1',
    accountHint: '310057795083',
  },
  {
    name: 'sample-2-compact',
    message: ['777.888.21654304.1', '+2,000,000', '05/14_17:04', 'مانده: 134,760,000'].join('\n'),
    expectedParser: 'compact-signed-v1',
    accountHint: '777.888.21654304.1',
  },
  {
    name: 'sample-3-compact',
    message: ['10.5718857.1', '+1,000,000', '05/14_20:30', 'مانده: 1,070,374,127'].join('\n'),
    expectedParser: 'compact-signed-v1',
    accountHint: '10.5718857.1',
  },
  {
    name: 'sample-4-melli',
    message: [
      'بانك ملي',
      'انتقال:+1,500,000',
      'حساب:17000',
      'مانده:78,159,809',
      '05/14-16:30',
    ].join('\n'),
    expectedParser: 'melli-transfer-v1',
    accountHint: '17000',
  },
  {
    name: 'sample-5-parsian-jalali',
    message: ['300432401476', '2,800,000+', 'مانده:16,234,550', '1405/5/14-18:01'].join('\n'),
    expectedParser: 'parsian-signed-v1',
    accountHint: '300432401476',
  },
  {
    name: 'sample-6-shahr',
    message: [
      '*بانک شهر*',
      'انتقال وجه کارتی',
      'واریز به:4003537814',
      'مبلغ:1,950,000 ریال',
      'موجودی:112,686,500 ریال',
      '1405/05/14 02:02:14',
    ].join('\n'),
    expectedParser: 'shahr-credit-v1',
    accountHint: '4003537814',
  },
];

async function postSample(
  ingestUrl: string,
  apiKey: string,
  deviceId: string,
  deviceName: string,
  fx: Fixture,
): Promise<{ ok: boolean; duplicate: boolean; eventId: string }> {
  const r = await fetch(`${ingestUrl}/api/v1/sms`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      apiKey,
      deviceId,
      deviceName,
      message: fx.message,
      sender: 'BANK',
      timestamp: String(Date.now()),
      checksum: 'a'.repeat(32),
    }),
  });
  if (!r.ok) {
    throw new Error(
      `ingest returned ${r.status} for ${fx.name}: ${(await r.text()).slice(0, 200)}`,
    );
  }
  return (await r.json()) as { ok: boolean; duplicate: boolean; eventId: string };
}

interface UnmatchedRow {
  id: string;
  parser_id: string | null;
  account_hint: string | null;
  detected_identifiers: Array<{ type: string; normalized_value: string }>;
}

async function findInUnmatched(
  dashboardUrl: string,
  accessCookie: string | null,
  apiKey: string,
  fx: Fixture,
): Promise<UnmatchedRow | null> {
  const headers: Record<string, string> = apiKey ? { cookie: accessCookie ?? '' } : {};
  void headers;
  const r = await fetch(`${dashboardUrl}/api/v1/matches/unmatched`, {
    headers: accessCookie ? { cookie: accessCookie } : {},
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { ok: boolean; items: UnmatchedRow[] };
  if (!j.ok) return null;
  return (
    j.items.find((it) => {
      const hint = it.account_hint;
      const matchesHint = hint === fx.accountHint;
      const matchesParser = it.parser_id === fx.expectedParser;
      return matchesHint && matchesParser;
    }) ?? null
  );
}

interface TodayRow {
  id: string;
  parser_id: string | null;
  account_hint: string | null;
  amount_irr: number | null;
  direction: string | null;
}

async function findInToday(
  dashboardUrl: string,
  accessCookie: string | null,
  fx: Fixture,
): Promise<TodayRow | null> {
  const r = await fetch(`${dashboardUrl}/api/v1/today`, {
    headers: accessCookie ? { cookie: accessCookie } : {},
  });
  if (!r.ok) return null;
  const j = (await r.json()) as { ok: boolean; items: TodayRow[] };
  if (!j.ok) return null;
  return (
    j.items.find((it) => {
      const hint = it.account_hint;
      const matchesHint = hint === fx.accountHint;
      const matchesParser = it.parser_id === fx.expectedParser;
      return matchesHint && matchesParser;
    }) ?? null
  );
}

async function main(): Promise<void> {
  const ingestUrl = process.env.INGEST_URL;
  const dashboardUrl = process.env.DASHBOARD_URL;
  const apiKey = process.env.VERIFY_API_KEY;
  const deviceId = process.env.VERIFY_DEVICE_ID;
  const deviceName = process.env.VERIFY_DEVICE_NAME ?? 'Verify Phone';
  const accessCookie = process.env.VERIFY_ACCESS_COOKIE ?? null;

  if (!ingestUrl || !dashboardUrl || !apiKey || !deviceId) {
    process.stderr.write(
      'Missing one of: INGEST_URL DASHBOARD_URL VERIFY_API_KEY VERIFY_DEVICE_ID\n',
    );
    process.exit(2);
  }

  const rows: Array<{
    name: string;
    expectedParser: string;
    accountHint: string;
    parser: string;
    inToday: string;
    inUnmatched: string;
    identifier: string;
    result: 'PASS' | 'FAIL';
  }> = [];

  for (const fx of FIXTURES) {
    process.stderr.write(`-> ${fx.name}\n`);
    try {
      await postSample(ingestUrl, apiKey, deviceId, deviceName, fx);
    } catch (e) {
      process.stderr.write(`   ingest error: ${(e as Error).message}\n`);
      rows.push({
        name: fx.name,
        expectedParser: fx.expectedParser,
        accountHint: fx.accountHint,
        parser: 'POST_FAIL',
        inToday: '-',
        inUnmatched: '-',
        identifier: '-',
        result: 'FAIL',
      });
      continue;
    }
    await new Promise((r) => setTimeout(r, 300));
    const today = await findInToday(dashboardUrl, accessCookie, fx);
    const unmatched = await findInUnmatched(dashboardUrl, accessCookie, apiKey, fx);
    rows.push({
      name: fx.name,
      expectedParser: fx.expectedParser,
      accountHint: fx.accountHint,
      parser: today?.parser_id ?? unmatched?.parser_id ?? '-',
      inToday: today ? 'yes' : 'no',
      inUnmatched: unmatched ? 'yes' : 'no',
      identifier: unmatched?.detected_identifiers[0]
        ? `${unmatched.detected_identifiers[0].type}=${unmatched.detected_identifiers[0].normalized_value}`
        : '-',
      result: today || unmatched ? 'PASS' : 'FAIL',
    });
  }

  const fmt = (cells: string[]) =>
    cells.map((c, i) => c.padEnd([18, 32, 16, 32, 6, 6, 30, 6][i] ?? c.length)).join('  ');
  process.stdout.write(
    fmt([
      'name',
      'expectedParser',
      'accountHint',
      'parser',
      'today',
      'unm',
      'identifier',
      'result',
    ]) + '\n',
  );
  for (const r of rows) {
    process.stdout.write(
      fmt([
        r.name,
        r.expectedParser,
        r.accountHint,
        r.parser,
        r.inToday,
        r.inUnmatched,
        r.identifier,
        r.result,
      ]) + '\n',
    );
  }

  const failures = rows.filter((r) => r.result !== 'PASS').length;
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
