/**
 * «محدودیت‌های ربات پشتیبانی» — who the support bot stopped answering, and giving chats back.
 *
 * The rows are the bot's own, read live from its n8n tables through `supportBotAdmin.ts` on every
 * request; nothing is copied into Postgres. The one thing read from Postgres is which chat is a
 * shop customer, so a row can open that customer's card.
 *
 * Reading names people, so the prefix is on `PERSONAL_DATA_PREFIXES` (access.ts). Every write is
 * ADMIN-only and audited after n8n confirms it.
 */
import type { EnvName } from '@shikoo/contracts';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import { audit, type Ident } from './adminAudit.js';
import {
  readSupportBot,
  releaseSupportBotChats,
  setSupportBotDailyCap,
  SupportBotAdminError,
  type SupportBotAdminConfig,
} from './supportBotAdmin.js';
import { BOT_SORTS, botStats, limitedChatIds, listContacts } from './supportBotLimits.js';

type Bindings = {
  DB: D1Database;
  ENV_NAME: EnvName;
  SUPPORT_BOT_ADMIN_URL?: string;
  SUPPORT_BOT_ADMIN_SECRET?: string;
};

const DETAIL: Record<SupportBotAdminError['code'], string> = {
  not_configured:
    'ربات پشتیبانی به داشبورد وصل نشده است: SUPPORT_BOT_ADMIN_URL و SUPPORT_BOT_ADMIN_SECRET روی سرور تنظیم نشده‌اند.',
  unreachable: 'به ربات پشتیبانی (n8n) نرسیدیم؛ چند لحظه بعد دوباره امتحان کنید.',
  bad_answer: 'جواب ربات پشتیبانی (n8n) خوانا نبود؛ نشانی و کلید را روی سرور بررسی کنید.',
};

function failed(e: unknown) {
  if (!(e instanceof SupportBotAdminError)) throw e;
  const status = e.code === 'not_configured' ? 503 : 502;
  return { body: { ok: false as const, error: `support_bot_${e.code}`, detail: DETAIL[e.code] }, status } as const;
}

