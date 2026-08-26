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
import {
  adapterFor,
  open,
  panelSecretKey,
  renewAllowed,
  renewModeFor,
  seal,
  splitCredential,
} from '@shikoo/domain';
import type { ProviderContext, ProvisioningAdapter } from '@shikoo/domain';
import { createHash } from 'node:crypto';
import { faNum } from './fa.js';

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
    /**
     * The address was create-only until 2026-08-26, so a panel that moved host
     * could not be repaired — only deleted and rebuilt, which loses the id every
     * sold subscription points at. Normalised through the same helper as create,
     * so the two cannot disagree about a trailing slash.
     */
    baseUrl: z.string().trim().max(300).nullable().optional(),
    /**
     * The two `config` keys `renewModeFor` and `renewAllowed` already read.
     * They were written for a dashboard that had not been built — the comment
     * in `provisioning/index.ts` says `renew_mode` "is what an admin sets from
     * here on", and until now nothing did. The Persian-phrase legacy keys stay
     * as the fallback and are never written from here.
     */
    renewMode: z.enum(['ADD', 'RESET']).optional(),
    renewEnabled: z.boolean().optional(),
    /**
     * Re-probe the panel and let the answer decide ACTIVE/DISABLED, the way
     * «وضعیت خودکار» does in the shop this screen is modelled on. Ignored when
     * `status` is also sent: an explicit choice by a person outranks a probe.
     */
    autoStatus: z.boolean().optional(),
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
 * One probe, two callers: «تست ارتباط» and «وضعیت خودکار».
 *
 * They ask the same question — can this panel be logged into right now — and
 * the moment they answer it separately they will disagree, which is the worst
 * possible outcome: a green test beside a panel the save switched off. So the
 * whole ladder lives here and both callers read the same verdict.
 *
 * `untestable` is NOT a failure. A `manual` panel has nothing to log into and
 * fulfils by hand; auto-status must leave it ACTIVE rather than switching off
 * every panel that was never going to answer.
 */
type PanelProbe =
  | { state: 'untestable'; reason: string }
  | { state: 'no_base_url' | 'no_credential' }
  | { state: 'unreachable'; ms: number; reason: string }
  | { state: 'unauthenticated'; ms: number; reason: string }
  | { state: 'ok'; ms: number; groups?: number; accounts?: number };

async function probePanel(target: {
  id: number;
  name: string;
  kind: string;
  baseUrl: string | null;
  credentials: { username: string; password: string } | null;
}): Promise<PanelProbe> {
  // Asked BEFORE the address, because it is the more informative answer and
  // the order was wrong the first time: a `manual` panel has no base_url, so
  // it came back "آدرس پنل وارد نشده" — which reads as something the operator
  // should go and fix, about a kind that will never have one.
  const adapter = adapterFor(target.kind);
  if (!adapter?.listGroups && !adapter?.listAccounts) {
    return {
      state: 'untestable',
      reason: `یک پنل «${target.kind}» چیزی برای ورود ندارد — تحویلش دستی است.`,
    };
  }
  if (!target.baseUrl) return { state: 'no_base_url' };
  if (!target.credentials) return { state: 'no_credential' };

  const started = Date.now();

  // Asked before the adapter, so the two answers cannot contradict.
  if (!(await reachable(target.baseUrl))) {
    return {
      state: 'unreachable',
      ms: Date.now() - started,
      reason: 'the address did not answer — wrong hostname, or the panel is down',
    };
  }

  const context = {
    id: target.id,
    code: String(target.id),
    name: target.name,
    baseUrl: target.baseUrl,
    credentials: target.credentials,
    config: {},
    fetch: fetch,
  };

  /**
   * The login is proved with the GROUP listing, not the account listing.
   *
   * Both answer the only question this asks — can we log in — and they cost
   * wildly different amounts. `listAccounts` pages through every user on the
   * panel; on the deployed dashboard that took longer than nginx's 60-second
   * default and the button answered `504 Gateway Time-out` on a panel that was
   * perfectly healthy. Reading the groups is one GET.
   *
   * The account count was the nicer number to show and it is not worth a button
   * that appears broken. What replaces it is more useful anyway: the group count
   * is what this screen is about, and a panel answering «۰ گروه» is telling an
   * operator something real.
   */
  try {
    const result = adapter.listGroups
      ? await adapter.listGroups(context)
      : await adapter.listAccounts!(context);
    const ms = Date.now() - started;
    if (!result.ok) {
      // The adapter's own reason. It is built from the panel's STATUS, not its
      // body — see the file header on why the body never comes back.
      return { state: 'unauthenticated', ms, reason: result.reason };
    }
    return {
      state: 'ok',
      ms,
      ...('groups' in result
        ? { groups: result.groups.length }
        : { accounts: result.accounts.length }),
    };
  } catch (err) {
    // The probe above already said something is there, so this is the adapter
    // itself throwing rather than the address being wrong.
    return { state: 'unauthenticated', ms: Date.now() - started, reason: (err as Error).message };
  }
}

/**
 * The probe, in the shape «تست ارتباط» has always answered in.
 *
 * Kept as a separate mapping rather than folded into `probePanel`, because the
 * verdict and the wire format have different reasons to change: auto-status
 * cares only about `state`, and it must not start depending on the wording of a
 * message written for a person to read.
 */
