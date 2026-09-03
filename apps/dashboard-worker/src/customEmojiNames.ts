/**
 * Custom emoji in the two fields that are DATA rather than wording.
 *
 * The bot's texts have been checked at the write path since the feature
 * shipped: `botContentRoutes` refuses malformed markup, so an admin who mistypes
 * a tag hears about it at save time rather than by reading a customer's
 * complaint. A product name and a panel name had no such check at all — they
 * are columns, and nothing between them and Telegram looked at them.
 *
 * From 2026-09-03 they may carry a tag, so they get the same gate, from the same
 * function. `checkCustomEmoji` is the rule; this file only translates its answer
 * and asks the database whether the shop has the feature on.
 *
 * ## Why not just sanitise on the way in
 *
 * Because silently rewriting what somebody typed is how a setting becomes
 * inert. An admin who pastes a tag while the switch is off and gets it quietly
 * stripped saves, sees plain text, and has no way to find out that the switch
 * is the reason. A refusal names the reason.
 */

import type { D1Database } from '@shikoo/database';
import { checkCustomEmoji, type CustomEmojiProblem } from '@shikoo/contracts';

/**
 * Whether the shop has custom emoji on, read at save time.
 *
 * Not cached: this runs when an admin presses save, a few times a day, and a
 * stale answer would either refuse markup the shop just enabled or accept
 * markup it just turned off.
 */
export async function customEmojiOn(db: D1Database): Promise<boolean> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE scope = 'bot' AND key = 'custom_emoji'`)
    .first<{ value: unknown }>();
  return row?.value === true || row?.value === 'true';
}

/** The problem, in the admin's language. Same three sentences the texts use. */
export function emojiProblem(problem: CustomEmojiProblem): string {
  switch (problem.kind) {
    case 'NOT_ALLOWED':
      return 'ایموجی سفارشی خاموش است. کلیدش در صفحهٔ «متن‌های ربات» است — و فقط وقتی کار می‌کند که صاحب ربات اشتراک تلگرام پرمیوم داشته باشد.';
    case 'MALFORMED_TAG':
      return 'تگ درست نیست. شکل صحیح: <tg-emoji emoji-id="۵۳۶۸…">🔥</tg-emoji> و هیچ تگ دیگری پذیرفته نمی‌شود.';
    case 'BAD_FALLBACK':
      return 'بین دو تگ باید دقیقاً یک ایموجی باشد — همان چیزی که به مشتری بدون پرمیوم نشان داده می‌شود.';
  }
}

/**
 * Checks one name, and answers with the sentence to show or null.
 *
 * A name with no markup in it is accepted whatever the switch says, which is
 * what keeps this invisible to every shop that never uses the feature: the
 * check only has an opinion once a `<tg-emoji` appears.
 */
export async function checkNameEmoji(db: D1Database, name: string | undefined): Promise<string | null> {
  if (name === undefined || !name.includes('<tg-emoji')) return null;
  const problem = checkCustomEmoji(name, await customEmojiOn(db));
  return problem === null ? null : emojiProblem(problem);
}
