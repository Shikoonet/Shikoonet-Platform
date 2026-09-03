/**
 * The panel settings the old bot had, as this screen now saves them.
 *
 * Two properties are worth a suite of their own.
 *
 * A setting that saves and does nothing is worse than one that is missing: the
 * operator believes they have configured something. This project keeps finding
 * legacy examples — a `status_keyboard_config` switched on at the shop while
 * every panel is `offconfig`, an `inbound_deactive` switched on holding a value
 * that cannot parse. So the two settings that can be saved into being inert are
 * refused here, and the refusal is asserted.
 *
 * And `config` still carries a hysteria shared secret, which is why nothing may
 * hand the object back. Every one of these settings is exposed as a derived
 * field instead, and the last test plants a canary and looks for it anywhere in
 * the response.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-pm@example.com';
const REVIEWER = 'reviewer-pm@example.com';
const READER = 'reader-pm@example.com';
/** Sealing needs a key. Same 32-byte hex fixture `panel-create.test.ts` uses. */
const PANEL_KEY = '1'.repeat(64);
const PREFIX = 'zz-pm-test-';
const CONFIG_SECRET = 'zz-pm-canary-hysteria-secret';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

async function makePanel(label: string, config: Record<string, unknown> = {}): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `INSERT INTO provisioning_providers (code, name, kind, status, base_url, secret_ref, config)
     VALUES (?1, ?2, 'pasarguard', 'ACTIVE', 'https://panel.invalid', 'ref', ?3::jsonb)
     RETURNING id`,
  )
    .bind(
      `${PREFIX}${label}`,
      `پنل ${label}`,
      JSON.stringify({ proxies: { hysteria: { password: CONFIG_SECRET } }, ...config }),
    )
    .first<{ id: number }>();
  return Number(row!.id);
}

async function makeCustomer(telegramId: number): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `INSERT INTO users (telegram_id, username, registered_at)
     VALUES (?1, ?2, now())
     ON CONFLICT (telegram_id) DO UPDATE SET username = EXCLUDED.username
     RETURNING id`,
  )
    .bind(telegramId, `${PREFIX}u${telegramId}`)
    .first<{ id: number }>();
  return Number(row!.id);
}

function patch(id: number, body: unknown, email = ADMIN) {
  return app.request(
    `/api/v1/admin/panels/${id}`,
    { method: 'POST', body: JSON.stringify(body) },
    envAs(email),
  );
}

async function configOf(id: number): Promise<Record<string, unknown>> {
  const row = await baseEnv.DB.prepare(
    'SELECT config::text AS config FROM provisioning_providers WHERE id = ?1',
  )
    .bind(id)
    .first<{ config: string }>();
  return JSON.parse(row!.config) as Record<string, unknown>;
}

async function panelFromApi(id: number) {
  const res = await app.request('/api/v1/admin/panels', {}, envAs(ADMIN));
  const body = (await res.json()) as { items: { id: number }[] };
  return body.items.find((p) => p.id === id) as Record<string, unknown> | undefined;
}

async function purge(): Promise<void> {
  await baseEnv.DB.prepare(
    `DELETE FROM provider_hidden_users WHERE provider_id IN
       (SELECT id FROM provisioning_providers WHERE code LIKE ?1)`,
  )
    .bind(`${PREFIX}%`)
    .run();
  await baseEnv.DB.prepare('DELETE FROM provisioning_providers WHERE code LIKE ?1')
    .bind(`${PREFIX}%`)
    .run();
  await baseEnv.DB.prepare('DELETE FROM users WHERE username LIKE ?1').bind(`${PREFIX}%`).run();
}

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
    [READER, 'READ_ONLY'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }
});

beforeEach(async () => {
  process.env['PANEL_SECRET_KEY'] = PANEL_KEY;
  await purge();
});
afterAll(async () => {
  delete process.env['PANEL_SECRET_KEY'];
  await purge();
});

