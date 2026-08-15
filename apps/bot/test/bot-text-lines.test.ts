/**
 * Every line of every screen, and the two things line-by-line editing broke.
 *
 * The registry grew from 37 sentences to every line of every screen. That
 * creates two failure modes the old tests could not see:
 *
 *   1. a line in the registry that no screen actually reads — the admin edits
 *      it, saves it, and the bot keeps saying the old thing. Nothing looks
 *      broken; the edit simply has no effect.
 *   2. a screen long enough that Telegram refuses the whole message. Each line
 *      is capped on its own, which used to be the same as capping the message
 *      and no longer is.
 *
 * Both are checked here against something outside the registry: the bot's own
 * source for the first, a real send for the second.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TEXTS, TEXT_KEYS, SCREENS, SCREEN_IDS } from '@shikoo/contracts';
import { assertSchema, db } from './helpers/env.js';
import { ensureCatalog, planId, providerId } from './helpers/shop.js';
import { handleUpdate } from '../src/handle.js';
import { invalidateBotContent, loadBotContent } from '../src/botContent.js';
import { createTelegramApi, MAX_MESSAGE_LENGTH } from '../src/telegram.js';
import { DEFAULT_LAYOUT } from '../src/keyboard.js';
import * as menu from '../src/menu.js';

let nextId = 0;
function ids(): { updateId: number; telegramId: number } {
  const n = ++nextId * 10;
  return { updateId: 962_000 + n, telegramId: 833_000 + n };
}

function press(updateId: number, telegramId: number, data: string) {
  return {
    update_id: updateId,
    callback_query: {
      id: `cq-${updateId}`,
      from: { id: telegramId, username: `liner${telegramId}` },
      message: { message_id: 5151, chat: { id: telegramId } },
      data,
    },
  };
}

function startUpdate(updateId: number, telegramId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: telegramId, username: `liner${telegramId}` },
      chat: { id: telegramId },
      text: '/start',
    },
  };
}

async function clearOverrides(): Promise<void> {
  await db.prepare(`DELETE FROM bot_texts`).run();
  await db.prepare(`DELETE FROM bot_keyboard_buttons`).run();
  invalidateBotContent();
  menu.resetContent();
}

/** Loads what is in the database into the module bindings, as an update would. */
async function applySaved(): Promise<void> {
  invalidateBotContent();
  menu.applyContent(await loadBotContent(db));
}

beforeAll(async () => {
  await assertSchema();
  await ensureCatalog();
});

beforeEach(clearOverrides);
afterEach(clearOverrides);

describe('the registry and the code agree', () => {
  /** Every `.ts` file the bot ships, concatenated. Tests are not included: a
   *  key only a test mentions is still a key no customer ever sees. */
  const source = (() => {
    const dir = join(import.meta.dirname, '..', 'src');
    return readdirSync(dir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(dir, f), 'utf8'))
      .join('\n');
  })();

  it('reads every key it offers the admin', () => {
    // Outside truth for the registry: the bot's own source. A key nobody reads
    // is an edit box that silently does nothing — the admin saves a sentence,
    // the panel says "ذخیره شد", and the customer keeps seeing the old one.
    const unread = TEXT_KEYS.filter((key) => !source.includes(`'${key}'`));
    expect(unread).toEqual([]);
  });

  it('refreshes every live binding when content is applied', () => {
    // The silent gap this whole file exists to catch, in its purest form: an
    // `export let` initialised from the defaults but never reassigned in
    // `applyContent` reads correctly at boot and then ignores every override
    // for the life of the process. Nothing throws, nothing logs, and the admin
    // just watches their edit not happen.
    const menuSrc = readFileSync(join(import.meta.dirname, '..', 'src', 'menu.ts'), 'utf8');
    const apply = menuSrc.slice(
      menuSrc.indexOf('export function applyContent'),
      menuSrc.indexOf('export function resetContent'),
    );
    expect(apply.length).toBeGreaterThan(0);

    const bindings = [
      ...menuSrc.matchAll(/^export let ([A-Z_0-9]+) = DEFAULT_TEXTS\.raw\('([A-Z_0-9]+)'\);/gm),
    ].map((m) => ({ binding: m[1] as string, key: m[2] as string }));
    expect(bindings.length).toBeGreaterThan(30);

    const stale = bindings
      .filter(({ binding, key }) => !apply.includes(`${binding} = t.raw('${key}')`))
      .map(({ binding }) => binding);
    expect(stale).toEqual([]);
  });

  it('puts every key on a screen the panel can name', () => {
    const known = new Set(SCREEN_IDS);
    for (const key of TEXT_KEYS) {
      expect(known.has(TEXTS[key].screen), `${key} → ${TEXTS[key].screen}`).toBe(true);
    }
  });

  it('gives every screen a Persian name and at least one line', () => {
    const used = new Set(TEXT_KEYS.map((key) => TEXTS[key].screen));
    for (const id of SCREEN_IDS) {
      expect(SCREENS[id].trim(), `screen ${id}`).not.toBe('');
      expect(used.has(id), `screen ${id} has no lines`).toBe(true);
    }
  });
});

