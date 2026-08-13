/**
 * Ingest core: validate, classify, persist, parse, suggest match.
 *
 * Returned values are typed for the route handler. Errors here are
 * structured — the route layer maps them to status codes.
 */

import { compilePatterns, normalizeText, parseSms } from '@shikoo/sms-parser';
import {
  resolveAccountByHint,
  suggestMatchesForTransaction,
  persistDetectedIdentifiers,
  resolveDetectedIdentifiers,
  assignAccountForTx,
  autoCreatePendingAccount,
  loadBankSmsPatterns,
  type DetectedIdentifierInput,
} from '@shikoo/domain';
import { SQL, type D1Database } from '@shikoo/database';
import type { Classification, IncomingSmsBody, NormalizedSms, ParseResult } from '@shikoo/contracts';
import { authenticateDevice } from './auth.js';
import { markIngested } from './devices.js';
import { bodyFingerprint, bodyOnlyHash } from './dedupe.js';
import { recordAudit } from './audit.js';
import { rematchMirzabotClaimsForCreditTx, type MirzabotMatchOpts } from './integrations/mirzabot.js';
import {
  INSERT_TRANSACTION_SQL,
  UPDATE_TRANSACTION_STATUS_SQL,
  annotateAccountWarning,
  buildEvidenceJson,
  initialStatus,
  processingDispositionFor,
  shouldCreateTransaction,
} from './transaction-create.js';

/**
 * Pull the detected identifiers out of evidence into a typed array.
 * Defensive against unknown shapes — the dashboard must work even when a
 * third-party parser produces a different structure.
 */
