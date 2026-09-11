/**
 * The two sweeps that delete a customer's account from a panel.
 *
 * Nothing else in this project destroys something a customer paid for, and
 * nothing puts it back. So the assertions that matter are the ones about NOT
 * deleting: every guard is tested from the side where it refuses, because a
 * guard that only ever passes is a guard nobody has checked.
 *
 * The panel is a fake `fetch` rather than a real adapter double, so what is
 * asserted is the request that would have gone out — the actual DELETE, to the
 * actual username.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeFinishedServices } from '../src/remove.js';
import { db, pendingNotifications } from './helpers/env.js';
import { invalidateShopSettings } from '../src/settings.js';
import { ensureCatalog, makeCustomer } from './helpers/shop.js';

const NOW_MS = Date.UTC(2026, 8, 6, 12, 0, 0);
const DAY = 86_400_000;

let seq = 0;
function nextTelegramId(): number {
  seq += 1;
  return 760_000 + seq * 13;
}

/** Every DELETE the sweep sent, in order. */
let deleted: string[] = [];

/**
 * A panel that logs in and deletes.
 *
 * `?override` lets one test make the delete fail without a second fake.
 */
function fakePanel(override?: (url: string) => Response | null): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const forced = override?.(url);
    if (forced) return forced;
    if (url.includes('/api/admin/token')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (init?.method === 'DELETE' && url.includes('/api/user/')) {
      deleted.push(decodeURIComponent(url.split('/api/user/')[1]!));
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
}

let providerId: number;

interface Fixture {
  publicId: string;
  /** Days ago it expired. Positive = in the past. */
  expiredDaysAgo?: number | null;
  panelStatus?: string | null;
  /** Days ago the panel last saw it connect. Null = never reported. */
  onlineDaysAgo?: number | null;
  status?: string;
  /**
   * When our row last heard from the panel. Null = never, or not since we last
   * wrote to it ourselves.
   *
   * Defaults to «just now», because that is what an ordinary service looks
   * like: `sync.ts` stamps it every ten minutes. It is a fixture knob because
   * of what NULL means — an add-on or a renewal sets it to NULL deliberately,
   * to say «the panel's verdict on this row is older than what we just did to
   * it», and the removal sweeps must refuse a row in that state.
   */
  syncedDaysAgo?: number | null;
}

async function makeService(userId: number, fx: Fixture): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO subscriptions
         (public_id, user_id, plan_name_at_sale, price_irr, remote_username, provider_id,
          status, purchased_at, expires_at, panel_status, panel_online_at, last_synced_at,
          notify)
       VALUES (?1, ?2, 'یک‌ماهه-۵۰گیگ', 1950000, ?3, ?4, ?5, now(), ?6, ?7, ?8, ?9,
               '{}'::jsonb)
       RETURNING id`,
    )
    .bind(
      fx.publicId,
      userId,
      `u_${fx.publicId}`,
      providerId,
      fx.status ?? 'ACTIVE',
      fx.expiredDaysAgo === undefined || fx.expiredDaysAgo === null
        ? null
        : new Date(NOW_MS - fx.expiredDaysAgo * DAY).toISOString(),
      fx.panelStatus === undefined ? 'limited' : fx.panelStatus,
      fx.onlineDaysAgo === undefined || fx.onlineDaysAgo === null
        ? null
        : new Date(NOW_MS - fx.onlineDaysAgo * DAY).toISOString(),
      fx.syncedDaysAgo === null
        ? null
        : new Date(NOW_MS - (fx.syncedDaysAgo ?? 0) * DAY).toISOString(),
    )
    .first<{ id: number }>();
  if (!row) throw new Error('remove fixture failed');
  return row.id;
}

async function setSetting(key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (scope, key, value) VALUES ('bot', ?1, ?2::jsonb)
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run();
  invalidateShopSettings();
}

/** Both switches on and the dry run off — the state everything below assumes. */
async function armed(): Promise<void> {
  await setSetting('cron_remove_expired', 'true');
  await setSetting('cron_remove_volume', 'true');
  await setSetting('cron_remove_dry_run', 'false');
  await setSetting('removedayc', '30');
  await setSetting('cronvolumere', '17');
}

/**
 * Whether this customer was messaged at all.
 *
 * Scoped to one chat rather than asserting the queue is empty: the queue is
 * shared with every other test in this file and «nobody was told» is the claim
 * being made, not «nothing happened anywhere».
 */
async function toldAnything(telegramId: number): Promise<boolean> {
  return (await pendingNotifications()).some((n) => n.chatId === telegramId);
}

async function statusOf(id: number): Promise<string> {
  const row = await db
    .prepare(`SELECT status FROM subscriptions WHERE id = ?1`)
    .bind(id)
    .first<{ status: string }>();
  return row!.status;
}

beforeAll(async () => {
  await ensureCatalog();
  // The credential comes from the environment rather than a sealed row, like
  // `sync.test.ts`: `credentialsFor` reads `PANEL_<CODE>` when there is no
  // `provider_secrets` row, and a sealed one would need the real
  // `PANEL_SECRET_KEY` to open.
  process.env.PANEL_ZZ_REMOVE_PANEL = 'admin:secret';
  const p = await db
    .prepare(
      `INSERT INTO provisioning_providers (code, name, kind, status, base_url, secret_ref)
       VALUES ('zz-remove-panel', 'پنل حذف', 'pasarguard', 'ACTIVE', 'https://remove.test',
               'zz-remove-panel')
       ON CONFLICT (code) DO UPDATE
         SET base_url = excluded.base_url, secret_ref = excluded.secret_ref
       RETURNING id`,
    )
    .first<{ id: number }>();
  providerId = Number(p!.id);
});

beforeEach(async () => {
  vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  deleted = [];
  await db.prepare(`DELETE FROM subscriptions WHERE provider_id = ?1`).bind(providerId).run();
  await armed();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key LIKE 'cron_%'`).run();
  invalidateShopSettings();
});

