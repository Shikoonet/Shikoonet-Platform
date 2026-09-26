import type { EnvName } from '@shikoo/contracts';
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

// The caps are the table's CHECKs (0105, 0106).
const answerFields = {
  question: z.string().trim().min(1).max(300),
  answer: z.string().trim().min(1).max(1500),
  // How customers asked it, one per line: what the bot recognises a message by.
  variants: z.string().max(4000).optional(),
  category: z.string().trim().max(60).optional(),
  // The right reply is a person: the bot passes these on instead of answering.
  handOff: z.boolean().optional(),
  note: z.string().max(1000).optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
  active: z.boolean().optional(),
};

const AnswerBody = z
  .object({
    ...answerFields,
    // On an edit, the version the form opened; a save made since is refused.
    version: z.number().int().min(1).optional(),
  })
  .strict();

/** One row of an imported dataset; `sourceKey` is its id there, so a re-import skips it. */
const ImportBody = z
  .object({
    items: z
      .array(z.object({ ...answerFields, sourceKey: z.string().trim().min(1).max(80) }).strict())
      .min(1)
      .max(500),
  })
  .strict();

interface AnswerRow {
  id: number;
  question: string;
  answer: string;
  variants: string;
  category: string;
  hand_off: boolean;
  note: string;
  source_key: string | null;
  sort_order: number;
  active: boolean;
  version: number;
  updated_at: string;
}

const shapeAnswer = (r: AnswerRow) => ({
  id: Number(r.id),
  question: r.question,
  answer: r.answer,
  variants: r.variants,
  category: r.category,
  handOff: r.hand_off,
  note: r.note,
  sourceKey: r.source_key,
  sortOrder: r.sort_order,
  active: r.active,
  version: r.version,
  updatedAt: r.updated_at,
});

const ANSWER_COLUMNS = `id, question, answer, variants, category, hand_off, note, source_key,
                        sort_order, active, version, updated_at`;
const SELECT_ANSWER = `SELECT ${ANSWER_COLUMNS} FROM support_answers`;

/** What an edit's audit row keeps: every field a later reader might want back. */
const answerHistory = (r: AnswerRow) => ({
  question: r.question,
  answer: r.answer,
  variants: r.variants,
  handOff: r.hand_off,
  active: r.active,
  version: r.version,
});

