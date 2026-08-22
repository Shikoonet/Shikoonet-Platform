/**
 * کانال‌های اجباری — the channels a customer must join before the shop will
 * talk to them.
 *
 * `required_channels` arrived with `0005_ops.sql`, the importer carries the one
 * live row, and `apps/bot/src/gate.ts` reads it on every update. Nothing could
 * write it: adding or removing a channel meant an `INSERT` by hand.
 *
 * ## The failure this screen exists to make visible
 *
 * The gate fails open, deliberately — a Telegram that will not answer must not
 * stop the shop selling. The price is that a wrong `chat_ref`, or a bot that was
 * never made an admin of the channel, produces a gate that never fires and looks
 * exactly like a shop where everybody is already a member. No error, no log, no
 * broken screen.
 *
 * So `chat_ref` is validated to the shape `getChatMember` actually accepts —
 * `@username` or a numeric `-100…` id, and never a `t.me/…` URL, which is the
 * mistake that looks right — and the screen says plainly that the bot must be an
 * administrator of each channel. Neither is a substitute for one real
 * `getChatMember` before the cutover, and the wording says that too.
 *
 * ## Deactivating rather than deleting is the default
 *
 * `active` is what the gate reads, so switching a channel off is the whole
 * feature and takes effect on the next update. Deletion exists for a row typed
 * wrong, and is refused for a row that is still switched on: a channel removed
 * while it is gating customers is a gate that stops firing with nothing on any
 * screen to say it changed.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import { audit, type Ident } from './adminAudit.js';

/**
 * What Telegram accepts as a `chat_id`, and nothing else.
 *
 * A `https://t.me/shikoonet` here reaches Telegram as a chat that does not
 * exist; the gate fails open on the error and the whole feature is silently
 * inert. It is the single most likely thing to be pasted into this field,
 * because it is what the admin has in their clipboard.
 */
const CHAT_REF = /^(@[A-Za-z0-9_]{4,32}|-100\d{5,17})$/;

const ChannelBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    chatRef: z
      .string()
      .trim()
      .refine(
        (v) => CHAT_REF.test(v),
        'شناسهٔ کانال باید @username یا عدد -100… باشد — لینک t.me قبول نیست',
      ),
    joinLink: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((v) => /^https?:\/\//i.test(v), 'لینک عضویت باید با http یا https شروع شود'),
    active: z.boolean().optional(),
  })
  .strict();

interface ChannelRow {
  id: number;
  title: string;
  chat_ref: string;
  join_link: string;
  active: boolean;
}

const shape = (r: ChannelRow) => ({
  id: Number(r.id),
  title: r.title,
  chatRef: r.chat_ref,
  joinLink: r.join_link,
  active: r.active,
});

export function registerChannelRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  app.get('/api/v1/admin/required-channels', async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT id, title, chat_ref, join_link, active FROM required_channels ORDER BY id`,
    ).all<ChannelRow>();
    return c.json({ ok: true, items: (rows.results ?? []).map(shape) });
  });

  app.post('/api/v1/admin/required-channels', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = ChannelBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    // The unique index answers, rather than a read first. Two admins pasting the
    // same channel at once is exactly the case a look-then-insert misses.
    const row = await c.env.DB.prepare(
      `INSERT INTO required_channels (title, chat_ref, join_link, active)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (chat_ref) DO NOTHING
       RETURNING id`,
    )
      .bind(body.data.title, body.data.chatRef, body.data.joinLink, body.data.active ?? true)
      .first<{ id: number }>();
    if (!row) {
      return c.json(
        { ok: false, error: 'already_listed', detail: 'این کانال از قبل در فهرست است.' },
        409,
      );
    }

    await audit(
      c.env.DB,
      ident,
      'required_channel.added',
      'REQUIRED_CHANNEL',
      String(row.id),
      null,
      {
        chat_ref: body.data.chatRef,
        active: body.data.active ?? true,
      },
      null,
    );
    return c.json({ ok: true, id: Number(row.id) });
  });

  /**
   * Switches a channel on or off — the action that actually changes what
   * customers see, since `active` is the only column the gate reads.
   */
  app.post('/api/v1/admin/required-channels/:id/active', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);
    const body = z
      .object({ active: z.boolean() })
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false, error: 'invalid_body' }, 400);

    const done = await c.env.DB.prepare(
      `UPDATE required_channels SET active = ?2 WHERE id = ?1 RETURNING chat_ref`,
    )
      .bind(id, body.data.active)
      .first<{ chat_ref: string }>();
    if (!done) return c.json({ ok: false, error: 'not_found' }, 404);

    await audit(
      c.env.DB,
      ident,
      body.data.active ? 'required_channel.enabled' : 'required_channel.disabled',
      'REQUIRED_CHANNEL',
      String(id),
      null,
      { chat_ref: done.chat_ref, active: body.data.active },
      null,
    );
    return c.json({ ok: true });
  });

  app.delete('/api/v1/admin/required-channels/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    // Guarded inside the statement rather than by reading `active` first. A
    // channel switched off between the read and the delete is fine to remove;
    // one switched on is gating customers right now, and removing it stops the
    // gate firing with nothing anywhere saying it changed. Switch it off first —
    // that is a decision somebody made, and it is in the audit log.
    const gone = await c.env.DB.prepare(
      `DELETE FROM required_channels WHERE id = ?1 AND NOT active RETURNING chat_ref, title`,
    )
      .bind(id)
      .first<{ chat_ref: string; title: string }>();
    if (!gone) {
      const row = await c.env.DB.prepare(`SELECT active FROM required_channels WHERE id = ?1`)
        .bind(id)
        .first<{ active: boolean }>();
      if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json(
        {
          ok: false,
          error: 'still_active',
          detail: 'اول کانال را خاموش کنید — الان دارد جلوی مشتری‌ها را می‌گیرد.',
        },
        409,
      );
    }

    await audit(
      c.env.DB,
      ident,
      'required_channel.deleted',
      'REQUIRED_CHANNEL',
      String(id),
      { chat_ref: gone.chat_ref, title: gone.title },
      null,
      null,
    );
    return c.json({ ok: true });
  });
}
