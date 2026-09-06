/**
 * Emoji packs — where the panel gets the ids from.
 *
 * The markup an admin types has a 64-bit number in it, and until now there was
 * nowhere on this panel to find one. A pack is a Telegram custom-emoji sticker
 * set, and `getStickerSet` answers with exactly the two halves the markup
 * needs — `custom_emoji_id` and the `emoji` a client without Premium draws —
 * so the ids are copied from Telegram's own answer rather than typed.
 *
 * ## This adds no second way to store an emoji
 *
 * The picker inserts the same `<tg-emoji>` markup the texts already hold,
 * `checkCustomEmoji` is still the gate, and `withEmojiFallback` is still the
 * landing. These routes fill a MENU. Nothing here is on the path that sends a
 * message, which is why a pack that is stale, empty or gone cannot cost a
 * customer their screen.
 *
 * ## Why the token is read the same way receipts read it
 *
 * `resolveBotToken` and not `c.env.TELEGRAM_BOT_TOKEN`: an operator who
 * connects a different bot from the panel gets a working shop, and a second
 * source of truth here would import packs against the OLD bot — which answers
 * for sets it can see and not for the ones the live bot can. Same call, same
 * answer, one place to change.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import { createLogger, resolveBotToken } from '@shikoo/domain';
import type { EnvName } from '@shikoo/contracts';
import { audit, type Ident } from './adminAudit.js';
import { faNum } from './fa.js';

const log = createLogger('dashboard');

/**
 * A set name, as Telegram spells it.
 *
 * Accepted as a bare name or as any of the links an admin will actually have in
 * their clipboard, because «paste the link» is the whole affordance: a form
 * that demands the name alone sends them to strip it by hand, and the first
 * thing they will paste is the link.
 *
 * The charset is Telegram's own for set names — letters, digits, underscore —
 * and it is enforced rather than trusted because this string is interpolated
 * into a URL.
 */
const SET_NAME = /^[A-Za-z0-9_]{1,64}$/;

export function setNameFrom(raw: string): string | null {
  const trimmed = raw.trim();
  const link = /(?:t\.me|telegram\.me)\/addemoji\/([A-Za-z0-9_]+)/i.exec(trimmed);
  const name = link ? (link[1] as string) : trimmed;
  return SET_NAME.test(name) ? name : null;
}

const PackAdd = z.object({ set: z.string().trim().min(1).max(200) }).strict();

/** One sticker, narrowed to the two fields a pack item is made of. */
const StickerSet = z.object({
  title: z.string().optional(),
  stickers: z.array(
    z.object({
      custom_emoji_id: z.string().optional(),
      emoji: z.string().optional(),
    }),
  ),
});

export interface PackItem {
  customEmojiId: string;
  fallbackEmoji: string;
}

/**
 * Asks Telegram what is in a set.
 *
 * A set that is not custom-emoji has no `custom_emoji_id` on its stickers, and
 * that is exactly how it is told apart — no second call, no `sticker_type`
 * string to match on. An empty result reaches the admin as «این ست ایموجی
 * سفارشی نیست», which is the true sentence: a normal sticker pack cannot go on
 * a button or in a message as an entity.
 */
