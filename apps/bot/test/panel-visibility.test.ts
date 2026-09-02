/**
 * «مخفی کردن پنل برای یک کاربر», and the free account.
 *
 * The two are in one file because they share a question: which panels does THIS
 * customer get to see. A hidden panel must vanish from the shop and from the
 * trial list together — a shop that blocks somebody from buying and then hands
 * them a free account on the same panel has blocked nothing.
 *
 * ## The assertion that matters most
 *
 * `purchasablePlan` is not a listing. It is what answers «may this customer buy
 * plan 41» when the number arrived in `callback_data`, which anybody can post.
 * Legacy filters hidden panels in its keyboard builders — seven separate
 * `continue`s — and never on that path at all. If only the listing were tested
 * here, this suite would go green against a bot a blocked customer could still
 * buy from by typing a number.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  productsForUser,
  purchasablePlan,
  trialPanelsForUser,
  plansOnPanel,
} from '../src/catalog.js';
import { placeTrialOrder } from '../src/order.js';
import { provisionPaidOrders } from '../src/provision.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, planId, providerId } from './helpers/shop.js';

const BLOCKED = 951_000_001;
const ORDINARY = 951_000_002;

let blockedId = 0;
let ordinaryId = 0;
let vipPanel = 0;
let trialPanel = 0;

/**
 * The trial tests get a panel of their own rather than borrowing `sim-vip`.
 *
 * Two reasons, and the second is the one that bites. `trialPanelsForUser`
 * refuses a panel that cannot provision — no address or no credential — and the
 * seeded panels have neither, so the fixture has to supply them. And vitest
 * runs the files of one package in parallel, so a test that gave `sim-vip` an
 * address would be changing a row `catalog.test.ts` is reading in another
 * worker. A row nobody else knows about cannot do that.
 */
const TRIAL_PANEL_CODE = 'sim-trial-fixture';

beforeAll(async () => {
  await ensureCatalog();
  blockedId = await makeCustomer(BLOCKED);
  ordinaryId = await makeCustomer(ORDINARY);
  vipPanel = await providerId('sim-vip');

  // `secret_ref` names an environment variable that does not exist here, and
  // that is fine: nothing in these tests calls the panel. What is being tested
  // is which panels the shop OFFERS, and «has a credential configured» is the
  // question that filter asks.
  const made = await db
    .prepare(
      `INSERT INTO provisioning_providers (code, name, kind, status, base_url, secret_ref, config)
       VALUES (?1, 'پنل تست فیکسچر', 'pasarguard', 'ACTIVE', 'https://fixture.invalid',
               'FIXTURE', '{}'::jsonb)
       ON CONFLICT (code) DO UPDATE SET status = 'ACTIVE'
       RETURNING id`,
    )
    .bind(TRIAL_PANEL_CODE)
    .first<{ id: number }>();
  trialPanel = made!.id;
});

afterAll(async () => {
  await db
    .prepare('DELETE FROM provider_hidden_users WHERE user_id IN (?1, ?2)')
    .bind(blockedId, ordinaryId)
    .run();
  await db
    .prepare("DELETE FROM orders WHERE kind = 'TRIAL' AND user_id IN (?1, ?2)")
    .bind(blockedId, ordinaryId)
    .run();
  await db
    .prepare('DELETE FROM provisioning_providers WHERE id = ?1')
    .bind(trialPanel)
    .run();
});

async function hide(userId: number, panelId = vipPanel): Promise<void> {
  await db
    .prepare(
      `INSERT INTO provider_hidden_users (provider_id, user_id, hidden_by)
       VALUES (?1, ?2, 'test')
       ON CONFLICT (provider_id, user_id) DO NOTHING`,
    )
    .bind(panelId, userId)
    .run();
}

async function unhide(userId: number, panelId = vipPanel): Promise<void> {
  await db
    .prepare('DELETE FROM provider_hidden_users WHERE provider_id = ?1 AND user_id = ?2')
    .bind(panelId, userId)
    .run();
}

