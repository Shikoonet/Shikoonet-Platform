/**
 * «بازخوانی» — read again, with today's parsers, every text that made no row.
 *
 * A bank text arrives once. If the parser of that day could not read it, the
 * text is kept (`raw_sms_events.normalized_body`) but no `transaction_candidates`
 * row exists, and «دفتر بانک» shows a hole where the money moved. When the
 * parser is written a week later, the text does not come back on its own.
 * This does that: for each such text, run `parseSms` as ingest would, and —
 * on apply — make the row through the very same `persistTransaction` ingest
 * uses, so a row made late is made the same.
 *
 * Deliberately not done here:
 *   - no claim matching, no auto-verify, no Mirzabot rematch. Auto-verify has a
 *     five-minute window; a text from last week cannot pass it honestly, and a
 *     row that could pay a claim is the one thing that must never be created
 *     by a batch. A CREDIT made here lands as unreviewed income, and a person
 *     decides.
 *   - no generic parser. A text only `generic-*` can read is left alone: that
 *     is a guess, and «پیامک‌های بی‌پارسر» keeps listing it until a named
 *     parser exists.
 *
 * Dry-run first, apply only what the dry-run listed — the same contract as
 * `cleanup-debits`: the operator has seen the list before it happens.
 */
import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import type { ParseResult } from '@shikoo/contracts';
import { compilePatterns, normalizeText, parseSms, type FallbackParser } from '@shikoo/sms-parser';
import { loadBankSmsPatterns } from './bankSmsPatterns.js';
import { TX_INCOME_DECLINED, TX_PINNED } from './incomeEligibility.js';
import { persistTransaction, readingAccountId } from './persistTransaction.js';
import { REDELIVERY_WINDOW_MS, findRedelivery } from './redelivery.js';
import { shouldCreateTransaction } from './transactionCreate.js';

/**
 * Something rests on the row (alias `t`): money the books counted, or a
 * person's decision about it — off the books, rejected, ignored. Such a row
 * keeps its account and amount; only its balance and clock may be upgraded.
 */
const RESTS_ON = `(${TX_PINNED} OR ${TX_INCOME_DECLINED} OR t.status IN ('REJECTED','IGNORED'))`;

/** The generic row `g` a text made, and whether something rests on it. */
const GUESS_COLUMNS = `
  g.id AS generic_tx_id, g.direction AS generic_direction, g.amount_irr AS generic_amount_irr,
  g.financial_account_id AS generic_account_id,
  (SELECT ${RESTS_ON} FROM transaction_candidates t WHERE t.id = g.id) AS generic_rests_on`;

interface Guess {
  generic_direction: 'CREDIT' | 'DEBIT' | null;
  generic_amount_irr: string | number | null;
  generic_account_id: string | null;
  generic_rests_on: boolean | null;
}

/**
 * What today's named reading may do to a row a generic parser guessed.
 *
 *   upgrade — the same movement in the same place: balance and the bank's
 *             clock, same id. Also for a row something rests on, wherever it
 *             is: a match rests on amount and account, and neither changes.
 *   reread  — nothing rests on it and the reading differs: another account,
 *             another amount. The guess goes; ingest's row takes its place.
 *             2026-09-24: generic-debit had read the year «1405» as the
 *             account and «10» as a 39,000 IRR fee; «upgrade» could only
 *             ever leave those rows where the guess put them.
 *   leave   — something rests on it and the reading is another movement:
 *             that is a person's question, not a batch's.
 */
function verdict(g: Guess, p: { direction: string; amountIrr: number }, target: string | null): 'upgrade' | 'reread' | 'leave' {
  const sameMovement = p.direction === g.generic_direction && p.amountIrr === Number(g.generic_amount_irr);
  // Moves only to an account we know. A number nobody knows is no reason to
  // take a row off the account it is on.
  const moves = target !== null && target !== g.generic_account_id;
  if (sameMovement && (g.generic_rests_on || !moves)) return 'upgrade';
  return g.generic_rests_on ? 'leave' : 'reread';
}

