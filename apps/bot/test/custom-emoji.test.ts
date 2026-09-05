/**
 * Telegram custom emoji: the escape, the switch, and the safe landing.
 *
 * Three things are being defended here, and they fail in different directions.
 *
 * The **escape** is a trust boundary. Every message the bot sends today is plain
 * text — `parse_mode` is set nowhere — so a Persian sentence containing `<` or
 * `&` is harmless. The moment one message goes as HTML, those characters become
 * a parse error and the customer gets nothing. So HTML is used for exactly the
 * messages that carry the markup, and everything outside the tags is escaped.
 *
 * The **switch** decides whether markup may be stored at all, and turning it off
 * must not throw away the shop's wording.
 *
 * The **landing** is what happens when Telegram says no — which is what it does
 * when the bot's owner has no Premium, and there is no API that would have said
 * so first.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkCustomEmoji,
  checkOverride,
  hasCustomEmoji,
  stripCustomEmoji,
  Texts,
  toTelegramHtml,
} from '@shikoo/contracts';
import { setEventSink, type LogRecord } from '@shikoo/domain';
import { assertSchema, db } from './helpers/env.js';
import { ensureCatalog, makeCustomer } from './helpers/shop.js';
import { handleUpdate } from '../src/handle.js';
import { createTelegramApi } from '../src/telegram.js';
import {
  CUSTOM_EMOJI_SETTING,
  disableCustomEmoji,
  invalidateShopSettings,
  loadShopSettings,
} from '../src/settings.js';
import { invalidateBotContent, loadBotContent } from '../src/botContent.js';

const FIRE = '<tg-emoji emoji-id="5368324170671202286">🔥</tg-emoji>';

let nextId = 0;
function ids(): { updateId: number; telegramId: number } {
  const n = ++nextId * 10;
  return { updateId: 977_000 + n, telegramId: 866_000 + n };
}

function startUpdate(updateId: number, telegramId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: telegramId, username: `ce${telegramId}` },
      chat: { id: telegramId },
      text: '/start',
    },
  };
}

async function setSwitch(on: boolean): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (scope, key, value) VALUES (?1, ?2, ?3::jsonb)
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value`,
    )
    .bind(CUSTOM_EMOJI_SETTING.scope, CUSTOM_EMOJI_SETTING.key, on ? 'true' : 'false')
    .run();
  invalidateShopSettings();
  invalidateBotContent();
}

async function putText(key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bot_texts (key, value) VALUES (?1, ?2)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    )
    .bind(key, value)
    .run();
  invalidateBotContent();
}

async function clearAll(): Promise<void> {
  await db.prepare(`DELETE FROM bot_texts`).run();
  await db
    .prepare(`DELETE FROM settings WHERE scope = ?1 AND key = ?2`)
    .bind(CUSTOM_EMOJI_SETTING.scope, CUSTOM_EMOJI_SETTING.key)
    .run();
  invalidateShopSettings();
  invalidateBotContent();
}

beforeAll(async () => {
  await assertSchema();
  await ensureCatalog();
});
beforeEach(clearAll);
afterEach(async () => {
  await clearAll();
  vi.restoreAllMocks();
});

describe('the markup itself', () => {
  it('recognises a well-formed tag and nothing else', () => {
    expect(hasCustomEmoji(`سلام ${FIRE}`)).toBe(true);
    expect(hasCustomEmoji('سلام 🔥')).toBe(false);
    // An id that is not digits is not a tag we will send.
    expect(hasCustomEmoji('<tg-emoji emoji-id="abc">🔥</tg-emoji>')).toBe(false);
  });

  it('refuses a fallback that is not exactly one emoji', () => {
    // Telegram requires one, and the fallback is the whole of what a customer
    // without Premium sees — two of them, or a letter, is a broken screen for
    // most of the shop's customers rather than a cosmetic problem.
    expect(checkCustomEmoji('<tg-emoji emoji-id="5">🔥🔥</tg-emoji>', true)).toEqual({
      kind: 'BAD_FALLBACK',
    });
    expect(checkCustomEmoji('<tg-emoji emoji-id="5">x</tg-emoji>', true)).toEqual({
      kind: 'BAD_FALLBACK',
    });
    // A family emoji is several code points and still one emoji.
    expect(checkCustomEmoji('<tg-emoji emoji-id="5">👨‍👩‍👧</tg-emoji>', true)).toBeNull();
  });

  it('refuses any other tag, so nothing else reaches an HTML parser', () => {
    for (const bad of [`<b>پررنگ</b> ${FIRE}`, '<tg-emoji emoji-id="5">🔥']) {
      expect(checkCustomEmoji(bad, true), bad).toEqual({ kind: 'MALFORMED_TAG' });
    }
  });

  it('escapes everything outside the tags', () => {
    // The failure this prevents: one message goes as HTML, and a `<` an admin
    // typed in an ordinary sentence becomes a parse error Telegram answers 400
    // to. The customer gets nothing and the log says "bad request".
    const html = toTelegramHtml(`قیمت < ۱۰۰ & ${FIRE} "نقل"`);
    expect(html).toContain('&lt;');
    expect(html).toContain('&amp;');
    expect(html).toContain('&quot;');
    expect(html).toContain('<tg-emoji emoji-id="5368324170671202286">🔥</tg-emoji>');
    // Exactly one tag survives — nothing an admin typed became markup.
    expect(html.match(/<tg-emoji/g)).toHaveLength(1);
    expect(html.match(/<(?!tg-emoji|\/tg-emoji)/g)).toBeNull();
  });

  it('falls back to the emoji between the tags', () => {
    expect(stripCustomEmoji(`سلام ${FIRE} خوش آمدید`)).toBe('سلام 🔥 خوش آمدید');
  });
});

describe('the switch', () => {
  it('is off unless the row says so, and is not a legacy off-word', async () => {
    // The shop switches read "on unless it holds its off-word", because they
    // describe a shop that has been selling for years. This one describes a
    // Premium subscription the bot cannot verify it has, so it is the other way
    // round.
    expect((await loadShopSettings(db)).customEmoji).toBe(false);
    await setSwitch(true);
    expect((await loadShopSettings(db)).customEmoji).toBe(true);
    await setSwitch(false);
    expect((await loadShopSettings(db)).customEmoji).toBe(false);
  });

  it('refuses markup at the write path while it is off', () => {
    expect(checkOverride('WELCOME', `سلام ${FIRE}`)).toEqual({ kind: 'NOT_ALLOWED' });
    expect(checkOverride('WELCOME', `سلام ${FIRE}`, { customEmoji: true })).toBeNull();
  });

  it('strips markup rather than dropping the shop’s sentence', async () => {
    // The important one. Rejecting the override would put the SHIPPED default
    // in front of the customer, so turning the feature off — or having it
    // turned off automatically — would silently throw away every sentence the
    // shop had rewritten.
    const rewritten = `به فروشگاه ما خوش آمدید ${FIRE}`;
    const off = new Texts({ WELCOME: rewritten }, false);
    expect(off.raw('WELCOME')).toBe('به فروشگاه ما خوش آمدید 🔥');

    const on = new Texts({ WELCOME: rewritten }, true);
    expect(on.raw('WELCOME')).toBe(rewritten);
  });

  it('strips markup out of the shipped defaults too, not only overrides', () => {
    // A default that ships with <tg-emoji> markup must behave the same way as
    // an override that carries markup: when the switch is off, the customer
    // sees the fallback glyph and never the literal tags. The send path then
    // has nothing in `hasCustomEmoji(text)`, no failed HTML send, no auto-
    // disable loop on a non-Premium owner.
    const off = new Texts({}, false);
    expect(off.raw('WELCOME')).not.toContain('tg-emoji');
    expect(off.raw('WELCOME')).toContain('👋');

    const on = new Texts({}, true);
    expect(on.raw('WELCOME')).toContain('tg-emoji');
  });

  it('sends the fallback to a real customer while it is off', async () => {
    await putText('WELCOME', `خوش آمدید ${FIRE}`);
    await setSwitch(false);

    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const out = await handleUpdate(db, startUpdate(updateId, telegramId));
    const text = out.replies[0]?.text ?? '';
    expect(text).toContain('خوش آمدید 🔥');
    expect(text).not.toContain('tg-emoji');

    // And with the switch on, the markup survives to the send path, which is
    // where it becomes HTML.
    await setSwitch(true);
    const again = ids();
    await makeCustomer(again.telegramId);
    const on = await handleUpdate(db, startUpdate(again.updateId, again.telegramId));
    expect(on.replies[0]?.text ?? '').toContain('tg-emoji');
  });
});

describe('a custom emoji on a BUTTON, when the shop has the feature off', () => {
  /**
   * The switch has to reach the keyboard, not only the wording.
   *
   * `Texts` has stripped markup when the feature is off since it shipped.
   * Labels went straight through, which was harmless while `checkLayout`
   * refused every tag on a label — and stopped being harmless the day a leading
   * tag became the way to put an emoji on a button.
   *
   * The cost is not a wrong screen. `withEmojiFallback` decides «is this
   * message rich» from the text AND both keyboards, so ONE tagged label makes
   * every screen in the shop take the premium path: sent, refused, stripped,
   * sent again. Telegram refusing once switches the feature off — and the tag
   * stays in the label, so the doubling goes on for ever, on exactly the shop
   * whose account cannot use the feature.
   */
  it('strips the tag from the label, so no screen pays for a refusal twice', async () => {
    await db
      .prepare(
        `INSERT INTO bot_keyboard_buttons (menu, action, label, row_index, col_index, visible)
         VALUES ('main', 'buy', ?1, 0, 0, true)
         ON CONFLICT (menu, action) DO UPDATE SET label = EXCLUDED.label`,
      )
      .bind(`${FIRE} خرید اشتراک`)
      .run();
    await setSwitch(false);
    invalidateBotContent();

    const content = await loadBotContent(db, Date.now(), false);
    const label = content.layouts['main'].find((b) => b.action === 'buy')?.label ?? '';

    expect(label).not.toContain('tg-emoji');
    // The glyph survives — the customer sees «🔥 خرید اشتراک», which is what the
    // fallback between the tags is written for.
    expect(label).toContain('🔥 خرید اشتراک');
  });

  it('keeps it when the shop has the feature on', async () => {
    await db
      .prepare(
        `INSERT INTO bot_keyboard_buttons (menu, action, label, row_index, col_index, visible)
         VALUES ('main', 'buy', ?1, 0, 0, true)
         ON CONFLICT (menu, action) DO UPDATE SET label = EXCLUDED.label`,
      )
      .bind(`${FIRE} خرید اشتراک`)
      .run();
    invalidateBotContent();

    const content = await loadBotContent(db, Date.now(), true);
    expect(content.layouts['main'].find((b) => b.action === 'buy')?.label ?? '').toContain(
      'tg-emoji',
    );
  });
});