describe('a panel hidden from one customer', () => {
  it('is in the shop for everybody while nobody is hidden', async () => {
    await unhide(blockedId);
    const services = await productsForUser(db, blockedId, vipPanel);
    expect(services.length).toBeGreaterThan(0);
  });

  it('disappears from the listing for the customer it is hidden from', async () => {
    await hide(blockedId);
    expect(await productsForUser(db, blockedId, vipPanel)).toEqual([]);
    expect(await plansOnPanel(db, blockedId, vipPanel)).toEqual([]);
  });

  it('leaves everybody else alone', async () => {
    await hide(blockedId);
    const services = await productsForUser(db, ordinaryId, vipPanel);
    expect(services.length).toBeGreaterThan(0);
  });

  /**
   * The one that is not a listing. `callback_data` is unsigned user input, so a
   * blocked customer can post `plan:<id>` for a plan they were never shown.
   */
  it('refuses the plan even when its id is posted directly', async () => {
    await hide(blockedId);
    const plan = await planId('sim-vip-1m-50');
    expect(await purchasablePlan(db, blockedId, plan)).toBeNull();
    expect(await purchasablePlan(db, ordinaryId, plan)).not.toBeNull();
  });

  it('comes back the moment the block is lifted, with nothing else changed', async () => {
    await hide(blockedId);
    await unhide(blockedId);
    const services = await productsForUser(db, blockedId, vipPanel);
    expect(services.length).toBeGreaterThan(0);
  });

  /**
   * Legacy appends without a membership test (`admin.php:8651`) and removes with
   * `array_search`, which takes only the first copy out — so an id added twice
   * needs removing twice, and the admin who removed it once believes they did.
   * The primary key is what makes that unwritable rather than merely unlikely.
   */
  it('cannot be written down twice', async () => {
    await hide(blockedId);
    await hide(blockedId);
    const row = await db
      .prepare(
        'SELECT COUNT(*)::int AS n FROM provider_hidden_users WHERE provider_id = ?1 AND user_id = ?2',
      )
      .bind(vipPanel, blockedId)
      .first<{ n: number }>();
    expect(row?.n).toBe(1);
    await unhide(blockedId);
  });
});

