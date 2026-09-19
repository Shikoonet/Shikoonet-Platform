/**
 * Ingest core: validate, classify, persist, parse, suggest match.
 *
 * Returned values are typed for the route handler. Errors here are
 * structured — the route layer maps them to status codes.
 */

import { compilePatterns, normalizeText, parseSms, redactOtp } from '@shikoo/sms-parser';
import {
  resolveAccountByHint,
  suggestMatchesForTransaction,
  loadBankSmsPatterns,
  createLogger,
  persistTransaction,
  shouldCreateTransaction,
  findRedelivery,
} from '@shikoo/domain';

const log = createLogger('ingest');
import { SQL, type D1Database } from '@shikoo/database';
import type {
  Classification,
  IncomingSmsBody,
  NormalizedSms,
  ParseResult,
} from '@shikoo/contracts';
import { authenticateDevice } from './auth.js';
import { markIngested } from './devices.js';
import { bodyFingerprint, bodyOnlyHash } from './dedupe.js';
import { recordAudit } from './audit.js';
import {
  rematchMirzabotClaimsForCreditTx,
  type MirzabotMatchOpts,
} from './integrations/mirzabot.js';


export interface IngestOk {
  ok: true;
  eventId: string;
  duplicate: boolean;
  status: 'received' | 'already_received' | 'outgoing_ignored' | 'direction_uncertain';
  /** Credit-only product rule: true when this SMS entered the actionable workflow. */
  actionable: boolean;
  /**
   * Set when an SMS was received but excluded from the actionable product
   * flow. Both DEBIT and UNKNOWN SMS are excluded — the raw event is
   * persisted for audit, but no transaction_candidate row is created.
   */
  reason?: 'OUTGOING_TRANSACTION_IGNORED' | 'DIRECTION_UNCERTAIN_IGNORED' | undefined;
  /** Mirror of `accepted` for client convenience (always true when ok). */
  accepted?: boolean;
}

export interface IngestErr {
  ok: false;
  error: string;
  code: 'UNAUTHORIZED' | 'INTERNAL';
}

export type IngestResult = IngestOk | IngestErr;

export interface IngestOptions {
  mirzabot?: MirzabotMatchOpts;
}

const REDACTED_BODY = '[redacted]';

