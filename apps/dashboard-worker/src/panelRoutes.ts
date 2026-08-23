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
 * Credentials USED to be unwritable here, and this header used to say so — "a
 * form that cannot be submitted cannot leak". That was true and it was also
 * why «مدیریت پنل‌ها» had an edit button and no add button: the credential
 * lived in `PANEL_<REF>` in the bot's environment, and a dashboard cannot write
 * an environment variable onto another container. Adding a panel meant editing
 * Coolify and redeploying, and a panel whose variable was forgotten answers
 * `retryable: false` — every paid order on it fails and refunds in front of the
 * customer.
 *
 * So since 2026-08-23 two routes here CAN write a credential, and the rules
 * that replace "there is no such route" are:
 *
 *   - it is sealed before it reaches the database (`provider_secrets`, AES-256-GCM,
 *     key in `PANEL_SECRET_KEY` and nowhere near the row);
 *   - no route in this file ever reads one back out to a browser — not the
 *     list, not the detail, not the echo of a write. `hasCredential` is a
 *     boolean and that is the whole of what leaves;
 *   - `audit_logs` records that a credential was set and by whom, never any
 *     part of the value;
 *   - the connection test reports the panel's HTTP status and nothing else,
 *     because some panels echo the submitted credentials back in the body of a
 *     rejected login.
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
import { adapterFor, open, panelSecretKey, seal, splitCredential } from '@shikoo/domain';
import { createHash } from 'node:crypto';

/**
 * A short fingerprint of the key that sealed a row, so a future rotation can
 * tell what it has already re-sealed. Of the KEY, never of the secret: a
 * fingerprint of the plaintext would let anyone holding the table confirm a
 * guessed password.
 */
function keyId(key: Buffer): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

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

/**
 * The credential half of a write, kept in one schema so both routes that accept
 * one accept exactly the same thing.
 *
 * `username:password` is assembled here and never split again — the colon rule
 * lives in `splitCredential`, and a username containing a colon would make the
 * two ends disagree about where the password starts. So it is refused at the
 * door rather than silently producing a password nobody typed.
 */
/**
 * Did we reach the host at all — measured, not inferred.
 *
 * `AccountsResult` on failure is only `{ ok: false, reason }`. A DNS failure and
 * a refused login are the same shape, and the adapter's own message is the only
 * thing that separates them. Reading that string was the first version of this
 * and it was wrong on the first real try: a hostname that does not resolve came
 * back as `reachable: true`, so the screen said "پنل جواب داد ولی ورود پذیرفته
 * نشد — نام کاربری یا رمز درست نیست" about an address that does not exist. That
 * is precisely the wrong answer this button exists to prevent: it sends an
 * operator to check a password that was never the problem.
 *
 * So reachability is its own question, asked first. ANY HTTP response counts —
 * 404 and 502 included. The question is whether something is there, not whether
 * it likes the request; the adapter decides the rest.
 */
