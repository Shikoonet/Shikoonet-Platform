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
  AccountsResult,
  ProviderContext,
  ProvisionRequest,
  ProvisionResult,
  ProvisioningAdapter,
  RemoteAccount,
  RenewRequest,
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
async function login(provider: ProviderContext): Promise<{ token: string } | { error: string }> {
  if (!provider.baseUrl) return { error: 'panel has no base_url configured' };
  if (!provider.credentials) {
    return { error: `no credentials found for panel "${provider.name}" (secret_ref)` };
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
    return { error: `panel login failed (HTTP ${res.status})` };
  }
  const json = (await res.json()) as { access_token?: unknown };
  const token = asString(json.access_token);
  if (token === null) return { error: 'panel login returned no access_token' };
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
function pick(request: ProvisionRequest, key: string): unknown {
  return request.planAttrs[key] ?? request.providerConfig[key];
}

export const marzbanAdapter: ProvisioningAdapter = {
  kind: 'pasarguard',

  async provision(request: ProvisionRequest, provider: ProviderContext): Promise<ProvisionResult> {
    try {
      const auth = await login(provider);
      if ('error' in auth) return { ok: false, reason: auth.error, retryable: true };
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
      const groups = pick(request, 'group_ids') ?? pick(request, 'inbounds');
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
      if ('error' in auth) return { ok: false, reason: auth.error, retryable: true };
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
        expiresAtMs = addedMs === null ? null : anchor + addedMs;
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

      if (request.mode === 'RESET') {
        // Legacy resets before it modifies, and the order matters: zeroing after
        // the new quota is set would still be correct, but a failure between the
        // two would leave the customer with a new quota and last month's usage
        // already counted against it.
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
      }

      const res = await withTimeout((signal) =>
        provider.fetch(`${base}/api/user/${encodeURIComponent(request.username)}`, {
          method: 'PUT',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: `Bearer ${auth.token}`,
          },
          body: JSON.stringify({ data_limit: dataLimit, expire, note: request.note }),
          signal,
        }),
      );
      if (!res.ok) {
        return {
          ok: false,
          reason: `panel refused to extend the account (HTTP ${res.status})`,
          retryable: res.status >= 500,
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
};