describe('the switch, before anything else', () => {
  it('does nothing at all while it is off', async () => {
    await setSetting('cron_remove_expired', 'false');
    const userId = await makeCustomer(nextTelegramId());
    const id = await makeService(userId, { publicId: 'rm-off', expiredDaysAgo: 90 });

    const out = await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS);

    expect(out).toMatchObject({ removed: 0, due: 0 });
    expect(deleted).toEqual([]);
    expect(await statusOf(id)).toBe('ACTIVE');
  });

  it('reports and deletes nothing while the dry run is on', async () => {
    await setSetting('cron_remove_dry_run', 'true');
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    const id = await makeService(userId, { publicId: 'rm-dry', expiredDaysAgo: 90 });

    const out = await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS);

    // It FOUND it — that is the report — and touched nothing.
    expect(out).toMatchObject({ removed: 0, due: 1, dryRun: true });
    expect(deleted).toEqual([]);
    expect(await statusOf(id)).toBe('ACTIVE');
    expect(await toldAnything(telegramId)).toBe(false);
  });
});

describe('removing a service the panel calls finished', () => {
  it('deletes it, marks the row, and tells the customer why', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    const id = await makeService(userId, { publicId: 'rm-1', expiredDaysAgo: 45 });

    const out = await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS);

    expect(out).toMatchObject({ removed: 1, failed: 0, dryRun: false });
    expect(deleted).toEqual(['u_rm-1']);
    expect(await statusOf(id)).toBe('REMOVED');

    const note = (await pendingNotifications()).find((n) => n.chatId === telegramId);
    expect(note?.text).toContain('یک‌ماهه-۵۰گیگ');
    // The number of days is in the message. A removal with no reason is the
    // one that produces a support ticket.
    expect(note?.text).toContain('45');
  });

  it('leaves it alone before the threshold', async () => {
    const userId = await makeCustomer(nextTelegramId());
    const id = await makeService(userId, { publicId: 'rm-early', expiredDaysAgo: 29 });

    expect((await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS)).due).toBe(0);
    expect(deleted).toEqual([]);
    expect(await statusOf(id)).toBe('ACTIVE');
  });

  it('refuses when the panel still calls it active, however long ago it expired', async () => {
    // The guard the parity is really about. Our date says «expired 200 days
    // ago»; the panel says the account is live. Deleting on our date alone is
    // how a working service disappears.
    const userId = await makeCustomer(nextTelegramId());
    const id = await makeService(userId, {
      publicId: 'rm-panel-active',
      expiredDaysAgo: 200,
      panelStatus: 'active',
    });

    expect((await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS)).due).toBe(0);
    expect(await statusOf(id)).toBe('ACTIVE');
  });

  it('refuses when the panel has said nothing at all', async () => {
    // NULL is «we do not know», and not knowing must never authorise a delete.
    // A panel that stops reporting status makes these sweeps stop.
    const userId = await makeCustomer(nextTelegramId());
    await makeService(userId, {
      publicId: 'rm-panel-silent',
      expiredDaysAgo: 200,
      panelStatus: null,
    });

    expect((await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS)).due).toBe(0);
    expect(deleted).toEqual([]);
  });
});

