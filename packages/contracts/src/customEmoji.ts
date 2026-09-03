/**
 * Telegram custom emoji, and the escaping that makes them safe to send.
 *
 * A bot may send a custom emoji in a private chat only if the **bot's owner**
 * has Telegram Premium. Ours only has private chats, so this is the whole of
 * the Premium surface worth building — message effects, `is_premium` branching
 * and Stars were considered and are not here.
 *
 * The markup is Telegram's own, and the admin types it themselves:
 *
 *     <tg-emoji emoji-id="5368324170671202286">🔥</tg-emoji>
 *
 * ## Why this file exists rather than a `parse_mode` flag
 *
 * The bot sends plain text today — `parse_mode` is set nowhere. Switching the
 * whole send path to HTML would make every `<` and `&` in a Persian sentence a
 * parse hazard: an admin who writes «قیمت < ۱۰۰ هزار» would get a message
 * Telegram refuses, and the customer would get nothing.
 *
 * So HTML is used for one message at a time — only one that actually carries
 * this markup — and everything outside the tags is escaped. That escape is a
 * trust boundary between admin-written text and Telegram's parser, and it is
 * not simplified: the tags are rebuilt from the parsed pieces rather than left
 * in place, so a `<` an admin typed cannot survive as markup.
 */

/**
 * One custom emoji, as an admin writes it.
 *
 * The id is digits — Telegram's ids are 64-bit numbers, kept as a string so
 * nothing rounds it. The fallback between the tags is what a client without the
 * emoji shows, and Telegram requires it to be exactly one emoji.
 */
const TAG = /<tg-emoji\s+emoji-id="(\d{1,24})">([^<>]{1,16})<\/tg-emoji>/g;

/** Anything that opens a tag we did not just match. */
const ANY_TAG = /<[^>]*>/;

export type CustomEmojiProblem =
  | { kind: 'NOT_ALLOWED' }
  | { kind: 'MALFORMED_TAG' }
  | { kind: 'BAD_FALLBACK' };

/** Whether the text carries at least one well-formed custom emoji. */
export function hasCustomEmoji(text: string): boolean {
  TAG.lastIndex = 0;
  return TAG.test(text);
}

/**
 * A single emoji, which is what Telegram requires between the tags.
 *
 * Counted by code point, not by UTF-16 unit: 🔥 is one emoji and two units, and
 * a flag or a family is more still. `Intl.Segmenter` gives grapheme clusters,
 * which is the unit a person means by "one emoji".
 */
function isOneEmoji(value: string): boolean {
  const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
  const graphemes = [...segmenter.segment(value)];
  if (graphemes.length !== 1) return false;
  return /\p{Extended_Pictographic}/u.test(value);
}

/**
 * Whether this text may be stored, given whether the shop has custom emoji on.
 *
 * Returns null when it is acceptable. Refusing at the write path is the point:
 * an admin who saves markup while the feature is off would see it stored and
 * then rendered as literal angle brackets to a customer, and nothing about the
 * panel would say why.
 */
export function checkCustomEmoji(text: string, allowed: boolean): CustomEmojiProblem | null {
  const withoutTags = text.replace(TAG, '');

  // A `tg-emoji` fragment that did not match the pattern above is a typo — an
  // unclosed tag, a quoted id with a letter in it — and it is refused whether or
  // not the rest of the text carries markup, because the admin meant it to work.
  if (/<\/?tg-emoji/.test(withoutTags)) return { kind: 'MALFORMED_TAG' };

  TAG.lastIndex = 0;
  const matches = [...text.matchAll(TAG)];

  // No markup means this message goes as plain text, and `parse_mode` is set
  // nowhere for it. A `<b>` or a lone `<` is then just characters, and refusing
  // them would stop an admin writing «قیمت < ۱۰۰ هزار» for no reason at all.
  if (matches.length === 0) return null;

  if (!allowed) return { kind: 'NOT_ALLOWED' };

  // From here the message WILL be sent as HTML, so every other tag in it would
  // reach Telegram's parser as markup rather than as text.
  if (ANY_TAG.test(withoutTags)) return { kind: 'MALFORMED_TAG' };

  for (const m of matches) {
    if (!isOneEmoji(m[2] as string)) return { kind: 'BAD_FALLBACK' };
  }
  return null;
}

