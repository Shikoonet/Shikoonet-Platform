/**
 * One account, several numbers (#316).
 *
 * Bank Keshavarzi keys the same account by its full number in one SMS
 * («واریز پل …») and by `کارت*XXXX` in the next. Whichever the bank sends,
 * the deposit has to land on the account — so an account carries as many
 * identifiers as the bank uses, added and removed from the edit form.
 *
 * `POST /accounts/:id/identifier` used to overwrite the canonical column for
 * a canonical kind; a second account number silently replaced the first.
 * Every test here asks the resolver, not the table, like
 * `account-identifier-sync.test.ts`: the table is the mechanism, whether an
 * SMS lands is the fact.
 */

import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveAccountByHint } from "@shikoo/domain";
import { applySchema, env as baseEnv } from "./helpers/env.js";
import { app } from "../src/index.js";

const ADMIN = "admin-idmany@example.com";
const PREFIX = "zz-idmany-";

function envAs(email = ADMIN) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

async function createAccount(body: Record<string, unknown>): Promise<string> {
  const res = await app.request(
    "/api/v1/accounts",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bank_name: "BANK",
        account_type: "ACCOUNT",
        ...body,
        display_name: `${PREFIX}${String(body.display_name ?? "x")}`,
      }),
    },
    envAs(),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

function add(id: string, body: unknown) {
  return app.request(
    `/api/v1/accounts/${id}/identifier`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    envAs(),
  );
}

function remove(id: string, identId: string) {
  return app.request(
    `/api/v1/accounts/${id}/identifier/${identId}`,
    { method: "DELETE" },
    envAs(),
  );
}

async function resolves(hint: string): Promise<string | "none" | "ambiguous"> {
  const r = await resolveAccountByHint(baseEnv.DB, hint);
  if (r.status === "OK") return r.accountId;
  if (r.status === "NOT_FOUND") return "none";
  return "ambiguous";
}

async function identifiersOf(id: string) {
  const rows = await baseEnv.DB.prepare(
    `SELECT id, kind, value FROM financial_account_identifiers
      WHERE financial_account_id = ?1 ORDER BY kind, value`,
  )
    .bind(id)
    .all<{ id: string; kind: string; value: string }>();
  return rows.results;
}

async function columnsOf(id: string) {
  return baseEnv.DB.prepare(
    `SELECT account_hint, card_last_four FROM financial_accounts WHERE id = ?1`,
  )
    .bind(id)
    .first<{ account_hint: string | null; card_last_four: string | null }>();
}

beforeAll(async () => {
  await applySchema();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
  )
    .bind(crypto.randomUUID(), ADMIN, Date.now())
    .run();
});

beforeEach(async () => {
  await baseEnv.DB.prepare(
    `DELETE FROM financial_accounts WHERE display_name LIKE ?1`,
  )
    .bind(`${PREFIX}%`)
    .run();
});

describe("an account with more than one number", () => {
  it("answers to a second account number without losing the first", async () => {
    // The Keshavarzi case: the full number and a card, both keys of one account.
    const id = await createAccount({
      display_name: "bki",
      account_hint: "31900001",
    });

    expect(
      (await add(id, { kind: "ACCOUNT_HINT", value: "0031900001" })).status,
    ).toBe(200);
    expect(
      (await add(id, { kind: "CARD_LAST_FOUR", value: "6037" })).status,
    ).toBe(200);

    expect(await resolves("31900001")).toBe(id);
    expect(await resolves("0031900001")).toBe(id);
    expect(await resolves("6037")).toBe(id);
    // The column kept the number the account was created with …
    expect(await columnsOf(id)).toEqual({
      account_hint: "31900001",
      card_last_four: "6037",
    });
  });

  it("fills an empty column the way «create» would have, and only an empty one", async () => {
    const id = await createAccount({ display_name: "empty" });
    expect(
      (await add(id, { kind: "CARD_LAST_FOUR", value: "1111" })).status,
    ).toBe(200);
    expect(
      (await add(id, { kind: "CARD_LAST_FOUR", value: "2222" })).status,
    ).toBe(200);

    expect((await columnsOf(id))?.card_last_four).toBe("1111");
    expect(await resolves("1111")).toBe(id);
    expect(await resolves("2222")).toBe(id);
  });

  it("adding the same number twice is one row", async () => {
    const id = await createAccount({
      display_name: "twice",
      account_hint: "5005",
    });
    expect(
      (await add(id, { kind: "ACCOUNT_HINT", value: "5005" })).status,
    ).toBe(200);
    expect(
      (await add(id, { kind: "ACCOUNT_HINT", value: "5005" })).status,
    ).toBe(200);
    expect(await identifiersOf(id)).toHaveLength(1);
  });

  it("refuses a number another account already answers to", async () => {
    const owner = await createAccount({
      display_name: "owner",
      account_hint: "9001",
    });
    const other = await createAccount({
      display_name: "other",
      account_hint: "9002",
    });

    const res = await add(other, { kind: "ACCOUNT_HINT", value: "9001" });
    expect(res.status).toBe(409);
    expect(await resolves("9001")).toBe(owner);
    expect(await identifiersOf(other)).toHaveLength(1);
  });

  it("takes an extra number away, and the SMS for it no longer lands", async () => {
    const id = await createAccount({
      display_name: "rm",
      account_hint: "7001",
    });
    expect(
      (await add(id, { kind: "ACCOUNT_HINT", value: "7002" })).status,
    ).toBe(200);
    const extra = (await identifiersOf(id)).find((r) => r.value === "7002")!;

    const res = await remove(id, extra.id);
    expect(res.status).toBe(200);

    expect(await resolves("7002")).toBe("none");
    expect(await resolves("7001")).toBe(id);
    const audit = await baseEnv.DB.prepare(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'account.identifier_removed' AND entity_id = ?1`,
    )
      .bind(id)
      .first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("will not remove the row that mirrors a column — that is the field above", async () => {
    const id = await createAccount({
      display_name: "mirror",
      account_hint: "8001",
    });
    const mirror = (await identifiersOf(id))[0]!;

    const res = await remove(id, mirror.id);
    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({
      error: "identifier_mirrors_column",
    });
    expect(await resolves("8001")).toBe(id);
  });

  it("cannot reach another account's row through this account's id", async () => {
    const a = await createAccount({ display_name: "a", account_hint: "6001" });
    const b = await createAccount({ display_name: "b", account_hint: "6002" });
    expect((await add(b, { kind: "ACCOUNT_HINT", value: "6003" })).status).toBe(
      200,
    );
    const bExtra = (await identifiersOf(b)).find((r) => r.value === "6003")!;

    expect((await remove(a, bExtra.id)).status).toBe(404);
    expect(await resolves("6003")).toBe(b);
  });
});
