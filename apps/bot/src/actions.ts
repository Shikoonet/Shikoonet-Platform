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

import { adapterFor, type AccountAction } from '@shikoo/domain';
import type { D1DatabaseSession } from '@shikoo/database';
import { credentialsFor } from './provision.js';
import { subscriptionOnPanelForUser, type OwnedSubscriptionOnPanel } from './owned.js';

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

  const result = await adapter.act(requestFor(action, service.remote_username), {
    id: service.provider_id ?? 0,
    code: service.provider_code ?? String(service.provider_id ?? ''),
    name: service.provider_name ?? 'panel',
    baseUrl: service.provider_base_url,
    credentials: credentialsFor(service.provider_secret_ref),
    config: service.provider_config ?? {},
    fetch: fetchImpl,
  });
  if (!result.ok) return { status: 'FAILED', service, reason: result.reason };

  // Only what the panel actually changed is written back. A status change
  // echoes the same link, and rewriting it would touch a row for nothing.
  const url = result.subscriptionUrl ?? null;
  if (action === 'REVOKE' && url !== null) {
    await tx
      .prepare(
        `UPDATE subscriptions SET subscription_url = ?3, updated_at = now()
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
