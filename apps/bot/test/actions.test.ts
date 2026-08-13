/**
 * The two buttons that reach the panel: replace the subscription link, and turn
 * the account off and on.
 *
 * No money moves here, so what is being pinned is different from the purchase
 * tests: that a customer can only ever act on their OWN service, that a panel
 * which refuses changes nothing in our database, and that a button is never
 * drawn for a service nothing can be asked about.
 *
 * The panel is answered in-process. That makes these tests hermetic and it also
 * makes them agree with our own idea of the panel — so the endpoints themselves
 * are cited from the live PHP in `marzban.ts`, not from this file. The HTTP
 * fake in `sim/fake-panel.mjs` is what a browser walkthrough uses.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleUpdate } from '../src/handle.js';
import * as menu from '../src/menu.js';
import type { TelegramUpdate } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { ensureCatalog, makeCustomer, providerId } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 7, 14, 9, 0, 0);
const PANEL_CODE = 'sim-action-panel';

let nextId = 1;
function ids(): { updateId: number; telegramId: number } {
  const n = nextId++ * 10;
  return { updateId: 990_000 + n, telegramId: 950_000 + n };
}

function press(updateId: number, telegramId: number, data: string): TelegramUpdate {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `act${telegramId}` },
      message: { message_id: 77, chat: { id: telegramId } },
      data,
    },
  };
}

/** A panel that answers, and records what it was asked. */
function panel(options: { status?: number } = {}) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  let revocations = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/admin/token')) {
      // Form encoded, like the real login — parsing it as JSON is what an
      // earlier version of this stub did, and it made every call look like an
      // unreachable panel.
      return new Response(JSON.stringify({ access_token: 't' }), { status: 200 });
    }
    const body = init?.body === undefined ? null : JSON.parse(String(init.body));
    calls.push({ method, url, body });
    if (options.status !== undefined) {
      return new Response(JSON.stringify({ detail: 'no' }), { status: options.status });
    }
    if (url.endsWith('/revoke_sub')) {
      revocations += 1;
      return new Response(
        JSON.stringify({
          username: 'u_act',
          status: 'active',
          subscription_url: `/sub/u_act/${revocations}`,
        }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({
        username: 'u_act',
        status: (body as { status?: string } | null)?.status ?? 'active',
        subscription_url: '/sub/u_act/1',
      }),
      { status: 200 },
    );
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetchImpl };
}