/** A pasted list may use Windows line ends, blank lines, or stray spaces. */
const cleanVariants = (v: string | undefined) =>
  (v ?? '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join('\n');

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
  app: Hono<{ Bindings: { DB: D1Database; ENV_NAME: EnvName }; Variables: { identity: Ident } }>,
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
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
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

    await audit(
      c.env.DB,
      ident,
      'content.article_created',
      'HELP_ARTICLE',
      String(row.id),
      null,
      {
        title: body.data.title,
      },
      null,
    );
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
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
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

    await audit(
      c.env.DB,
      ident,
      'content.article_deleted',
      'HELP_ARTICLE',
      String(id),
      null,
      null,
      null,
    );
    return c.json({ ok: true });
  });

  // --- پرسش و پاسخ پشتیبانی --------------------------------------------------
  //
  // What the support bot may say. The support door hands every visible row to
  // the bot on every message, so a save here is live on the next customer
  // question. Each edit bumps `version` and puts the text before and after in
  // audit_logs: that is the history an older wording is read back from.

  app.get('/api/v1/admin/support-answers', async (c) => {
    const rows = await c.env.DB.prepare(`${SELECT_ANSWER} ORDER BY sort_order, id`).all<AnswerRow>();
    return c.json({ ok: true, items: (rows.results ?? []).map(shapeAnswer) });
  });

  app.post('/api/v1/admin/support-answers', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = AnswerBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    // Every write below shares a transaction with its audit row: the log is the
    // only history of an answer's wording, so a write it missed is rolled back.
    const created = await c.env.DB.withSession(async (tx) => {
      const row = await tx
        .prepare(
          `INSERT INTO support_answers
             (question, answer, variants, category, hand_off, note, sort_order, active)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
           RETURNING ${ANSWER_COLUMNS}`,
        )
        .bind(
          body.data.question,
          body.data.answer,
          cleanVariants(body.data.variants),
          body.data.category ?? '',
          body.data.handOff ?? false,
          body.data.note ?? '',
          body.data.sortOrder ?? 0,
          body.data.active ?? true,
        )
        .first<AnswerRow>();
      if (!row) return null;
      await audit(
        tx,
        ident,
        'content.support_answer_created',
        'SUPPORT_ANSWER',
        String(row.id),
        null,
        answerHistory(row),
        null,
      );
      return row;
    });
    if (!created) return c.json({ ok: false, error: 'insert_failed' }, 500);
    return c.json({ ok: true, answer: shapeAnswer(created) });
  });

  /**
   * A whole dataset at once: the two hundred answers read out of the support
   * chats, uploaded from the admin's own machine (the file is private and
   * never in git). A row whose `sourceKey` is already here is skipped, not
   * overwritten, so importing again adds only what is new and keeps every
   * edit. Rows arrive hidden unless the file says otherwise; one audit row
   * names every key that went in.
   */
  app.post('/api/v1/admin/support-answers/import', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = ImportBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      const issue = body.error.issues[0];
      return c.json(
        { ok: false, error: 'invalid_body', detail: `${issue?.path.join('.')}: ${issue?.message}` },
        400,
      );
    }

    const added = await c.env.DB.withSession(async (tx) => {
      const base = await tx
        .prepare(`SELECT COALESCE(max(sort_order), 0)::int AS top FROM support_answers`)
        .first<{ top: number }>();
      const keys: string[] = [];
      for (const [i, it] of body.data.items.entries()) {
        const row = await tx
          .prepare(
            `INSERT INTO support_answers
               (question, answer, variants, category, hand_off, note, sort_order, active, source_key)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT (source_key) DO NOTHING
             RETURNING id`,
          )
          .bind(
            it.question,
            it.answer,
            cleanVariants(it.variants),
            it.category ?? '',
            it.handOff ?? false,
            it.note ?? '',
            it.sortOrder ?? Math.min(9999, (base?.top ?? 0) + 10 * (i + 1)),
            it.active ?? false,
            it.sourceKey,
          )
          .first<{ id: number }>();
        if (row) keys.push(it.sourceKey);
      }
      await audit(
        tx,
        ident,
        'content.support_answers_imported',
        'SUPPORT_ANSWER',
        'import',
        null,
        { added: keys.length, skipped: body.data.items.length - keys.length, keys },
        null,
      );
      return keys.length;
    });
    return c.json({ ok: true, added, skipped: body.data.items.length - added });
  });

  app.post('/api/v1/admin/support-answers/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = AnswerBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    const out = await c.env.DB.withSession(async (tx) => {
      // Locked, so two saves of one answer take turns and each one's «before»
      // is what the other left.
      const before = await tx
        .prepare(`${SELECT_ANSWER} WHERE id = ?1 FOR UPDATE`)
        .bind(id)
        .first<AnswerRow>();
      if (!before) return 'not_found' as const;
      // The form sends the version it opened. Another admin's save since then
      // is refused rather than silently written over.
      if (body.data.version !== undefined && body.data.version !== before.version) {
        return 'edited_elsewhere' as const;
      }
      const after = await tx
        .prepare(
          `UPDATE support_answers
              SET question = ?2, answer = ?3, variants = ?4, category = ?5, hand_off = ?6,
                  note = ?7, sort_order = ?8, active = ?9,
                  version = version + 1, updated_at = now()
            WHERE id = ?1
           RETURNING ${ANSWER_COLUMNS}`,
        )
        .bind(
          id,
          body.data.question,
          body.data.answer,
          body.data.variants === undefined ? before.variants : cleanVariants(body.data.variants),
          body.data.category ?? before.category,
          body.data.handOff ?? before.hand_off,
          body.data.note ?? before.note,
          body.data.sortOrder ?? before.sort_order,
          body.data.active ?? before.active,
        )
        .first<AnswerRow>();
      if (!after) return 'not_found' as const;
      // The whole text on both sides, not a summary: this row is the only
      // place the previous wording survives.
      await audit(
        tx,
        ident,
        'content.support_answer_updated',
        'SUPPORT_ANSWER',
        String(id),
        answerHistory(before),
        answerHistory(after),
        null,
      );
      return after;
    });
    if (out === 'not_found') return c.json({ ok: false, error: 'not_found' }, 404);
    if (out === 'edited_elsewhere') {
      return c.json(
        {
          ok: false,
          error: 'edited_elsewhere',
          detail: 'این پرسش و پاسخ همین حالا جای دیگری ویرایش شد؛ صفحه را تازه کنید و دوباره ویرایش کنید.',
        },
        409,
      );
    }
    return c.json({ ok: true, answer: shapeAnswer(out) });
  });

  app.delete('/api/v1/admin/support-answers/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    // Only a hidden answer goes, in one statement, as for «آموزش».
    const gone = await c.env.DB.withSession(async (tx) => {
      const row = await tx
        .prepare(`DELETE FROM support_answers WHERE id = ?1 AND NOT active RETURNING question, answer`)
        .bind(id)
        .first<{ question: string; answer: string }>();
      if (row) {
        await audit(tx, ident, 'content.support_answer_deleted', 'SUPPORT_ANSWER', String(id), row, null, null);
      }
      return row;
    });
    if (!gone) {
      const exists = await c.env.DB.prepare(`SELECT 1 AS one FROM support_answers WHERE id = ?1`)
        .bind(id)
        .first<{ one: number }>();
      if (!exists) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json(
        {
          ok: false,
          error: 'still_visible',
          detail: 'اول این پرسش و پاسخ را پنهان کنید، بعد حذفش کنید.',
        },
        409,
      );
    }
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
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
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

    await audit(
      c.env.DB,
      ident,
      'content.app_created',
      'CLIENT_APP',
      String(row.id),
      null,
      {
        name: body.data.name,
        link: body.data.link,
      },
      null,
    );
    const created = await c.env.DB.prepare(`${SELECT_APP} WHERE id = ?1`)
      .bind(row.id)
      .first<AppRow>();
    return c.json({ ok: true, app: shapeApp(created!) });
  });

  app.post('/api/v1/admin/client-apps/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = AppBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
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
