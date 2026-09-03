/**
 * The premium emoji an admin has given the bot, from inside the bot.
 *
 * ## Why this exists next to the panel's own pack screen
 *
 * The dashboard can import a whole sticker set by name, and that is the right
 * tool when you know the name. It is the wrong tool for «this emoji, the one I
 * just used»: a person who wants a particular glyph has it in their keyboard,
 * put there by their own Premium, and has no idea which set it came from.
 *
 * Telegram already answers that question. A message containing a custom emoji
 * arrives with an entity carrying `custom_emoji_id` — the exact number the
 * markup needs. So the admin sends the emoji to the bot and the bot reads the
 * id off the message. Nothing is typed and nothing is looked up.
 *
 * The round trip is also the only honest test of the feature: the bot draws the
 * emoji back on a button, and an admin who SEES it knows this bot can send it.
 * No documentation and no setting can tell you that — Telegram refuses a bot
 * whose owner has no Premium, and there is no API that says so beforehand.
 *
 * ## The rows are the panel's rows
 *
 * `emoji_packs` / `emoji_pack_items` from migration 0050, under a pack of their
 * own. A second table would have meant two answers to «what may I choose from»
 * and a picker in each place showing half of them.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import {
  DEFAULT_LAYOUTS,
  MAX_LABEL_LENGTH,
  labelMarkupProblem,
  renderedLabelLength,
  stripCustomEmoji,
} from '@shikoo/contracts';

type Db = D1Database | D1DatabaseSession;

/** The pack that holds what was sent to the bot rather than imported by name. */
const IN_BOT_PACK = '__from_bot__';

export interface StoredEmoji {
  /** The row's own id, so a button can name one without carrying the tag. */
  id: number;
  customEmojiId: string;
  fallbackEmoji: string;
}

/**
 * The custom emoji in a message, in the order they appear.
 *
 * Telegram gives offsets in UTF-16 units, which is what `String.prototype.slice`
 * counts in — so the fallback glyph is read out by slicing rather than by
 * guessing at code points. That glyph matters: it is what a customer without
 * Premium sees, and inventing one would put a different picture on their screen
 * from the one the admin chose.
 */
export function customEmojiIn(message: {
  text?: string | undefined;
  entities?:
    | { type: string; offset: number; length: number; custom_emoji_id?: string | undefined }[]
    | undefined;
}): { customEmojiId: string; fallbackEmoji: string }[] {
  const text = message.text ?? '';
  const found: { customEmojiId: string; fallbackEmoji: string }[] = [];
  for (const e of message.entities ?? []) {
    if (e.type !== 'custom_emoji' || !e.custom_emoji_id) continue;
    const fallback = text.slice(e.offset, e.offset + e.length);
    if (fallback === '') continue;
    found.push({ customEmojiId: e.custom_emoji_id, fallbackEmoji: fallback });
  }
  return found;
}

/**
 * Writes what the admin sent, and answers how many were new.
 *
 * `ON CONFLICT DO NOTHING` on the pack's own primary key, so sending the same
 * emoji twice is a no-op rather than a duplicate in the picker. The admin is
 * told the number either way — «۰ تازه» is a useful answer, not a failure.
 */
export async function rememberEmoji(
  db: Db,
  emoji: { customEmojiId: string; fallbackEmoji: string }[],
): Promise<number> {
  if (emoji.length === 0) return 0;
  const pack = await db
    .prepare(
      `INSERT INTO emoji_packs (set_name, title, synced_at)
       VALUES (?1, 'فرستاده‌شده در ربات', now())
       ON CONFLICT (set_name) DO UPDATE SET synced_at = now(), active = true
       RETURNING id`,
    )
    .bind(IN_BOT_PACK)
    .first<{ id: number }>();
  if (!pack) return 0;

  let added = 0;
  for (const item of emoji) {
    const row = await db
      .prepare(
        `INSERT INTO emoji_pack_items (pack_id, custom_emoji_id, fallback_emoji, sort_order)
         VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(sort_order), -1) + 1
                                FROM emoji_pack_items WHERE pack_id = ?1))
         ON CONFLICT (pack_id, custom_emoji_id) DO NOTHING
         RETURNING custom_emoji_id`,
      )
      .bind(pack.id, item.customEmojiId, item.fallbackEmoji)
      .first<{ custom_emoji_id: string }>();
    if (row) added += 1;
  }
  return added;
}

/** Everything the picker may offer, in the order the packs were added. */
export async function storedEmoji(db: Db, limit = 40): Promise<StoredEmoji[]> {
  const { results } = await db
    .prepare(
      `SELECT i.id, i.custom_emoji_id, i.fallback_emoji
         FROM emoji_pack_items i
         JOIN emoji_packs p ON p.id = i.pack_id
        WHERE p.active
        ORDER BY p.id, i.sort_order, i.id
        LIMIT ?1`,
    )
    .bind(limit)
    .all<{ id: number; custom_emoji_id: string; fallback_emoji: string }>();
  return (results ?? []).map((r) => ({
    id: r.id,
    customEmojiId: r.custom_emoji_id,
    fallbackEmoji: r.fallback_emoji,
  }));
}

/**
 * One of them by its own id.
 *
 * By ID and not by position in the list above — 0052 says why at length. A
 * button carries the row's identity, so the emoji an admin picked is the emoji
 * that gets written however the packs have changed since the screen was drawn.
 */
