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

/**
 * The two ways a renewal is applied, both of them live.
 *
 * Legacy `panels.php:extend` offers five, selected per panel by
 * `marzban_panel.Methodextend`. The production rows use exactly two:
 *
 *     panel  Methodextend                         mode
 *       1    اضافه شدن زمان و حجم به ماه بعد        ADD
 *       8    ریست حجم و زمان                       RESET
 *      12    ریست حجم و زمان                       RESET
 *      13    ریست حجم و زمان                       RESET  (renewal switched off)
 *      14    ریست حجم و زمان                       RESET
 *
 * The other three are not implemented for the same reason the `on_hold` branches
 * of `provision` are not: nothing selects them, and a branch nobody runs is a
 * branch nobody notices is wrong.
 *
 * RESET  — the usage counter goes to zero, the quota becomes the plan's, and
 *          the clock starts again from the moment of renewal.
 * ADD    — the plan's volume is added to what is already there and its days are
 *          added to whatever time is left, so a customer who renews early loses
 *          nothing. Usage is NOT reset; the quota grows instead.
 */
export type RenewMode = 'RESET' | 'ADD';

/** What a renewal buys, flattened the same way `ProvisionRequest` is. */
export interface RenewRequest {
  /** The account already on the panel. Not derived — read off the subscription. */
  username: string;
  /** The plan's volume. NULL means unmetered. */
  volumeGb: number | null;
  /** The plan's duration. NULL means no expiry. */
  durationDays: number | null;
  note: string;
  providerConfig: Record<string, unknown>;
  planAttrs: Record<string, unknown>;
  mode: RenewMode;
  /**
   * The moment the renewal takes effect, resolved by the caller so the adapter
   * still has no clock. In ADD mode the new expiry is measured from whichever
   * is later, this or the account's own remaining time — which is what stops an
   * early renewal from throwing away the days already paid for.
   */
  renewFrom: Date;
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
  /**
   * What the account's limits are now, as the adapter set them.
   *
   * Only a renewal fills these in, and only because the answer is not
   * derivable outside the adapter: in ADD mode the new expiry is measured from
   * the panel's own remaining time and the new quota from the panel's own
   * counter. Recomputing either in the caller would be two implementations of
   * one rule, drifting apart the first time a panel's clock does.
   *
   * `undefined` means "unchanged / not applicable"; `null` means "no limit".
   */
  expiresAt?: Date | null;
  volumeGb?: number | null;
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
  /**
   * What the panel was already made to do before this failed.
   *
   * A renewal is two calls to the panel and only the pair is meaningful. If the
   * first one lands and the second is refused, the account has moved and the
   * order has not — the customer is refunded and told it failed, while their
   * usage counter really is back at zero. Nothing can put that back: no panel
   * API accepts a used-traffic figure.
   *
   * So the adapter says what it did, and the sweep writes it down where a
   * person can find it. An empty array is the ordinary case and the default;
   * a failure before any call has nothing to report.
   */
  applied?: string[];
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

/**
 * Something the customer asks of an account they already own — not a purchase.
 *
 * Deliberately not folded into `renew`: nothing here changes what was paid for,
 * so none of it goes near an order. What comes back is only what the caller has
 * to store — a revoked link is a new link, and a status change is a status.
 */
export type AccountAction =
  | { kind: 'REVOKE_SUB'; username: string }
  | { kind: 'SET_ENABLED'; username: string; enabled: boolean };

export type AccountActionResult =
  | {
      ok: true;
      /** Present when the action replaced it. `undefined` means unchanged. */
      subscriptionUrl?: string | null;
      /** What the account's status is now, as the panel reports it. */
      enabled?: boolean;
    }
  | { ok: false; reason: string; retryable: boolean };

export interface ProvisioningAdapter {
  readonly kind: string;
  /**
   * Create the thing, or return the one that is already there under this
   * username. Must be safe to call twice with the same request — the sweep
   * that calls it can be interrupted at any point and will call again.
   */
  provision(request: ProvisionRequest, provider: ProviderContext): Promise<ProvisionResult>;
  /**
   * Extend an account that already exists.
   *
   * Not idempotent the way `provision` is, and cannot be: adding thirty days
   * twice adds sixty. The caller is what makes it safe — an order is claimed
   * out of PAID before this runs and only ever reaches here once.
   *
   * Optional. Without it a renewal falls to a person, which is the right
   * answer for a product nobody automated.
   */
  renew?(request: RenewRequest, provider: ProviderContext): Promise<ProvisionResult>;
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
  /**
   * Act on an existing account at the customer's request: replace its
   * subscription link, or turn it off and on.
   *
   * Optional, and a provider that lacks it simply does not offer the buttons —
   * a `manual` product has no panel to ask, and pretending otherwise would tell
   * the customer something happened when nothing did.
   */
  act?(action: AccountAction, provider: ProviderContext): Promise<AccountActionResult>;
}

/** Everything about the provider except its secrets. */
export interface ProviderContext {
  id: number;
  code: string;
  name: string;
  baseUrl: string | null;
  /**
   * Resolved credentials, looked up from the environment by `secret_ref` —
   * never read out of the database, which is why the column holds a name and
   * not a password.
   *
   * That keeps the login out of the row. It does not make the row harmless:
   * `config.proxies` carries a hysteria shared secret, because provisioning
   * sends it. See `migrations/0002_catalog.sql`.
   */
  credentials: { username: string; password: string } | null;
  config: Record<string, unknown>;
  /** Injected so tests do not reach the network and never need a real panel. */
  fetch: typeof globalThis.fetch;
}