describe('a custom emoji inside a NAME, not inside the wording', () => {
  // A product name and a panel name are DATA. They reach a screen through a
  // slot, and `raw()` had already made its stripping decision one step earlier —
  // so with the shop's switch off, a name an admin had put an emoji in arrived
  // at the customer as the literal `<tg-emoji …>` markup, in the middle of an
  // invoice. Nobody had seen it because nobody had yet typed one.

  it('strips a tag that arrived in a slot when the switch is off', () => {
    const texts = new Texts({}, false);
    const line = texts.render('CHECKOUT_SERVICE', { product: `${FIRE} پلاتینیوم` });
    expect(line).not.toContain('tg-emoji');
    expect(line).toContain('🔥 پلاتینیوم');
  });

  it('keeps it when the switch is on, so the message can render it', () => {
    const texts = new Texts({}, true);
    const line = texts.render('CHECKOUT_SERVICE', { product: `${FIRE} پلاتینیوم` });
    expect(line).toContain('tg-emoji');
  });
});

describe('sending it, and being refused', () => {
  /** A Telegram that answers however the test says, and records what it got. */
  function fakeTelegram(
    answers: ('ok' | 'reject' | 'network' | 'notmodified' | 'chatnotfound')[],
  ) {
    const bodies: Record<string, unknown>[] = [];
    let call = 0;
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      const answer = answers[call++] ?? 'ok';
      if (answer === 'network') throw new Error('socket hang up');
      if (answer === 'notmodified') {
        return new Response(
          JSON.stringify({
            ok: false,
            error_code: 400,
            description: 'Bad Request: message is not modified',
          }),
          { status: 400 },
        );
      }
      if (answer === 'chatnotfound') {
        return new Response(
          JSON.stringify({ ok: false, error_code: 400, description: 'Bad Request: chat not found' }),
          { status: 400 },
        );
      }
      return new Response(
        JSON.stringify(
          answer === 'ok'
            ? { ok: true, result: {} }
            : {
                ok: false,
                error_code: 400,
                description: 'Bad Request: CUSTOM_EMOJI_INVALID',
              },
        ),
        { status: answer === 'ok' ? 200 : 400 },
      );
    }) as unknown as typeof globalThis.fetch;
    return { bodies, fetchImpl };
  }

  it('leaves a plain message plain', async () => {
    // The ordinary path, and the one that must not change: `parse_mode` is
    // still set nowhere for a message with no markup, so a sentence full of `<`
    // is as safe as it was before this feature existed.
    const { bodies, fetchImpl } = fakeTelegram(['ok']);
    const api = createTelegramApi({ token: 't', baseUrl: 'https://x.test', fetch: fetchImpl });
    await api.sendMessage(1, 'قیمت < ۱۰۰ هزار');
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!['parse_mode']).toBeUndefined();
    expect(bodies[0]!['text']).toBe('قیمت < ۱۰۰ هزار');
  });

  it('sends markup as escaped HTML', async () => {
    const { bodies, fetchImpl } = fakeTelegram(['ok']);
    const api = createTelegramApi({ token: 't', baseUrl: 'https://x.test', fetch: fetchImpl });
    await api.sendMessage(1, `قیمت < ۱۰۰ ${FIRE}`);
    expect(bodies[0]!['parse_mode']).toBe('HTML');
    expect(bodies[0]!['text']).toContain('&lt;');
    expect(bodies[0]!['text']).toContain('<tg-emoji');
  });

  it('lands the message plain when Telegram refuses, and says so once', async () => {
    // No API tells the bot whether its owner has Premium. It finds out here.
    const refused = vi.fn();
    const { bodies, fetchImpl } = fakeTelegram(['reject', 'ok']);
    const api = createTelegramApi({
      token: 't',
      baseUrl: 'https://x.test',
      fetch: fetchImpl,
      onCustomEmojiRefused: refused,
    });

    await expect(api.sendMessage(1, `خوش آمدید ${FIRE}`)).resolves.toBeUndefined();
    expect(bodies).toHaveLength(2);
    // The customer got the screen, with the fallback emoji in it.
    expect(bodies[1]!['text']).toBe('خوش آمدید 🔥');
    expect(bodies[1]!['parse_mode']).toBeUndefined();
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('puts a leading emoji on the BUTTON, as an icon rather than as markup', async () => {
    // A button's `text` is plain — Telegram parses no markup in it — so the
    // only way a premium emoji reaches one is `icon_custom_emoji_id`. Sent as
    // markup it would arrive as the literal string on the button.
    const { bodies, fetchImpl } = fakeTelegram(['ok']);
    const api = createTelegramApi({ token: 't', baseUrl: 'https://x.test', fetch: fetchImpl });

    await api.sendMessage(1, 'یک متن ساده', [[{ text: `${FIRE} پلاتینیوم`, callback_data: 'x' }]]);

    const button = (bodies[0]!['reply_markup'] as { inline_keyboard: Record<string, unknown>[][] })
      .inline_keyboard[0]![0]!;
    expect(button['text']).toBe('پلاتینیوم');
    expect(button['icon_custom_emoji_id']).toBe('5368324170671202286');
    // The TEXT decided nothing here: it carries no markup, so no parse_mode.
    // Sending one would hand Telegram an unescaped Persian sentence.
    expect(bodies[0]!['parse_mode']).toBeUndefined();
  });

  it('keeps the glyph when the label is nothing but an emoji', async () => {
    // An icon with an empty label is a button with no text, which Telegram
    // refuses — and the button is somebody's whole screen.
    const { bodies, fetchImpl } = fakeTelegram(['ok']);
    const api = createTelegramApi({ token: 't', baseUrl: 'https://x.test', fetch: fetchImpl });

    await api.sendMessage(1, 'سلام', [[{ text: FIRE, callback_data: 'x' }]]);

    const button = (bodies[0]!['reply_markup'] as { inline_keyboard: Record<string, unknown>[][] })
      .inline_keyboard[0]![0]!;
    expect(button['text']).toBe('🔥');
    expect(button['icon_custom_emoji_id']).toBeUndefined();
  });

  it('lands the KEYBOARD plain too, not just the text', async () => {
    // The bug this pins: the retry used to re-send the identical keyboard, so a
    // shop whose Premium had just been refused sent the icon field again, was
    // refused again, and the customer got nothing at all.
    const refused = vi.fn();
    const { bodies, fetchImpl } = fakeTelegram(['reject', 'ok']);
    const api = createTelegramApi({
      token: 't',
      baseUrl: 'https://x.test',
      fetch: fetchImpl,
      onCustomEmojiRefused: refused,
    });

    await expect(
      api.sendMessage(1, 'یک متن ساده', [[{ text: `${FIRE} پلاتینیوم`, callback_data: 'x' }]]),
    ).resolves.toBeUndefined();

    expect(bodies).toHaveLength(2);
    const second = (bodies[1]!['reply_markup'] as { inline_keyboard: Record<string, unknown>[][] })
      .inline_keyboard[0]![0]!;
    expect(second['icon_custom_emoji_id']).toBeUndefined();
    expect(second['text']).toBe('🔥 پلاتینیوم');
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('tries the premium form even when only a BUTTON carries markup', async () => {
    // The ladder used to be entered on the text alone, so an emoji that lived
    // only on a button was sent once and never landed anywhere when refused.
    const refused = vi.fn();
    const { bodies, fetchImpl } = fakeTelegram(['reject', 'ok']);
    const api = createTelegramApi({
      token: 't',
      baseUrl: 'https://x.test',
      fetch: fetchImpl,
      onCustomEmojiRefused: refused,
    });

    await api.sendMessage(1, 'بدون ایموجی', [[{ text: `${FIRE} خرید`, callback_data: 'buy' }]]);

    expect(bodies).toHaveLength(2);
    expect(refused).toHaveBeenCalledTimes(1);
  });

  it('does not switch the feature off because a customer pressed twice', async () => {
    // Replacing a message with itself is answered 400 «message is not
    // modified» — and `call()` puts the word "rejected" on every 400, so it
    // arrived here looking exactly like Telegram refusing the emoji. It then
    // resent the message stripped, which of course succeeded (no entities makes
    // it a real change), concluded the owner has no Premium, and switched the
    // shop's feature off. Any customer could do it to the whole shop with two
    // taps, and nothing said why.
    const refused = vi.fn();
    const { bodies, fetchImpl } = fakeTelegram(['notmodified']);
    const api = createTelegramApi({
      // A token shaped like a real one, unlike the `'t'` the tests above use.
      // `call()` redacts the token out of every description it reports, and a
      // one-character token redacts a letter out of every English word — which
      // makes the message this test is about unrecognisable to the code reading
      // it. Harmless in production, where a token is 46 characters, and quietly
      // fatal to a test that matches on wording.
      token: '8000000000:AAHfakefakefakefakefakefakefakefakefake',
      baseUrl: 'https://x.test',
      fetch: fetchImpl,
      onCustomEmojiRefused: refused,
    });

    await expect(api.editMessageText(1, 5, `خوش آمدید ${FIRE}`)).resolves.toBeUndefined();

    // Nothing resent: the screen already said what we wanted it to say.
    expect(bodies).toHaveLength(1);
    expect(refused).not.toHaveBeenCalled();
  });

  it('does not switch the feature off because the network dropped', async () => {
    // A blip is not a refusal. Auto-disabling on one would turn a dropped
    // connection into a setting change nobody made.
    const refused = vi.fn();
    const { fetchImpl } = fakeTelegram(['network']);
    const api = createTelegramApi({
      token: 't',
      baseUrl: 'https://x.test',
      fetch: fetchImpl,
      onCustomEmojiRefused: refused,
    });

    await expect(api.sendMessage(1, `خوش آمدید ${FIRE}`)).rejects.toThrow();
    expect(refused).not.toHaveBeenCalled();
  });

  it('does not classify a dead destination as a custom-emoji refusal', async () => {
    // Both are Telegram 400 responses, but only CUSTOM_EMOJI_INVALID says
    // anything about the optional feature. Retrying a dead chat as plain text
    // used to produce the misleading custom_emoji_refused -> notify.dead pair
    // seen in production logs.
    const refused = vi.fn();
    const classified: LogRecord[] = [];
    setEventSink((record) => {
      if (record.evt === 'telegram.custom_emoji_refused') classified.push(record);
    });
    const { bodies, fetchImpl } = fakeTelegram(['chatnotfound', 'chatnotfound']);
    const api = createTelegramApi({
      token: '8000000000:AAHfakefakefakefakefakefakefakefakefake',
      baseUrl: 'https://x.test',
      fetch: fetchImpl,
      onCustomEmojiRefused: refused,
    });

    try {
      await expect(api.sendMessage(1, `خوش آمدید ${FIRE}`)).rejects.toThrow('chat not found');
    } finally {
      setEventSink(null);
    }
    // Telegram does not document every custom-emoji error sentence, so a 400
    // gets one plain probe. The same destination fails it too, which proves the
    // emoji was not the problem and prevents the global setting change.
    expect(bodies).toHaveLength(2);
    expect(refused).not.toHaveBeenCalled();
    expect(classified).toEqual([]);
  });

  it('turns the setting off in the database, and the bot obeys it', async () => {
    await setSwitch(true);
    await putText('WELCOME', `خوش آمدید ${FIRE}`);

    // Warm BOTH caches by sending a real screen first. Without this the test
    // proves nothing about the second cache: the wording is loaded with the
    // stripping decision already baked in, so an empty content cache would
    // reload correctly no matter what `disableCustomEmoji` invalidated.
    const warm = ids();
    await makeCustomer(warm.telegramId);
    const before = await handleUpdate(db, startUpdate(warm.updateId, warm.telegramId));
    expect(before.replies[0]?.text ?? '').toContain('tg-emoji');
    expect((await loadShopSettings(db)).customEmoji).toBe(true);

    await disableCustomEmoji(db);

    expect((await loadShopSettings(db)).customEmoji).toBe(false);
    // Both caches went, so the very next screen is already plain — not thirty
    // seconds of sending the markup that was just refused.
    const { updateId, telegramId } = ids();
    await makeCustomer(telegramId);
    const out = await handleUpdate(db, startUpdate(updateId, telegramId));
    expect(out.replies[0]?.text ?? '').toContain('خوش آمدید 🔥');
    expect(out.replies[0]?.text ?? '').not.toContain('tg-emoji');
  });
});