describe('روش ساخت نام کاربری', () => {
  it('saves the mode and its text', async () => {
    const id = await makePanel('username');
    const res = await patch(id, { usernameMode: 'PANEL_TEXT', usernameText: 'vipnode' });
    expect(res.status).toBe(200);

    const config = await configOf(id);
    expect(config['username_mode']).toBe('PANEL_TEXT');
    expect(config['username_text']).toBe('vipnode');
    // The Persian phrase underneath is never written from here — it is a value
    // out of `lang/fa.php`, and a shop that edited that file would repoint every
    // panel that still relied on it.
    expect(config['MethodUsername']).toBeUndefined();
  });

  /**
   * Without this the save succeeds, the screen says nothing, and every account
   * is still named after the Telegram id — because `usernamePrefix` falls back
   * when the text cannot be used. That is the exact failure shape this project
   * keeps finding in the legacy settings.
   */
  it('refuses a custom-text mode with no usable text', async () => {
    const id = await makePanel('username-empty');
    for (const text of [null, 'اسم', 'ab', '123']) {
      const res = await patch(id, { usernameMode: 'PANEL_TEXT', usernameText: text });
      expect(res.status).toBe(400);
    }
    expect((await configOf(id))['username_mode']).toBeUndefined();
  });

  it('accepts the mode alone when the panel already has a usable text', async () => {
    const id = await makePanel('username-stored', { username_text: 'already' });
    expect((await patch(id, { usernameMode: 'PANEL_TEXT' })).status).toBe(200);
    expect((await configOf(id))['username_mode']).toBe('PANEL_TEXT');
  });
});

describe('سرویس تست', () => {
  it('saves the switch and both numbers together', async () => {
    const id = await makePanel('trial');
    const res = await patch(id, {
      trialEnabled: true,
      trialVolumeGb: 2,
      trialDurationHours: 12,
    });
    expect(res.status).toBe(200);

    const config = await configOf(id);
    expect(config['trial_enabled']).toBe(true);
    expect(config['trial_volume_gb']).toBe(2);
    expect(config['trial_duration_hours']).toBe(12);

    const panel = await panelFromApi(id);
    expect(panel?.['trial']).toEqual({ enabled: true, volumeGb: 2, durationHours: 12 });
  });

  it('refuses to be switched on with a number missing', async () => {
    const id = await makePanel('trial-half');
    const res = await patch(id, { trialEnabled: true, trialVolumeGb: 2 });
    expect(res.status).toBe(400);
    expect((await configOf(id))['trial_enabled']).toBeUndefined();
  });

  it('lets the switch be turned on later, once the numbers are stored', async () => {
    const id = await makePanel('trial-later');
    expect((await patch(id, { trialVolumeGb: 2, trialDurationHours: 12 })).status).toBe(200);
    expect((await patch(id, { trialEnabled: true })).status).toBe(200);
    expect((await panelFromApi(id))?.['trial']).toEqual({
      enabled: true,
      volumeGb: 2,
      durationHours: 12,
    });
  });

  it('can always be switched off, whatever the numbers say', async () => {
    const id = await makePanel('trial-off', { trial_enabled: true });
    expect((await patch(id, { trialEnabled: false })).status).toBe(200);
    expect((await configOf(id))['trial_enabled']).toBe(false);
  });
});

describe('قیمت حجم و زمان اضافه', () => {
  it('writes the tier table the bot already charges from', async () => {
    const id = await makePanel('prices');
    const res = await patch(id, {
      extraVolumeTomanPerGb: { f: 5000, n: 4000, n2: null },
      extraTimeTomanPerDay: { f: 1500, n: 1000, n2: 1000 },
    });
    expect(res.status).toBe(200);

    // The LEGACY key, deliberately: `extraPricingFor` reads it and the bot has
    // been charging from it for weeks. A new key would mean two places a price
    // can live and a fallback deciding which one wins.
    const config = await configOf(id);
    expect(config['priceextravolume']).toEqual({ f: 5000, n: 4000, n2: null });
    expect(config['priceextratime']).toEqual({ f: 1500, n: 1000, n2: 1000 });

    expect((await panelFromApi(id))?.['extraVolumeTomanPerGb']).toEqual({
      f: 5000,
      n: 4000,
      n2: null,
    });
  });

  it('reads the legacy strings production actually stores', async () => {
    // Production holds these as TEXT containing JSON, not as jsonb objects —
    // `{"f":"50000","n":"5000","n2":"5000"}` on the VIP panel. A reader that
    // only handled objects would show every migrated panel as unpriced.
    const id = await makePanel('prices-legacy', {
      priceextravolume: '{"f":"50000","n":"5000","n2":"5000"}',
    });
    expect((await panelFromApi(id))?.['extraVolumeTomanPerGb']).toEqual({
      f: 50000,
      n: 5000,
      n2: 5000,
    });
  });

  it('refuses zero, which the bot reads as «not for sale»', async () => {
    const id = await makePanel('prices-zero');
    const res = await patch(id, { extraVolumeTomanPerGb: { f: 0, n: null, n2: null } });
    expect(res.status).toBe(400);
  });
});

