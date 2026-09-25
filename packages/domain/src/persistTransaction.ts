/**
 * A parsed bank text becomes a `transaction_candidates` row — the one path.
 *
 * Resolves the account from the identifiers the parser detected (or the
 * legacy single hint), auto-creates a PENDING account for a number nobody
 * has seen, writes the row with its evidence, the detected identifiers and
 * the assignment history, and marks NEEDS_REVIEW when the hint was ambiguous.
 *
 * Lived inside `apps/ingest-worker/src/ingest.ts` until 2026-09-19 and moved
 * here unchanged, so that «بازخوانی» in the dashboard — reading a text again
 * with a parser that did not exist when it arrived — makes exactly the row
 * ingest would have made. Nothing in here matches a claim or pays anything;
 * that stays with the caller.
 */
import type { D1Database } from '@shikoo/database';
import type { ParseResult } from '@shikoo/contracts';
import { autoCreatePendingAccount } from './autoCreateAccount.js';
import { assignAccountForTx } from './assignments.js';
import { persistDetectedIdentifiers, resolveDetectedIdentifiers, type DetectedIdentifierInput } from './identifiers.js';
import { resolveAccountByHint } from './resolution.js';
import { recordOwnerSuggestion, suggestOwnerByBalance } from './suggestOwnerByBalance.js';
import {
  INSERT_TRANSACTION_SQL,
  UPDATE_TRANSACTION_STATUS_SQL,
  annotateAccountWarning,
  buildEvidenceJson,
  initialStatus,
  processingDispositionFor,
  shouldCreateTransaction,
} from './transactionCreate.js';

export interface PersistedTransaction {
  id: string;
  amount_irr: number;
  direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
  financial_account_id: string | null;
  transaction_reference: string | null;
  bank_timestamp: number;
}

/**
 * Pull the detected identifiers out of evidence into a typed array.
 * Defensive against unknown shapes — the dashboard must work even when a
 * third-party parser produces a different structure.
 */
export function extractDetectedIdentifiers(r: ParseResult): DetectedIdentifierInput[] {
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

/**
 * The account a reading lands on: the lookup below, without creating a
 * PENDING account for a number nobody knows (null then, as for an ambiguous
 * one). «بازخوانی» asks it before it offers to move a guessed row.
 */
export async function readingAccountId(db: D1Database, r: ParseResult): Promise<string | null> {
  const detected = extractDetectedIdentifiers(r);
  if (detected.length > 0) {
    const resolved = await resolveDetectedIdentifiers(db, detected);
    return resolved.status === 'OK' ? resolved.accountId : null;
  }
  if (!r.accountHint) return null;
  const resolved = await resolveAccountByHint(db, r.accountHint);
  return resolved.status === 'OK' ? resolved.accountId : null;
}

export async function persistTransaction(
  db: D1Database,
  eventId: string,
  bankTimestamp: number,
  r: ParseResult,
  _normalizedBody: string,
): Promise<PersistedTransaction | null> {
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
      const hint =
        detected.find((d) => d.type === 'ACCOUNT_HINT')?.normalizedValue ??
        detected.find((d) => d.type === 'ACCOUNT_NUMBER')?.normalizedValue ??
        r.accountHint ??
        null;
      if (hint) {
        const created = await autoCreatePendingAccount(db, {
          hint,
          bankName: typeof r.evidence.bank === 'string' ? r.evidence.bank : null,
          accountType: 'OTHER',
          deviceId: null,
          now: Date.now(),
        });
        accountId = created.accountId;
        if (created.created) await suggestOwner(db, created.accountId, r, bankTimestamp);
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
      if (created.created) await suggestOwner(db, created.accountId, r, bankTimestamp);
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
      (d) => d.normalizedValue === (r.accountHint ?? detected[0]?.normalizedValue ?? ''),
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

/**
 * A number nobody knew just got a PENDING account. If the bank's balance on
 * this very text chains from exactly one live account, say so on the row —
 * a suggestion for the review queue, never a merge. See `suggestOwnerByBalance`.
 */
async function suggestOwner(db: D1Database, pendingId: string, r: ParseResult, at: number): Promise<void> {
  if (r.balanceIrr === null || r.amountIrr === null || (r.direction !== 'CREDIT' && r.direction !== 'DEBIT')) return;
  const owner = await suggestOwnerByBalance(db, {
    direction: r.direction,
    amountIrr: r.amountIrr,
    balanceIrr: r.balanceIrr,
    at,
    excludeAccountId: pendingId,
  });
  if (owner) await recordOwnerSuggestion(db, pendingId, owner);
}
