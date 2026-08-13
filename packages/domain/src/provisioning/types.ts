/**
 * The one interface every kind of thing we sell is delivered through.
 *
 * Mirzabot has no such seam: `marzban_panel` is 43 VPN-specific columns and
 * every panel type is a separate top-level PHP file that `index.php` branches
 * into. Selling something that is not a VPN means widening that table.
 *
 * Here the order, the wallet, the invoice and the payment verification never
 * learn what was sold. They hand a request to an adapter chosen by
 * `provisioning_providers.kind` and store whatever handle comes back in
 * `subscriptions.remote_ref`. Adding Spotify is a new file in this directory.
 *
 * `provision` and `listAccounts` exist. `revoke` is named in the plan and is
 * not declared here — an unimplemented branch per adapter buys nothing until
 * something calls it.
 */

/** What the customer bought, flattened so an adapter needs no SQL. */
export interface ProvisionRequest {
  /**
   * The remote account name. Deterministic, derived from the order — see
   * `remoteUsernameFor`. That is what makes retrying safe.
   */
  username: string;
  /** NULL means unmetered. */
  volumeGb: number | null;
  /** NULL means no expiry. */
  durationDays: number | null;
  /** Shown in the panel so a human can tell where an account came from. */
  note: string;
  /** `provisioning_providers.config` — inbounds, proxies, panel quirks. */
  providerConfig: Record<string, unknown>;
  /** `product_plans.attrs` — per-plan overrides of the above. */
  planAttrs: Record<string, unknown>;
  /** Absolute expiry, resolved by the caller so the adapter has no clock. */
  expiresAt: Date | null;
}

export interface ProvisionOk {
  ok: true;
  /** Goes to `subscriptions.remote_username`. */
  remoteUsername: string;
  /**
   * Goes to `subscriptions.remote_ref`. Adapter-owned; nothing outside the
   * adapter that wrote it may interpret its keys.
   */
  remoteRef: Record<string, unknown>;
  /** What the customer is actually given. NULL when there is nothing to link. */
  subscriptionUrl: string | null;
  /**
   * True when the account was already there and this call found it rather than
   * created it. A retry after a timeout is the normal way to see this, and it
   * must not be treated as a failure.
   */
  alreadyExisted: boolean;
}

export interface ProvisionFailed {
  ok: false;
  /** Stored in `orders.failure_reason`, so it is read by a human. Never a stack. */
  reason: string;
  /**
   * Whether trying again could plausibly work. A refused password is not
   * retryable; a timeout is. The sweep uses this to decide between leaving the
   * order for the next pass and stopping to wait for a person.
   */
  retryable: boolean;
}

export type ProvisionResult = ProvisionOk | ProvisionFailed;

/**
 * One remote account as the provider currently sees it.
 *
 * Deliberately three fields and not the panel's whole user object. Everything
 * else the panel knows — status, expiry, inbounds — is either ours to decide or
 * cannot be mapped without guessing, and a sync that guesses is a sync that can
 * mark a paid service dead because a panel had a bad minute.
 */
export interface RemoteAccount {
  username: string;
  /** Bytes consumed. NULL when the provider does not count. */
  usedBytes: number | null;
  /** Absolute, tappable. NULL when this provider hands out no link. */
  subscriptionUrl: string | null;
}

export type AccountsResult =
  | { ok: true; accounts: RemoteAccount[] }
  | { ok: false; reason: string };

export interface ProvisioningAdapter {
  readonly kind: string;
  /**
   * Create the thing, or return the one that is already there under this
   * username. Must be safe to call twice with the same request — the sweep
   * that calls it can be interrupted at any point and will call again.
   */
  provision(request: ProvisionRequest, provider: ProviderContext): Promise<ProvisionResult>;
  /**
   * Every account this provider holds, for the sweep that refreshes what the
   * customer sees.
   *
   * Optional, and bulk on purpose. Mirzabot asks the panel about one account
   * every time anyone opens a service screen; with 3,139 live services that is
   * a panel request per glance. One listing per panel per sweep is the same
   * information for a thousandth of the traffic.
   *
   * An adapter with nothing to report — `manual` — simply does not have this,
   * and the sweep skips it rather than being told an empty list.
   */
  listAccounts?(provider: ProviderContext): Promise<AccountsResult>;
}

/** Everything about the provider except its secrets. */
export interface ProviderContext {
  id: number;
  code: string;
  name: string;
  baseUrl: string | null;
  /**
   * Resolved credentials, looked up from the environment by `secret_ref` —
   * never read out of the database. `provisioning_providers` stays safe to
   * dump, log and hand to a support agent, which is why the column holds a
   * name and not a password.
   */
  credentials: { username: string; password: string } | null;
  config: Record<string, unknown>;
  /** Injected so tests do not reach the network and never need a real panel. */
  fetch: typeof globalThis.fetch;
}
