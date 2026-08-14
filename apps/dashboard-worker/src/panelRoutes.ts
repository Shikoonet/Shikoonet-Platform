/**
 * مدیریت پنل‌ها — the panels that actually fulfil an order.
 *
 * `panel/panels.php` puts the panel's username, password and API token in the
 * same form as its name, and its list query is `SELECT *`. This route returns
 * neither `secret_ref` nor `config`, ever.
 *
 * That is not caution for its own sake. `migrations/0002_catalog.sql:27` used
 * to claim the row was safe to hand to a support agent and was wrong twice:
 * the importer carried a live panel admin JWT into `config` (fixed, and held
 * by a test), and `config.proxies` still holds a hysteria shared secret that
 * cannot be removed because provisioning has to send it. So the row is
 * panel-operator material, and a screen behind Cloudflare Access is still a
 * screen — it gets the name, the address, the status and the counts.
 *
 * Credentials change through the secret store, not here. There is no route in
 * this file that can write one, which is the point: a form that cannot be
 * submitted cannot leak.
 *
 * The counts are the reason this screen exists at all. Disabling a panel is
 * safe or catastrophic depending on how many live subscriptions sit on it, and
 * that number is not on the PHP screen — an admin there disables a panel and
 * finds out from the customers.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import { audit, type Ident } from './adminAudit.js';

const PanelPatch = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    status: z.enum(['ACTIVE', 'DISABLED']).optional(),
    // NULL is unlimited, which is what the legacy 'unlimited' string became.
    capacity: z.number().int().min(0).max(1_000_000).nullable().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'no fields to change');

interface PanelRow {
  id: number;
  code: string;
  name: string;
  kind: string;
  status: string;
  base_url: string | null;
  capacity: number | null;
  sort_order: number;
  has_secret_ref: boolean;
  product_count: number;
  plan_count: number;
  live_subscriptions: number;
}

function shape(r: PanelRow) {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    kind: r.kind,
    status: r.status,
    baseUrl: r.base_url,
    capacity: r.capacity,
    sortOrder: r.sort_order,
    // Whether a credential is configured, never which one. An unconfigured
    // panel cannot provision, and that is worth seeing on the list.
    hasSecretRef: r.has_secret_ref,
    productCount: Number(r.product_count),
    planCount: Number(r.plan_count),
    liveSubscriptions: Number(r.live_subscriptions),
  };
}

/**
 * `secret_ref IS NOT NULL` rather than `secret_ref`: the column names a secret
 * in the runtime store, and even the name does not need to reach the browser.
 * `config` is absent from this projection on purpose — see the file header.
 */
const SELECT_PANEL = `
  SELECT pr.id, pr.code, pr.name, pr.kind, pr.status, pr.base_url,
         pr.capacity, pr.sort_order,
         (pr.secret_ref IS NOT NULL) AS has_secret_ref,
         (SELECT COUNT(*) FROM products p WHERE p.provider_id = pr.id) AS product_count,
         (SELECT COUNT(*) FROM product_plans pl
            JOIN products p2 ON p2.id = pl.product_id
           WHERE p2.provider_id = pr.id) AS plan_count,
         -- ACTIVE and ON_HOLD both count: an on-hold subscription has been
         -- paid for and starts on first connection, so it expects this panel
         -- to still be there. The other four statuses (PENDING_PAYMENT,
         -- DISABLED, REMOVED, FAILED) are not owed anything.
         (SELECT COUNT(*) FROM subscriptions s
           WHERE s.provider_id = pr.id
             AND s.status IN ('ACTIVE', 'ON_HOLD')) AS live_subscriptions
    FROM provisioning_providers pr`;

export function registerPanelRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  app.get('/api/v1/admin/panels', async (c) => {
    const rows = await c.env.DB.prepare(`${SELECT_PANEL} ORDER BY pr.sort_order, pr.id`).all<PanelRow>();
    // Five rows on this dataset and a hard ceiling of a few dozen — there is
    // nothing to page.
    return c.json({ ok: true, items: (rows.results ?? []).map(shape) });
  });

  app.post('/api/v1/admin/panels/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = PanelPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json({ ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message }, 400);
    }

    const before = await c.env.DB.prepare(`${SELECT_PANEL} WHERE pr.id = ?1`).bind(id).first<PanelRow>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    const sets: string[] = [];
    const params: unknown[] = [];
    const put = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = ?${params.length}`);
    };
    const patch = body.data;
    if (patch.name !== undefined) put('name', patch.name);
    if (patch.status !== undefined) put('status', patch.status);
    if (patch.capacity !== undefined) put('capacity', patch.capacity);
    if (patch.sortOrder !== undefined) put('sort_order', patch.sortOrder);
    params.push(id);

    await c.env.DB.prepare(
      `UPDATE provisioning_providers SET ${sets.join(', ')}, updated_at = now()
        WHERE id = ?${params.length}`,
    )
      .bind(...params)
      .run();

    const after = await c.env.DB.prepare(`${SELECT_PANEL} WHERE pr.id = ?1`).bind(id).first<PanelRow>();
    if (!after) return c.json({ ok: false, error: 'not_found' }, 404);

    await audit(
      c.env.DB,
      ident,
      'panel.updated',
      'PROVIDER',
      String(id),
      { name: before.name, status: before.status, capacity: before.capacity, sort_order: before.sort_order },
      { name: after.name, status: after.status, capacity: after.capacity, sort_order: after.sort_order },
      null,
    );

    return c.json({
      ok: true,
      panel: shape(after),
      // The caller shows this before and after: disabling a panel that is
      // still fulfilling renewals is a decision, not a typo, but it should be
      // a decision made with the number in view.
      liveSubscriptions: Number(after.live_subscriptions),
    });
  });
}