const ListQuery = z.object({
  status: z.enum(['all', 'limited', 'attack', 'limit', 'human', 'ok']).default('all'),
  q: z.string().max(100).default(''),
  sort: z.enum(BOT_SORTS).default('last_seen'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});
const ReleaseBody = z.object({ chatIds: z.array(z.number().int().positive()).min(1).max(1000) }).strict();
const ReleaseAllBody = z.object({ includeAttackers: z.boolean().default(false) }).strict();
const CapBody = z.object({ cap: z.number().int().min(1).max(500) }).strict();

export function registerSupportBotRoutes(app: Hono<{ Bindings: Bindings; Variables: { identity: Ident } }>) {
  const config = (env: Bindings): SupportBotAdminConfig => ({
    url: env.SUPPORT_BOT_ADMIN_URL,
    secret: env.SUPPORT_BOT_ADMIN_SECRET,
    // Read at call time, so a test's spy on globalThis.fetch is the one used.
    fetchFn: (...a) => globalThis.fetch(...a),
  });

  /** Which of these Telegram ids are shop customers, and their `users.id`. */
  async function shopIds(db: D1Database, chatIds: number[]): Promise<Map<number, number>> {
    if (chatIds.length === 0) return new Map();
    const { results } = await db
      .prepare(`SELECT id, telegram_id FROM users WHERE telegram_id = ANY(?1::bigint[])`)
      .bind(chatIds)
      .all<{ id: number; telegram_id: number }>();
    return new Map((results ?? []).map((r) => [Number(r.telegram_id), Number(r.id)]));
  }

  app.get('/api/v1/admin/support-bot', async (c) => {
    const query = ListQuery.safeParse(c.req.query());
    if (!query.success) return c.json({ ok: false, error: 'bad_query' }, 400);
    const cfg = config(c.env);
    // Not set up yet is a state of the shop, not a fault of this page.
    if (!cfg.url || !cfg.secret) return c.json({ ok: true, configured: false });
    let read;
    try {
      read = await readSupportBot(cfg);
    } catch (e) {
      const f = failed(e);
      return c.json(f.body, f.status);
    }
    const now = Date.now();
    const { pageSize, ...rest } = query.data;
    const list = listContacts(read, { ...rest, size: pageSize }, now);
    const stats = botStats(read, now);
    const attackers = stats.attackers.slice(0, 50);
    const users = await shopIds(c.env.DB, [
      ...new Set([...list.items.map((r) => r.chat_id), ...attackers.map((a) => a.chat_id)]),
    ]);
    return c.json({
      ok: true,
      configured: true,
      cap: read.cap,
      total: list.total,
      page: list.page,
      pageSize: list.size,
      pages: list.pages,
      items: list.items.map((r) => ({
        chatId: r.chat_id,
        userId: users.get(r.chat_id) ?? null,
        name: r.name,
        username: r.username,
        status: r.status,
        heldUntil: r.held_until,
        messages: r.msg_count,
        botReplies: r.bot_replies,
        aiToday: r.ai_day === stats.today ? r.ai_count : 0,
        tickets: r.ticket_count,
        firstSeen: r.first_seen,
        lastSeen: r.last_seen,
      })),
      stats: {
        today: stats.today,
        contacts: stats.contacts,
        messages: stats.messages,
        botReplies: stats.botReplies,
        limitedNow: stats.limitedNow,
        attackBlockedNow: stats.attackBlockedNow,
        withPersonNow: stats.withPersonNow,
        limitedToday: stats.limitedToday,
        attacksToday: stats.attacksToday,
        attacksTotal: stats.attacksTotal,
        attackersTotal: stats.attackersTotal,
        byDay: stats.byDay,
      },
      attackers: attackers.map((a) => ({
        chatId: a.chat_id,
        userId: users.get(a.chat_id) ?? null,
        name: a.name,
        username: a.username,
        attempts: a.attempts,
        lastAt: a.last_at,
        lastText: a.last_text,
        blockedNow: a.blocked_now,
      })),
    });
  });

  app.post('/api/v1/admin/support-bot/release', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const body = ReleaseBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false, error: 'bad_body' }, 400);
    try {
      const ids = await releaseSupportBotChats(config(c.env), [...new Set(body.data.chatIds)]);
      await audit(
        c.env.DB,
        ident,
        'support_bot.chats_released',
        'SUPPORT_BOT_CHAT',
        ids.length === 1 ? String(ids[0]) : 'many',
        null,
        { chatIds: ids },
        null,
      );
      return c.json({ ok: true, released: ids.length, chatIds: ids });
    } catch (e) {
      const f = failed(e);
      return c.json(f.body, f.status);
    }
  });

  app.post('/api/v1/admin/support-bot/release-all', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const body = ReleaseAllBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false, error: 'bad_body' }, 400);
    try {
      const cfg = config(c.env);
      // Decided from a fresh read, not from the page the admin was looking at.
      const wanted = limitedChatIds(await readSupportBot(cfg), Date.now(), body.data.includeAttackers);
      const ids = await releaseSupportBotChats(cfg, wanted);
      await audit(
        c.env.DB,
        ident,
        'support_bot.all_released',
        'SUPPORT_BOT_CHAT',
        'many',
        null,
        { includeAttackers: body.data.includeAttackers, chatIds: ids },
        null,
      );
      return c.json({ ok: true, released: ids.length, chatIds: ids });
    } catch (e) {
      const f = failed(e);
      return c.json(f.body, f.status);
    }
  });

  app.post('/api/v1/admin/support-bot/cap', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const body = CapBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ ok: false, error: 'bad_body' }, 400);
    try {
      const cfg = config(c.env);
      const before = (await readSupportBot(cfg)).cap;
      const cap = await setSupportBotDailyCap(cfg, body.data.cap);
      await audit(c.env.DB, ident, 'support_bot.cap_set', 'SETTING', 'ai_daily_per_user', { cap: before }, { cap }, null);
      return c.json({ ok: true, cap });
    } catch (e) {
      const f = failed(e);
      return c.json(f.body, f.status);
    }
  });
}
