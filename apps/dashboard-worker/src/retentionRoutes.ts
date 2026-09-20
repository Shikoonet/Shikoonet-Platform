/**
 * «یادآوری تمدید» — the retention rules, from the panel.
 *
 * One read that gives the screen everything it draws — the rules, each one's
 * funnel and last-acted time, the panels and codes the pickers offer — and
 * one write that replaces the list. The list is a single `settings` row
 * (migration 0084), so «replace» is the natural write and there is no
 * per-rule route to keep in step with it.
 *
 * ## What the write refuses, and why here
 *
 * `parseRetentionRules` is the bot's own reader, so a body it returns null
 * for is a body the bot could not act on — refused before the write, like
 * `cronRoutes` refuses a key not in the registry. Two things the shape cannot
 * see are checked against the database: a panel that does not exist, and a
 * code the customer could not use for the renewal the rule is selling — a
 * disabled one, or one marked «فقط خرید اول», which the bot rejects at
 * checkout for anybody who already owns a service.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import {
  RETENTION_LIMITS,
  RETENTION_RULES,
  discountLabel,
  parseRetentionRules,
  renderRetentionText,
  reportTopicKey,
  withoutQuotedPrice,
  type EnvName,
} from '@shikoo/contracts';
import { NOT_A_SHELF, retentionAudienceCount, retentionFunnel, retentionPanelAdmins } from '@shikoo/domain';
import { audit, type Ident } from './adminAudit.js';

const Body = z.object({ items: z.array(z.unknown()) });
const TestBody = z.object({ rule: z.unknown() });
const AudienceQuery = z.object({
  providerId: z.coerce.number().int().positive().nullable(),
  panelAdmin: z.string().regex(/^\S{1,64}$/).nullable(),
  daysBefore: z.coerce.number().int().min(0).max(RETENTION_LIMITS.daysBefore),
  daysAfter: z.coerce.number().int().min(0).max(RETENTION_LIMITS.daysAfter),
  onlyService: z.enum(['true', 'false']).transform((v) => v === 'true'),
});

/** A chat id as the settings row holds it — a large negative integer, never zero. */
function chatOf(value: unknown): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n !== 0 ? n : null;
}

