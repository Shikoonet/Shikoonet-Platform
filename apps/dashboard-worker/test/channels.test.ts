/**
 * کانال‌های اجباری, from the panel.
 *
 * `required_channels` has been in the schema since 0005 and `gate.ts` reads it
 * on every update; nothing could write it. The assertions here are about the one
 * property that makes this screen worth having, and it is not CRUD.
 *
 * **A wrong channel is silent.** The gate fails open on purpose — a Telegram
 * that will not answer must not stop the shop selling — so a `chat_ref`
 * `getChatMember` cannot resolve produces a gate that never fires and looks
 * exactly like a shop where everybody is already a member. There is no error,
 * no log and no broken screen, which is why the shape is refused at the door
 * rather than discovered later.
 *
 * The one thing no test can reach is whether the bot is an administrator of the
 * channel. That needs a real `getChatMember` with the production token and is
 * recorded as a switchover blocker in `docs/STATUS.md`.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-channels@example.com';
const REVIEWER = 'reviewer-channels@example.com';
/** Every channel this file writes starts here, so the purge can find them. */
const PREFIX = '@zzchan';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

const post = (path: string, body: unknown, email = ADMIN) =>
  app.request(
    path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    envAs(email),
  );

const del = (path: string, email = ADMIN) => app.request(path, { method: 'DELETE' }, envAs(email));
const get = (path: string, email = ADMIN) => app.request(path, {}, envAs(email));

function add(chatRef: string, extra: Record<string, unknown> = {}, email = ADMIN) {
  return post(
    '/api/v1/admin/required-channels',
    { title: 'کانال تست', chatRef, joinLink: JOIN_LINK, ...extra },
    email,
  );
}

const rowById = (id: number) =>
  baseEnv.DB.prepare(`SELECT chat_ref, join_link, active FROM required_channels WHERE id = ?1`)
    .bind(id)
    .first<{ chat_ref: string; join_link: string; active: boolean }>();

/** The one join link every fixture here carries, and what the purge matches on. */
const JOIN_LINK = 'https://t.me/zzchan';

/**
 * Matched on the join link rather than the `chat_ref` prefix.
 *
 * The prefix looked like the obvious key and is the wrong one: half the cases
 * below deliberately send a `chat_ref` that is NOT the prefix — a t.me URL, a
 * numeric id, a too-short handle — and any of those that gets written survives
 * a prefix purge. That is not hypothetical; removing the `CHAT_REF` guard to
 * prove it was load-bearing left exactly such a row behind, and `gate.ts` reads
 * whatever is active, so the next package's suite went red on a channel this
 * one abandoned.
 *
 * The join link is the same on every fixture whatever else varies, which is
 * what makes it the key.
 */
async function purge(): Promise<void> {
  await baseEnv.DB.prepare(`DELETE FROM required_channels WHERE join_link = ?1`)
    .bind(JOIN_LINK)
    .run();
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

describe('adding a channel', () => {
  it('takes a @username and switches it on', async () => {
    const res = await add(`${PREFIX}_alpha`);
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: number };
    const row = await rowById(id);
    expect(row?.chat_ref).toBe(`${PREFIX}_alpha`);
    expect(row?.active).toBe(true);
  });

  it('takes a numeric -100 id, which is the other thing Telegram accepts', async () => {
    // No hand-written cleanup: it carries the same join link as everything else
    // here, so the purge takes it. A one-off `DELETE` beside the assertion is a
    // cleanup that does not run when the assertion above it fails.
    expect((await add('-1003992817118')).status).toBe(200);
  });

  it('refuses the t.me link, which is the paste that looks right', async () => {
    // The whole reason this validation exists. A URL here reaches Telegram as a
    // chat that does not exist, `gate.ts` fails open on the error, and the
    // feature is inert with nothing on any screen to say so — the single most
    // likely mistake, because it is what the admin has in their clipboard.
    for (const bad of [
      'https://t.me/shikoonet',
      't.me/shikoonet',
      'shikoonet',
      '@ab',
      '-100',
      '@has space',
    ]) {
      const res = await add(bad);
      expect(res.status, bad).toBe(400);
    }
  });

  it('refuses a join link that is not a link', async () => {
    const res = await add(`${PREFIX}_nolink`, { joinLink: '@shikoonet' });
    expect(res.status).toBe(400);
  });

  it('lets the unique index answer about a duplicate', async () => {
    await add(`${PREFIX}_twice`);
    const again = await add(`${PREFIX}_twice`);
    expect(again.status).toBe(409);
  });

  it('is closed to anyone but an ADMIN', async () => {
    const res = await add(`${PREFIX}_reviewer`, {}, REVIEWER);
    expect(res.status).toBe(403);
  });
});