describe('a line inside a computed screen', () => {
  it('reaches the customer once the admin saves it', async () => {
    // The plan detail screen is assembled from eight possible lines. Before this
    // slice not one of them could be edited at all.
    const custom = '💳 مبلغی که می‌پردازید: {amount}';
    await db
      .prepare(`INSERT INTO bot_texts (key, value) VALUES ('PLAN_PAYABLE', ?1)`)
      .bind(custom)
      .run();
    invalidateBotContent();

    const { updateId, telegramId } = ids();
    const vip = await providerId('sim-vip');
    const plan = await planId('sim-vip-1m-50');

    await handleUpdate(db, startUpdate(updateId, telegramId));
    await handleUpdate(db, press(updateId + 1, telegramId, 'buy'));
    await handleUpdate(db, press(updateId + 2, telegramId, `panel:${vip}`));
    const detail = await handleUpdate(db, press(updateId + 3, telegramId, `plan:${plan}`));

    const text = detail.replies[0]?.text ?? '';
    expect(text).toContain('💳 مبلغی که می‌پردازید: 195,000 تومان');
    expect(text).not.toContain(TEXTS.PLAN_PAYABLE.default.replace('{amount}', ''));
  });

  it('reaches the invoice, which four screens now share', async () => {
    await db
      .prepare(`INSERT INTO bot_texts (key, value) VALUES ('CHECKOUT_EXACT_WARNING', ?1)`)
      .bind('همان مبلغ، بدون گرد کردن.')
      .run();
    invalidateBotContent();

    const { updateId, telegramId } = ids();
    const vip = await providerId('sim-vip');
    const plan = await planId('sim-vip-1m-50');

    await handleUpdate(db, startUpdate(updateId, telegramId));
    await handleUpdate(db, press(updateId + 1, telegramId, 'buy'));
    await handleUpdate(db, press(updateId + 2, telegramId, `panel:${vip}`));
    await handleUpdate(db, press(updateId + 3, telegramId, `plan:${plan}`));
    const placed = await handleUpdate(db, press(updateId + 4, telegramId, `order:${plan}`));

    expect(placed.replies[0]?.text).toContain('همان مبلغ، بدون گرد کردن.');
  });
});