export interface ReparseCandidate {
  eventId: string;
  sender: string;
  receivedAt: number;
  /** What the parser of the day said. */
  was: { parserId: string | null; classification: string };
  /** What today's parser says. */
  now: {
    parserId: string;
    direction: 'CREDIT' | 'DEBIT';
    amountIrr: number;
    balanceIrr: number | null;
    accountHint: string | null;
  };
  /**
   * The same text, same phone, same sender, within six hours of an earlier
   * one — a bank's re-send. Ingest would have set `duplicate_of` and made no
   * row; apply does the same. Listed so the operator sees it is not lost.
   */
  redeliveryOf: string | null;
  /**
   * The text already has a row, made by a generic parser (a guess: last
   * number as balance, arrival as time). Today's named parser reads the same
   * movement — same direction, same amount — so apply upgrades that row in
   * place: parser, balance, the bank's clock. No new row, nothing matched.
   * A row that already paid a claim is upgraded too: the match rests on the
   * amount and the account, and neither changes. (Seven of the eight
   * Keshavarzi rows on production were matched; the first cut left them
   * «حدسی» for good.)
   */
  upgrades: { transactionId: string; balanceIrr: number | null; bankTimestamp: number } | null;
  /**
   * The text has a row a generic parser guessed, nothing rests on it, and
   * today's reading puts the movement elsewhere — `now` is where. Apply
   * deletes the guess and makes ingest's row. What the guess said, so the
   * operator sees what moves.
   */
  rereads: { transactionId: string; accountId: string | null; amountIrr: number } | null;
}

export interface ReparseDryRun {
  sinceMs: number;
  scanned: number;
  /** Texts today's named parsers can read into a row. */
  candidates: ReparseCandidate[];
  /** Texts still nobody reads (or only a generic parser guesses at). */
  stillUnread: number;
}

const FILTERED = `(r.classification IN ('OTP','PROMOTIONAL','IGNORED') OR r.normalized_body LIKE '%[otp-redacted]%')`;

/** The one place the two halves agree on what a text parses to — with the operator's DB patterns, as ingest runs. */
function parseAgain(body: string, sender: string, smsTimestamp: number, fallbacks: readonly FallbackParser[]): ParseResult {
  const text = normalizeText(body).text;
  return parseSms({ raw: body, text, sender, timestamp: smsTimestamp, deviceId: 'reparse' }, fallbacks);
}

async function fallbacksOf(db: D1Database): Promise<readonly FallbackParser[]> {
  return compilePatterns(await loadBankSmsPatterns(db)).parsers;
}

function readable(r: ParseResult): r is ParseResult & { direction: 'CREDIT' | 'DEBIT'; amountIrr: number; parserId: string } {
  return (
    shouldCreateTransaction(r) &&
    typeof r.parserId === 'string' &&
    !r.parserId.startsWith('generic-') &&
    !r.parserId.startsWith('fallback-') &&
    typeof r.amountIrr === 'number' &&
    r.amountIrr > 0
  );
}

