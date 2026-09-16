/**
 * عضویت اجباری در کانال, on «تنظیمات».
 *
 * Sam, 2026-09-16: the list lived only under «آموزش، برنامه‌ها و کانال‌ها» and
 * nobody looking for a setting found it. What the panel has to do beyond
 * listing rows is say the one thing no validation can check — the bot must be
 * an admin of the channel, or the gate fails open — and name the bot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RequiredChannelsPanel } from '../src/hub/RequiredChannelsPanel.js';
import { RoleProvider } from '../src/role.js';

const channels = vi.fn(async () => ({
  ok: true as const,
  items: [
    { id: 1, title: 'کانال شیکو', chatRef: '@shikoonet', joinLink: 'https://t.me/shikoonet', active: true },
    { id: 2, title: 'کانال قدیمی', chatRef: '@old', joinLink: 'https://t.me/old', active: false },
  ],
}));
const bot = vi.fn(async () => ({
  ok: true as const,
  source: 'dashboard' as const,
  envName: 'staging',
  connected: null,
  liveUsername: 'shikoo_dev_bot',
}));
const setActive = vi.fn(async (_id: number, _active: boolean) => ({ ok: true }));
const add = vi.fn(async (_body: unknown) => ({ ok: true, id: 3 }));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      requiredChannels: () => channels(),
      botConnection: () => bot(),
      setRequiredChannelActive: (id: number, active: boolean) => setActive(id, active),
      addRequiredChannel: (body: unknown) => add(body),
      deleteRequiredChannel: async () => ({ ok: true }),
    },
  };
});

function draw() {
  render(
    <RoleProvider role="ADMIN">
      <RequiredChannelsPanel />
    </RoleProvider>,
  );
}

beforeEach(() => {
  channels.mockClear();
  setActive.mockClear();
  add.mockClear();
});
afterEach(() => vi.restoreAllMocks());

describe('عضویت اجباری در کانال', () => {
  it('lists the channels and names the bot that has to be made admin', async () => {
    draw();
    expect(await screen.findByText('کانال شیکو')).toBeTruthy();
    expect(screen.getByText('@shikoo_dev_bot')).toBeTruthy();
    // The sentence the e2e walk also looks for: the failure this guards is silent.
    expect(screen.getByText(/گیت برای همه باز می‌ماند/)).toBeTruthy();
    expect(screen.getByText('۱ کانال فعال')).toBeTruthy();
  });

  it('will not delete a channel that is still on — switching off comes first', async () => {
    draw();
    const on = (await screen.findByText('کانال شیکو')).closest('tr')!;
    const off = screen.getByText('کانال قدیمی').closest('tr')!;
    expect((on.querySelector('button[title]') as HTMLButtonElement).disabled).toBe(true);
    expect((off.querySelectorAll('button')[1] as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(on.querySelectorAll('button')[0]!);
    await waitFor(() => expect(setActive).toHaveBeenCalledWith(1, false));
  });

  it('adds a channel only with a shape Telegram accepts', async () => {
    draw();
    await screen.findByText('کانال شیکو');
    fireEvent.click(screen.getByRole('button', { name: 'کانال تازه' }));

    fireEvent.change(screen.getByLabelText('نامی که روی دکمه می‌آید'), { target: { value: 'کانال ما' } });
    fireEvent.change(screen.getByLabelText('لینک عضویت'), { target: { value: 'https://t.me/ours' } });
    const ref = screen.getByLabelText('شناسهٔ کانال');
    fireEvent.change(ref, { target: { value: 'https://t.me/ours' } });
    expect(screen.getByText(/لینک t.me اینجا کار نمی‌کند/)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'افزودن' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(ref, { target: { value: '@ours' } });
    fireEvent.click(screen.getByRole('button', { name: 'افزودن' }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith({ title: 'کانال ما', chatRef: '@ours', joinLink: 'https://t.me/ours' }),
    );
    expect(await screen.findByText(/با یک حساب غیرعضو امتحانش کنید/)).toBeTruthy();
  });
});
