/**
 * Which card gets shown, and how often — and, since 2026-08-21, which card
 * actually RECEIVES the money.
 *
 * The head admin's request on 2026-08-13 was a ratio, and it had two halves:
 * a newly added card must be shown MORE than the others until it catches up,
 * and it must NOT be the only card shown. Both halves are asserted here,
 * because the second one is what the code did wrong before this change —
 * `ORDER BY last_assigned_at NULLS FIRST` gave a fresh card 100% of checkouts.
 *
 * Sam's request on 2026-08-21 was a queue: a card goes to the back when money
 * lands on it, not when it is merely shown. A shown-and-abandoned checkout is
 * the common case — the customer opens the payment screen and walks away — and
 * under the old rule it cost that card its turn, so the money piled onto a
 * fraction of the cards. The second half of this file counts DEPOSITS rather
 * than assignments and is where that is asserted.
 *
 * These count real assignments through `rotateCard` rather than reasoning about
 * the SQL. Every other card in the shared database is parked as DISABLED for
 * the duration so the counts are over a known pool.
 */

import { MIRZABOT_SOURCE } from '@shikoo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { rotateCard } from '../src/payment.js';
import { db } from './helpers/env.js';

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
 * A pool of `count` cards, all ACTIVE, with every other card in the database
 * parked. `weights[i]` is the display weight of card i; anything unspecified
 * is 1. Returns the card numbers in index order.
 */
