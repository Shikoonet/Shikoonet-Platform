/**
 * Turning a payment card off, and the queue position that survives it.
 *
 * The bot half of this is already proved elsewhere: `rotation.test.ts` draws 60
 * checkouts and a DISABLED card takes none of them, and `pay.test.ts` shows the
 * customer «کارتی موجود نیست» rather than a checkout with nowhere to pay when
 * every card is off. What did not exist was any way to turn one off — `PATCH
 * /api/v1/payment-cards/:id` accepted `displayWeight` and nothing else, so a
 * card could only be DELETED. Deleting is not the same act: the digits are
 * UNIQUE, so a deleted card cannot be re-added while any history references it,
 * and the audit trail loses the row that received the money.
 *
 * The half worth testing is what happens on the way BACK. `rotation_cursor` is
 * the card's place in the bakery queue (0064), and a card switched off months
 * ago still holds the ticket it had then — in front of every card that has
 * taken money since. Re-enabling is the same event as adding, and both draw a
 * fresh ticket from the queue sequence: the card joins the back of the line.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ACCOUNT = 'card-status-account';
const READER = 'card-status-reader@example.com';
const REVIEWER = 'card-status-reviewer@example.com';

/**
 * A fresh card id per test.
 *
 * `audit_logs` is append-only — the trigger refuses DELETE, which is the point
 * of the table — so a test cannot clear the rows it wrote. Reusing one card id
 * would leave each test reading the previous test's audit row. Unique ids cost
 * nothing and remove the question.
 */
let seq = 0;
let A = '';
let B = '';
let C = '';

function envAs(email?: string) {
  return email ? { ...baseEnv, TEST_ACCESS_USER: email } : baseEnv;
}

async function patch(id: string, body: unknown, email?: string) {
  return app.fetch(
    new Request(`https://example.com/api/v1/payment-cards/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: JSON.stringify(body),
    }),
    envAs(email),
  );
}

async function card(id: string) {
  return baseEnv.DB.prepare(
    `SELECT id, status, holder_name, rotation_cursor FROM payment_cards WHERE id = ?1`,
  )
    .bind(id)
    .first<{
      id: string;
      status: string;
      holder_name: string | null;
      rotation_cursor: number;
    }>();
}

/**
 * `cursor` is a hand-written ticket, or 'next' for one drawn from the queue
 * sequence the way the routes draw them. Tickets only ever come from that
 * sequence in production, so a test that wants "in front of / behind" has to
 * draw its comparison tickets from it too — a literal 40,000,000 is above
 * the sequence on a fresh database and below it on the sim database.
 */
async function seedCard(id: string, digits: string, cursor: number | 'next', status = 'ACTIVE') {
  await baseEnv.DB.prepare(
    `INSERT INTO payment_cards
       (id, financial_account_id, card_digits, holder_name, created_at, status, rotation_cursor)
     VALUES (?1, ?2, ?3, NULL, 1, ?4,
             CASE WHEN ?6 = 1 THEN nextval('payment_card_queue_seq') ELSE ?5 END)`,
  )
    .bind(id, ACCOUNT, digits, status, cursor === 'next' ? 0 : cursor, cursor === 'next' ? 1 : 0)
    .run();
}

async function cursorOf(id: string): Promise<number> {
  return (await card(id))!.rotation_cursor;
}

beforeAll(async () => {
  await applySchema();
  // Both identities have to exist as rows: `TEST_ACCESS_USER` pins WHO is
  // asking, not WHAT they may do, so an unseeded admin answers 401 and every
  // assertion below would be measuring the door instead of the route.
  for (const [email, role] of [
    [baseEnv.TEST_ACCESS_USER!, 'ADMIN'],
    [READER, 'READ_ONLY'],
    [REVIEWER, 'REVIEWER'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, 1, 1)
       ON CONFLICT (email) DO UPDATE SET role = excluded.role, active = 1`,
    )
      .bind(crypto.randomUUID(), email, role)
      .run();
  }
});

