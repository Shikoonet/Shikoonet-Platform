/**
 * The screen between a category and its prices.
 *
 * `catalog.ts` had said for weeks that the shop «goes through services now» and
 * that sorting a category as one list «would interleave three services' sizes
 * into one ladder, which is the shape the service level was introduced to
 * remove». It then did exactly that: `categoryScreen` called `plansInCategory`
 * and drew every size of every tier in one flat list, so a customer looking at
 * «۳۰ گیگ — ۱۰۰٬۰۰۰» could not tell whether it was پلاتینیوم or معمولی. The
 * screen that fixes it — `prd:` — was already built and simply never reached.
 *
 * So what is asserted here is the SHAPE OF THE WALK, from the customer's side:
 * which callbacks the keyboard carries at each step. Asserting that
 * `productsForUser` returns three rows would prove nothing about whether the
 * customer is ever shown them — that was the whole defect.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { assertSchema, db } from './helpers/env.js';
import { handleUpdate } from '../src/handle.js';

const PREFIX = 'zz-svclevel-';

let nextId = 0;
function ids(): { updateId: number; telegramId: number } {
  const n = ++nextId * 10;
  return { updateId: 861_000 + n, telegramId: 861_000 + n };
}

interface Tier {
  productId: number;
  planIds: number[];
}

/** One panel, one category, and as many tiers inside it as asked for. */
async function makeShop(
  label: string,
  tiers: Array<{ name: string; plans: number }>,
): Promise<{ categoryId: number; tiers: Tier[] }> {
  const provider = await db
    .prepare(
      `INSERT INTO provisioning_providers (code, name, kind, status)
       VALUES (?1, ?1, 'marzban', 'ACTIVE') RETURNING id`,
    )
    .bind(`${PREFIX}${label}`)
    .first<{ id: number }>();
  const providerId = Number(provider!.id);

  const category = await db
    .prepare(`INSERT INTO product_categories (name, sort_order) VALUES (?1, 0) RETURNING id`)
    .bind(`${PREFIX}${label}`)
    .first<{ id: number }>();
  const categoryId = Number(category!.id);

  const out: Tier[] = [];
  for (const [i, tier] of tiers.entries()) {
    const product = await db
      .prepare(
        `INSERT INTO products (code, name, kind, provider_id, category_id, status, sort_order)
         VALUES (?1, ?2, 'vpn', ?3, ?4, 'ACTIVE', ?5) RETURNING id`,
      )
      .bind(`${PREFIX}${label}-${i}`, tier.name, providerId, categoryId, i)
      .first<{ id: number }>();
    const productId = Number(product!.id);

    const planIds: number[] = [];
    for (let n = 0; n < tier.plans; n += 1) {
      const plan = await db
        .prepare(
          `INSERT INTO product_plans (product_id, name, price_irr, duration_days, volume_gb, status)
           VALUES (?1, ?2, ?3, 30, 10, 'ACTIVE') RETURNING id`,
        )
        .bind(productId, `${tier.name} — گزینهٔ ${n + 1}`, 1_000_000 * (n + 1))
        .first<{ id: number }>();
      planIds.push(Number(plan!.id));
    }
    out.push({ productId, planIds });
  }
  return { categoryId, tiers: out };
}

/** Open a category as a real customer would, and hand back the keyboard. */
async function openCategory(
  categoryId: number,
): Promise<{ text: string; buttons: Array<{ text: string; data: string }> }> {
  const { updateId, telegramId } = ids();
  await handleUpdate(db, {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: telegramId, username: `sv${telegramId}` },
      chat: { id: telegramId },
      text: '/start',
    },
  });
  const shown = await handleUpdate(db, {
    update_id: updateId + 1,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `sv${telegramId}` },
      message: { message_id: updateId, chat: { id: telegramId } },
      data: `cat:${categoryId}`,
    },
  });
  const reply = shown.replies[0];
  return {
    text: reply?.text ?? '',
    buttons: (reply?.keyboard ?? [])
      .flat()
      .map((b) => ({ text: b.text, data: b.callback_data ?? '' })),
  };
}

beforeAll(async () => {
  await assertSchema();
});

beforeEach(async () => {
  // Own rows only. The suite shares one database and other files' fixtures are
  // none of this file's business.
  await db.prepare(`DELETE FROM product_plans WHERE name LIKE ?1`).bind(`%گزینهٔ%`).run();
  await db.prepare(`DELETE FROM products WHERE code LIKE ?1`).bind(`${PREFIX}%`).run();
  await db.prepare(`DELETE FROM product_categories WHERE name LIKE ?1`).bind(`${PREFIX}%`).run();
  await db
    .prepare(`DELETE FROM provisioning_providers WHERE code LIKE ?1`)
    .bind(`${PREFIX}%`)
    .run();
});

afterAll(async () => {
  await db.prepare(`DELETE FROM products WHERE code LIKE ?1`).bind(`${PREFIX}%`).run();
  await db.prepare(`DELETE FROM product_categories WHERE name LIKE ?1`).bind(`${PREFIX}%`).run();
  await db
    .prepare(`DELETE FROM provisioning_providers WHERE code LIKE ?1`)
    .bind(`${PREFIX}%`)
    .run();
});