async function pool(count: number, weights: Record<number, number> = {}): Promise<string[]> {
  await db.prepare(`UPDATE payment_cards SET status = 'DISABLED' WHERE id NOT LIKE ?1`).bind(`${PREFIX}%`).run();
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
           (id, financial_account_id, card_digits, label, holder_name, status,
            created_at, display_weight, rotation_cursor)
         VALUES (?1, ?2, ?3, ?4, 'چرخش', 'ACTIVE', 0, ?5, 0)
         ON CONFLICT (card_digits) DO UPDATE
           SET status = 'ACTIVE', display_weight = EXCLUDED.display_weight,
               rotation_cursor = 0, last_assigned_at = NULL`,
      )
      .bind(`${PREFIX}${i}`, ACCOUNT_ID, digits, `card ${i}`, weights[i] ?? 1)
      .run();
  }
  return cards;
}

/** Assign `times` cards through the real rotation and count who got them. */
async function draw(times: number): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  for (let i = 0; i < times; i++) {
    const card = await db.withSession((tx) => rotateCard(tx, 1_700_000_000_000 + i));
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
 * Money confirmed on `digits`.
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

/** Draw one card through the real rotation and return its number. */
async function drawOne(): Promise<string> {
  const [card] = [...(await draw(1)).keys()];
  if (!card) throw new Error('rotation returned no card');
  return card;
}

/** Draw a card, then pay it. One customer who goes all the way through. */
async function drawAndPay(): Promise<string> {
  const card = await drawOne();
  await deposit(card);
  return card;
}

afterEach(async () => {
  await db.prepare(`DELETE FROM payment_claims WHERE id LIKE ?1`).bind(`${CLAIM_PREFIX}%`).run();
  await db.prepare(`DELETE FROM payment_cards WHERE id LIKE ?1`).bind(`${PREFIX}%`).run();
  await db.prepare(`DELETE FROM financial_accounts WHERE id = ?1`).bind(ACCOUNT_ID).run();
  await db.prepare(`UPDATE payment_cards SET status = 'ACTIVE'`).run();
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
describe('card rotation', { timeout: 30_000 }, () => {
  it('splits evenly when every card has the same weight', async () => {
    const cards = await pool(5);

    const counts = await draw(500);

    for (const card of cards) {
      expect(counts.get(card)).toBe(100);
    }
  });

  it('shows a weighted card more often, in the ratio of its weight', async () => {
    // Card 0 carries weight 3 among five cards, so its expected share is
    // 3/(3+1+1+1+1) = 3/7 and each other card gets 1/7.
    const cards = await pool(5, { 0: 3 });

    const counts = await draw(700);

    expect(counts.get(cards[0]!)).toBe(300);
    for (const card of cards.slice(1)) {
      expect(counts.get(card)).toBe(100);
    }
  });

  it('never gives the weighted card every checkout', async () => {
    // The half of the request that the old code got wrong. Even at the maximum
    // weight the schema allows, the other cards must keep their turn.
    const cards = await pool(4, { 0: 20 });

    const counts = await draw(230);

    for (const card of cards) {
      expect(counts.get(card) ?? 0).toBeGreaterThan(0);
    }
    expect(counts.get(cards[0]!)).toBeLessThan(230);
  });

  it('does not let a card added later drain the pool', async () => {
    // Four cards run for a while, then a fifth is added the way the dashboard
    // adds one: seeded to MAX(rotation_cursor) rather than to zero. Without
    // that seeding the newcomer sits at 0 among peers in the millions and takes
    // every single checkout until it catches up — the live bug this replaced.
    const cards = await pool(4);
    await draw(400);

    const newcomer = digitsFor(99);
    await db
      .prepare(
        `INSERT INTO payment_cards
           (id, financial_account_id, card_digits, label, holder_name, status,
            created_at, display_weight, rotation_cursor)
         VALUES (?1, ?2, ?3, 'newcomer', 'چرخش', 'ACTIVE', 0, 1,
                 COALESCE((SELECT MAX(rotation_cursor) FROM payment_cards WHERE status = 'ACTIVE'), 0))`,
      )
      .bind(`${PREFIX}99`, ACCOUNT_ID, newcomer)
      .run();

    const counts = await draw(100);

    const share = counts.get(newcomer) ?? 0;
    expect(share).toBeGreaterThan(0);
    // A fair share of five cards is 20. Anything near 100 would be the old bug.
    expect(share).toBeLessThanOrEqual(25);
    for (const card of cards) {
      expect(counts.get(card) ?? 0).toBeGreaterThan(0);
    }
  });

  it('skips a card that has been disabled', async () => {
    const cards = await pool(3);
    await db.prepare(`UPDATE payment_cards SET status = 'DISABLED' WHERE card_digits = ?1`)
      .bind(cards[1]!)
      .run();

    const counts = await draw(60);

    expect(counts.get(cards[1]!)).toBeUndefined();
    expect(counts.get(cards[0]!)).toBe(30);
    expect(counts.get(cards[2]!)).toBe(30);
  });
});

/**
 * The queue, as Sam described it on 2026-08-21: thirty cards in a line, and the
 * one that just took money goes to the end of it.
 *
 * The distinction these cases turn on is the one the old code did not make.
 * Being SHOWN a card advances it by 1,000,000; taking money on it advances it
 * by 1,000,000,000 — a thousand times as far. So a checkout the customer
 * abandons barely moves the card, and a checkout they pay sends it a full lap
 * back. Neither number is asserted anywhere; what is asserted is the behaviour
 * the ratio buys, which is what would actually be wrong if somebody changed it.
 */
describe('card queue advances on money, not on being shown', { timeout: 60_000 }, () => {
  it('sends a card that took money to the back, and leaves a shown one where it was', async () => {
    const cards = await pool(3);

    // One customer pays. The other two cards are untouched.
    expect(await drawAndPay()).toBe(cards[0]!);

    const counts = await draw(100);

    // A hundred more checkouts and card 0 is still waiting its turn, because
    // one lap is 1000 assignments and only 100 have happened. Under the old
    // rule it would take its ordinary third of these, about 33.
    expect(counts.get(cards[0]!) ?? 0).toBe(0);
    expect(counts.get(cards[1]!)).toBe(50);
    expect(counts.get(cards[2]!)).toBe(50);
  });

  it('spreads thirty payments over thirty cards even when most checkouts are abandoned', async () => {
    // This is the whole request in one case. Every round has two customers who
    // are shown a card and never pay, and one who does.
    //
    // Under the old rule the abandoned checkouts advanced their cards just as
    // far as a paid one, so the paying customer was always handed the third
    // card of the round: the money landed on cards 2, 5, 8 … 29 — ten of the
    // thirty — three times each, and the other twenty never saw a rial. That is
    // the imbalance Sam is describing, and it is what this case fails on if the
    // queue ever goes back to moving when a card is merely shown.
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

  it('gives a weighted card its share of the money, not just of the screens', async () => {
    // `display_weight` was the head admin's 2026-08-13 knob and it still has to
    // mean something. It divides the payment step too, so a weight of 2 comes
    // back around twice as fast and collects twice the deposits.
    const cards = await pool(3, { 0: 2 });

    const paid = new Map<string, number>();
    for (let i = 0; i < 40; i++) {
      const card = await drawAndPay();
      paid.set(card, (paid.get(card) ?? 0) + 1);
    }

    expect(paid.get(cards[0]!)).toBe(20);
    expect(paid.get(cards[1]!)).toBe(10);
    expect(paid.get(cards[2]!)).toBe(10);
  });

  it('does not move the queue for a claim imported already VERIFIED', async () => {
    // `packages/migrate` writes historical claims straight in as VERIFIED. If
    // those moved the queue, cutover would reorder every card by whatever order
    // the import happened to run in — thousands of laps, all meaningless. The
    // trigger is ON UPDATE for exactly this reason.
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

    const counts = await draw(20);

    expect(counts.get(cards[0]!)).toBe(10);
    expect(counts.get(cards[1]!)).toBe(10);
  });

  it('leaves the queue alone when a verification is reverted', async () => {
    // Reverting an approval does not un-receive the money, and rewinding the
    // cursor would need the whole history of what it was before. The card keeps
    // its lap. Written down because it is a choice, not an oversight.
    const cards = await pool(2);
    const id = await openClaim(cards[0]!);
    await db.prepare(`UPDATE payment_claims SET status = 'VERIFIED' WHERE id = ?1`).bind(id).run();
    await db.prepare(`UPDATE payment_claims SET status = 'REJECTED' WHERE id = ?1`).bind(id).run();

    const counts = await draw(20);

    expect(counts.get(cards[0]!) ?? 0).toBe(0);
    expect(counts.get(cards[1]!)).toBe(20);
  });
});
