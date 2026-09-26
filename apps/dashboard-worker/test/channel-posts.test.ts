/**
 * «پست کانال» (#473), from the panel.
 *
 * The tool this replaces kept nothing and double-posted. The properties that
 * matter here are the ones the bot relies on when it copies a post into the
 * channel (`apps/bot/test/channel-posts.test.ts`):
 *
 * - what is scheduled has been previewed, and any change clears the preview;
 * - the preview's chat and message id come from Telegram through the server,
 *   never from a request;
 * - every button is a link — a campaign's link built here — and nothing else;
 * - a channel is stored by its numeric id, and only if the bot can post there;
 * - writes that race the bot's claim answer 409 instead of landing late.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const ADMIN = 'admin-channel-posts@example.com';
const REVIEWER = 'reviewer-channel-posts@example.com';
const KEY_HEX = 'e'.repeat(64);
const TOKEN = '7712345678:AAH9fakeTokenForTestsOnly_not_a_real_one';
const GROUP = -1003992817118;
const TOPIC = 175;
const CHANNEL = -1001234567890;
const NOW_MS = Date.UTC(2026, 8, 26, 9, 0, 0);

const envAs = (email = ADMIN) => ({ ...baseEnv, TEST_ACCESS_USER: email });
const req = (method: string, path: string, body?: unknown, email = ADMIN) =>
  app.request(
    path,
    body === undefined
      ? { method }
      : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    envAs(email),
  );
const patch = (id: number, body: unknown, email = ADMIN) =>
  req('PATCH', `/api/v1/admin/channel-posts/${id}`, body, email);

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/** Every call the panel made to Telegram, by method, with what it sent. */
let calls: Array<{ method: string; body: unknown }> = [];
/** Answers that differ from the happy path, by method. */
let refuse: Record<string, string> = {};
let botStatus: { status: string; can_post_messages?: boolean } = {
  status: 'administrator',
  can_post_messages: true,
};
let nextMessageId = 500;
/** Runs while Telegram is answering `getChat` — a stand-in for the bot acting mid-request. */
let duringGetChat: (() => Promise<void>) | null = null;

function telegram() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const method = String(input).split('/').at(-1)!;
    const body =
      init?.body instanceof FormData
        ? Object.fromEntries(
            [...init.body.entries()].map(([k, v]) => [k, typeof v === 'string' ? v : '<file>']),
          )
        : JSON.parse(String(init?.body ?? '{}'));
    calls.push({ method, body });
    if (refuse[method]) return json({ ok: false, description: refuse[method] });
    switch (method) {
      case 'getChat':
        if (duringGetChat) await duringGetChat();
        return (body as { chat_id: unknown }).chat_id === '@nosuch'
          ? json({ ok: false, description: 'Bad Request: chat not found' })
          : json({ ok: true, result: { id: CHANNEL, title: 'کانال شیکو', type: 'channel' } });
      case 'getMe':
        return json({ ok: true, result: { id: 7712345678 } });
      case 'getChatMember':
        return json({ ok: true, result: botStatus });
      case 'sendMessage':
        return json({ ok: true, result: { message_id: ++nextMessageId } });
      case 'sendPhoto':
        return json({
          ok: true,
          result: {
            message_id: ++nextMessageId,
            photo: [{ file_id: 'small' }, { file_id: 'PHOTO-ID', file_size: 12 }],
          },
        });
      case 'sendVideo':
        return json({
          ok: true,
          result: { message_id: ++nextMessageId, video: { file_id: 'VIDEO-ID' } },
        });
      default:
        return json({ ok: true, result: true });
    }
  });
}

const of = (method: string) =>
  calls.filter((c) => c.method === method).map((c) => c.body as Record<string, unknown>);

async function setting(key: string, value: string): Promise<void> {
  await baseEnv.DB.prepare(
    `INSERT INTO settings (scope, key, value) VALUES ('bot', ?1, to_jsonb(?2::text))
     ON CONFLICT (scope, key) DO UPDATE SET value = to_jsonb(?2::text)`,
  )
    .bind(key, value)
    .run();
}

