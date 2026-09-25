/**
 * «🗑 حذف از فهرست» — a customer takes a dead service off «سرویس‌های من».
 *
 * What is pinned: only a dead service (expired, used up, removed, failed) can
 * be hidden, only by its owner, and hiding writes one column and one audit row
 * — never a panel call. A hidden service is gone from every customer screen
 * that reads through owned.ts: the list, its count, the detail, the renewal.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import { countRenewableForUser, countSubscriptionsForUser } from '../src/owned.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, providerId } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 8, 25, 9, 0, 0);
const DAY = 86_400_000;
const GB = 1024 ** 3;

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 880_000 + n, telegramId: 870_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `hide${telegramId}` },
      message: { message_id: 77, chat: { id: telegramId } },
      data,
    },
  };
}

/** Any call at all is a failure: hiding never reaches the panel. */
const calls: string[] = [];
const noPanel = (async (input: string | URL | Request) => {
  calls.push(String(input));
  return new Response('{}', { status: 500 });
}) as unknown as typeof globalThis.fetch;

interface Fixture {
  status?: string;
  expiresInDays?: number | null;
  usedGb?: number;
  manual?: boolean;
}

async function makeService(userId: number, f: Fixture = {}): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, provider_id, plan_name_at_sale, provider_name_at_sale,
          price_irr, remote_username, volume_gb, used_bytes, status, purchased_at, expires_at)
       VALUES (?1, ?2, ?3, 'یک‌ماهه-50گیگ', 'لوکیشن تست', 1950000, ?4, 50, ?5, ?6, now(), ?7)
       RETURNING id`,
    )
    .bind(
      `hide${nextId}-${userId}`,
      userId,
      await providerId(f.manual ? 'sim-shop' : 'sim-vip'),
      `u_hide${nextId}_${userId}`,
      Math.round((f.usedGb ?? 0) * GB),
      f.status ?? 'ACTIVE',
      f.expiresInDays === null
        ? null
        : new Date(NOW_MS + (f.expiresInDays ?? 10) * DAY).toISOString(),
    )
    .first<{ id: number }>();
  if (!row) throw new Error('service fixture failed');
  nextId += 1;
  return row.id;
}

async function hiddenAt(id: number): Promise<string | null> {
  const row = await db
    .prepare(`SELECT hidden_at FROM subscriptions WHERE id = ?1`)
    .bind(id)
    .first<{ hidden_at: string | null }>();
  return row?.hidden_at ?? null;
}

/**
 * audit_logs is append-only and outlives the per-suite truncate, while
 * subscription ids restart — so a test counts the rows IT added, not the total.
 */
async function auditRows(id: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*)::int AS n FROM audit_logs
        WHERE action = 'subscription.hidden' AND entity_id = ?1`,
    )
    .bind(String(id))
    .first<{ n: number }>();
  return row?.n ?? 0;
}

beforeAll(ensureCatalog);

beforeEach(() => {
  calls.length = 0;
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a dead service', () => {
  it.each([
    ['expired', { expiresInDays: -1 }],
    ['used up', { usedGb: 50 }],
    ['removed from the panel', { status: 'REMOVED', expiresInDays: -40 }],
    ['failed, with no panel behind it', { status: 'FAILED', manual: true, expiresInDays: null }],
  ] as const)('%s: offers the button, asks, then hides it', async (_, fixture) => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId, fixture);

    const detail = await handleUpdate(db, press(updateId, telegramId, `sub:${service}`), noPanel);
    expect(JSON.stringify(detail.replies[0]?.keyboard)).toContain(`"del:${service}"`);

    const ask = await handleUpdate(db, press(updateId + 1, telegramId, `del:${service}`), noPanel);
    expect(ask.replies[0]?.text).toBe(menu.CONFIRM_DELETE_SERVICE);
    expect(JSON.stringify(ask.replies[0]?.keyboard)).toContain(`"del2:${service}"`);
    // The question writes nothing.
    expect(await hiddenAt(service)).toBeNull();
    const audited = await auditRows(service);

    const done = await handleUpdate(db, press(updateId + 2, telegramId, `del2:${service}`), noPanel);
    expect(done.replies[0]?.text).toContain(menu.SERVICE_DELETED);
    expect(await hiddenAt(service)).not.toBeNull();
    expect(await auditRows(service)).toBe(audited + 1);
    expect(calls).toHaveLength(0);

    // Gone from every screen that reads through owned.ts.
    expect(await countSubscriptionsForUser(db, userId)).toBe(0);
    expect(await countRenewableForUser(db, userId)).toBe(0);
    const again = await handleUpdate(db, press(updateId + 3, telegramId, `sub:${service}`), noPanel);
    expect(again.replies[0]?.text).toBe(menu.SERVICE_GONE);
  });

  it('pressed twice writes one audit row, and the list keeps the other services', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const dead = await makeService(userId, { expiresInDays: -1 });
    const live = await makeService(userId);
    const audited = await auditRows(dead);

    await handleUpdate(db, press(updateId, telegramId, `del2:${dead}`), noPanel);
    const second = await handleUpdate(db, press(updateId + 1, telegramId, `del2:${dead}`), noPanel);

    expect(await auditRows(dead)).toBe(audited + 1);
    expect(second.replies[0]?.text).not.toContain(menu.SERVICE_DELETED);
    expect(JSON.stringify(second.replies[0]?.keyboard)).toContain(`"sub:${live}"`);
    expect(await countSubscriptionsForUser(db, userId)).toBe(1);
  });
});

describe('a service that still works', () => {
  it.each([
    ['active', {}],
    ['on hold', { status: 'ON_HOLD' }],
    ['switched off by the customer', { status: 'DISABLED' }],
  ] as const)('%s: no button, and a forged del2 changes nothing', async (_, fixture) => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId, fixture);
    const audited = await auditRows(service);

    const detail = await handleUpdate(db, press(updateId, telegramId, `sub:${service}`), noPanel);
    expect(JSON.stringify(detail.replies[0]?.keyboard)).not.toContain('del:');

    const ask = await handleUpdate(db, press(updateId + 1, telegramId, `del:${service}`), noPanel);
    expect(ask.replies[0]?.text).not.toBe(menu.CONFIRM_DELETE_SERVICE);

    await handleUpdate(db, press(updateId + 2, telegramId, `del2:${service}`), noPanel);
    expect(await hiddenAt(service)).toBeNull();
    expect(await auditRows(service)).toBe(audited);
  });
});

describe('somebody else’s service', () => {
  it('cannot be hidden by id', async () => {
    const owner = ids();
    const stranger = ids();
    const ownerId = await makeCustomer(owner.telegramId);
    await makeCustomer(stranger.telegramId);
    const service = await makeService(ownerId, { expiresInDays: -1 });
    const audited = await auditRows(service);

    const ask = await handleUpdate(
      db,
      press(stranger.updateId, stranger.telegramId, `del:${service}`),
      noPanel,
    );
    expect(ask.replies[0]?.text).toBe(menu.SERVICE_GONE);
    await handleUpdate(db, press(stranger.updateId + 1, stranger.telegramId, `del2:${service}`), noPanel);

    expect(await hiddenAt(service)).toBeNull();
    expect(await auditRows(service)).toBe(audited);
  });
});
