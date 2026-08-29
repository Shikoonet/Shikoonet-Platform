#!/usr/bin/env tsx
/**
 * Inject a synthetic bank CREDIT SMS into staging ingest (TEST only).
 *
 * Usage:
 *   source .staging-test.env   # STAGING_SMS_API_KEY from setup-staging-mirzabot-test.sh
 *   pnpm inject:staging-sms -- --amount-toman 195000 --account-hint 30101883751600
 *
 * Options:
 *   --amount-toman N        Toman amount (IRR = N * 10). Default 195000.
 *   --account-hint HINT     Must match an ACTIVE financial_accounts.account_hint on staging.
 *   --device-id CODE        Default mirzabot-test-sms
 *   --ingest-url URL        Default https://ingest-worker.samsos.workers.dev/api/v1/sms
 *   --bank-timestamp-ms MS  Optional fixed bank timestamp (epoch ms). Default: now.
 */

import { createHash, randomBytes } from 'node:crypto';

const INGEST_URL =
  process.env.STAGING_INGEST_URL ?? 'https://ingest-worker.samsos.workers.dev/api/v1/sms';
const DEVICE_CODE = process.env.STAGING_SMS_DEVICE_CODE ?? 'mirzabot-test-sms';
const DEVICE_NAME = process.env.STAGING_SMS_DEVICE_NAME ?? 'Mirzabot TEST SMS Injector';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function formatIrr(amountIrr: number): string {
  return amountIrr.toLocaleString('en-US');
}

function buildCompactSignedSms(accountHint: string, amountIrr: number): string {
  return [
    accountHint,
    `${formatIrr(amountIrr)}+`,
    'مانده:40,913,550',
    '1405/05/14 18:01',
  ].join('\n');
}

async function main(): Promise<void> {
  const apiKey = process.env.STAGING_SMS_API_KEY;
  if (!apiKey) {
    console.error('Missing STAGING_SMS_API_KEY. Run scripts/setup-staging-mirzabot-test.sh first.');
    process.exit(1);
  }

  const amountToman = Number.parseInt(arg('amount-toman', '195000')!, 10);
  if (!Number.isFinite(amountToman) || amountToman <= 0) {
    console.error('Invalid --amount-toman');
    process.exit(1);
  }
  const amountIrr = amountToman * 10;
  const accountHint = arg('account-hint', '30101883751600')!;
  const deviceId = arg('device-id', DEVICE_CODE)!;
  const bankTs = arg('bank-timestamp-ms')
    ? Number.parseInt(arg('bank-timestamp-ms')!, 10)
    : Date.now();
  const ingestUrl = arg('ingest-url', INGEST_URL)!;

  const message = buildCompactSignedSms(accountHint, amountIrr);
  const checksum = createHash('sha256').update(message + bankTs).digest('hex').slice(0, 32);
  const body = {
    apiKey,
    deviceId,
    deviceName: DEVICE_NAME,
    message,
    sender: 'TEST-INJECT',
    timestamp: String(bankTs),
    checksum,
  };

  console.log('Posting synthetic SMS to staging ingest…');
  console.log(`  account_hint: ${accountHint}`);
  console.log(`  amount: ${amountToman.toLocaleString()} Toman = ${amountIrr.toLocaleString()} IRR (×10)`);
  console.log('  NOTE: use the exact Toman amount shown by the bot, not a rounded example.');
  console.log(`  bank_timestamp_ms: ${bankTs}`);

  const res = await fetch(ingestUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }

  if (!res.ok) {
    console.error('Ingest failed:', res.status, json);
    process.exit(1);
  }

  console.log('Ingest OK:', JSON.stringify(json, null, 2));
  console.log('\nCheck dashboard Today / Unmatched for the new CREDIT transaction.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
