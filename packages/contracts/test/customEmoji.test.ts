/**
 * `customEmoji.ts` — the escape between an admin's typing and Telegram's parser.
 *
 * ## Why this file exists, when `apps/bot` already tests this
 *
 * It does, and thoroughly — through the bot, with a shop and a chat around it.
 * What that cannot say is what this module does on its own, and this module is
 * the one thing in `contracts` that is a TRUST BOUNDARY rather than a shape: it
 * decides what an admin may store and what reaches Telegram as markup. Its own
 * unit tests belong beside it.
 *
 * `apps/bot` proves the wiring. These prove the rule, and the cases below are
 * ones a bot test would have to build a whole shop to reach: a `<` an admin
 * typed in Persian, an unclosed tag, a fallback that is two emoji, a label that
 * is nothing BUT an emoji.
 */

import { describe, expect, it } from 'vitest';
import {
  checkCustomEmoji,
  hasCustomEmoji,
  splitCustomEmojiLabel,
  stripCustomEmoji,
  toTelegramHtml,
} from '../src/customEmoji.js';

const FIRE = '<tg-emoji emoji-id="5368324170671202286">\u{1F525}</tg-emoji>';

describe('hasCustomEmoji', () => {
  it('is true only for a well-formed tag', () => {
    expect(hasCustomEmoji(`سلام ${FIRE}`)).toBe(true);
    expect(hasCustomEmoji('سلام')).toBe(false);
    expect(hasCustomEmoji('<tg-emoji emoji-id="12">\u{1F525}')).toBe(false);
  });

  it('answers the same on a second call', () => {
    // `TAG` is a global regex, so `lastIndex` survives a call. A reader who
    // forgot to reset it gets `false` the second time for the same string —
    // the shape of bug that only shows up under a loop.
    const text = `سلام ${FIRE}`;
    expect([hasCustomEmoji(text), hasCustomEmoji(text)]).toEqual([true, true]);
  });
});

describe('checkCustomEmoji — what an admin may save', () => {
  it('accepts ordinary Persian that happens to contain a less-than sign', () => {
    // The reason this file exists rather than a global `parse_mode`. Such text
    // goes as plain text, so a lone `<` is a character; refusing it would stop
    // an admin writing a price range for no reason at all.
    const price = 'قیمت < ۱۰۰';
    expect(checkCustomEmoji(price, false)).toBeNull();
    expect(checkCustomEmoji(price, true)).toBeNull();
  });

  it('refuses markup while the shop has the feature off', () => {
    // Stored-then-drawn-as-brackets is the failure: the customer sees the raw
    // tag and nothing in the panel says why.
    expect(checkCustomEmoji(`سلام ${FIRE}`, false)).toEqual({
      kind: 'NOT_ALLOWED',
    });
  });

  it('refuses a broken tag whether the feature is on or off', () => {
    // A typo is a typo: the admin MEANT it to work, so it is not quietly
    // treated as text on the grounds that the feature is off.
    const broken = '<tg-emoji emoji-id="536">\u{1F525}';
    expect(checkCustomEmoji(broken, true)).toEqual({ kind: 'MALFORMED_TAG' });
    expect(checkCustomEmoji(broken, false)).toEqual({ kind: 'MALFORMED_TAG' });
  });

  it('refuses another tag once the message is going as HTML', () => {
    // With markup present the whole message is sent as HTML, so a `<b>` beside
    // it would reach Telegram's parser rather than the customer's screen.
    expect(checkCustomEmoji(`<b>x</b> ${FIRE}`, true)).toEqual({ kind: 'MALFORMED_TAG' });
  });

  it('refuses a fallback that is not exactly one emoji', () => {
    // Telegram requires one. Counted by grapheme — so two fires are two, and a
    // plain letter is none.
    expect(
      checkCustomEmoji('<tg-emoji emoji-id="1">\u{1F525}\u{1F525}</tg-emoji>', true),
    ).toEqual({ kind: 'BAD_FALLBACK' });
    expect(checkCustomEmoji('<tg-emoji emoji-id="1">a</tg-emoji>', true)).toEqual({
      kind: 'BAD_FALLBACK',
    });
  });

  it('accepts a fallback that is one emoji made of several code points', () => {
    // A family is one grapheme and several code points. A check counting UTF-16
    // units or code points would refuse it.
    expect(
      checkCustomEmoji(
        '<tg-emoji emoji-id="1">\u{1F468}\u200D\u{1F469}\u200D\u{1F466}</tg-emoji>',
        true,
      ),
    ).toBeNull();
  });

  it('refuses a flag or a keycap — a known ceiling, written down here', () => {
    /**
     * MEASURED, not intended. `isOneEmoji` asks two questions: one grapheme,
     * and `\p{Extended_Pictographic}`. A flag is one grapheme built from two REGIONAL INDICATOR
     * letters, and a keycap from a digit and U+20E3 — and neither of those base
     * characters carries that property. So both are refused although a person
     * would call each one emoji.
     *
     * Asserted rather than left silent, because the alternative is that
     * somebody changes it later and cannot tell whether the old behaviour was a
     * decision. It is not: this shop is Iranian and an admin reaching for a flag
     * is plausible. Out of scope for the change this test arrived with.
     */
    expect(
      checkCustomEmoji('<tg-emoji emoji-id="1">\u{1F1EE}\u{1F1F7}</tg-emoji>', true),
    ).toEqual({ kind: 'BAD_FALLBACK' });
    expect(checkCustomEmoji('<tg-emoji emoji-id="1">1\uFE0F\u20E3</tg-emoji>', true)).toEqual({
      kind: 'BAD_FALLBACK',
    });
  });
});

