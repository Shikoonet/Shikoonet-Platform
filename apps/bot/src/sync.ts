/**
 * Keeping «سرویس های من» true.
 *
 * The subscription row records what was sold. Two things about it change
 * afterwards without anybody writing them down: how much volume has been used,
 * and — for the 3,139 services migrated from the PHP bot — the subscription
 * link, which the old schema never stored at all.
 *
 * Mirzabot asks the panel every time a customer opens a service screen
 * (`admin.php:6212`). That is a network call inside a button press, and here a
 * button press runs inside the transaction that claims `update_id`, so a slow
 * panel would hold the exactly-once lock open for twenty seconds. So this is a
 * sweep instead: one listing per panel, every few minutes, writing what it
 * learns onto the rows.
 *
 * What is deliberately NOT written:
 *
 *   - `status`. Marzban says active / limited / expired / disabled / on_hold;
 *     the column allows six different values and no honest mapping exists.
 *     Expiry and exhaustion are derived at display time from data that cannot
 *     be lost (`menu.serviceState`).
 *   - `expires_at`. We sold the duration, so we own the date. A panel clock
 *     that is wrong must not be able to shorten what a customer paid for.
 *   - Anything at all when the panel does not answer. A failed listing leaves
 *     every row exactly as it was, showing slightly old numbers rather than
 *     none.
 */

import type { D1Database } from '@shikoo/database';
import { adapterFor, type ProviderContext, type RemoteAccount } from '@shikoo/domain';
import { credentialsFor } from './provision.js';
import { createLogger } from '@shikoo/domain';

const log = createLogger('bot');

/**
 * How stale the numbers are allowed to get.
 *
 * Five panels times one listing is cheap, but the poll loop comes round every
 * 25 seconds and a listing per cycle would be 144 requests an hour per panel
 * for a figure that moves slowly. Ten minutes is well inside what a customer
 * reads as "current".
 */
export const SYNC_INTERVAL_MS = 10 * 60 * 1000;

/** Rows updated per statement. One statement per panel would build a parameter
 *  array of a few thousand entries; this keeps each one boring. */
const CHUNK = 500;

interface ProviderRow {
  id: number;
  code: string;
  name: string;
  kind: string;
  base_url: string | null;
  secret_ref: string | null;
  config: Record<string, unknown> | null;
}

export interface SyncSummary {
  /** Providers whose listing succeeded. */
  panels: number;
  /** Subscription rows whose figures were refreshed. */
  updated: number;
  /** Providers that could not be listed. Their rows are untouched. */
  failed: number;
}

const NOTHING: SyncSummary = { panels: 0, updated: 0, failed: 0 };

/**
 * True when it is worth asking the panels again.
 *
 * MAX rather than MIN: a successful sweep advances every row it touched, so the
 * newest timestamp is "when the last sweep ran". MIN would be pinned forever by
 * the first subscription whose account no longer exists on its panel, and the
 * sweep would then run every single cycle.
 */
async function isDue(db: D1Database, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT MAX(last_synced_at) AS newest FROM subscriptions
        WHERE status = 'ACTIVE' AND remote_username IS NOT NULL`,
    )
    .first<{ newest: string | null }>();
  if (!row || row.newest === null) return true;
  return Date.parse(row.newest) <= now - SYNC_INTERVAL_MS;
}

/**
 * Refreshes usage and links for every active service, one listing per panel.
 *
 * Returns a summary rather than notifications: nothing here is news for a
 * customer. Telling somebody their usage went up is what the warning sweep is
 * for, and it reads these columns.
 */
export async function syncSubscriptions(
  db: D1Database,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  now: number = Date.now(),
): Promise<SyncSummary> {
  if (!(await isDue(db, now))) return NOTHING;

  // Only panels that actually hold something. A provider with no live
  // subscription is a panel we have no business calling.
  const { results } = await db
    .prepare(
      `SELECT DISTINCT pv.id, pv.code, pv.name, pv.kind, pv.base_url, pv.secret_ref, pv.config
         FROM provisioning_providers pv
         JOIN subscriptions s ON s.provider_id = pv.id
        WHERE s.status = 'ACTIVE' AND s.remote_username IS NOT NULL
        ORDER BY pv.id`,
    )
    .all<ProviderRow>();

  const summary: SyncSummary = { panels: 0, updated: 0, failed: 0 };

  for (const row of results ?? []) {
    const adapter = adapterFor(row.kind);
    // `manual` and anything without an adapter have nothing to list. Not a
    // failure — there is simply no remote side to ask.
    if (!adapter.listAccounts) continue;

    const provider: ProviderContext = {
      id: row.id,
      code: row.code,
      name: row.name,
      baseUrl: row.base_url,
      credentials: credentialsFor(row.secret_ref),
      config: row.config ?? {},
      fetch: fetchImpl,
    };

    const listed = await adapter.listAccounts(provider);
    if (!listed.ok) {
      summary.failed++;
      // The reason names the panel and an HTTP status, never a credential.
      // The reason names the panel and an HTTP status, never a credential.
      log.warn('sync.panel_skipped', { ref: row.code, reason: listed.reason });
      continue;
    }

    summary.panels++;
    summary.updated += await writeAccounts(db, row.id, listed.accounts);
  }

  return summary;
}

/**
 * Writes one panel's figures onto the subscriptions that point at it.
 *
 * One statement per chunk, matched on `(provider_id, remote_username)` — which
 * is the partial index `idx_subs_remote` and the same pair that makes a remote
 * account unique.
 *
 * `subscription_url` is COALESCEd so a panel that stops returning one does not
 * erase a link the customer already has. `used_bytes` is not: a NULL there
 * means the panel genuinely no longer counts, and keeping a stale number would
 * be worse than showing none.
 */
async function writeAccounts(
  db: D1Database,
  providerId: number,
  accounts: RemoteAccount[],
): Promise<number> {
  let updated = 0;
  for (let at = 0; at < accounts.length; at += CHUNK) {
    const chunk = accounts.slice(at, at + CHUNK);
    const result = await db
      .prepare(
        `UPDATE subscriptions s
            SET used_bytes       = v.used_bytes,
                subscription_url = COALESCE(v.url, s.subscription_url),
                last_synced_at   = now(),
                updated_at       = now()
           FROM (SELECT * FROM unnest(?2::text[], ?3::bigint[], ?4::text[])
                          AS t(username, used_bytes, url)) v
          WHERE s.provider_id = ?1
            AND s.status = 'ACTIVE'
            AND s.remote_username = v.username`,
      )
      .bind(
        providerId,
        chunk.map((a) => a.username),
        chunk.map((a) => a.usedBytes),
        chunk.map((a) => a.subscriptionUrl),
      )
      .run();
    updated += result.meta.changes;
  }
  return updated;
}
