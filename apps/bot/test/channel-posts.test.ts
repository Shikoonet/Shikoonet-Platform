/**
 * «پست کانال» (#473) — the bot's side: a scheduled post goes out once.
 *
 * The tool this replaces told the operator a post had failed after Telegram
 * had taken it, and the channel got it twice. So the assertions are about
 * how many times Telegram is asked, and what the row says afterwards — for
 * each way a send can end.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { onlyLinkButtons, sendDueChannelPost } from '../src/channelPosts.js';
import { pausedFor, resetPace } from '../src/pace.js';
import { TelegramRejection } from '../src/telegram.js';
import { db } from './helpers/env.js';
import { stubApi } from './helpers/telegram.js';

const BY = 'channel-posts-test';
const MARKUP = {
  inline_keyboard: [[{ text: 'خرید', url: 'https://t.me/shikoonet_bot?start=c_x' }]],
};

async function post(opts: { sendAt?: string; markup?: unknown } = {}): Promise<number> {
  const row = await db
    .prepare(
      `INSERT INTO channel_posts
         (chat_id, chat_title, status, text, preview_chat_id, preview_message_id,
          reply_markup, send_at, created_by)
       VALUES (-1001234567890, 'کانال تست', 'SCHEDULED', 'سلام', -1009876543210, 77,
               ?1::jsonb, now() + ?2::interval, ?3)
       RETURNING id`,
    )
    .bind(JSON.stringify(opts.markup ?? MARKUP), opts.sendAt ?? '-1 minute', BY)
    .first<{ id: number }>();
  return Number(row!.id);
}

const rowOf = (id: number) =>
  db
    .prepare(
      `SELECT status, message_id, error, claimed_at, send_at FROM channel_posts WHERE id = ?1`,
    )
    .bind(id)
    .first<{
      status: string;
      message_id: number | null;
      error: string | null;
      claimed_at: string | null;
      send_at: string;
    }>();

beforeEach(async () => {
  await db.prepare(`DELETE FROM channel_posts WHERE created_by = ?1`).bind(BY).run();
});

afterEach(async () => {
  resetPace();
  // A 429 test writes the ban down for the next process; it must not outlive the test.
  await db
    .prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'telegram_pause_until'`)
    .run();
  await db.prepare(`DELETE FROM channel_posts WHERE created_by = ?1`).bind(BY).run();
});

describe('a scheduled channel post', () => {
  it('goes out once, as a copy of its preview with its keyboard', async () => {
    const id = await post();
    const copyMessage = vi.fn(async () => 4242);
    const api = stubApi({ copyMessage });

    expect(await sendDueChannelPost(db, api)).toBe(1);
    expect(await sendDueChannelPost(db, api)).toBe(0);

    expect(copyMessage).toHaveBeenCalledTimes(1);
    expect(copyMessage).toHaveBeenCalledWith(-1001234567890, -1009876543210, 77, MARKUP);
    expect(await rowOf(id)).toMatchObject({ status: 'SENT', message_id: 4242, error: null });
  });

  it('is sent once when two sweeps reach it at the same moment', async () => {
    await post();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const copyMessage = vi.fn(async () => {
      await gate;
      return 1;
    });
    const api = stubApi({ copyMessage });

    const both = Promise.all([sendDueChannelPost(db, api), sendDueChannelPost(db, api)]);
    await vi.waitFor(() => expect(copyMessage).toHaveBeenCalled());
    release();
    const handled = await both;

    expect(copyMessage).toHaveBeenCalledTimes(1);
    expect(handled.sort()).toEqual([0, 1]);
  });

  it('waits for its time', async () => {
    const id = await post({ sendAt: '1 hour' });
    const copyMessage = vi.fn(async () => 1);

    expect(await sendDueChannelPost(db, stubApi({ copyMessage }))).toBe(0);
    expect(copyMessage).not.toHaveBeenCalled();
    expect((await rowOf(id))?.status).toBe('SCHEDULED');
  });

  it('goes back in the queue on a 429, after the wait, and pauses the bot', async () => {
    const id = await post();
    const api = stubApi({
      copyMessage: async () => {
        throw new TelegramRejection('telegram copyMessage rejected: Too Many Requests', 429, 30);
      },
    });

    expect(await sendDueChannelPost(db, api)).toBe(1);

    const row = await rowOf(id);
    expect(row).toMatchObject({ status: 'SCHEDULED', claimed_at: null });
    expect(new Date(row!.send_at).getTime()).toBeGreaterThan(Date.now() + 20_000);
    expect(pausedFor()).toBeGreaterThan(20_000);
  });

  it('fails, and says why, when Telegram refuses it — nothing went out', async () => {
    const id = await post();
    const api = stubApi({
      copyMessage: async () => {
        throw new TelegramRejection('telegram copyMessage rejected: chat not found', 400);
      },
    });

    expect(await sendDueChannelPost(db, api)).toBe(1);

    const row = await rowOf(id);
    expect(row?.status).toBe('FAILED');
    expect(row?.error).toContain('chat not found');
  });

  it('stays SENDING when the answer never came, and is never sent again by itself', async () => {
    const id = await post();
    const copyMessage = vi.fn(async (): Promise<number> => {
      throw new Error('telegram copyMessage failed: The operation was aborted due to timeout');
    });
    const api = stubApi({ copyMessage });

    expect(await sendDueChannelPost(db, api)).toBe(1);
    expect(await sendDueChannelPost(db, api)).toBe(0);

    expect(copyMessage).toHaveBeenCalledTimes(1);
    expect((await rowOf(id))?.status).toBe('SENDING');
  });

  it('is not sent if its keyboard carries anything but links', async () => {
    const id = await post({
      markup: { inline_keyboard: [[{ text: 'x', callback_data: 'buy' }]] },
    });
    const copyMessage = vi.fn(async () => 1);

    expect(await sendDueChannelPost(db, stubApi({ copyMessage }))).toBe(1);

    expect(copyMessage).not.toHaveBeenCalled();
    expect((await rowOf(id))?.status).toBe('FAILED');
  });
});

describe('onlyLinkButtons', () => {
  it('takes https and tg links, the style and the premium emoji, and no keyboard at all', () => {
    expect(onlyLinkButtons(null)).toBe(true);
    expect(onlyLinkButtons({ inline_keyboard: [] })).toBe(true);
    expect(
      onlyLinkButtons({
        inline_keyboard: [
          [
            {
              text: 'a',
              url: 'https://x.test',
              style: 'success',
              icon_custom_emoji_id: '5368324170671202286',
            },
            { text: 'b', url: 'tg://resolve?domain=x' },
          ],
        ],
      }),
    ).toBe(true);
  });

  it('refuses everything else', () => {
    for (const bad of [
      { inline_keyboard: [[{ text: 'a', callback_data: 'buy' }]] },
      { inline_keyboard: [[{ text: 'a', url: 'http://x.test' }]] },
      { inline_keyboard: [[{ text: 'a', url: 'javascript:alert(1)' }]] },
      { inline_keyboard: [[{ text: 'a', url: 'https://x.test', login_url: {} }]] },
      { inline_keyboard: [{ text: 'a', url: 'https://x.test' }] },
      { keyboard: [] },
    ]) {
      expect(onlyLinkButtons(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});