/** A topic id — a small positive integer. Null is the group's General topic. */
function topicOf(value: unknown): number | null {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

interface ActedRow {
  job: string;
  at: string;
  count: number;
}

export function registerRetentionRoutes(
  app: Hono<{ Bindings: { DB: D1Database; ENV_NAME: EnvName }; Variables: { identity: Ident } }>,
) {
  app.get('/api/v1/admin/retention', async (c) => {
    const db = c.env.DB;
    const row = await db
      .prepare(`SELECT value FROM settings WHERE scope = ?1 AND key = ?2`)
      .bind(RETENTION_RULES.scope, RETENTION_RULES.key)
      .first<{ value: unknown }>();
    const rules = row ? (parseRetentionRules(row.value) ?? []) : [];

    const [{ results: acted }, { results: panels }, { results: codes }, admins] = await Promise.all([
      db
        .prepare(
          `SELECT DISTINCT ON (fields->>'job')
                  fields->>'job' AS job, at::text AS at,
                  COALESCE((fields->>'count')::int, 0) AS count
             FROM app_events
            WHERE evt = 'sweep.acted' AND fields->>'job' LIKE 'retention:%'
            ORDER BY fields->>'job', at DESC`,
        )
        .all<ActedRow>(),
      db
        .prepare(
          `SELECT id, name, base_url AS "baseUrl", status FROM provisioning_providers pr
            WHERE ${NOT_A_SHELF} ORDER BY sort_order, id`,
        )
        .all<{ id: number; name: string; baseUrl: string | null; status: string }>(),
      // Every code the screen may name, with enough to say why one is greyed:
      // the operator picks from what exists, and a code that has since
      // expired must still be shown on the rule that names it.
      db
        .prepare(
          `SELECT id, code, kind, applies_to AS "appliesTo", status,
                  first_purchase_only AS "firstPurchaseOnly",
                  (expires_at IS NOT NULL AND expires_at <= now()) AS expired
             FROM discount_codes ORDER BY id DESC`,
        )
        .all<{
          id: number;
          code: string;
          kind: string;
          appliesTo: string;
          status: string;
          firstPurchaseOnly: boolean;
          expired: boolean;
        }>(),
      // The panel admins the sync has seen — the picker. Empty until the
      // first sync after 0085, and the screen says so.
      retentionPanelAdmins(db),
    ]);
    const lastActed = new Map((acted ?? []).map((r) => [r.job, r]));

    const items = await Promise.all(
      rules.map(async (r) => {
        const last = lastActed.get(`retention:${r.key}`);
        return {
          ...r,
          lastActed: last ? { at: last.at, count: last.count } : null,
          funnel: await retentionFunnel(db, r.key, r.codeId),
        };
      }),
    );

    return c.json({
      ok: true,
      items,
      panels: panels ?? [],
      admins,
      codes: codes ?? [],
    });
  });

  /**
   * «الان چند نفر؟» — the rule's audience as the operator types it.
   *
   * Sam, 2026-09-20: typing a panel and two numbers should show how many
   * people that is. Read-only, so a reviewer may ask; the count uses the
   * sweep's own predicate from `@shikoo/domain`, so it cannot promise an
   * audience the sweep would not write to.
   */
  app.get('/api/v1/admin/retention/audience', async (c) => {
    const parsed = AudienceQuery.safeParse({
      providerId: c.req.query('providerId') || null,
      panelAdmin: c.req.query('panelAdmin') || null,
      daysBefore: c.req.query('daysBefore') ?? '0',
      daysAfter: c.req.query('daysAfter') ?? '0',
      onlyService: c.req.query('onlyService') ?? 'false',
    });
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
    if (parsed.data.providerId === null && parsed.data.panelAdmin === null) {
      return c.json({ ok: false, error: 'invalid_query' }, 400);
    }
    return c.json({ ok: true, count: await retentionAudienceCount(c.env.DB, parsed.data) });
  });

  /**
   * «تست» — the sentence a customer would get, sent to the reports group.
   *
   * Sam, 2026-09-20: «مطمئن شم که درست کار می‌کنه». Rendered from the DRAFT on
   * the screen, not the saved row, so an operator can try wording before
   * saving it; and rendered for a real service where one exists — the newest
   * ACTIVE service on the rule's panel — so `{service}` and `{username}` show
   * what they would show, not a placeholder. Goes to «📝 گزارش اطلاع رسانی ها»
   * under a header that says it is a test and reached no customer. No renew
   * button: a callback pressed in the group would run as the admin and find
   * no service of theirs to renew.
   */
  app.post('/api/v1/admin/retention/test', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const parsed = TestBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const rule = parseRetentionRules([parsed.data.rule])?.[0];
    if (!rule) return c.json({ ok: false, error: 'invalid_rules' }, 400);

    const db = c.env.DB;
    const { results: rows } = await db
      .prepare(`SELECT key, value FROM settings WHERE scope = 'bot' AND key IN ('Channel_Report', ?1)`)
      .bind(reportTopicKey('reportcron'))
      .all<{ key: string; value: unknown }>();
    const setting = (key: string): unknown => (rows ?? []).find((r) => r.key === key)?.value;
    const chatId = chatOf(setting('Channel_Report'));
    if (chatId === null) return c.json({ ok: false, error: 'no_report_group' }, 409);
    const botUsername = await db
      .prepare(`SELECT value FROM settings WHERE scope = 'bot' AND key = 'username'`)
      .first<{ value: unknown }>();
    const handle = typeof botUsername?.value === 'string' ? botUsername.value.trim() : '';
    if (handle === '') return c.json({ ok: false, error: 'no_bot_username' }, 409);

    const sample = await db
      .prepare(
        `SELECT plan_name_at_sale, remote_username FROM subscriptions
          WHERE (?1::bigint IS NULL OR provider_id = ?1)
            AND (?2::text IS NULL OR panel_admin = ?2)
            AND status = 'ACTIVE'
          ORDER BY purchased_at DESC LIMIT 1`,
      )
      .bind(rule.providerId, rule.panelAdmin)
      .first<{ plan_name_at_sale: string; remote_username: string | null }>();
    const code =
      rule.codeId === null
        ? null
        : await db
            .prepare(`SELECT code, kind, percent, amount_irr, bonus_gb FROM discount_codes WHERE id = ?1`)
            .bind(rule.codeId)
            .first<{ code: string; kind: string; percent: number | null; amount_irr: number | null; bonus_gb: number | null }>();

    // The «before» text when the rule has a before side, else the «after»
    // one — and the FIRST day of that side, which is the message a customer
    // actually meets first: «5 روز مانده» before, «1 روز گذشته» after.
    const after = rule.daysBefore === 0;
    const text = renderRetentionText(after && rule.textAfter !== '' ? rule.textAfter : rule.text, {
      days: String(after ? 1 : rule.daysBefore),
      service: sample ? withoutQuotedPrice(sample.plan_name_at_sale) : 'نمونه',
      username: sample?.remote_username ?? 'sample_user',
      // The same `<code>` the bot sends, so the group sees it tap-to-copy.
      code: code === null ? '' : `<code>${code.code}</code>`,
      discount:
        code === null
          ? ''
          : discountLabel({ kind: code.kind, percent: code.percent, amountIrr: code.amount_irr, bonusGb: code.bonus_gb }),
      renewButton: 'تمدید سرویس',
    });
    const body = [`🧪 تست قانون «${rule.name}» — به هیچ مشتری‌ای نرفته.`, '', text].join('\n');
    // The same green link the customer gets, minus the service id: `/start
    // renew` opens the presser's own list, so an admin trying it in the group
    // sees the screen rather than «سرویس پیدا نشد» about somebody else's.
    const keyboard = [[{ text: 'تمدید سرویس', url: `https://t.me/${handle}?start=renew`, style: 'success' }]];

    const now = Date.now();
    await db
      .prepare(
        // The same table the bot flushes, as `alert()` writes it. The key
        // carries the clock on purpose: each press of «تست» is its own event
        // and the operator expects one message per press.
        `INSERT INTO bot_notifications (dedupe_key, chat_id, body, message_thread_id, reply_markup)
         VALUES (?1, ?2, ?3, ?4, ?5::jsonb) ON CONFLICT (dedupe_key) DO NOTHING`,
      )
      .bind(
        `retention-test:${rule.key}:${now}`,
        chatId,
        body,
        topicOf(setting(reportTopicKey('reportcron'))),
        JSON.stringify(keyboard),
      )
      .run();

    return c.json({ ok: true, text: text.replace(/<\/?code>/g, '') });
  });

  app.post('/api/v1/admin/retention/rules', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const parsed = Body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const items = parseRetentionRules(parsed.data.items);
    if (items === null) return c.json({ ok: false, error: 'invalid_rules' }, 400);

    const db = c.env.DB;
    const providerIds = [...new Set(items.flatMap((r) => (r.providerId === null ? [] : [r.providerId])))];
    if (providerIds.length > 0) {
      const { results } = await db
        .prepare(`SELECT id FROM provisioning_providers WHERE id = ANY(?1)`)
        .bind(providerIds)
        .all<{ id: number }>();
      const found = new Set((results ?? []).map((r) => Number(r.id)));
      const missing = providerIds.filter((id) => !found.has(id));
      if (missing.length > 0) return c.json({ ok: false, error: 'unknown_panel', ids: missing }, 400);
    }

    const codeIds = [...new Set(items.flatMap((r) => (r.codeId === null ? [] : [r.codeId])))];
    if (codeIds.length > 0) {
      const { results } = await db
        .prepare(
          `SELECT id FROM discount_codes
            WHERE id = ANY(?1) AND status = 'ACTIVE' AND NOT first_purchase_only`,
        )
        .bind(codeIds)
        .all<{ id: number }>();
      const usable = new Set((results ?? []).map((r) => Number(r.id)));
      const bad = codeIds.filter((id) => !usable.has(id));
      if (bad.length > 0) return c.json({ ok: false, error: 'unusable_code', ids: bad }, 400);
    }

    const before = await db
      .prepare(`SELECT value FROM settings WHERE scope = ?1 AND key = ?2`)
      .bind(RETENTION_RULES.scope, RETENTION_RULES.key)
      .first<{ value: unknown }>();

    // Upsert, like `saveMessageTemplates` and unlike `cronRoutes`. A cron key
    // is one of a fixed registry the bot reads by name, so a missing row means
    // a missing migration and the route says so. This row is the whole list:
    // absent and empty read the same to the bot (`loadRetentionRules`), and
    // `seed:sim` truncates `settings` to three keys, so the browser walk in
    // CI would otherwise open this screen to an error box on every run.
    await db
      .prepare(
        `INSERT INTO settings (scope, key, value, updated_by)
         VALUES (?1, ?2, ?3::jsonb, ?4)
         ON CONFLICT (scope, key) DO UPDATE
           SET value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
      )
      .bind(RETENTION_RULES.scope, RETENTION_RULES.key, JSON.stringify(items), ident.email)
      .run();

    await audit(
      db,
      ident,
      'settings.update',
      'setting',
      `${RETENTION_RULES.scope}:${RETENTION_RULES.key}`,
      before?.value ?? null,
      items,
      'retention',
    );

    return c.json({ ok: true, items });
  });
}