function probeReply(probe: PanelProbe): Record<string, unknown> {
  switch (probe.state) {
    case 'untestable':
      // Honest rather than green. Answering "OK" for a kind a person fulfils by
      // hand would teach an operator to trust a tick that means nothing.
      return {
        reachable: false,
        authenticated: false,
        untestable: true,
        reason: probe.reason,
      };
    case 'no_base_url':
    case 'no_credential':
      return { reachable: false, authenticated: false, reason: probe.state };
    case 'unreachable':
      return { reachable: false, authenticated: false, ms: probe.ms, reason: probe.reason };
    case 'unauthenticated':
      return { reachable: true, authenticated: false, ms: probe.ms, reason: probe.reason };
    case 'ok':
      return {
        reachable: true,
        authenticated: true,
        ms: probe.ms,
        ...(probe.groups === undefined ? {} : { groups: probe.groups }),
        ...(probe.accounts === undefined ? {} : { accounts: probe.accounts }),
      };
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
 * The panel, ready to be asked something — or the Persian sentence saying why
 * it cannot be.
 *
 * Five routes need the same four steps (row, adapter, credential, address) and
 * they must fail identically, because the difference between «آدرس وارد نشده»
 * and «رمز باز نشد» is the difference between an operator fixing the right
 * field and retyping a password that was already correct. Written once here
 * rather than five times: the group listing already had its own copy of this
 * and a second one drifting would show two screens disagreeing about the same
 * panel.
 *
 * `status` is deliberately NOT part of it. A disabled panel can still be
 * inspected and repaired — refusing to read its groups because it is off is how
 * a panel gets stuck off.
 */
type PanelContext =
  | { ok: true; adapter: ProvisioningAdapter; provider: ProviderContext; code: string }
  | { ok: false; status: 404 | 200; reason: string };

async function panelContext(db: D1Database, id: number): Promise<PanelContext> {
  const row = await db
    .prepare(
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
  if (!row) return { ok: false, status: 404, reason: 'not_found' };

  const adapter = adapterFor(row.kind);
  if (!adapter.listGroups) {
    return { ok: false, status: 200, reason: `یک پنل «${row.kind}» گروه ندارد.` };
  }

  let credentials: { username: string; password: string } | null;
  try {
    credentials = credentialFor(row);
  } catch (err) {
    // Thrown, not null: a sealed value that will not open is almost always a
    // wrong PANEL_SECRET_KEY, and «این پنل رمز ندارد» would send somebody to
    // retype one that was already right.
    return { ok: false, status: 200, reason: `اعتبارنامهٔ ذخیره‌شده باز نشد: ${(err as Error).message}` };
  }
  if (!row.base_url) return { ok: false, status: 200, reason: 'آدرس پنل وارد نشده است.' };
  if (!credentials) return { ok: false, status: 200, reason: 'این پنل هنوز رمزی ندارد.' };

  return {
    ok: true,
    adapter,
    code: row.code,
    provider: {
      id: row.id,
      code: row.code,
      name: row.name,
      baseUrl: row.base_url,
      credentials,
      config: row.config ?? {},
      fetch,
    },
  };
}

/**
 * Every group id our own catalog still sends to this panel.
 *
 * Both the panel's default and every plan that overrides it, because deleting a
 * group either one names turns the next purchase on it into
 * `404 Group not found` — which the adapter classifies as non-retryable, so the
 * customer pays, waits, and is refunded. This is the group-42 failure with the
 * arrow reversed, and it is the one thing this screen can prevent outright
 * rather than merely warn about.
 */
async function groupIdsInUse(db: D1Database, panelId: number): Promise<Set<number>> {
  const inUse = new Set<number>();
  const panel = await db
    .prepare(`SELECT config FROM provisioning_providers WHERE id = ?1`)
    .bind(panelId)
    .first<{ config: Record<string, unknown> | null }>();
  const own = panel?.config?.['group_ids'] ?? panel?.config?.['inbounds'];
  if (Array.isArray(own)) for (const v of own) if (typeof v === 'number') inUse.add(v);

  // Both levels of override in one query. The SERVICE level is the newer of
  // the two and it is the one an operator now actually uses — «پلاتینیوم» sells
  // into group 6 because its product row says so — so leaving it out of this
  // set would let the delete button remove exactly the group the shop is
  // selling, which is the failure this guard exists to stop.
  const overrides = await db
    .prepare(
      `SELECT COALESCE(pl.attrs->'group_ids', pl.attrs->'inbounds') AS groups
         FROM product_plans pl
         JOIN products p ON p.id = pl.product_id
        WHERE p.provider_id = ?1
          AND (jsonb_exists(pl.attrs, 'group_ids') OR jsonb_exists(pl.attrs, 'inbounds'))
        UNION ALL
       SELECT COALESCE(p.attrs->'group_ids', p.attrs->'inbounds') AS groups
         FROM products p
        WHERE p.provider_id = ?1
          AND (jsonb_exists(p.attrs, 'group_ids') OR jsonb_exists(p.attrs, 'inbounds'))`,
    )
    .bind(panelId)
    .all<{ groups: unknown }>();
  for (const r of overrides.results ?? []) {
    if (Array.isArray(r.groups)) for (const v of r.groups) if (typeof v === 'number') inUse.add(v);
  }
  return inUse;
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

/**
 * Replacing a credential, where the username may be left out.
 *
 * No route here hands a stored username back — the sealed blob is the only copy
 * — so the edit form's username box is empty on a panel that already has one.
 * The first version of that form dropped a typed password on the floor when the
 * box was blank, silently, under a label reading «پسورد جدید (خالی = بدون
 * تغییر)». Found by typing a correct password into the browser and watching the
 * panel come back «ورود پذیرفته نشد».
 *
 * So the server supplies what the browser cannot: absent, the username is read
 * out of the existing sealed value and re-sealed with the new password. This is
 * deliberately NOT `Credential` — creating a panel and testing one both have
 * nothing stored to fall back on, and must keep asking for both halves.
 */
const CredentialReplacement = Credential.partial({ username: true });

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
 * A group as an operator asks for it to be.
 *
 * `name` is trimmed and required because the panel requires it — even on an
 * update, where a body carrying only the inbound list answers
 * `422 {"detail":{"name":"Field required"}}`. `inboundTags` may be empty and
 * that is a real state, not a mistake to reject: an empty group is a tier that
 * exists and delivers nothing, which is exactly what somebody building one step
 * at a time has for a minute. The screen warns; the schema does not refuse.
 */
/**
 * The panel's own selection of its groups.
 *
 * De-duplicated and sorted so two saves of the same ticks produce the same
 * stored value and the audit trail does not record a change that was not one.
 * An empty list is a real answer — «this panel names no default» — and the
 * route turns it into the ABSENCE of the key, never `[]`.
 */
const GroupSelection = z
  .object({
    groupIds: z
      .array(z.number().int().min(0).max(1_000_000))
      .max(200)
      .transform((ids) => [...new Set(ids)].sort((a, b) => a - b)),
  })
  .strict();

const GroupSpec = z
  .object({
    name: z.string().trim().min(1).max(120),
    inboundTags: z
      .array(z.string().trim().min(1).max(200))
      .max(100)
      .transform((tags) => [...new Set(tags)]),
  })
  .strict();

/**
 * A host, as an operator asks for it.
 *
 * `addresses` may be empty — the panel accepts it and the host then resolves to
 * the panel's own address, which is the common case for a single-server shop.
 * Refusing it here would block the simplest thing somebody wants to do.
 */
const HostSpec = z
  .object({
    remark: z.string().trim().min(1).max(120),
    inboundTag: z.string().trim().min(1).max(200),
    addresses: z
      .array(z.string().trim().min(1).max(253))
      .max(20)
      .default([])
      .transform((a) => [...new Set(a)]),
  })
  .strict();

const PanelTest = z
  .object({
    baseUrl: z.string().trim().max(300).optional(),
    kind: z.string().trim().min(1).max(40).optional(),
    credential: Credential.optional(),
  })
  .strict();

/**
 * Why a panel could not be deleted, in the words an operator can act on.
 *
 * Names what is attached and then names the alternative, because "in_use" on
 * its own sends somebody hunting for a delete button that will never work. The
 * three counts are not interchangeable: products are a catalogue edit, live
 * subscriptions are customers, and stock is inventory already paid for.
 */
function refusal(counts: { products: number; subscriptions: number; stock: number }): string {
  const parts: string[] = [];
  if (counts.products > 0) parts.push(`${faNum(counts.products)} سرویس`);
  if (counts.subscriptions > 0) parts.push(`${faNum(counts.subscriptions)} اشتراک زنده`);
  if (counts.stock > 0) parts.push(`${faNum(counts.stock)} کانفیگ در انبار`);
  if (parts.length === 0) return 'چیزی به این پنل وصل است و حذف انجام نشد.';
  return `${parts.join(' و ')} روی این پنل است. «غیرفعال کن» پنل را از خرید و تمدید برمی‌دارد بدون اینکه چیزی از دست برود.`;
}

interface PanelRow {
  id: number;
  code: string;
  name: string;
  kind: string;
  status: string;
  base_url: string | null;
  capacity: number | null;
  sort_order: number;
  config: Record<string, unknown> | null;
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
    /**
     * The two renewal settings, DERIVED — not the config they come from.
     *
     * Both have a legacy spelling underneath them (`Methodextend`, a Persian
     * phrase, and `status_extend`) and the rule for reading them lives in
     * `provisioning/index.ts`. Calling those functions here rather than
     * re-implementing the fallback is the whole point: the screen and the bot
     * must never disagree about whether a panel accumulates or resets.
     */
    renewMode: renewModeFor(r.config ?? {}),
    renewEnabled: renewAllowed(r.config ?? {}),
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
 * store, and even the NAME does not need to reach the browser.
 *
 * `config` IS selected, and never returned. `shape` turns it into the two
 * derived renewal answers and drops the object — the hysteria shared secret in
 * `config.proxies` is why nothing here may hand the row back whole.
 */
const SELECT_PANEL = `
  SELECT pr.id, pr.code, pr.name, pr.kind, pr.status, pr.base_url,
         pr.capacity, pr.sort_order,
         pr.config,
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
    let status = !p.credential && needsLogin ? 'DISABLED' : 'ACTIVE';

    /**
     * «وضعیت خودکار» on the way in: having a password is not the same as the
     * password being right.
     *
     * Until now a panel with a typo in its address was created ACTIVE, joined
     * the catalogue, and the first customer to buy from it paid, waited and was
     * refunded. The probe costs one GET and answers before anything is written.
     * A kind with nothing to log into is left alone — `untestable` is not a
     * failure.
     */
    let probe: PanelProbe | null = null;
    if (status === 'ACTIVE' && needsLogin) {
      probe = await probePanel({
        id: 0,
        name: p.name,
        kind: p.kind,
        baseUrl,
        credentials: p.credential ?? null,
      });
      if (probe.state !== 'ok' && probe.state !== 'untestable') status = 'DISABLED';
    }

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

    return c.json(
      {
        ok: true,
        panel: shape(created),
        // So the screen can say WHY a panel it just made is switched off,
        // instead of leaving the operator to guess and press «تست اتصال».
        ...(probe === null ? {} : { probe: probeReply(probe) }),
        status: 201,
      },
      201,
    );
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

    const body = CredentialReplacement.safeParse(await c.req.json().catch(() => null));
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

    // The username, from the caller or from what is already sealed here.
    let username = body.data.username ?? null;
    if (username === null) {
      const stored = await c.env.DB.prepare(
        `SELECT pr.secret_ref, ps.sealed
           FROM provisioning_providers pr
           LEFT JOIN provider_secrets ps ON ps.provider_id = pr.id
          WHERE pr.id = ?1`,
      )
        .bind(id)
        .first<{ secret_ref: string | null; sealed: string | null }>();
      try {
        username = stored ? (credentialFor(stored)?.username ?? null) : null;
      } catch {
        username = null;
      }
      if (username === null) {
        return c.json(
          {
            ok: false,
            error: 'invalid_body',
            detail: 'این پنل هنوز اعتبارنامه‌ای ندارد — یوزرنیم هم باید داده شود.',
          },
          400,
        );
      }
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
      .bind(id, seal(`${username}:${body.data.password}`, key), keyId(key), ident.email)
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
      { code: before.code, username },
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

    // What ignores this panel's choice. `attrs` wins in `pick()`, so anything
    // listed here is unaffected by whatever is saved on this screen — and that
    // is now most of the catalogue, because a service picking its own tier is
    // the normal case rather than a migrated oddity.
    //
    // Services and plans in one list, each saying which it is. The screen shows
    // «فروخته می‌شود در», and an operator reading it needs to know whether the
    // thing overriding them is a whole service or one plan inside one.
    const overrides = await c.env.DB.prepare(
      `SELECT pl.id, pl.name, 'PLAN' AS level,
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
        UNION ALL
       SELECT p.id, p.name, 'PRODUCT' AS level,
              COALESCE(p.attrs->'group_ids', p.attrs->'inbounds') AS groups
         FROM products p
        WHERE p.provider_id = ?1
          AND (jsonb_exists(p.attrs, 'group_ids') OR jsonb_exists(p.attrs, 'inbounds'))
        ORDER BY level, id`,
    )
      .bind(id)
      .all<{ id: number; name: string; level: string; groups: unknown }>();

    /**
     * The services on this panel that do NOT choose their own level.
     *
     * They are the only ones the panel's own ticks still decide, and the screen
     * never said which they were — so the tick column and the «فروخته می‌شود در»
     * column beside it described two different things under one heading and
     * contradicted each other on any row where a service named a group the
     * panel had not ticked.
     *
     * Naming them is what makes the default legible. On the test panel it is
     * three groups at once, so a service with no level of its own lands in all
     * three — which nobody chose on purpose and nothing said out loud.
     */
    const inheriting = await c.env.DB.prepare(
      `SELECT p.id, p.name
         FROM products p
        WHERE p.provider_id = ?1
          AND p.status <> 'DISABLED'
          AND NOT (jsonb_exists(p.attrs, 'group_ids') OR jsonb_exists(p.attrs, 'inbounds'))
        ORDER BY p.sort_order, p.id`,
    )
      .bind(id)
      .all<{ id: number; name: string }>();
    const inherit = inheriting.results ?? [];

    const adapter = adapterFor(row.kind);
    if (!adapter?.listGroups) {
      return c.json({
        ok: true,
        selected,
        available: null,
        untestable: true,
        reason: `یک پنل «${row.kind}» گروه ندارد.`,
        plans: overrides.results ?? [],
        inherit,
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
        inherit,
      });
    }
    if (!row.base_url || !credentials) {
      return c.json({
        ok: true,
        selected,
        available: null,
        reason: row.base_url ? 'این پنل هنوز رمزی ندارد.' : 'آدرس پنل وارد نشده است.',
        plans: overrides.results ?? [],
        inherit,
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
        inherit,
    });
  });

  /**
   * Which of the panel's own groups this panel sells, when a service does not
   * name its own.
   *
   * ─────────────────────────────────────────────────────────────────────────
   * This route existed, was deleted on 2026-08-24, and is back on 2026-08-26.
   * The note that removed it said delivery "looks at the plan's attrs and then
   * the provider config — never at this column", and that sentence contradicts
   * itself: this column IS the provider config. Three things measured from
   * outside say so, none of them this file:
   *
   *   - `provisioning.test.ts` has a green case literally named «the panel
   *     default», and it asserts against the body the fake panel received.
   *   - `GET` below returns `inherit` — the services with no level of their own,
   *     which exists precisely because these ticks decide them.
   *   - `config.group_ids` on panel 7 was moved from `[1]` to `[3]` by hand and
   *     `panel:preflight` went from failing to passing. Nothing else changed.
   *
   * What was really wrong was the value it wrote. Every stored selection on the
   * practice box was `[]`, and `[]` is not nullish, so it won the `??` chain and
   * the create body carried `group_ids: []` — «this account belongs to no
   * group», which strips every inbound and hands the customer a subscription
   * link that resolves and returns nothing. So an empty selection now DELETES
   * the key rather than storing an empty list, and `groupIdsFor` skips an empty
   * array at every level as well. Two fences, because this one was expensive.
   * ─────────────────────────────────────────────────────────────────────────
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
    const groupIds = body.data.groupIds;

    // Both spellings go in either branch. Leaving the legacy `inbounds` behind
    // would let it answer for a panel an operator had just cleared, because
    // `groupIdsFor` falls through to it.
    await c.env.DB.prepare(
      groupIds.length === 0
        ? `UPDATE provisioning_providers
              SET config = (COALESCE(config, '{}'::jsonb) - 'inbounds') - 'group_ids',
                  updated_at = now()
            WHERE id = ?1`
        : `UPDATE provisioning_providers
              SET config = (COALESCE(config, '{}'::jsonb) - 'inbounds')
                           || jsonb_build_object('group_ids', ?2::jsonb),
                  updated_at = now()
            WHERE id = ?1`,
    )
      .bind(...(groupIds.length === 0 ? [id] : [id, JSON.stringify(groupIds)]))
      .run();

    await audit(
      c.env.DB,
      ident,
      'catalog.panel_groups_set',
      'PROVISIONING_PROVIDER',
      String(id),
      { code: before.code, groups: wasSending },
      { code: before.code, groups: groupIds.length === 0 ? null : groupIds },
      null,
    );

    const after = await c.env.DB.prepare(`${SELECT_PANEL} WHERE pr.id = ?1`)
      .bind(id)
      .first<PanelRow>();
    return c.json({ ok: true, panel: after ? shape(after) : null });
  });

  /**
   * Every inbound the panel has, so a group can be built out of a list rather
   * than out of remembered tag names.
   *
   * The legacy wizard had no equivalent: panel/panels.php took a typed
   * comma-separated inbounds string, so a typo produced a tier that saved
   * cleanly and delivered nothing. This is the same fix the group listing was —
   * ask the panel, do not accept a name.
   *
   * `hosted` is on each row because it is the whole difference between a
   * platinum tier and a platinum-shaped one. An inbound with no host is in
   * every listing, counts toward every total, and hands the customer nothing.
   */
  app.get('/api/v1/admin/panels/:id/inbounds', async (c) => {
    const ident = c.get('identity');
    if (ident.role === null) return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const ctx = await panelContext(c.env.DB, id);
    if (!ctx.ok) {
      if (ctx.status === 404) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json({ ok: true, inbounds: null, reason: ctx.reason });
    }
    if (!ctx.adapter.listInbounds) {
      return c.json({ ok: true, inbounds: null, reason: 'این نوع پنل اینباند ندارد.' });
    }

    const result = await ctx.adapter.listInbounds(ctx.provider);
    return c.json({
      ok: true,
      inbounds: result.ok ? result.inbounds : null,
      ...(result.ok ? {} : { reason: result.reason }),
    });
  });

  /**
   * Make a group ON THE PANEL.
   *
   * Note what this does NOT do: it does not add the new group to what this
   * panel sends. Creating a tier and selling it are two decisions, and folding
   * them together would mean every customer of every existing plan silently
   * started receiving the new inbounds the moment somebody pressed «بساز».
   * The screen offers the checkbox right after; the route keeps them apart.
   *
   * A separate path from POST …/groups, which saves the SELECTION. One verb on
   * one noun meaning two different writes is how an operator ends up replacing
   * a panel's whole tier list while trying to add one to it.
   */
  app.post('/api/v1/admin/panels/:id/panel-groups', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = GroupSpec.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    const ctx = await panelContext(c.env.DB, id);
    if (!ctx.ok) {
      if (ctx.status === 404) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json({ ok: false, error: 'panel_unavailable', detail: ctx.reason }, 400);
    }
    if (!ctx.adapter.createGroup) {
      return c.json({ ok: false, error: 'unsupported', detail: 'این نوع پنل گروه نمی‌سازد.' }, 400);
    }

    const result = await ctx.adapter.createGroup(ctx.provider, body.data);
    if (!result.ok) {
      return c.json({ ok: false, error: 'panel_refused', detail: result.reason }, 400);
    }

    await audit(
      c.env.DB,
      ident,
      'catalog.panel_group_created',
      'PROVISIONING_PROVIDER',
      String(id),
      null,
      {
        code: ctx.code,
        group: result.group.id,
        name: result.group.name,
        inbounds: result.group.inboundTags ?? [],
      },
      null,
    );
    return c.json({ ok: true, group: result.group });
  });

  /**
   * Rename a group or change which inbounds it carries.
   *
   * A full replacement, because the panel makes it one — PUT /api/group/{id}
   * rejects a body without a name. That is worth knowing at this layer too: a
   * caller that sent only the changed field would get a 422 back and no
   * explanation of which field it had forgotten.
   *
   * Changing the inbounds of a group people already bought does not re-deliver
   * anything, and it does not have to: a PasarGuard subscription link is
   * resolved when it is fetched, so existing customers pick the change up on
   * their next refresh. That cuts both ways, which is why the screen says the
   * member count out loud next to this button.
   */
  app.post('/api/v1/admin/panels/:id/panel-groups/:groupId', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    const groupId = Number(c.req.param('groupId'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);
    if (!Number.isInteger(groupId) || groupId < 0) {
      return c.json({ ok: false, error: 'invalid_group_id' }, 400);
    }

    const body = GroupSpec.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    const ctx = await panelContext(c.env.DB, id);
    if (!ctx.ok) {
      if (ctx.status === 404) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json({ ok: false, error: 'panel_unavailable', detail: ctx.reason }, 400);
    }
    if (!ctx.adapter.updateGroup) {
      return c.json({ ok: false, error: 'unsupported', detail: 'این نوع پنل گروه ندارد.' }, 400);
    }

    const result = await ctx.adapter.updateGroup(ctx.provider, groupId, body.data);
    if (!result.ok) {
      return c.json({ ok: false, error: 'panel_refused', detail: result.reason }, 400);
    }

    await audit(
      c.env.DB,
      ident,
      'catalog.panel_group_updated',
      'PROVISIONING_PROVIDER',
      String(id),
      { code: ctx.code, group: groupId },
      {
        code: ctx.code,
        group: groupId,
        name: result.group.name,
        inbounds: result.group.inboundTags ?? [],
      },
      null,
    );
    return c.json({ ok: true, group: result.group });
  });

  /**
   * Delete a group from the panel — refused while our own catalog still sends it.
   *
   * The guard is here and not in the adapter because this is the only layer
   * that knows what we sell. A group named by this panel's group_ids, or by any
   * plan's attrs.group_ids, is one whose deletion turns the next purchase into
   * 404 Group not found → non-retryable → the customer pays, waits, and is
   * refunded with a «تماس بگیرید». That is precisely the group-42 story this
   * screen was built to end, and here it is preventable rather than merely
   * reportable, so it is prevented.
   *
   * Members are NOT a refusal. Accounts in a deleted group keep existing; they
   * stop carrying its inbounds, which is a real consequence and a decision an
   * admin is allowed to make. The count travels to the screen so the decision
   * gets made with the number in view.
   */
  app.delete('/api/v1/admin/panels/:id/panel-groups/:groupId', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    const groupId = Number(c.req.param('groupId'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);
    if (!Number.isInteger(groupId) || groupId < 0) {
      return c.json({ ok: false, error: 'invalid_group_id' }, 400);
    }

    const inUse = await groupIdsInUse(c.env.DB, id);
    if (inUse.has(groupId)) {
      return c.json(
        {
          ok: false,
          error: 'group_in_use',
          detail:
            'این گروه هنوز فروخته می‌شود — از تیک خودِ پنل، یا از یکی از سرویس‌ها، یا از یک پلن. ' +
            'در تب «گروه‌ها» ستون «فروخته می‌شود در» می‌گوید کدام. اول آن را بردارید، بعد حذفش کنید.',
        },
        409,
      );
    }

    const ctx = await panelContext(c.env.DB, id);
    if (!ctx.ok) {
      if (ctx.status === 404) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json({ ok: false, error: 'panel_unavailable', detail: ctx.reason }, 400);
    }
    if (!ctx.adapter.deleteGroup) {
      return c.json({ ok: false, error: 'unsupported', detail: 'این نوع پنل گروه ندارد.' }, 400);
    }

    const result = await ctx.adapter.deleteGroup(ctx.provider, groupId);
    if (!result.ok) {
      return c.json({ ok: false, error: 'panel_refused', detail: result.reason }, 400);
    }

    await audit(
      c.env.DB,
      ident,
      'catalog.panel_group_deleted',
      'PROVISIONING_PROVIDER',
      String(id),
      { code: ctx.code, group: groupId },
      null,
      null,
    );
    return c.json({ ok: true });
  });

  /**
   * The hosts on this panel — what actually puts an inbound in a subscription.
   *
   * The panel has no inbound endpoint at all: `POST /api/inbound` is 404 and
   * `/api/inbounds` is 405. An inbound is a section of the Xray core config,
   * and the only way to add one is to rewrite that whole config — which a
   * dashboard should not do, because one bad edit takes every customer's proxy
   * down rather than one tier.
   *
   * A host is the piece that was actually missing, and it is the one that
   * decides delivery: an inbound with no host is in every listing, counts
   * toward every total, and hands the customer nothing.
   */
  app.get('/api/v1/admin/panels/:id/hosts', async (c) => {
    const ident = c.get('identity');
    if (ident.role === null) return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const ctx = await panelContext(c.env.DB, id);
    if (!ctx.ok) {
      if (ctx.status === 404) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json({ ok: true, hosts: null, reason: ctx.reason });
    }
    if (!ctx.adapter.listHosts) {
      return c.json({ ok: true, hosts: null, reason: 'این نوع پنل هاست ندارد.' });
    }

    const result = await ctx.adapter.listHosts(ctx.provider);
    return c.json({
      ok: true,
      hosts: result.ok ? result.hosts : null,
      ...(result.ok ? {} : { reason: result.reason }),
    });
  });

  app.post('/api/v1/admin/panels/:id/hosts', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const body = HostSpec.safeParse(await c.req.json().catch(() => null));
    if (!body.success) {
      return c.json(
        { ok: false, error: 'invalid_body', detail: body.error.issues[0]?.message },
        400,
      );
    }

    const ctx = await panelContext(c.env.DB, id);
    if (!ctx.ok) {
      if (ctx.status === 404) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json({ ok: false, error: 'panel_unavailable', detail: ctx.reason }, 400);
    }
    if (!ctx.adapter.createHost) {
      return c.json({ ok: false, error: 'unsupported', detail: 'این نوع پنل هاست ندارد.' }, 400);
    }

    const result = await ctx.adapter.createHost(ctx.provider, body.data);
    if (!result.ok) {
      return c.json({ ok: false, error: 'panel_refused', detail: result.reason }, 400);
    }

    await audit(
      c.env.DB,
      ident,
      'catalog.panel_host_created',
      'PROVISIONING_PROVIDER',
      String(id),
      null,
      {
        code: ctx.code,
        host: result.host.id,
        remark: result.host.remark,
        inbound: result.host.inboundTag,
      },
      null,
    );
    return c.json({ ok: true, host: result.host });
  });

  /**
   * Remove a host — refused when it is the last one keeping a tier alive.
   *
   * Same shape as the group guard and the same failure it prevents, one level
   * down. Deleting the last enabled host on an inbound does not break anything
   * loudly: every customer keeps their subscription link, and the link quietly
   * stops producing that config. A tier that used to hand out two now hands out
   * one, and the first report of it is a support message.
   *
   * Only when a group WE SELL carries that inbound. A host on an inbound no
   * tier of ours uses is the operator's own business.
   */
  app.delete('/api/v1/admin/panels/:id/hosts/:hostId', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    const hostId = Number(c.req.param('hostId'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);
    if (!Number.isInteger(hostId) || hostId < 0) {
      return c.json({ ok: false, error: 'invalid_host_id' }, 400);
    }

    const ctx = await panelContext(c.env.DB, id);
    if (!ctx.ok) {
      if (ctx.status === 404) return c.json({ ok: false, error: 'not_found' }, 404);
      return c.json({ ok: false, error: 'panel_unavailable', detail: ctx.reason }, 400);
    }
    if (!ctx.adapter.deleteHost || !ctx.adapter.listHosts) {
      return c.json({ ok: false, error: 'unsupported', detail: 'این نوع پنل هاست ندارد.' }, 400);
    }

    const hosts = await ctx.adapter.listHosts(ctx.provider);
    if (!hosts.ok) {
      // Refusing rather than guessing. The guard below cannot run without this
      // listing, and deleting with the guard skipped is exactly the delete the
      // guard exists to stop.
      return c.json(
        {
          ok: false,
          error: 'panel_unavailable',
          detail: `فهرست هاست‌ها خوانده نشد، پس نمی‌دانیم حذفش چه چیزی را خالی می‌کند: ${hosts.reason}`,
        },
        400,
      );
    }
    const target = hosts.hosts.find((h) => h.id === hostId);
    if (target) {
      const survivors = hosts.hosts.filter(
        (h) => h.inboundTag === target.inboundTag && h.id !== hostId && !h.disabled,
      );
      if (survivors.length === 0) {
        const inUse = await groupIdsInUse(c.env.DB, id);
        const groups = ctx.adapter.listGroups
          ? await ctx.adapter.listGroups(ctx.provider)
          : { ok: false as const, reason: 'no group listing' };
        const stranded =
          groups.ok
            ? groups.groups.filter(
                (g) => inUse.has(g.id) && (g.inboundTags ?? []).includes(target.inboundTag),
              )
            : [];
        if (stranded.length > 0) {
          return c.json(
            {
              ok: false,
              error: 'host_in_use',
              detail: `این تنها هاستِ «${target.inboundTag}» است و گروه ${stranded
                .map((g) => `«${g.name}»`)
                .join('، ')} که می‌فروشیم روی همین اینباند است. با حذفش، مشتری‌های آن گروه بی‌سروصدا یک کانفیگ کمتر می‌گیرند. اول اینباند را از گروه بردارید.`,
            },
            409,
          );
        }
      }
    }

    const result = await ctx.adapter.deleteHost(ctx.provider, hostId);
    if (!result.ok) {
      return c.json({ ok: false, error: 'panel_refused', detail: result.reason }, 400);
    }

    await audit(
      c.env.DB,
      ident,
      'catalog.panel_host_deleted',
      'PROVISIONING_PROVIDER',
      String(id),
      { code: ctx.code, host: hostId, inbound: target?.inboundTag ?? null },
      null,
      null,
    );
    return c.json({ ok: true });
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

    const probe = await probePanel({
      id: unsaved ? 0 : id,
      name,
      kind,
      baseUrl,
      credentials,
    });
    return c.json({ ok: true, ...probeReply(probe) });
  });

  /**
   * Remove a panel — the button this screen did not have.
   *
   * The shop this is modelled on deletes unconditionally: it COUNTS the
   * services pointing at the panel, deletes anyway, and then reports «N سرویس
   * بدون پنل ماندند» after the fact (`legacy/faoxima/panel/panels.php:1219`).
   * On our schema that is worse than it sounds, because
   * `subscriptions.provider_id` is `ON DELETE SET NULL` — Postgres would not
   * even raise: every live subscription would quietly lose the panel it is
   * fulfilled from and nothing would look wrong until a renewal.
   *
   * So the guard is inside the DELETE, the same shape as `catalog.product`:
   * the count is only ever used to WORD the refusal, never to decide it. A
   * count-then-delete pair has a window between the two, and this is the one
   * table where that window costs a customer their service.
   */
  app.delete('/api/v1/admin/panels/:id', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const id = Number(c.req.param('id'));
    if (!Number.isInteger(id) || id <= 0) return c.json({ ok: false, error: 'invalid_id' }, 400);

    const before = await c.env.DB.prepare(`${SELECT_PANEL} WHERE pr.id = ?1`)
      .bind(id)
      .first<PanelRow>();
    if (!before) return c.json({ ok: false, error: 'not_found' }, 404);

    // `provider_secrets` and `discount_codes` cascade and are deliberately not
    // in this list: a sealed password and a discount code that named this panel
    // have no meaning once it is gone. Products, live subscriptions and stock
    // do, and each is a different conversation with the operator.
    const gone = await c.env.DB.prepare(
      `DELETE FROM provisioning_providers
        WHERE id = ?1
          AND NOT EXISTS (SELECT 1 FROM products p WHERE p.provider_id = ?1)
          AND NOT EXISTS (SELECT 1 FROM subscriptions s
                           WHERE s.provider_id = ?1
                             AND s.status IN ('ACTIVE', 'ON_HOLD'))
          AND NOT EXISTS (SELECT 1 FROM provisioning_stock st WHERE st.provider_id = ?1)
       RETURNING id`,
    )
      .bind(id)
      .first<{ id: number }>();

    if (!gone) {
      const refs = await c.env.DB.prepare(
        `SELECT (SELECT COUNT(*) FROM products p WHERE p.provider_id = ?1) AS products,
                (SELECT COUNT(*) FROM subscriptions s
                  WHERE s.provider_id = ?1
                    AND s.status IN ('ACTIVE', 'ON_HOLD')) AS subscriptions,
                (SELECT COUNT(*) FROM provisioning_stock st WHERE st.provider_id = ?1) AS stock`,
      )
        .bind(id)
        .first<{ products: number; subscriptions: number; stock: number }>();
      const counts = {
        products: Number(refs?.products ?? 0),
        subscriptions: Number(refs?.subscriptions ?? 0),
        stock: Number(refs?.stock ?? 0),
      };
      return c.json({ ok: false, error: 'in_use', detail: refusal(counts), counts }, 409);
    }

    await audit(
      c.env.DB,
      ident,
      'catalog.panel_deleted',
      'PROVIDER',
      String(id),
      { code: before.code, name: before.name, kind: before.kind, base_url: before.base_url },
      null,
      null,
    );

    // Nothing was touched on the panel itself. Deleting our row is a statement
    // about our catalogue, not about somebody else's server, and the accounts
    // already living there keep working.
    return c.json({ ok: true });
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

    const patch = body.data;

    let baseUrl: string | null | undefined = patch.baseUrl;
    if (baseUrl) {
      // The same helper create uses. Two normalisers would eventually store an
      // address the connection test never tried.
      const normalised = normalisePanelUrl(baseUrl);
      if ('error' in normalised) {
        return c.json({ ok: false, error: 'invalid_body', detail: normalised.error }, 400);
      }
      baseUrl = normalised.url;
    }
    if (baseUrl === '') baseUrl = null;

    /**
     * «وضعیت خودکار» — probe first, then write once.
     *
     * Deliberately a one-shot at save time, never a background sweep.
     * `panelContext` refuses to couple reads to `status` for a reason it spells
     * out: a panel that goes unreachable for ten minutes must not become a panel
     * an operator cannot get back. So an explicit `status` in the same patch
     * always wins, and the manual switch on the screen still works.
     *
     * `untestable` leaves the status alone entirely — a `manual` panel has
     * nothing to log into and is not broken for failing to answer.
     */
    let autoStatus: 'ACTIVE' | 'DISABLED' | null = null;
    let probe: PanelProbe | null = null;
    if (patch.autoStatus && patch.status === undefined) {
      const secret = await c.env.DB.prepare(
        `SELECT pr.secret_ref, ps.sealed
           FROM provisioning_providers pr
           LEFT JOIN provider_secrets ps ON ps.provider_id = pr.id
          WHERE pr.id = ?1`,
      )
        .bind(id)
        .first<{ secret_ref: string | null; sealed: string | null }>();
      let credentials: { username: string; password: string } | null = null;
      try {
        credentials = secret ? credentialFor(secret) : null;
      } catch {
        // A sealed row that will not open is a panel that cannot log in, which
        // is exactly what the auto status is asking about.
        credentials = null;
      }
      probe = await probePanel({
        id,
        name: before.name,
        kind: before.kind,
        baseUrl: baseUrl === undefined ? before.base_url : baseUrl,
        credentials,
      });
      if (probe.state === 'ok') autoStatus = 'ACTIVE';
      else if (probe.state !== 'untestable') autoStatus = 'DISABLED';
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const put = (column: string, value: unknown) => {
      params.push(value);
      sets.push(`${column} = ?${params.length}`);
    };
    if (patch.name !== undefined) put('name', patch.name);
    if (patch.status !== undefined) put('status', patch.status);
    else if (autoStatus !== null) put('status', autoStatus);
    if (patch.capacity !== undefined) put('capacity', patch.capacity);
    if (patch.sortOrder !== undefined) put('sort_order', patch.sortOrder);
    if (baseUrl !== undefined) put('base_url', baseUrl);

    // The two renewal keys, merged into `config` rather than replacing it —
    // `proxies` and the migrated group ids live in the same object and a
    // wholesale write would take them with it.
    const configPatch: Record<string, unknown> = {};
    if (patch.renewMode !== undefined) configPatch['renew_mode'] = patch.renewMode;
    if (patch.renewEnabled !== undefined) configPatch['renew_enabled'] = patch.renewEnabled;
    if (Object.keys(configPatch).length > 0) {
      params.push(JSON.stringify(configPatch));
      sets.push(`config = COALESCE(config, '{}'::jsonb) || ?${params.length}::jsonb`);
    }

    // A patch of only `autoStatus` on an untestable panel changes nothing, and
    // `SET , updated_at = now()` is a syntax error rather than a no-op.
    if (sets.length > 0) {
      params.push(id);
      await c.env.DB.prepare(
        `UPDATE provisioning_providers SET ${sets.join(', ')}, updated_at = now()
          WHERE id = ?${params.length}`,
      )
        .bind(...params)
        .run();
    }

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
        base_url: before.base_url,
        renew_mode: renewModeFor(before.config ?? {}),
        renew_enabled: renewAllowed(before.config ?? {}),
      },
      {
        name: after.name,
        status: after.status,
        capacity: after.capacity,
        sort_order: after.sort_order,
        base_url: after.base_url,
        renew_mode: renewModeFor(after.config ?? {}),
        renew_enabled: renewAllowed(after.config ?? {}),
      },
      null,
    );

    return c.json({
      ok: true,
      panel: shape(after),
      // Why the status moved, when it moved by itself. Without this the screen
      // can only say «غیرفعال شد» and the operator has to go and press «تست
      // اتصال» to find out what this call already knows.
      ...(probe === null ? {} : { probe: probeReply(probe) }),
      // The caller shows this before and after: disabling a panel that is
      // still fulfilling renewals is a decision, not a typo, but it should be
      // a decision made with the number in view.
      liveSubscriptions: Number(after.live_subscriptions),
    });
  });
}
