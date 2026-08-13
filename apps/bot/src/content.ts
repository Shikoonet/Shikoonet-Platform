/**
 * The two read-only corners of the menu: education and the client apps.
 *
 * Both are tables the migration filled and nothing has read since —
 * `help_articles` (4 rows in production) and `client_apps` (8). Neither has a
 * customer-owned row in it, so there is no ownership rule here; the only rule
 * is that a customer sees active rows and nothing else.
 *
 * `media_id` is deliberately ignored for now. It is a Telegram file id from the
 * old bot's own uploads, and a file id belongs to the bot that uploaded it —
 * sending it from this bot would fail. Re-uploading the four images is an admin
 * job, not a migration.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';

type Db = D1Database | D1DatabaseSession;

export interface HelpArticle {
  id: number;
  title: string;
  body: string;
  category: string | null;
}

export interface ClientApp {
  id: number;
  name: string;
  platform: string | null;
  link: string;
}

export async function helpArticles(db: Db, limit = 20): Promise<HelpArticle[]> {
  const { results } = await db
    .prepare(
      `SELECT id, title, body, category FROM help_articles
        WHERE active ORDER BY sort_order, id LIMIT ?1`,
    )
    .bind(limit)
    .all<HelpArticle>();
  return results ?? [];
}

/** One article, and only if it is one a customer may see. */
export async function helpArticle(db: Db, id: number): Promise<HelpArticle | null> {
  return db
    .prepare(`SELECT id, title, body, category FROM help_articles WHERE id = ?1 AND active`)
    .bind(id)
    .first<HelpArticle>();
}

export async function clientApps(db: Db, limit = 20): Promise<ClientApp[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, platform, link FROM client_apps
        WHERE active ORDER BY sort_order, id LIMIT ?1`,
    )
    .bind(limit)
    .all<ClientApp>();
  return results ?? [];
}