describe('removing a service that ran out of gigabytes', () => {
  it('goes by the last connection, not by the expiry date', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    // Not expired at all — a month of days left — but the panel limited it and
    // nobody has connected for three weeks.
    const id = await makeService(userId, {
      publicId: 'rm-vol',
      expiredDaysAgo: -30,
      panelStatus: 'limited',
      onlineDaysAgo: 21,
    });

    const out = await removeFinishedServices(db, 'volume', fakePanel(), NOW_MS);

    expect(out).toMatchObject({ removed: 1 });
    expect(deleted).toEqual(['u_rm-vol']);
    expect(await statusOf(id)).toBe('REMOVED');
    expect((await pendingNotifications()).find((n) => n.chatId === telegramId)?.text).toContain(
      'حجمش تمام شده بود',
    );
  });

  it('never touches a service the panel has no connection time for', async () => {
    // Bought and never plugged in. Mirzabot returns on the same condition, and
    // this customer belongs to the «unused» nudge rather than to a deletion.
    const userId = await makeCustomer(nextTelegramId());
    const id = await makeService(userId, {
      publicId: 'rm-vol-never',
      panelStatus: 'limited',
      onlineDaysAgo: null,
    });

    expect((await removeFinishedServices(db, 'volume', fakePanel(), NOW_MS)).due).toBe(0);
    expect(await statusOf(id)).toBe('ACTIVE');
  });

  it('refuses a service whose panel verdict is older than our own last write', async () => {
    /*
     * The customer just paid to top the account up, and this sweep would have
     * deleted it.
     *
     * `panel_status` and `panel_online_at` come from exactly one place —
     * `sync.ts`, every ten minutes. An add-on writes the new volume, the new
     * expiry and `last_synced_at = NULL`, and deliberately leaves the panel's
     * two columns alone, because it has no fresh reading of them. So for up to
     * ten minutes a just-topped-up account still reads `limited` with a
     * weeks-old last connection — and this sweep runs every twenty-five
     * seconds.
     *
     * NULL `last_synced_at` is the row saying «what you are about to judge me
     * on is out of date». There is no undoing a deletion, so it is refused.
     */
    const userId = await makeCustomer(nextTelegramId());
    await makeService(userId, {
      publicId: 'rm-vol-just-topped-up',
      panelStatus: 'limited',
      onlineDaysAgo: 60,
      syncedDaysAgo: null,
    });

    expect((await removeFinishedServices(db, 'volume', fakePanel(), NOW_MS)).due).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('refuses an expired service whose panel verdict is older than our own last write', async () => {
    // The same guard on the other sweep. A RENEWAL nulls `last_synced_at` too,
    // and a renewed service still carrying the panel's «expired» is exactly the
    // account that must not be deleted.
    const userId = await makeCustomer(nextTelegramId());
    await makeService(userId, {
      publicId: 'rm-exp-just-renewed',
      panelStatus: 'expired',
      expiredDaysAgo: 60,
      syncedDaysAgo: null,
    });

    expect((await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS)).due).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('will not take an expired account, because that is the other sweep', async () => {
    // The PHP's two overlapping status lists leave `limited` as the only word
    // that survives, and the two sweeps must not both claim one service —
    // which would delete it once and message the customer twice.
    const userId = await makeCustomer(nextTelegramId());
    await makeService(userId, {
      publicId: 'rm-vol-expired',
      panelStatus: 'expired',
      onlineDaysAgo: 60,
    });

    expect((await removeFinishedServices(db, 'volume', fakePanel(), NOW_MS)).due).toBe(0);
    expect(deleted).toEqual([]);
  });

  it('leaves it alone before the threshold', async () => {
    const userId = await makeCustomer(nextTelegramId());
    await makeService(userId, {
      publicId: 'rm-vol-early',
      panelStatus: 'limited',
      onlineDaysAgo: 16,
    });

    expect((await removeFinishedServices(db, 'volume', fakePanel(), NOW_MS)).due).toBe(0);
  });
});

describe('when the panel will not do it', () => {
  it('leaves the row ACTIVE so the next cycle tries again', async () => {
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    const id = await makeService(userId, { publicId: 'rm-fail', expiredDaysAgo: 45 });

    const out = await removeFinishedServices(
      db,
      'expired',
      fakePanel((url) => (url.includes('/api/user/') ? new Response('nope', { status: 503 }) : null)),
      NOW_MS,
    );

    expect(out).toMatchObject({ removed: 0, failed: 1 });
    // The account is still on the panel, so the row must still say so. Marking
    // it REMOVED here would hide a live account nobody is tracking.
    expect(await statusOf(id)).toBe('ACTIVE');
    expect(await toldAnything(telegramId)).toBe(false);
  });

  it('does not count a row another pass already took', async () => {
    /*
     * `removed` is «accounts this pass deleted», and it used to be «rows this
     * pass reached».
     *
     * The guarded UPDATE is what makes the removal at-most-once, so a row that
     * leaves ACTIVE between the SELECT and that write matches nothing — a
     * second poller during a rolling deploy, or an operator moving it by hand.
     * The counter incremented anyway, so `sweep.acted` reported an account this
     * sweep did not touch. The only hint was `told:false` in a log line.
     *
     * The window is staged where it actually occurs: the panel has done its
     * half, and the row moves before ours runs. A first draft of this test just
     * pre-set the row to REMOVED, which never reaches the loop at all —
     * `EXPIRED_DUE` requires ACTIVE — so it passed with the fix reverted and
     * proved nothing.
     */
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    const id = await makeService(userId, { publicId: 'rm-raced', expiredDaysAgo: 45 });

    // A second due row, on a second customer, that nothing races. It is what
    // makes the early `continue` a continuation rather than an exit: with one
    // fixture, turning that `continue` into a `break` changed nothing.
    const otherTelegramId = nextTelegramId();
    const otherUserId = await makeCustomer(otherTelegramId);
    await makeService(otherUserId, { publicId: 'rm-not-raced', expiredDaysAgo: 45 });

    let panelCalled = false;
    const racing = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/api/admin/token')) {
        return new Response(JSON.stringify({ access_token: 'tok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (init?.method === 'DELETE' && url.includes('/api/user/u_rm-raced')) {
        panelCalled = true;
        // Somebody else takes the row, after it was selected and after the
        // panel agreed, but before our guarded UPDATE. Only this row — the
        // other one takes the ordinary path in the same pass.
        await db
          .prepare(`UPDATE subscriptions SET status = 'REMOVED' WHERE id = ?1`)
          .bind(id)
          .run();
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;

    const out = await removeFinishedServices(db, 'expired', racing, NOW_MS);

    // It really was due and really reached the panel — without this the test
    // would pass for the wrong reason.
    expect(panelCalled).toBe(true);
    // Two were due; only the unraced one is counted, and `failed` stays 0 —
    // a raced row is not a panel failure and must not be retried as one.
    expect(out).toMatchObject({ due: 2, removed: 1, failed: 0, dryRun: false });
    // The customer whose row somebody else took is not told a second time
    // about a service that is already finished with.
    expect(await toldAnything(telegramId)).toBe(false);
    // The other one is, in the same pass.
    expect(await toldAnything(otherTelegramId)).toBe(true);
  });

  it('counts the row it moved even when the message was already queued', async () => {
    /*
     * The other half of the `{ claimed, told }` split. `claimed` is «our row
     * moved to REMOVED» and `told` is «the customer has a message owed to
     * them», and only the first decides the count.
     *
     * The state is reached the way production reaches it: the dedupe key is
     * already in `bot_notifications`, so `enqueue` returns false. Nothing
     * prunes that table, so a key written once is there for good — which is
     * exactly why `told` must not be allowed to zero the count.
     */
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    const id = await makeService(userId, { publicId: 'rm-told', expiredDaysAgo: 45 });

    await db
      .prepare(
        `INSERT INTO bot_notifications (dedupe_key, chat_id, body, status)
         VALUES (?1, ?2, 'anything', 'SENT')`,
      )
      .bind(`remove:${id}:expired`, telegramId)
      .run();

    const out = await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS);

    expect(deleted).toEqual(['u_rm-told']);
    expect(out).toMatchObject({ due: 1, removed: 1, failed: 0, dryRun: false });
    expect(await statusOf(id)).toBe('REMOVED');
    // Nothing new was queued — the key was taken — and that is not a reason to
    // report the removal as something that did not happen.
    expect(await toldAnything(telegramId)).toBe(false);
  });

  it('counts an account that was already gone as removed and still tells the customer', async () => {
    // A 404 is the end state that was asked for. Treating it as a failure
    // would retry against an account nobody can find, for ever.
    const telegramId = nextTelegramId();
    const userId = await makeCustomer(telegramId);
    const id = await makeService(userId, { publicId: 'rm-404', expiredDaysAgo: 45 });

    const out = await removeFinishedServices(
      db,
      'expired',
      fakePanel((url) => (url.includes('/api/user/') ? new Response('{}', { status: 404 }) : null)),
      NOW_MS,
    );

    expect(out).toMatchObject({ removed: 1, failed: 0 });
    expect(await statusOf(id)).toBe('REMOVED');
  });
});

describe('the ceiling', () => {
  it('never removes more than one batch in a pass', async () => {
    for (let i = 0; i < 14; i += 1) {
      const userId = await makeCustomer(nextTelegramId());
      await makeService(userId, { publicId: `rm-many-${i}`, expiredDaysAgo: 60 + i });
    }

    const first = await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS);
    expect(first.removed).toBe(10);

    // And the rest are still there for the next cycle rather than lost.
    const second = await removeFinishedServices(db, 'expired', fakePanel(), NOW_MS);
    expect(second.removed).toBe(4);
    expect(deleted).toHaveLength(14);
  });
});
