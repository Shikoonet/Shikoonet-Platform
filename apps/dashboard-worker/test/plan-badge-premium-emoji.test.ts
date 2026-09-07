/**
 * A premium emoji on a plan button — the badge that could not be saved.
 *
 * ## What was actually broken, and what never was
 *
 * The bot has been able to draw one of these the whole time. `badged()` puts
 * the admin's badge at the FRONT of the button label, and `keyboardFor` turns a
 * `<tg-emoji>` tag at the front of any inline label into
 * `icon_custom_emoji_id` — the one place the Bot API has for a custom emoji on
 * a button, since a button's `text` is parsed as plain. Position, transport and
 * the shop-wide switch were all already right.
 *
 * What stopped it was arithmetic: `length(badge) BETWEEN 1 AND 24` counted the
 * markup, and one tag is 53 characters that draw as one glyph. Migration 0059
 * measures the rendered form instead, and the route's zod schema now measures
 * it the same way with the same helper.
 *
 * So this suite asserts the two halves that can drift: that a real badge with a
 * real tag survives a round trip to Postgres and back, and that widening the
 * count did NOT widen what the field is for — a long plain badge, a tag in the
 * wrong place, and two tags are all still refused.
 *
 * Every assertion re-reads `product_plans`. A route that echoed its request
 * body would pass a test that only compared the response to what was sent.
 */

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv, fixtureCategory } from './helpers/env.js';
import { app } from '../src/index.js';
import { premiumEmojiTag, renderedLabelLength } from '@shikoo/contracts';

const ADMIN = 'admin-badge@example.com';
const PREFIX = 'zz-badge-emoji-';

/** A real id and its real fallback glyph, from the pack 0050 seeds. */
const FIRE = premiumEmojiTag({ label: 'test', fallback: '🔥', id: '5368324170671202286' });

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

async function planRow(id: number) {
  return baseEnv.DB.prepare(`SELECT badge FROM product_plans WHERE id = ?1`)
    .bind(id)
    .first<{ badge: string | null }>();
}

let planId = 0;

beforeAll(async () => {
  await applySchema();
  await fixtureCategory();
  await baseEnv.DB.prepare(
    `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
     VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3)`,
  )
    .bind(crypto.randomUUID(), ADMIN, Date.now())
    .run();

  const provider = await baseEnv.DB.prepare(
    `INSERT INTO provisioning_providers (code, name, kind, status)
     VALUES (?1, 'پنل نشان', 'marzban', 'ACTIVE') RETURNING id`,
  )
    .bind(`${PREFIX}p`)
    .first<{ id: number }>();
  const product = await baseEnv.DB.prepare(
    `INSERT INTO products (code, name, kind, provider_id, category_id, status)
     VALUES (?1, 'محصول نشان', 'vpn', ?2,
             (SELECT id FROM product_categories WHERE name = '__fixture'), 'ACTIVE') RETURNING id`,
  )
    .bind(`${PREFIX}pr`, Number(provider!.id))
    .first<{ id: number }>();
  const plan = await baseEnv.DB.prepare(
    `INSERT INTO product_plans (product_id, name, price_irr, duration_days, volume_gb, status)
     VALUES (?1, 'یک ماهه', 900000, 30, 50, 'ACTIVE') RETURNING id`,
  )
    .bind(Number(product!.id))
    .first<{ id: number }>();
  planId = Number(plan!.id);
});

afterAll(async () => {
  await baseEnv.DB.prepare(
    `DELETE FROM product_plans WHERE product_id IN (SELECT id FROM products WHERE code LIKE ?1)`,
  )
    .bind(`${PREFIX}%`)
    .run();
  await baseEnv.DB.prepare(`DELETE FROM products WHERE code LIKE ?1`).bind(`${PREFIX}%`).run();
  await baseEnv.DB.prepare(`DELETE FROM provisioning_providers WHERE code LIKE ?1`)
    .bind(`${PREFIX}%`)
    .run();
  await baseEnv.DB.prepare(`DELETE FROM access_users WHERE email = ?1`).bind(ADMIN).run();
});

async function patch(badge: string) {
  return app.request(
    `/api/v1/admin/products/plans/${planId}`,
    { method: 'POST', body: JSON.stringify({ badge }) },
    envAs(ADMIN),
  );
}

describe('the tag itself', () => {
  /**
   * The number Postgres would see, and the number JavaScript sees, are not the
   * same number — and that gap is why `renderedLabelLength` spreads the string
   * instead of reading `.length`.
   *
   * `'🔥'.length` is 2 in JavaScript (two UTF-16 units) and `length('🔥')` is 1
   * in Postgres (one character). So the same tag is 54 to `.length` and 53 to
   * the CHECK constraint. A panel measuring with `.length` would be stricter
   * than the database that has the last word, and only for badges with emoji in
   * them — which is most of this shop's.
   */
  it('measures 53 the way Postgres counts and 54 the way JavaScript does', () => {
    expect([...FIRE].length).toBe(53);
    expect(FIRE.length).toBe(54);
  });

  it('draws as exactly one glyph, which is the whole reason 24 was the wrong count', () => {
    expect(renderedLabelLength(FIRE)).toBe(1);
  });
});

describe('a plan badge may carry one premium emoji', () => {
  it('saves the markup verbatim, and Postgres keeps it', async () => {
    const res = await patch(`${FIRE} آف`);
    expect(res.status).toBe(200);
    // The database, not the response. 56 raw characters through a column whose
    // CHECK used to cap at 24.
    expect((await planRow(planId))!.badge).toBe(`${FIRE} آف`);
  });

  it('is still bounded — by what the button DRAWS, which is four characters here', async () => {
    expect(renderedLabelLength(`${FIRE} آف`)).toBe(4);
  });
});

describe('widening the count did not widen what the field is for', () => {
  it('refuses twenty-five plain characters, exactly as before', async () => {
    const before = (await planRow(planId))!.badge;
    const res = await patch('ط'.repeat(25));
    expect(res.status).toBe(400);
    expect((await planRow(planId))!.badge).toBe(before);
  });

  it('refuses a badge that draws past the cap even when a tag makes it look shorter', async () => {
    const before = (await planRow(planId))!.badge;
    const res = await patch(`${FIRE} ${'ط'.repeat(24)}`);
    expect(res.status).toBe(400);
    expect((await planRow(planId))!.badge).toBe(before);
  });

  it('refuses a tag that is not at the front — there is nowhere for it to go', async () => {
    const before = (await planRow(planId))!.badge;
    const res = await patch(`آف ${FIRE}`);
    expect(res.status).toBe(400);
    expect((await planRow(planId))!.badge).toBe(before);
  });

  it('refuses two tags — a button has one icon field, not a list', async () => {
    const before = (await planRow(planId))!.badge;
    const res = await patch(`${FIRE}${FIRE}`);
    expect(res.status).toBe(400);
    expect((await planRow(planId))!.badge).toBe(before);
  });

  it('refuses a half-written tag rather than storing markup the customer would read literally', async () => {
    const before = (await planRow(planId))!.badge;
    const res = await patch('<tg-emoji emoji-id="536">آف');
    expect(res.status).toBe(400);
    expect((await planRow(planId))!.badge).toBe(before);
  });
});