export async function ingest(
  db: D1Database,
  raw: IncomingSmsBody,
  options?: IngestOptions,
): Promise<IngestResult> {
  const auth = await authenticateDevice(db, raw.deviceId, raw.apiKey);
  if (!auth.ok) {
    // generic 401 — do not log the raw apiKey
    return { ok: false, error: 'unauthorized', code: 'UNAUTHORIZED' };
  }

  const device = auth.device;
  const credential = auth.credential;

  // Normalize first so dedupe is whitespace-stable.
  const normalized = normalizeText(raw.message);
  const normalizedBody = normalized.text;
  const smsTimestamp = Number.parseInt(raw.timestamp, 10);
  if (!Number.isFinite(smsTimestamp)) {
    return { ok: false, error: 'bad_timestamp', code: 'INTERNAL' };
  }

  const fingerprint = await bodyFingerprint({
    deviceId: device.id,
    sender: raw.sender,
    timestamp: smsTimestamp,
    normalizedBody,
  });

  // Try to find an existing event with the same fingerprint.
  const existing =
    (await db
      .prepare(SQL.findRawSmsByFingerprint)
      .bind(device.id, fingerprint)
      .first<{ id: string; duplicate_of: string | null }>()) ?? null;

  if (existing) {
    // Duplicate path — successful auth already bumped last_seen_at and
    // refreshed display_name; do NOT bump last_success_at (per spec).
    return {
      ok: true,
      accepted: true,
      actionable: true,
      eventId: existing.id,
      duplicate: true,
      status: 'already_received',
    };
  }

  const sms: NormalizedSms = {
    raw: raw.message,
    text: normalizedBody,
    sender: raw.sender,
    timestamp: smsTimestamp,
    deviceId: device.id,
  };
  // Operator-editable bank patterns. They are strictly additive — they never
  // run where a built-in named the bank, never replace an amount a built-in
  // extracted, and never see an OTP (see registry.ts). A pattern that no longer
  // compiles is skipped and reported rather than taking every bank SMS down
  // with it; the id is safe to log, the body is not.
  const { parsers, skipped } = compilePatterns(await loadBankSmsPatterns(db));
  for (const s of skipped) {
    log.warn('sms.pattern_skipped', { ref: s.id, problems: s.problems.join('; ') });
  }
  const result = parseSms(sms, parsers);

  const eventId = crypto.randomUUID();
  const created = Date.now();
  const classification: Classification = result.classification;
  const isRedactable =
    classification === 'OTP' || classification === 'PROMOTIONAL' || classification === 'IGNORED';

  // ---------------------------------------------------------------------
  // Defence in depth: the body we are about to store, scrubbed of anything
  // that looks like a one-time password.
  //
  // The classifier above is the first line and it is precise, which means it
  // can be wrong in the direction that matters. `کد یکبار مصرف` matched
  // nothing until 2026-08-27, fell through to UNKNOWN, and UNKNOWN is not
  // redactable — so the code went into `normalized_body`. One phrasing the
  // vocabulary had not met was enough to break the guarantee at
  // `docs/threat-model.md:106`.
  //
  // A vocabulary is a list, and a list is never finished. So the storage
  // boundary asks its own question, with its own tolerance: `redactOtp` is
  // eager where the classifier is precise, because its false positive costs
  // one scrubbed number in a body nothing reads for money, and its false
  // negative is a password in a database.
  //
  // The digits go and the SENTENCE STAYS. `normalized_body` is what an
  // operator reads on «رویدادها» when a bank SMS did not parse, and it is how
  // the next `bank_sms_patterns` row gets written — blanking it would make
  // every unrecognised message mentioning a code permanently unparseable, and
  // the shop would lose payments to protect a number.
  //
  // Runs only when the message was NOT already classified redactable: those
  // store `[redacted]` and a NULL body, so there is nothing left to scrub.
  const scrubbed = isRedactable ? null : redactOtp(normalizedBody);
  if (scrubbed !== null && scrubbed.redacted > 0) {
    // The COUNT, never the value, and never the body it came out of. That an
    // OTP reached this point at all means the classifier missed a phrasing,
    // which is worth an operator seeing — `classification` names what it was
    // read as instead, so the next vocabulary entry can be written.
    log.warn('sms.otp_scrubbed_before_persist', {
      ref: eventId,
      classification,
      occurrences: scrubbed.redacted,
    });
  }
  const bodyToStore = scrubbed === null ? null : scrubbed.text;

  // Persist raw event. INSERT OR IGNORE on (device_id, body_sha256) defends
  // against a race between two concurrent retries.
  await db
    .prepare(
      `INSERT OR IGNORE INTO raw_sms_events
        (id, device_id, sender, encrypted_or_protected_body, normalized_body, body_sha256, app_checksum,
         sms_timestamp, received_at, classification, parser_status, parser_id, parser_version, duplicate_of, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, NULL, ?14)`,
    )
    .bind(
      eventId,
      device.id,
      raw.sender,
      isRedactable ? REDACTED_BODY : null,
      // `bodyToStore`, not `normalizedBody`: see the scrubbing block above.
      // The fingerprint below is still computed over the ORIGINAL text, so
      // dedupe is unaffected — a sha256 is not reversible and two deliveries
      // of one message still collide.
      bodyToStore,
      fingerprint,
      raw.checksum,
      smsTimestamp,
      created,
      classification,
      isRedactable ? 'OK' : resultMatched(result),
      isRedactable ? null : (result.parserId ?? null),
      isRedactable ? null : (result.parserVersion ?? null),
      created,
    )
    .run();

  // Re-read to handle the OR IGNORE race: if another retry inserted first,
  // return that row.
  const winner =
    (await db
      .prepare(SQL.findRawSmsByFingerprint)
      .bind(device.id, fingerprint)
      .first<{ id: string; duplicate_of: string | null }>()) ?? null;
  const finalEventId = winner?.id ?? eventId;
  let wasDuplicate = winner?.id !== eventId;

  // The bank's own clock, when the parser read one off the text, is when the
  // money moved; the phone's timestamp is only when the text arrived. On
  // 2026-09-18 Melli delivered a 20:35 deposit at 21:13, and «دفتر بانک»,
  // ordering by arrival, took that older balance as the newest one and opened
  // the books 150,000 toman short. The parsers already fall back to the phone
  // when the two disagree by more than two days; the same fence here covers
  // the parsers that do not.
  const bankTimestamp = bankClockOf(result, smsTimestamp);

  // A bank sometimes sends one text twice, minutes apart (Melli, the same
  // night: 20:46 and 21:12, byte-identical down to «0627-20:45»). The
  // fingerprint is per delivery — it carries the phone's timestamp — so the
  // second copy is a new raw event and is kept as one; but it must not become
  // a second transaction. An identical balance means the money moved once,
  // and a second CREDIT row of the same amount could verify a second claim.
  // `duplicate_of` has existed since 0004 for exactly this and was never set.
  if (!wasDuplicate && !isRedactable && result.balanceIrr !== null) {
    const first = await findRedelivery(db, device.id, raw.sender, bodyToStore, eventId, smsTimestamp);
    if (first) {
      await db
        .prepare(`UPDATE raw_sms_events SET duplicate_of = ?1 WHERE id = ?2`)
        .bind(first.id, eventId)
        .run();
      wasDuplicate = true;
    }
  }

  // Only run the parser side-effects on the winning insert.
  //
  // CREDIT-only product rule: only `direction === 'CREDIT'` is actionable.
  // UNKNOWN (direction uncertain) short-circuits before persistTransaction:
  // the raw SMS is persisted above for audit and nothing else happens. DEBIT
  // is persisted as a row (below) and skips the matching side-effects.
  const isOutgoingTransaction = !wasDuplicate && !isRedactable && result.direction === 'DEBIT';
  const isDirectionUncertain = !wasDuplicate && !isRedactable && result.direction === 'UNKNOWN';
  const skipSideEffects = isOutgoingTransaction || isDirectionUncertain;

  // A withdrawal is recorded (0073) — balance, account, disposition
  // OUTGOING_IGNORED — and then left alone: no matching, no suggestion, no
  // claim rematch. The phone still hears `outgoing_ignored`; its contract is
  // frozen and «do not retry» is still the right answer.
  if (isOutgoingTransaction) {
    await persistTransaction(db, finalEventId, bankTimestamp, result, normalizedBody);
  }
  if (!wasDuplicate && !isRedactable && !skipSideEffects) {
    const txRow = await persistTransaction(db, finalEventId, bankTimestamp, result, normalizedBody);
    if (txRow) {
      // Mirzabot claims are decided by their own matcher (paid_clicked_at ±5m,
      // strict 1↔1); suggestMatchesForTransaction skips them by source_system.
      if (options?.mirzabot) {
        await rematchMirzabotClaimsForCreditTx(db, txRow, options.mirzabot);
      }
      await suggestMatchesForTransaction(db, { tx: txRow });
      // Surface AMBIGUOUS resolution via audit log if the hint resolved to
      // more than one active account — never silently pick one.
      if (result.accountHint && txRow.financial_account_id === null) {
        const r = await resolveAccountByHint(db, result.accountHint);
        if (r.status === 'ACCOUNT_IDENTIFIER_AMBIGUOUS') {
          await recordAudit(db, {
            actorEmail: null,
            actorRole: 'SYSTEM',
            action: 'account.identifier_ambiguous',
            entityType: 'TRANSACTION',
            entityId: txRow.id,
            before: null,
            after: { hint: result.accountHint, matches: r.matches },
          });
        }
      }
    }
  }

  // last_success_at advances only on the new-ingestion path (not the duplicate
  // idempotency path) per spec.
  if (!wasDuplicate) {
    await markIngested(db, device.id, credential.id);
  }

  // A text no named parser read: a generic parser guessed at it, or nothing
  // made a row of what is not an OTP or an advert. Counted, never quoted — the
  // body stays in `raw_sms_events`, where «بانک‌ها › پیامک‌های بی‌پارسر» lists it
  // by shape. This line is what makes a new bank, or a new withdrawal shape
  // from an old one, visible the day it arrives instead of from the ledger a
  // week later (Keshavarzi, 2026-09-19).
  if (!wasDuplicate && !isRedactable) {
    const parserId = result.parserId ?? null;
    const generic = parserId !== null && parserId.startsWith('generic-');
    const madeRow = shouldCreateTransaction(result);
    if (generic || !madeRow) {
      log.warn('sms.needs_parser', {
        ref: finalEventId,
        sender: raw.sender,
        parserId,
        classification,
        madeRow,
      });
    }
  }

  await recordAudit(db, {
    actorEmail: null,
    actorRole: 'SYSTEM',
    action: isOutgoingTransaction
      ? 'sms.outgoing_ignored'
      : isDirectionUncertain
        ? 'sms.direction_uncertain'
        : wasDuplicate
          ? 'sms.duplicate'
          : 'sms.received',
    entityType: 'RAW_SMS',
    entityId: finalEventId,
    before: null,
    after: {
      classification,
      parserId: isRedactable ? null : (result.parserId ?? null),
      parserWarnings: isRedactable ? [] : result.warnings,
      deviceCode: device.device_code,
      direction: skipSideEffects ? result.direction : undefined,
    },
  });

  void bodyOnlyHash;

  return {
    ok: true,
    accepted: true,
    actionable: !skipSideEffects,
    eventId: finalEventId,
    duplicate: wasDuplicate,
    status: isOutgoingTransaction
      ? 'outgoing_ignored'
      : isDirectionUncertain
        ? 'direction_uncertain'
        : wasDuplicate
          ? 'already_received'
          : 'received',
    ...(isOutgoingTransaction
      ? { reason: 'OUTGOING_TRANSACTION_IGNORED' as const }
      : isDirectionUncertain
        ? { reason: 'DIRECTION_UNCERTAIN_IGNORED' as const }
        : {}),
  };
}

const BANK_CLOCK_MAX_DRIFT_MS = 2 * 86_400_000;

/** The bank's own time from the text when the parser found one and it is sane; else the phone's. */
function bankClockOf(r: ParseResult, smsTimestamp: number): number {
  const fromText = r.evidence['bankTimestamp'];
  if (typeof fromText !== 'number' || !Number.isFinite(fromText)) return smsTimestamp;
  return Math.abs(fromText - smsTimestamp) > BANK_CLOCK_MAX_DRIFT_MS ? smsTimestamp : fromText;
}

function resultMatched(r: ParseResult): 'OK' | 'WARN' | 'ERROR' {
  if (r.matched) return 'OK';
  if (r.warnings.length > 0) return 'WARN';
  return 'ERROR';
}

