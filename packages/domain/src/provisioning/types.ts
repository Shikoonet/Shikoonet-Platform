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
 * Only `provision` exists so far. `renew`, `revoke` and `status` are named in
 * the plan and will land with the renewal flow — declaring them now as methods
 * nobody implements would be four unimplemented branches per adapter.
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

export interface ProvisioningAdapter {
  readonly kind: string;
  /**
   * Create the thing, or return the one that is already there under this
   * username. Must be safe to call twice with the same request — the sweep
   * that calls it can be interrupted at any point and will call again.
   */
  provision(request: ProvisionRequest, provider: ProviderContext): Promise<ProvisionResult>;
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
