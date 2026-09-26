/**
 * What a customer may do to a service they already own.
 *
 * Two things, both free and both irreversible-ish in a way that matters:
 * replacing the subscription link (every device that imported the old one stops
 * working), and turning the account off and on at the panel.
 *
 * Neither goes near an order. Nothing here changes what was paid for, so there
 * is no money path to protect — the guard that matters is ownership, and it is
 * the same one as everywhere else: the row is loaded through `owned.ts`, whose
 * query carries `AND user_id = ?`. A callback id never selects a row on its own.
 *
 * ponytail: the panel call happens inside the update's transaction, so a slow
 * panel holds that transaction for as long as the adapter's timeout. At this
 * traffic — a few taps a minute — that is cheaper than a job table and a second
 * sweep. Move it out when a panel's latency starts showing up as lock waits.
 */

import {
  adapterFor,
  createLogger,
  type AccountAction,
  type ProviderContext,
} from '@shikoo/domain';
import type { D1DatabaseSession } from '@shikoo/database';
import { credentialsFor } from './provision.js';
import { subscriptionOnPanelForUser, type OwnedSubscriptionOnPanel } from './owned.js';

const log = createLogger('bot');

export type ServiceAction = 'REVOKE' | 'ENABLE' | 'DISABLE';

export type ActionOutcome =
  /** No such service for this customer. Also what a crafted id gets. */
  | { status: 'GONE' }
  /** A product no panel provisions — a manual one. There is nothing to call. */
  | { status: 'UNSUPPORTED'; service: OwnedSubscriptionOnPanel }
  | { status: 'FAILED'; service: OwnedSubscriptionOnPanel; reason: string }
  | { status: 'OK'; service: OwnedSubscriptionOnPanel; subscriptionUrl: string | null };

function requestFor(action: ServiceAction, username: string): AccountAction {
  return action === 'REVOKE'
    ? { kind: 'REVOKE_SUB', username }
    : { kind: 'SET_ENABLED', username, enabled: action === 'ENABLE' };
}

function providerFor(
  service: OwnedSubscriptionOnPanel,
  fetchImpl: typeof globalThis.fetch,
): ProviderContext {
  return {
    id: service.provider_id ?? 0,
    code: service.provider_code ?? String(service.provider_id ?? ''),
    name: service.provider_name ?? 'panel',
    baseUrl: service.provider_base_url,
    credentials: credentialsFor(service.provider_secret_ref, service.provider_sealed),
    config: service.provider_config ?? {},
    fetch: fetchImpl,
  };
}

/**
 * A service opened without a link gets it from the panel there and then.
 *
 * The sync sweep backfills link-less rows 100 at a time, in random order, panel
 * by panel — the 6,364 imported on 2026-09-23 take most of a day to drain, and
 * a customer who opens «سرویس های من» meanwhile was told to message support.
 * One GET for the one account they are looking at costs nothing next to that.
 *
 * Written only where the column is still NULL, like the sweep. Anything that
 * goes wrong — no adapter, no credentials, a panel that does not answer, an
 * account it does not know — is the screen as it was before: «لینک هنوز در
 * دسترس نیست». Same transaction caveat as `actOnService`, bounded by the
 * adapter's timeout.
 */
export async function withLinkFromPanel(
  tx: D1DatabaseSession,
  userId: number,
  service: OwnedSubscriptionOnPanel,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<OwnedSubscriptionOnPanel> {
  if (
    service.subscription_url ||
    service.remote_username === null ||
    service.provider_kind === null
  ) {
    return service;
  }
  const adapter = adapterFor(service.provider_kind);
  if (!adapter.accountLinks) return service;
  const links = await adapter
    .accountLinks(providerFor(service, fetchImpl), [service.remote_username])
    .catch(() => null);
  const url = links?.get(service.remote_username);
  if (!url) return service;
  // `clock_timestamp()`, not `now()` — see the revoke in `actOnService`.
  await tx
    .prepare(
      `UPDATE subscriptions SET subscription_url = ?3, updated_at = clock_timestamp()
        WHERE id = ?1 AND user_id = ?2 AND subscription_url IS NULL`,
    )
    .bind(service.id, userId, url)
    .run();
  return { ...service, subscription_url: url };
}

export async function actOnService(
  tx: D1DatabaseSession,
  userId: number,
  subscriptionId: number,
  action: ServiceAction,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<ActionOutcome> {
  const service = await subscriptionOnPanelForUser(tx, userId, subscriptionId);
  if (!service) return { status: 'GONE' };

  const adapter = service.provider_kind === null ? null : adapterFor(service.provider_kind);
  if (!adapter?.act || service.remote_username === null) {
    return { status: 'UNSUPPORTED', service };
  }

  const result = await adapter.act(
    requestFor(action, service.remote_username),
    providerFor(service, fetchImpl),
  );
  if (!result.ok) {
    // Logged here, where the panel's own sentence is produced and where its
    // audience is. It used to travel out to `handle.ts` and be printed on the
    // customer's screen in English; now it goes to the one place that can act
    // on it, and the customer gets the shop's Persian line.
    log.warn('service.action_refused', {
      action,
      subscription: subscriptionId,
      panel: service.provider_code ?? String(service.provider_id ?? ''),
      reason: result.reason,
    });
    return { status: 'FAILED', service, reason: result.reason };
  }

  // Only what the panel actually changed is written back. A status change
  // echoes the same link, and rewriting it would touch a row for nothing.
  const url = result.subscriptionUrl ?? null;
  if (action === 'REVOKE' && url !== null) {
    // Stamped with the moment of this write, not the transaction's start. The
    // sync keeps a link written after its listing began (`listedAt` in
    // sync.ts), and this transaction opened before the panel was asked
    // anything — `now()` would date the new link to before the revoke, and a
    // sync listing in the meantime would put the revoked one back.
    await tx
      .prepare(
        `UPDATE subscriptions SET subscription_url = ?3, updated_at = clock_timestamp()
          WHERE id = ?1 AND user_id = ?2`,
      )
      .bind(subscriptionId, userId, url)
      .run();
  }
  if (action !== 'REVOKE') {
    // `result.enabled` is what the panel says it is now; the request is only
    // the fallback for a panel that answered without saying.
    const enabled = result.enabled ?? action === 'ENABLE';
    await tx
      .prepare(
        `UPDATE subscriptions SET status = ?3, updated_at = now()
          WHERE id = ?1 AND user_id = ?2 AND status IN ('ACTIVE', 'DISABLED')`,
      )
      .bind(subscriptionId, userId, enabled ? 'ACTIVE' : 'DISABLED')
      .run();
  }

  const updated = await subscriptionOnPanelForUser(tx, userId, subscriptionId);
  return { status: 'OK', service: updated ?? service, subscriptionUrl: url };
}
