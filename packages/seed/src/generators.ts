/**
 * Deterministic generator for the spec's seed counts:
 *   - 6 devices
 *   - 36 financial_accounts (6 per device × 6 devices)
 *   - 600 raw_sms_events
 *     - 25 OTP, 25 PROMOTIONAL, 30 BANK_DEBIT, 30 AMBIGUOUS_CURRENCY,
 *       40 duplicates, 20 malformed, 10 parser failures
 *     - remainder: BANK_CREDIT / BANK_BALANCE
 *   - 350 payment_claims (some matched, some unmatched, 10 FAKE_RECEIPT)
 *   - 250 reconciliation_matches
 *     - SUGGESTED / NEEDS_REVIEW / CONFIRMED / REJECTED mix
 *   - 30 unmatched transactions (no claim)
 *
 * Numbers add up to 600:
 *   25 (OTP) + 25 (promo) + 30 (debit) + 30 (ambiguous) + 460 credit/balance
 *   = 570 transactions + 25 OTP + 25 promo (redacted) = 600 events
 *   - 40 of the 600 are duplicates (deduped by fingerprint, do not create new tx)
 *   - 20 of the 600 are malformed (parser_status=WARN or ERROR)
 *   - 10 of those 20 are parser failures (ERROR)
 */
import { normalizeText, parseSms } from '@shikoo/sms-parser';
import { MIRZABOT_SOURCE, tokenPrefix } from '@shikoo/contracts';
import { scoreMatch } from '@shikoo/domain';
import type { D1Database } from '@shikoo/database';
import { rng, pick, randInt } from './rng.js';

const BANKS = ['Melli', 'Tejarat', 'Saderat', 'Pasargad', 'Sepah', 'Eghtesad'] as const;

interface Device {
  id: string;
  code: string;
  display_name: string;
}

interface Account {
  id: string;
  device_id: string;
  bank_name: string;
  display_name: string;
  card_last_four: string;
  account_last_four: string;
}

async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function id(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Date.now();
}

function buildCreditBody(
  amount: number,
  cardLastFour: string,
  balance: number,
  ambiguous: boolean,
): string {
  if (ambiguous) {
    // mixed currency keywords → AMBIGUOUS_CURRENCY
    return `مبلغ ${amount.toLocaleString('en-US')} ریال (${amount.toLocaleString('en-US')} تومان) به کارت *${cardLastFour} واریز شد. مانده ${(balance * 10).toLocaleString('en-US')} ریال`;
  }
  return `مبلغ ${amount.toLocaleString('en-US')} ریال به کارت *${cardLastFour} واریز شد. مانده ${balance.toLocaleString('en-US')} ریال`;
}

function buildDebitBody(amount: number, cardLastFour: string, balance: number): string {
  return `برداشت ${amount.toLocaleString('en-US')} ریال از کارت *${cardLastFour}. مانده ${balance.toLocaleString('en-US')} ریال`;
}

function buildBalanceBody(cardLastFour: string, balance: number): string {
  // balance-only (no amount)
  return `مانده حساب کارت *${cardLastFour} : ${balance.toLocaleString('en-US')} ریال`;
}

function buildOtpBody(code: number): string {
  return `کد تایید: ${code} - هرگز با کسی به اشتراک نگذارید`;
}

function buildPromoBody(bank: string): string {
  return `${bank}: اپلیکیشن ما را نصب کنید و 10,000 تومان جایزه بگیرید. https://example.com/promo`;
}

export interface SeedResult {
  devices: number;
  accounts: number;
  rawSmsEvents: number;
  transactionCandidates: number;
  paymentClaims: number;
  reconciliationMatches: number;
  fakeReceipts: number;
  duplicates: number;
  parserErrors: number;
}

