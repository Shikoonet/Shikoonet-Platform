/**
 * Which card gets shown — the bakery queue, as Sam put it on 2026-09-15:
 * «هر کی نان گرفت بره انتهای صف».
 *
 * Three rules, each with its own describe below:
 *
 *   - The line moves on MONEY, not on being shown (Sam, 2026-08-21). A
 *     shown-and-abandoned checkout is the common case, and when that cost a
 *     card its turn the money piled onto a fraction of the cards. Money is
 *     the bank SMS (0074, issue #304), or a claim settled without one.
 *   - A card in a customer's hands is out of the line for ten minutes — for
 *     any amount — and the lease is the open `payments` row. Handed out busy
 *     anyway, because every card is, it takes a ticket.
 *   - Only a live card is in the line: card ACTIVE, account on.
 *
 * These count real assignments through `rotateCard` rather than reasoning about
 * the SQL. Every other card in the shared database is parked as DISABLED for
 * the duration so the counts are over a known pool.
 */

import { MIRZABOT_SOURCE } from '@shikoo/contracts';
import { CARD_HOLD_MS } from '@shikoo/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { rotateCard } from '../src/payment.js';
import { db } from './helpers/env.js';

/** A fixed instant every draw is measured from — the picker reads no clock. */
const T = 1_700_000_000_000;
const MINUTE = 60_000;

const ACCOUNT_ID = 'rotation-test-account';
const PREFIX = 'rot-card-';
const CLAIM_PREFIX = 'rot-claim-';

/** Luhn-valid 16-digit numbers, distinct per index. */
function digitsFor(index: number): string {
  const body = `6037${String(700_000_000 + index).padStart(11, '0')}`.slice(0, 15);
  for (let check = 0; check <= 9; check++) {
    const candidate = `${body}${check}`;
    if (luhnOk(candidate)) return candidate;
  }
  throw new Error(`no Luhn-valid card for index ${index}`);
}

