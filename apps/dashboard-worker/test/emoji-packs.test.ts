/**
 * Emoji packs — the menu the picker reads from.
 *
 * What is being defended here is that the pack is ONLY a menu. Nothing in this
 * suite asserts a rendering behaviour, because a pack never renders anything:
 * the id it hands over goes into the same `<tg-emoji>` markup the texts have
 * always held, through the same `checkCustomEmoji` gate. So the interesting
 * failures are all about honesty — an id copied wrong, a normal sticker set
 * accepted as an emoji one, or a sticker removed upstream that stays in the
 * menu for ever.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';
import { checkCustomEmoji } from '@shikoo/contracts';
import { keyId, panelSecretKey, seal } from '@shikoo/domain';
import { fetchStickerSet, setNameFrom } from '../src/emojiPackRoutes.js';

const ADMIN = 'admin@example.com';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email, TELEGRAM_BOT_TOKEN: 'test-token' };
}



/** Telegram, answering with one custom-emoji set. */
function fakeTelegram(stickers: { custom_emoji_id?: string; emoji?: string }[], title = 'ست تست') {
  return (async () =>
    new Response(JSON.stringify({ ok: true, result: { title, stickers } }), {
      status: 200,
    })) as unknown as typeof globalThis.fetch;
}

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  await baseEnv.DB.prepare(`DELETE FROM emoji_pack_items WHERE pack_id IN
    (SELECT id FROM emoji_packs WHERE set_name <> '__builtin__')`).run();
  await baseEnv.DB.prepare(`DELETE FROM emoji_packs WHERE set_name <> '__builtin__'`).run();
  // A sealed token row another suite left behind sends `resolveBotToken` down
  // the `panelSecretKey` path, which throws without a key — so these tests
  // would answer 409 for a reason that has nothing to do with them. Cleared, so
  // the env token is what resolves.
  await baseEnv.DB.prepare(`DELETE FROM bot_credentials`).run();
});

describe('naming a pack', () => {
  it('takes the link an admin actually has in their clipboard', () => {
    // The form that demands a bare name sends them to strip it by hand, and the
    // first thing anybody pastes is the link.
    expect(setNameFrom('https://t.me/addemoji/ShikooPack')).toBe('ShikooPack');
    expect(setNameFrom('t.me/addemoji/ShikooPack')).toBe('ShikooPack');
    expect(setNameFrom('  ShikooPack ')).toBe('ShikooPack');
  });

  it('refuses anything that would not be safe in a URL', () => {
    // This string is interpolated into an api.telegram.org address.
    expect(setNameFrom('Shikoo Pack')).toBeNull();
    expect(setNameFrom('../../secret')).toBeNull();
    expect(setNameFrom('pack?name=x')).toBeNull();
  });
});

describe('reading a set from Telegram', () => {
  it('keeps only stickers that carry BOTH halves the markup needs', async () => {
    // An id with no glyph would build `<tg-emoji …></tg-emoji>`, which
    // `checkCustomEmoji` refuses — so the menu would be offering a button that
    // cannot be saved.
    const set = await fetchStickerSet(
      't',
      'X',
      fakeTelegram([
        { custom_emoji_id: '5111111111111111111', emoji: '🔥' },
        { custom_emoji_id: '5222222222222222222' },
        { emoji: '🎯' },
      ]),
    );
    expect('items' in set && set.items).toEqual([
      { customEmojiId: '5111111111111111111', fallbackEmoji: '🔥' },
    ]);
  });

  it('reads a plain sticker set as empty, not as a pack', async () => {
    // A normal sticker pack has no `custom_emoji_id` anywhere in it, and cannot
    // go on a button or into a message as an entity. Telling them apart by that
    // absence needs no second call.
    const set = await fetchStickerSet('t', 'X', fakeTelegram([{ emoji: '🐱' }, { emoji: '🐶' }]));
    expect('items' in set && set.items).toEqual([]);
  });

  it('every id it returns builds markup the validator accepts', async () => {
    // The end-to-end claim of the whole feature, asserted against the REAL
    // gate rather than against a regex restated here.
    const set = await fetchStickerSet(
      't',
      'X',
      fakeTelegram([{ custom_emoji_id: '5111111111111111111', emoji: '🔥' }]),
    );
    if (!('items' in set)) throw new Error('expected items');
    for (const item of set.items) {
      const markup = `<tg-emoji emoji-id="${item.customEmojiId}">${item.fallbackEmoji}</tg-emoji>`;
      expect(checkCustomEmoji(markup, true)).toBeNull();
    }
  });
});