beforeEach(async () => {
  await baseEnv.DB.prepare(`DELETE FROM payment_cards WHERE financial_account_id = ?1`)
    .bind(ACCOUNT)
    .run();
  await baseEnv.DB.prepare(`DELETE FROM financial_accounts WHERE id = ?1`).bind(ACCOUNT).run();
  await baseEnv.DB.prepare(
    `INSERT INTO financial_accounts
       (id, bank_name, display_name, owner_label, account_type, account_hint,
        card_last_four, account_last_four, iban, device_id, active,
        parser_configuration, status, created_at, updated_at)
     VALUES (?1, 'BANK', 'card-status account', NULL, 'ACCOUNT', 'card-status-hint',
             NULL, NULL, NULL, NULL, 1, '{}', 'ACTIVE', 1, 1)`,
  )
    .bind(ACCOUNT)
    .run();
  seq += 1;
  A = `card-status-${seq}-a`;
  B = `card-status-${seq}-b`;
  C = `card-status-${seq}-c`;
});

describe('switching a card off and on', () => {
  it('turns a card off, and the row says so', async () => {
    await seedCard(A, '5047061674737313', 1_000_000);

    const res = await patch(A, { status: 'DISABLED' });

    expect(res.status).toBe(200);
    expect(await card(A)).toMatchObject({ status: 'DISABLED' });
  });

  it('turns it back on', async () => {
    await seedCard(A, '5047061674737313', 1_000_000, 'DISABLED');

    expect((await patch(A, { status: 'ACTIVE' })).status).toBe(200);
    expect(await card(A)).toMatchObject({ status: 'ACTIVE' });
  });

  it('sends a re-enabled card to the back of the line', async () => {
    // The card was switched off early and kept its old ticket; its peers have
    // taken money since and drawn new ones. Coming back in FRONT of them means
    // it takes every checkout until each of them has taken money again — a
    // shop showing one card all afternoon.
    await seedCard(A, '5047061674737313', 1_000_000, 'DISABLED');
    await seedCard(B, '5047061674687526', 'next');
    await seedCard(C, '5047061153142274', 'next');

    await patch(A, { status: 'ACTIVE' });

    expect(await cursorOf(A)).toBeGreaterThan(await cursorOf(C));
    expect(await cursorOf(C)).toBeGreaterThan(await cursorOf(B));
  });

  it('leaves the cursor alone when the card is only being switched OFF', async () => {
    // Nothing about turning a card off should move the queue; the seed happens
    // on the way back in, once, and doing it here as well would double-count.
    await seedCard(A, '5047061674737313', 1_000_000);
    await seedCard(B, '5047061674687526', 40_000_000);

    await patch(A, { status: 'DISABLED' });

    expect((await card(A))?.rotation_cursor).toBe(1_000_000);
  });

  it('does not move the cursor when the card was already ACTIVE', async () => {
    // A UI that PATCHes the whole row on every save must not reshuffle the queue
    // for a no-op. The seed is for the DISABLED -> ACTIVE transition only.
    await seedCard(A, '5047061674737313', 1_000_000);
    await seedCard(B, '5047061674687526', 40_000_000);

    await patch(A, { status: 'ACTIVE' });

    expect((await card(A))?.rotation_cursor).toBe(1_000_000);
  });

  it('records the change, because a card that stopped taking money needs a why', async () => {
    await seedCard(A, '5047061674737313', 1_000_000);

    await patch(A, { status: 'DISABLED' });

    const row = await baseEnv.DB.prepare(
      `SELECT action, before_json, after_json FROM audit_logs
        WHERE entity_type = 'PAYMENT_CARD' AND entity_id = ?1`,
    )
      .bind(A)
      .first<{ action: string; before_json: string; after_json: string }>();
    expect(row).not.toBeNull();
    expect(JSON.parse(row!.before_json)).toMatchObject({ status: 'ACTIVE' });
    expect(JSON.parse(row!.after_json)).toMatchObject({ status: 'DISABLED' });
  });
});