export async function fetchStickerSet(
  token: string,
  setName: string,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<{ title: string; items: PackItem[] } | { error: string }> {
  let response: Response;
  try {
    response = await fetchImpl(
      `https://api.telegram.org/bot${token}/getStickerSet?name=${encodeURIComponent(setName)}`,
      { method: 'GET', signal: AbortSignal.timeout(15_000) },
    );
  } catch {
    // The token is in that URL, so nothing about this failure is echoed back.
    return { error: 'تلگرام جواب نداد. چند لحظه بعد دوباره امتحان کنید.' };
  }
  const body = (await response.json().catch(() => null)) as
    | { ok?: boolean; result?: unknown }
    | null;
  if (!body?.ok) return { error: 'تلگرام این ست را نشناخت. لینک یا نام ست را دوباره بررسی کنید.' };
  const parsed = StickerSet.safeParse(body.result);
  if (!parsed.success) return { error: 'پاسخ تلگرام قابل خواندن نبود.' };

  const items: PackItem[] = [];
  for (const sticker of parsed.data.stickers) {
    // Both halves or neither. A row with an id and no glyph would produce
    // `<tg-emoji emoji-id="…"></tg-emoji>`, which `checkCustomEmoji` refuses —
    // so the menu would offer a button that cannot be saved.
    if (sticker.custom_emoji_id && sticker.emoji) {
      items.push({ customEmojiId: sticker.custom_emoji_id, fallbackEmoji: sticker.emoji });
    }
  }
  return { title: parsed.data.title ?? setName, items };
}

/** Replaces a pack's items with what Telegram just said is in it. */
async function writeItems(db: D1Database, packId: number, items: PackItem[]): Promise<void> {
  // Deleted and rewritten rather than upserted: a sticker removed from the set
  // upstream has to leave the menu too, and an upsert would leave it behind for
  // ever with nothing to say why it is still there.
  await db.prepare(`DELETE FROM emoji_pack_items WHERE pack_id = ?1`).bind(packId).run();
  let order = 0;
  for (const item of items) {
    await db
      .prepare(
        `INSERT INTO emoji_pack_items (pack_id, custom_emoji_id, fallback_emoji, sort_order)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (pack_id, custom_emoji_id) DO UPDATE
           SET fallback_emoji = EXCLUDED.fallback_emoji, sort_order = EXCLUDED.sort_order`,
      )
      .bind(packId, item.customEmojiId, item.fallbackEmoji, order++)
      .run();
  }
}

export function registerEmojiPackRoutes(
  // The same shape `receiptRoutes` declares, and for the same reason: both need
  // the live bot token, and a second spelling of these bindings is a second
  // place for the app's type to drift away from them.
  app: Hono<{
    Bindings: { DB: D1Database; ENV_NAME: EnvName; TELEGRAM_BOT_TOKEN?: string };
    Variables: { identity: Ident };
  }>,
): void {
  /** Every pack and what is in it — one call, because a picker needs all of it. */
  app.get('/api/v1/admin/emoji-packs', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN' && ident.role !== 'REVIEWER') {
      return c.json({ ok: false, error: 'forbidden' }, 403);
    }
    const { results } = await c.env.DB.prepare(
      `SELECT p.id, p.set_name, p.title, p.active, p.synced_at,
              i.custom_emoji_id, i.fallback_emoji
         FROM emoji_packs p
         LEFT JOIN emoji_pack_items i ON i.pack_id = p.id
        WHERE p.active
        ORDER BY p.id, i.sort_order, i.custom_emoji_id`,
    ).all<{
      id: number;
      set_name: string;
      title: string;
      active: boolean;
      synced_at: string | null;
      custom_emoji_id: string | null;
      fallback_emoji: string | null;
    }>();

    const packs = new Map<number, Record<string, unknown>>();
    for (const row of results ?? []) {
      const pack = packs.get(row.id) ?? {
        id: row.id,
        setName: row.set_name,
        title: row.title,
        syncedAt: row.synced_at,
        emoji: [] as { id: string; fallback: string }[],
      };
      if (row.custom_emoji_id && row.fallback_emoji) {
        (pack['emoji'] as { id: string; fallback: string }[]).push({
          id: row.custom_emoji_id,
          fallback: row.fallback_emoji,
        });
      }
      packs.set(row.id, pack);
    }
    return c.json({ ok: true, packs: [...packs.values()] });
  });

  /** Adds a pack, or re-reads one that is already here. Same call either way. */
  app.post('/api/v1/admin/emoji-packs', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = PackAdd.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false, error: 'invalid_body' }, 400);

    const setName = setNameFrom(body.data.set);
    if (setName === null) {
      return c.json(
        {
          ok: false,
          error: 'invalid_body',
          detail: 'نام ست را یا لینک t.me/addemoji/… را بفرستید.',
        },
        400,
      );
    }

    // Wrapped, like `receiptRoutes` wraps it. `resolveBotToken` THROWS
    // `SecretKeyMissing` when a sealed token row exists and this service has no
    // `PANEL_SECRET_KEY` to open it — a deployment fact, not a server fault, and
    // letting it escape turns it into a 500 that tells the operator nothing.
    let token: string | undefined;
    try {
      token = (await resolveBotToken(c.env.DB, c.env.ENV_NAME, c.env))?.token;
    } catch (err) {
      log.warn('emoji_pack.token_unreadable', { set: setName }, err);
      return c.json(
        {
          ok: false,
          error: 'secret_key_missing',
          detail:
            'توکن ربات ذخیره شده ولی این سرویس PANEL_SECRET_KEY ندارد، پس نمی‌شود بازش کرد و از تلگرام پرسید.',
        },
        409,
      );
    }
    if (!token) {
      return c.json(
        {
          ok: false,
          error: 'no_bot_token',
          detail: 'هنوز رباتی وصل نشده، پس نمی‌شود از تلگرام پرسید این ست چه دارد.',
        },
        409,
      );
    }

    const set = await fetchStickerSet(token, setName);
    if ('error' in set) return c.json({ ok: false, error: 'telegram', detail: set.error }, 502);
    if (set.items.length === 0) {
      return c.json(
        {
          ok: false,
          error: 'not_custom_emoji',
          detail: 'این یک ست ایموجی سفارشی نیست — ست استیکر معمولی روی دکمه و در متن کار نمی‌کند.',
        },
        400,
      );
    }

    const pack = await c.env.DB.prepare(
      `INSERT INTO emoji_packs (set_name, title, synced_at)
       VALUES (?1, ?2, now())
       ON CONFLICT (set_name) DO UPDATE
         SET title = EXCLUDED.title, synced_at = now(), active = true
       RETURNING id`,
    )
      .bind(setName, set.title)
      .first<{ id: number }>();
    if (!pack) return c.json({ ok: false, error: 'not_saved' }, 500);

    await writeItems(c.env.DB, pack.id, set.items);
    await audit(
      c.env.DB,
      ident,
      'emoji_pack.sync',
      'emoji_pack',
      String(pack.id),
      null,
      { set: setName, count: set.items.length },
      null,
    );
    log.info('emoji_pack.synced', { set: setName, emoji: set.items.length });

    return c.json({
      ok: true,
      pack: { id: pack.id, setName, title: set.title, count: set.items.length },
      message: `${faNum(set.items.length)} ایموجی از «${set.title}» خوانده شد.`,
    });
  });

  /**
   * Hides a pack. The rows stay, and so does every id already typed into a text
   * — those are Telegram's ids, not ours, and removing a menu never un-sent a
   * message.
   */
  app.delete('/api/v1/admin/emoji-packs/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const row = await c.env.DB.prepare(
      `UPDATE emoji_packs SET active = false
        WHERE id = ?1 AND set_name <> '__builtin__' AND active
        RETURNING set_name`,
    )
      .bind(id)
      .first<{ set_name: string }>();
    // The built-in pack is not removable: it holds the emoji the shipped texts
    // already carry, so hiding it would leave those markup tags in the wording
    // with nothing on the panel explaining where they came from.
    if (!row) return c.json({ ok: false, error: 'not_found' }, 404);

    await audit(
      c.env.DB,
      ident,
      'emoji_pack.hide',
      'emoji_pack',
      String(id),
      { set: row.set_name, active: true },
      { set: row.set_name, active: false },
      null,
    );
    return c.json({ ok: true });
  });
}
