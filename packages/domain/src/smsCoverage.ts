/**
 * Which bank texts the parsers read, and which they did not.
 *
 * Every SMS the phone relays is kept in `raw_sms_events` with its normalized
 * body, the parser that won and what it was classified as; a bank transaction
 * additionally becomes a `transaction_candidates` row. That is the whole
 * record — and until 2026-09-19 nobody could see it. Keshavarzi ran for two
 * days on a generic parser that took the card's «4006» as the balance, and
 * seven withdrawals from four banks made no row at all, and each was found
 * from the ledger, days later, one at a time.
 *
 * Two views over that record, both read-only:
 *
 *   senderCoverage   one line per sender — how many texts, how many read by a
 *                    named parser, by a generic one, or by none; what to look at
 *   unparsedShapes   every text a named parser did not read, grouped by its
 *                    SHAPE (digits → 9) so a hundred bills from one bank are one
 *                    line with a count, and one sample body to write the parser
 *                    from
 *
 * «filtered» is OTP and promotional — not bank money, deliberately dropped.
 * «generic» is a row made by a parser that guesses (`generic-*`), which is
 * how a wrong balance gets in. «unread» is a text that is not filtered and
 * made no row: a withdrawal shape the bank's parser does not know, most often.
 */
import type { D1Database } from '@shikoo/database';

export interface SenderCoverage {
  sender: string;
  total: number;
  filtered: number;
  named: number;
  generic: number;
  unread: number;
  lastAt: number;
  parsers: { parserId: string; n: number }[];
}

export interface UnparsedShape {
  sender: string;
  shape: string;
  count: number;
  lastAt: number;
  parserId: string | null;
  classification: string;
  /** «unread» made no row; «generic» made one by guessing. */
  reason: 'unread' | 'generic';
  sampleEventId: string;
  sampleBody: string;
}

const num = (v: unknown): number => Number(v ?? 0);

/** Filtered on purpose: not bank money. */
const FILTERED = `r.classification IN ('OTP','PROMOTIONAL','IGNORED')`;
const HAS_ROW = `EXISTS (SELECT 1 FROM transaction_candidates t WHERE t.raw_sms_event_id = r.id)`;
const GENERIC = `COALESCE(r.parser_id, '') LIKE 'generic-%'`;

export async function senderCoverage(db: D1Database, sinceMs: number): Promise<SenderCoverage[]> {
  const rows = await db
    .prepare(
      `SELECT r.sender,
              count(*)::int AS total,
              count(*) FILTER (WHERE ${FILTERED})::int AS filtered,
              count(*) FILTER (WHERE NOT ${FILTERED} AND ${HAS_ROW} AND NOT ${GENERIC})::int AS named,
              count(*) FILTER (WHERE NOT ${FILTERED} AND ${HAS_ROW} AND ${GENERIC})::int AS generic,
              count(*) FILTER (WHERE NOT ${FILTERED} AND NOT ${HAS_ROW})::int AS unread,
              max(r.received_at) AS last_at,
              json_agg(json_build_object('parserId', COALESCE(r.parser_id, '-'), 'n', 1)) AS parsers
         FROM raw_sms_events r
        WHERE r.received_at >= ?1
        GROUP BY r.sender
        ORDER BY unread DESC, generic DESC, total DESC`,
    )
    .bind(sinceMs)
    .all<{
      sender: string;
      total: number;
      filtered: number;
      named: number;
      generic: number;
      unread: number;
      last_at: string | number;
      parsers: { parserId: string; n: number }[] | string;
    }>();
  return (rows.results ?? []).map((r) => {
    const raw = typeof r.parsers === 'string' ? (JSON.parse(r.parsers) as { parserId: string }[]) : r.parsers;
    const tally = new Map<string, number>();
    for (const p of raw) tally.set(p.parserId, (tally.get(p.parserId) ?? 0) + 1);
    return {
      sender: r.sender,
      total: num(r.total),
      filtered: num(r.filtered),
      named: num(r.named),
      generic: num(r.generic),
      unread: num(r.unread),
      lastAt: num(r.last_at),
      parsers: [...tally].map(([parserId, n]) => ({ parserId, n })).sort((a, b) => b.n - a.n),
    };
  });
}

export async function unparsedShapes(db: D1Database, sinceMs: number): Promise<UnparsedShape[]> {
  const rows = await db
    .prepare(
      `WITH candidates AS (
         SELECT r.id, r.sender, r.received_at, r.parser_id, r.classification, r.normalized_body,
                regexp_replace(replace(r.normalized_body, E'\\n', ' | '), '[0-9]', '9', 'g') AS shape,
                CASE WHEN ${HAS_ROW} THEN 'generic' ELSE 'unread' END AS reason
           FROM raw_sms_events r
          WHERE r.received_at >= ?1
            AND r.normalized_body IS NOT NULL
            AND NOT ${FILTERED}
            AND (NOT ${HAS_ROW} OR ${GENERIC})
       ),
       latest AS (
         SELECT DISTINCT ON (sender, shape) sender, shape, id, normalized_body, parser_id, classification, reason
           FROM candidates ORDER BY sender, shape, received_at DESC
       )
       SELECT c.sender, c.shape, count(*)::int AS n, max(c.received_at) AS last_at,
              l.parser_id, l.classification, l.reason, l.id AS sample_id, l.normalized_body AS sample_body
         FROM candidates c
         JOIN latest l ON l.sender = c.sender AND l.shape = c.shape
        GROUP BY c.sender, c.shape, l.parser_id, l.classification, l.reason, l.id, l.normalized_body
        ORDER BY (l.reason = 'unread') DESC, n DESC, last_at DESC`,
    )
    .bind(sinceMs)
    .all<{
      sender: string;
      shape: string;
      n: number;
      last_at: string | number;
      parser_id: string | null;
      classification: string;
      reason: 'unread' | 'generic';
      sample_id: string;
      sample_body: string;
    }>();
  return (rows.results ?? []).map((r) => ({
    sender: r.sender,
    shape: r.shape,
    count: num(r.n),
    lastAt: num(r.last_at),
    parserId: r.parser_id,
    classification: r.classification,
    reason: r.reason,
    sampleEventId: r.sample_id,
    sampleBody: r.sample_body,
  }));
}