describe('a category with several tiers asks which tier first', () => {
  it('offers the tiers, and not a single price', async () => {
    const shop = await makeShop('three', [
      { name: 'پلاتینیوم', plans: 2 },
      { name: 'طلایی', plans: 2 },
      { name: 'معمولی', plans: 2 },
    ]);

    const screen = await openCategory(shop.categoryId);
    const services = screen.buttons.filter((b) => b.data.startsWith('prd:'));
    const plans = screen.buttons.filter((b) => b.data.startsWith('plan:'));

    expect(services.map((b) => b.text)).toEqual(['پلاتینیوم', 'طلایی', 'معمولی']);
    // The point of the whole change: six prices from three tiers used to land
    // here in one ladder with nothing saying which tier a row belonged to.
    expect(plans).toHaveLength(0);
  });

  it('names the category on the screen, so three tier lists are not three identical screens', async () => {
    const shop = await makeShop('named', [
      { name: 'پلاتینیوم', plans: 2 },
      { name: 'طلایی', plans: 2 },
    ]);
    const screen = await openCategory(shop.categoryId);
    expect(screen.text).toContain(`${PREFIX}named`);
  });

  it('offers a way back to the categories, not only to the menu', async () => {
    // A level with no way back up is a dead end, and this screen had a lone
    // «منو» for as long as nothing but an expired button could reach it.
    const shop = await makeShop('back', [
      { name: 'پلاتینیوم', plans: 2 },
      { name: 'طلایی', plans: 2 },
    ]);
    const screen = await openCategory(shop.categoryId);
    expect(screen.buttons.map((b) => b.data)).toContain('buy');
    expect(screen.buttons.map((b) => b.data)).toContain('menu');
  });

  it('opens one tier onto that tier’s prices only', async () => {
    const shop = await makeShop('drill', [
      { name: 'پلاتینیوم', plans: 2 },
      { name: 'طلایی', plans: 3 },
    ]);
    const { updateId, telegramId } = ids();
    await handleUpdate(db, {
      update_id: updateId,
      message: {
        message_id: updateId,
        from: { id: telegramId, username: `sv${telegramId}` },
        chat: { id: telegramId },
        text: '/start',
      },
    });
    const shown = await handleUpdate(db, {
      update_id: updateId + 1,
      callback_query: {
        id: `cq-${updateId}`,
        from: { id: telegramId, username: `sv${telegramId}` },
        message: { message_id: updateId, chat: { id: telegramId } },
        data: `prd:${shop.tiers[1]!.productId}`,
      },
    });
    const plans = (shown.replies[0]?.keyboard ?? [])
      .flat()
      .filter((b) => (b.callback_data ?? '').startsWith('plan:'));

    // Three, not five: the other tier's prices are on the other tier's screen.
    expect(plans).toHaveLength(3);
    expect(plans.every((b) => b.text.includes('طلایی'))).toBe(true);
  });
});

describe('a list of one is still not a choice', () => {
  it('skips the tier screen when a category holds one service', async () => {
    // Every catalogue migrated from the PHP bot is shaped like this, so this is
    // the common case rather than the edge one: a customer must not be made to
    // press a button that was never a decision.
    const shop = await makeShop('single', [{ name: 'تک', plans: 2 }]);
    const screen = await openCategory(shop.categoryId);

    expect(screen.buttons.filter((b) => b.data.startsWith('prd:'))).toHaveLength(0);
    expect(screen.buttons.filter((b) => b.data.startsWith('plan:'))).toHaveLength(2);
  });

  it('goes straight to the price page for one service holding one plan', async () => {
    const shop = await makeShop('onlyone', [{ name: 'تک', plans: 1 }]);
    const screen = await openCategory(shop.categoryId);

    // The detail page, which carries «ثبت سفارش» rather than another list.
    expect(screen.buttons.map((b) => b.data).some((d) => d.startsWith('order:'))).toBe(true);
  });
});

describe('the tier list obeys the same visibility rule as everything else', () => {
  it('drops a tier whose panel is switched off, rather than listing a dead button', async () => {
    const shop = await makeShop('mixed', [
      { name: 'پلاتینیوم', plans: 2 },
      { name: 'طلایی', plans: 2 },
      { name: 'معمولی', plans: 2 },
    ]);
    // One tier moves to a switched-off panel of its own.
    const dead = await db
      .prepare(
        `INSERT INTO provisioning_providers (code, name, kind, status)
         VALUES (?1, ?1, 'marzban', 'DISABLED') RETURNING id`,
      )
      .bind(`${PREFIX}mixed-off`)
      .first<{ id: number }>();
    await db
      .prepare(`UPDATE products SET provider_id = ?1 WHERE id = ?2`)
      .bind(Number(dead!.id), shop.tiers[1]!.productId)
      .run();

    const screen = await openCategory(shop.categoryId);
    const services = screen.buttons.filter((b) => b.data.startsWith('prd:'));
    expect(services.map((b) => b.text)).toEqual(['پلاتینیوم', 'معمولی']);
  });
});