describe('گروه اکانت غیرفعال', () => {
  it('saves group ids and reads them back', async () => {
    const id = await makePanel('downgrade');
    expect((await patch(id, { downgradeGroupIds: [3, 4] })).status).toBe(200);
    expect((await panelFromApi(id))?.['downgradeGroupIds']).toEqual([3, 4]);
  });

  it('clears back to «leave ended accounts alone»', async () => {
    const id = await makePanel('downgrade-clear', { downgrade_group_ids: [3] });
    expect((await patch(id, { downgradeGroupIds: null })).status).toBe(200);
    expect((await panelFromApi(id))?.['downgradeGroupIds']).toEqual([]);
  });
});

describe('مخفی کردن پنل برای یک کاربر', () => {
  function hidden(id: number, email = ADMIN) {
    return app.request(`/api/v1/admin/panels/${id}/hidden-users`, {}, envAs(email));
  }
  function hide(id: number, telegramId: number, email = ADMIN) {
    return app.request(
      `/api/v1/admin/panels/${id}/hidden-users`,
      { method: 'POST', body: JSON.stringify({ telegramId }) },
      envAs(email),
    );
  }
  function unhide(id: number, userId: number, email = ADMIN) {
    return app.request(
      `/api/v1/admin/panels/${id}/hidden-users/${userId}`,
      { method: 'DELETE' },
      envAs(email),
    );
  }

  it('starts empty and adds by Telegram id', async () => {
    const id = await makePanel('hidden');
    const userId = await makeCustomer(700_000_101);

    expect((await (await hidden(id)).json()) as unknown).toEqual({ ok: true, users: [] });

    expect((await hide(id, 700_000_101)).status).toBe(200);
    const list = (await (await hidden(id)).json()) as { users: { userId: number }[] };
    expect(list.users).toHaveLength(1);
    expect(list.users[0]).toMatchObject({ userId, telegramId: 700_000_101 });
  });

  /**
   * Legacy stores the bare number, so an id belonging to nobody and an id with a
   * typo in it are stored identically and both look like a working block.
   */
  it('refuses an id nobody has started the bot with', async () => {
    const id = await makePanel('hidden-unknown');
    const res = await hide(id, 700_000_999);
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toBe('user_not_found');
  });

  it('adding twice leaves one row and does not fail', async () => {
    const id = await makePanel('hidden-twice');
    await makeCustomer(700_000_102);
    expect((await hide(id, 700_000_102)).status).toBe(200);
    expect((await hide(id, 700_000_102)).status).toBe(200);
    const list = (await (await hidden(id)).json()) as { users: unknown[] };
    expect(list.users).toHaveLength(1);
  });

  it('removes, and says so when there was nothing to remove', async () => {
    const id = await makePanel('hidden-remove');
    const userId = await makeCustomer(700_000_103);
    await hide(id, 700_000_103);

    expect((await unhide(id, userId)).status).toBe(200);
    expect(((await (await hidden(id)).json()) as { users: unknown[] }).users).toHaveLength(0);
    // Not a cheerful 200: an admin who mistypes an id must not be told the block
    // was lifted. Legacy has three separate messages for this case.
    expect((await unhide(id, userId)).status).toBe(404);
  });

  it('is ADMIN-only to write and readable by a reviewer', async () => {
    const id = await makePanel('hidden-roles');
    await makeCustomer(700_000_104);
    expect((await hide(id, 700_000_104, REVIEWER)).status).toBe(403);
    await hide(id, 700_000_104);
    expect((await hidden(id, REVIEWER)).status).toBe(200);
    expect((await unhide(id, 1, REVIEWER)).status).toBe(403);
  });

  it('goes with the panel when the panel goes', async () => {
    const id = await makePanel('hidden-cascade');
    await makeCustomer(700_000_105);
    await hide(id, 700_000_105);
    await baseEnv.DB.prepare('DELETE FROM provisioning_providers WHERE id = ?1').bind(id).run();
    const left = await baseEnv.DB.prepare(
      'SELECT COUNT(*)::int AS n FROM provider_hidden_users WHERE provider_id = ?1',
    )
      .bind(id)
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });
});

