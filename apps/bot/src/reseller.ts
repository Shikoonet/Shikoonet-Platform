/**
 * Applying to become a reseller.
 *
 * 116 people did this on the live bot, which makes it the only "coming soon"
 * button in the menu with a real number behind it.
 *
 * The legacy flow is `index.php:6143-6169`, and it charges: it refuses anyone
 * whose balance is below `setting.agentreqprice` and deducts that price when
 * the application is filed. **On the production settings row that price is 0**,
 * so nothing here touches money. If the admin ever sets it, the deduction has
 * to be a `wallet_entries` row like every other movement — not the balance
 * UPDATE the PHP does, which is the same edit that produced an account at
 * -5,940,000 Toman with no history to explain it.
 *
 * The description is whatever the customer types. It is capped at the length
 * the legacy column allowed so the admin sees what they are used to, and it is
 * never parsed, never rendered as markup, and never used to select anything.
 */

import type { D1DatabaseSession } from '@shikoo/database';

/** `Requestagent.Description` is varchar(500) in the live schema. */
export const DESCRIPTION_MAX = 500;

export type ApplyResult = 'FILED' | 'ALREADY_PENDING' | 'ALREADY_RESELLER' | 'EMPTY';

/**
 * Files an application.
 *
 * The uniqueness is the index's, not this function's: `ON CONFLICT DO NOTHING`
 * on `idx_reseller_request_one_open` means two taps arriving together produce
 * one row and one "already filed", instead of both reading "no open request"
 * and both writing.
 */
export async function applyForReseller(
  tx: D1DatabaseSession,
  userId: number,
  isReseller: boolean,
  description: string,
): Promise<ApplyResult> {
  if (isReseller) return 'ALREADY_RESELLER';
  const text = description.trim().slice(0, DESCRIPTION_MAX);
  if (text.length === 0) return 'EMPTY';

  const done = await tx
    .prepare(
      `INSERT INTO reseller_requests (user_id, description, status, created_at)
       VALUES (?1, ?2, 'PENDING', now())
       ON CONFLICT DO NOTHING`,
    )
    .bind(userId, text)
    .run();
  return done.meta.changes > 0 ? 'FILED' : 'ALREADY_PENDING';
}

/** Whether this customer is waiting on an answer. */
export async function hasOpenRequest(tx: D1DatabaseSession, userId: number): Promise<boolean> {
  const row = await tx
    .prepare(`SELECT 1 FROM reseller_requests WHERE user_id = ?1 AND status = 'PENDING' LIMIT 1`)
    .bind(userId)
    .first<{ '?column?': number }>();
  return row !== null;
}