describe('the pack tables', () => {
  it('ships a default pack, so a fresh install opens to something', async () => {
    const res = await app.request('/api/v1/admin/emoji-packs', {}, envAs(ADMIN));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      packs: { setName: string; emoji: { id: string; fallback: string }[] }[];
    };
    const builtin = body.packs.find((p) => p.setName === '__builtin__');
    expect(builtin).toBeDefined();
    // The three ids that are hard-coded in the shipped texts, so an admin can
    // finally reuse them somewhere else.
    expect(builtin!.emoji.map((e) => e.id)).toContain('5467566950868082386');
    expect(builtin!.emoji).toHaveLength(3);
  });

  it('drops a sticker that left the set upstream, instead of keeping it for ever', async () => {
    // The reason items are rewritten rather than upserted, and it goes through
    // the ROUTE: a menu that still offers something the set no longer has is a
    // menu nobody can trust, and nothing on the screen would explain why it is
    // still there.
    const pack = await baseEnv.DB.prepare(
      `INSERT INTO emoji_packs (set_name, title) VALUES ('ZzTestPack', 'قدیمی') RETURNING id`,
    ).first<{ id: number }>();
    await baseEnv.DB.prepare(
      `INSERT INTO emoji_pack_items (pack_id, custom_emoji_id, fallback_emoji, sort_order)
       VALUES (?1, '5999999999999999999', '🗑', 0)`,
    )
      .bind(pack!.id)
      .run();

    vi.stubGlobal(
      'fetch',
      fakeTelegram([{ custom_emoji_id: '5111111111111111111', emoji: '🔥' }], 'تازه'),
    );
    const res = await app.request(
      '/api/v1/admin/emoji-packs',
      { method: 'POST', body: JSON.stringify({ set: 'https://t.me/addemoji/ZzTestPack' }) },
      envAs(ADMIN),
    );
    vi.unstubAllGlobals();
    expect(res.status).toBe(200);

    const { results } = await baseEnv.DB.prepare(
      `SELECT custom_emoji_id FROM emoji_pack_items WHERE pack_id = ?1`,
    )
      .bind(pack!.id)
      .all<{ custom_emoji_id: string }>();
    // The stale one is gone, not merely outnumbered.
    expect(results?.map((r) => r.custom_emoji_id)).toEqual(['5111111111111111111']);
    // And the pack kept its identity rather than being duplicated under the
    // same set name, which the unique index is there to prevent.
    const count = await baseEnv.DB.prepare(
      `SELECT COUNT(*)::int AS n FROM emoji_packs WHERE set_name = 'ZzTestPack'`,
    ).first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('refuses a plain sticker set with a sentence that says why', async () => {
    vi.stubGlobal('fetch', fakeTelegram([{ emoji: '🐱' }]));
    const res = await app.request(
      '/api/v1/admin/emoji-packs',
      { method: 'POST', body: JSON.stringify({ set: 'ZzPlainPack' }) },
      envAs(ADMIN),
    );
    vi.unstubAllGlobals();
    expect(res.status).toBe(400);
    // Nothing half-written: a refused import leaves no pack behind.
    const row = await baseEnv.DB.prepare(
      `SELECT id FROM emoji_packs WHERE set_name = 'ZzPlainPack'`,
    ).first<{ id: number }>();
    expect(row).toBeNull();
  });

  it('says why when the bot token is sealed and this service has no key', async () => {
    // Found by a test answering 500. `resolveBotToken` THROWS `SecretKeyMissing`
    // rather than returning null, so an unwrapped call turns a deployment fact —
    // «this service was not given PANEL_SECRET_KEY» — into an Internal Server
    // Error that names nothing. `receiptRoutes` learned this on staging first.
    // Sealed with a REAL key, the way «پیکربندی › ربات تلگرام» seals one, and
    // stored under THIS service's `ENV_NAME`. Both details are load-bearing: a
    // nonsense value never reaches the unseal, and a row belonging to another
    // environment is skipped by design — either way the answer is a different
    // 409 and the throw is never exercised.
    const key = panelSecretKey({ PANEL_SECRET_KEY: 'a'.repeat(64) });
    await baseEnv.DB.prepare(
      `INSERT INTO bot_credentials (id, env_name, sealed, key_id, bot_id, set_by)
       VALUES (1, 'test', ?1, ?2, 8902884911, 'admin@example.com')`,
    )
      .bind(seal('8902884911:AAtest-only-not-a-real-token', key), keyId(key))
      .run();
    const env = { ...baseEnv, TEST_ACCESS_USER: ADMIN } as Record<string, unknown>;
    delete env['TELEGRAM_BOT_TOKEN'];
    delete env['PANEL_SECRET_KEY'];

    const res = await app.request(
      '/api/v1/admin/emoji-packs',
      { method: 'POST', body: JSON.stringify({ set: 'ZzAnyPack' }) },
      env,
    );

    expect(res.status).toBe(409);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'secret_key_missing' });
    await baseEnv.DB.prepare(`DELETE FROM bot_credentials`).run();
  });

  it('will not let the built-in pack be hidden', async () => {
    // It holds the emoji the shipped texts already carry. Hiding it would leave
    // that markup in the wording with nothing on the panel explaining it.
    const builtin = await baseEnv.DB.prepare(
      `SELECT id FROM emoji_packs WHERE set_name = '__builtin__'`,
    ).first<{ id: number }>();
    const res = await app.request(
      `/api/v1/admin/emoji-packs/${builtin!.id}`,
      { method: 'DELETE' },
      envAs(ADMIN),
    );
    expect(res.status).toBe(404);
    const still = await baseEnv.DB.prepare(
      `SELECT active FROM emoji_packs WHERE id = ?1`,
    )
      .bind(builtin!.id)
      .first<{ active: boolean }>();
    expect(still?.active).toBe(true);
  });
});
