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

import { createHash } from 'node:crypto';
import { createPostgresD1 } from '@shikoo/db';

/** The code all three rows are keyed by, and the secret_ref `credentialsFor` resolves. */
const CODE = 'test-panel';

/**
 * A catalogue is not enough to buy anything.
 *
 * Wiring the panel got the shop as far as an order summary and no further: the
 * checkout hands the customer a bank card to pay into, and a fresh test
 * database has none, so the purchase stops one tap before the interesting part.
 * The same is true of the SMS that proves the money arrived — `POST
 * /api/v1/sms` authenticates a device, and there were no devices either.
 *
 * So this script sets up everything a purchase needs to run end to end, not
 * just the panel. Each row is keyed by a fixed id and written with
 * ON CONFLICT, so running it twice changes nothing.
 */
const ACCOUNT_ID = 'fa-test-panel';
const CARD_ID = 'pc-test-panel';
const DEVICE_ID = 'dev-test-panel';
const DEVICE_CODE = 'test-panel-phone';
const CREDENTIAL_ID = 'dc-test-panel';

/**
 * The card the test shop hands out.
 *
 * `603799` is Bank Melli's real issuer range, so `bank_card_prefixes` attributes
 * it the way a customer's card would be — the attribution is part of what is
 * being tested. The remaining ten digits are zeros and a Luhn check digit: the
 * number passes every validator and belongs to no account that exists.
 */
export const CARD_DIGITS = '6037991000000004';

/**
 * What the bank SMS calls the same account.
 *
 * A card number is what the customer is shown; it is not what arrives in the
 * shop's SMS. Melli writes `حساب:<account number>`, and ingest resolves that
 * against `account_hint` only — `card_last_four` answers a different question
 * and is deliberately not consulted for an account-number identifier. An
 * account row carrying only the card therefore looks unknown to ingest: the
 * first SMS auto-creates a PENDING account, the transaction is attributed to
 * that instead of to the shop, and the claim can never auto-verify.
 *
 * Verified against the running box on 2026-08-19, which did exactly that.
 */
const ACCOUNT_HINT = '0350000004';

/**
 * The product carries its own code because a product is not a panel: one panel
 * can sell several, and 'test-panel' is already taken by the provider.
 */
const PRODUCT_CODE = 'test-panel-vpn';

/**
 * Nothing here may touch a real database by accident.
 *
 * This script writes to the catalogue — the table that decides where a
 * customer's order is delivered. On the simulation that is free; on production
 * it would silently repoint a live product at a test panel, and the first
 * evidence would be a customer receiving a config from the wrong server. The
 * host is checked rather than trusted because `DATABASE_URL` is one shell
 * variable away from being the wrong one.
 *
 * The hostname is a proxy for "is this the simulation", and on 2026-08-19 that
 * proxy ran out: the Coolify staging box is a test environment too, and its
 * database is reachable only as a Docker service name. So the check now has an
 * escape hatch — one that cannot be taken by accident, because it names the
 * host it is being taken for. Setting it to `yes` would not do; the operator
 * has to have looked at the host they are about to write to.
 */
const OVERRIDE = 'WIRE_TEST_PANEL_ON_HOST';

export function assertLocal(connectionString: string): void {
  const host = new URL(connectionString).hostname;
  if (host === '127.0.0.1' || host === 'localhost' || host === '::1') return;
  if (process.env[OVERRIDE] === host) return;
  throw new Error(
    `refusing to write the catalogue on a non-local database (host ${host}). ` +
      'This script is for the simulation. If this really is a test environment, ' +
      `re-run it with ${OVERRIDE}=${host}.`,
  );
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
  if (groupIds.length === 0)
    throw new Error('PANEL_TEST_PANEL_GROUP_IDS parsed to no group at all');

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

    const now = Date.now();

    // The account the card resolves back to. Without it a claim decides
    // UNMAPPED_CARD and nothing can ever auto-verify — the seed hit exactly
    // this and says so in `packages/seed/src/generators.ts`.
    await db
      .prepare(
        `INSERT INTO financial_accounts
           (id, bank_name, display_name, owner_label, account_type,
            account_hint, card_last_four, active, status, parser_configuration,
            created_at, updated_at)
         VALUES (?1, 'MELLI', 'حساب تست', 'تست شیکو', 'CARD', ?2, ?3, 1, 'ACTIVE', '{}', ?4, ?4)
         ON CONFLICT (id) DO UPDATE
            SET account_hint = ?2, card_last_four = ?3,
                status = 'ACTIVE', active = 1, updated_at = ?4`,
      )
      .bind(ACCOUNT_ID, ACCOUNT_HINT, CARD_DIGITS.slice(-4), now)
      .run();

    await db
      .prepare(
        `INSERT INTO payment_cards
           (id, financial_account_id, card_digits, label, created_at,
            holder_name, status, display_weight, rotation_cursor)
         VALUES (?1, ?2, ?3, 'کارت تست', ?4, 'تست شیکو', 'ACTIVE', 1, 0)
         ON CONFLICT (id) DO UPDATE SET status = 'ACTIVE', financial_account_id = ?2`,
      )
      .bind(CARD_ID, ACCOUNT_ID, CARD_DIGITS, now)
      .run();

    // The sms-relay phone. Its key is never stored — only the hash the ingest
    // endpoint compares against, which is why the plaintext has to come from
    // the environment and is not printed back out.
    const deviceKey = required('SMS_TEST_DEVICE_KEY');
    await db
      .prepare(
        `INSERT INTO devices (id, device_code, display_name, description, active, created_at, updated_at)
         VALUES (?1, ?2, 'گوشی تست', 'sms-relay شبیه‌سازی', 1, ?3, ?3)
         ON CONFLICT (id) DO UPDATE SET active = 1, updated_at = ?3`,
      )
      .bind(DEVICE_ID, DEVICE_CODE, now)
      .run();
    await db
      .prepare(
        `INSERT INTO device_credentials
           (id, device_id, token_hash, token_prefix, status, created_at, activated_at)
         VALUES (?1, ?2, ?3, ?4, 'ACTIVE', ?5, ?5)
         ON CONFLICT (id) DO UPDATE
            SET token_hash = ?3, token_prefix = ?4, status = 'ACTIVE', activated_at = ?5`,
      )
      .bind(
        CREDENTIAL_ID,
        DEVICE_ID,
        createHash('sha256').update(deviceKey).digest('hex'),
        deviceKey.slice(0, 4),
        now,
      )
      .run();

    console.log(`provider ${provider.id} (${CODE}) -> ${panelUrl}, groups ${groupIds.join(',')}`);
    console.log(`product  ${product.id}, plan ${planId}`);
    console.log(`card     ${CARD_DIGITS} -> account ${ACCOUNT_ID} (SMS hint ${ACCOUNT_HINT})`);
    console.log(`device   ${DEVICE_CODE}, key read from SMS_TEST_DEVICE_KEY (hash stored)`);
    console.log('credentials are read at run time from PANEL_TEST_PANEL — nothing was stored.');
    return 0;
  } finally {
    await pool.end();
  }
}

/** Ten gigabytes for thirty days, at the same 123,000 toman the hand-typed row used. */
const PLAN_NAME = '۱۰ گیگ / ۳۰ روز — ۱۲۳٬۰۰۰ تومان';
const PLAN_PRICE_IRR = 1_230_000;

// Only when run directly, so a test can import `assertLocal` without the script
// opening a pool and writing rows — the same guard `src/server.ts` uses.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(String(err instanceof Error ? err.message : err));
      process.exit(2);
    });
}