describe('toTelegramHtml', () => {
  it('keeps the tag and escapes everything around it', () => {
    expect(toTelegramHtml(`a < b ${FIRE} c & d`)).toBe(`a &lt; b ${FIRE} c &amp; d`);
  });

  it('leaves no angle bracket an admin typed as markup, anywhere', () => {
    // The claim in the module header, asserted directly: the only unescaped
    // tags in the output are ones this function itself rebuilt.
    const out = toTelegramHtml(`<script>x</script> ${FIRE} <b>y`);
    const withoutOurTags = out.replace(/<tg-emoji emoji-id="\d+">[^<>]+<\/tg-emoji>/g, '');
    expect(withoutOurTags).not.toMatch(/[<>]/);
  });

  it('escapes quotes, which sit next to an attribute', () => {
    expect(toTelegramHtml('he said "hi"')).toBe('he said &quot;hi&quot;');
  });
});

describe('stripCustomEmoji', () => {
  it('leaves the fallback glyph, so a message still says what it said', () => {
    // The safe landing when the owner has no Premium: plain text, not silence.
    expect(stripCustomEmoji(`a ${FIRE} b`)).toBe('a \u{1F525} b');
  });

  it('leaves text with no markup alone', () => {
    expect(stripCustomEmoji('سلام')).toBe('سلام');
  });
});

describe('splitCustomEmojiLabel — a button is not a message', () => {
  it('lifts a leading tag into the icon field', () => {
    // A button's `text` parses no markup at all; the emoji goes in a field of
    // its own. Left in place it would reach the customer as a literal tag.
    expect(splitCustomEmojiLabel(`${FIRE} خرید`)).toEqual({
      text: 'خرید',
      icon: '5368324170671202286',
    });
  });

  it('turns a tag further along into its own glyph', () => {
    // There is nowhere on a button for a second icon to go.
    expect(splitCustomEmojiLabel(`خرید ${FIRE}`)).toEqual({
      text: 'خرید \u{1F525}',
      icon: null,
    });
  });

  it('keeps the glyph when the label is nothing else', () => {
    // `icon` with an empty `text` is a button Telegram refuses, and the button
    // may be somebody's whole screen. So the glyph becomes the label.
    expect(splitCustomEmojiLabel(FIRE)).toEqual({ text: '\u{1F525}', icon: null });
  });

  it('leaves a plain label alone', () => {
    expect(splitCustomEmojiLabel('خرید')).toEqual({
      text: 'خرید',
      icon: null,
    });
  });
});
