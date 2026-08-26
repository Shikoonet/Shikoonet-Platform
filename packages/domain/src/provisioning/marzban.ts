/**
 * PasarGuard — the only panel software in production, under Marzban's name.
 *
 * This file is called `marzban.ts` because the wire protocol descends from
 * Marzban's and the legacy driver is `Marzban.php`. The panels are not Marzban.
 * Mirzabot has no `pasarguard` type, so it files the admin's choice under the
 * Marzban name and records the truth in a second column —
 * `legacy/mirzabot-php/admin.php:749-750`:
 *
 *     $version_panel = $userdata['type'] == "pasarguard" ? "1" : "0";
 *     $userdata['type'] = $userdata['type'] == "pasarguard" ? "marzban" : ...;
 *
 * So `version 1` in the table below does not mean "an old Marzban". It means
 * PasarGuard, on every row. That is exactly why the branch this file
 * implements is the one that sends `group_ids` and `proxy_settings`.
 *
 * The legacy `Marzban.php:adduser` branches four ways: two API shapes
 * (`version_panel`) crossed with two expiry behaviours (`conecton`, plus a
 * third for test accounts). Reading the live `marzban_panel` rows collapses all
 * of that:
 *
 *     id  name                     status   version  conecton      sublink
 *      1  ...VIP                   active   1        offconecton   onsublink
 *      8  ...                      disable  1        offconecton   onsublink
 *     12  ...                      active   1        offconecton   onsublink
 *     13  ...                      active   1        offconecton   onsublink
 *     14  ...                      disable  1        offconecton   onsublink
 *
 * Every panel is version 1 — that is, PasarGuard — and every one is
 * `offconecton`. So this file implements one path — `group_ids` +
 * `proxy_settings` + an absolute ISO expiry — rather than porting branches
 * nothing selects. The two `on_hold`
 * variants are not dead code we deleted; they are code we never wrote, and the
 * table above is why. If a panel ever arrives with different settings, that is
 * the moment to add the branch, with a row to point at.
 *
 * Credentials never come from the database. `provisioning_providers.secret_ref`
 * names them; the caller resolves them from the environment.
 */

import type {
  AccountAction,
  AccountActionResult,
  AccountsResult,
  ProviderContext,
  ProvisionRequest,
  ProvisionResult,
  ProvisioningAdapter,
  RemoteAccount,
  RenewRequest,
  GroupsResult,
  GroupDeleteResult,
  GroupWriteResult,
  HostDeleteResult,
  HostWriteResult,
  HostsResult,
  InboundsResult,
  PanelGroup,
  PanelHost,
} from './types.js';

const GB = 1024 * 1024 * 1024;
/** Long enough for a panel under load, short enough that a sweep is not stuck. */
const TIMEOUT_MS = 20_000;

/** One page of the account listing. Marzban's own default is 50; the sweep runs
 *  every few minutes, so fewer, larger responses cost the panel less. */
const PAGE_SIZE = 500;
/**
 * ponytail: a hard ceiling on the listing rather than a cursor.
 *
 * The largest live panel holds a few thousand accounts, so this is roughly ten
 * times what exists. It is here so that a panel answering with a page that
 * never shrinks cannot spin the sweep forever. Raise it if a panel ever grows
 * past it — the log line below says so by name.
 */
const MAX_ACCOUNTS = 50_000;