async function makeService(
  userId: number,
  options: { status?: string; manual?: boolean; username?: string | null } = {},
): Promise<number> {
  const provider = await providerId(options.manual ? 'sim-shop' : 'sim-vip');
  const row = await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, provider_id, plan_name_at_sale, provider_name_at_sale,
          price_irr, remote_username, subscription_url, volume_gb, status, purchased_at)
       VALUES (?1, ?2, ?3, 'یک‌ماهه-50گیگ', 'لوکیشن تست', 1950000, ?4,
               'https://panel.test/sub/u_act/0', 50, ?5, now())
       RETURNING id`,
    )
    .bind(
      `act${nextId}-${userId}`,
      userId,
      provider,
      options.username === undefined ? 'u_act' : options.username,
      options.status ?? 'ACTIVE',
    )
    .first<{ id: number }>();
  if (!row) throw new Error('service fixture failed');
  return row.id;
}

async function serviceRow(id: number) {
  return db
    .prepare(`SELECT status, subscription_url FROM subscriptions WHERE id = ?1`)
    .bind(id)
    .first<{ status: string; subscription_url: string | null }>();
}

beforeAll(async () => {
  await ensureCatalog();
  process.env[`PANEL_${PANEL_CODE.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`] = 'admin:secret';
  // Only the automated fixtures get an address; `sim-shop` stays manual, which
  // is what the "no buttons" case needs.
  await db
    .prepare(
      `UPDATE provisioning_providers
          SET base_url = 'https://panel.test', secret_ref = ?1
        WHERE kind <> 'manual'`,
    )
    .bind(PANEL_CODE)
    .run();
});

beforeEach(() => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('replacing the subscription link', () => {
  it('asks first, because the old link stops working', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId);
    const p = panel();

    const out = await handleUpdate(db, press(updateId, telegramId, `rvk:${service}`), p.fetchImpl);

    expect(out.replies[0]?.text).toBe(menu.CONFIRM_REVOKE);
    // Nothing was asked of the panel by the question itself.
    expect(p.calls).toHaveLength(0);
    expect(await serviceRow(service)).toMatchObject({
      subscription_url: 'https://panel.test/sub/u_act/0',
    });
  });

  it('replaces the link on confirmation and stores the new one', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId);
    const p = panel();

    const out = await handleUpdate(db, press(updateId, telegramId, `rvk2:${service}`), p.fetchImpl);

    expect(p.calls[0]).toMatchObject({ method: 'POST' });
    expect(p.calls[0]?.url).toContain('/revoke_sub');
    const row = await serviceRow(service);
    expect(row?.subscription_url).toBe('https://panel.test/sub/u_act/1');
    // The customer is given the new link, not told to go and look for it.
    expect(out.replies[0]?.text).toContain('https://panel.test/sub/u_act/1');
  });

  it('changes nothing here when the panel refuses', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId);
    const p = panel({ status: 500 });

    const out = await handleUpdate(db, press(updateId, telegramId, `rvk2:${service}`), p.fetchImpl);

    expect(out.replies[0]?.text).toContain('انجام نشد');
    expect(await serviceRow(service)).toMatchObject({
      subscription_url: 'https://panel.test/sub/u_act/0',
    });
  });
});

describe('turning the account off and on', () => {
  it('sends the status the customer asked for and records it', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId);
    const p = panel();

    const off = await handleUpdate(db, press(updateId, telegramId, `off:${service}`), p.fetchImpl);
    expect(p.calls[0]).toMatchObject({ method: 'PUT', body: { status: 'disabled' } });
    expect(await serviceRow(service)).toMatchObject({ status: 'DISABLED' });
    // And the switch now offers the other direction.
    expect(JSON.stringify(off.replies[0]?.keyboard)).toContain(`on:${service}`);

    const on = await handleUpdate(db, press(updateId + 1, telegramId, `on:${service}`), p.fetchImpl);
    expect(p.calls[1]).toMatchObject({ method: 'PUT', body: { status: 'active' } });
    expect(await serviceRow(service)).toMatchObject({ status: 'ACTIVE' });
    expect(JSON.stringify(on.replies[0]?.keyboard)).toContain(`off:${service}`);
  });

  it('believes the panel over the request when the two disagree', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId);
    // A panel that accepts the call and stays active anyway. Writing DISABLED
    // here would leave our screen saying "off" for an account that is on.
    const stubborn = (async (input: string | URL | Request) =>
      String(input).endsWith('/api/admin/token')
        ? new Response(JSON.stringify({ access_token: 't' }), { status: 200 })
        : new Response(JSON.stringify({ username: 'u_act', status: 'active' }), {
            status: 200,
          })) as unknown as typeof globalThis.fetch;

    await handleUpdate(db, press(updateId, telegramId, `off:${service}`), stubborn);

    expect(await serviceRow(service)).toMatchObject({ status: 'ACTIVE' });
  });
});

describe('who may press these buttons', () => {
  it('does not act on a service belonging to someone else', async () => {
    const owner = await makeCustomer(ids().telegramId);
    const service = await makeService(owner);
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const p = panel();

    const out = await handleUpdate(db, press(updateId, telegramId, `rvk2:${service}`), p.fetchImpl);

    expect(out.replies[0]?.text).toBe(menu.SERVICE_GONE);
    // The important half: the panel was never called for a row we do not own.
    expect(p.calls).toHaveLength(0);
    expect(await serviceRow(service)).toMatchObject({
      subscription_url: 'https://panel.test/sub/u_act/0',
    });
  });

  it('offers nothing to press on a manually provisioned service', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId, { manual: true });
    const p = panel();

    const detail = await handleUpdate(
      db,
      press(updateId, telegramId, `sub:${service}`),
      p.fetchImpl,
    );
    const keyboard = JSON.stringify(detail.replies[0]?.keyboard);
    expect(keyboard).not.toContain('rvk');
    expect(keyboard).not.toContain(`off:${service}`);

    // And pressing it anyway — the button can be forged — says so and calls nothing.
    const forced = await handleUpdate(
      db,
      press(updateId + 1, telegramId, `rvk2:${service}`),
      p.fetchImpl,
    );
    expect(forced.replies[0]?.text).toBe(menu.ACTION_UNSUPPORTED);
    expect(p.calls).toHaveLength(0);
  });

  it('offers nothing on a service the panel has already lost', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId, { status: 'REMOVED' });
    const p = panel();

    const detail = await handleUpdate(db, press(updateId, telegramId, `sub:${service}`), p.fetchImpl);

    expect(JSON.stringify(detail.replies[0]?.keyboard)).not.toContain('rvk');
  });

  it('tells the customer plainly when the panel has no such account', async () => {
    const { updateId, telegramId } = ids();
    const userId = await makeCustomer(telegramId);
    const service = await makeService(userId);
    const p = panel({ status: 404 });

    const out = await handleUpdate(db, press(updateId, telegramId, `off:${service}`), p.fetchImpl);

    expect(out.replies[0]?.text).toContain('انجام نشد');
    expect(await serviceRow(service)).toMatchObject({ status: 'ACTIVE' });
  });
});
