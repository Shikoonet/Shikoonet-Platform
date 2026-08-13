/**
 * Marzban — the only panel type in production.
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
 * Every panel is version 1 and every one is `offconecton`. So this file
 * implements one path — `group_ids` + `proxy_settings` + an absolute ISO
 * expiry — rather than porting branches nothing selects. The two `on_hold`
 * variants are not dead code we deleted; they are code we never wrote, and the
 * table above is why. If a panel ever arrives with different settings, that is
 * the moment to add the branch, with a row to point at.
 *
 * Credentials never come from the database. `provisioning_providers.secret_ref`
 * names them; the caller resolves them from the environment.
 */

import type {
  ProviderContext,
  ProvisionRequest,
  ProvisionResult,
  ProvisioningAdapter,
} from './types.js';

const GB = 1024 * 1024 * 1024;
/** Long enough for a panel under load, short enough that a sweep is not stuck. */
const TIMEOUT_MS = 20_000;

interface MarzbanUser {
  username?: unknown;
  subscription_url?: unknown;
  expire?: unknown;
  status?: unknown;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
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
    provider.fetch(`${provider.baseUrl!.replace(/\/+$/, '')}/api/user/${encodeURIComponent(username)}`, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal,
    }),
  );
  if (res.status === 404) return { state: 'missing' };
  if (!res.ok) return { state: 'failed', status: res.status };
  return { state: 'found', user: (await res.json()) as MarzbanUser };
}

/** 5xx is the panel having a bad day; 4xx is us asking for something wrong. */
function isPanelFault(status: number): boolean {
  return status >= 500;
}

/** Plan-level settings win over panel-level ones, same precedence as the legacy bot. */
function pick(request: ProvisionRequest, key: string): unknown {
  return request.planAttrs[key] ?? request.providerConfig[key];
}

export const marzbanAdapter: ProvisioningAdapter = {
  kind: 'marzban',

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
        return { ok: false, reason: 'panel reported a conflict for a user it does not have', retryable: true };
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
};