function luhnOk(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * A 16-digit card that ends in the account's `card_last_four` (so the parser's
 * account hint still resolves) and passes Luhn.
 *
 * Luhn matters even in a fixture: a card number that could not exist is a fake
 * that would hide a real check. `index` guarantees uniqueness — `card_last_four`
 * is drawn at random and 36 draws collide often enough — and one free digit is
 * brute-forced to make the checksum come out.
 */
function fixtureCardDigits(index: number, lastFour: string): string {
  const body = String(index).padStart(7, '0');
  for (let filler = 0; filler <= 9; filler++) {
    const candidate = `6037${body}${filler}${lastFour}`;
    if (luhnOk(candidate)) return candidate;
  }
  // Unreachable: changing one digit walks the checksum through all ten residues.
  throw new Error(`no Luhn-valid card for index ${index}`);
}

export async function seed(db: D1Database, opts: { verbose?: boolean } = {}): Promise<SeedResult> {
  const seedNum = 20260804;
  const rand = rng(seedNum);

  // 1) Devices (6)
  const devices: Device[] = [];
  for (let i = 0; i < 6; i++) {
    const d: Device = {
      id: id(),
      code: `phone-${String.fromCharCode(0x41 + i).toLowerCase()}`,
      display_name: `Test Phone ${i + 1}`,
    };
    devices.push(d);
  }
  const t0 = now();
  for (const d of devices) {
    await db
      .prepare(
        `INSERT INTO devices (id, device_code, display_name, description, active, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, 1, ?4, ?4)`,
      )
      .bind(d.id, d.code, d.display_name, t0)
      .run();
    // The key a manual smoke test presents. Two things must hold, and neither
    // did before 2026-08-14:
    //   - the prefix comes from `tokenPrefix`, because ingest looks the
    //     credential up by `apiKey.slice(0, 4)` on equality. The old
    //     hand-written `tok-pho` was seven characters, so no seeded device
    //     could authenticate at all.
    //   - the key is shaped like a real one (64 hex, `generateApiToken`), so
    //     the six devices get six different prefixes. A literal
    //     `token-phone-a-…` gives all of them `toke`.
    // Every ingest test mints its own credential, which is why neither showed.
    // Derivation is in `sim/README.md` so a smoke test can recompute the key.
    const apiKey = await sha256(`seed-apikey-${d.code}-${seedNum}`);
    await db
      .prepare(
        `INSERT INTO device_credentials (id, device_id, token_hash, token_prefix, status, created_at, activated_at) VALUES (?1, ?2, ?3, ?4, 'ACTIVE', ?5, ?5)`,
      )
      .bind(id(), d.id, await sha256(apiKey), tokenPrefix(apiKey), t0)
      .run();
  }

  // 2) Financial accounts (36 — 6 banks × 6 devices)
  const accounts: Account[] = [];
  for (const d of devices) {
    for (const bank of BANKS) {
      const cardLastFour = String(randInt(rand, 1000, 9999));
      const accountLastFour = String(randInt(rand, 1000, 9999));
      const a: Account = {
        id: id(),
        device_id: d.id,
        bank_name: bank,
        display_name: `${bank} ${d.display_name}`,
        card_last_four: cardLastFour,
        account_last_four: accountLastFour,
      };
      accounts.push(a);
      await db
        .prepare(
          `INSERT INTO financial_accounts (id, bank_name, display_name, owner_label, account_type, account_hint, card_last_four, account_last_four, device_id, active, parser_configuration, created_at, updated_at)
           VALUES (?1, ?2, ?3, NULL, 'CARD', ?4, ?5, ?6, ?7, 1, ?8, ?9, ?9)`,
        )
        .bind(
          a.id,
          a.bank_name,
          a.display_name,
          cardLastFour,
          cardLastFour,
          accountLastFour,
          a.device_id,
          '{}',
          t0,
        )
        .run();
    }
  }

  // 2a) One payment card per card account. Card-to-card verification resolves
  //     the card the customer paid into back to an account through this table;
  //     with it empty, every claim decides UNMAPPED_CARD and nothing can ever
  //     auto-verify. The seed made none, so that path was untestable.
  for (const [i, a] of accounts.entries()) {
    await db
      .prepare(
        `INSERT INTO payment_cards (id, financial_account_id, card_digits, label, holder_name, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, 'ACTIVE', ?6)`,
      )
      .bind(id(), a.id, fixtureCardDigits(i, a.card_last_four), a.display_name, 'تست شیکو', t0)
      .run();
  }

  // 2b) Spec-mandated accounts for the deterministic bank parsers. Each
  // account_hint is the exact token the parser emits, so the ingest path's
  // account_hint lookup resolves cleanly. Assign to phone-a / phone-b /
  // phone-c so real banks live on at least one device.
  const specAccounts: Array<{
    bank_name: string;
    display_name: string;
    account_hint: string;
    account_type: 'ACCOUNT' | 'IBAN' | 'OTHER';
    device_code: string;
  }> = [
    {
      bank_name: 'PARSIAN',
      display_name: 'پارسیان حساب ۱',
      account_hint: '30101883751600',
      account_type: 'ACCOUNT',
      device_code: 'phone-a',
    },
    {
      bank_name: 'PARSIAN',
      display_name: 'پارسیان حساب ۲',
      account_hint: '20101347595604',
      account_type: 'ACCOUNT',
      device_code: 'phone-b',
    },
    {
      bank_name: 'GARDESHGARI',
      display_name: 'گردشگری حساب ۱',
      account_hint: '110.9992.2377306.1',
      account_type: 'IBAN',
      device_code: 'phone-a',
    },
    {
      bank_name: 'GARDESHGARI',
      display_name: 'گردشگری حساب ۲',
      account_hint: '110.7007.2377306.1',
      account_type: 'IBAN',
      device_code: 'phone-b',
    },
    {
      bank_name: 'SHAHR',
      display_name: 'شهر حساب ۱',
      account_hint: '7001018246497',
      account_type: 'ACCOUNT',
      device_code: 'phone-a',
    },
    {
      bank_name: 'SHAHR',
      display_name: 'شهر حساب ۲',
      account_hint: '9001017429938',
      account_type: 'ACCOUNT',
      device_code: 'phone-b',
    },
    {
      bank_name: 'SHAHR',
      display_name: 'شهر حساب ۳',
      account_hint: '400788235261',
      account_type: 'ACCOUNT',
      device_code: 'phone-c',
    },
    {
      bank_name: 'UNKNOWN',
      display_name: 'Sam account',
      account_hint: '10.8206380.1',
      account_type: 'OTHER',
      device_code: 'phone-b',
    },
  ];
  for (const sa of specAccounts) {
    const dev = devices.find((d) => d.code === sa.device_code);
    if (!dev) continue;
    await db
      .prepare(
        `INSERT INTO financial_accounts (id, bank_name, display_name, owner_label, account_type, account_hint, card_last_four, account_last_four, device_id, active, parser_configuration, created_at, updated_at)
         VALUES (?1, ?2, ?3, NULL, ?4, ?5, NULL, NULL, ?6, 1, '{}', ?7, ?7)`,
      )
      .bind(id(), sa.bank_name, sa.display_name, sa.account_type, sa.account_hint, dev.id, t0)
      .run();
  }

  // 3) 600 raw_sms_events with the required distribution
  //    Layout:
  //      indices 0..24   (25) OTP
  //      indices 25..49  (25) PROMO
  //      indices 50..79  (30) DEBIT
  //      indices 80..109 (30) AMBIGUOUS (credit shape, both currency keywords)
  //      indices 110..559 (450) normal CREDIT/BALANCE
  //      40 of those are duplicates (random pick)
  //      20 are malformed (parser_status WARN or ERROR)
  //      10 are parser failures (subset of malformed)
  const smsRows: Array<{
    id: string;
    device_id: string;
    account: Account | null;
    sender: string;
    body: string;
    classification:
      | 'OTP'
      | 'PROMOTIONAL'
      | 'BANK_CREDIT'
      | 'BANK_DEBIT'
      | 'BALANCE'
      | 'UNKNOWN'
      | 'IGNORED';
    parserStatus: 'OK' | 'WARN' | 'ERROR';
    parserId: string | null;
    parserVersion: string | null;
    duplicateOfId: string | null;
    bankTimestamp: number;
    fingerprint: string;
    checksum: string;
  }> = [];

  let duplicateCount = 0,
    parserErrorCount = 0;

  // We'll create a pool of "anchor" bodies to dup from.
  const anchorIds: string[] = [];

  for (let i = 0; i < 600; i++) {
    const device = pick(rand, devices);
    let classification:
      | 'OTP'
      | 'PROMOTIONAL'
      | 'BANK_CREDIT'
      | 'BANK_DEBIT'
      | 'BALANCE'
      | 'UNKNOWN'
      | 'IGNORED';
    let parserStatus: 'OK' | 'WARN' | 'ERROR' = 'OK';
    let parserId: string | null = null;
    let parserVersion: string | null = null;
    let body: string;
    const account: Account | null = pick(
      rand,
      accounts.filter((a) => a.device_id === device.id),
    );
    const bankTimestamp = t0 - randInt(rand, 0, 30 * 24 * 60 * 60 * 1000);

    if (i < 25) {
      classification = 'OTP';
      body = buildOtpBody(randInt(rand, 100000, 999999));
      parserId = 'otp';
      parserVersion = '1.0.0';
    } else if (i < 50) {
      classification = 'PROMOTIONAL';
      body = buildPromoBody(pick(rand, BANKS));
      parserId = 'promo';
      parserVersion = '1.0.0';
    } else if (i < 80) {
      classification = 'BANK_DEBIT';
      const amount = randInt(rand, 10_000, 5_000_000);
      const balance = randInt(rand, 100_000, 100_000_000);
      body = buildDebitBody(amount, account!.card_last_four, balance);
      parserId = 'debit';
      parserVersion = '1.0.0';
    } else if (i < 110) {
      classification = 'BANK_CREDIT';
      const amount = randInt(rand, 10_000, 5_000_000);
      const balance = randInt(rand, 100_000, 100_000_000);
      body = buildCreditBody(amount, account!.card_last_four, balance, true);
      parserId = 'credit';
      parserVersion = '1.0.0';
      parserStatus = 'WARN';
    } else if (i < 560) {
      const isBalance = rand() < 0.1;
      const amount = randInt(rand, 10_000, 5_000_000);
      const balance = randInt(rand, 100_000, 100_000_000);
      if (isBalance) {
        classification = 'BALANCE';
        body = buildBalanceBody(account!.card_last_four, balance);
      } else {
        classification = 'BANK_CREDIT';
        body = buildCreditBody(amount, account!.card_last_four, balance, false);
      }
      parserId = isBalance ? 'balance' : 'credit';
      parserVersion = '1.0.0';
    } else {
      // 560..579: 20 malformed (WARN, parser doesn't match anything useful)
      // 590..599: 10 parser failures (ERROR)
      classification = 'IGNORED';
      body = `این یک پیام ناشناس است ${randInt(rand, 1000, 9999)} بدون الگوی بانکی`;
      parserId = 'unknown';
      parserVersion = '1.0.0';
      if (i < 580) {
        parserStatus = 'WARN';
      } else {
        parserStatus = 'ERROR';
        parserErrorCount++;
      }
    }

    const fingerprint = await sha256(
      `${device.id}|BANK|${bankTimestamp}|${normalizeText(body).text}`,
    );
    const checksum = await sha256(body + i);
    const rowId = id();

    // 4) Duplicate logic — after enough anchors exist, a few rows
    //    reuse a prior anchor's fingerprint → second occurrence.
    let duplicateOfId: string | null = null;
    if (
      anchorIds.length > 5 &&
      duplicateCount < 40 &&
      rand() < 0.08 &&
      classification !== 'OTP' &&
      classification !== 'PROMOTIONAL' &&
      classification !== 'IGNORED'
    ) {
      duplicateOfId = pick(rand, anchorIds);
      duplicateCount++;
    }
    if (
      classification !== 'OTP' &&
      classification !== 'PROMOTIONAL' &&
      classification !== 'IGNORED'
    ) {
      anchorIds.push(rowId);
    }
    smsRows.push({
      id: rowId,
      device_id: device.id,
      account,
      sender: 'BANK',
      body,
      classification,
      parserStatus,
      parserId,
      parserVersion,
      duplicateOfId,
      bankTimestamp,
      fingerprint,
      checksum,
    });
  }

  // 4) Persist raw_sms_events + transaction_candidates
  let transactionCount = 0;
  for (const r of smsRows) {
    const isRedactable = r.classification === 'OTP' || r.classification === 'PROMOTIONAL';
    const normText = normalizeText(r.body).text;
    await db
      .prepare(
        `INSERT INTO raw_sms_events (id, device_id, sender, encrypted_or_protected_body, normalized_body, body_sha256, app_checksum, sms_timestamp, received_at, classification, parser_status, parser_id, parser_version, duplicate_of, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)`,
      )
      .bind(
        r.id,
        r.device_id,
        r.sender,
        isRedactable ? '[redacted]' : null,
        isRedactable ? null : normText,
        r.fingerprint,
        r.checksum,
        r.bankTimestamp,
        now(),
        r.classification,
        r.parserStatus,
        isRedactable ? null : r.parserId,
        isRedactable ? null : r.parserVersion,
        r.duplicateOfId,
        now(),
      )
      .run();

    if (r.duplicateOfId) continue;

    // Run through the parser to derive the canonical amount/direction/bank_ts.
    const norm = normalizeText(r.body);
    const parsed = parseSms({
      ...norm,
      raw: r.body,
      sender: r.sender,
      timestamp: r.bankTimestamp,
      deviceId: r.device_id,
    });
    if (parsed.amountIrr === null && parsed.balanceIrr === null && parsed.direction === 'UNKNOWN')
      continue;

    const txId = id();
    await db
      .prepare(
        `INSERT INTO transaction_candidates (id, raw_sms_event_id, financial_account_id, direction, amount_irr, balance_irr, transaction_reference, bank_timestamp, confidence, parser_id, parser_version, parser_evidence_json, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)`,
      )
      .bind(
        txId,
        r.id,
        r.account?.id ?? null,
        parsed.direction,
        parsed.amountIrr,
        parsed.balanceIrr,
        parsed.transactionReference,
        r.bankTimestamp,
        parsed.confidence,
        parsed.parserId ?? 'unknown',
        parsed.parserVersion ?? '1.0.0',
        JSON.stringify(parsed.evidence),
        parsed.warnings.includes('AMBIGUOUS_CURRENCY') ? 'NEEDS_REVIEW' : 'PARSED',
        now(),
      )
      .run();
    transactionCount++;
  }

  // 5) 350 payment_claims. Most of the claims link to a transaction.
  //    10 claims are FAKE_RECEIPT (rejected after admin review).
  //    ~30 claims are unmatched (no matching transaction exists).
  const claimRows: Array<{
    id: string;
    account: Account | null;
    amount: number;
    ts: number;
    status: 'PENDING' | 'MATCH_SUGGESTED' | 'VERIFIED' | 'REJECTED' | 'FAKE_RECEIPT';
    submitted_at: number;
  }> = [];
  for (let i = 0; i < 350; i++) {
    const a = pick(rand, accounts);
    const amount = randInt(rand, 10_000, 5_000_000);
    const ts = t0 - randInt(rand, 0, 30 * 24 * 60 * 60 * 1000);
    let status: 'PENDING' | 'MATCH_SUGGESTED' | 'VERIFIED' | 'REJECTED' | 'FAKE_RECEIPT' =
      'PENDING';
    if (i >= 340) status = 'FAKE_RECEIPT';
    claimRows.push({ id: id(), account: a, amount, ts, status, submitted_at: ts });
  }
  for (const c of claimRows) {
    await db
      .prepare(
        `INSERT INTO payment_claims (id, external_order_id, customer_reference, expected_amount_irr, target_financial_account_id, submitted_at, receipt_url_or_r2_key, source_system, metadata_json, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?11)`,
      )
      .bind(
        c.id,
        `order-${c.id.slice(0, 8)}`,
        null,
        c.amount,
        c.account?.id ?? null,
        c.ts,
        null,
        // Every claim in this hub is a card-to-card claim. `source_system` names
        // that protocol, not the bot that opened it — every review query, the
        // auto-verify engine and `matching.ts`'s exclusion all key off this
        // value. Writing 'manual' here made the whole Payments screen render
        // zero rows in the simulation environment.
        MIRZABOT_SOURCE,
        '{}',
        c.status,
        c.ts,
      )
      .run();
  }

/** Match statuses that consume their transaction and claim for good. */
const SETTLING_STATUSES = new Set(['CONFIRMED', 'AUTO_VERIFIED']);

  // 6) 250 reconciliation_matches. We pick the first 250 transactions by
  //    bank_timestamp and try to score them against open claims for the
  //    same account. Strong matches → SUGGESTED, weaker → NEEDS_REVIEW,
  //    some are CONFIRMED / REJECTED.
  const txs = await db
    .prepare(
      `SELECT id, financial_account_id, direction, amount_irr, bank_timestamp FROM transaction_candidates WHERE amount_irr IS NOT NULL ORDER BY bank_timestamp DESC LIMIT 250`,
    )
    .all<{
      id: string;
      financial_account_id: string | null;
      direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
      amount_irr: number;
      bank_timestamp: number;
    }>();

  let matchCount = 0;
  let confirmedCount = 0,
    rejectedCount = 0;
  /** Claims already consumed by a CONFIRMED / AUTO_VERIFIED match. */
  const settledClaims = new Set<string>();
  for (const tx of txs.results) {
    if (matchCount >= 250) break;
    if (!tx.financial_account_id) continue;
    const claimRows = await db
      .prepare(
        `SELECT * FROM payment_claims WHERE target_financial_account_id = ?1 AND status IN ('PENDING','MATCH_SUGGESTED') ORDER BY submitted_at DESC LIMIT 5`,
      )
      .bind(tx.financial_account_id)
      .all<{
        id: string;
        target_financial_account_id: string | null;
        expected_amount_irr: number;
        submitted_at: number;
        status: string;
      }>();
    if (!claimRows.results.length) continue;
    const accountRow = await db
      .prepare(`SELECT * FROM financial_accounts WHERE id = ?1`)
      .bind(tx.financial_account_id)
      .first<{
        id: string;
        bank_name: string;
        display_name: string;
        owner_label: string | null;
        account_type: string;
        account_hint: string | null;
        card_last_four: string | null;
        account_last_four: string | null;
        device_id: string | null;
        active: number;
        parser_configuration: string;
        created_at: number;
        updated_at: number;
      }>();

    let bestScore = 0;
    let bestClaimId: string | null = null;
    let bestReasons: { matching: string[]; mismatching: string[] } | null = null;
    for (const claim of claimRows.results) {
      const breakdown = scoreMatch(
        {
          amount_irr: tx.amount_irr,
          direction: tx.direction,
          financial_account_id: tx.financial_account_id,
          transaction_reference: null,
          bank_timestamp: tx.bank_timestamp,
        },
        claim as never,
        accountRow,
      );
      if (breakdown.score > bestScore) {
        bestScore = breakdown.score;
        bestClaimId = claim.id;
        bestReasons = { matching: breakdown.matching, mismatching: breakdown.mismatching };
      }
    }
    if (!bestClaimId || !bestReasons) continue;

    let status: 'SUGGESTED' | 'CONFIRMED' | 'REJECTED' | 'AUTO_VERIFIED';
    const ratio = bestScore;
    if (ratio >= 0.85) status = 'SUGGESTED';
    else if (ratio >= 0.55) status = 'AUTO_VERIFIED';
    else status = 'AUTO_VERIFIED';

    if (matchCount % 7 === 0 && confirmedCount < 60) status = 'CONFIRMED';
    if (matchCount % 11 === 0 && rejectedCount < 30) status = 'REJECTED';

    // Several transactions on one account can pick the same best claim — the
    // search above has no memory. A second settling match on that claim
    // violates `idx_match_one_auto_per_claim`, so it is demoted to a
    // suggestion, which is what an unsettled candidate actually is.
    //
    // This went unnoticed because the seed tests applied migrations
    // 0001-0006, 0010 and 0012 but not 0011 — the one that creates the
    // money-invariant indexes. The generator was therefore only ever exercised
    // against a schema that could not reject it.
    if (SETTLING_STATUSES.has(status) && settledClaims.has(bestClaimId)) {
      status = 'SUGGESTED';
    }
    if (SETTLING_STATUSES.has(status)) settledClaims.add(bestClaimId);

    const mId = id();
    const ts = now();
    await db
      .prepare(
        `INSERT INTO reconciliation_matches (id, transaction_candidate_id, payment_claim_id, score, matching_reasons_json, mismatch_reasons_json, status, reviewed_by, reviewed_at, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)`,
      )
      .bind(
        mId,
        tx.id,
        bestClaimId,
        ratio,
        JSON.stringify(bestReasons.matching),
        JSON.stringify(bestReasons.mismatching),
        status,
        status === 'CONFIRMED' || status === 'REJECTED' ? 'admin@example.com' : null,
        status === 'CONFIRMED' || status === 'REJECTED' ? ts : null,
        ts,
      )
      .run();

    // Mirror statuses onto the transaction + claim so the dashboard reflects
    // the match.
    const txStatus: 'APPROVED' | 'NEEDS_REVIEW' | 'PARSED' =
      status === 'CONFIRMED' ? 'APPROVED' : status === 'AUTO_VERIFIED' ? 'NEEDS_REVIEW' : 'PARSED';
    await db
      .prepare(`UPDATE transaction_candidates SET status = ?2, updated_at = ?3 WHERE id = ?1`)
      .bind(tx.id, txStatus, ts)
      .run();
    if (status === 'CONFIRMED') {
      await db
        .prepare(`UPDATE payment_claims SET status = 'VERIFIED', updated_at = ?2 WHERE id = ?1`)
        .bind(bestClaimId, ts)
        .run();
      confirmedCount++;
    } else if (status === 'REJECTED') {
      await db
        .prepare(`UPDATE payment_claims SET status = 'REJECTED', updated_at = ?2 WHERE id = ?1`)
        .bind(bestClaimId, ts)
        .run();
      rejectedCount++;
    } else if (status === 'SUGGESTED') {
      await db
        .prepare(
          `UPDATE payment_claims SET status = 'MATCH_SUGGESTED', updated_at = ?2 WHERE id = ?1`,
        )
        .bind(bestClaimId, ts)
        .run();
    }
    matchCount++;
  }

  const result: SeedResult = {
    devices: devices.length,
    accounts: accounts.length,
    rawSmsEvents: smsRows.length,
    transactionCandidates: transactionCount,
    paymentClaims: claimRows.length,
    reconciliationMatches: matchCount,
    fakeReceipts: claimRows.filter((c) => c.status === 'FAKE_RECEIPT').length,
    duplicates: duplicateCount,
    parserErrors: parserErrorCount,
  };
  if (opts.verbose) {
    console.log('seed:', result);
  }
  return result;
}