/** HTML-escapes the five characters Telegram's parser cares about. */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The text as HTML Telegram will accept: tags kept, everything else escaped.
 *
 * Rebuilt from the matched pieces rather than escaped-around-in-place, so there
 * is no arrangement of characters an admin can type that leaves an unescaped
 * `<` outside a tag this function recognised.
 */
export function toTelegramHtml(text: string): string {
  let out = '';
  let at = 0;
  TAG.lastIndex = 0;
  for (const m of text.matchAll(TAG)) {
    out += escape(text.slice(at, m.index));
    out += `<tg-emoji emoji-id="${m[1] as string}">${escape(m[2] as string)}</tg-emoji>`;
    at = m.index + m[0].length;
  }
  return out + escape(text.slice(at));
}

/**
 * The text with every custom emoji replaced by its own fallback.
 *
 * The safe landing. A shop that turns this on without the owner having Premium
 * gets plain messages that still say what they were written to say, rather than
 * a bot that has stopped answering.
 */
export function stripCustomEmoji(text: string): string {
  return text.replace(TAG, (_whole, _id: string, fallback: string) => fallback);
}

/**
 * The same tag, anchored at the start of a label and matched once.
 *
 * Its own pattern rather than a reuse of `TAG`: that one is global, so it
 * carries `lastIndex` between calls, and every reader of this file has to
 * remember to reset it. This one cannot be stateful.
 */
const LEADING_TAG = /^\s*<tg-emoji\s+emoji-id="(\d{1,24})">([^<>]{1,16})<\/tg-emoji>\s*/;

/** A label split into what Telegram draws and what it draws it WITH. */
export interface EmojiLabel {
  /** The button's `text`, with no markup left in it. */
  text: string;
  /** The button's `icon_custom_emoji_id`, or null when there is none. */
  icon: string | null;
}

/**
 * A button label, split into a plain label and one custom-emoji id.
 *
 * ## Why a button cannot do what a message does
 *
 * A message carries entities, so `<tg-emoji>` anywhere in it renders where it
 * was written. A button's `text` is a plain string — Telegram parses no markup
 * in it at all — and the custom emoji goes in a field of its own,
 * `icon_custom_emoji_id`, which draws ONE emoji at the label's leading edge.
 *
 * So the shapes do not match, and this is where they are reconciled: the
 * LEADING tag becomes the icon, and any tag further along becomes its own
 * fallback glyph, because there is nowhere on a button for a second one to go.
 * Left as markup it would reach the customer as the literal text
 * `<tg-emoji emoji-id="…">🔥</tg-emoji>` on a button, which is the one outcome
 * worth ruling out.
 *
 * ## A label that is ONLY an emoji keeps its glyph
 *
 * `icon` plus an empty `text` is a button with no label. Telegram refuses that,
 * and refusing it here is not the answer either — the button is somebody's
 * whole screen. So a label that reduces to nothing keeps the fallback glyph as
 * its text and asks for no icon: the customer sees 🔥 rather than a shop that
 * stopped answering. Same rule mirzabot's `splitCustomEmojiLabel` arrived at.
 */
export function splitCustomEmojiLabel(label: string): EmojiLabel {
  const leading = LEADING_TAG.exec(label);
  const icon = leading ? (leading[1] as string) : null;
  const rest = stripCustomEmoji(leading ? label.slice(leading[0].length) : label);
  if (rest.trim() === '') return { text: stripCustomEmoji(label).trim(), icon: null };
  return { text: rest, icon };
}
