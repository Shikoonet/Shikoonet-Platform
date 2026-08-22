/**
 * بخش آموزش و برنامه‌ها, from the panel.
 *
 * Both tables have been read by the bot since «آموزش» was built and written by
 * nobody, so the admin's own `admin.php` was still where those screens lived.
 * That stops being true the day the PHP is switched off, which is what this
 * screen is for.
 *
 * The assertions worth having are the two rules that are NOT the legacy
 * panel's: a row a customer can still see cannot be deleted, and the Telegram
 * `file_id` never reaches the browser — it belongs to the old bot and sending it
 * from this one fails at Telegram with nothing on screen to explain why.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-content@example.com';
const REVIEWER = 'reviewer-content@example.com';
const PREFIX = 'zz-content-';

/** Distinctive enough that finding it in a response cannot be a coincidence. */
const OLD_BOT_FILE_ID = 'zz-canary-AgACAgQAAxkBAAI-old-bot-file-id';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

async function makeArticle(
  label: string,
  opts: { active?: boolean; media?: boolean } = {},
): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `INSERT INTO help_articles (title, category, body, media_id, sort_order, active)
     VALUES (?1, 'راهنما', 'متن', ?2, 0, ?3) RETURNING id`,
  )
    .bind(`${PREFIX}${label}`, opts.media === false ? null : OLD_BOT_FILE_ID, opts.active ?? true)
    .first<{ id: number }>();
  return Number(row!.id);
}

async function makeApp(label: string, opts: { active?: boolean } = {}): Promise<number> {
  const row = await baseEnv.DB.prepare(
    `INSERT INTO client_apps (name, platform, link, sort_order, active)
     VALUES (?1, 'android', 'https://example.invalid/a.apk', 0, ?2) RETURNING id`,
  )
    .bind(`${PREFIX}${label}`, opts.active ?? true)
    .first<{ id: number }>();
  return Number(row!.id);
}

const articleRow = (id: number) =>
  baseEnv.DB.prepare(`SELECT title, body, active, media_id FROM help_articles WHERE id = ?1`)
    .bind(id)
    .first<{ title: string; body: string; active: boolean; media_id: string | null }>();

const appRow = (id: number) =>
  baseEnv.DB.prepare(`SELECT name, link, active FROM client_apps WHERE id = ?1`)
    .bind(id)
    .first<{ name: string; link: string; active: boolean }>();

async function purge(): Promise<void> {
  await baseEnv.DB.prepare(`DELETE FROM help_articles WHERE title LIKE ?1`)
    .bind(`${PREFIX}%`)
    .run();
  await baseEnv.DB.prepare(`DELETE FROM client_apps WHERE name LIKE ?1`).bind(`${PREFIX}%`).run();
}

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }
});

beforeEach(purge);
afterAll(purge);

