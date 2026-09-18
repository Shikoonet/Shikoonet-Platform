/**
 * «احتمالاً فاکتور X» on a deposit nobody claimed (#275).
 *
 * An invoice dies with its card hold (#274), and a customer who pays after
 * that lands in «واریزی‌ها» with no claim. The row names the expired invoice
 * that fits — same amount, a card mapped to the account the SMS came in on,
 * issued in the 24 hours before the deposit — and nothing else: no match,
 * no verification, no claim.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applySchema, env as baseEnv } from "./helpers/env.js";
import { app } from "../src/index.js";

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
       (id, bank_name, display_name, owner_label, account_type, active, status, parser_configuration, created_at, updated_at)
       VALUES (?1,'Melli',?2,NULL,'CARD',1,'ACTIVE','{}',?3,?3)`,
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
  await baseEnv.DB.prepare(`DELETE FROM reconciliation_matches`).run();
  await baseEnv.DB.prepare(`DELETE FROM payment_claims`).run();
  await baseEnv.DB.prepare(`DELETE FROM transaction_candidates`).run();
  await baseEnv.DB.prepare(`DELETE FROM raw_sms_events`).run();
});

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
  } = {},
) {
  await baseEnv.DB.prepare(
    `INSERT INTO payments (public_id, user_id, amount_irr, method, status, assigned_card_number, created_at)
     VALUES (?1, ?2, ?3, 'CARD_TO_CARD', ?4, ?5, to_timestamp(?6 / 1000.0))`,
  )
    .bind(
      publicId,
      opts.user === undefined ? userId : opts.user,
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
