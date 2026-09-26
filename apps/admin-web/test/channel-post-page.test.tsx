/**
 * «انتشار در کانال» (#473) — the screen's own rules.
 *
 * The server enforces every one of these too (`channel-posts.test.ts`); the
 * screen's job is not to offer a door that answers 409. Chiefly: nothing is
 * sent that the operator has not just seen in the reports group — so the send
 * buttons wait for a saved, previewed post, and go off again at the first edit.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ChannelPostPage } from '../src/pages/ChannelPostPage.js';
import { RoleProvider } from '../src/role.js';
import type { ChannelPost } from '../src/api.js';

const base: ChannelPost = {
  id: 7,
  chatId: -1001234567890,
  chatTitle: 'کانال شیکو',
  status: 'DRAFT',
  text: '<b>سلام</b>',
  mediaKind: 'NONE',
  buttons: [],
  previewed: false,
  sendAt: null,
  sentAt: null,
  inChannel: false,
  error: null,
  campaignSlug: null,
  createdBy: 'a@b',
  createdAt: Date.UTC(2026, 8, 26),
  stuck: false,
};

let items: ChannelPost[] = [];
const op = vi.fn(async (_id: number, _op: unknown) => ({ ok: true, campaign: 'post-7' }));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      channelPosts: async () => ({
        ok: true,
        botUsername: 'shikoonet_bot',
        items,
        chats: [{ ref: String(base.chatId), title: base.chatTitle }],
      }),
      campaigns: async () => ({
        ok: true,
        startMs: null,
        endMs: null,
        botUsername: 'shikoonet_bot',
        items: [],
      }),
      channelPostOp: (id: number, body: unknown) => op(id, body),
      addChannelPost: vi.fn(async () => ({ ok: true, id: 8 })),
      previewChannelPost: vi.fn(async () => ({ ok: true })),
      deleteChannelPost: vi.fn(async () => ({ ok: true })),
      uploadChannelPostMedia: vi.fn(),
    },
  };
});

function draw(role: 'ADMIN' | 'REVIEWER' = 'ADMIN') {
  render(
    <RoleProvider role={role}>
      <ChannelPostPage />
    </RoleProvider>,
  );
}

const button = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

afterEach(() => {
  items = [];
  vi.clearAllMocks();
});

describe('sending', () => {
  it('waits for a preview, and goes off again at the first edit', async () => {
    items = [{ ...base, previewed: false }];
    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'باز کن' }));
    expect(button('ارسال الان').disabled).toBe(true);
    expect(button('پیش‌نمایش در گروه گزارش').disabled).toBe(false);
  });

  it('is offered for a previewed post, and withdrawn once its text changes', async () => {
    items = [{ ...base, previewed: true }];
    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'باز کن' }));
    expect(button('ارسال الان').disabled).toBe(false);

    fireEvent.change(screen.getByLabelText(/^متن/), { target: { value: 'متن دیگر' } });

    expect(button('ارسال الان').disabled).toBe(true);
    expect(button('زمان‌بندی').disabled).toBe(true);
    expect(button('پیش‌نمایش در گروه گزارش').disabled).toBe(true);
  });

  it('sends now as a schedule with no time', async () => {
    items = [{ ...base, previewed: true }];
    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'باز کن' }));
    fireEvent.click(button('ارسال الان'));
    await waitFor(() => expect(op).toHaveBeenCalledWith(7, { op: 'schedule', sendAt: null }));
  });
});

describe('the list', () => {
  it('asks a person how a stuck send ended', async () => {
    items = [{ ...base, status: 'SENDING', stuck: true }];
    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'نرسید' }));
    await waitFor(() => expect(op).toHaveBeenCalledWith(7, { op: 'resolve', inChannel: false }));
    expect(screen.getByRole('button', { name: 'در کانال هست' })).toBeTruthy();
  });

  it('offers pin and delete-from-channel for a post that is there', async () => {
    items = [{ ...base, status: 'SENT', inChannel: true, sentAt: Date.UTC(2026, 8, 26) }];
    draw();
    expect(await screen.findByRole('button', { name: 'حذف از کانال' })).toBeTruthy();
    fireEvent.click(button('سنجاق'));
    await waitFor(() => expect(op).toHaveBeenCalledWith(7, { op: 'pin', pinned: true }));
  });

  it('offers a reviewer nothing that writes', async () => {
    items = [{ ...base, status: 'SENT', inChannel: true, sentAt: Date.UTC(2026, 8, 26) }];
    draw('REVIEWER');
    await screen.findByRole('button', { name: 'حذف از کانال' });
    for (const name of ['پست تازه', 'سنجاق', 'حذف از کانال', 'ارسال دوباره']) {
      expect(button(name).disabled, name).toBe(true);
    }
  });
});

describe('tracking', () => {
  it('gives the post its campaign and a buy button pointing at it', async () => {
    items = [{ ...base }];
    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'باز کن' }));
    fireEvent.click(button('ردیابی این پست'));

    await waitFor(() => expect(op).toHaveBeenCalledWith(7, { op: 'track' }));
    expect(await screen.findByDisplayValue('🛒 خرید سرویس')).toBeTruthy();
    // Unsaved until the operator saves it — so nothing can be sent yet.
    expect(button('ارسال الان').disabled).toBe(true);
  });
});
