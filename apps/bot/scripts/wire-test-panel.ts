/**
 * Points the simulation catalogue at the REAL PasarGuard test panel.
 *
 *   corepack pnpm --filter @shikoo/bot panel:wire-test
 *
 * The head admin delivered a dedicated test panel on 2026-08-18. Until then the
 * only way to prove a delivery was creating a throwaway account on the live
 * customer panel and deleting it in a `finally` — it worked, and it walked the
 * edge every time. This wires a normal product/plan/provider chain to the test
 * panel so the whole path can be exercised without going near a customer.
 *
 * WHY A SCRIPT AND NOT SEED DATA. The panel's URL and admin password live in
 * `sim/.env.local`, which is git-ignored, and they must stay out of the
 * repository. The seed is committed, deterministic data; this is a local
 * pointer at a machine only we can reach. So the rows are built here from the
 * environment, and the file itself contains no secret.
 *
 * WHY IT EXISTS AT ALL. The rows were first typed in by hand. A hand-typed row
 * disappears the next time the simulation database is rebuilt, and the next
 * person re-derives it from nothing — which is how `base_url` ended up still
 * pointing at the fake panel while everything else looked wired.
 *
 * Idempotent: run it as often as you like. It writes ONLY the provider,
 * product and plan it owns, all three keyed by code, and touches nothing else.
 * It refuses to run against anything but a local database — see `assertLocal`.
 */

import { createPostgresD1 } from '@shikoo/db';

/** The code all three rows are keyed by, and the secret_ref `credentialsFor` resolves. */
const CODE = 'test-panel';

/**
 * The product carries its own code because a product is not a panel: one panel
 * can sell several, and 'test-panel' is already taken by the provider.
 */
const PRODUCT_CODE = 'test-panel-vpn';

/**
 * Nothing here may touch a real database.
 *
 * This script writes to the catalogue — the table that decides where a
 * customer's order is delivered. On the simulation that is free; on production
 * it would silently repoint a live product at a test panel, and the first
 * evidence would be a customer receiving a config from the wrong server. The
 * host is checked rather than trusted because `DATABASE_URL` is one shell
 * variable away from being the wrong one.
 */
function assertLocal(connectionString: string): void {
  const host = new URL(connectionString).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    throw new Error(
      `refusing to write the catalogue on a non-local database (host ${host}). ` +
        'This script is for the simulation only.',
    );
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. It belongs in sim/.env.local.`);
  return value;
}

async function main(): Promise<number> {
  const connectionString = required('DATABASE_URL');
  assertLocal(connectionString);

  const panelUrl = required('PANEL_TEST_PANEL_URL').replace(/\/+$/, '');
  // Read only to fail early with a useful message. The value is never printed
  // and never written to the database — `credentialsFor` reads it at run time
  // from `PANEL_<SECRET_REF>`, which is why secret_ref is the code below.
  required('PANEL_TEST_PANEL');

  // The panel has exactly one group, id 1, and production's 42/2 do not exist
  // here. Sending those is the failure this whole chain was built after.
  const groupIds = (process.env['PANEL_TEST_PANEL_GROUP_IDS'] ?? '1')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n));
  if (groupIds.length === 0) throw new Error('PANEL_TEST_PANEL_GROUP_IDS parsed to no group at all');

  const { db, pool } = createPostgresD1({ connectionString });
  try {
    const provider = await db
      .prepare(
        `INSERT INTO provisioning_providers (code, name, kind, status, base_url, secret_ref, config)
         VALUES (?1, ?2, 'pasarguard', 'ACTIVE', ?3, ?1, ?4::jsonb)
         ON CONFLICT (code) DO UPDATE
            SET base_url = excluded.base_url,
                secret_ref = excluded.secret_ref,
                config = excluded.config,
                status = 'ACTIVE',
                kind = 'pasarguard',
                updated_at = now()
         RETURNING id`,
      )
      .bind(CODE, 'پنل تست', panelUrl, JSON.stringify({ group_ids: groupIds }))
      .first<{ id: number }>();
    if (!provider) throw new Error('the provider row came back empty');

    const product = await db
      .prepare(
        // `products.kind` is what the customer buys ('vpn'), not how it is
        // delivered — that is the provider's `kind`. The two are different
        // vocabularies on purpose and 'pasarguard' is only valid in the second.
        `INSERT INTO products (code, name, kind, provider_id, status, description)
         VALUES (?1, ?2, 'vpn', ?3, 'ACTIVE', ?4)
         ON CONFLICT (code) DO UPDATE
            SET provider_id = excluded.provider_id, status = 'ACTIVE', updated_at = now()
         RETURNING id`,
      )
      .bind(PRODUCT_CODE, 'سرویس تست', provider.id, 'روی پنل تست — مشتری واقعی ندارد')
      .first<{ id: number }>();
    if (!product) throw new Error('the product row came back empty');

    // No ON CONFLICT: plans have no unique code, so the plan is found by
    // (product, name) and inserted only when it is genuinely absent. Blindly
    // inserting would leave a second identical plan on every run.
    const existing = await db
      .prepare(`SELECT id FROM product_plans WHERE product_id = ?1 AND name = ?2`)
      .bind(product.id, PLAN_NAME)
      .first<{ id: number }>();
    const planId =
      existing?.id ??
      (
        await db
          .prepare(
            `INSERT INTO product_plans (product_id, name, price_irr, duration_days, volume_gb, status)
             VALUES (?1, ?2, ?3, 30, 10, 'ACTIVE') RETURNING id`,
          )
          .bind(product.id, PLAN_NAME, PLAN_PRICE_IRR)
          .first<{ id: number }>()
      )?.id;

    console.log(`provider ${provider.id} (${CODE}) -> ${panelUrl}, groups ${groupIds.join(',')}`);
    console.log(`product  ${product.id}, plan ${planId}`);
    console.log('credentials are read at run time from PANEL_TEST_PANEL — nothing was stored.');
    return 0;
  } finally {
    await pool.end();
  }
}

/** Ten gigabytes for thirty days, at the same 123,000 toman the hand-typed row used. */
const PLAN_NAME = '۱۰ گیگ / ۳۰ روز — ۱۲۳٬۰۰۰ تومان';
const PLAN_PRICE_IRR = 1_230_000;

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(String(err instanceof Error ? err.message : err));
    process.exit(2);
  });
