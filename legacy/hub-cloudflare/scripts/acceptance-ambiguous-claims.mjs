#!/usr/bin/env node
/**
 * Live staging acceptance: two claims competing for one bank transfer.
 *
 *   1. POST claim A (paidClickedAt = T)
 *   2. POST claim B (paidClickedAt = T + 10s)
 *   3. Inject one SMS (bankTimestamp = T + 20s) — inside both ±60s windows
 *
 * Expected: both claims → AMBIGUOUS_CLAIMS, transaction not consumed.
 *
 * Usage: source .staging-test.env && node scripts/acceptance-ambiguous-claims.mjs
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';

const CLAIMS_URL =
  process.env.PAYMENT_HUB_CLAIMS_URL ??
  'https://ingest-worker.samsos.workers.dev/api/v1/integrations/mirzabot/claims';
const CLAIMS_PATH = '/api/v1/integrations/mirzabot/claims';
const INTEGRATION_ID = process.env.PAYMENT_HUB_INTEGRATION_ID ?? 'mirzabot-test';
const SECRET = process.env.PAYMENT_HUB_HMAC_SECRET;
const INGEST_URL = process.env.STAGING_INGEST_URL;
const SMS_KEY = process.env.STAGING_SMS_API_KEY;

if (!SECRET || !INGEST_URL || !SMS_KEY) {
  console.error('Missing env. Run: source .staging-test.env');
  process.exit(1);
}

// پارسیان2 - پویان — clean in prior boundary run (hint 20101347595604).
const CARD = '6221061244863090';
const ACCOUNT_HINT = '20101347595604';
const AMOUNT_TOMAN = 193_000;
const AMOUNT_IRR = AMOUNT_TOMAN * 10;

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256Hex(secret, data) {
  return createHmac('sha256', secret).update(data).digest('hex');
}

async function signedClaim(body) {
  const rawBody = JSON.stringify(body);
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyHash = sha256Hex(rawBody);
  const payload = `${ts}\nPOST\n${CLAIMS_PATH}\n${bodyHash}`;
  const signature = `sha256=${hmacSha256Hex(SECRET, payload)}`;

  const res = await fetch(CLAIMS_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Integration-Id': INTEGRATION_ID,
      'X-Event-Id': body.eventId,
      'X-Timestamp': ts,
      'X-Signature': signature,
    },
    body: rawBody,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`claim POST ${res.status}: ${JSON.stringify(json)}`);
  }
  return json;
}

async function injectSms(bankTs) {
  const message = [ACCOUNT_HINT, `${AMOUNT_IRR.toLocaleString('en-US')}+`, 'مانده:40,913,550', '1405/05/14 18:01'].join('\n');
  const checksum = sha256Hex(message + bankTs).slice(0, 32);
  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      apiKey: SMS_KEY,
      deviceId: process.env.STAGING_SMS_DEVICE_CODE ?? 'mirzabot-test-sms',
      deviceName: 'Ambiguous-claims acceptance',
      message,
      sender: 'TEST-INJECT',
      timestamp: String(bankTs),
      checksum,
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`SMS ingest ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

function claimBody(orderId, paidClickedAt, receiptSubmittedAt) {
  return {
    eventId: `evt-acc-${randomUUID()}`,
    source: 'MIRZABOT',
    orderId,
    telegramUserId: '7137494513',
    telegramUsername: 'Issumaa',
    amountToman: AMOUNT_TOMAN,
    expectedAmountIrr: AMOUNT_IRR,
    cardNumber: CARD,
    paidClickedAt,
    receiptSubmittedAt,
    receipt: { telegramFileUniqueId: `file-${orderId}` },
  };
}

async function main() {
  const T = Date.now();
  const orderA = `acc-ambig-a-${randomUUID().slice(0, 8)}`;
  const orderB = `acc-ambig-b-${randomUUID().slice(0, 8)}`;
  const paidA = T;
  const paidB = T + 10_000;
  const bankTs = T + 20_000;

  console.log('=== Ambiguous claims acceptance (staging) ===');
  console.log('card         :', CARD);
  console.log('account_hint :', ACCOUNT_HINT);
  console.log('claim A      :', orderA, 'paidClickedAt', paidA);
  console.log('claim B      :', orderB, 'paidClickedAt', paidB);
  console.log('bank SMS     :', bankTs, '(Δ+20s from A, +10s from B)');
  console.log();

  const bodyA = claimBody(orderA, paidA, paidA + 1500);
  const bodyB = claimBody(orderB, paidB, paidB + 1500);

  const resA = await signedClaim(bodyA);
  console.log('claim A response:', JSON.stringify(resA));
  const resB = await signedClaim(bodyB);
  console.log('claim B response:', JSON.stringify(resB));

  if (resA.autoVerified || resB.autoVerified) {
    console.error('FAIL: a claim auto-verified before SMS — aborting');
    process.exit(1);
  }

  const sms = await injectSms(bankTs);
  console.log('SMS ingest    :', JSON.stringify(sms));
  console.log();

  // Give matching a moment to settle.
  await new Promise((r) => setTimeout(r, 3000));

  const extA = `mirzabot:test:${orderA}`;
  const extB = `mirzabot:test:${orderB}`;

  // Query via dashboard preview if available, else print order ids for manual check.
  const preview = process.env.ACCEPTANCE_PREVIEW_URL ?? 'http://localhost:8787';
  const payments = await fetch(`${preview}/api/v1/payments?tab=needs_review`).then((r) => r.json());

  const itemA = payments.items?.find((i) => i.orderId === orderA);
  const itemB = payments.items?.find((i) => i.orderId === orderB);

  console.log('=== Results (needs_review tab) ===');
  for (const [label, item, ext] of [
    ['A', itemA, extA],
    ['B', itemB, extB],
  ]) {
    if (!item) {
      console.log(`claim ${label} (${orderA}/${orderB}): NOT in needs_review`);
      continue;
    }
    console.log(`claim ${label}:`);
    console.log('  reviewState  :', item.reviewState);
    console.log('  suspectReason:', item.suspectReason);
    console.log('  candidates   :', item.candidates?.length ?? 0);
    if (item.matchedTransaction) console.log('  matched tx   : YES (unexpected)');
  }

  const pass =
    itemA?.suspectReason === 'AMBIGUOUS_CLAIMS' &&
    itemB?.suspectReason === 'AMBIGUOUS_CLAIMS' &&
    !itemA?.matchedTransaction &&
    !itemB?.matchedTransaction;

  console.log();
  console.log(pass ? 'PASS: both claims AMBIGUOUS_CLAIMS, no auto-match' : 'CHECK: verify D1 / dashboard manually');
  console.log('orderIds:', orderA, orderB);

  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