export async function emojiById(db: Db, id: number): Promise<StoredEmoji | null> {
  const row = await db
    .prepare(
      `SELECT i.id, i.custom_emoji_id, i.fallback_emoji
         FROM emoji_pack_items i
         JOIN emoji_packs p ON p.id = i.pack_id
        WHERE i.id = ?1 AND p.active`,
    )
    .bind(id)
    .first<{ id: number; custom_emoji_id: string; fallback_emoji: string }>();
  return row
    ? { id: row.id, customEmojiId: row.custom_emoji_id, fallbackEmoji: row.fallback_emoji }
    : null;
}

/**
 * Puts an emoji at the front of one main-menu button's label, and answers with
 * the label as it now reads.
 *
 * ## The shape is the one the send path can draw
 *
 * A leading tag becomes `icon_custom_emoji_id` on the button; anywhere else has
 * nowhere to render. `labelMarkupProblem` is the same rule the panel's own save
 * applies, asked here so the bot cannot write a layout the panel would refuse —
 * two writers, one definition of a valid label.
 *
 * ## Replacing rather than stacking
 *
 * `stripCustomEmoji` first, so pressing this twice on one button swaps the
 * emoji instead of collecting them. A button has ONE icon slot; a second tag
 * would be silently dropped at send time, and the admin would be looking at a
 * label they cannot explain.
 *
 * The row is written into `bot_keyboard_buttons`, which is where the panel
 * saves layouts — so the change is the shop's layout, visible in the panel, and
 * undone the same way anything else there is.
 */
export async function setButtonEmoji(
  db: Db,
  action: string,
  currentLabel: string,
  emoji: { customEmojiId: string; fallbackEmoji: string },
): Promise<string | null> {
  const plain = stripCustomEmoji(currentLabel).trim();
  const label = `<tg-emoji emoji-id="${emoji.customEmojiId}">${emoji.fallbackEmoji}</tg-emoji> ${plain}`;
  // Refused rather than written, and NULL rather than the old label — the
  // caller has to be able to tell «placed» from «could not».
  //
  // Two ways it can be refused, and the second was found by review rather than
  // by a test:
  //
  //   * a shape the send path cannot draw — a fallback glyph that is not one
  //     emoji, say — which would put raw markup on every customer's keyboard;
  //   * a label that is now too long. The glyph and its space add two or three
  //     characters, so a button already near the cap goes over it, and the only
  //     thing that noticed was the CHECK in 0053 — as an exception thrown out of
  //     an admin's button press, with a constraint name for a message.
  if (labelMarkupProblem(label)) return null;
  if (renderedLabelLength(label) > MAX_LABEL_LENGTH) return null;

  // ## The whole layout, or none of it
  //
  // A saved layout REPLACES the shipped one — `readLayouts` does
  // `layouts[menu] = buttons`, not a merge — so writing a single row for `main`
  // does not add an emoji to one button. It makes that button the entire menu,
  // for every customer, until somebody notices.
  //
  // An earlier version of this function wrote exactly one row. It passed its own
  // tests, because those pressed a button and then read the row back; what it
  // broke was every OTHER screen, which is how it was found — a suite that never
  // mentions emoji went red because «خرید» had vanished from the keyboard.
  //
  // So a shop with nothing saved gets the shipped layout written out in full,
  // with this one label changed. That is also what the panel's own save does,
  // which keeps the two writers producing the same kind of row.
  const anySaved = await db
    .prepare(`SELECT 1 AS present FROM bot_keyboard_buttons WHERE menu = 'main' LIMIT 1`)
    .first<{ present: number }>();

  if (!anySaved) {
    for (const b of DEFAULT_LAYOUTS['main']) {
      await db
        .prepare(
          `INSERT INTO bot_keyboard_buttons (menu, action, label, row_index, col_index, visible)
           VALUES ('main', ?1, ?2, ?3, ?4, ?5)
           ON CONFLICT (menu, action) DO NOTHING`,
        )
        .bind(
          b.action,
          b.action === action ? label : b.label,
          b.rowIndex,
          b.colIndex,
          b.visible,
        )
        .run();
    }
    // No early return here, and that is the fix rather than a tidy-up.
    //
    // Every insert above is `DO NOTHING`, so if another writer seeded this
    // layout between the SELECT and this loop — a second admin, or the panel
    // saving — all of them are no-ops, INCLUDING the target's. Returning
    // `label` at that point told the admin «نشست» about a button that still
    // carries somebody else's text. The update below is what makes the answer
    // true: it runs either way, and success is claimed only for a row that came
    // back from it.
  }

  const updated = await db
    .prepare(
      `UPDATE bot_keyboard_buttons SET label = ?2
        WHERE menu = 'main' AND action = ?1
       RETURNING action`,
    )
    .bind(action, label)
    .first<{ action: string }>();
  // Nothing came back, so nothing was written. Two ways to arrive: the button
  // is in `MENUS` but absent from this shop's saved layout — an admin removed
  // that row on purpose and putting it back would add a button they took off —
  // or the seed above lost a race with a layout that does not carry it. Both
  // are «could not», and the caller says so.
  if (!updated) return null;
  return label;
}