function luhnOk(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * A pool of `count` cards, all ACTIVE and standing in the line in index order,
 * with every other card in the database parked. Returns the card numbers.
 *
 * Tickets come from the queue sequence, never written by hand. The first
 * version of this wrote `0..count-1` and passed on the sim database, where
 * the sequence had been seeded above four million, and failed in CI on a
 * fresh one: there the sequence started at 1, so a card that took money drew
 * ticket 2 and landed in FRONT of card 5 rather than behind it. A ticket only
 * means «behind everyone» when everyone's ticket came from the same counter.
 */
async function pool(count: number): Promise<string[]> {
  await db
    .prepare(`UPDATE payment_cards SET status = 'DISABLED' WHERE id NOT LIKE ?1`)
    .bind(`${PREFIX}%`)
    .run();
  await db
    .prepare(
      `INSERT INTO financial_accounts
         (id, bank_name, display_name, account_type, account_hint, card_last_four,
          active, parser_configuration, created_at, updated_at)
       VALUES (?1, 'ROTATION', 'حساب تست چرخش', 'CARD', '0000', '0000', 1, '{}', 0, 0)
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(ACCOUNT_ID)
    .run();

  const cards: string[] = [];
  for (let i = 0; i < count; i++) {
    const digits = digitsFor(i);
    cards.push(digits);
    await db
      .prepare(
        `INSERT INTO payment_cards
           (id, financial_account_id, card_digits, holder_name, status,
            created_at, rotation_cursor)
         VALUES (?1, ?2, ?3, ?4, 'ACTIVE', 0, nextval('payment_card_queue_seq'))
         ON CONFLICT (card_digits) DO UPDATE
           SET status = 'ACTIVE', rotation_cursor = nextval('payment_card_queue_seq'),
               last_assigned_at = NULL`,
      )
      .bind(`${PREFIX}${i}`, ACCOUNT_ID, digits, `card ${i}`)
      .run();
  }
  return cards;
}

/** Assign `times` cards through the real rotation and count who got them. */
async function draw(times: number, at: number = T): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let i = 0; i < times; i++) {
    const card = await db.withSession((tx) => rotateCard(tx, at + i));
    if (!card) throw new Error(`rotation returned no card on draw ${i}`);
    counts.set(card.card_digits, (counts.get(card.card_digits) ?? 0) + 1);
  }
  return counts;
}

let claimSeq = 0;

/** One PENDING claim against `digits`, not yet verified. Returns its id. */
async function openClaim(digits: string): Promise<string> {
  const id = `${CLAIM_PREFIX}${claimSeq++}`;
  await db
    .prepare(
      `INSERT INTO payment_claims
         (id, external_order_id, expected_amount_irr, target_financial_account_id,
          card_digits, submitted_at, source_system, status, created_at, updated_at)
       VALUES (?1, ?2, 1000000, ?3, ?4, 0, ?5, 'PENDING', 0, 0)`,
    )
    .bind(id, id, ACCOUNT_ID, digits, MIRZABOT_SOURCE)
    .run();
  return id;
}

/**
 * Money confirmed on `digits` without a bank SMS — a hand delivery, or a
 * verification the operator typed in.
 *
 * Deliberately a bare UPDATE. Nothing from `mirzabotVerify.ts` or the dashboard
 * routes is imported here, because a claim reaches VERIFIED down three separate
 * paths and the point of holding this in the database is that it does not
 * matter which one ran. A test that called one of those functions would prove
 * the queue moves for that function and say nothing about the other two.
 */
async function deposit(digits: string): Promise<void> {
  const id = await openClaim(digits);
  await db.prepare(`UPDATE payment_claims SET status = 'VERIFIED' WHERE id = ?1`).bind(id).run();
}

let smsSeq = 0;

/**
 * The bank's word that money landed: the rows ingest writes for a deposit
 * SMS — an actionable CREDIT on `accountId` unless told otherwise, or one it
 * could not place (`null`). Bare INSERTs for the same reason `deposit()` is
 * a bare UPDATE. Returns the transaction id.
 */
async function sms(
  accountId: string | null,
  opts: { direction?: 'CREDIT' | 'DEBIT'; disposition?: string } = {},
): Promise<string> {
  const id = `${CLAIM_PREFIX}sms-${smsSeq++}`;
  await db
    .prepare(
      `INSERT INTO devices (id, device_code, display_name, active, created_at, updated_at)
       VALUES (?1, ?1, 'rotation fixture', 1, 0, 0)
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(`${CLAIM_PREFIX}device`)
    .run();
  await db
    .prepare(
      `INSERT INTO raw_sms_events
         (id, device_id, sender, normalized_body, body_sha256, app_checksum,
          sms_timestamp, received_at, classification, parser_status, created_at)
       VALUES (?1, ?2, 'BANK', 'x', ?1, 'c', 0, 0, 'BANK_TRANSACTION', 'OK', 0)`,
    )
    .bind(id, `${CLAIM_PREFIX}device`)
    .run();
  await db
    .prepare(
      `INSERT INTO transaction_candidates
         (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status,
          processing_disposition, bank_timestamp, confidence, parser_id, parser_version,
          parser_evidence_json, created_at, updated_at)
       VALUES (?1, ?1, ?2, ?3, 1000000, 'PARSED', ?4, 0, 1.0, 'test', 'v1', '{}', 0, 0)`,
    )
    .bind(id, accountId, opts.direction ?? 'CREDIT', opts.disposition ?? 'ACTIONABLE')
    .run();
  return id;
}

/**
 * Moves `digits` onto an account of its own, as production cards are — one
 * card, one account — so an SMS on it moves that card and no other. Returns
 * the account id.
 */
async function ownAccount(digits: string): Promise<string> {
  const id = `${ACCOUNT_ID}-${digits}`;
  await db
    .prepare(
      `INSERT INTO financial_accounts
         (id, bank_name, display_name, account_type, account_hint, card_last_four,
          active, parser_configuration, created_at, updated_at)
       VALUES (?1, 'ROTATION', 'حساب تست چرخش', 'CARD', ?2, ?2, 1, '{}', 0, 0)
       ON CONFLICT (id) DO NOTHING`,
    )
    .bind(id, digits.slice(-4))
    .run();
  await db
    .prepare(`UPDATE payment_cards SET financial_account_id = ?2 WHERE card_digits = ?1`)
    .bind(digits, id)
    .run();
  return id;
}

/** Draw one card through the real rotation and return its number. */
async function drawOne(at: number = T): Promise<string> {
  const [card] = [...(await draw(1, at)).keys()];
  if (!card) throw new Error('rotation returned no card');
  return card;
}

/** Draw a card, then pay it. One customer who goes all the way through. */
async function drawAndPay(): Promise<string> {
  const card = await drawOne();
  await deposit(card);
  return card;
}

let holdSeq = 0;

/**
 * An invoice holding `digits`: the open `payments` row `checkoutFor` writes
 * when it shows a card, dated `shownAt`. `claimed` is the row after
 * «پرداخت کردم». Returns the row id so a test can settle it.
 */
async function hold(digits: string, shownAt: number, claimed = false): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO payments
         (public_id, amount_irr, method, status, assigned_card_number, created_at, updated_at)
       VALUES (?1, 1000000, 'CARD_TO_CARD', ?2, ?3,
               to_timestamp(?4 / 1000.0), to_timestamp(?4 / 1000.0))
       RETURNING id`,
    )
    .bind(`${CLAIM_PREFIX}hold-${holdSeq++}`, claimed ? 'AWAITING_REVIEW' : 'PENDING', digits, shownAt)
    .first<{ id: number }>();
  return row!.id;
}

afterEach(async () => {
  await db.prepare(`DELETE FROM payments WHERE public_id LIKE ?1`).bind(`${CLAIM_PREFIX}%`).run();
  // The transaction and the match go with the SMS (ON DELETE CASCADE).
  await db.prepare(`DELETE FROM raw_sms_events WHERE id LIKE ?1`).bind(`${CLAIM_PREFIX}%`).run();
  await db.prepare(`DELETE FROM devices WHERE id = ?1`).bind(`${CLAIM_PREFIX}device`).run();
  await db.prepare(`DELETE FROM payment_claims WHERE id LIKE ?1`).bind(`${CLAIM_PREFIX}%`).run();
  await db.prepare(`DELETE FROM payment_cards WHERE id LIKE ?1`).bind(`${PREFIX}%`).run();
  await db.prepare(`DELETE FROM financial_accounts WHERE id LIKE ?1`).bind(`${ACCOUNT_ID}%`).run();
  await db.prepare(`UPDATE payment_cards SET status = 'ACTIVE'`).run();
  /*
   * And every ACCOUNT back on.
   *
   * The card picker asks the account too since 2026-09-03, so a test here that
   * switches one off takes every card of that account out of rotation — for
   * this file AND for every file after it on the shared database. `pool()`
   * re-creates its own row with `ON CONFLICT DO NOTHING`, which does NOT undo
   * an `active = 0` left on a row that still exists.
   *
   * The line above has done the same for `payment_cards.status` since this file
   * was written, and for the same reason. This is its other half.
   */
  await db.prepare(`UPDATE financial_accounts SET active = 1 WHERE active <> 1`).run();
});

/**
 * A generous timeout, and the reason for it.
 *
 * `draw()` runs one real transaction per checkout against the simulation
 * Postgres, so these cases are bound by database round-trips rather than by
 * anything they compute. Alone they finish in about two seconds; on 2026-08-16
 * one of them crossed vitest's 5s default during a full serial run while the
 * machine was also rebuilding a Docker daemon, and failed with a timeout rather
 * than an assertion.
 *
 * That is the worst kind of red: nothing was wrong, and a suite that fails when
 * the machine is busy teaches everybody to re-run it instead of reading it. The
 * limit is raised rather than the work reduced — the counts are the assertion,
 * and fewer draws would make the ratio noisy, which is a flake with a different
 * shape.
 */
describe('the line moves on money, not on being shown', { timeout: 60_000 }, () => {
  it('shows the front of the line to everyone until somebody pays', async () => {
    // Being shown is not taking bread. Twenty customers open a checkout and
    // walk away (no invoice row here, so no hold either) and the same card is
    // at the front for every one of them.
    const cards = await pool(3);

    const counts = await draw(20);

    expect(counts.get(cards[0]!)).toBe(20);
  });

  it('sends the card that took money to the back, and comes round to it again', async () => {
    const cards = await pool(3);

    expect(await drawAndPay()).toBe(cards[0]!);
    expect(await drawAndPay()).toBe(cards[1]!);
    expect(await drawAndPay()).toBe(cards[2]!);
    // Everybody has had a turn; the line is back in its first order.
    expect(await drawAndPay()).toBe(cards[0]!);
    expect(await drawOne()).toBe(cards[1]!);
  });

  it('spreads thirty payments over thirty cards even when most checkouts are abandoned', async () => {
    // The whole request in one case. Every round has two customers who are
    // shown a card and never pay, and one who does. Under the pre-0029 rule the
    // abandoned checkouts moved their cards as far as a paid one, so the money
    // landed on cards 2, 5, 8 … 29 — ten of the thirty — three times each.
    const cards = await pool(30);

    const paid = new Map<string, number>();
    for (let round = 0; round < 30; round++) {
      await draw(2);
      const card = await drawAndPay();
      paid.set(card, (paid.get(card) ?? 0) + 1);
    }

    expect(paid.size).toBe(30);
    for (const card of cards) expect(paid.get(card)).toBe(1);
  });

  it('puts a card added later at the back of the line, not the front', async () => {
    // The dashboard adds a card with `nextval` on the queue sequence. The old
    // clock design seeded a newcomer at zero among peers in the millions, and
    // it took every checkout until it caught up — the head admin's 2026-08-13
    // complaint. Here it simply waits its turn behind everyone.
    const cards = await pool(3);
    for (let i = 0; i < 3; i++) await drawAndPay();

    const newcomer = digitsFor(99);
    await db
      .prepare(
        `INSERT INTO payment_cards
           (id, financial_account_id, card_digits, holder_name, status,
            created_at, rotation_cursor)
         VALUES (?1, ?2, ?3, 'newcomer', 'ACTIVE', 0, nextval('payment_card_queue_seq'))`,
      )
      .bind(`${PREFIX}99`, ACCOUNT_ID, newcomer)
      .run();

    const order: string[] = [];
    for (let i = 0; i < 4; i++) order.push(await drawAndPay());
    expect(order).toEqual([...cards, newcomer]);
  });

  it('sends a card to the back when its order is delivered by hand, before any SMS', async () => {
    // Sam, 2026-09-15: «اگر دستی تایید کنم یعنی بله، باید ته صف بره». Manual
    // delivery and continuity mode write FULFILLED_UNRECONCILED and the bank
    // SMS reconciles it to VERIFIED hours later; the card moves on the first
    // of the two, and the reconciliation itself moves nothing.
    const cards = await pool(3);
    const id = await openClaim(cards[0]!);
    await db
      .prepare(`UPDATE payment_claims SET status = 'FULFILLED_UNRECONCILED' WHERE id = ?1`)
      .bind(id)
      .run();
    expect(await drawOne()).toBe(cards[1]!);

    await deposit(cards[1]!);
    await db.prepare(`UPDATE payment_claims SET status = 'VERIFIED' WHERE id = ?1`).bind(id).run();

    expect(await drawOne()).toBe(cards[2]!);
    await deposit(cards[2]!);
    expect(await drawOne()).toBe(cards[0]!);
  });

  it('moves the line when the bank SMS lands, claimed or not', async () => {
    // Issue #304. Five deposits in twelve minutes on one production card:
    // the line waited for a claim to be VERIFIED, and between the deposit and
    // that lie the relay phone, the customer's «پرداخت کردم» and the matcher's
    // cron. The SMS is the money; the SMS moves the card. Every card of the
    // account, because the SMS names the account, not the card.
    const cards = await pool(3);
    const account0 = await ownAccount(cards[0]!);
    expect(await drawOne()).toBe(cards[0]!);

    // No claim anywhere.
    await sms(account0);
    expect(await drawOne()).toBe(cards[1]!);
    // Card 0 takes another: a fresh ticket, still at the back.
    await sms(account0);
    expect(await drawOne()).toBe(cards[1]!);
    await sms(await ownAccount(cards[1]!));
    expect(await drawOne()).toBe(cards[2]!);
  });

  it('gives one ticket per deposit when the SMS is then matched to a claim', async () => {
    // The SMS moved the card; the auto-verification that follows must not
    // move it again, or every ordinary sale would be two tickets and a
    // hand-delivered one only one. The match row is what tells the claim
    // trigger to stand down — written before the claim, as both verify
    // paths do.
    const cards = await pool(2);
    const account0 = await ownAccount(cards[0]!);
    const claimId = await openClaim(cards[0]!);
    const txId = await sms(account0);
    expect(await drawOne()).toBe(cards[1]!);
    await deposit(cards[1]!);
    expect(await drawOne()).toBe(cards[0]!);

    await db
      .prepare(
        `INSERT INTO reconciliation_matches
           (id, transaction_candidate_id, payment_claim_id, score, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, 1, 'AUTO_VERIFIED', 0, 0)`,
      )
      .bind(`${CLAIM_PREFIX}match`, txId, claimId)
      .run();
    await db.prepare(`UPDATE payment_claims SET status = 'VERIFIED' WHERE id = ?1`).bind(claimId).run();
    // Still in front: the verification drew no second ticket.
    expect(await drawOne()).toBe(cards[0]!);
  });

  it('ignores debits, admin transfers and deposits nobody could place', async () => {
    const cards = await pool(2);
    const account0 = await ownAccount(cards[0]!);
    await sms(account0, { direction: 'DEBIT', disposition: 'OUTGOING_IGNORED' });
    expect(await drawOne()).toBe(cards[0]!);
    await sms(account0, { disposition: 'ADMIN_EXCLUDED' });
    expect(await drawOne()).toBe(cards[0]!);
    await sms(null);
    expect(await drawOne()).toBe(cards[0]!);
  });

  it('moves the line when the operator places a stray deposit on an account', async () => {
    // Ingest could not tell whose SMS it was; the transaction screen's
    // «change account» is the deposit landing, late.
    const cards = await pool(2);
    const account0 = await ownAccount(cards[0]!);
    const txId = await sms(null);
    expect(await drawOne()).toBe(cards[0]!);

    // Writing the same NULL again is not a placement.
    await db
      .prepare(`UPDATE transaction_candidates SET financial_account_id = NULL WHERE id = ?1`)
      .bind(txId)
      .run();
    expect(await drawOne()).toBe(cards[0]!);

    await db
      .prepare(`UPDATE transaction_candidates SET financial_account_id = ?2 WHERE id = ?1`)
      .bind(txId, account0)
      .run();
    expect(await drawOne()).toBe(cards[1]!);
  });

  it('does not move the queue for a claim imported already VERIFIED', async () => {
    // `packages/migrate` writes historical claims straight in as VERIFIED. If
    // those moved the queue, cutover would reorder every card by whatever order
    // the import happened to run in. The trigger is ON UPDATE for exactly this
    // reason.
    const cards = await pool(2);
    const id = `${CLAIM_PREFIX}${claimSeq++}`;
    await db
      .prepare(
        `INSERT INTO payment_claims
           (id, external_order_id, expected_amount_irr, target_financial_account_id,
            card_digits, submitted_at, source_system, status, created_at, updated_at)
         VALUES (?1, ?2, 1000000, ?3, ?4, 0, ?5, 'VERIFIED', 0, 0)`,
      )
      .bind(id, id, ACCOUNT_ID, cards[0]!, MIRZABOT_SOURCE)
      .run();

    expect(await drawOne()).toBe(cards[0]!);
  });

  it('leaves the queue alone when a verification is reverted', async () => {
    // Reverting an approval does not un-receive the money, and the ticket a
    // card drew cannot be handed back. The card keeps its place at the back.
    // Written down because it is a choice, not an oversight.
    const cards = await pool(2);
    const id = await openClaim(cards[0]!);
    await db.prepare(`UPDATE payment_claims SET status = 'VERIFIED' WHERE id = ?1`).bind(id).run();
    await db.prepare(`UPDATE payment_claims SET status = 'REJECTED' WHERE id = ?1`).bind(id).run();

    expect(await drawOne()).toBe(cards[1]!);
  });

  it('skips a card that has been disabled', async () => {
    const cards = await pool(3);
    await db
      .prepare(`UPDATE payment_cards SET status = 'DISABLED' WHERE card_digits = ?1`)
      .bind(cards[0]!)
      .run();

    expect(await drawOne()).toBe(cards[1]!);
  });
});

/**
 * A card in a customer's hands is out of the line.
 *
 * The hold is the open `payments` row — nothing else records it — so these
 * write that row the way `checkoutFor` does and read the picker's answer at
 * chosen instants. (`pay.test.ts` walks the same thing through the real
 * checkout, so a `checkoutFor` that stopped recording the card would fail
 * there.) Without the hold, two customers buying the same plan a minute apart
 * are told to pay the same amount into the same card, and the matcher cannot
 * say whose transfer is whose (`AMBIGUOUS_CLAIMS`).
 */
describe("a card in a customer's hands is out of the line", () => {
  it('skips a held card for ten minutes, then hands it out again', async () => {
    const cards = await pool(2);
    await hold(cards[0]!, T);

    expect(await drawOne(T)).toBe(cards[1]!);
    expect(await drawOne(T + CARD_HOLD_MS - 1)).toBe(cards[1]!);
    // Free again — and at the FRONT, because it never took money.
    expect(await drawOne(T + CARD_HOLD_MS)).toBe(cards[0]!);
  });

  it('holds for as many minutes as the operator set on the settings screen', async () => {
    // Sam, 2026-09-15: the ten minutes is a default, not a rule. Written the
    // way the settings screen writes it — a JSON string — and put back after,
    // because `settings` is shared by every file on this database. An upsert,
    // not an UPDATE: another suite truncates `settings`, and an UPDATE that
    // touched no row would leave this test asserting the default against
    // itself.
    const cards = await pool(2);
    await hold(cards[0]!, T);
    const set = (json: string) =>
      db
        .prepare(
          `INSERT INTO settings (scope, key, value) VALUES ('pay', 'card_hold_minutes', ?1::jsonb)
           ON CONFLICT (scope, key) DO UPDATE SET value = EXCLUDED.value`,
        )
        .bind(json)
        .run();
    await set('"2"');
    try {
      expect(await drawOne(T + 2 * MINUTE - 1)).toBe(cards[1]!);
      expect(await drawOne(T + 2 * MINUTE)).toBe(cards[0]!);
    } finally {
      await set('10');
    }
  });

  it('does not stretch the hold when the customer says they paid', async () => {
    // Sam, 2026-09-17: «ما سقف نداریم اصلا؛ یک زمانی رو مشخص میکنیم». Until
    // that day a «پرداخت کردم» kept the card out for a day or until review,
    // and production stood with six of seven cards behind claims nobody had
    // looked at. One length now, whatever was pressed: the same ten minutes.
    const cards = await pool(2);
    await hold(cards[0]!, T, true);

    expect(await drawOne(T + CARD_HOLD_MS - 1)).toBe(cards[1]!);
    expect(await drawOne(T + CARD_HOLD_MS)).toBe(cards[0]!);

    // And a review that ends it early still frees the card that instant.
    const later = T + CARD_HOLD_MS;
    const claimed = await hold(cards[0]!, later, true);
    expect(await drawOne(later + MINUTE)).toBe(cards[1]!);
    await db.prepare(`UPDATE payments SET status = 'REJECTED' WHERE id = ?1`).bind(claimed).run();
    expect(await drawOne(later + MINUTE)).toBe(cards[0]!);
  });

  it('frees the card when the invoice is settled or expired', async () => {
    const cards = await pool(2);
    for (const status of ['PAID', 'EXPIRED']) {
      const id = await hold(cards[0]!, T);
      expect(await drawOne(T)).toBe(cards[1]!);
      await db.prepare(`UPDATE payments SET status = ?2 WHERE id = ?1`).bind(id, status).run();
      expect(await drawOne(T)).toBe(cards[0]!);
    }
  });

  it('keeps selling when every card is busy, on the card that frees soonest', async () => {
    // Sam's call: three cards, five customers at once, nobody is turned away.
    // The fourth customer gets the card whose ten minutes end first — the
    // matcher may need a person for that one, and review beats no sale.
    const cards = await pool(3);
    await hold(cards[0]!, T - 2 * MINUTE);
    await hold(cards[1]!, T - 9 * MINUTE);
    await hold(cards[2]!, T - 5 * MINUTE);

    expect(await drawOne(T)).toBe(cards[1]!);
  });

  it('sends a card handed out busy to the back of the line', async () => {
    // Issue #304, Sam 2026-09-18. Being shown moves nothing — except when
    // every card is in somebody's hands: then a rush bigger than the pool
    // walks the line instead of piling onto whichever hold is oldest, and
    // once the holds lift the line has turned as if money had landed.
    const cards = await pool(3);
    await hold(cards[0]!, T);
    await hold(cards[1]!, T);
    await hold(cards[2]!, T);

    expect(await drawOne(T)).toBe(cards[0]!);
    // Still busy (the draw wrote no invoice), but now at the back.
    expect(await drawOne(T)).toBe(cards[1]!);
    expect(await drawOne(T)).toBe(cards[2]!);
    expect(await drawOne(T)).toBe(cards[0]!);
    // Holds lifted: the line stands as the rush left it.
    expect(await drawOne(T + CARD_HOLD_MS)).toBe(cards[1]!);
  });

  it('draws no ticket for a free card, however many times it is shown', async () => {
    const cards = await pool(2);
    await draw(5);
    await hold(cards[1]!, T);

    expect(await drawOne(T)).toBe(cards[0]!);
  });

  it('prefers any free card, however far back in the line, to a busy one', async () => {
    const cards = await pool(3);
    await hold(cards[0]!, T);
    await hold(cards[1]!, T);

    expect(await drawOne(T)).toBe(cards[2]!);
  });

  it('holds the card for an order of a different amount too', async () => {
    // Until #304 a held card was handed to any order for another amount, on
    // the reasoning that only same-amount invoices confuse the matcher. True,
    // and beside the point: the line moves when the SMS lands, minutes after
    // the checkout, so in a busy quarter-hour the front card was everybody's.
    // Production 2026-09-18: five deposits on one card while five stood free.
    const cards = await pool(2);
    await hold(cards[0]!, T, true);

    expect(await drawOne(T + MINUTE)).toBe(cards[1]!);
    expect(await drawOne(T + MINUTE)).toBe(cards[1]!);
  });
});

/**
 * Whose card it is, not just which card it is.
 *
 * Sam switched every financial account off on 2026-09-03 and the bot kept
 * handing out a card. The picker read `payment_cards.status` and nothing else,
 * so «غیرفعال‌کردن» on the accounts screen removed the account from «آمار مالی»
 * — which filters `fa.active = 1 AND fa.status = 'ACTIVE'` — while customers
 * went on being told to pay into it. The money still arrived and still matched;
 * it simply arrived somewhere the panel had been told to retire and could no
 * longer show.
 *
 * These assert the picker against the ACCOUNT, and each one is a state an
 * operator can put an account into from the screens that exist.
 */
describe('a card is only handed out while its account is in service', () => {
  /** Puts the rotation account into one state for the length of one test. */
  async function accountState(active: 0 | 1, status: string): Promise<void> {
    await db
      .prepare(`UPDATE financial_accounts SET active = ?2, status = ?3 WHERE id = ?1`)
      .bind(ACCOUNT_ID, active, status)
      .run();
  }

  it('refuses every card on a deactivated account rather than picking one', async () => {
    await pool(3);
    // It works first — otherwise this test could pass against a broken fixture.
    expect(await drawOne()).toBeTruthy();

    await accountState(0, 'ACTIVE');

    const card = await db.withSession((tx) => rotateCard(tx, T));
    // Null is the honest answer, and `checkoutFor` turns it into «کارت موجود
    // نیست». Handing the card out anyway is what this is fixing.
    expect(card).toBeNull();
  });

  for (const status of ['PENDING', 'MUTED', 'DECLINED']) {
    it(`refuses a card whose account is ${status}`, async () => {
      await pool(3);
      await accountState(1, status);

      expect(await db.withSession((tx) => rotateCard(tx, T))).toBeNull();
    });
  }

  it('hands it out again the moment the account comes back', async () => {
    // The other half, and the reason «فعال‌کردن» had to ship in the same change:
    // a gate with no way back is a shop that cannot sell again.
    await pool(3);
    await accountState(0, 'ACTIVE');
    expect(await db.withSession((tx) => rotateCard(tx, T))).toBeNull();

    await accountState(1, 'ACTIVE');

    const card = await db.withSession((tx) => rotateCard(tx, T + 1));
    expect(card?.card_digits).toBeTruthy();
  });

  it('skips the switched-off account and still serves a live one', async () => {
    // The mixed case, which is the one a shop is actually in: not everything
    // off, just one account retired. The rest must keep selling.
    await pool(2);
    const live = 'fa-rotation-live';
    await db
      .prepare(
        `INSERT INTO financial_accounts
           (id, bank_name, display_name, account_type, account_hint, card_last_four,
            active, status, parser_configuration, created_at, updated_at)
         VALUES (?1, 'ROTATION', 'حساب زنده', 'CARD', '0001', '0001', 1, 'ACTIVE', '{}', 0, 0)
         ON CONFLICT (id) DO UPDATE SET active = 1, status = 'ACTIVE'`,
      )
      .bind(live)
      .run();
    const liveDigits = digitsFor(90);
    await db
      .prepare(
        `INSERT INTO payment_cards
           (id, financial_account_id, card_digits, holder_name, status,
            created_at, rotation_cursor)
         VALUES (?1, ?2, ?3, 'زنده', 'ACTIVE', 0, nextval('payment_card_queue_seq'))
         ON CONFLICT (card_digits) DO UPDATE SET status = 'ACTIVE'`,
      )
      .bind(`${PREFIX}live`, live, liveDigits)
      .run();

    await db
      .prepare(`UPDATE financial_accounts SET active = 0 WHERE id = ?1`)
      .bind(ACCOUNT_ID)
      .run();

    try {
      // Every draw must land on the live account's card, never on the two
      // belonging to the account that was switched off.
      const seen = await draw(5);
      expect([...seen.keys()]).toEqual([liveDigits]);
    } finally {
      await db.prepare(`DELETE FROM payment_cards WHERE id = ?1`).bind(`${PREFIX}live`).run();
      await db.prepare(`DELETE FROM financial_accounts WHERE id = ?1`).bind(live).run();
    }
  });
});