describe('دو حالت تازهٔ نام کاربری', () => {
  it('saves the customer-typed mode with no panel text, and does not ask for one', async () => {
    // The PANEL_TEXT refusal must not be copied here: this mode's data arrives
    // per order, so there is nothing that could be missing at save time.
    const id = await makePanel('unamecust');
    expect((await patch(id, { usernameMode: 'CUSTOMER_TEXT' })).status).toBe(200);
    expect((await configOf(id))['username_mode']).toBe('CUSTOMER_TEXT');
  });

  it('saves the order-id mode', async () => {
    const id = await makePanel('unameorder');
    expect((await patch(id, { usernameMode: 'ORDER_ID' })).status).toBe(200);
    expect((await configOf(id))['username_mode']).toBe('ORDER_ID');
  });

  it('refuses a mode the builder would not recognise', async () => {
    // The schema's enum is `USERNAME_MODES`, the same list `usernameShapeFor`
    // reads. A mode accepted here and unknown there would save, report success,
    // and name every account after the Telegram id.
    const id = await makePanel('unamebad');
    expect((await patch(id, { usernameMode: 'RANDOM' })).status).toBe(400);
  });
});

describe('حداقل خرید حجم و زمان', () => {
  it('saves a floor and reads it back through the function the bot enforces with', async () => {
    const id = await makePanel('min');

    expect((await patch(id, { extraVolumeMinGb: 10, extraTimeMinDays: 3 })).status).toBe(200);

    // The legacy column names, because that is where the importer has been
    // putting these all along and where `extraBoundsFor` looks.
    const config = await configOf(id);
    expect(config['mainvolume']).toBe(10);
    expect(config['maintime']).toBe(3);
  });

  it('reads a legacy {f,n,n2} table the importer carried, not just a number', async () => {
    // Production rows hold the tier table. One bound per panel is Sam's answer,
    // so the `f` entry is the one read — and a test written only against the
    // number this screen writes would never have touched that path.
    const id = await makePanel('minlegacy', { mainvolume: '{"f":"25","n":"5","n2":"5"}' });

    const res = await app.request('/api/v1/admin/panels', {}, envAs(ADMIN));
    const body = (await res.json()) as { items: { id: number; extraVolumeMinGb: number | null }[] };
    expect(body.items.find((p) => p.id === id)?.extraVolumeMinGb).toBe(25);
  });

  it('clears a floor with null', async () => {
    const id = await makePanel('minclear', { mainvolume: 10 });
    expect((await patch(id, { extraVolumeMinGb: null })).status).toBe(200);
    expect((await configOf(id))['mainvolume']).toBeNull();
  });
});

describe('روش تمدید سرویس', () => {
  it('accepts the third mode', async () => {
    const id = await makePanel('renew3');
    expect((await patch(id, { renewMode: 'ADD_VOLUME_RESET_TIME' })).status).toBe(200);
    expect((await configOf(id))['renew_mode']).toBe('ADD_VOLUME_RESET_TIME');
  });

  it('refuses a mode nothing knows how to apply', async () => {
    // The schema's enum is `RENEW_MODES`, the same list `renewModeFor` reads.
    // A mode accepted here and unknown there would save, report success, and
    // silently renew as RESET.
    const id = await makePanel('renewbad');
    expect((await patch(id, { renewMode: 'ADD_TIME_RESET_VOLUME' })).status).toBe(400);
  });
});