describe('the free trial', () => {
  async function setTrial(patch: Record<string, unknown>): Promise<void> {
    await db
      .prepare(
        `UPDATE provisioning_providers
            SET config = COALESCE(config, '{}'::jsonb) || ?2::jsonb
          WHERE id = ?1`,
      )
      .bind(trialPanel, JSON.stringify(patch))
      .run();
  }

  it('offers nothing while no panel is switched on', async () => {
    await setTrial({ trial_enabled: false });
    const panels = await trialPanelsForUser(db, ordinaryId);
    expect(panels.find((p) => p.providerId === trialPanel)).toBeUndefined();
  });

  it('offers a switched-on panel, with its size on the row', async () => {
    await setTrial({ trial_enabled: true, trial_volume_gb: 2, trial_duration_hours: 12 });
    const panels = await trialPanelsForUser(db, ordinaryId);
    const vip = panels.find((p) => p.providerId === trialPanel);
    expect(vip).toMatchObject({ volumeGb: 2, durationHours: 12 });
  });

  it('does not offer it to a customer the panel is hidden from', async () => {
    await setTrial({ trial_enabled: true, trial_volume_gb: 2, trial_duration_hours: 12 });
    await hide(blockedId, trialPanel);
    const panels = await trialPanelsForUser(db, blockedId);
    expect(panels.find((p) => p.providerId === trialPanel)).toBeUndefined();
    await unhide(blockedId, trialPanel);
  });

  it('will not offer a panel switched on with a number missing', async () => {
    await setTrial({ trial_enabled: true, trial_volume_gb: null, trial_duration_hours: 12 });
    const panels = await trialPanelsForUser(db, ordinaryId);
    expect(panels.find((p) => p.providerId === trialPanel)).toBeUndefined();
  });

  /**
   * The quota is the WHERE clause of the increment, not a read before it.
   * Legacy reads `user.limit_usertest`, compares in PHP and writes back
   * (`index.php:3132`), so two taps in the same second both see the old number
   * and both pass. Running the two claims concurrently is the only way to test
   * that; a sequential pair would pass against the legacy shape too.
   */
  it('hands out exactly one free account when two taps race', async () => {
    await db
      .prepare("DELETE FROM orders WHERE kind = 'TRIAL' AND user_id = ?1")
      .bind(ordinaryId)
      .run();
    await db.prepare('UPDATE users SET test_quota_used = 0 WHERE id = ?1').bind(ordinaryId).run();

    const both = await Promise.all([
      db.withSession((tx) => placeTrialOrder(tx, ordinaryId, trialPanel, 1)),
      db.withSession((tx) => placeTrialOrder(tx, ordinaryId, trialPanel, 1)),
    ]);
    expect(both.filter((r) => r !== null)).toHaveLength(1);

    const orders = await db
      .prepare("SELECT COUNT(*)::int AS n FROM orders WHERE kind = 'TRIAL' AND user_id = ?1")
      .bind(ordinaryId)
      .first<{ n: number }>();
    expect(orders?.n).toBe(1);
  });

  it('writes an order that is free, PAID, and names its panel', async () => {
    await db
      .prepare("DELETE FROM orders WHERE kind = 'TRIAL' AND user_id = ?1")
      .bind(ordinaryId)
      .run();
    await db.prepare('UPDATE users SET test_quota_used = 0 WHERE id = ?1').bind(ordinaryId).run();

    const placed = await db.withSession((tx) => placeTrialOrder(tx, ordinaryId, trialPanel, 1));
    expect(placed).not.toBeNull();

    const row = await db
      .prepare(
        `SELECT kind, status, total_irr, provider_id, plan_id
           FROM orders WHERE public_id = ?1`,
      )
      .bind(placed!.publicId)
      .first<{
        kind: string;
        status: string;
        total_irr: number;
        provider_id: number;
        plan_id: number | null;
      }>();
    // PAID with nothing behind it is the whole shape of a free fulfilment: the
    // provisioning sweep reads PAID and never asks how it got there.
    expect(row).toMatchObject({
      kind: 'TRIAL',
      status: 'PAID',
      total_irr: 0,
      provider_id: trialPanel,
      plan_id: null,
    });
  });

  it('refuses to hand one out when the shop has set the quota to zero', async () => {
    await db.prepare('UPDATE users SET test_quota_used = 0 WHERE id = ?1').bind(ordinaryId).run();
    const placed = await db.withSession((tx) => placeTrialOrder(tx, ordinaryId, trialPanel, 0));
    expect(placed).toBeNull();
  });

  /**
   * The window between the tap and the delivery, which is two transactions
   * wide and long enough for an admin to switch the trial off.
   *
   * The customer must not be charged for that — and what a trial costs is not
   * money, it is the one free account on their own row. `refundOrder` cannot
   * see it: a trial has no payment behind it. Without the statement in `fail`
   * the order fails, the message says «سهمیهٔ شما مصرف نشد», and the counter
   * says otherwise.
   */
  it('gives the free account back when the trial is withdrawn mid-flight', async () => {
    await db
      .prepare("DELETE FROM orders WHERE kind = 'TRIAL' AND user_id = ?1")
      .bind(ordinaryId)
      .run();
    await db.prepare('UPDATE users SET test_quota_used = 0 WHERE id = ?1').bind(ordinaryId).run();
    await setTrial({ trial_enabled: true, trial_volume_gb: 2, trial_duration_hours: 12 });

    const placed = await db.withSession((tx) => placeTrialOrder(tx, ordinaryId, trialPanel, 1));
    expect(placed).not.toBeNull();
    expect(await quotaUsed()).toBe(1);

    // The admin switches it off between the tap and the sweep.
    await setTrial({ trial_enabled: false });

    // A fetch that would throw if it were ever called: the sweep must decide
    // this without touching the panel.
    const noPanel = (() => {
      throw new Error('the sweep called the panel for a withdrawn trial');
    }) as unknown as typeof globalThis.fetch;
    await provisionPaidOrders(db, noPanel);

    const order = await db
      .prepare('SELECT status, failure_reason FROM orders WHERE public_id = ?1')
      .bind(placed!.publicId)
      .first<{ status: string; failure_reason: string | null }>();
    expect(order?.status).toBe('FAILED');
    expect(await quotaUsed()).toBe(0);
  });

  async function quotaUsed(): Promise<number> {
    const row = await db
      .prepare('SELECT test_quota_used FROM users WHERE id = ?1')
      .bind(ordinaryId)
      .first<{ test_quota_used: number }>();
    return Number(row?.test_quota_used ?? -1);
  }
});
