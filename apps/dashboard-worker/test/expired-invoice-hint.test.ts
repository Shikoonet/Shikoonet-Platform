/**
 * «احتمالاً فاکتور X» on a deposit nobody claimed (#275).
 *
 * An invoice dies with its card hold (#274), and a customer who pays after
 * that lands in «واریزی‌ها» with no claim. The row names the expired invoice
 * that fits — same amount, a card mapped to the account the SMS came in on,
 * issued in the 24 hours before the deposit — and nothing else: no match,
 * no verification, no claim.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema, env as baseEnv } from "./helpers/env.js";
import { app } from "../src/index.js";
import { alertLateDeposits } from "@shikoo/domain";
import { reportTopicKey } from "@shikoo/contracts";

const EMAIL = "admin-hint@example.com";
const ACCOUNT = "acc-hint";
const OTHER_ACCOUNT = "acc-hint-other";
const CARD = "6037991234567890";
const OTHER_CARD = "6037990000000000";
const AMOUNT = 2_500_000;
const HOUR = 60 * 60 * 1000;
const DEPOSIT_AT = 1_786_091_200_000;

function envAs(email = EMAIL) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

let userId: number;

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
  )
    .bind(crypto.randomUUID(), EMAIL, now)
    .run();
  for (const [id, name] of [
    [ACCOUNT, "Hint Target"],
    [OTHER_ACCOUNT, "Hint Other"],
  ]) {
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO financial_accounts
       (id, bank_name, display_name, owner_label, account_type, active, status, parser_configuration, created_at, updated_at, customer_visible)
       VALUES (?1,'Melli',?2,NULL,'CARD',1,'ACTIVE','{}',?3,?3,1)`,
    )
      .bind(id, name, now)
      .run();
  }
  for (const [card, account] of [
    [CARD, ACCOUNT],
    [OTHER_CARD, OTHER_ACCOUNT],
  ]) {
    await baseEnv.DB.prepare(
      `INSERT INTO payment_cards (id, financial_account_id, card_digits, created_at)
       VALUES (?1, ?2, ?3, ?4) ON CONFLICT (card_digits) DO UPDATE SET financial_account_id = excluded.financial_account_id`,
    )
      .bind(crypto.randomUUID(), account, card, now)
      .run();
  }
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO devices (id, device_code, display_name, active, created_at, updated_at)
     VALUES ('dev-hint', 'DEV-HINT', 'Hint Device', 1, ?1, ?1)`,
  )
    .bind(now)
    .run();
  const user = await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, registered_at) VALUES (990001, 'latepayer', now())
     ON CONFLICT (telegram_id) DO UPDATE SET username = excluded.username RETURNING id`,
  ).first<{ id: number }>();
  userId = user!.id;
});

beforeEach(async () => {
  await baseEnv.DB.prepare(
    `DELETE FROM payments WHERE public_id LIKE 'hint-%'`,
  ).run();
  await baseEnv.DB.prepare(
    `DELETE FROM orders WHERE public_id LIKE 'order-hint-%'`,
  ).run();
  await baseEnv.DB.prepare(`DELETE FROM reconciliation_matches`).run();
  await baseEnv.DB.prepare(`DELETE FROM payment_claims`).run();
  await baseEnv.DB.prepare(`DELETE FROM transaction_candidates`).run();
  await baseEnv.DB.prepare(`DELETE FROM raw_sms_events`).run();
});

/**
 * A customer an operator already credited by hand from their page, after the
 * deposit — 1 Mehr 1405. Its own user: a wallet entry cannot be deleted, and
 * `latepayer` must stay uncredited for the tests above.
 */