interface MarzbanUser {
  username?: unknown;
  subscription_url?: unknown;
  expire?: unknown;
  status?: unknown;
  used_traffic?: unknown;
  data_limit?: unknown;
  note?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * A byte counter from a panel, or null.
 *
 * Everything is checked because this number is written to a column with a
 * `>= 0` CHECK and then subtracted from the customer's quota. A negative or
 * fractional `used_traffic` — both of which a panel mid-restart has been seen
 * to report — would either abort the whole sync batch on the constraint or
 * show a customer more volume than they bought.
 */
function asByteCount(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

/**
 * `subscription_url` comes back as a path (`/sub/<token>`) on some panels and
 * an absolute URL on others. The customer needs something they can tap.
 */
function absoluteSubUrl(raw: unknown, baseUrl: string): string | null {
  const value = asString(raw);
  if (value === null) return null;
  if (/^https?:\/\//i.test(value)) return value;
  return `${baseUrl.replace(/\/+$/, '')}/${value.replace(/^\/+/, '')}`;
}

async function withTimeout<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * A bearer token for this panel.
 *
 * Deliberately not cached. The legacy bot keeps the token in a database column
 * with a one-hour window, which means a token in a table that gets dumped and a
 * whole class of "why is it 401 for an hour" bugs. One extra request per
 * provisioning — an event that happens a few times an hour — is not worth
 * either.
 */
interface LoginFailed {
  error: string;
  /**
   * False when waiting cannot possibly help.
   *
   * The distinction is not cosmetic. A retryable failure sends the order back
   * to PAID and the sweep tries again forever; for a panel with no `base_url`
   * or no secret in the environment that is a customer who has been charged,
   * hears nothing, and waits on a loop that can never finish. Seen on the test
   * bot on 2026-08-13 after paying from the wallet: the money left the ledger
   * and the order sat at PAID in silence.
   *
   * Configuration cannot fix itself, so it goes to a person instead.
   */
  retryable: boolean;
}

async function login(provider: ProviderContext): Promise<{ token: string } | LoginFailed> {
  if (!provider.baseUrl) {
    return { error: 'panel has no base_url configured', retryable: false };
  }
  if (!provider.credentials) {
    return {
      error: `no credentials found for panel "${provider.name}" (secret_ref)`,
      retryable: false,
    };
  }
  const body = new URLSearchParams({
    username: provider.credentials.username,
    password: provider.credentials.password,
  });
  const res = await withTimeout((signal) =>
    provider.fetch(`${provider.baseUrl!.replace(/\/+$/, '')}/api/admin/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal,
    }),
  );
  if (!res.ok) {
    // The status is safe to report; the body may echo the credentials back.
    // A rejected login is wrong credentials, which is configuration; only the
    // panel being ill is worth trying again for.
    return {
      error: `panel login failed (HTTP ${res.status})`,
      retryable: isPanelFault(res.status),
    };
  }
  const json = (await res.json()) as { access_token?: unknown };
  const token = asString(json.access_token);
  if (token === null) return { error: 'panel login returned no access_token', retryable: true };
  return { token };
}

/**
 * Look the account up.
 *
 * Returns the status rather than throwing on a bad one. Throwing lumped every
 * failed read in with a network error and made it retryable — so a 403 from a
 * panel whose admin account lost permission would have been retried forever
 * instead of reaching a person. A read failure is classified exactly like a
 * write failure: the panel's problem is worth another pass, ours is not.
 */
type UserLookup =
  | { state: 'found'; user: MarzbanUser }
  | { state: 'missing' }
  | { state: 'failed'; status: number };

async function getUser(
  provider: ProviderContext,
  token: string,
  username: string,
): Promise<UserLookup> {
  const res = await withTimeout((signal) =>
    provider.fetch(
      `${provider.baseUrl!.replace(/\/+$/, '')}/api/user/${encodeURIComponent(username)}`,
      {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        signal,
      },
    ),
  );
  if (res.status === 404) return { state: 'missing' };
  if (!res.ok) return { state: 'failed', status: res.status };
  return { state: 'found', user: (await res.json()) as MarzbanUser };
}

/** 5xx is the panel having a bad day; 4xx is us asking for something wrong. */
function isPanelFault(status: number): boolean {
  return status >= 500;
}

/**
 * The account's current expiry, in epoch milliseconds, or null for unmetered.
 *
 * Marzban has reported this both ways across versions — a unix timestamp on the
 * older API and an ISO string on the newer one — and the same field is written
 * back as ISO by `provision`. Reading only one shape would silently treat the
 * other as "no expiry", which in ADD mode means renewing from today and
 * throwing away every day the customer had left.
 */
function expiryMs(raw: unknown): number | null {
  if (typeof raw === 'number') return raw > 0 ? raw * 1000 : null;
  if (typeof raw === 'string' && raw.length > 0) {
    // A numeric string is a timestamp; anything else is a date.
    if (/^\d+$/.test(raw)) {
      const seconds = Number(raw);
      return seconds > 0 ? seconds * 1000 : null;
    }
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** The account's current quota in bytes, or null when it is unmetered. */
function quotaBytes(raw: unknown): number | null {
  const n = asByteCount(raw);
  return n === null || n === 0 ? null : n;
}

/** Plan-level settings win over panel-level ones, same precedence as the legacy bot. */
function pick(
  request: { planAttrs: Record<string, unknown>; providerConfig: Record<string, unknown> },
  key: string,
): unknown {
  return request.planAttrs[key] ?? request.providerConfig[key];
}

/**
 * The `group_ids` a create would send for this plan, or undefined for none.
 *
 * Exported because the panel preflight has to answer the same question before
 * cutover, and answering it a second time is how the two answers drift apart.
 * `inbounds` is the legacy spelling the importer carried across; both are read
 * here so a caller never has to know which one a given row uses.
 *
 * This exists because of a real miss. The migrated configuration sends
 * `[42, 2]`, group 42 was deleted from the live panel some time after the
 * 2026-08-11 dump, and PasarGuard answers `404 "Group not found"` — which
 * `login`'s sibling classifies as non-retryable, so every VIP order would have
 * gone FAILED and refunded in front of the customer on the first day.
 */
export function groupIdsFor(request: {
  planAttrs: Record<string, unknown>;
  providerConfig: Record<string, unknown>;
}): unknown {
  return firstConfigured(
    request.planAttrs['group_ids'],
    request.providerConfig['group_ids'],
    request.planAttrs['inbounds'],
    request.providerConfig['inbounds'],
  );
}

/**
 * The first level that actually names a tier — where an EMPTY list is not one.
 *
 * `pick` used `??`, and `[]` is not nullish, so a service saved with no groups
 * shadowed the panel underneath it and the create body carried `group_ids: []`.
 * PasarGuard reads that as «this account belongs to no group», which strips
 * every inbound: the subscription link resolves, returns nothing, and the
 * customer who just paid has an account that cannot connect. `renew` has
 * refused to send an empty array since it was written (see the body it builds
 * below); this is the same rule on the create side, where it was missing.
 *
 * Measured on the test panel 2026-08-26: five of its thirteen accounts carry
 * `group_ids: []`. Absence is the only way to say «no opinion here», so an
 * empty list falls through to the next level, and all four levels empty answers
 * `undefined` — which omits the key entirely.
 */
function firstConfigured(...levels: unknown[]): unknown {
  for (const value of levels) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return value;
  }
  return undefined;
}

/**
 * Which inbound tags currently carry an enabled host.
 *
 * Two callers need this and they must not disagree, because the number it
 * produces is the one an operator builds a price tier on. Null — never an empty
 * set — when the listing could not be read: an empty set would report every
 * inbound as delivering nothing, which is the loudest possible way to be wrong
 * about a panel that is merely slow.
 */
async function hostedTags(
  provider: ProviderContext,
  base: string,
  token: string,
): Promise<Set<string> | null> {
  try {
    const res = await withTimeout((signal) =>
      (provider.fetch ?? fetch)(`${base}/api/hosts`, {
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        signal,
      }),
    );
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (!Array.isArray(body)) return null;
    return new Set(
      body
        .map(toHost)
        .filter((h): h is PanelHost => h !== null && !h.disabled)
        .map((h) => h.inboundTag),
    );
  } catch {
    return null;
  }
}

/** One group row from the panel, in our shape. Null when it has no usable id. */
function toGroup(item: unknown, hosted: Set<string> | null): PanelGroup | null {
  const row = item as {
    id?: unknown;
    name?: unknown;
    total_users?: unknown;
    inbound_tags?: unknown;
    is_disabled?: unknown;
  };
  if (typeof row.id !== 'number') return null;
  const tags = Array.isArray(row.inbound_tags)
    ? row.inbound_tags.filter((t): t is string => typeof t === 'string')
    : [];
  return {
    id: row.id,
    // A group with no name still has to be pickable, and its id is the only
    // thing that identifies it either way.
    name: typeof row.name === 'string' && row.name !== '' ? row.name : `#${row.id}`,
    ...(typeof row.total_users === 'number' ? { memberCount: row.total_users } : {}),
    ...(tags.length > 0 ? { inboundTags: tags } : {}),
    ...(hosted === null ? {} : { deliverableInbounds: tags.filter((t) => hosted.has(t)).length }),
    ...(typeof row.is_disabled === 'boolean' ? { disabled: row.is_disabled } : {}),
  };
}

/**
 * A write against `/api/group`, with the reply read back rather than assumed.
 *
 * Shared by create and update because the two differ only in verb and path, and
 * the part that is easy to get wrong — parsing the reply instead of echoing the
 * request — must be identical in both. The panel is the authority on what a
 * group ended up being: it is the thing that would silently drop an inbound tag
 * it does not know.
 */
async function writeGroup(
  provider: ProviderContext,
  method: 'POST' | 'PUT',
  path: string,
  spec: { name: string; inboundTags: string[] },
): Promise<GroupWriteResult> {
  try {
    const auth = await login(provider);
    if ('error' in auth) return { ok: false, reason: auth.error };
    const base = provider.baseUrl!.replace(/\/+$/, '');
    const res = await withTimeout((signal) =>
      (provider.fetch ?? fetch)(`${base}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${auth.token}`,
        },
        // `inbound_tags` is required and `name` is required even on the update:
        // `PUT /api/group/{id}` with `{is_disabled: true}` alone answers 422
        // «name Field required». Measured 2026-08-23, and the reason this takes
        // a whole spec rather than a patch.
        body: JSON.stringify({ name: spec.name, inbound_tags: spec.inboundTags }),
        signal,
      }),
    );
    if (!res.ok) {
      // The status and the panel's own `detail`, which is a validation message
      // («Group already exists», «Inbound not found») and not an echo of what
      // was submitted. Nothing else from the body: a rejected request repeats
      // the credentials back in some deployments, and this reaches a browser.
      let detail = '';
      try {
        const body: unknown = await res.json();
        const d = (body as { detail?: unknown }).detail;
        if (typeof d === 'string') detail = ` — ${d}`;
      } catch {
        detail = '';
      }
      return { ok: false, reason: `panel refused the group (HTTP ${res.status})${detail}` };
    }
    const hosted = await hostedTags(provider, base, auth.token);
    const group = toGroup(await res.json(), hosted);
    if (group === null) return { ok: false, reason: 'the panel replied without a group id' };
    return { ok: true, group };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `could not reach the panel: ${reason}` };
  }
}

/** One host row from the panel, in our shape. Null when it has no usable id. */
function toHost(item: unknown): PanelHost | null {
  const row = item as {
    id?: unknown;
    remark?: unknown;
    inbound_tag?: unknown;
    address?: unknown;
    is_disabled?: unknown;
  };
  if (typeof row.id !== 'number') return null;
  if (typeof row.inbound_tag !== 'string') return null;
  return {
    id: row.id,
    remark: typeof row.remark === 'string' && row.remark !== '' ? row.remark : `#${row.id}`,
    inboundTag: row.inbound_tag,
    addresses: Array.isArray(row.address)
      ? row.address.filter((a): a is string => typeof a === 'string')
      : [],
    disabled: row.is_disabled === true,
  };
}

export const marzbanAdapter: ProvisioningAdapter = {
  kind: 'pasarguard',

  async provision(request: ProvisionRequest, provider: ProviderContext): Promise<ProvisionResult> {
    try {
      const auth = await login(provider);
      if ('error' in auth) return { ok: false, reason: auth.error, retryable: auth.retryable };
      const base = provider.baseUrl!.replace(/\/+$/, '');

      // Look first. The username is derived from the order, so a sweep that
      // already created this account and then died before writing the row finds
      // it here instead of colliding.
      const existing = await getUser(provider, auth.token, request.username);
      if (existing.state === 'failed') {
        return {
          ok: false,
          reason: `panel would not answer for this account (HTTP ${existing.status})`,
          retryable: isPanelFault(existing.status),
        };
      }
      if (existing.state === 'found') {
        return {
          ok: true,
          remoteUsername: request.username,
          remoteRef: { panel: provider.code, username: request.username },
          subscriptionUrl: absoluteSubUrl(existing.user.subscription_url, base),
          alreadyExisted: true,
        };
      }

      const body: Record<string, unknown> = {
        username: request.username,
        // A plan with no volume is unmetered, which Marzban spells as 0.
        data_limit: request.volumeGb === null ? 0 : Math.round(request.volumeGb * GB),
        // Absolute expiry: every production panel is `offconecton`, so an
        // account starts running the moment it exists.
        expire: request.expiresAt === null ? 0 : request.expiresAt.toISOString(),
        note: request.note,
        data_limit_reset_strategy: pick(request, 'data_limit_reset_strategy') ?? 'no_reset',
      };
      const proxySettings = pick(request, 'proxy_settings') ?? pick(request, 'proxies');
      if (proxySettings !== undefined) body['proxy_settings'] = proxySettings;
      const groups = groupIdsFor(request);
      if (groups !== undefined) body['group_ids'] = groups;

      const res = await withTimeout((signal) =>
        provider.fetch(`${base}/api/user`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${auth.token}`,
          },
          body: JSON.stringify(body),
          signal,
        }),
      );

      if (res.status === 409) {
        // Created by a racing sweep between our read and our write. Read it back
        // rather than reporting a failure over an account that exists.
        const raced = await getUser(provider, auth.token, request.username);
        if (raced.state === 'found') {
          return {
            ok: true,
            remoteUsername: request.username,
            remoteRef: { panel: provider.code, username: request.username },
            subscriptionUrl: absoluteSubUrl(raced.user.subscription_url, base),
            alreadyExisted: true,
          };
        }
        return {
          ok: false,
          reason: 'panel reported a conflict for a user it does not have',
          retryable: true,
        };
      }

      if (!res.ok) {
        return {
          ok: false,
          reason: `panel refused to create the account (HTTP ${res.status})`,
          // 4xx is our request being wrong — a wrong inbound id, a bad plan.
          // Repeating it changes nothing until a human edits something.
          retryable: res.status >= 500,
        };
      }

      const created = (await res.json()) as MarzbanUser;
      return {
        ok: true,
        remoteUsername: asString(created.username) ?? request.username,
        remoteRef: { panel: provider.code, username: request.username },
        subscriptionUrl: absoluteSubUrl(created.subscription_url, base),
        alreadyExisted: false,
      };
    } catch (error) {
      // A timeout, a DNS failure, a panel that is down. All worth another pass;
      // none worth losing the order over.
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `could not reach the panel: ${reason}`, retryable: true };
    }
  },

  /**
   * Extend an account that is already on the panel.
   *
   * Unlike `provision`, the operation is not naturally idempotent — in ADD mode
   * a second attempt adds a second month. The retry window is real: the sweep
   * returns an order to PAID on a timeout, and a timeout is exactly the case
   * where the panel may have applied the change and lost the answer.
   *
   * So the order's own id is written into the account's `note` in the same
   * request that applies the change. A retry reads it back first and stops. The
   * note is ours — `provision` already writes `shikoo <order>` into it, and it
   * is what the admin reads in the panel to see where an account came from.
   */
  async renew(request: RenewRequest, provider: ProviderContext): Promise<ProvisionResult> {
    try {
      const auth = await login(provider);
      if ('error' in auth) return { ok: false, reason: auth.error, retryable: auth.retryable };
      const base = provider.baseUrl!.replace(/\/+$/, '');

      const found = await getUser(provider, auth.token, request.username);
      if (found.state === 'failed') {
        return {
          ok: false,
          reason: `panel would not answer for this account (HTTP ${found.status})`,
          retryable: isPanelFault(found.status),
        };
      }
      if (found.state === 'missing') {
        // Renewing something that is not there cannot be fixed by trying again.
        // The customer has paid, so this has to reach a person.
        return {
          ok: false,
          reason: `account "${request.username}" is no longer on the panel`,
          retryable: false,
        };
      }

      const already = asString(found.user.note)?.includes(request.note) ?? false;
      if (already) {
        const currentQuota = quotaBytes(found.user.data_limit);
        const currentExpiry = expiryMs(found.user.expire);
        return {
          ok: true,
          remoteUsername: request.username,
          remoteRef: { panel: provider.code, username: request.username },
          subscriptionUrl: absoluteSubUrl(found.user.subscription_url, base),
          alreadyExisted: true,
          expiresAt: currentExpiry === null ? null : new Date(currentExpiry),
          volumeGb: currentQuota === null ? null : currentQuota / GB,
        };
      }

      const addedBytes = request.volumeGb === null ? null : Math.round(request.volumeGb * GB);
      const addedMs = request.durationDays === null ? null : request.durationDays * 86_400_000;
      const from = request.renewFrom.getTime();

      let dataLimit: number;
      let expiresAtMs: number | null;
      if (request.mode === 'ADD') {
        // Measured from whatever time is left, so renewing early keeps the days
        // already paid for. `time() - expire > 0 ? time() : expire` in the PHP.
        const current = expiryMs(found.user.expire);
        const anchor = current !== null && current > from ? current : from;
        // Zero means "add nothing here", which is NOT what null means. Null is
        // "no limit", and the two part company on an unmetered account: an
        // extra-volume purchase adds no days, and `anchor + 0` would stamp
        // today's date on a service that had no expiry at all — killing it.
        expiresAtMs = addedMs === null ? null : addedMs === 0 ? current : anchor + addedMs;
        const currentQuota = quotaBytes(found.user.data_limit);
        // Adding to an unmetered account, or adding unmetered volume, leaves it
        // unmetered — anything else would put a cap on a service that had none.
        dataLimit = addedBytes === null || currentQuota === null ? 0 : currentQuota + addedBytes;
      } else {
        expiresAtMs = addedMs === null ? null : from + addedMs;
        dataLimit = addedBytes ?? 0;
      }
      // Seconds, not ISO — and the difference is not ours to choose. The live
      // PHP writes this field two different ways against these same five
      // panels, and which one depends on the OPERATION, not on the panel:
      //
      //   create  Marzban.php:242     date('c', $ts)   ISO-8601
      //   extend  panels.php:1958     $time_new        unix seconds
      //
      // `provision` above matches the first because it is a create. This is an
      // extend, so it matches the second. Both shapes are proven against the
      // production panels every day; picking one for both would be replacing
      // evidence with a preference.
      const expire = expiresAtMs === null ? 0 : Math.floor(expiresAtMs / 1000);

      // What has already happened to this account by the time something fails.
      //
      // A renewal is two calls and only the pair means anything. The order
      // below is deliberate and stays: resetting after the new quota is set
      // would leave the customer with a new quota and last month's usage
      // counted against it, which is the wrong way to be wrong. Being wrong
      // this way gives them a free refill instead — bounded, and in the
      // customer's favour — but it is still a thing that happened, and the only
      // record of it used to be that the order said FAILED.
      const applied: string[] = [];

      if (request.mode === 'RESET') {
        const reset = await withTimeout((signal) =>
          provider.fetch(`${base}/api/user/${encodeURIComponent(request.username)}/reset`, {
            method: 'POST',
            headers: { accept: 'application/json', authorization: `Bearer ${auth.token}` },
            signal,
          }),
        );
        if (!reset.ok) {
          return {
            ok: false,
            reason: `panel would not reset the usage counter (HTTP ${reset.status})`,
            retryable: isPanelFault(reset.status),
          };
        }
        // Past this line the account has changed, whatever happens next.
        applied.push('usage counter reset to zero');
      }

      const res = await withTimeout((signal) =>
        provider.fetch(`${base}/api/user/${encodeURIComponent(request.username)}`, {
          method: 'PUT',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${auth.token}`,
          },
          /*
           * `group_ids` goes with a renewal, and NEVER an empty array.
           *
           * Sending `[]` to PasarGuard is not "leave them alone" — it is "this
           * account belongs to no group", which strips every inbound and kills
           * the subscription silently: the link still resolves and returns
           * nothing. Absent is the way to say "leave them alone", so the key is
           * omitted rather than sent empty.
           *
           * The caller supplies this only for a real renewal. An add-on buys no
           * tier, and `mode` cannot be used to tell the two apart because
           * `renewModeFor` answers 'ADD' for ordinary renewals in some shops.
           */
          body: JSON.stringify({
            data_limit: dataLimit,
            expire,
            note: request.note,
            ...(Array.isArray(request.groupIds) && request.groupIds.length > 0
              ? { group_ids: request.groupIds }
              : {}),
          }),
          signal,
        }),
      );
      if (!res.ok) {
        return {
          ok: false,
          reason: `panel refused to extend the account (HTTP ${res.status})`,
          retryable: res.status >= 500,
          applied,
        };
      }

      const updated = (await res.json()) as MarzbanUser;
      return {
        ok: true,
        remoteUsername: asString(updated.username) ?? request.username,
        remoteRef: { panel: provider.code, username: request.username },
        subscriptionUrl:
          absoluteSubUrl(updated.subscription_url, base) ??
          absoluteSubUrl(found.user.subscription_url, base),
        alreadyExisted: false,
        // What was asked for, not what came back: a panel that echoes the
        // request is agreeing, and a panel that echoes something else has
        // already been accepted by the `res.ok` above.
        expiresAt: expiresAtMs === null ? null : new Date(expiresAtMs),
        volumeGb: dataLimit === 0 ? null : dataLimit / GB,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `could not reach the panel: ${reason}`, retryable: true };
    }
  },

  /**
   * `GET /api/groups`, which is the only place the truth about a group id lives.
   *
   * Moved here from `apps/bot/scripts/panel-preflight.ts`, which had its own
   * copy: two implementations of "what groups does this panel have" is exactly
   * the drift `groupIdsFor` was extracted to avoid on the other side of the same
   * question.
   *
   * Both response shapes are accepted because both are real — PasarGuard answers
   * `{groups: [...]}` and older builds answer a bare array. A body that is
   * neither is an error rather than an empty list: reporting "no groups" for
   * "could not read the answer" would send an operator to delete configuration
   * that was correct.
   */
  async listGroups(provider: ProviderContext): Promise<GroupsResult> {
    try {
      const auth = await login(provider);
      if ('error' in auth) return { ok: false, reason: auth.error };
      const base = provider.baseUrl!.replace(/\/+$/, '');
      const res = await withTimeout((signal) =>
        (provider.fetch ?? fetch)(`${base}/api/groups`, {
          headers: { accept: 'application/json', authorization: `Bearer ${auth.token}` },
          signal,
        }),
      );
      // The status only, never the body: a rejected request echoes the
      // submitted credentials back in some deployments, and this reaches a
      // browser.
      if (!res.ok) return { ok: false, reason: `could not list groups (HTTP ${res.status})` };

      const body: unknown = await res.json();
      const list = Array.isArray(body)
        ? body
        : Array.isArray((body as { groups?: unknown }).groups)
          ? (body as { groups: unknown[] }).groups
          : null;
      if (list === null) {
        return { ok: false, reason: 'the group listing was neither a list nor {groups: [...]}' };
      }

      // Two calls, and the second is worth it: without it this reports the
      // inbound count, which is the number an operator would reasonably read as
      // "how much the customer gets" and is not. A failure there is not fatal —
      // the groups are still the answer and the deliverable count is absent.
      const hosted = await hostedTags(provider, base, auth.token);

      const groups: PanelGroup[] = [];
      for (const item of list) {
        const group = toGroup(item, hosted);
        if (group !== null) groups.push(group);
      }
      return { ok: true, groups };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `could not reach the panel: ${reason}` };
    }
  },

  /**
   * `GET /api/inbounds`, which answers a bare array of tag strings.
   *
   * Not derived from `listGroups`: an inbound no group uses yet is invisible
   * there, and it is exactly the one somebody is hunting for when they build a
   * new tier. `hosted` comes from the same host listing the group counts use,
   * so the two screens cannot disagree about which inbound delivers.
   */
  async listInbounds(provider: ProviderContext): Promise<InboundsResult> {
    try {
      const auth = await login(provider);
      if ('error' in auth) return { ok: false, reason: auth.error };
      const base = provider.baseUrl!.replace(/\/+$/, '');
      const res = await withTimeout((signal) =>
        (provider.fetch ?? fetch)(`${base}/api/inbounds`, {
          headers: { accept: 'application/json', authorization: `Bearer ${auth.token}` },
          signal,
        }),
      );
      if (!res.ok) return { ok: false, reason: `could not list inbounds (HTTP ${res.status})` };

      const body: unknown = await res.json();
      // A bare array of strings on PasarGuard 5.2.1, measured. `{inbounds: []}`
      // is accepted too rather than guessed at, on the same reasoning as the
      // group listing: a shape we cannot read is an error, never an empty list,
      // because "this panel has no inbounds" sends an operator to build a tier
      // out of nothing.
      const list = Array.isArray(body)
        ? body
        : Array.isArray((body as { inbounds?: unknown }).inbounds)
          ? (body as { inbounds: unknown[] }).inbounds
          : null;
      if (list === null) {
        return { ok: false, reason: 'the inbound listing was neither a list nor {inbounds: [...]}' };
      }

      const hosted = await hostedTags(provider, base, auth.token);
      const inbounds = list
        .map((item) =>
          typeof item === 'string' ? item : asString((item as { tag?: unknown }).tag),
        )
        .filter((tag): tag is string => tag !== null && tag !== '')
        .map((tag) => ({ tag, ...(hosted === null ? {} : { hosted: hosted.has(tag) }) }));
      return { ok: true, inbounds };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `could not reach the panel: ${reason}` };
    }
  },

  /**
   * `POST /api/group` — singular.
   *
   * The plural answers `405 Method Not Allowed`, which is not a shape anyone
   * would guess from `GET /api/groups` two lines above. Measured 2026-08-23.
   */
  createGroup(
    provider: ProviderContext,
    spec: { name: string; inboundTags: string[] },
  ): Promise<GroupWriteResult> {
    return writeGroup(provider, 'POST', '/api/group', spec);
  },

  updateGroup(
    provider: ProviderContext,
    id: number,
    spec: { name: string; inboundTags: string[] },
  ): Promise<GroupWriteResult> {
    return writeGroup(provider, 'PUT', `/api/group/${encodeURIComponent(String(id))}`, spec);
  },

  /**
   * `DELETE /api/group/{id}` — answers 204 with no body.
   *
   * The panel deletes it whether or not accounts are in it, and does not say
   * how many were. Whatever guard belongs in front of that belongs in the
   * caller, which is the only layer that knows what our own catalog still
   * sends.
   */
  async deleteGroup(provider: ProviderContext, id: number): Promise<GroupDeleteResult> {
    try {
      const auth = await login(provider);
      if ('error' in auth) return { ok: false, reason: auth.error };
      const base = provider.baseUrl!.replace(/\/+$/, '');
      const res = await withTimeout((signal) =>
        (provider.fetch ?? fetch)(`${base}/api/group/${encodeURIComponent(String(id))}`, {
          method: 'DELETE',
          headers: { accept: 'application/json', authorization: `Bearer ${auth.token}` },
          signal,
        }),
      );
      // 404 is success for a delete: the group is not there, which is what was
      // asked for. Reporting it as a failure would leave an operator retrying a
      // button that already worked.
      if (!res.ok && res.status !== 404) {
        return { ok: false, reason: `panel refused the delete (HTTP ${res.status})` };
      }
      return { ok: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `could not reach the panel: ${reason}` };
    }
  },

  async listHosts(provider: ProviderContext): Promise<HostsResult> {
    try {
      const auth = await login(provider);
      if ('error' in auth) return { ok: false, reason: auth.error };
      const base = provider.baseUrl!.replace(/\/+$/, '');
      const res = await withTimeout((signal) =>
        (provider.fetch ?? fetch)(`${base}/api/hosts`, {
          headers: { accept: 'application/json', authorization: `Bearer ${auth.token}` },
          signal,
        }),
      );
      if (!res.ok) return { ok: false, reason: `could not list hosts (HTTP ${res.status})` };
      const body: unknown = await res.json();
      if (!Array.isArray(body)) {
        return { ok: false, reason: 'the host listing was not a list' };
      }
      const hosts: PanelHost[] = [];
      for (const item of body) {
        const host = toHost(item);
        if (host !== null) hosts.push(host);
      }
      return { ok: true, hosts };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `could not reach the panel: ${reason}` };
    }
  },

  /**
   * `POST /api/host/` — with the TRAILING SLASH.
   *
   * Without it the panel answers `307` and the redirect drops the body, so the
   * call looks like it worked and creates nothing. Measured, along with the two
   * required fields nobody would guess: `priority`, which is not optional and
   * is not in any example, and `address`, which must be a LIST — a bare string
   * answers «Input should be a valid set».
   *
   * An unknown inbound tag is `400 "<tag> not found"`, which is the panel
   * telling us the tier would have been empty. Passed through.
   */
  async createHost(
    provider: ProviderContext,
    spec: { remark: string; inboundTag: string; addresses: string[] },
  ): Promise<HostWriteResult> {
    try {
      const auth = await login(provider);
      if ('error' in auth) return { ok: false, reason: auth.error };
      const base = provider.baseUrl!.replace(/\/+$/, '');
      const res = await withTimeout((signal) =>
        (provider.fetch ?? fetch)(`${base}/api/host/`, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${auth.token}`,
          },
          body: JSON.stringify({
            remark: spec.remark,
            inbound_tag: spec.inboundTag,
            address: spec.addresses,
            // Required, and deliberately not asked for on screen: somebody
            // adding an address for a tier has no opinion about it, and 0 is
            // what every existing host on the live panel carries.
            priority: 0,
          }),
          signal,
        }),
      );
      if (!res.ok) {
        let detail = '';
        try {
          const body: unknown = await res.json();
          const d = (body as { detail?: unknown }).detail;
          if (typeof d === 'string') detail = ` — ${d}`;
        } catch {
          detail = '';
        }
        return { ok: false, reason: `panel refused the host (HTTP ${res.status})${detail}` };
      }
      const host = toHost(await res.json());
      if (host === null) return { ok: false, reason: 'the panel replied without a host id' };
      return { ok: true, host };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `could not reach the panel: ${reason}` };
    }
  },

  async deleteHost(provider: ProviderContext, id: number): Promise<HostDeleteResult> {
    try {
      const auth = await login(provider);
      if ('error' in auth) return { ok: false, reason: auth.error };
      const base = provider.baseUrl!.replace(/\/+$/, '');
      const res = await withTimeout((signal) =>
        (provider.fetch ?? fetch)(`${base}/api/host/${encodeURIComponent(String(id))}`, {
          method: 'DELETE',
          headers: { accept: 'application/json', authorization: `Bearer ${auth.token}` },
          signal,
        }),
      );
      // 404 is the state that was asked for, same as a group delete.
      if (!res.ok && res.status !== 404) {
        return { ok: false, reason: `panel refused the delete (HTTP ${res.status})` };
      }
      return { ok: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `could not reach the panel: ${reason}` };
    }
  },

  async listAccounts(provider: ProviderContext): Promise<AccountsResult> {
    try {
      const auth = await login(provider);
      if ('error' in auth) return { ok: false, reason: auth.error };
      const base = provider.baseUrl!.replace(/\/+$/, '');

      const accounts: RemoteAccount[] = [];
      for (let offset = 0; offset < MAX_ACCOUNTS; offset += PAGE_SIZE) {
        const res = await withTimeout((signal) =>
          provider.fetch(`${base}/api/users?offset=${offset}&limit=${PAGE_SIZE}`, {
            method: 'GET',
            headers: { accept: 'application/json', authorization: `Bearer ${auth.token}` },
            signal,
          }),
        );
        if (!res.ok)
          return { ok: false, reason: `panel would not list accounts (HTTP ${res.status})` };

        const json = (await res.json()) as { users?: unknown };
        const page = Array.isArray(json.users) ? (json.users as MarzbanUser[]) : [];
        for (const user of page) {
          const username = asString(user.username);
          // An account with no name cannot be matched to a subscription, so it
          // is not an account as far as this sweep is concerned.
          if (username === null) continue;
          accounts.push({
            username,
            usedBytes: asByteCount(user.used_traffic),
            subscriptionUrl: absoluteSubUrl(user.subscription_url, base),
          });
        }
        // A short page is the last page. Trusting `total` instead would mean
        // trusting a number to agree with the array beside it.
        if (page.length < PAGE_SIZE) return { ok: true, accounts };
      }
      // Hit the ceiling. Reporting what was read beats reporting nothing, and
      // the log line is what says the ceiling needs raising.
      console.error(
        `[marzban] panel ${provider.code} has more than ${MAX_ACCOUNTS} accounts; the rest were not synced`,
      );
      return { ok: true, accounts };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `could not reach the panel: ${reason}` };
    }
  },

  /**
   * The two things a customer may do to their own account.
   *
   * Both endpoints come from the live PHP rather than from a reading of the
   * panel's docs, which are switched off on our panel:
   *
   *   revoke   Marzban.php:197      POST /api/user/{u}/revoke_sub
   *   on/off   panels.php:1659-1666 PUT  /api/user/{u}  {"status": …}
   *
   * The status is sent, never toggled from what we last saw. A toggle computed
   * here would turn an account back on because our copy of its state was stale.
   */
  async act(action: AccountAction, provider: ProviderContext): Promise<AccountActionResult> {
    try {
      if (!provider.baseUrl) {
        return { ok: false, reason: 'this panel has no address configured', retryable: false };
      }
      const auth = await login(provider);
      if ('error' in auth) return { ok: false, reason: auth.error, retryable: auth.retryable };
      const base = provider.baseUrl.replace(/\/+$/, '');
      const user = encodeURIComponent(action.username);

      const res = await withTimeout((signal) =>
        action.kind === 'REVOKE_SUB'
          ? provider.fetch(`${base}/api/user/${user}/revoke_sub`, {
              method: 'POST',
              headers: { accept: 'application/json', authorization: `Bearer ${auth.token}` },
              signal,
            })
          : provider.fetch(`${base}/api/user/${user}`, {
              method: 'PUT',
              headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                authorization: `Bearer ${auth.token}`,
              },
              body: JSON.stringify({ status: action.enabled ? 'active' : 'disabled' }),
              signal,
            }),
      );
      // 404 is not "try later": the account is not there, and a customer who is
      // shown "we will retry" for a service that does not exist is being lied to.
      if (res.status === 404) {
        return { ok: false, reason: 'the panel does not know this account', retryable: false };
      }
      if (!res.ok) {
        return {
          ok: false,
          reason: `panel refused the change (HTTP ${res.status})`,
          retryable: isPanelFault(res.status),
        };
      }

      const updated = (await res.json()) as MarzbanUser;
      const status = asString((updated as { status?: unknown }).status);
      return {
        ok: true,
        // Only a revoke replaces the link. On a status change the panel echoes
        // the same one, and storing it again would be a write that says nothing.
        ...(action.kind === 'REVOKE_SUB'
          ? { subscriptionUrl: absoluteSubUrl(updated.subscription_url, base) }
          : {}),
        // What the panel says it is now — not what we asked for. If it refused
        // quietly, this is where that shows.
        ...(status === null ? {} : { enabled: status === 'active' }),
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { ok: false, reason: `could not reach the panel: ${reason}`, retryable: true };
    }
  },
};