describe('the renew button is quoted from the live keyboard', () => {
  /** The layout is stored whole, so a rename means saving every button. */
  async function saveLayoutWithRenewNamed(label: string): Promise<void> {
    for (const b of DEFAULT_LAYOUT) {
      await db
        .prepare(
          `INSERT INTO bot_keyboard_buttons (menu, action, label, row_index, col_index, visible)
           VALUES ('main', ?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(
          b.action,
          b.action === 'renew' ? label : b.label,
          b.rowIndex,
          b.colIndex,
          b.visible,
        )
        .run();
    }
    await applySaved();
  }

  const expired = {
    id: 1,
    status: 'ACTIVE',
    plan_name_at_sale: 'یک ماهه',
    volume_gb: 50,
    used_bytes: 0,
    expires_at: '2020-01-01T00:00:00.000Z',
    public_id: 'svc0000001',
    provider_name_at_sale: 'سیم',
    remote_username: 'u1',
    subscription_url: 'https://example.invalid/sub',
  };

  it('names the button as the admin renamed it, on all three screens', async () => {
    await saveLayoutWithRenewNamed('🔁 تمدید کن');

    // Not "all three read one variable" — each is checked for the new wording,
    // which is what a customer would be told to press.
    expect(menu.serviceDetail(expired, Date.now())).toContain('«🔁 تمدید کن»');
    expect(menu.timeRunningOut('یک ماهه', 3)).toContain('«🔁 تمدید کن»');
    expect(menu.volumeRunningOut('یک ماهه', 1_073_741_824)).toContain('«🔁 تمدید کن»');
  });

  it('never leaves the raw slot on a customer’s screen', async () => {
    // A layout that dropped the renew button entirely is legal. The sentence
    // then names the shipped label — wrong in a smaller way than `{renewButton}`.
    for (const b of DEFAULT_LAYOUT.filter((x) => x.action !== 'renew')) {
      await db
        .prepare(
          `INSERT INTO bot_keyboard_buttons (menu, action, label, row_index, col_index, visible)
           VALUES ('main', ?1, ?2, ?3, ?4, ?5)`,
        )
        .bind(b.action, b.label, b.rowIndex, b.colIndex, b.visible)
        .run();
    }
    await applySaved();

    for (const screen of [
      menu.serviceDetail(expired, Date.now()),
      menu.timeRunningOut('یک ماهه', 3),
      menu.volumeRunningOut('یک ماهه', 1_073_741_824),
    ]) {
      expect(screen).not.toContain('{renewButton}');
      expect(screen).toContain('تمدید سرویس');
    }
  });

  it('says the shipped label when no layout is saved at all', () => {
    expect(menu.timeRunningOut('یک ماهه', 3)).toContain('«♻️ تمدید سرویس»');
  });
});

describe('a screen longer than Telegram allows', () => {
  function apiCapturing() {
    const sent: { text: string }[] = [];
    const api = createTelegramApi({
      token: '1:t',
      baseUrl: 'http://fake.invalid',
      fetch: async (_input, init) => {
        sent.push(JSON.parse(String(init?.body)) as { text: string });
        return new Response(JSON.stringify({ ok: true, result: {} }), {
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    return { api, sent };
  }

  it('arrives shortened instead of not arriving', async () => {
    // Every line is under the cap on its own; their sum is not. Nothing in the
    // write path can see the sum, because it depends on the data in the slots.
    const { api, sent } = apiCapturing();
    await api.sendMessage(1, 'ا'.repeat(MAX_MESSAGE_LENGTH + 500));

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text.length).toBe(MAX_MESSAGE_LENGTH);
    expect(sent[0]?.text.endsWith('…')).toBe(true);
  });

  it('leaves a message that fits exactly alone', async () => {
    const { api, sent } = apiCapturing();
    const exact = 'ا'.repeat(MAX_MESSAGE_LENGTH);
    await api.sendMessage(1, exact);
    expect(sent[0]?.text).toBe(exact);
  });

  it('shortens an edit too, not only a new message', async () => {
    const { api, sent } = apiCapturing();
    await api.editMessageText(1, 2, 'ب'.repeat(MAX_MESSAGE_LENGTH + 1));
    expect(sent[0]?.text.length).toBe(MAX_MESSAGE_LENGTH);
  });
});