describe('the education screen', () => {
  it('lists hidden articles too, because this is where they are turned back on', async () => {
    await makeArticle('visible');
    await makeArticle('hidden', { active: false });

    const res = await app.request('/api/v1/admin/help-articles', {}, envAs(ADMIN));
    const body = (await res.json()) as { items: { title: string; active: boolean }[] };

    const mine = body.items.filter((i) => i.title.startsWith(PREFIX));
    expect(mine.map((i) => i.active).sort()).toEqual([false, true]);
  });

  it('never puts the old bot’s file id on the wire', async () => {
    const id = await makeArticle('withmedia');

    const raw = await (await app.request('/api/v1/admin/help-articles', {}, envAs(ADMIN))).text();

    // Genuinely in the row this response was built from, or the assertion below
    // would pass against an empty table.
    expect((await articleRow(id))!.media_id).toBe(OLD_BOT_FILE_ID);
    expect(raw).not.toContain(OLD_BOT_FILE_ID);
    // The fact that an image exists is still worth seeing.
    expect(raw).toContain('"hasMedia":true');
  });

  it('writes what the admin typed, and says who did it', async () => {
    const created = await app.request(
      '/api/v1/admin/help-articles',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: `${PREFIX}new`, body: 'چطور وصل شویم', sortOrder: 3 }),
      },
      envAs(ADMIN),
    );
    expect(created.status).toBe(200);
    const { article } = (await created.json()) as { article: { id: number } };

    expect(await articleRow(article.id)).toMatchObject({ body: 'چطور وصل شویم', active: true });
    const log = await baseEnv.DB.prepare(
      `SELECT action FROM audit_logs WHERE entity_id = ?1 ORDER BY id DESC LIMIT 1`,
    )
      .bind(String(article.id))
      .first<{ action: string }>();
    expect(log?.action).toBe('content.article_created');
  });

  it('refuses to delete an article a customer can still open', async () => {
    // The rule that is not the legacy panel's. Neither table has a foreign key
    // pointing at it, so there is no constraint to lean on — `active` is what
    // the bot filters on, so hiding is the reversible step and removing is the
    // separate, explicit one.
    const id = await makeArticle('live');

    const refused = await app.request(
      `/api/v1/admin/help-articles/${id}`,
      { method: 'DELETE' },
      envAs(ADMIN),
    );

    expect(refused.status).toBe(409);
    expect(await articleRow(id)).not.toBeNull();

    await app.request(
      `/api/v1/admin/help-articles/${id}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: `${PREFIX}live`, body: 'متن', active: false }),
      },
      envAs(ADMIN),
    );
    const gone = await app.request(
      `/api/v1/admin/help-articles/${id}`,
      { method: 'DELETE' },
      envAs(ADMIN),
    );

    expect(gone.status).toBe(200);
    expect(await articleRow(id)).toBeNull();
  });

  it('lets a reviewer read and not write', async () => {
    const id = await makeArticle('readonly');

    expect((await app.request('/api/v1/admin/help-articles', {}, envAs(REVIEWER))).status).toBe(
      200,
    );
    const write = await app.request(
      `/api/v1/admin/help-articles/${id}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: 'تغییر', body: '' }),
      },
      envAs(REVIEWER),
    );

    expect(write.status).toBe(403);
    expect((await articleRow(id))!.title).toBe(`${PREFIX}readonly`);
  });
});

describe('the apps screen', () => {
  it('refuses a link that is not one a customer should be sent to', async () => {
    for (const link of ['javascript:alert(1)', 'tg://resolve?domain=x', 'ftp://a/b', 'nothing']) {
      const res = await app.request(
        '/api/v1/admin/client-apps',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: `${PREFIX}bad`, link }),
        },
        envAs(ADMIN),
      );
      expect(res.status, link).toBe(400);
    }

    const ok = await app.request(
      '/api/v1/admin/client-apps',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `${PREFIX}good`, link: 'https://example.invalid/v2ray' }),
      },
      envAs(ADMIN),
    );
    expect(ok.status).toBe(200);
  });

  it('edits an app in place and keeps its order when the field is left out', async () => {
    const id = await makeApp('edit');
    await baseEnv.DB.prepare(`UPDATE client_apps SET sort_order = 7 WHERE id = ?1`).bind(id).run();

    const res = await app.request(
      `/api/v1/admin/client-apps/${id}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `${PREFIX}edit`, link: 'https://example.invalid/new' }),
      },
      envAs(ADMIN),
    );

    expect(res.status).toBe(200);
    expect(await appRow(id)).toMatchObject({ link: 'https://example.invalid/new', active: true });
    const order = await baseEnv.DB.prepare(`SELECT sort_order FROM client_apps WHERE id = ?1`)
      .bind(id)
      .first<{ sort_order: number }>();
    expect(order!.sort_order).toBe(7);
  });

  it('refuses to delete an app a customer can still tap', async () => {
    const id = await makeApp('live');

    const refused = await app.request(
      `/api/v1/admin/client-apps/${id}`,
      { method: 'DELETE' },
      envAs(ADMIN),
    );

    expect(refused.status).toBe(409);
    expect(await appRow(id)).not.toBeNull();
  });
});