export async function dryRunReparse(db: D1Database, sinceMs: number): Promise<ReparseDryRun> {
  const rows = await db
    .prepare(
      `SELECT r.id, r.device_id, r.sender, r.normalized_body, r.sms_timestamp, r.received_at, r.parser_id, r.classification,
              ${GUESS_COLUMNS},
              g.balance_irr AS generic_balance_irr, g.bank_timestamp AS generic_bank_timestamp
         FROM raw_sms_events r
         LEFT JOIN transaction_candidates g
           ON g.raw_sms_event_id = r.id AND g.parser_id LIKE 'generic-%'
        WHERE r.received_at >= ?1
          AND r.normalized_body IS NOT NULL
          AND r.duplicate_of IS NULL
          AND NOT ${FILTERED}
          AND (g.id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM transaction_candidates t WHERE t.raw_sms_event_id = r.id))
        ORDER BY r.received_at`,
    )
    .bind(sinceMs)
    .all<
      Guess & {
        id: string;
        device_id: string;
        sender: string;
        normalized_body: string;
        sms_timestamp: string | number;
        received_at: string | number;
        parser_id: string | null;
        classification: string;
        generic_tx_id: string | null;
        generic_balance_irr: string | number | null;
        generic_bank_timestamp: string | number | null;
      }
    >();
  const fallbacks = await fallbacksOf(db);
  const candidates: ReparseCandidate[] = [];
  // Earlier candidates in this very list, by phone+sender+body: two unread
  // copies of one text have no row yet for `findRedelivery` to find.
  const seen = new Map<string, { id: string; at: number }>();
  let stillUnread = 0;
  for (const r of rows.results ?? []) {
    const p = parseAgain(r.normalized_body, r.sender, Number(r.sms_timestamp), fallbacks);
    if (!readable(p)) {
      stillUnread += 1;
      continue;
    }
    const smsTs = Number(r.sms_timestamp);
    if (r.generic_tx_id) {
      // A row exists: upgraded in place, read again, or left for a person.
      const v = verdict(r, p, await readingAccountId(db, p));
      if (v === 'leave') {
        stillUnread += 1;
        continue;
      }
      candidates.push({
        redeliveryOf: null,
        upgrades:
          v === 'upgrade'
            ? { transactionId: r.generic_tx_id, balanceIrr: r.generic_balance_irr === null ? null : Number(r.generic_balance_irr), bankTimestamp: Number(r.generic_bank_timestamp) }
            : null,
        rereads:
          v === 'reread'
            ? { transactionId: r.generic_tx_id, accountId: r.generic_account_id, amountIrr: Number(r.generic_amount_irr) }
            : null,
        eventId: r.id,
        sender: r.sender,
        receivedAt: Number(r.received_at),
        was: { parserId: r.parser_id, classification: r.classification },
        now: { parserId: p.parserId, direction: p.direction, amountIrr: p.amountIrr, balanceIrr: p.balanceIrr, accountHint: p.accountHint },
      });
      continue;
    }
    let redeliveryOf: string | null = null;
    if (p.balanceIrr !== null && p.amountIrr !== null) {
      // The same facts `findRedelivery` keys on, for a re-send whose first
      // copy is still only in this batch.
      const key = [r.device_id, p.direction, p.amountIrr, p.balanceIrr].join('\u0000');
      const earlier = seen.get(key);
      // Either side, like `findRedelivery`: this list is ordered by arrival,
      // and a re-send can carry an earlier bank clock than the copy before it.
      if (earlier && Math.abs(smsTs - earlier.at) <= REDELIVERY_WINDOW_MS) redeliveryOf = earlier.id;
      else
        redeliveryOf =
          (await findRedelivery(db, r.device_id, { direction: p.direction, amountIrr: p.amountIrr, balanceIrr: p.balanceIrr }, r.id, smsTs))?.id ?? null;
      if (!redeliveryOf) seen.set(key, { id: r.id, at: smsTs });
    }
    candidates.push({
      redeliveryOf,
      upgrades: null,
      rereads: null,
      eventId: r.id,
      sender: r.sender,
      receivedAt: Number(r.received_at),
      was: { parserId: r.parser_id, classification: r.classification },
      now: {
        parserId: p.parserId,
        direction: p.direction,
        amountIrr: p.amountIrr,
        balanceIrr: p.balanceIrr,
        accountHint: p.accountHint,
      },
    });
  }
  return { sinceMs, scanned: (rows.results ?? []).length, candidates, stillUnread };
}

export interface ReparseApplied {
  made: { eventId: string; transactionId: string; parserId: string; direction: 'CREDIT' | 'DEBIT' }[];
  /** Rows a generic parser had made, now carrying the named parser's balance and clock. */
  upgraded: { eventId: string; transactionId: string; parserId: string; direction: 'CREDIT' | 'DEBIT' }[];
  /** Guessed rows nothing rested on, deleted and made again as ingest would — `replaced` is the guess's id. */
  reread: { eventId: string; transactionId: string; replaced: string; parserId: string; direction: 'CREDIT' | 'DEBIT' }[];
  /** Listed in the dry-run but no longer eligible — a row appeared meanwhile, or the text now parses differently. */
  skipped: { eventId: string; why: 'already_has_row' | 'no_longer_readable' | 'not_found' | 'redelivery' }[];
  /** A row this call could not make. The others were still made, and are all in `made`. */
  failed: { eventId: string; error: string }[];
}

