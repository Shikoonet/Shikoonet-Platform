/**
 * «محدودیت‌های ربات پشتیبانی» — Sam, 2026-09-26: who the bot limited, give access back, messages
 * sent and answered, filter and sort and pages, «آزادسازی همه», per-day counts, attackers and their
 * ids, and a click through to the customer's own page.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { SupportBotPage } from '../src/pages/SupportBotPage.js';

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

const PAGE = {
  ok: true,
  configured: true,
  cap: 20,
  total: 2,
  page: 1,
  pageSize: 25,
  pages: 1,
  items: [
    { chatId: 7700000001, userId: 41, name: 'مشتری', username: 'shopper', status: 'limit', heldUntil: '2026-09-27T06:00:00Z', messages: 30, botReplies: 20, aiToday: 20, tickets: 1, firstSeen: null, lastSeen: '2026-09-26T09:00:00Z' },
    { chatId: 7700000003, userId: null, name: '', username: '', status: 'ok', heldUntil: null, messages: 1, botReplies: 1, aiToday: 0, tickets: 0, firstSeen: null, lastSeen: '2026-09-26T08:00:00Z' },
  ],
  stats: {
    today: '2026-09-26', contacts: 3, messages: 34, botReplies: 22, limitedNow: 1, attackBlockedNow: 1, withPersonNow: 0,
    limitedToday: 1, attacksToday: 1, attacksTotal: 2, attackersTotal: 1,
    byDay: [{ day: '2026-09-26', limited: 1, attacks: 1, attackers: 1 }],
  },
  attackers: [
    { chatId: 7700000002, userId: null, name: 'x', username: '', attempts: 2, lastAt: '2026-09-26T09:30:00Z', lastText: "' OR 1=1 --", blockedNow: true },
  ],
};

function mock(page: unknown = PAGE) {
  const calls: { url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url.includes('/release-all')) return json({ ok: true, released: 3, chatIds: [1, 2, 3] });
      if (url.includes('/release')) return json({ ok: true, released: 1, chatIds: [7700000001] });
      if (url.includes('/cap')) return json({ ok: true, cap: 12 });
      return json(page);
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const renderAs = (role: 'ADMIN' | 'REVIEWER') =>
  render(
    <RoleProvider role={role}>
      <SupportBotPage />
    </RoleProvider>,
  );

describe('the support bot limits page', () => {
  it('shows each chat with its reason, a link to the customer’s card, and the attackers', async () => {
    mock();
    renderAs('ADMIN');
    expect(await screen.findByText('سقف روزانه', { selector: 'span' })).toBeTruthy();
    // A shop customer opens their card; a stranger opens in Telegram.
    expect(screen.getByText('@shopper').closest('a')?.getAttribute('href')).toMatch(/\/customers\?id=41$/);
    expect(screen.getByText('7700000002', { selector: 'a' }).getAttribute('href')).toBe('tg://user?id=7700000002');
    expect(screen.getByText("' OR 1=1 --")).toBeTruthy();
    // Only a limited chat carries the button; the active one does not.
    expect(screen.getAllByText('بازگرداندن دسترسی')).toHaveLength(2);
  });

  it('gives one chat back, and «آزادسازی همه» asks first and sends the attackers choice', async () => {
    const calls = mock();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderAs('ADMIN');
    fireEvent.click((await screen.findAllByText('بازگرداندن دسترسی'))[0]!);
    await screen.findByText('ربات دوباره در این چت جواب می‌دهد.');
    expect(calls.find((c) => c.url.endsWith('/support-bot/release'))?.body).toEqual({ chatIds: [7700000001] });

    fireEvent.click(screen.getByLabelText(/حمله‌کننده‌ها هم آزاد شوند/));
    fireEvent.click(screen.getByText('آزادسازی همه'));
    await screen.findByText('۳ چت آزاد شد.');
    expect(window.confirm).toHaveBeenCalled();
    expect(calls.find((c) => c.url.endsWith('/release-all'))?.body).toEqual({ includeAttackers: true });
  });

  it('sends the filter, sort and page the operator chose', async () => {
    const calls = mock();
    renderAs('ADMIN');
    await screen.findByText('سقف روزانه', { selector: 'span' });
    fireEvent.change(screen.getByLabelText('وضعیت'), { target: { value: 'limited' } });
    fireEvent.change(screen.getByLabelText('ترتیب'), { target: { value: 'msg_count' } });
    await waitFor(() => {
      const last = calls.at(-1)!.url;
      expect(last).toContain('status=limited');
      expect(last).toContain('sort=msg_count');
      expect(last).toContain('page=1');
    });
  });

  it('leaves the write buttons dead for a REVIEWER', async () => {
    mock();
    renderAs('REVIEWER');
    await screen.findByText('سقف روزانه', { selector: 'span' });
    expect((screen.getByText('آزادسازی همه') as HTMLButtonElement).disabled).toBe(true);
    for (const b of screen.getAllByText('بازگرداندن دسترسی')) expect((b as HTMLButtonElement).disabled).toBe(true);
  });

  it('says the bot is not connected instead of showing an error', async () => {
    mock({ ok: true, configured: false });
    renderAs('ADMIN');
    expect(await screen.findByText(/هنوز به داشبورد وصل نشده است/)).toBeTruthy();
    expect(document.querySelector('.alert-error')).toBeNull();
    expect(screen.getByRole('heading', { name: 'محدودیت‌های ربات پشتیبانی' })).toBeTruthy();
  });
});
