/**
 * The markup an admin's picker inserts.
 *
 * ## The list that used to be here is gone (2026-09-03)
 *
 * `PREMIUM_EMOJI_PACK` was fifteen hand-written entries, and its own comment
 * called them "sample ids" that "work today". They did not. Two entries carried
 * the SAME id under different glyphs (💳 and 📡 were both
 * `5469770986475151673`), and five ran in sequence —
 * `…082383`, `…082384`, `…082385` — which is what a number typed by a person
 * looks like, not one Telegram minted. An invented id does not render: the
 * customer sees the fallback glyph at best, and the shop believes it has a
 * feature it has never had.
 *
 * The ids now come from Telegram itself. An admin pastes a
 * `t.me/addemoji/…` link, the panel calls `getStickerSet`, and every id it
 * stores was reported by the same service that will later be asked to draw it.
 * See `emojiPackRoutes.ts` and migration 0050.
 *
 * What stays here is the one line both ends have to agree on: how an id and a
 * fallback glyph become the markup. The picker builds it, `checkCustomEmoji`
 * validates it, and `toTelegramHtml` sends it — three readers, one spelling.
 */

/** One choice in the picker: what Telegram draws, and what it draws instead. */
export interface PremiumEmoji {
  /** A short label the admin sees — the pack's title. */
  label: string;
  /** The single glyph between the tags — what a non-Premium viewer sees. */
  fallback: string;
  /** Telegram's custom-emoji id for this glyph. */
  id: string;
}

/**
 * The markup that turns one entry of a pack into the text an admin pastes.
 * Kept as one function so the picker and the shipped defaults cannot drift on
 * the order of `emoji-id` and the fallback.
 */
export function premiumEmojiTag(emoji: PremiumEmoji): string {
  return `<tg-emoji emoji-id="${emoji.id}">${emoji.fallback}</tg-emoji>`;
}
