/**
 * `/start c_<slug>` — the customer arriving on a campaign link (#471).
 *
 * The row this writes is the whole of what the dashboard's «کمپین‌ها» counts
 * from: a start, whether the start made the customer, and when. So the
 * assertions are about exactly that row — once per campaign and customer,
 * nothing for a slug that names no campaign, and never a side effect on the
 * referral that shares the payload slot.
 *
 * The gated case — a newcomer who is not in the channel yet, which is who an ad
 * brings — lives in `gate.test.ts`, beside the channel it needs.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { makeCustomer } from './helpers/shop.js';

/** This file's own block: `* 10`, so each call owns ten update ids. */
const BASE_TELEGRAM = 471_000;
const BASE_UPDATE = 471_000_000;
let nextId = 0;
function ids(): { updateId: number; telegramId: number } {
  const n = ++nextId * 10;
  return { updateId: BASE_UPDATE + n, telegramId: BASE_TELEGRAM + n };
}

function starts(updateId: number, telegramId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: telegramId },
      from: { id: telegramId, username: `cmp${telegramId}` },
      text,
    },
  };
}

const SLUG = 'zz-bot-spring';
const ARCHIVED = 'zz-bot-autumn';
let campaignId = 0;
let archivedId = 0;

async function purge(): Promise<void> {
  // Customers first: their starts go with them, and then nothing holds the
  // campaigns (RESTRICT) back.
  await db
    .prepare(`DELETE FROM users WHERE telegram_id BETWEEN ?1 AND ?2`)
    .bind(BASE_TELEGRAM, BASE_TELEGRAM + 9999)
    .run();
  await db.prepare(`DELETE FROM campaigns WHERE slug LIKE 'zz-bot-%'`).run();
  // A second standalone run would find every update id already claimed, and
  // `handleUpdate` answers those with a silent `duplicate` (issue #183).
  await db
    .prepare(`DELETE FROM telegram_updates WHERE update_id BETWEEN ?1 AND ?2`)
    .bind(BASE_UPDATE, BASE_UPDATE + 999_999)
    .run();
}

const startsOf = (telegramId: number) =>
  db
    .prepare(
      `SELECT s.campaign_id, s.is_new_user FROM campaign_starts s
         JOIN users u ON u.id = s.user_id
        WHERE u.telegram_id = ?1
        ORDER BY s.campaign_id`,
    )
    .bind(telegramId)
    .all<{ campaign_id: number; is_new_user: boolean }>()
    .then((r) => (r.results ?? []).map((x) => ({ ...x, campaign_id: Number(x.campaign_id) })));

beforeAll(async () => {
  await purge();
  const make = (slug: string, status: string) =>
    db
      .prepare(`INSERT INTO campaigns (slug, name, status) VALUES (?1, ?1, ?2) RETURNING id`)
      .bind(slug, status)
      .first<{ id: number }>()
      .then((r) => Number(r!.id));
  campaignId = await make(SLUG, 'ACTIVE');
  archivedId = await make(ARCHIVED, 'ARCHIVED');
});

afterAll(purge);

describe('/start c_<slug>', () => {
  it('records a newcomer once, however often they press the link', async () => {
    const { updateId, telegramId } = ids();

    await handleUpdate(db, starts(updateId, telegramId, `/start c_${SLUG}`));
    await handleUpdate(db, starts(updateId + 1, telegramId, `/start c_${SLUG}`));

    expect(await startsOf(telegramId)).toEqual([{ campaign_id: campaignId, is_new_user: true }]);
  });

  it('records an existing customer as not new', async () => {
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);

    await handleUpdate(db, starts(updateId, telegramId, `/start c_${SLUG}`));

    expect(await startsOf(telegramId)).toEqual([{ campaign_id: campaignId, is_new_user: false }]);
  });

  it('keeps counting an archived campaign — its links are still out there', async () => {
    const { updateId, telegramId } = ids();

    await handleUpdate(db, starts(updateId, telegramId, `/start c_${ARCHIVED}`));

    expect(await startsOf(telegramId)).toEqual([{ campaign_id: archivedId, is_new_user: true }]);
  });

  it('puts one customer in every campaign they arrived from', async () => {
    const { updateId, telegramId } = ids();

    await handleUpdate(db, starts(updateId, telegramId, `/start c_${SLUG}`));
    await handleUpdate(db, starts(updateId + 1, telegramId, `/start c_${ARCHIVED}`));

    // New on the first, not on the second: the second /start did not make them.
    expect(await startsOf(telegramId)).toEqual(
      [
        { campaign_id: campaignId, is_new_user: true },
        { campaign_id: archivedId, is_new_user: false },
      ].sort((a, b) => a.campaign_id - b.campaign_id),
    );
  });

  it('counts a link retyped with capitals as the same campaign', async () => {
    const { updateId, telegramId } = ids();

    await handleUpdate(db, starts(updateId, telegramId, `/start c_${SLUG.toUpperCase()}`));
    await handleUpdate(db, starts(updateId + 1, telegramId, `/start c_${SLUG}`));

    expect(await startsOf(telegramId)).toEqual([{ campaign_id: campaignId, is_new_user: true }]);
  });

  it('writes nothing for a slug that names no campaign, or is not a slug at all', async () => {
    const { updateId, telegramId } = ids();

    for (const [i, text] of [
      '/start c_zz-bot-nobody',
      "/start c_x'--",
      '/start c_ab',
      `/start c_${SLUG}_`,
    ].entries()) {
      await handleUpdate(db, starts(updateId + i, telegramId, text));
    }

    expect(await startsOf(telegramId)).toEqual([]);
  });

  it('is not a referral, and a referral is not a campaign', async () => {
    const referrer = await makeCustomer(ids().telegramId);
    const { updateId, telegramId } = ids();

    await handleUpdate(db, starts(updateId, telegramId, `/start c_${SLUG}`));
    await handleUpdate(db, starts(updateId + 1, telegramId, `/start ${referrer}`));

    const row = await db
      .prepare(`SELECT referred_by FROM users WHERE telegram_id = ?1`)
      .bind(telegramId)
      .first<{ referred_by: number | null }>();
    // The digits still refer — the campaign start before them did not take
    // the slot — and the digits added no second campaign row.
    expect(row?.referred_by).toBe(referrer);
    expect(await startsOf(telegramId)).toEqual([{ campaign_id: campaignId, is_new_user: true }]);
  });
});
