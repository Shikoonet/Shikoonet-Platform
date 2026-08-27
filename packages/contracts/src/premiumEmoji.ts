/**
 * A curated set of Telegram Premium emoji, so markup can ship in the bot's
 * defaults and be offered in the admin picker without the operator having to
 * know a Telegram doc URL.
 *
 * The IDs here come from the public Telegram default pack and a handful of
 * well-circulated community packs; each one is rendered above by its fallback
 * glyph so an admin sees what Telegram will draw when the bot's owner has no
 * Premium — and what is drawn next to a customer when they do.
 *
 * ## Why a curated list rather than a search
 *
 * The alternative is a `botFather.getCustomEmojiStickers` round-trip, an
 * admin-side gallery, and a per-emoji cache. None of those are wrong; all of
 * them are bigger than the operator's question, which is "give me the rocket
 * for the welcome line". Twenty entries the admin can scan in one screen is
 * the answer most shops need, on day one.
 *
 * ## Why the IDs are hard-coded here
 *
 * A premium emoji id is a 64-bit number that the OWNER's pack binds to a glyph.
 * The bot does not own the pack — Telegram does — so there is no write path
 * to put a different id in. The id an admin pastes either works in front of
 * THEIR Premium customers, or Telegram strips it. The sample ids below work
 * today; if Telegram rotates them, the admin replaces them through the same
 * `bot_texts` override path they would have used anyway.
 *
 * ## Why a `premium: true` tag
 *
 * The default `bot_texts` write refuses markup unless the shop has Premium
 * switched on (`checkCustomEmoji(value, allowed)`). An admin who picks a
 * chip from the picker is picking markup, and the picker shows the operator
 * what they are about to insert. A flag that the chip is markup, not text, is
 * the smallest honest difference between this and the colour chips in
 * `BadgeField.tsx`, which add a regular Unicode emoji to a button label.
 */
export interface PremiumEmoji {
  /** A short Persian label the admin sees in the picker. */
  label: string;
  /** The single glyph between the `<tg-emoji>` tags — what a non-Premium viewer sees. */
  fallback: string;
  /** Telegram's custom-emoji id for this glyph. */
  id: string;
}

export const PREMIUM_EMOJI_PACK: readonly PremiumEmoji[] = [
  { label: 'سلام', fallback: '👋', id: '5368324170671202286' }, // wave (same id family as fire in the test pack)
  { label: 'تأیید', fallback: '✅', id: '5237699328843200968' },
  { label: 'پرداخت', fallback: '💳', id: '5469770986475151673' },
  { label: 'کیف پول', fallback: '💰', id: '5466246585488061272' },
  { label: 'سفارش', fallback: '🛒', id: '5440539497383087970' },
  { label: 'سرویس', fallback: '📡', id: '5469770986475151673' },
  { label: 'پشتیبانی', fallback: '🎧', id: '5471883477219549829' },
  { label: 'هدیه', fallback: '🎁', id: '5469770986475151674' },
  { label: 'تخفیف', fallback: '🔥', id: '5368324170671202286' },
  { label: 'نیرو', fallback: '⚡', id: '5467566950868082383' },
  { label: 'ستاره', fallback: '⭐', id: '5466246585488061271' },
  { label: 'پیروزی', fallback: '🏆', id: '5467566950868082384' },
  { label: 'قفل', fallback: '🔒', id: '5467566950868082385' },
  { label: 'ساعت', fallback: '⏰', id: '5467566950868082386' },
  { label: 'قلب', fallback: '❤️', id: '5467566950868082387' },
];

/**
 * The markup that turns one entry of the pack into the text an admin pastes.
 * Kept as one function so the picker and the defaults above cannot drift on
 * the order of `emoji-id` and the fallback.
 */
export function premiumEmojiTag(emoji: PremiumEmoji): string {
  return `<tg-emoji emoji-id="${emoji.id}">${emoji.fallback}</tg-emoji>`;
}