async function handPaidCustomer(): Promise<number> {
  const user = await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, registered_at) VALUES (990002, 'handpaid', now())
     ON CONFLICT (telegram_id) DO UPDATE SET username = excluded.username RETURNING id`,
  ).first<{ id: number }>();
  await baseEnv.DB.prepare(
    `INSERT INTO wallet_entries (user_id, amount_irr, kind, actor, note, idempotency_key)
     VALUES (?1, ?2, 'ADMIN_ADJUST', 'sam@example.com', 'اشتباه واریزی', ?3)`,
  )
    .bind(user!.id, AMOUNT, `admin-adjust:${user!.id}:${crypto.randomUUID()}`)
    .run();
  return user!.id;
}

async function seedDeposit(
  id: string,
  account: string | null = ACCOUNT,
  amount = AMOUNT,
) {
  const now = Date.now();
  await baseEnv.DB.prepare(
    `INSERT INTO raw_sms_events
       (id, device_id, sender, normalized_body, body_sha256, app_checksum, sms_timestamp,
        received_at, classification, parser_status, parser_id, parser_version, created_at)
     VALUES (?1,'dev-hint','TEST','seed',?2,'cksum',?3,?4,'BANK_CREDIT','OK','test','v1',?4)`,
  )
    .bind(`sms-${id}`, `hash-${id}`, DEPOSIT_AT, now)
    .run();
  await baseEnv.DB.prepare(
    `INSERT INTO transaction_candidates
       (id, raw_sms_event_id, financial_account_id, direction, amount_irr, status, bank_timestamp,
        confidence, parser_id, parser_version, parser_evidence_json, processing_disposition,
        created_at, updated_at)
     VALUES (?1, ?2, ?3, 'CREDIT', ?4, 'PARSED', ?5, 1.0, 'test', 'v1', '{}', 'ACTIONABLE', ?6, ?6)`,
  )
    .bind(id, `sms-${id}`, account, amount, DEPOSIT_AT, now)
    .run();
}

async function seedInvoice(
  publicId: string,
  opts: {
    status?: string;
    card?: string;
    amount?: number;
    issuedAt?: number;
    user?: number | null;
    /** The order the invoice was for, in this status; none when omitted. */
    order?: string;
  } = {},
) {
  const order = opts.order
    ? await baseEnv.DB.prepare(
        `INSERT INTO orders (public_id, user_id, kind, unit_price_irr, total_irr, status)
         VALUES (?1, ?2, 'NEW_PURCHASE', ?3, ?3, ?4) RETURNING id`,
      )
        .bind(`order-${publicId}`, userId, opts.amount ?? AMOUNT, opts.order)
        .first<{ id: number }>()
    : null;
  await baseEnv.DB.prepare(
    `INSERT INTO payments (public_id, user_id, order_id, amount_irr, method, status, assigned_card_number, created_at)
     VALUES (?1, ?2, ?3, ?4, 'CARD_TO_CARD', ?5, ?6, to_timestamp(?7 / 1000.0))`,
  )
    .bind(
      publicId,
      opts.user === undefined ? userId : opts.user,
      order?.id ?? null,
      opts.amount ?? AMOUNT,
      opts.status ?? "EXPIRED",
      opts.card ?? CARD,
      opts.issuedAt ?? DEPOSIT_AT - 2 * HOUR,
    )
    .run();
}

interface Hint {
  publicId: string;
  invoiceAt: number;
  customer: { id: number; telegramId: string; username: string | null } | null;
  others: number;
}

async function income(): Promise<
  Array<{ id: string; expiredInvoice: Hint | null }>
> {
  const res = await app.fetch(
    new Request("https://example.com/api/v1/payments?tab=income&range=all"),
    envAs(),
  );
  expect(res.status).toBe(200);
  return (
    (await res.json()) as {
      items: Array<{ id: string; expiredInvoice: Hint | null }>;
    }
  ).items;
}

describe("the expired invoice a late deposit probably belongs to", () => {
  it("names the invoice and the customer", async () => {
    await seedDeposit("t-late");
    await seedInvoice("hint-1");

    const [row] = await income();
    expect(row?.expiredInvoice).toEqual({
      publicId: "hint-1",
      invoiceAt: DEPOSIT_AT - 2 * HOUR,
      customer: { id: userId, telegramId: "990001", username: "latepayer" },
      others: 0,
    });
    // A hint, not a decision: the deposit is still unclaimed income.
    const claims = await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM payment_claims`,
    ).first<{
      n: number;
    }>();
    expect(claims?.n).toBe(0);
  });

  it("says nothing when nothing fits", async () => {
    await seedDeposit("t-alone");
    // Wrong amount, wrong card, still open, issued after the deposit, too old.
    await seedInvoice("hint-amount", { amount: AMOUNT + 10 });
    await seedInvoice("hint-card", { card: OTHER_CARD });
    await seedInvoice("hint-open", { status: "PENDING" });
    await seedInvoice("hint-after", { issuedAt: DEPOSIT_AT + 60_000 });
    await seedInvoice("hint-old", { issuedAt: DEPOSIT_AT - 25 * HOUR });

    const [row] = await income();
    expect(row?.expiredInvoice).toBeNull();
  });

  it("a deposit on no account gets no hint — the card says nothing about it", async () => {
    await seedDeposit("t-noacc", null);
    await seedInvoice("hint-noacc");
    const [row] = await income();
    expect(row?.expiredInvoice).toBeNull();
  });

  it("names the newest of several and counts the rest", async () => {
    await seedDeposit("t-many");
    await seedInvoice("hint-older", { issuedAt: DEPOSIT_AT - 5 * HOUR });
    await seedInvoice("hint-newer", { issuedAt: DEPOSIT_AT - 1 * HOUR });
    await seedInvoice("hint-oldest", {
      issuedAt: DEPOSIT_AT - 9 * HOUR,
      user: null,
    });

    const [row] = await income();
    expect(row?.expiredInvoice?.publicId).toBe("hint-newer");
    expect(row?.expiredInvoice?.others).toBe(2);
  });

  it("a card checkout closed because the order was paid from the wallet is not an invoice anyone is late on", async () => {
    await seedDeposit("t-wallet");
    // The wallet button leaves the order PAID and its card row EXPIRED — the
    // same word the sweep uses for an invoice nobody paid, on money that was
    // never owed to that card. The row must not be offered as the owner of a
    // stranger's deposit.
    await seedInvoice("hint-wallet", { order: "PAID" });
    expect((await income())[0]?.expiredInvoice).toBeNull();

    // The same row on an order that really ran out is still named, and the
    // paid one does not count among the «others».
    await seedInvoice("hint-ranout", { order: "EXPIRED", issuedAt: DEPOSIT_AT - 3 * HOUR });
    expect((await income())[0]?.expiredInvoice).toMatchObject({
      publicId: "hint-ranout",
      others: 0,
    });
  });

  it("an invoice whose customer is gone is still named, without a customer", async () => {
    await seedDeposit("t-gone");
    await seedInvoice("hint-gone", { user: null });
    const [row] = await income();
    expect(row?.expiredInvoice).toMatchObject({
      publicId: "hint-gone",
      customer: null,
    });
  });
});