describe('پنل فقط برای تازه‌واردها', () => {
  it('saves the tick and reads it back', async () => {
    const id = await makePanel('newcomers');
    expect((await patch(id, { newcomersOnly: true })).status).toBe(200);
    expect((await configOf(id))['newcomers_only']).toBe(true);

    const res = await app.request('/api/v1/admin/panels', {}, envAs(ADMIN));
    const body = (await res.json()) as { items: { id: number; newcomersOnly: boolean }[] };
    expect(body.items.find((p) => p.id === id)?.newcomersOnly).toBe(true);
  });

  it('is off on a panel nobody has ticked', async () => {
    const id = await makePanel('newcomers-off');
    const res = await app.request('/api/v1/admin/panels', {}, envAs(ADMIN));
    const body = (await res.json()) as { items: { id: number; newcomersOnly: boolean }[] };
    expect(body.items.find((p) => p.id === id)?.newcomersOnly).toBe(false);
  });
});

describe('یوزرنیم پنل', () => {
  /**
   * Half a credential, handed back on purpose — and only to an ADMIN.
   *
   * Sam asked to see which account a panel signs in with. The password is not
   * here and cannot be: nothing reads one back, which is what makes «خالی =
   * بدون تغییر» on that box true.
   */
  it('hands the username back to an admin, and never the password', async () => {
    const id = await makePanel('cred');
    const set = await app.request(
      `/api/v1/admin/panels/${id}/credentials`,
      { method: 'POST', body: JSON.stringify({ username: 'paneladmin', password: 'sup3r-s3cret' }) },
      envAs(ADMIN),
    );
    expect(set.status).toBe(200);

    const res = await app.request(
      `/api/v1/admin/panels/${id}/credential-username`,
      {},
      envAs(ADMIN),
    );
    const text = await res.text();

    expect(res.status).toBe(200);
    expect(JSON.parse(text)).toMatchObject({ ok: true, username: 'paneladmin' });
    // The half that must never travel.
    expect(text).not.toContain('sup3r-s3cret');
  });

  it('records who set it, which the screen has never been able to say', async () => {
    const id = await makePanel('credwho');
    await app.request(
      `/api/v1/admin/panels/${id}/credentials`,
      { method: 'POST', body: JSON.stringify({ username: 'u', password: 'p' }) },
      envAs(ADMIN),
    );
    const res = await app.request(
      `/api/v1/admin/panels/${id}/credential-username`,
      {},
      envAs(ADMIN),
    );
    expect(await res.json()).toMatchObject({ setBy: ADMIN });
  });

  it('is refused to a reviewer and to a reader', async () => {
    // The role that may CHANGE a credential is the role that may see one. A
    // REVIEWER may read what a panel is; who it signs in as is not that.
    const id = await makePanel('credrole');
    for (const who of [REVIEWER, READER]) {
      const res = await app.request(
        `/api/v1/admin/panels/${id}/credential-username`,
        {},
        envAs(who),
      );
      expect(res.status).toBe(403);
    }
  });

  it('answers null rather than inventing one when no credential is stored', async () => {
    const id = await makePanel('crednone');
    const res = await app.request(
      `/api/v1/admin/panels/${id}/credential-username`,
      {},
      envAs(ADMIN),
    );
    expect(await res.json()).toMatchObject({ ok: true, username: null });
  });
});

describe('none of it leaks the panel config', () => {
  it('never returns the hysteria secret, by any key, at any depth', async () => {
    const id = await makePanel('canary', {
      username_mode: 'PANEL_TEXT',
      username_text: 'vipnode',
      trial_enabled: true,
      trial_volume_gb: 2,
      trial_duration_hours: 12,
      downgrade_group_ids: [3],
    });
    const res = await app.request('/api/v1/admin/panels', {}, envAs(ADMIN));
    const text = await res.text();
    expect(text).not.toContain(CONFIG_SECRET);
    // and the settings themselves did arrive, so this is not passing by
    // returning nothing at all.
    expect(text).toContain('PANEL_TEXT');
    expect(String(id).length).toBeGreaterThan(0);
  });
});
