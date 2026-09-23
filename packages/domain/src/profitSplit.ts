/**
 * «تقسیم سود» and each partner's running account — 0095.
 *
 * Sam, 1 Mehr 1405: at the end of the month Pouyan says «۴۰ میلیون تقسیم
 * می‌کنم»; one partner already took 5 million in the middle of it. The split
 * is a decision (what each is now owed), the draw is a payment (money that
 * left an account). A partner's balance is every share minus every draw:
 *
 *     balance = Σ shares of every live split − Σ his PARTNER_DRAW rows
 *
 * Positive is owed to him; negative is taken ahead of the profit. It carries
 * from month to month because it is a sum, not a monthly figure.
 *
 * Draws count from the fresh start on (`booksStartMs`), like every other money
 * figure: the 680 million filed before it are history, and a partner does not
 * start the new books 300 million in debt for them. Splits are all counted —
 * the table began empty after the books did.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import { booksStartMs } from './books.js';
import { tehranDateStringFromMs } from './historyRange.js';
import { allocate } from './shopProfit.js';

type Db = D1Database | D1DatabaseSession;

export interface PartnerAccount {
  partyId: number;
  name: string;
  sharePercent: number | null;
  active: boolean;
  /** Every share of every live split. */
  allottedIrr: number;
  /** Every draw since the books opened, fee included. */
  drawnIrr: number;
  /** allotted − drawn: positive is owed to him. */
  balanceIrr: number;
}

export async function partnerAccounts(db: Db): Promise<PartnerAccount[]> {
  const start = await booksStartMs(db);
  const startDay = start === null ? null : tehranDateStringFromMs(start);
  const rows = await db
    .prepare(
      `SELECT pa.id, pa.name, pa.share_percent, pa.active,
              COALESCE((SELECT SUM(s.amount_irr) FROM profit_distribution_shares s
                          JOIN profit_distributions d ON d.id = s.distribution_id AND d.voided_at IS NULL
                         WHERE s.party_id = pa.id), 0) AS allotted_irr,
              COALESCE((SELECT SUM(b.fee_irr - b.amount_irr) FROM shop_books b
                         WHERE b.party_id = pa.id AND b.kind = 'PARTNER_DRAW'
                           ${startDay ? 'AND b.spent_on >= ?1::date' : ''}), 0) AS drawn_irr
         FROM parties pa
        WHERE 'PARTNER' = ANY(pa.roles)
        ORDER BY pa.name`,
    )
    .bind(...(startDay ? [startDay] : []))
    .all<{ id: number; name: string; share_percent: string | number | null; active: boolean; allotted_irr: string | number; drawn_irr: string | number }>();
  return (rows.results ?? [])
    .map((r) => {
      const allottedIrr = Number(r.allotted_irr);
      const drawnIrr = Number(r.drawn_irr);
      return {
        partyId: Number(r.id),
        name: r.name,
        sharePercent: r.share_percent === null ? null : Number(r.share_percent),
        active: r.active,
        allottedIrr,
        drawnIrr,
        balanceIrr: allottedIrr - drawnIrr,
      };
    })
    // An archived partner stays while his account is not settled.
    .filter((p) => p.active || p.allottedIrr !== 0 || p.drawnIrr !== 0);
}

/**
 * `total` over the active partners, in proportion to their percents, in
 * whole units summing to `total` exactly (`allocate`). The route passes Toman,
 * so every share is a figure somebody can actually transfer. Percents that add to
 * less than 100 still divide the whole amount — the amount is what was
 * decided; the percents say only who gets what part of it.
 */
export function splitByPercent(
  total: number,
  partners: Array<{ partyId: number; sharePercent: number | null; active: boolean }>,
): Array<{ partyId: number; sharePercent: number; amountIrr: number }> {
  const eligible = partners.filter((p) => p.active && p.sharePercent !== null && p.sharePercent > 0);
  const amounts = allocate(total, eligible.map((p) => p.sharePercent!));
  return eligible.map((p, i) => ({ partyId: p.partyId, sharePercent: p.sharePercent!, amountIrr: amounts[i]! }));
}

export interface Distribution {
  id: number;
  fromDay: string;
  toDay: string;
  profitIrr: number | null;
  note: string;
  createdBy: string;
  createdAt: string;
  voidedAt: string | null;
  totalIrr: number;
  shares: Array<{ partyId: number; name: string; sharePercent: number | null; amountIrr: number }>;
}

export async function listDistributions(db: Db, limit = 50): Promise<Distribution[]> {
  const rows = await db
    .prepare(
      `SELECT d.id, to_char(d.from_day, 'YYYY-MM-DD') AS from_day, to_char(d.to_day, 'YYYY-MM-DD') AS to_day,
              d.profit_irr, d.note, d.created_by, d.created_at::text AS created_at, d.voided_at::text AS voided_at,
              COALESCE(json_agg(json_build_object('partyId', s.party_id, 'name', pa.name,
                         'sharePercent', s.share_percent, 'amountIrr', s.amount_irr) ORDER BY pa.name)
                       FILTER (WHERE s.party_id IS NOT NULL), '[]') AS shares
         FROM profit_distributions d
         LEFT JOIN profit_distribution_shares s ON s.distribution_id = d.id
         LEFT JOIN parties pa ON pa.id = s.party_id
        GROUP BY d.id
        ORDER BY d.to_day DESC, d.id DESC
        LIMIT ?1`,
    )
    .bind(limit)
    .all<{
      id: number;
      from_day: string;
      to_day: string;
      profit_irr: string | number | null;
      note: string;
      created_by: string;
      created_at: string;
      voided_at: string | null;
      shares: string | Array<{ partyId: number; name: string; sharePercent: string | number | null; amountIrr: string | number }>;
    }>();
  return (rows.results ?? []).map((r) => {
    const raw = typeof r.shares === 'string' ? JSON.parse(r.shares) : r.shares;
    const shares = (raw as Array<{ partyId: number; name: string; sharePercent: string | number | null; amountIrr: string | number }>).map((s) => ({
      partyId: Number(s.partyId),
      name: s.name,
      sharePercent: s.sharePercent === null ? null : Number(s.sharePercent),
      amountIrr: Number(s.amountIrr),
    }));
    return {
      id: Number(r.id),
      fromDay: r.from_day,
      toDay: r.to_day,
      profitIrr: r.profit_irr === null ? null : Number(r.profit_irr),
      note: r.note,
      createdBy: r.created_by,
      createdAt: r.created_at,
      voidedAt: r.voided_at,
      totalIrr: shares.reduce((a, s) => a + s.amountIrr, 0),
      shares,
    };
  });
}
