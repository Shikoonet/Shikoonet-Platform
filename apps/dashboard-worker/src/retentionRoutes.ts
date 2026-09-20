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
import { RETENTION_RULES, parseRetentionRules, type EnvName } from '@shikoo/contracts';
import { NOT_A_SHELF, retentionFunnel } from '@shikoo/domain';
import { audit, type Ident } from './adminAudit.js';

const Body = z.object({ items: z.array(z.unknown()) });

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

    const [{ results: acted }, { results: panels }, { results: codes }] = await Promise.all([
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
      installed: row !== null,
      items,
      panels: panels ?? [],
      codes: codes ?? [],
    });
  });

  app.post('/api/v1/admin/retention/rules', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const parsed = Body.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const items = parseRetentionRules(parsed.data.items);
    if (items === null) return c.json({ ok: false, error: 'invalid_rules' }, 400);

    const db = c.env.DB;
    const providerIds = [...new Set(items.map((r) => r.providerId))];
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
    // Migration 0084 inserts the row. Its absence is worth saying rather than
    // hiding behind an INSERT.
    if (!before) return c.json({ ok: false, error: 'setting_not_installed' }, 404);

    await db
      .prepare(
        `UPDATE settings SET value = ?1::jsonb, updated_at = now(), updated_by = ?2
          WHERE scope = ?3 AND key = ?4`,
      )
      .bind(JSON.stringify(items), ident.email, RETENTION_RULES.scope, RETENTION_RULES.key)
      .run();

    await audit(
      db,
      ident,
      'settings.update',
      'setting',
      `${RETENTION_RULES.scope}:${RETENTION_RULES.key}`,
      before.value,
      items,
      'retention',
    );

    return c.json({ ok: true, items });
  });
}