describe('switching a channel off', () => {
  it('is the action that actually changes what customers see', async () => {
    // `active` is the only column `gate.ts` reads, so this is the whole feature.
    const { id } = (await (await add(`${PREFIX}_toggle`)).json()) as { id: number };

    expect(
      (await post(`/api/v1/admin/required-channels/${id}/active`, { active: false })).status,
    ).toBe(200);
    expect((await rowById(id))?.active).toBe(false);

    await post(`/api/v1/admin/required-channels/${id}/active`, { active: true });
    expect((await rowById(id))?.active).toBe(true);
  });

  it('is closed to anyone but an ADMIN', async () => {
    const { id } = (await (await add(`${PREFIX}_guard`)).json()) as { id: number };
    const res = await post(
      `/api/v1/admin/required-channels/${id}/active`,
      { active: false },
      REVIEWER,
    );
    expect(res.status).toBe(403);
    expect((await rowById(id))?.active).toBe(true);
  });
});

describe('deleting a channel', () => {
  it('refuses one that is still gating customers', async () => {
    // Removing a live channel stops the gate firing with nothing anywhere saying
    // it changed. Switching it off first is a decision somebody made, and it is
    // in the audit log.
    const { id } = (await (await add(`${PREFIX}_live`)).json()) as { id: number };
    const res = await del(`/api/v1/admin/required-channels/${id}`);
    expect(res.status).toBe(409);
    expect(await rowById(id)).not.toBeNull();
  });

  it('removes one that is already switched off', async () => {
    const { id } = (await (await add(`${PREFIX}_off`, { active: false })).json()) as { id: number };
    expect((await del(`/api/v1/admin/required-channels/${id}`)).status).toBe(200);
    expect(await rowById(id)).toBeNull();
  });

  it('keeps what it removed, in a table that cannot be deleted from', async () => {
    const { id } = (await (await add(`${PREFIX}_audit`, { active: false })).json()) as {
      id: number;
    };
    await del(`/api/v1/admin/required-channels/${id}`);

    const log = await baseEnv.DB.prepare(
      `SELECT action, before_json FROM audit_logs
        WHERE entity_type = 'REQUIRED_CHANNEL' AND entity_id = ?1
          AND action = 'required_channel.deleted'`,
    )
      .bind(String(id))
      .first<{ action: string; before_json: unknown }>();
    expect(log?.action).toBe('required_channel.deleted');
    const before =
      typeof log?.before_json === 'string'
        ? (JSON.parse(log.before_json) as { chat_ref: string })
        : (log?.before_json as { chat_ref: string });
    expect(before.chat_ref).toBe(`${PREFIX}_audit`);
  });

  it('is closed to anyone but an ADMIN', async () => {
    const { id } = (await (await add(`${PREFIX}_delguard`, { active: false })).json()) as {
      id: number;
    };
    expect((await del(`/api/v1/admin/required-channels/${id}`, REVIEWER)).status).toBe(403);
    expect(await rowById(id)).not.toBeNull();
  });
});

describe('reading the list', () => {
  it('shows switched-off channels too, because that is the state being managed', async () => {
    await add(`${PREFIX}_on`);
    await add(`${PREFIX}_dark`, { active: false });

    const body = (await (await get('/api/v1/admin/required-channels')).json()) as {
      items: { chatRef: string; active: boolean }[];
    };
    const mine = body.items.filter((i) => i.chatRef.startsWith(PREFIX));
    expect(mine).toHaveLength(2);
    expect(mine.filter((i) => i.active)).toHaveLength(1);
  });
});
