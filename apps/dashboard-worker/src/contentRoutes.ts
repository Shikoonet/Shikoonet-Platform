/**
 * بخش آموزش و برنامه‌ها — the two tables the bot reads and nobody could edit.
 *
 * `help_articles` (4 production rows) and `client_apps` (8) came over with the
 * migration and the bot has drawn both since «آموزش» was built. Until now the
 * only way to change either was an `INSERT` by hand, which meant the admin's own
 * `admin.php` was still the place those screens were written — and that stops
 * being true the day the PHP is switched off.
 *
 * Two things here are deliberately not what the legacy panel does.
 *
 * **Nothing is deleted while it might be on somebody's screen.** Neither table
 * has a foreign key pointing at it, so a `DELETE` would always succeed and there
 * is no constraint to lean on the way the catalogue does. `active` is what the
 * bot filters on, so hiding is the reversible action and removing is a separate,
 * explicit one — and a row that has never been active can simply go.
 *
 * **`media_id` is not editable.** It is a Telegram `file_id` from the OLD bot's
 * uploads, and a file id belongs to the bot that uploaded it: pasting one here
 * produces a send that fails at Telegram with nothing on the screen to explain
 * why. `content.ts` ignores the column for the same reason. Re-uploading the
 * four images is an admin job through the bot, not a form field.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import { audit, type Ident } from './adminAudit.js';

const ArticleBody = z
  .object({
    title: z.string().trim().min(1).max(200),
    category: z.string().trim().max(80).nullable().optional(),
    // The whole article is one Telegram message. 4096 is the hard cap and the
    // send path truncates rather than failing, so a longer body would be
    // silently cut on the customer's screen instead of refused on the admin's.
    body: z.string().max(3500),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    active: z.boolean().optional(),
  })
  .strict();

const AppBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    platform: z.string().trim().max(40).nullable().optional(),
    // A link the customer taps. `http`/`https` only: a `tg://` or `javascript:`
    // string is not something this shop should be putting in front of anybody.
    link: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((v) => /^https?:\/\//i.test(v), 'لینک باید با http یا https شروع شود'),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    active: z.boolean().optional(),
  })
  .strict();

interface ArticleRow {
  id: number;
  title: string;
  category: string | null;
  body: string;
  media_id: string | null;
  sort_order: number;
  active: boolean;
}

interface AppRow {
  id: number;
  name: string;
  platform: string | null;
  link: string;
  sort_order: number;
  active: boolean;
}

const shapeArticle = (r: ArticleRow) => ({
  id: Number(r.id),
  title: r.title,
  category: r.category,
  body: r.body,
  // Whether an image came over with the row, never the id itself: it belongs to
  // the old bot and is useless — and misleading — anywhere else.
  hasMedia: r.media_id !== null,
  sortOrder: r.sort_order,
  active: r.active,
});

const shapeApp = (r: AppRow) => ({
  id: Number(r.id),
  name: r.name,
  platform: r.platform,
  link: r.link,
  sortOrder: r.sort_order,
  active: r.active,
});

const SELECT_ARTICLE = `SELECT id, title, category, body, media_id, sort_order, active
                          FROM help_articles`;
const SELECT_APP = `SELECT id, name, platform, link, sort_order, active FROM client_apps`;

export function registerContentRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  // --- آموزش ---------------------------------------------------------------

  app.get('/api/v1/admin/help-articles', async (c) => {
    // Inactive rows are listed too. This is the screen where an admin turns one
    // back on, so hiding the hidden ones would hide the button that unhides.
    const rows = await c.env.DB.prepare(
      `${SELECT_ARTICLE} ORDER BY sort_order, id`,
    ).all<ArticleRow>();
    return c.json({ ok: true, items: (rows.results ?? []).map(shapeArticle) });
  });

  app.post('/api/v1/admin/help-articles', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = ArticleBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message }, 400);
    }

    const row = await c.env.DB.prepare(
      `INSERT INTO help_articles (title, category, body, sort_order, active)
       VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id`,
    )
      .bind(
        body.data.title,
        body.data.category ?? null,
        body.data.body,
        body.data.sortOrder ?? 0,
        body.data.active ?? true,
      )
      .first<{ id: number }>();
    if (!row) return c.json({ ok: false, error: 'insert_failed' }, 500);

    await audit(c.env.DB, ident, 'content.article_created', 'HELP_ARTICLE', String(row.id), null, {
      title: body.data.title,
    }, null);
    const created = await c.env.DB.prepare(`${SELECT_ARTICLE} WHERE id = ?1`)
      .bind(row.id)
      .first<ArticleRow>();
    return c.json({ ok: true, article: shapeArticle(created!) });
  });

  app.post('/api/v1/admin/help-articles/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = ArticleBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message }, 400);
    }

    const before = await c.env.DB.prepare(`${SELECT_ARTICLE} WHERE id = ?1`)
      .bind(id)
      .first<ArticleRow>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    await c.env.DB.prepare(
      `UPDATE help_articles
          SET title = ?2, category = ?3, body = ?4, sort_order = ?5, active = ?6
        WHERE id = ?1`,
    )
      .bind(
        id,
        body.data.title,
        body.data.category ?? null,
        body.data.body,
        body.data.sortOrder ?? before.sort_order,
        body.data.active ?? before.active,
      )
      .run();

    const after = await c.env.DB.prepare(`${SELECT_ARTICLE} WHERE id = ?1`)
      .bind(id)
      .first<ArticleRow>();
    await audit(
      c.env.DB,
      ident,
      'content.article_updated',
      'HELP_ARTICLE',
      String(id),
      { title: before.title, active: before.active },
      { title: after!.title, active: after!.active },
      null,
    );
    return c.json({ ok: true, article: shapeArticle(after!) });
  });

  app.delete('/api/v1/admin/help-articles/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    // Only a hidden row goes. In one statement rather than "read, check, delete"
    // — the shop is two admins on two phones, and the row can be switched back
    // on between the read and the delete.
    const gone = await c.env.DB.prepare(`DELETE FROM help_articles WHERE id = ?1 AND NOT active`)
      .bind(id)
      .run();
    if (gone.meta.changes === 0) {
      const exists = await c.env.DB.prepare(`SELECT active FROM help_articles WHERE id = ?1`)
        .bind(id)
        .first<{ active: boolean }>();
      if (!exists) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json(
        {
          ok: false,
          error: 'still_visible',
          detail: 'اول مطلب را از حالت نمایش خارج کنید، بعد حذفش کنید.',
        },
        409,
      );
    }

    await audit(c.env.DB, ident, 'content.article_deleted', 'HELP_ARTICLE', String(id), null, null, null);
    return c.json({ ok: true });
  });

  // --- برنامه‌ها ------------------------------------------------------------

  app.get('/api/v1/admin/client-apps', async (c) => {
    const rows = await c.env.DB.prepare(`${SELECT_APP} ORDER BY sort_order, id`).all<AppRow>();
    return c.json({ ok: true, items: (rows.results ?? []).map(shapeApp) });
  });

  app.post('/api/v1/admin/client-apps', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = AppBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message }, 400);
    }

    const row = await c.env.DB.prepare(
      `INSERT INTO client_apps (name, platform, link, sort_order, active)
       VALUES (?1, ?2, ?3, ?4, ?5) RETURNING id`,
    )
      .bind(
        body.data.name,
        body.data.platform ?? null,
        body.data.link,
        body.data.sortOrder ?? 0,
        body.data.active ?? true,
      )
      .first<{ id: number }>();
    if (!row) return c.json({ ok: false, error: 'insert_failed' }, 500);

    await audit(c.env.DB, ident, 'content.app_created', 'CLIENT_APP', String(row.id), null, {
      name: body.data.name,
      link: body.data.link,
    }, null);
    const created = await c.env.DB.prepare(`${SELECT_APP} WHERE id = ?1`).bind(row.id).first<AppRow>();
    return c.json({ ok: true, app: shapeApp(created!) });
  });

  app.post('/api/v1/admin/client-apps/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = AppBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message }, 400);
    }

    const before = await c.env.DB.prepare(`${SELECT_APP} WHERE id = ?1`).bind(id).first<AppRow>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    await c.env.DB.prepare(
      `UPDATE client_apps SET name = ?2, platform = ?3, link = ?4, sort_order = ?5, active = ?6
        WHERE id = ?1`,
    )
      .bind(
        id,
        body.data.name,
        body.data.platform ?? null,
        body.data.link,
        body.data.sortOrder ?? before.sort_order,
        body.data.active ?? before.active,
      )
      .run();

    const after = await c.env.DB.prepare(`${SELECT_APP} WHERE id = ?1`).bind(id).first<AppRow>();
    await audit(
      c.env.DB,
      ident,
      'content.app_updated',
      'CLIENT_APP',
      String(id),
      { name: before.name, link: before.link, active: before.active },
      { name: after!.name, link: after!.link, active: after!.active },
      null,
    );
    return c.json({ ok: true, app: shapeApp(after!) });
  });

  app.delete('/api/v1/admin/client-apps/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const gone = await c.env.DB.prepare(`DELETE FROM client_apps WHERE id = ?1 AND NOT active`)
      .bind(id)
      .run();
    if (gone.meta.changes === 0) {
      const exists = await c.env.DB.prepare(`SELECT active FROM client_apps WHERE id = ?1`)
        .bind(id)
        .first<{ active: boolean }>();
      if (!exists) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json(
        {
          ok: false,
          error: 'still_visible',
          detail: 'اول برنامه را از حالت نمایش خارج کنید، بعد حذفش کنید.',
        },
        409,
      );
    }

    await audit(c.env.DB, ident, 'content.app_deleted', 'CLIENT_APP', String(id), null, null, null);
    return c.json({ ok: true });
  });
}
