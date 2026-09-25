/**
 * «این شماره مال کدام حساب ماست؟» — answered by the bank's own balance.
 *
 * When a text names an account number nobody registered, ingest makes a
 * PENDING account for it. Often the number is a second identifier of an
 * account we already have (a Pol transfer names the account, the card
 * texts name the card). The bank's balance says so: the last balance the
 * known account texted, plus or minus this movement, equals this text's
 * balance. The chain is exact, in rials, and two different accounts do not
 * land on the same figure by accident.
 *
 * Exactly one live account may fit; two is silence. A suggestion is written
 * on the PENDING row and the review queue offers the merge. Nothing merges
 * on its own.
 */
import type { D1DatabaseSession } from '@shikoo/database';

const LOOKBACK_MS = 3 * 86_400_000;

export interface OwnerClue {
  direction: 'CREDIT' | 'DEBIT';
  amountIrr: number;
  balanceIrr: number;
  /** The bank's clock on this text. */
  at: number;
  /** The PENDING account just made — never its own owner. */
  excludeAccountId: string;
}

export async function suggestOwnerByBalance(db: D1DatabaseSession, clue: OwnerClue): Promise<string | null> {
  const signed = clue.direction === 'CREDIT' ? clue.amountIrr : -clue.amountIrr;
  const rows = await db
    .prepare(
      `WITH last AS (
         SELECT DISTINCT ON (t.financial_account_id) t.financial_account_id, t.balance_irr
           FROM transaction_candidates t
           JOIN financial_accounts fa ON fa.id = t.financial_account_id
          WHERE fa.active = 1 AND fa.status = 'ACTIVE' AND fa.id <> ?4
            AND t.balance_irr IS NOT NULL
            AND t.status NOT IN ('REJECTED','IGNORED')
            AND t.bank_timestamp < ?1 AND t.bank_timestamp >= ?1 - ?5
          ORDER BY t.financial_account_id, t.bank_timestamp DESC, t.created_at DESC
       )
       SELECT financial_account_id FROM last WHERE balance_irr + ?2 = ?3`,
    )
    .bind(clue.at, signed, clue.balanceIrr, clue.excludeAccountId, LOOKBACK_MS)
    .all<{ financial_account_id: string }>();
  const hits = rows.results ?? [];
  return hits.length === 1 ? hits[0]!.financial_account_id : null;
}

export async function recordOwnerSuggestion(db: D1DatabaseSession, pendingId: string, ownerId: string): Promise<void> {
  await db
    .prepare(`UPDATE financial_accounts SET suggested_owner_id = ?2, suggested_reason = 'balance_chain' WHERE id = ?1`)
    .bind(pendingId, ownerId)
    .run();
}
