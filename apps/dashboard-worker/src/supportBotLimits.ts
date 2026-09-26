/**
 * «محدودیت‌های ربات پشتیبانی»: who the support bot has stopped answering and why, the day-by-day
 * counts, and who tried to break it.
 *
 * The rows are the bot's own state, kept in its n8n tables and read through the «ShikooSup admin API»
 * webhook (supportBotAdmin.ts). Nothing here is stored in Postgres; this file only turns those rows
 * into what the page shows, so the rules are testable without n8n.
 *
 * A chat is held when `human_until` is in the future. Why it is held is the reason on the chat's open
 * ticket: `attack` (the attack guard, 7 days), `limit` (the daily AI cap, 24 hours), or anything else,
 * which means a person is handling it. A chat at the day's cap without a hold is still `limit`.
 */
import { tehranAdjacentDay, tehranTodayDateString } from './tehranDay.js';

export interface BotContactRow {
  chat_id: number;
  name: string;
  username: string;
  first_seen: string | null;
  last_seen: string | null;
  msg_count: number;
  bot_replies: number;
  ai_day: string;
  ai_count: number;
  human_until: string | null;
  open_ticket: number;
  ticket_count: number;
}

export interface BotTicketRow {
  id: number;
  chat_id: number;
  reason: string;
  status: string;
  text: string;
  created_at: string;
}

export interface BotRead {
  cap: number;
  contacts: BotContactRow[];
  tickets: BotTicketRow[];
}

export type BotContactStatus = 'attack' | 'limit' | 'human' | 'ok';
export const BOT_STATUSES = ['attack', 'limit', 'human', 'ok'] as const;
/** The statuses the bot itself imposed; «آزادسازی همه» lifts these and nothing else. */
export const BOT_LIMITED: readonly BotContactStatus[] = ['attack', 'limit'];

export const BOT_SORTS = [
  'last_seen',
  'first_seen',
  'msg_count',
  'bot_replies',
  'ai_count',
  'human_until',
  'ticket_count',
] as const;
export type BotSort = (typeof BOT_SORTS)[number];

export interface BotListQuery {
  status: 'all' | 'limited' | BotContactStatus;
  q: string;
  sort: BotSort;
  dir: 'asc' | 'desc';
  page: number;
  size: number;
}

export interface BotContactView extends BotContactRow {
  status: BotContactStatus;
  /** When the bot answers again; null when it already does. */
  held_until: string | null;
}

const ts = (v: string | null | undefined): number => (v ? Date.parse(v) || 0 : 0);

function flaggedReasons(tickets: readonly BotTicketRow[]): Map<number, string> {
  return new Map(tickets.map((t) => [t.id, t.reason]));
}

export function contactStatus(
  c: BotContactRow,
  flagged: ReadonlyMap<number, string>,
  cap: number,
  nowMs: number,
): BotContactStatus {
  const held = ts(c.human_until) > nowMs;
  const why = flagged.get(c.open_ticket);
  if (held && why === 'attack') return 'attack';
  if (held && why === 'limit') return 'limit';
  if (held) return 'human';
  if (c.ai_day === tehranTodayDateString(nowMs) && c.ai_count >= cap) return 'limit';
  return 'ok';
}

export function viewContacts(read: BotRead, nowMs: number): BotContactView[] {
  const flagged = flaggedReasons(read.tickets);
  return read.contacts.map((c) => {
    const status = contactStatus(c, flagged, read.cap, nowMs);
    return { ...c, status, held_until: ts(c.human_until) > nowMs ? c.human_until : null };
  });
}

/** The chats «آزادسازی همه» hands back: every bot-imposed limit, attackers only when asked. */
export function limitedChatIds(read: BotRead, nowMs: number, includeAttackers: boolean): number[] {
  return viewContacts(read, nowMs)
    .filter((c) => c.status === 'limit' || (includeAttackers && c.status === 'attack'))
    .map((c) => c.chat_id);
}

