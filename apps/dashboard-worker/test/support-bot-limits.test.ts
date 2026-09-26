/**
 * The support bot's limits page turns the bot's n8n rows into statuses, a list and counts.
 * Days are Tehran days, checked against Intl on Asia/Tehran rather than against the code's own helper.
 */
import { describe, expect, it } from 'vitest';
import {
  botStats,
  contactStatus,
  limitedChatIds,
  listContacts,
  type BotContactRow,
  type BotRead,
  type BotTicketRow,
} from '../src/supportBotLimits.js';

// 2026-09-26 10:00 UTC = 13:30 in Tehran.
const NOW = Date.parse('2026-09-26T10:00:00Z');
const tehranDay = (ms: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran' }).format(new Date(ms));
const TODAY = tehranDay(NOW);
const later = (h: number) => new Date(NOW + h * 3600e3).toISOString();

const contact = (chat_id: number, over: Partial<BotContactRow> = {}): BotContactRow => ({
  chat_id,
  name: `n${chat_id}`,
  username: '',
  first_seen: '2026-09-20T08:00:00Z',
  last_seen: '2026-09-26T09:00:00Z',
  msg_count: 1,
  bot_replies: 1,
  ai_day: TODAY,
  ai_count: 1,
  human_until: null,
  open_ticket: 0,
  ticket_count: 0,
  ...over,
});
const ticket = (id: number, chat_id: number, reason: string, created_at: string, text = 'x'): BotTicketRow => ({
  id,
  chat_id,
  reason,
  status: 'open',
  text,
  created_at,
});

const read: BotRead = {
  cap: 20,
  contacts: [
    contact(101, { human_until: later(150), open_ticket: 1, msg_count: 9, name: 'حمله‌گر' }),
    contact(102, { human_until: later(20), open_ticket: 2, ai_count: 20, msg_count: 30, username: 'limitguy' }),
    contact(103, { human_until: later(1), open_ticket: 99, msg_count: 5 }),
    contact(104, { ai_count: 20, msg_count: 5 }),
    contact(105, { human_until: later(-1), open_ticket: 1, msg_count: 2 }),
    contact(106, { ai_day: '2026-09-25', ai_count: 25, msg_count: 0 }),
  ],
  tickets: [
    ticket(1, 101, 'attack', '2026-09-26T09:30:00Z', "' OR 1=1 --"),
    ticket(2, 102, 'limit', '2026-09-26T09:45:00Z'),
    ticket(3, 101, 'attack', '2026-09-25T09:00:00Z', 'earlier try'),
    // 20:40 UTC on the 25th is 00:10 on the 26th in Tehran.
    ticket(4, 104, 'limit', '2026-09-25T20:40:00Z'),
    ticket(5, 104, 'limit', '2026-09-25T20:50:00Z'),
  ],
};

describe('support bot limits', () => {
  it('reads why the bot is quiet in a chat from the open ticket and the day’s count', () => {
    const flagged = new Map(read.tickets.map((t) => [t.id, t.reason]));
    const s = (id: number) => contactStatus(read.contacts.find((c) => c.chat_id === id)!, flagged, 20, NOW);
    expect([101, 102, 103, 104, 105, 106].map(s)).toEqual(['attack', 'limit', 'human', 'limit', 'ok', 'ok']);
  });

  it('filters, searches, sorts and pages the list', () => {
    const base = { status: 'all', q: '', sort: 'msg_count', dir: 'desc', page: 1, size: 2 } as const;
    const first = listContacts(read, base, NOW);
    expect(first.items.map((c) => c.chat_id)).toEqual([102, 101]);
    expect([first.total, first.pages]).toEqual([6, 3]);
    // 103 and 104 tie on 5 messages; the chat id keeps their order stable.
    expect(listContacts(read, { ...base, page: 2 }, NOW).items.map((c) => c.chat_id)).toEqual([103, 104]);
    // A page past the end shows the last page, not an empty one.
    expect(listContacts(read, { ...base, page: 9 }, NOW).page).toBe(3);
    expect(listContacts(read, { ...base, status: 'limited', size: 10 }, NOW).items.map((c) => c.chat_id)).toEqual([
      102, 101, 104,
    ]);
    expect(listContacts(read, { ...base, q: '@LimitGuy' }, NOW).items.map((c) => c.chat_id)).toEqual([102]);
    expect(listContacts(read, { ...base, q: '105' }, NOW).items.map((c) => c.chat_id)).toEqual([105]);
    const held = listContacts(read, { ...base, status: 'attack' }, NOW).items[0];
    expect(held?.held_until).toBe(later(150));
  });

  it('releases every bot limit, and attackers only when asked', () => {
    expect(limitedChatIds(read, NOW, false)).toEqual([102, 104]);
    expect(limitedChatIds(read, NOW, true)).toEqual([101, 102, 104]);
  });

  it('counts limited people and attacks per Tehran day, and names each attacker once', () => {
    const s = botStats(read, NOW, 3);
    expect(s.today).toBe(TODAY);
    const day25 = tehranDay(Date.parse('2026-09-25T09:00:00Z'));
    expect(s.byDay.map((d) => d.day)).toEqual([tehranDay(NOW - 2 * 86400e3), day25, TODAY]);
    // Ticket 4 and 5 fall on the 26th in Tehran: one person, not two, and not the 25th.
    expect(s.byDay[2]).toEqual({ day: TODAY, limited: 2, attacks: 1, attackers: 1 });
    expect(s.byDay[1]).toEqual({ day: day25, limited: 0, attacks: 1, attackers: 1 });
    expect([s.limitedToday, s.attacksToday, s.attacksTotal, s.attackersTotal]).toEqual([2, 1, 2, 1]);
    expect([s.limitedNow, s.attackBlockedNow, s.withPersonNow, s.contacts, s.messages]).toEqual([2, 1, 1, 6, 51]);
    expect(s.attackers).toEqual([
      {
        chat_id: 101,
        name: 'حمله‌گر',
        username: '',
        attempts: 2,
        last_at: '2026-09-26T09:30:00Z',
        last_text: "' OR 1=1 --",
        blocked_now: true,
      },
    ]);
  });
});