async function reachable(baseUrl: string): Promise<boolean> {
  const control = new AbortController();
  const timer = setTimeout(() => control.abort(), 8_000);
  try {
    await fetch(baseUrl, { method: 'GET', signal: control.signal, redirect: 'manual' });
    return true;
  } catch {
    // DNS, TLS, a refused connection, or the timeout above.
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A panel's credential, resolved exactly the way the bot resolves it.
 *
 * The precedence is the load-bearing part, and it is `credentialsFor` in
 * `apps/bot/src/provision.ts`: the sealed row first, `PANEL_<REF>` second. Two
 * places deciding this independently is how a connection test comes back green
 * against one credential while orders go out on another — so both routes here
 * call this, and it says out loud which rule it is copying.
 *
 * A sealed value that will not open THROWS rather than returning null. The two
 * are different facts: null is "this panel has no credential", and a caller is
 * entitled to say so; a row that will not open usually means PANEL_SECRET_KEY is
 * wrong, and telling an operator their panel has no password would send them to
 * retype one that was already right.
 */
function credentialFor(row: {
  secret_ref: string | null;
  sealed: string | null;
}): { username: string; password: string } | null {
  if (row.sealed) return splitCredential(open(row.sealed, panelSecretKey()));
  if (!row.secret_ref) return null;
  const raw = process.env[`PANEL_${row.secret_ref.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`];
  return raw ? splitCredential(raw) : null;
}

/**
 * The panel address, normalised the way the legacy wizard asked an operator to
 * type it.
 *
 * `panel/panels.php` printed four rules and then trusted the human to follow
 * them: send it without /dashboard, leave the port off when it is 443, no
 * trailing slash, and it must carry http or https. Four rules a person applies
 * by hand is four ways to save a panel that answers 404 and looks configured —
 * and an operator only finds out when a paying customer's order fails.
 *
 * So they are applied here instead of printed. Each is a fact about the address,
 * not a preference:
 *
 *   - /dashboard is the panel's WEB UI. The API is at the root, so an address
 *     ending there makes every call 404. Stripped, because there is no reading
 *     of "the panel is at /dashboard" that the API honours.
 *   - a trailing slash doubles into `//api/...` on some builds. Stripped.
 *   - :443 on https and :80 on http are the defaults; keeping them makes the
 *     stored address differ from the one `originGuard` and the subscription
 *     links compare against. Dropped.
 *   - no scheme is refused rather than guessed. Assuming https for a panel
 *     reachable only over http would fail at TLS with a message about
 *     certificates, and assuming http would send the password in clear.
 */
function normalisePanelUrl(raw: string): { url: string } | { error: string } {
  const trimmed = raw.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return { error: 'آدرس باید با http:// یا https:// شروع شود' };
  }
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: 'این آدرس معتبر نیست' };
  }
  if (
    (parsed.protocol === 'https:' && parsed.port === '443') ||
    (parsed.protocol === 'http:' && parsed.port === '80')
  ) {
    parsed.port = '';
  }
  let path = parsed.pathname.replace(/\/+$/, '');
  // Case-insensitively, and only at the END: a panel really mounted under
  // /x/dashboard/api is not a thing, but a host named `dashboard.example.com`
  // is — and stripping that would break it.
  path = path.replace(/\/dashboard$/i, '');
  parsed.pathname = path;
  parsed.search = '';
  parsed.hash = '';
  return { url: parsed.toString().replace(/\/+$/, '') };
}

const Credential = z
  .object({
    username: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((v) => !v.includes(':'), 'a panel username cannot contain a colon'),
    password: z.string().min(1).max(512),
  })
  .strict();

const PanelCreate = z
  .object({
    // Lowercase and dashed, because this doubles as the `PANEL_<CODE>`
    // environment name for anyone who still wires one that way, and it is what
    // an operator reads in an error message.
    code: z
      .string()
      .trim()
      .min(2)
      .max(60)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes only'),
    name: z.string().trim().min(1).max(120),
    // The same nine the CHECK constraint allows. Listed rather than free text
    // so a typo answers 400 here instead of 500 from Postgres.
    kind: z.enum([
      'marzban',
      'pasarguard',
      'marzneshin',
      'hiddify',
      'xui',
      'wireguard',
      'ai_account',
      'spotify',
      'manual',
    ]),
    baseUrl: z.string().trim().max(300).nullable().optional(),
    capacity: z.number().int().min(0).max(1_000_000).nullable().optional(),
    sortOrder: z.number().int().min(0).max(9999).optional(),
    credential: Credential.optional(),
  })
  .strict();

/**
 * The test route's body.
 *
 * A credential may be supplied so the button works BEFORE the panel is saved —
 * which is the only order that makes sense: an operator types an address and a
 * password and wants to know they are right, not to save a broken panel and
 * find out afterwards. Omitted, the stored credential is used, which is what
 * the button on an existing panel does.
 */
/**
 * A set of group ids.
 *
 * Deduplicated and sorted before it is stored, so two saves that mean the same
 * thing produce the same row and an audit diff shows a real change rather than
 * a reordering. Empty is allowed and means "send no groups", which is what a
 * panel whose plans all override it should say.
 */