const row = (id: number) =>
  baseEnv.DB.prepare(
    `SELECT chat_id, chat_title, status, text, media_kind, media_file_id, preview_chat_id,
            preview_message_id, reply_markup, message_id, campaign_slug
       FROM channel_posts WHERE id = ?1`,
  )
    .bind(id)
    .first<Record<string, unknown>>();

async function draft(body: Record<string, unknown> = {}): Promise<number> {
  const res = await req('POST', '/api/v1/admin/channel-posts', {
    chat: '@shikoonet',
    text: '<b>سلام</b>',
    ...body,
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return ((await res.json()) as { id: number }).id;
}

/** A post in the channel, as the bot leaves one. */
async function sent(media = 'NONE'): Promise<number> {
  const r = await baseEnv.DB.prepare(
    `INSERT INTO channel_posts (chat_id, chat_title, status, text, media_kind, media_file_id,
                                sent_at, message_id, created_by)
     VALUES (?1, 'کانال شیکو', 'SENT', 'قبلی', ?2, ?3, now(), 9001, 'test') RETURNING id`,
  )
    .bind(CHANNEL, media, media === 'NONE' ? null : 'PHOTO-ID')
    .first<{ id: number }>();
  return Number(r!.id);
}

/**
 * The shop-wide settings this file changes, as they were — put back after it.
 * Found by the full run: `retention.test.ts` later builds its link from
 * `username` and expected the seeded bot, not the one left behind here.
 */
const SHARED_SETTINGS = ['Channel_Report', 'topic_otherreport', 'username'];
let before: Array<{ key: string; value: unknown }> = [];

beforeAll(async () => {
  await applySchema();
  const { results } = await baseEnv.DB.prepare(
    `SELECT key, value FROM settings WHERE scope = 'bot' AND key = ANY(?1)`,
  )
    .bind(SHARED_SETTINGS)
    .all<{ key: string; value: unknown }>();
  before = results ?? [];
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
      .bind(crypto.randomUUID(), email, role, NOW_MS)
      .run();
  }
});

beforeEach(async () => {
  calls = [];
  refuse = {};
  duringGetChat = null;
  botStatus = { status: 'administrator', can_post_messages: true };
  process.env['PANEL_SECRET_KEY'] = KEY_HEX;
  await baseEnv.DB.prepare(`DELETE FROM channel_posts`).run();
  await baseEnv.DB.prepare(
    `DELETE FROM campaigns WHERE slug LIKE 'post-%' OR slug = 'zz-cp-ads'`,
  ).run();
  await baseEnv.DB.prepare(`DELETE FROM bot_credentials`).run();
  await setting('Channel_Report', String(GROUP));
  await setting('topic_otherreport', String(TOPIC));
  await setting('username', 'shikoonet_bot');
  Object.assign(baseEnv, { TELEGRAM_BOT_TOKEN: TOKEN });
  telegram();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env['PANEL_SECRET_KEY'];
});

afterAll(async () => {
  await baseEnv.DB.prepare(`DELETE FROM channel_posts`).run();
  await baseEnv.DB.prepare(
    `DELETE FROM campaigns WHERE slug LIKE 'post-%' OR slug = 'zz-cp-ads'`,
  ).run();
  await baseEnv.DB.prepare(
    `DELETE FROM required_channels WHERE join_link = 'https://t.me/zzcp'`,
  ).run();
  await baseEnv.DB.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = ANY(?1)`)
    .bind(SHARED_SETTINGS)
    .run();
  for (const row of before) {
    await baseEnv.DB.prepare(
      `INSERT INTO settings (scope, key, value) VALUES ('bot', ?1, ?2::jsonb)`,
    )
      .bind(row.key, JSON.stringify(row.value))
      .run();
  }
});

describe('the channel', () => {
  it('is stored by its numeric id and title, not by the name it was typed as', async () => {
    const id = await draft();
    expect(await row(id)).toMatchObject({
      chat_id: CHANNEL,
      chat_title: 'کانال شیکو',
      status: 'DRAFT',
    });
  });

  it('says Telegram did not answer, not that the bot lacks rights, when getMe fails', async () => {
    refuse = { getMe: 'Too Many Requests: retry after 5' };
    const res = await req('POST', '/api/v1/admin/channel-posts', { chat: '@shikoonet' });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { error: string }).error).toBe('telegram_refused');
  });

  it('is refused when the bot cannot post there, or does not exist, or is a link', async () => {
    botStatus = { status: 'administrator', can_post_messages: false };
    expect((await req('POST', '/api/v1/admin/channel-posts', { chat: '@shikoonet' })).status).toBe(
      422,
    );
    botStatus = { status: 'left' };
    expect((await req('POST', '/api/v1/admin/channel-posts', { chat: '@shikoonet' })).status).toBe(
      422,
    );
    botStatus = { status: 'administrator', can_post_messages: true };
    expect((await req('POST', '/api/v1/admin/channel-posts', { chat: '@nosuch' })).status).toBe(
      422,
    );
    expect(
      (await req('POST', '/api/v1/admin/channel-posts', { chat: 'https://t.me/shikoonet' })).status,
    ).toBe(400);
    expect(
      (
        await baseEnv.DB.prepare(`SELECT count(*)::int AS n FROM channel_posts`).first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
  });
});

describe('buttons', () => {
  it('are links only — no plain http, no script, no callback, no stray field', async () => {
    for (const bad of [
      [[{ text: 'a', url: 'http://x.test' }]],
      [[{ text: 'a', url: 'javascript:alert(1)' }]],
      [[{ text: 'a', callback_data: 'buy' }]],
      [[{ text: 'a', url: 'https://x.test', campaign: 'zz-cp-ads' }]],
      [[{ text: '', url: 'https://x.test' }]],
      [Array.from({ length: 9 }, () => ({ text: 'a', url: 'https://x.test' }))],
    ]) {
      const res = await req('POST', '/api/v1/admin/channel-posts', {
        chat: '@shikoonet',
        buttons: bad,
      });
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
  });

  it('refuses a campaign that does not exist — it would count nothing, silently', async () => {
    const res = await req('POST', '/api/v1/admin/channel-posts', {
      chat: '@shikoonet',
      buttons: [[{ text: 'خرید', campaign: 'zz-cp-nobody' }]],
    });
    expect(res.status).toBe(400);
  });
});

describe('preview, then schedule', () => {
  it('previews in the reports group exactly as it will go out, and only then schedules', async () => {
    await baseEnv.DB.prepare(`INSERT INTO campaigns (slug, name) VALUES ('zz-cp-ads', 'x')`).run();
    const id = await draft({
      buttons: [
        [{ text: 'پروکسی', url: 'https://t.me/proxy?server=a', style: 'primary' }],
        [{ text: 'خرید', campaign: 'zz-cp-ads', style: 'success', emoji: '5368324170671202286' }],
      ],
    });

    expect((await patch(id, { op: 'schedule', sendAt: null })).status).toBe(409);
    expect((await req('POST', `/api/v1/admin/channel-posts/${id}/preview`)).status).toBe(200);

    const [preview] = of('sendMessage');
    expect(preview).toMatchObject({
      chat_id: GROUP,
      message_thread_id: TOPIC,
      parse_mode: 'HTML',
      text: '<b>سلام</b>',
    });
    const keyboard = {
      inline_keyboard: [
        [{ text: 'پروکسی', url: 'https://t.me/proxy?server=a', style: 'primary' }],
        [
          {
            text: 'خرید',
            url: 'https://t.me/shikoonet_bot?start=c_zz-cp-ads',
            style: 'success',
            icon_custom_emoji_id: '5368324170671202286',
          },
        ],
      ],
    };
    expect(preview!.reply_markup).toEqual(keyboard);
    // What the bot will copy: Telegram's own ids, and the very keyboard it was shown.
    expect(await row(id)).toMatchObject({
      preview_chat_id: GROUP,
      preview_message_id: nextMessageId,
      reply_markup: keyboard,
    });

    expect((await patch(id, { op: 'schedule', sendAt: null })).status).toBe(200);
    expect((await row(id))?.status).toBe('SCHEDULED');
  });

  it('takes no preview id from a request — only Telegram gives one', async () => {
    const id = await draft();
    for (const body of [
      { op: 'edit', preview_message_id: 1, preview_chat_id: GROUP },
      { op: 'edit', previewMessageId: 1 },
    ]) {
      expect((await patch(id, body)).status).toBe(400);
    }
    expect(
      (
        await req('POST', '/api/v1/admin/channel-posts', {
          chat: '@shikoonet',
          previewMessageId: 1,
        })
      ).status,
    ).toBe(400);
    expect((await row(id))?.preview_message_id).toBeNull();
  });

  it('needs a new preview after any change', async () => {
    const id = await draft();
    await req('POST', `/api/v1/admin/channel-posts/${id}/preview`);
    await patch(id, { op: 'schedule', sendAt: null });

    expect((await patch(id, { op: 'edit', text: 'متن تازه' })).status).toBe(200);

    expect(await row(id)).toMatchObject({
      status: 'DRAFT',
      text: 'متن تازه',
      preview_message_id: null,
    });
    expect((await patch(id, { op: 'schedule', sendAt: null })).status).toBe(409);
  });

  it('refuses a change, a cancel or a new picture once the bot has claimed it', async () => {
    const id = await draft();
    await req('POST', `/api/v1/admin/channel-posts/${id}/preview`);
    await patch(id, { op: 'schedule', sendAt: null });
    // The bot's claim, as `sendDueChannelPost` writes it.
    await baseEnv.DB.prepare(
      `UPDATE channel_posts SET status = 'SENDING', claimed_at = now() WHERE id = ?1`,
    )
      .bind(id)
      .run();

    expect((await patch(id, { op: 'edit', text: 'دیر' })).status).toBe(409);
    expect((await patch(id, { op: 'cancel' })).status).toBe(409);
    expect((await req('DELETE', `/api/v1/admin/channel-posts/${id}`)).status).toBe(409);
    expect(await row(id)).toMatchObject({ status: 'SENDING', text: '<b>سلام</b>' });
  });

  it('refuses an edit that loses the race to the bot, instead of landing on a post in flight', async () => {
    const id = await draft();
    await req('POST', `/api/v1/admin/channel-posts/${id}/preview`);
    await patch(id, { op: 'schedule', sendAt: null });
    // The route has read the post as SCHEDULED; the bot claims it while the
    // route is still asking Telegram about the new channel.
    duringGetChat = async () => {
      await baseEnv.DB.prepare(
        `UPDATE channel_posts SET status = 'SENDING', claimed_at = now() WHERE id = ?1`,
      )
        .bind(id)
        .run();
    };

    expect((await patch(id, { op: 'edit', chat: '@shikoonet', text: 'دیر' })).status).toBe(409);
    expect(await row(id)).toMatchObject({ status: 'SENDING', text: '<b>سلام</b>' });
  });

  it('refuses a time already gone — never quietly turns it into «now»', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    const id = await draft();
    await req('POST', `/api/v1/admin/channel-posts/${id}/preview`);
    const gone = new Date(NOW_MS - 2 * 3_600_000).toISOString();

    expect((await patch(id, { op: 'schedule', sendAt: gone })).status).toBe(400);
    expect((await row(id))?.status).toBe('DRAFT');
  });

  it('refuses a schedule past 90 days, and cancels one back to a draft', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    const id = await draft();
    await req('POST', `/api/v1/admin/channel-posts/${id}/preview`);
    const far = new Date(NOW_MS + 100 * 86_400_000).toISOString();
    expect((await patch(id, { op: 'schedule', sendAt: far })).status).toBe(400);

    const soon = new Date(NOW_MS + 3_600_000).toISOString();
    expect((await patch(id, { op: 'schedule', sendAt: soon })).status).toBe(200);
    expect((await patch(id, { op: 'cancel' })).status).toBe(200);
    expect((await row(id))?.status).toBe('DRAFT');
  });
});

describe('a picture', () => {
  const upload = (id: number, bytes: Uint8Array, kind = 'photo') =>
    app.request(
      `/api/v1/admin/channel-posts/${id}/media?kind=${kind}&name=a.jpg`,
      { method: 'POST', body: bytes },
      envAs(),
    );

  it('goes to the reports group once for its file id, and that upload is removed', async () => {
    const id = await draft();
    const res = await upload(id, new Uint8Array([1, 2, 3]));
    expect(res.status, await res.clone().text()).toBe(200);

    expect(of('sendPhoto')).toHaveLength(1);
    expect(of('sendPhoto')[0]).toMatchObject({ chat_id: String(GROUP), photo: '<file>' });
    expect(of('deleteMessage')).toEqual([{ chat_id: GROUP, message_id: nextMessageId }]);
    expect(await row(id)).toMatchObject({ media_kind: 'PHOTO', media_file_id: 'PHOTO-ID' });

    // …and the preview sends it by that id, the text as its caption.
    await req('POST', `/api/v1/admin/channel-posts/${id}/preview`);
    expect(of('sendPhoto')[1]).toMatchObject({ photo: 'PHOTO-ID', caption: '<b>سلام</b>' });
  });

  it('is refused past the cap, and so is a caption Telegram would refuse', async () => {
    const id = await draft({ text: 'x'.repeat(1025) });
    expect((await upload(id, new Uint8Array(10 * 1024 * 1024 + 1))).status).toBe(413);
    expect((await upload(id, new Uint8Array([1]))).status).toBe(200);
    expect((await req('POST', `/api/v1/admin/channel-posts/${id}/preview`)).status).toBe(400);
  });
});

describe('a post in the channel', () => {
  it('is edited there, and the row follows only when Telegram agreed', async () => {
    const id = await sent();
    expect((await patch(id, { op: 'edit', text: 'درست‌شده' })).status).toBe(200);
    expect(of('editMessageText')[0]).toMatchObject({
      chat_id: CHANNEL,
      message_id: 9001,
      text: 'درست‌شده',
    });
    expect((await row(id))?.text).toBe('درست‌شده');

    refuse = { editMessageText: 'Bad Request: message to edit not found' };
    expect((await patch(id, { op: 'edit', text: 'دوباره' })).status).toBe(422);
    expect((await row(id))?.text).toBe('درست‌شده');
  });

  it('edits a picture’s caption, and never its channel or picture', async () => {
    const id = await sent('PHOTO');
    expect((await patch(id, { op: 'edit', text: 'زیرنویس' })).status).toBe(200);
    expect(of('editMessageCaption')[0]).toMatchObject({ caption: 'زیرنویس' });
    expect((await patch(id, { op: 'edit', removeMedia: true })).status).toBe(400);
    expect((await patch(id, { op: 'edit', chat: '@other_channel' })).status).toBe(400);
  });

  it('is pinned and unpinned there', async () => {
    const id = await sent();
    expect((await patch(id, { op: 'pin', pinned: true })).status).toBe(200);
    expect((await patch(id, { op: 'pin', pinned: false })).status).toBe(200);
    expect(of('pinChatMessage')).toEqual([
      { chat_id: CHANNEL, message_id: 9001, disable_notification: true },
    ]);
    expect(of('unpinChatMessage')).toEqual([{ chat_id: CHANNEL, message_id: 9001 }]);
  });

  it('is deleted when the channel says the message is already gone', async () => {
    const id = await sent();
    refuse = { deleteMessage: 'Bad Request: message to delete not found' };
    expect((await req('DELETE', `/api/v1/admin/channel-posts/${id}`)).status).toBe(200);
    expect(await row(id)).toBeNull();
  });

  it('is deleted from the channel first, and kept if the channel refuses', async () => {
    const id = await sent();
    refuse = { deleteMessage: "Bad Request: message can't be deleted" };
    expect((await req('DELETE', `/api/v1/admin/channel-posts/${id}`)).status).toBe(422);
    expect(await row(id)).not.toBeNull();

    refuse = {};
    expect((await req('DELETE', `/api/v1/admin/channel-posts/${id}`)).status).toBe(200);
    expect(of('deleteMessage').at(-1)).toEqual({ chat_id: CHANNEL, message_id: 9001 });
    expect(await row(id)).toBeNull();
  });
});

describe('a send with no answer', () => {
  it('is settled by a person once it has been stuck, and not before', async () => {
    const id = await draft();
    await baseEnv.DB.prepare(
      `UPDATE channel_posts SET status = 'SENDING', claimed_at = now() WHERE id = ?1`,
    )
      .bind(id)
      .run();
    expect((await patch(id, { op: 'resolve', inChannel: true })).status).toBe(409);

    await baseEnv.DB.prepare(
      `UPDATE channel_posts SET claimed_at = now() - interval '5 minutes' WHERE id = ?1`,
    )
      .bind(id)
      .run();
    expect((await patch(id, { op: 'resolve', inChannel: true })).status).toBe(200);
    // In the channel, but with no id there is nothing to edit, pin or delete by.
    expect(await row(id)).toMatchObject({ status: 'SENT', message_id: null });
    expect((await patch(id, { op: 'pin', pinned: true })).status).toBe(409);
  });
});

describe('the post’s own campaign', () => {
  it('is post-<id>, counted by a buy button whose link the server builds', async () => {
    const id = await draft();
    const res = await patch(id, { op: 'track' });
    expect(await res.json()).toMatchObject({ ok: true, campaign: `post-${id}` });

    const campaign = await baseEnv.DB.prepare(`SELECT source FROM campaigns WHERE slug = ?1`)
      .bind(`post-${id}`)
      .first<{ source: string }>();
    expect(campaign?.source).toBe('channel');
    expect((await row(id))?.campaign_slug).toBe(`post-${id}`);

    await patch(id, { op: 'edit', buttons: [[{ text: 'خرید', campaign: `post-${id}` }]] });
    await req('POST', `/api/v1/admin/channel-posts/${id}/preview`);
    expect(of('sendMessage')[0]!.reply_markup).toEqual({
      inline_keyboard: [[{ text: 'خرید', url: `https://t.me/shikoonet_bot?start=c_post-${id}` }]],
    });
  });
});