export function listContacts(
  read: BotRead,
  query: BotListQuery,
  nowMs: number,
): { items: BotContactView[]; total: number; page: number; size: number; pages: number } {
  const q = query.q.trim().replace(/^@/, '').toLowerCase();
  const rows = viewContacts(read, nowMs).filter((c) => {
    if (query.status === 'limited' && !BOT_LIMITED.includes(c.status)) return false;
    if (query.status !== 'all' && query.status !== 'limited' && c.status !== query.status) return false;
    if (!q) return true;
    return (
      String(c.chat_id).includes(q) ||
      c.name.toLowerCase().includes(q) ||
      c.username.toLowerCase().includes(q)
    );
  });
  const dates = new Set<BotSort>(['last_seen', 'first_seen', 'human_until']);
  const key = (c: BotContactView): number =>
    dates.has(query.sort) ? ts(c[query.sort] as string | null) : Number(c[query.sort]) || 0;
  const sign = query.dir === 'asc' ? 1 : -1;
  // Ties fall back to the chat id so a page never shuffles between two requests.
  rows.sort((a, b) => sign * (key(a) - key(b)) || a.chat_id - b.chat_id);
  const pages = Math.max(1, Math.ceil(rows.length / query.size));
  const page = Math.min(Math.max(1, query.page), pages);
  return {
    items: rows.slice((page - 1) * query.size, page * query.size),
    total: rows.length,
    page,
    size: query.size,
    pages,
  };
}

export interface BotStats {
  cap: number;
  today: string;
  contacts: number;
  messages: number;
  botReplies: number;
  limitedNow: number;
  attackBlockedNow: number;
  withPersonNow: number;
  limitedToday: number;
  attacksToday: number;
  attackersTotal: number;
  attacksTotal: number;
  /** Oldest first, `days` Tehran days ending today; distinct people per day, attempts counted each. */
  byDay: { day: string; limited: number; attacks: number; attackers: number }[];
  attackers: {
    chat_id: number;
    name: string;
    username: string;
    attempts: number;
    last_at: string;
    last_text: string;
    blocked_now: boolean;
  }[];
}

export function botStats(read: BotRead, nowMs: number, days = 14): BotStats {
  const today = tehranTodayDateString(nowMs);
  const views = viewContacts(read, nowMs);
  const byId = new Map(views.map((c) => [c.chat_id, c]));
  const dayOf = (iso: string) => tehranTodayDateString(ts(iso));

  const byDay = Array.from({ length: days }, (_, i) => tehranAdjacentDay(today, i - (days - 1))).map(
    (day) => {
      const on = read.tickets.filter((t) => dayOf(t.created_at) === day);
      const limits = on.filter((t) => t.reason === 'limit');
      const attacks = on.filter((t) => t.reason === 'attack');
      return {
        day,
        limited: new Set(limits.map((t) => t.chat_id)).size,
        attacks: attacks.length,
        attackers: new Set(attacks.map((t) => t.chat_id)).size,
      };
    },
  );

  const attackTickets = read.tickets
    .filter((t) => t.reason === 'attack')
    .sort((a, b) => ts(b.created_at) - ts(a.created_at));
  const seen = new Map<number, BotStats['attackers'][number]>();
  for (const t of attackTickets) {
    const hit = seen.get(t.chat_id);
    if (hit) {
      hit.attempts += 1;
      continue;
    }
    const c = byId.get(t.chat_id);
    seen.set(t.chat_id, {
      chat_id: t.chat_id,
      name: c?.name ?? '',
      username: c?.username ?? '',
      attempts: 1,
      last_at: t.created_at,
      last_text: t.text,
      blocked_now: c?.status === 'attack',
    });
  }
  const todayRow = byDay[byDay.length - 1];
  return {
    cap: read.cap,
    today,
    contacts: views.length,
    messages: views.reduce((s, c) => s + (c.msg_count || 0), 0),
    botReplies: views.reduce((s, c) => s + (c.bot_replies || 0), 0),
    limitedNow: views.filter((c) => c.status === 'limit').length,
    attackBlockedNow: views.filter((c) => c.status === 'attack').length,
    withPersonNow: views.filter((c) => c.status === 'human').length,
    limitedToday: todayRow?.limited ?? 0,
    attacksToday: todayRow?.attacks ?? 0,
    attackersTotal: seen.size,
    attacksTotal: attackTickets.length,
    byDay,
    attackers: [...seen.values()],
  };
}