/**
 * Makes a row for each event the dry-run listed, and only those. Re-checks
 * every one: the text is read again (parsers may have changed since the
 * dry-run was taken) and a row that appeared meanwhile is left alone, so
 * applying twice makes nothing twice.
 */
export async function applyReparse(db: D1Database, eventIds: string[]): Promise<ReparseApplied> {
  const fallbacks = await fallbacksOf(db);
  const made: ReparseApplied['made'] = [];
  const upgraded: ReparseApplied['upgraded'] = [];
  const reread: ReparseApplied['reread'] = [];
  const skipped: ReparseApplied['skipped'] = [];
  const failed: ReparseApplied['failed'] = [];
  for (const eventId of eventIds) {
    try {
      await applyOne(db, eventId, fallbacks, made, upgraded, reread, skipped);
    } catch (e) {
      // One text's failure is one text's failure: the rows already made stay
      // made, and the caller audits every one of them.
      failed.push({ eventId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { made, upgraded, reread, skipped, failed };
}

async function applyOne(
  db: D1Database,
  eventId: string,
  fallbacks: readonly FallbackParser[],
  made: ReparseApplied['made'],
  upgraded: ReparseApplied['upgraded'],
  reread: ReparseApplied['reread'],
  skipped: ReparseApplied['skipped'],
): Promise<void> {
    const r = await db
      .prepare(
        `SELECT r.id, r.device_id, r.sender, r.normalized_body, r.sms_timestamp, r.parser_id,
                EXISTS (SELECT 1 FROM transaction_candidates t WHERE t.raw_sms_event_id = r.id) AS has_row,
                ${GUESS_COLUMNS}
           FROM raw_sms_events r
           LEFT JOIN transaction_candidates g
             ON g.raw_sms_event_id = r.id AND g.parser_id LIKE 'generic-%'
          WHERE r.id = ?1 AND r.normalized_body IS NOT NULL AND r.duplicate_of IS NULL`,
      )
      .bind(eventId)
      .first<
        Guess & {
          id: string;
          device_id: string;
          sender: string;
          normalized_body: string;
          sms_timestamp: string | number;
          parser_id: string | null;
          has_row: boolean;
          generic_tx_id: string | null;
        }
      >();
    if (!r) {
      skipped.push({ eventId, why: 'not_found' });
      return;
    }
    if (r.has_row && !r.generic_tx_id) {
      skipped.push({ eventId, why: 'already_has_row' });
      return;
    }
    const p = parseAgain(r.normalized_body, r.sender, Number(r.sms_timestamp), fallbacks);
    if (!readable(p)) {
      skipped.push({ eventId, why: 'no_longer_readable' });
      return;
    }
    const smsTs = Number(r.sms_timestamp);
    if (r.generic_tx_id) {
      const v = verdict(r, p, await readingAccountId(db, p));
      if (v === 'leave') {
        skipped.push({ eventId, why: 'no_longer_readable' });
        return;
      }
      if (v === 'reread') {
        // One transaction: the guess goes and ingest's row takes its place, or
        // neither happens and the guess is still there to retry (CodeRabbit on
        // #451). The guess goes only if still nothing rests on it — the
        // condition is in the DELETE, not read a moment before it. Delete
        // first, so no moment holds two rows for one text.
        const genericTxId = r.generic_tx_id;
        const out = await db.withSession(async (tx) => {
          const gone = await tx
            .prepare(
              `DELETE FROM transaction_candidates t
                WHERE t.id = ?1 AND t.parser_id LIKE 'generic-%' AND NOT ${RESTS_ON}
                RETURNING t.id`,
            )
            .bind(genericTxId)
            .first<{ id: string }>();
          if (!gone) return null;
          const made = await persistTransaction(tx, r.id, bankClock(p, smsTs), p, r.normalized_body);
          if (!made) throw new Error('reread made no row');
          await markRead(tx, r.id, p);
          return { replaced: gone.id, transactionId: made.id };
        });
        if (!out) {
          skipped.push({ eventId, why: 'no_longer_readable' });
          return;
        }
        reread.push({ eventId: r.id, transactionId: out.transactionId, replaced: out.replaced, parserId: p.parserId, direction: p.direction });
        return;
      }
      const bankTs = bankClock(p, smsTs);
      // One transaction: the row, its text, and the books' anchor change
      // together or not at all. The fresh start copied this row's balance and
      // clock; if it stays on the guess, the ledger counts the same money
      // twice — 2026-09-19 on production, a 9-second move opened a 400,000 T gap.
      await db.batch([
        db
          .prepare(
            `UPDATE transaction_candidates
                SET parser_id = ?2, parser_version = ?3, balance_irr = ?4, bank_timestamp = ?5,
                    parser_evidence_json = ?6, updated_at = ?7
              WHERE id = ?1`,
          )
          .bind(r.generic_tx_id, p.parserId, p.parserVersion ?? '0.0.0', p.balanceIrr, bankTs, JSON.stringify(p.evidence), Date.now()),
        db
          .prepare(`UPDATE raw_sms_events SET classification = ?2, parser_status = 'OK', parser_id = ?3, parser_version = ?4 WHERE id = ?1`)
          .bind(r.id, p.classification, p.parserId, p.parserVersion ?? '0.0.0'),
        db
          .prepare(`UPDATE account_opening_balances SET as_of = ?2, balance_irr = COALESCE(?3, balance_irr) WHERE transaction_candidate_id = ?1`)
          .bind(r.generic_tx_id, bankTs, p.balanceIrr),
      ]);
      upgraded.push({ eventId: r.id, transactionId: r.generic_tx_id, parserId: p.parserId, direction: p.direction });
      return;
    }
    // The bank's re-send, exactly as ingest treats it: the earlier copy — made
    // a row a moment ago in this same batch, or long ago — owns the movement.
    if (p.balanceIrr !== null && p.amountIrr !== null) {
      const first = await findRedelivery(db, r.device_id, { direction: p.direction, amountIrr: p.amountIrr, balanceIrr: p.balanceIrr }, r.id, smsTs);
      if (first) {
        await db.prepare(`UPDATE raw_sms_events SET duplicate_of = ?1 WHERE id = ?2`).bind(first.id, r.id).run();
        skipped.push({ eventId, why: 'redelivery' });
        return;
      }
    }
    const tx = await persistTransaction(db, r.id, bankClock(p, smsTs), p, r.normalized_body);
    if (!tx) {
      skipped.push({ eventId, why: 'no_longer_readable' });
      return;
    }
    await markRead(db, r.id, p);
    made.push({ eventId: r.id, transactionId: tx.id, parserId: p.parserId, direction: p.direction });
}

/**
 * The bank's own clock from the text, as ingest stores it — with the same
 * two-day fence, so a parser that read a wrong year cannot move the row.
 */
function bankClock(p: ParseResult, smsTs: number): number {
  const fromText = p.evidence['bankTimestamp'];
  return typeof fromText === 'number' && Math.abs(fromText - smsTs) <= 2 * 86_400_000 ? fromText : smsTs;
}

/** The raw row now says what read it, so the coverage view stops listing it. */
async function markRead(db: D1DatabaseSession, eventId: string, p: ParseResult): Promise<void> {
  await db
    .prepare(
      `UPDATE raw_sms_events SET classification = ?2, parser_status = 'OK', parser_id = ?3, parser_version = ?4 WHERE id = ?1`,
    )
    .bind(eventId, p.classification, p.parserId, p.parserVersion ?? '0.0.0')
    .run();
}