function extractDetectedIdentifiers(r: ParseResult): DetectedIdentifierInput[] {
  const raw = r.evidence.detectedIdentifiers;
  if (!Array.isArray(raw)) return [];
  const out: DetectedIdentifierInput[] = [];
  for (const x of raw) {
    if (!x || typeof x !== 'object') continue;
    const t = (x as { type?: unknown }).type;
    const v = (x as { normalizedValue?: unknown }).normalizedValue;
    const m = (x as { maskedValue?: unknown }).maskedValue;
    const c = (x as { confidence?: unknown }).confidence;
    const p = (x as { parserId?: unknown }).parserId;
    if (typeof v !== 'string' || typeof t !== 'string') continue;
    if (t !== 'ACCOUNT_NUMBER' && t !== 'CARD_LAST_FOUR' && t !== 'IBAN' && t !== 'ACCOUNT_HINT')
      continue;
    out.push({
      type: t,
      normalizedValue: v,
      maskedValue: typeof m === 'string' ? m : v,
      confidence: typeof c === 'number' ? Math.max(0, Math.min(1, c)) : r.confidence,
      parserId: typeof p === 'string' ? p : (r.parserId ?? 'unknown'),
    });
  }
  return out;
}

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
  const auth = await authenticateDevice(db, raw.deviceId, raw.apiKey, raw.deviceName);
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
    console.warn(`bank_sms_patterns row ${s.id} skipped: ${s.problems.join('; ')}`);
  }
  const result = parseSms(sms, parsers);

  const eventId = crypto.randomUUID();
  const created = Date.now();
  const classification: Classification = result.classification;
  const isRedactable =
    classification === 'OTP' || classification === 'PROMOTIONAL' || classification === 'IGNORED';

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
      isRedactable ? null : normalizedBody,
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
  const wasDuplicate = winner?.id !== eventId;

  // Only run the parser side-effects on the winning insert.
  //
  // CREDIT-only product rule: only `direction === 'CREDIT'` is actionable.
  // Both DEBIT (outgoing) and UNKNOWN (direction uncertain) short-circuit
  // before persistTransaction. The raw SMS is still persisted above for
  // audit, but NO transaction_candidate row is created and no matching /
  // auto-assign / identifier resolution runs. The phone must not retry
  // these SMS.
  const isOutgoingTransaction = !wasDuplicate && !isRedactable && result.direction === 'DEBIT';
  const isDirectionUncertain = !wasDuplicate && !isRedactable && result.direction === 'UNKNOWN';
  const skipSideEffects = isOutgoingTransaction || isDirectionUncertain;

  if (!wasDuplicate && !isRedactable && !skipSideEffects) {
    const txRow = await persistTransaction(db, finalEventId, smsTimestamp, result, normalizedBody);
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

function resultMatched(r: ParseResult): 'OK' | 'WARN' | 'ERROR' {
  if (r.matched) return 'OK';
  if (r.warnings.length > 0) return 'WARN';
  return 'ERROR';
}

async function persistTransaction(
  db: D1Database,
  eventId: string,
  bankTimestamp: number,
  r: ParseResult,
  _normalizedBody: string,
): Promise<{
  id: string;
  amount_irr: number;
  direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
  financial_account_id: string | null;
  transaction_reference: string | null;
  bank_timestamp: number;
} | null> {
  if (!shouldCreateTransaction(r)) return null;

  const detected = extractDetectedIdentifiers(r);

  let accountId: string | null = null;
  let accountWarning = '';
  if (detected.length > 0) {
    const resolved = await resolveDetectedIdentifiers(db, detected);
    if (resolved.status === 'OK') {
      accountId = resolved.accountId;
    } else if (resolved.status === 'ACCOUNT_IDENTIFIER_AMBIGUOUS') {
      accountId = null;
      accountWarning = `ACCOUNT_IDENTIFIER_AMBIGUOUS:${resolved.matches.map((m) => m.accountId).join(',')}`;
    } else {
      // NOT_FOUND — auto-create a PENDING account so the admin can
      // review the newly-discovered hint in the Accounts review queue.
      // The new row is PENDING, so it does NOT short-circuit into Today
      // / matching / totals until an admin accepts it. The transaction
      // itself is still written with `financial_account_id` set to the
      // new PENDING row, so when the admin later Accepts the row the
      // existing transaction history is preserved and the admin only
      // needs to review the account, not the transactions.
      const hint = detected.find((d) => d.type === 'ACCOUNT_HINT')?.normalizedValue
        ?? detected.find((d) => d.type === 'ACCOUNT_NUMBER')?.normalizedValue
        ?? r.accountHint
        ?? null;
      if (hint) {
        const created = await autoCreatePendingAccount(db, {
          hint,
          bankName: typeof r.evidence.bank === 'string' ? r.evidence.bank : null,
          accountType: 'OTHER',
          deviceId: null,
          now: Date.now(),
        });
        accountId = created.accountId;
      }
    }
  } else if (r.accountHint) {
    // Fallback for parsers that haven't been migrated to emit
    // detectedIdentifiers yet: resolve via the legacy single-column path.
    const resolved = await resolveAccountByHint(db, r.accountHint);
    if (resolved.status === 'OK') {
      accountId = resolved.accountId;
    } else if (resolved.status === 'ACCOUNT_IDENTIFIER_AMBIGUOUS') {
      accountId = null;
      accountWarning = `ACCOUNT_IDENTIFIER_AMBIGUOUS:${resolved.matches.map((m) => m.id).join(',')}`;
    } else {
      // NOT_FOUND — auto-create a PENDING account on the legacy hint.
      const created = await autoCreatePendingAccount(db, {
        hint: r.accountHint,
        bankName: typeof r.evidence.bank === 'string' ? r.evidence.bank : null,
        accountType: 'OTHER',
        deviceId: null,
        now: Date.now(),
      });
      accountId = created.accountId;
    }
  }

  const warnings = annotateAccountWarning(r, accountId);
  if (accountWarning) warnings.push(accountWarning);
  const evidenceJson = buildEvidenceJson({ ...r, warnings });
  let status = initialStatus(r);
  if (accountWarning) status = 'NEEDS_REVIEW';
  const id = crypto.randomUUID();
  const created = Date.now();

  await db
    .prepare(INSERT_TRANSACTION_SQL)
    .bind(
      id,
      eventId,
      accountId,
      r.direction,
      r.amountIrr,
      r.balanceIrr,
      r.transactionReference,
      bankTimestamp,
      r.confidence,
      r.parserId ?? 'unknown',
      r.parserVersion ?? '0.0.0',
      evidenceJson,
      status,
      processingDispositionFor(r),
      created,
      created,
    )
    .run();

  // Persist detected identifiers (idempotent via UNIQUE).
  await persistDetectedIdentifiers(db, id, detected, created);

  // Record the assignment history. We only record AUTO_IDENTIFIER rows
  // when the resolver found a single unambiguous account — AMBIGUOUS and
  // MISSING resolve to null and never produce a row. The history writer
  // (assignAccountForTx) is a no-op when the same triple is already
  // active, so re-ingest is safe.
  if (accountId) {
    const driving = detected.find(
      (d) =>
        d.normalizedValue === (r.accountHint ?? detected[0]?.normalizedValue ?? ''),
    );
    await assignAccountForTx(
      db,
      {
        transactionCandidateId: id,
        financialAccountId: accountId,
        source: 'AUTO_IDENTIFIER',
        identifierType: (driving?.type ?? null) as
          | 'ACCOUNT_NUMBER'
          | 'CARD_LAST_FOUR'
          | 'IBAN'
          | 'ACCOUNT_HINT'
          | null,
        normalizedIdentifier: driving?.normalizedValue ?? r.accountHint ?? null,
        assignedBy: 'SYSTEM',
      },
      created,
    );
  }

  if (status === 'NEEDS_REVIEW') {
    await db.prepare(UPDATE_TRANSACTION_STATUS_SQL).bind(id, 'NEEDS_REVIEW', created).run();
  }

  return {
    id,
    amount_irr: r.amountIrr ?? 0,
    direction: r.direction,
    financial_account_id: accountId,
    transaction_reference: r.transactionReference,
    bank_timestamp: bankTimestamp,
  };
}
