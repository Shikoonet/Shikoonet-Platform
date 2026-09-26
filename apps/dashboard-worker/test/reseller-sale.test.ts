/**
 * The two dashboard switches the reseller sale adds (#474).
 *
 *   - An account's audience (0104 widened `customer_visible` to 0/1/2): only an
 *     ADMIN moves an account into or out of the resellers' line, because either
 *     way it decides where money lands. A reviewer keeps the on/off it had.
 *   - A panel's price table: saved in IRR under `config.reseller_sale`, read
 *     back in Toman through the function the bot sells with, refused when it
 *     would save and sell nothing.
 *
 * Every assertion reads the COLUMN back rather than trusting the response —
 * the arrangement `account-active.test.ts` explains.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resellerSaleFor } from '@shikoo/domain';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-rsale@example.com';
const REVIEWER = 'reviewer-rsale@example.com';
const PREFIX = 'zz-rsale-';
const PANEL = 'rsale-panel';

function envAs(email = ADMIN) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

async function audienceOf(id: string): Promise<number> {
  const row = await baseEnv.DB.prepare(`SELECT customer_visible FROM financial_accounts WHERE id = ?1`)
    .bind(id)
    .first<{ customer_visible: number }>();
  return Number(row!.customer_visible);
}

function patchAccount(id: string, body: unknown, email = ADMIN) {
  return app.request(
    `/api/v1/accounts/${id}`,
    { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    envAs(email),
  );
}

let panelId: number;

function savePanel(body: unknown) {
  return app.request(
    `/api/v1/admin/panels/${panelId}`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    envAs(ADMIN),
  );
}

async function configOf(): Promise<Record<string, unknown>> {
  const row = await baseEnv.DB.prepare(`SELECT config FROM provisioning_providers WHERE id = ?1`)
    .bind(panelId)
    .first<{ config: Record<string, unknown> }>();
  return row!.config;
}

/** A fixed instant for the fixtures, so nothing here reads the live clock. */
const FIXTURE_MS = Date.UTC(2026, 8, 26, 9, 0, 0);

beforeAll(async () => {
  await applySchema();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
      .bind(`rsale-fixture-${role.toLowerCase()}`, email, role, FIXTURE_MS)
      .run();
  }
  const panel = await baseEnv.DB.prepare(
    `INSERT INTO provisioning_providers (code, name, kind, status, base_url, config)
     VALUES (?1, 'پنل فروش نماینده', 'pasarguard', 'ACTIVE', 'https://rsale.invalid', '{}'::jsonb)
     ON CONFLICT (code) DO UPDATE SET config = '{}'::jsonb
     RETURNING id`,
  )
    .bind(PANEL)
    .first<{ id: number }>();
  panelId = panel!.id;
});

beforeEach(async () => {
  await baseEnv.DB.prepare(`DELETE FROM financial_accounts WHERE id LIKE ?1`).bind(`${PREFIX}%`).run();
  await baseEnv.DB.prepare(
    `INSERT INTO financial_accounts
       (id, bank_name, display_name, account_type, active, customer_visible,
        parser_configuration, status, created_at, updated_at)
     VALUES (?1, 'BANK', 'حساب تست', 'ACCOUNT', 1, 1, '{}', 'ACTIVE', 1, 1)`,
  )
    .bind(`${PREFIX}a`)
    .run();
});

describe('an account’s audience', () => {
  it('an ADMIN moves an account into the resellers’ line and back', async () => {
    expect((await patchAccount(`${PREFIX}a`, { customer_visible: 2 })).status).toBe(200);
    expect(await audienceOf(`${PREFIX}a`)).toBe(2);
    expect((await patchAccount(`${PREFIX}a`, { customer_visible: 1 })).status).toBe(200);
    expect(await audienceOf(`${PREFIX}a`)).toBe(1);
  });

  it('a reviewer cannot move it in or out, and keeps the on/off they had', async () => {
    expect((await patchAccount(`${PREFIX}a`, { customer_visible: 2 }, REVIEWER)).status).toBe(403);
    expect(await audienceOf(`${PREFIX}a`)).toBe(1);
    // The switch the older screen sends still works for them.
    expect((await patchAccount(`${PREFIX}a`, { customer_visible: false }, REVIEWER)).status).toBe(200);
    expect(await audienceOf(`${PREFIX}a`)).toBe(0);

    await patchAccount(`${PREFIX}a`, { customer_visible: 2 });
    // Out of the resellers' line is the owner's call too — even to «off».
    expect((await patchAccount(`${PREFIX}a`, { customer_visible: true }, REVIEWER)).status).toBe(403);
    expect((await patchAccount(`${PREFIX}a`, { customer_visible: 0 }, REVIEWER)).status).toBe(403);
    expect(await audienceOf(`${PREFIX}a`)).toBe(2);
  });

  it('refuses an audience the column does not have', async () => {
    expect((await patchAccount(`${PREFIX}a`, { customer_visible: 3 })).status).toBe(400);
  });
});

describe('a panel’s reseller price table', () => {
  const table = {
    tiers: [
      { fromTb: 1, pricePerTbToman: 3_000_000 },
      { fromTb: 3, pricePerTbToman: 2_000_000 },
    ],
    roleId: 4,
    termDays: 90,
    maxOrderToman: null,
  };

  it('stores IRR, and the bot reads what the operator typed', async () => {
    expect((await savePanel({ resellerSale: table })).status).toBe(200);
    const config = await configOf();
    expect(config['reseller_sale']).toEqual({
      tiers: [
        { from_tb: 1, price_per_tb_irr: 30_000_000 },
        { from_tb: 3, price_per_tb_irr: 20_000_000 },
      ],
      role_id: 4,
      term_days: 90,
      max_order_irr: null,
    });
    // The bot's own reader agrees.
    expect(resellerSaleFor(config)?.tiers).toEqual([
      { fromTb: 1, pricePerTbIrr: 30_000_000 },
      { fromTb: 3, pricePerTbIrr: 20_000_000 },
    ]);
    const list = await app.request('/api/v1/admin/panels', {}, envAs(ADMIN));
    const item = ((await list.json()) as { items: { id: number; resellerSale: unknown }[] }).items.find(
      (p) => p.id === panelId,
    );
    expect(item?.resellerSale).toEqual(table);
  });

  it('refuses a table that would save and sell nothing', async () => {
    const outOfOrder = { ...table, tiers: [table.tiers[1], table.tiers[0]] };
    expect((await savePanel({ resellerSale: outOfOrder })).status).toBe(400);
    // The smallest order over the per-order cap: nobody could ever buy.
    expect((await savePanel({ resellerSale: { ...table, maxOrderToman: 2_000_000 } })).status).toBe(400);
    // Role 1 is PasarGuard's owner.
    expect((await savePanel({ resellerSale: { ...table, roleId: 1 } })).status).toBe(400);
    // Above one card-to-card transfer.
    expect((await savePanel({ resellerSale: { ...table, maxOrderToman: 10_000_001 } })).status).toBe(400);
  });

  it('stops selling with null', async () => {
    await savePanel({ resellerSale: table });
    expect((await savePanel({ resellerSale: null })).status).toBe(200);
    expect(resellerSaleFor(await configOf())).toBeNull();
  });
});
