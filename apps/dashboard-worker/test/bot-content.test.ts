/**
 * The admin side of the bot's wording and keyboard.
 *
 * The rules are not restated here — they are `checkOverride` and `checkLayout`
 * in `@shikoo/contracts`, which the bot also imports, and `apps/bot` already
 * tests them against what a customer receives. What this file checks is the
 * part only the route can get wrong: that a refusal actually refuses, that a
 * reset deletes rather than writes, and that the whole-layout replacement
 * leaves no half-saved keyboard behind.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';
import { DEFAULT_LAYOUT, TEXTS } from '@shikoo/contracts';

const ADMIN = 'admin@example.com';
const REVIEWER = 'reviewer-content@example.com';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

async function saveText(key: string, value: string, email = ADMIN) {
  return app.request(
    '/api/v1/admin/bot-texts',
    { method: 'POST', body: JSON.stringify({ key, value }) },
    envAs(email),
  );
}

async function saveLayout(buttons: unknown, email = ADMIN) {
  return app.request(
    '/api/v1/admin/bot-keyboard',
    { method: 'POST', body: JSON.stringify({ buttons }) },
    envAs(email),
  );
}

async function textRow(key: string) {
  return baseEnv.DB.prepare(`SELECT value, updated_by FROM bot_texts WHERE key = ?1`)
    .bind(key)
    .first<{ value: string; updated_by: string | null }>();
}

async function layoutRows() {
  const rows = await baseEnv.DB.prepare(
    `SELECT action, label, row_index, col_index, visible FROM bot_keyboard_buttons
      ORDER BY row_index, col_index`,
  ).all<{
    action: string;
    label: string;
    row_index: number;
    col_index: number;
    visible: boolean;
  }>();
  return rows.results ?? [];
}

async function purge(): Promise<void> {
  await baseEnv.DB.prepare(`DELETE FROM bot_texts`).run();
  await baseEnv.DB.prepare(`DELETE FROM bot_keyboard_buttons`).run();
}

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
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
  await purge();
  await baseEnv.DB.prepare(`TRUNCATE audit_logs CASCADE`).run();
});

afterAll(purge);

describe('GET /api/v1/admin/bot-texts', () => {
  it('lists every text the bot has, not just the edited ones', async () => {
    const res = await app.request('/api/v1/admin/bot-texts', {}, envAs(ADMIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{ key: string; value: string; customised: boolean }>;
    };
    // The registry is the list. A text nobody has touched has no row and must
    // still be visible and editable.
    expect(body.items.length).toBe(Object.keys(TEXTS).length);
    const welcome = body.items.find((i) => i.key === 'WELCOME')!;
    expect(welcome.customised).toBe(false);
    expect(welcome.value).toBe(TEXTS.WELCOME.default);
  });

  it('is readable by a reviewer', async () => {
    expect((await app.request('/api/v1/admin/bot-texts', {}, envAs(REVIEWER))).status).toBe(200);
  });
});

describe('POST /api/v1/admin/bot-texts', () => {
  it('stores an override and records who wrote it', async () => {
    const res = await saveText('WELCOME', 'سلام!');
    expect(res.status).toBe(200);

    const row = (await textRow('WELCOME'))!;
    expect(row.value).toBe('سلام!');
    expect(row.updated_by).toBe(ADMIN);

    const logs = await baseEnv.DB.prepare(
      `SELECT action FROM audit_logs WHERE entity_type = 'BOT_TEXT' AND entity_id = 'WELCOME'`,
    ).all<{ action: string }>();
    expect(logs.results?.map((l) => l.action)).toEqual(['bot_text.updated']);
  });

  it('stores the default as no row at all', async () => {
    await saveText('WELCOME', 'موقت');
    expect(await textRow('WELCOME')).not.toBeNull();

    // Saving the default back is the reset. Keeping a row that copies the
    // default would freeze this shop's wording at today's version.
    const res = await saveText('WELCOME', TEXTS.WELCOME.default);
    expect(((await res.json()) as { customised: boolean }).customised).toBe(false);
    expect(await textRow('WELCOME')).toBeNull();
  });

  it('refuses an override that drops a slot the screen needs', async () => {
    const res = await saveText('SUPPORT_SCREEN', 'به ما پیام بدهید');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };
    // The message names the slot, because "invalid" would leave the admin
    // guessing which of their edits was the problem.
    expect(body.detail).toContain('{handle}');
    expect(await textRow('SUPPORT_SCREEN')).toBeNull();
  });

  it('refuses a slot the text has no value for', async () => {
    const res = await saveText('WELCOME', 'سلام {name}');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain('{name}');
  });

  it('refuses an empty text and an unknown key', async () => {
    expect((await saveText('WELCOME', '   ')).status).toBe(400);
    expect((await saveText('NOT_A_KEY', 'x')).status).toBe(404);
  });

  it('is refused for a reviewer', async () => {
    expect((await saveText('WELCOME', 'nope', REVIEWER)).status).toBe(403);
    expect(await textRow('WELCOME')).toBeNull();
  });
});

describe('the keyboard', () => {
  const valid = [
    { action: 'buy', label: '🛒 خرید', rowIndex: 0, colIndex: 0, visible: true },
    { action: 'wal', label: '💰 کیف پول', rowIndex: 0, colIndex: 1, visible: true },
    { action: 'sup', label: '☎️ پشتیبانی', rowIndex: 1, colIndex: 0, visible: false },
  ];

  it('returns the default layout while nothing is saved', async () => {
    const res = await app.request('/api/v1/admin/bot-keyboard', {}, envAs(ADMIN));
    const body = (await res.json()) as {
      customised: boolean;
      buttons: Array<{ action: string }>;
      actions: Array<{ action: string }>;
    };
    expect(body.customised).toBe(false);
    expect(body.buttons.map((b) => b.action)).toEqual(DEFAULT_LAYOUT.map((b) => b.action));
    // The palette has to contain everything, or an admin cannot add back a
    // button they removed.
    expect(body.actions.length).toBeGreaterThanOrEqual(DEFAULT_LAYOUT.length);
  });

  it('replaces the whole layout rather than merging', async () => {
    expect((await saveLayout(DEFAULT_LAYOUT)).status).toBe(200);
    expect(await layoutRows()).toHaveLength(DEFAULT_LAYOUT.length);

    // A second, shorter save must leave the old buttons gone, not merged in.
    expect((await saveLayout(valid)).status).toBe(200);
    const rows = await layoutRows();
    expect(rows.map((r) => r.action)).toEqual(['buy', 'wal', 'sup']);
    expect(rows.find((r) => r.action === 'sup')!.visible).toBe(false);
  });

  it('refuses a keyboard with nothing a customer could press', async () => {
    const res = await saveLayout(valid.map((b) => ({ ...b, visible: false })));
    expect(res.status).toBe(400);
    // And leaves whatever was there alone.
    expect(await layoutRows()).toHaveLength(0);
  });

  it('refuses an action the bot cannot dispatch', async () => {
    const res = await saveLayout([{ ...valid[0], action: 'nope' }]);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toContain('nope');
  });

  it('refuses two buttons in one cell', async () => {
    const res = await saveLayout([valid[0], { ...valid[1], rowIndex: 0, colIndex: 0 }]);
    expect(res.status).toBe(400);
  });

  it('does not leave a half-written layout when a save is refused', async () => {
    await saveLayout(valid);
    const before = await layoutRows();

    // The DELETE and the INSERTs are one batch; a refusal happens before it.
    await saveLayout([{ ...valid[0], action: 'nope' }]);
    expect(await layoutRows()).toEqual(before);
  });

  it('resets by emptying the table', async () => {
    await saveLayout(valid);
    const res = await app.request(
      '/api/v1/admin/bot-keyboard/reset',
      { method: 'POST' },
      envAs(ADMIN),
    );
    expect(res.status).toBe(200);
    // Empty means "use the layout the code ships", so a button added by a
    // later release reaches a shop that reset.
    expect(await layoutRows()).toHaveLength(0);

    const after = await app.request('/api/v1/admin/bot-keyboard', {}, envAs(ADMIN));
    expect(((await after.json()) as { customised: boolean }).customised).toBe(false);
  });

  it('is refused for a reviewer', async () => {
    expect((await saveLayout(valid, REVIEWER)).status).toBe(403);
    expect(await layoutRows()).toHaveLength(0);
  });
});