describe('the rest of the edit', () => {
  it('no longer knows a display weight — the queue has no use for one', async () => {
    // `display_weight` went with migration 0064. A body that still sends it is
    // a stale client, and `.strict()` makes that a 400 rather than a silent drop.
    await seedCard(A, '5047061674737313', 1_000_000);

    expect((await patch(A, { displayWeight: 5 })).status).toBe(400);
  });

  it('names the card holder — in the column the bot prints on the invoice', async () => {
    // `holder_name`, not a second column. Until 0068 this route wrote `label`,
    // `rotateCard` returned `holder_name`, and three production cards went to
    // customers nameless with the owner's name saved on every one of them.
    await seedCard(A, '5047061674737313', 1_000_000);

    expect((await patch(A, { holderName: 'پویان بهمن' })).status).toBe(200);
    expect(await card(A)).toMatchObject({ holder_name: 'پویان بهمن' });
  });

  it('still refuses the column that went with 0068', async () => {
    await seedCard(A, '5047061674737313', 1_000_000);

    expect((await patch(A, { label: 'کارت پویان' })).status).toBe(400);
  });

  it('clears the name when asked to, which is not the same as not asking', async () => {
    // The distinction the SQL turns on. `holder_name` cannot be COALESCEd
    // against the existing value, because null is a real value — it means «no
    // name on the invoice» — so an explicit null has to be told apart from an
    // absent field.
    await seedCard(A, '5047061674737313', 1_000_000);
    await patch(A, { holderName: 'پویان بهمن' });

    await patch(A, { holderName: null });

    expect((await card(A))?.holder_name).toBeNull();
  });

  it('leaves the name alone when the call is about something else', async () => {
    await seedCard(A, '5047061674737313', 1_000_000);
    await patch(A, { holderName: 'پویان بهمن' });

    await patch(A, { status: 'DISABLED' });

    expect(await card(A)).toMatchObject({ holder_name: 'پویان بهمن', status: 'DISABLED' });
  });

  it('changes name and status in one call without losing either', async () => {
    await seedCard(A, '5047061674737313', 1_000_000);

    await patch(A, { holderName: 'پویان بهمن', status: 'DISABLED' });

    expect(await card(A)).toMatchObject({ holder_name: 'پویان بهمن', status: 'DISABLED' });
  });
});

describe('what the route refuses', () => {
  it('refuses a status that is not one of the two', async () => {
    await seedCard(A, '5047061674737313', 1_000_000);

    expect((await patch(A, { status: 'PAUSED' })).status).toBe(400);
    expect(await card(A)).toMatchObject({ status: 'ACTIVE' });
  });

  it('refuses a body that asks for nothing', async () => {
    // It has to be a 400 on purpose, or a UI bug silently writes an audit row
    // recording that nothing changed.
    await seedCard(A, '5047061674737313', 1_000_000);

    expect((await patch(A, {})).status).toBe(400);
  });

  it('refuses an operator who may only read', async () => {
    await seedCard(A, '5047061674737313', 1_000_000);

    expect((await patch(A, { status: 'DISABLED' }, READER)).status).toBe(403);
    expect(await card(A)).toMatchObject({ status: 'ACTIVE' });
  });

  /**
   * A REVIEWER may add a card and may delete one. Disabling is the smaller act.
   *
   * This route guarded on `role !== 'ADMIN'` while its two siblings — POST
   * add-card and DELETE card — guard on `role === 'READ_ONLY'`. The screen
   * followed the siblings: the toggle spreads `useWriteProps`, which is
   * `role !== 'READ_ONLY'`, so a REVIEWER was shown an enabled «خاموش کن» that
   * answered 403 and surfaced as «خاموش کردن ناموفق بود (403)».
   *
   * Fixed by matching the siblings rather than by disabling the button: the
   * other direction leaves a REVIEWER able to DELETE a card but not to turn one
   * off, which is the wrong way round.
   */
  it('lets a reviewer switch a card off, like the add and delete beside it', async () => {
    await seedCard(A, '5047061674737313', 1_000_000);

    expect((await patch(A, { status: 'DISABLED' }, REVIEWER)).status).toBe(200);
    expect(await card(A)).toMatchObject({ status: 'DISABLED' });
  });

  it('404s on a card that does not exist', async () => {
    expect((await patch('card-status-nope', { status: 'DISABLED' })).status).toBe(404);
  });
});
