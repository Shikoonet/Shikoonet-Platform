/**
 * Applying to be a reseller.
 *
 * The legacy rule set is `index.php:6143-6169`: not already a reseller, not
 * already waiting, a description, and — on a settings row where the price is
 * not zero — a fee. Production has `agentreqprice = 0`, so no money moves here
 * and there is nothing to test about money.
 *
 * The interesting assertion is the one the legacy schema got for free from a
 * PRIMARY KEY and ours had to be given: two applications from one person cannot
 * both exist.
 */

import { CUSTOMER, RESELLER } from './helpers/viewers.js';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import { applyForReseller, DESCRIPTION_MAX } from '../src/reseller.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 7, 14, 9, 0, 0);

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 960_000 + n, telegramId: 980_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `agr${telegramId}` },
      message: { message_id: 3, chat: { id: telegramId } },
      data,
    },
  };
}

function types(updateId: number, telegramId: number, text: string): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      chat: { id: telegramId },
      from: { id: telegramId, username: `agr${telegramId}` },
      text,
    },
  };
}

async function requestsFor(userId: number) {
  const { results } = await db
    .prepare(
      `SELECT description, status FROM reseller_requests WHERE user_id = ?1 ORDER BY id`,
    )
    .bind(userId)
    .all<{ description: string; status: string }>();
  return results ?? [];
}

beforeAll(async () => {
  await ensureCatalog();
});

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('applying', () => {
  it('records what the customer wrote, waiting for an answer', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);

    const asked = await handleUpdate(db, press(updateId, telegramId, 'agr'));
    expect(asked.replies[0]?.text).toBe(menu.ASK_RESELLER_REQUEST);
    const filed = await handleUpdate(
      db,
      types(updateId + 1, telegramId, 'ماهی ۳۰ سرویس می‌فروشم'),
    );

    expect(filed.replies[0]?.text).toBe(menu.RESELLER_REQUEST_FILED);
    expect(await requestsFor(userId)).toEqual([
      { description: 'ماهی ۳۰ سرویس می‌فروشم', status: 'PENDING' },
    ]);
  });

  it('does not open a second application while one is waiting', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await handleUpdate(db, press(updateId, telegramId, 'agr'));
    await handleUpdate(db, types(updateId + 1, telegramId, 'اولی'));

    // Ask again: the button answers before the question this time.
    const again = await handleUpdate(db, press(updateId + 2, telegramId, 'agr'));

    expect(again.replies[0]?.text).toBe(menu.RESELLER_REQUEST_OPEN);
    expect(await requestsFor(userId)).toHaveLength(1);
  });

  it('cannot write a second open application even without the screen', async () => {
    // The test above passes with the index dropped, because the button checks
    // first — so it proves the screen, not the guarantee. This one calls the
    // writer twice the way two simultaneous taps would, with no SELECT between
    // them, and it is the partial unique index that answers.
    const userId = await makeCustomer(ids().telegramId);

    const first = await applyForReseller(db, userId, false, 'یکی');
    const second = await applyForReseller(db, userId, false, 'دوباره');

    expect([first, second]).toEqual(['FILED', 'ALREADY_PENDING']);
    expect(await requestsFor(userId)).toHaveLength(1);
  });

  it('lets somebody who was turned down try again', async () => {
    // The legacy PRIMARY KEY made this impossible forever. Deliberate change.
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await handleUpdate(db, press(updateId, telegramId, 'agr'));
    await handleUpdate(db, types(updateId + 1, telegramId, 'اولی'));
    await db
      .prepare(`UPDATE reseller_requests SET status = 'REJECTED' WHERE user_id = ?1`)
      .bind(userId)
      .run();

    await handleUpdate(db, press(updateId + 2, telegramId, 'agr'));
    await handleUpdate(db, types(updateId + 3, telegramId, 'دومی'));

    expect(await requestsFor(userId)).toEqual([
      { description: 'اولی', status: 'REJECTED' },
      { description: 'دومی', status: 'PENDING' },
    ]);
  });

  it('tells a reseller there is nothing to apply for', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId, { reseller: true });

    const out = await handleUpdate(db, press(updateId, telegramId, 'agr'));

    expect(out.replies[0]?.text).toBe(menu.ALREADY_RESELLER);
    expect(await requestsFor(userId)).toHaveLength(0);
  });

  it('does not offer the button to a reseller at all', async () => {
    const texts = menu.mainMenu(RESELLER).flat().map((b) => b.text);
    expect(texts).not.toContain('👨‍💻 درخواست نمایندگی');
    // And it is a real button for everyone else, not the "coming soon" stub.
    const targets = menu.mainMenu(CUSTOMER).flat().map((b) => b.callback_data);
    expect(targets).toContain('agr');
  });

  it('asks again for a message with nothing in it', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await handleUpdate(db, press(updateId, telegramId, 'agr'));

    const out = await handleUpdate(db, types(updateId + 1, telegramId, '   '));

    expect(out.replies[0]?.text).toBe(menu.RESELLER_REQUEST_EMPTY);
    expect(await requestsFor(userId)).toHaveLength(0);
  });

  it('stores a long message at the length the admin panel expects', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    await handleUpdate(db, press(updateId, telegramId, 'agr'));

    await handleUpdate(db, types(updateId + 1, telegramId, 'ب'.repeat(900)));

    const [row] = await requestsFor(userId);
    expect(row?.description).toHaveLength(DESCRIPTION_MAX);
  });

  it('ignores an application nobody asked for', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);

    const out = await handleUpdate(db, types(updateId, telegramId, 'نماینده شوم؟'));

    expect(out.status).toBe('ignored');
    expect(await requestsFor(userId)).toHaveLength(0);
  });
});