/**
 * «شارژ کیف پول» — the door this hint was missing. The invoice is dead, so the
 * deposit goes to the customer's balance, once, and the bot tells them.
 * Deposit ids are fresh per run: a wallet entry is append-only, so a fixed id
 * would find itself already credited on the next run of this file.
 */
describe("«شارژ کیف پول» on a late deposit", () => {
  const REVIEWER = "reviewer-hint@example.com";

  async function walletBalance(): Promise<number> {
    const row = await baseEnv.DB.prepare(`SELECT balance_irr FROM wallets WHERE user_id = ?1`)
      .bind(userId)
      .first<{ balance_irr: number | string }>();
    return Number(row?.balance_irr ?? 0);
  }

  function creditWallet(id: string, body: unknown, email = EMAIL) {
    return app.fetch(
      new Request(`https://example.com/api/v1/transactions/${id}/credit-wallet`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      envAs(email),
    );
  }

  it("pays the deposit into the customer's wallet, messages them, and leaves «واریزی‌ها»", async () => {
    const id = `t-credit-${crypto.randomUUID()}`;
    await seedDeposit(id);
    await seedInvoice("hint-credit");
    const before = await walletBalance();

    const res = await creditWallet(id, { userId, reason: "paid after the invoice expired" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, amountIrr: AMOUNT, notified: true });

    expect(await walletBalance()).toBe(before + AMOUNT);
    expect((await income()).map((r) => r.id)).not.toContain(id);
    const note = await baseEnv.DB.prepare(
      `SELECT body FROM bot_notifications WHERE dedupe_key = ?1`,
    )
      .bind(`deposit-wallet:${id}`)
      .first<{ body: string }>();
    expect(note?.body).toContain("کیف پول شما شارژ شد");
    expect(note?.body).toContain(`${(AMOUNT / 10).toLocaleString("en-US")} تومان`);
    const audit = await baseEnv.DB.prepare(
      `SELECT actor_email FROM audit_logs WHERE action = 'transaction.credited_to_wallet' AND entity_id = ?1`,
    )
      .bind(id)
      .first<{ actor_email: string }>();
    expect(audit?.actor_email).toBe(EMAIL);

    // Once: the second press is refused and moves nothing.
    const again = await creditWallet(id, { userId, reason: "again" });
    expect(again.status).toBe(409);
    expect(await walletBalance()).toBe(before + AMOUNT);
  });

  it("is an ADMIN's act, and asks for a reason", async () => {
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, 'REVIEWER', 1, ?3, ?3)`,
    )
      .bind(crypto.randomUUID(), REVIEWER, Date.now())
      .run();
    const id = `t-credit-${crypto.randomUUID()}`;
    await seedDeposit(id);
    const before = await walletBalance();

    expect((await creditWallet(id, { userId, reason: "x" }, REVIEWER)).status).toBe(403);
    expect((await creditWallet(id, { userId, reason: " " })).status).toBe(400);
    expect((await creditWallet(id, { userId: 999_999_999, reason: "x" })).status).toBe(404);
    expect(await walletBalance()).toBe(before);
    expect((await income()).map((r) => r.id)).toContain(id);
  });

  it("refuses a customer credited by hand since the deposit, names it, and pays only when told to go on", async () => {
    const handId = await handPaidCustomer();
    const balanceOf = async () =>
      Number(
        (await baseEnv.DB.prepare(`SELECT balance_irr FROM wallets WHERE user_id = ?1`)
          .bind(handId)
          .first<{ balance_irr: number | string }>())?.balance_irr ?? 0,
      );
    const id = `t-credit-${crypto.randomUUID()}`;
    await seedDeposit(id);
    const before = await balanceOf();

    const refused = await creditWallet(id, { userId: handId, reason: "wrong amount" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      ok: false,
      error: "hand_credited",
      handCredit: { amountIrr: AMOUNT, note: "اشتباه واریزی", actor: "sam@example.com" },
    });
    expect(await balanceOf()).toBe(before);
    expect((await income()).map((r) => r.id)).toContain(id);

    const paid = await creditWallet(id, { userId: handId, reason: "a different payment", despiteHandCredit: true });
    expect(paid.status).toBe(200);
    expect(await balanceOf()).toBe(before + AMOUNT);
    const audit = await baseEnv.DB.prepare(
      `SELECT after_json FROM audit_logs WHERE action = 'transaction.credited_to_wallet' AND entity_id = ?1`,
    )
      .bind(id)
      .first<{ after_json: string }>();
    expect(JSON.parse(audit!.after_json)).toMatchObject({ userId: handId, despiteHandCredit: true });
  });
});

/**
 * The report group is told — 1 Mehr 1405, production: a 120,000 deposit for
 * an expired invoice sat in «واریزی‌ها» from 11:08 until the evening while the
 * customer raised eight more invoices. Sam: an alert, never an automatic credit.
 */
describe("the late deposit reaches the report group, once", () => {
  const GROUP = -1009990275;
  const TOPIC = 7;
  const at = (ms: number) => alertLateDeposits(baseEnv.DB, ms);
  const alerts = async () =>
    (
      await baseEnv.DB.prepare(
        `SELECT dedupe_key, chat_id, message_thread_id, body FROM bot_notifications
          WHERE dedupe_key LIKE 'report:paymentreport:late-deposit:%' ORDER BY id`,
      ).all<{ dedupe_key: string; chat_id: string | number; message_thread_id: number | null; body: string }>()
    ).results;

  beforeEach(async () => {
    await baseEnv.DB.prepare(
      `DELETE FROM bot_notifications WHERE dedupe_key LIKE 'report:paymentreport:late-deposit:%'`,
    ).run();
    for (const [key, value] of [
      ["Channel_Report", String(GROUP)],
      [reportTopicKey("paymentreport"), String(TOPIC)],
    ] as const) {
      await baseEnv.DB.prepare(
        `INSERT INTO settings (scope, key, value) VALUES ('bot', ?1, ?2::jsonb)
         ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
      )
        .bind(key, value)
        .run();
    }
  });

  // `settings` is shared by every file on this database; leave it as found.
  afterAll(async () => {
    await baseEnv.DB.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key IN ('Channel_Report', ?1)`)
      .bind(reportTopicKey("paymentreport"))
      .run();
  });

  it("names the deposit, the invoice and the customer, and says to credit the wallet", async () => {
    await seedDeposit("t-alert");
    await seedInvoice("hint-alert", { order: "EXPIRED" });

    expect(await at(DEPOSIT_AT + HOUR)).toBe(1);
    const [row] = await alerts();
    expect([row?.dedupe_key, Number(row?.chat_id), row?.message_thread_id]).toEqual([
      "report:paymentreport:late-deposit:t-alert",
      GROUP,
      TOPIC,
    ]);
    // 2,500,000 Rial is 250,000 Toman, the way the group reads money.
    expect(row?.body).toContain("۲۵۰٬۰۰۰ تومان");
    expect(row?.body).toContain("hint-alert");
    expect(row?.body).toContain("@latepayer");
    expect(row?.body).toContain("«شارژ کیف پول»");
    // Once: the next sweep finds it already said.
    expect(await at(DEPOSIT_AT + HOUR + 15_000)).toBe(0);
    expect(await alerts()).toHaveLength(1);
  });

  it("points at the customer's fresh invoice instead, when there is one for the same money", async () => {
    await seedDeposit("t-alert-open");
    await seedInvoice("hint-alert-old", { order: "EXPIRED" });
    // Raised after the old one expired, with a receipt waiting — production's @msterali777.
    await seedInvoice("hint-alert-new", { status: "AWAITING_REVIEW", issuedAt: DEPOSIT_AT + 30 * 60_000 });

    expect(await at(DEPOSIT_AT + HOUR)).toBe(1);
    const [row] = await alerts();
    expect(row?.body).toContain("hint-alert-new");
    expect(row?.body).toContain("«تخصیص»");
    expect(row?.body).not.toContain("«شارژ کیف پول»");
  });

  it("says the customer was already credited by hand, instead of sending the operator to credit them", async () => {
    const handId = await handPaidCustomer();
    await seedDeposit("t-alert-hand");
    await seedInvoice("hint-alert-hand", { order: "EXPIRED", user: handId });

    expect(await at(DEPOSIT_AT + HOUR)).toBe(1);
    const [row] = await alerts();
    expect(row?.body).toContain("@handpaid");
    expect(row?.body).toContain("۲۵۰٬۰۰۰ تومان دستی شارژ گرفته");
    expect(row?.body).toContain("«اشتباه واریزی»");
    expect(row?.body).not.toContain("«شارژ کیف پول»");
  });

  it("says nothing without an expired invoice, or about a deposit older than a day", async () => {
    await seedDeposit("t-alert-none");
    expect(await at(DEPOSIT_AT + HOUR)).toBe(0);

    await seedDeposit("t-alert-stale");
    await seedInvoice("hint-alert-stale", { order: "EXPIRED" });
    expect(await at(DEPOSIT_AT + 25 * HOUR)).toBe(0);
    expect(await alerts()).toHaveLength(0);
  });
});