describe('sending again', () => {
  it('makes a new draft with the same channel, words, picture and buttons — and no preview', async () => {
    const first = await sent('PHOTO');
    await baseEnv.DB.prepare(`UPDATE channel_posts SET campaign_slug = 'post-1' WHERE id = ?1`)
      .bind(first)
      .run();
    const res = await req('POST', '/api/v1/admin/channel-posts', { copyOf: first });
    const { id } = (await res.json()) as { id: number };

    expect(await row(id)).toMatchObject({
      chat_id: CHANNEL,
      text: 'قبلی',
      media_kind: 'PHOTO',
      media_file_id: 'PHOTO-ID',
      status: 'DRAFT',
      preview_message_id: null,
      message_id: null,
      // A new post, which may want its own campaign.
      campaign_slug: null,
    });
  });
});

describe('who may', () => {
  it('lets a reviewer read the list, and nothing more', async () => {
    const id = await draft();
    expect((await req('GET', '/api/v1/admin/channel-posts', undefined, REVIEWER)).status).toBe(200);
    expect(
      (await req('POST', '/api/v1/admin/channel-posts', { chat: '@shikoonet' }, REVIEWER)).status,
    ).toBe(403);
    expect((await patch(id, { op: 'track' }, REVIEWER)).status).toBe(403);
    expect(
      (await req('POST', `/api/v1/admin/channel-posts/${id}/preview`, undefined, REVIEWER)).status,
    ).toBe(403);
    expect(
      (await req('DELETE', `/api/v1/admin/channel-posts/${id}`, undefined, REVIEWER)).status,
    ).toBe(403);
  });

  it('lists the posts and the channels to pick from', async () => {
    await draft();
    const list = (await (await req('GET', '/api/v1/admin/channel-posts')).json()) as {
      items: Array<{ chatId: number; status: string; previewed: boolean }>;
      chats: Array<{ ref: string; title: string }>;
      botUsername: string | null;
    };
    expect(list.items[0]).toMatchObject({ chatId: CHANNEL, status: 'DRAFT', previewed: false });
    expect(list.chats).toContainEqual({ ref: String(CHANNEL), title: 'کانال شیکو' });

    // A required channel stored by the same id is the same channel: offered once.
    await baseEnv.DB.prepare(
      `INSERT INTO required_channels (title, chat_ref, join_link, active)
       VALUES ('کانال اجباری', ?1, 'https://t.me/zzcp', false)`,
    )
      .bind(String(CHANNEL))
      .run();
    const again = (await (await req('GET', '/api/v1/admin/channel-posts')).json()) as {
      chats: Array<{ ref: string }>;
    };
    expect(again.chats.filter((c) => c.ref === String(CHANNEL))).toHaveLength(1);
    await baseEnv.DB.prepare(
      `DELETE FROM required_channels WHERE join_link = 'https://t.me/zzcp'`,
    ).run();
    expect(list.botUsername).toBe('shikoonet_bot');
  });
});