const GroupSelection = z
  .object({
    groupIds: z
      .array(z.number().int().min(0).max(1_000_000))
      .max(200)
      .transform((ids) => [...new Set(ids)].sort((a, b) => a - b)),
  })
  .strict();

const PanelTest = z
  .object({
    baseUrl: z.string().trim().max(300).optional(),
    kind: z.string().trim().min(1).max(40).optional(),
    credential: Credential.optional(),
  })
  .strict();

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
 * A boolean rather than the value: the column names a secret in the runtime
 * store, and even the NAME does not need to reach the browser. `config` is
 * absent from this projection on purpose — see the file header.
 */
const SELECT_PANEL = `
  SELECT pr.id, pr.code, pr.name, pr.kind, pr.status, pr.base_url,
         pr.capacity, pr.sort_order,
         -- Either resolution path counts. Reporting only secret_ref would
         -- show a panel added through this screen as having no credential,
         -- which is the one thing this column exists to warn about.
         -- (No backticks in a SQL comment inside a template literal — they
         -- close the string. Second time today.)
         (pr.secret_ref IS NOT NULL
            OR EXISTS (SELECT 1 FROM provider_secrets ps WHERE ps.provider_id = pr.id))
           AS has_secret_ref,
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
    const rows = await c.env.DB.prepare(
      `${SELECT_PANEL} ORDER BY pr.sort_order, pr.id`,
    ).all<PanelRow>();
    // Five rows on this dataset and a hard ceiling of a few dozen — there is
    // nothing to page.
    return c.json({ ok: true, items: (rows.results ?? []).map(shape) });
  });

  /**
   * Add a panel — the button «مدیریت پنل‌ها» did not have.
   *
   * Provider row and sealed credential in ONE statement, through a CTE, so a
   * failure cannot leave a panel that exists and cannot authenticate. That row
   * is worse than no row: it is ACTIVE by default, so the next purchase routed
   * to it answers `retryable: false` and refunds a customer who already paid.
   *
   * The credential is optional, because `manual` and `ai_account` panels have
   * nothing to log in to. Every other kind without one is created DISABLED
   * rather than ACTIVE — see below.
   */
  app.post('/api/v1/admin/panels', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const body = PanelCreate.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }
    const p = body.data;

    // Applied before the duplicate check, so two panels that differ only by a
    // trailing slash collide on `code` rather than both being created.
    let baseUrl: string | null = null;
    if (p.baseUrl) {
      const normalised = normalisePanelUrl(p.baseUrl);
      if ('error' in normalised) {
        return c.json({ ok: false, error: 'invalid_body', detail: normalised.error }, 400);
      }
      baseUrl = normalised.url;
    }

    const taken = await c.env.DB.prepare(`SELECT 1 FROM provisioning_providers WHERE code = ?1`)
      .bind(p.code)
      .first();
    // A friendly answer for the collision an operator will actually hit. The
    // unique index is still what guarantees it — this only decides the wording.
    if (taken) return c.json({ ok: false, error: 'code_taken' }, 409);

    // A panel that cannot log in must not be ACTIVE. Postgres defaults the
    // column to 'ACTIVE', which is right for a panel that works and exactly
    // wrong for one waiting on a password: catalogue routing does not ask
    // whether a panel has a credential, it asks whether it is ACTIVE.
    const needsLogin = p.kind !== 'manual' && p.kind !== 'ai_account';
    const status = !p.credential && needsLogin ? 'DISABLED' : 'ACTIVE';

    let sealed: string | null = null;
    let sealedKeyId: string | null = null;
    if (p.credential) {
      let key: Buffer;
      try {
        key = panelSecretKey();
      } catch (err) {
        // The operator typed a correct password and the SERVER is misconfigured.
        // Saying so beats "could not save", which sends them back to retype it.
        return c.json(
          { ok: false, error: 'secret_key_missing', detail: (err as Error).message },
          503,
        );
      }
      sealed = seal(`${p.credential.username}:${p.credential.password}`, key);
      sealedKeyId = keyId(key);
    }

    await c.env.DB.prepare(
      `WITH created AS (
         INSERT INTO provisioning_providers (code, name, kind, status, base_url, capacity, sort_order)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         RETURNING id
       )
       INSERT INTO provider_secrets (provider_id, sealed, key_id, set_by)
       -- The casts are load-bearing, not decoration: a bare parameter in
       -- "WHERE ?8 IS NOT NULL" gives the planner nothing to infer a type from
       -- and Postgres answers "could not determine data type of parameter $8".
       -- SQLite inferred it and Postgres will not, which is the seam
       -- packages/db exists for.
       SELECT created.id, ?8::text, ?9::text, ?10::text
         FROM created
        WHERE ?8::text IS NOT NULL`,
    )
      .bind(
        p.code,
        p.name,
        p.kind,
        status,
        baseUrl,
        p.capacity ?? null,
        p.sortOrder ?? 0,
        sealed,
        sealedKeyId,
        ident.email,
      )
      .run();

    const created = await c.env.DB.prepare(`${SELECT_PANEL} WHERE pr.code = ?1`)
      .bind(p.code)
      .first<PanelRow>();
    if (!created) return c.json({ ok: false, error: 'not_found' }, 500);

    await audit(
      c.env.DB,
      ident,
      'catalog.panel_created',
      'PROVISIONING_PROVIDER',
      String(created.id),
      null,
      // The shape, never the credential. `hasCredential` is deliberately the
      // only thing recorded about it.
      { code: p.code, name: p.name, kind: p.kind, status, hasCredential: sealed !== null },
      null,
    );

    return c.json({ ok: true, panel: shape(created), status: 201 }, 201);
  });

  /**
   * Replace a panel's credential.
   *
   * Separate from the patch route because the two have different blast radii: a
   * name is cosmetic and this is the thing an order's success hangs on. It is
   * also the only write in this file whose BEFORE value cannot be audited,
   * which is a reason to keep it visibly on its own.
   */
  app.post('/api/v1/admin/panels/:id/credentials', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = Credential.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    const before = await c.env.DB.prepare(`${SELECT_PANEL} WHERE pr.id = ?1`)
      .bind(id)
      .first<PanelRow>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    let key: Buffer;
    try {
      key = panelSecretKey();
    } catch (err) {
      return c.json(
        { ok: false, error: 'secret_key_missing', detail: (err as Error).message },
        503,
      );
    }

    await c.env.DB.prepare(
      `INSERT INTO provider_secrets (provider_id, sealed, key_id, set_by)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT (provider_id) DO UPDATE
         SET sealed = EXCLUDED.sealed,
             key_id = EXCLUDED.key_id,
             set_by = EXCLUDED.set_by,
             updated_at = now()`,
    )
      .bind(id, seal(`${body.data.username}:${body.data.password}`, key), keyId(key), ident.email)
      .run();

    await audit(
      c.env.DB,
      ident,
      'catalog.panel_credential_set',
      'PROVISIONING_PROVIDER',
      String(id),
      null,
      // The username is recorded because it is an operational fact somebody
      // will need during an incident, and it is not the secret. The password
      // is not here in any form, hashed or otherwise.
      { code: before.code, username: body.data.username },
      null,
    );

    const after = await c.env.DB.prepare(`${SELECT_PANEL} WHERE pr.id = ?1`)
      .bind(id)
      .first<PanelRow>();
    return c.json({ ok: true, panel: after ? shape(after) : null });
  });

  /**
   * تست ارتباط با پنل — does this address and this password actually work.
   *
   * Through `adapter.listAccounts`, not a hand-written login probe, and that
   * choice is the whole value of the button. `listAccounts` is the same code
   * path provisioning authenticates with, so a green here means a purchase will
   * get through the login; a bespoke probe would prove only that the probe
   * works. It is also read-only — nothing is created on the panel to test it,
   * which is what makes this safe to press against a live panel.
   *
   * A credential may be supplied in the body to test BEFORE saving. That is the
   * order an operator actually works in: type the address and password, press
   * test, and only save something known to work. Omitted, the stored credential
   * is used — which is how the button behaves on a panel that already exists.
   *
   * WHAT COMES BACK. Reachable or not, authenticated or not, and how many
   * accounts were listed. Never the panel's response body: `panel-preflight.ts`
   * found that some panels echo the submitted credentials back inside a
   * rejected login, and this response is rendered in a browser.
   */
  /**
   * گروه‌های پنل — what the panel offers, and what we are actually sending.
   *
   * The legacy shop modelled a "panel" as a physical PasarGuard plus a choice of
   * groups: `marzban_panel` has five rows, all on `https://pasargad.4g3.uk`, and
   * they differ only in `inbounds` — `[42,2]` for VIP, `[83]` for the unlimited
   * single-location line, `[2]` for the rest. Buying VIP got you groups 42 and 2
   * because the panel row said so. The migration carried that into
   * `provisioning_providers.config.inbounds`, and `pick()` in marzban.ts lets a
   * plan override it via `attrs.group_ids` — plan first, panel as the default,
   * the same precedence the PHP had.
   *
   * Until now nothing in the dashboard showed any of it. `group_ids` appeared
   * zero times in `apps/admin-web` and zero times in this app, so the number that
   * decides what a paying customer receives was visible only in a jsonb column.
   *
   * Three things come back together, because separately they mislead:
   *
   *   selected  — what this panel sends today
   *   available — what the panel says it HAS, asked live
   *   plans     — the plans that override the panel, so changing this here does
   *               not silently do nothing for the ones that do not use it
   *
   * `available` is null, never empty, when the panel could not be asked. A panel
   * that is down is not a panel with no groups, and rendering the second for the
   * first invites an operator to "fix" configuration that was correct — which is
   * the exact shape of the group-42 miss this screen exists to prevent.
   */
  app.get('/api/v1/admin/panels/:id/groups', async (c) => {
    const ident = c.get('identity');
    // A read, so REVIEWER and READ_ONLY are fine — but the reply names the
    // panel's live state, so it stays behind the same door as the rest of
    // /admin/*, which `write-roles` does not cover for GETs.
    if (ident.role === null) return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const row = await c.env.DB.prepare(
      `SELECT pr.id, pr.code, pr.name, pr.kind, pr.base_url, pr.secret_ref,
              pr.config, ps.sealed
         FROM provisioning_providers pr
         LEFT JOIN provider_secrets ps ON ps.provider_id = pr.id
        WHERE pr.id = ?1`,
    )
      .bind(id)
      .first<{
        id: number;
        code: string;
        name: string;
        kind: string;
        base_url: string | null;
        secret_ref: string | null;
        config: Record<string, unknown> | null;
        sealed: string | null;
      }>();
    if (!row) return c.json({ ok: false, error: 'not_found' }, 404);

    const config = row.config ?? {};
    // Both spellings, because the importer wrote the legacy one and anything
    // saved through this screen writes the current one. Reading only `group_ids`
    // would show every migrated panel as sending nothing.
    const rawSelected = config['group_ids'] ?? config['inbounds'];
    const selected = Array.isArray(rawSelected)
      ? rawSelected.filter((v): v is number => typeof v === 'number')
      : [];

    // Which plans ignore this panel's choice. `attrs` wins in `pick()`, so a
    // plan listed here is unaffected by anything saved on this screen.
    const overrides = await c.env.DB.prepare(
      `SELECT pl.id, pl.name,
              COALESCE(pl.attrs->'group_ids', pl.attrs->'inbounds') AS groups
         FROM product_plans pl
         JOIN products p ON p.id = pl.product_id
        WHERE p.provider_id = ?1
          -- jsonb_exists, not the operator that means the same thing.
          -- Postgres spells jsonb key-existence with a question mark, and
          -- packages/db reads a bare one as a placeholder: it refused this
          -- statement outright with "mixes ?N and bare ? placeholders", which
          -- is the adapter doing its job rather than guessing. The function
          -- form has no such collision.
          AND (jsonb_exists(pl.attrs, 'group_ids') OR jsonb_exists(pl.attrs, 'inbounds'))
        ORDER BY pl.id`,
    )
      .bind(id)
      .all<{ id: number; name: string; groups: unknown }>();

    const adapter = adapterFor(row.kind);
    if (!adapter?.listGroups) {
      return c.json({
        ok: true,
        selected,
        available: null,
        untestable: true,
        reason: `یک پنل «${row.kind}» گروه ندارد.`,
        plans: overrides.results ?? [],
      });
    }

    let credentials: { username: string; password: string } | null;
    try {
      credentials = credentialFor(row);
    } catch (err) {
      return c.json({
        ok: true,
        selected,
        available: null,
        reason: `اعتبارنامهٔ ذخیره‌شده باز نشد: ${(err as Error).message}`,
        plans: overrides.results ?? [],
      });
    }
    if (!row.base_url || !credentials) {
      return c.json({
        ok: true,
        selected,
        available: null,
        reason: row.base_url ? 'این پنل هنوز رمزی ندارد.' : 'آدرس پنل وارد نشده است.',
        plans: overrides.results ?? [],
      });
    }

    const result = await adapter.listGroups({
      id: row.id,
      code: row.code,
      name: row.name,
      baseUrl: row.base_url,
      credentials,
      config,
      fetch: fetch,
    });

    return c.json({
      ok: true,
      selected,
      available: result.ok ? result.groups : null,
      ...(result.ok ? {} : { reason: result.reason }),
      plans: overrides.results ?? [],
    });
  });

  /**
   * Save which groups this panel sends.
   *
   * Written as `group_ids` and the legacy `inbounds` key is REMOVED in the same
   * write. Leaving it would put two spellings of the same fact in one row, and
   * `pick()` reads `group_ids` first — so the stale one would sit there looking
   * authoritative and doing nothing, until somebody read it during an incident.
   *
   * Everything else in `config` is preserved: it carries `proxies`, including a
   * hysteria shared secret provisioning has to send, and a screen that owns one
   * key must not rewrite the object around it.
   */
  app.post('/api/v1/admin/panels/:id/groups', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = GroupSelection.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    const before = await c.env.DB.prepare(
      `SELECT code, config FROM provisioning_providers WHERE id = ?1`,
    )
      .bind(id)
      .first<{ code: string; config: Record<string, unknown> | null }>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    const previous = before.config ?? {};
    const wasSending = previous['group_ids'] ?? previous['inbounds'] ?? null;

    await c.env.DB.prepare(
      `UPDATE provisioning_providers
          SET config = (COALESCE(config, '{}'::jsonb) - 'inbounds')
                       || jsonb_build_object('group_ids', ?2::jsonb),
              updated_at = now()
        WHERE id = ?1`,
    )
      .bind(id, JSON.stringify(body.data.groupIds))
      .run();

    await audit(
      c.env.DB,
      ident,
      'catalog.panel_groups_set',
      'PROVISIONING_PROVIDER',
      String(id),
      { code: before.code, groups: wasSending },
      { code: before.code, groups: body.data.groupIds },
      null,
    );

    const after = await c.env.DB.prepare(`${SELECT_PANEL} WHERE pr.id = ?1`)
      .bind(id)
      .first<PanelRow>();
    return c.json({ ok: true, panel: after ? shape(after) : null });
  });

  app.post('/api/v1/admin/panels/:id/test', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    // id 0 means "not saved yet" — the create form testing before it writes.
    const unsaved = id === 0;
    if (!unsaved && (!Number.isInteger(id) || id < 0)) {
      return c.json({ ok: false, error: 'invalid_id' }, 400);
    }

    const body = PanelTest.safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    let kind = body.data.kind ?? null;
    let baseUrl = body.data.baseUrl ?? null;
    if (baseUrl) {
      // Normalised here too, so «تست ارتباط» exercises the address that would
      // actually be saved. Testing the raw one and storing a different one is
      // how a green test turns into a 404 an hour later.
      const normalised = normalisePanelUrl(baseUrl);
      if ('error' in normalised) {
        return c.json({ ok: false, error: 'invalid_body', detail: normalised.error }, 400);
      }
      baseUrl = normalised.url;
    }
    let name = 'panel';
    let credentials: { username: string; password: string } | null = null;

    if (body.data.credential) {
      credentials = body.data.credential;
    }

    if (!unsaved) {
      const row = await c.env.DB.prepare(
        `SELECT pr.name, pr.kind, pr.base_url, pr.secret_ref, ps.sealed
           FROM provisioning_providers pr
           LEFT JOIN provider_secrets ps ON ps.provider_id = pr.id
          WHERE pr.id = ?1`,
      )
        .bind(id)
        .first<{
          name: string;
          kind: string;
          base_url: string | null;
          secret_ref: string | null;
          sealed: string | null;
        }>();
      if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
      name = row.name;
      kind = kind ?? row.kind;
      baseUrl = baseUrl ?? row.base_url;
      if (!credentials) {
        try {
          credentials = credentialFor(row);
        } catch (err) {
          return c.json({
            ok: true,
            reachable: false,
            authenticated: false,
            reason: `stored credential could not be opened: ${(err as Error).message}`,
          });
        }
      }
    }

    if (!kind) return c.json({ ok: false, error: 'kind_required' }, 400);

    // Asked BEFORE the address, because it is the more informative answer and
    // the order was wrong the first time: a `manual` panel has no base_url, so
    // it came back "آدرس پنل وارد نشده" — which reads as something the operator
    // should go and fix, about a kind that will never have one.
    const adapter = adapterFor(kind);
    if (!adapter?.listAccounts) {
      // Honest rather than green. Answering "OK" for a kind a person fulfils by
      // hand would teach an operator to trust a tick that means nothing.
      return c.json({
        ok: true,
        reachable: false,
        authenticated: false,
        untestable: true,
        reason: `یک پنل «${kind}» چیزی برای ورود ندارد — تحویلش دستی است.`,
      });
    }
    if (!baseUrl) {
      return c.json({ ok: true, reachable: false, authenticated: false, reason: 'no_base_url' });
    }
    if (!credentials) {
      return c.json({ ok: true, reachable: false, authenticated: false, reason: 'no_credential' });
    }

    const started = Date.now();

    // Asked before the adapter, so the two answers cannot contradict.
    if (!(await reachable(baseUrl))) {
      return c.json({
        ok: true,
        reachable: false,
        authenticated: false,
        ms: Date.now() - started,
        reason: 'the address did not answer — wrong hostname, or the panel is down',
      });
    }

    try {
      const result = await adapter.listAccounts({
        id: unsaved ? 0 : id,
        code: String(id),
        name,
        baseUrl,
        credentials,
        config: {},
        fetch: fetch,
      });
      const ms = Date.now() - started;
      if (!result.ok) {
        return c.json({
          ok: true,
          reachable: true,
          authenticated: false,
          ms,
          // The adapter's own reason. It is built from the panel's STATUS, not
          // its body — see the file header on why the body never comes back.
          reason: result.reason,
        });
      }
      return c.json({
        ok: true,
        reachable: true,
        authenticated: true,
        ms,
        accounts: result.accounts.length,
      });
    } catch (err) {
      // The probe above already said something is there, so this is the adapter
      // itself throwing rather than the address being wrong.
      return c.json({
        ok: true,
        reachable: true,
        authenticated: false,
        ms: Date.now() - started,
        reason: (err as Error).message,
      });
    }
  });

  app.post('/api/v1/admin/panels/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = PanelPatch.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    const before = await c.env.DB.prepare(`${SELECT_PANEL} WHERE pr.id = ?1`)
      .bind(id)
      .first<PanelRow>();
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

    const after = await c.env.DB.prepare(`${SELECT_PANEL} WHERE pr.id = ?1`)
      .bind(id)
      .first<PanelRow>();
    if (!after) return c.json({ ok: false, error: 'not_found' }, 404);

    await audit(
      c.env.DB,
      ident,
      'panel.updated',
      'PROVIDER',
      String(id),
      {
        name: before.name,
        status: before.status,
        capacity: before.capacity,
        sort_order: before.sort_order,
      },
      {
        name: after.name,
        status: after.status,
        capacity: after.capacity,
        sort_order: after.sort_order,
      },
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
