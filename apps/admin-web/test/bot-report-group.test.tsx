/**
 * «گروه گزارش‌ها» on the bot screen.
 *
 * The route existed before this screen did, which meant the whole reporting
 * feature was unreachable: an operator had no way to name the group and no way
 * to find out whether one was set. Sam said so in those words — «این قسمت وجود
 * نداره تو پنل».
 *
 * So the assertions are about what an operator can SEE and DO, not about the
 * request shape alone. The one that matters most is the half-configured case:
 * a topic that was never made is silent — its report lands in the group's
 * General instead of failing — so the only way anybody learns about it is this
 * screen saying so.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { BotPage } from '../src/pages/BotPage.js';
import type { BotConnection } from '../src/api.js';

const TOPICS = [
  { kind: 'buyreport', title: '🛍 گزارش‌های خرید', threadId: 11 },
  { kind: 'paymentreport', title: '💰 گزارش مالی', threadId: null },
];

function connection(over: Partial<BotConnection> = {}): BotConnection {
  return {
    source: 'dashboard',
    envName: 'local',
    connected: {
      botId: 7712345678,
      username: 'shikoo_bot',
      firstName: 'Shikoo',
      envName: 'local',
      keyId: 'k1',
      setBy: 'admin@example.com',
      updatedAt: '2026-09-03T09:00:00Z',
    },
    liveUsername: 'shikoo_bot',
    appliesAfter: 'ربات تا نیم دقیقه بعد از ذخیره بالا می‌آید.',
    reportGroup: { chatId: null, configured: 0, topics: TOPICS },
    ...over,
  };
}

let current = connection();
const botConnection = vi.fn(async () => current);
const setReportGroup = vi.fn(async (_chatId: number) => ({
  ok: true,
  chatId: -1_001_222_333,
  created: { buyreport: 11 },
}));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      // Wrapped, not by reference: the factory is hoisted above the consts.
      botConnection: () => botConnection(),
      setReportGroup: (chatId: number) => setReportGroup(chatId),
      setBotToken: async () => ({ ok: true, connected: {} }),
    },
  };
});

const draw = () =>
  render(
    <RoleProvider role="ADMIN">
      <BotPage />
    </RoleProvider>,
  );

beforeEach(() => {
  current = connection();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  botConnection.mockClear();
  setReportGroup.mockClear();
});

describe('before a group is set', () => {
  it('says so, and says no report is being sent', async () => {
    draw();

    expect(await screen.findByText('تنظیم نشده')).toBeTruthy();
    // The consequence, not just the state. «تنظیم نشده» alone reads as a
    // cosmetic gap rather than as «هیچ گزارشی فرستاده نمی‌شود».
    const note = await screen.findByText(/هیچ گزارشی فرستاده نمی‌شود/);
    expect(note).toBeTruthy();
  });

  it('tells the operator what to do in Telegram first', async () => {
    draw();
    // Every one of these is fixed in Telegram, not here, and the route refuses
    // until they are done.
    expect(await screen.findByText(/Topics/)).toBeTruthy();
    expect(screen.getByText(/ادمینش کن/)).toBeTruthy();
  });
});

describe('the group id', () => {
  it('refuses to send anything that is not a supergroup id', async () => {
    draw();
    const button = await screen.findByRole('button', { name: /تنظیم گروه/ });

    // A positive number is a private chat, not a group — the server would
    // refuse it, and there is no reason to spend a round trip finding out.
    fireEvent.change(screen.getByLabelText('آیدی عددی گروه'), { target: { value: '1234567' } });
    expect((button as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('آیدی عددی گروه'), { target: { value: 'سلام' } });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it('sends the id as a number once it looks like one', async () => {
    draw();
    fireEvent.change(await screen.findByLabelText('آیدی عددی گروه'), {
      target: { value: '-1001222333' },
    });
    fireEvent.click(screen.getByRole('button', { name: /تنظیم گروه/ }));

    await waitFor(() => expect(setReportGroup).toHaveBeenCalled());
    expect(setReportGroup.mock.calls[0]![0]).toBe(-1_001_222_333);
  });

  it('asks before it makes anything in somebody’s group', async () => {
    draw();
    fireEvent.change(await screen.findByLabelText('آیدی عددی گروه'), {
      target: { value: '-1001222333' },
    });
    fireEvent.click(screen.getByRole('button', { name: /تنظیم گروه/ }));

    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    // Re-running is safe, and saying so is the point — otherwise an operator
    // who half-finished once will not press it again.
    expect(vi.mocked(window.confirm).mock.calls[0]![0]).toContain('دست نمی‌خورند');
  });
});

describe('once a group is set', () => {
  /**
   * The half-configured case, which is the one nothing else can surface.
   */
  it('lists every topic and marks the ones that were never made', async () => {
    current = connection({
      reportGroup: { chatId: -1_001_222_333, configured: 1, topics: TOPICS },
    });

    draw();

    expect(await screen.findByText('۱ از ۲ تاپیک')).toBeTruthy();
    expect(screen.getByText('🛍 گزارش‌های خرید')).toBeTruthy();
    // And what an unmade topic actually does, rather than just «—».
    expect(screen.getByText(/ساخته نشده — در تاپیک عمومی/)).toBeTruthy();
  });
});
