/**
 * The two sweeps that delete a customer's account from a panel.
 *
 * These are the only things in this project that destroy something a customer
 * paid for, and nothing puts it back. Every design choice below follows from
 * that one fact, so they are written out rather than left to be inferred.
 *
 * ## Where they come from
 *
 * Mirzabot has run both for months — `cronbot/NoticationsService.php`, behind
 * `cron_status.remove` and `cron_status.remove_volume`. `apps/bot/src/warn.ts`
 * used to say we had deliberately not built them, quoting the 2026-08-13 dump
 * where both switches read `false`. `backup_2026-09-02.sql` says both are
 * `true`: the admin turned them on some time in between. So the comment was
 * right when written and wrong by the time anyone read it — the same lesson as
 * rule six, this time about ourselves.
 *
 * ## The conditions, and the odd one
 *
 *   remove_expired  panel says `limited` or `expired`
 *                   AND our expiry is more than `removedayc` days past
 *
 *   remove_volume   panel says `limited`  (only — see below)
 *                   AND the panel reports a last-connection time
 *                   AND that is more than `cronvolumere` days ago
 *
 * The volume one reads oddly in the PHP and the reading matters. Line 155
 * requires `status IN ('limited','expired')`; line 163 then RETURNS for
 * `status IN ('Unknown','active','on_hold','disabled','expired')`. `expired`
 * is in both, so the only status that survives the pair is `limited` — an
 * account out of gigabytes, not one out of days. Days are the other sweep's
 * job, and the two must not both claim the same service.
 *
 * A service the panel has never reported a connection for is skipped, which is
 * the PHP's behaviour too (`$timelastconect == 0` returns). Somebody who
 * bought and never connected keeps their account: they are the `unused` nudge's
 * audience, not this one's.
 *
 * ## Four guards the parity does not give us
 *
 * 1. Both switches default OFF, whatever the legacy blob says (migration 0057).
 * 2. `cron_remove_dry_run` defaults ON. In that mode both sweeps select exactly
 *    what they would delete, write it to `app_events`, message nobody, and
 *    delete nothing. Mirzabot has no such mode; we need one because we cannot
 *    undo a wrong deletion and «the sweep is right» is not knowable in advance.
 * 3. A ceiling per pass, like every other sweep here.
 * 4. Both read the PANEL's verdict, never our own status alone. A removal on
 *    our dates would take services the panel still considers live.
 */

import type { D1Database } from '@shikoo/database';
import { adapterFor, createLogger, type ProviderContext } from '@shikoo/domain';
import { credentialsFor } from './provision.js';
import { enqueue } from './notify.js';
import * as menu from './menu.js';
import { loadShopSettings } from './settings.js';

const log = createLogger('bot');

/**
 * A ceiling per pass, and deliberately smaller than `warn.ts`'s fifty.
 *
 * Each row here is one panel request that destroys an account, not one row of
 * an UPDATE. Ten a cycle is roughly 1,400 a day, which drains any real backlog
 * within a day while keeping the blast radius of a misconfigured threshold to
 * something an operator can notice and stop.
 */
const BATCH = 10;

export type RemovalReason = 'expired' | 'volume';

interface DueRow {
  id: number;
  public_id: string;
  telegram_id: number | null;
  plan_name_at_sale: string;
  remote_username: string;
  provider_id: number;
  expires_at: string | null;
  panel_status: string;
  panel_online_at: string | null;
  days: number;
}

interface ProviderRow {
  id: number;
  code: string;
  name: string;
  kind: string;
  base_url: string | null;
  secret_ref: string | null;
  sealed: string | null;
  config: Record<string, unknown> | null;
}

export interface RemovalSummary {
  /** Accounts actually deleted from a panel. Always 0 while the dry run is on. */
  removed: number;
  /** Rows that met every condition. Equals `removed` only outside the dry run. */
  due: number;
  /** Panels that refused or could not be reached. Those rows stay for next cycle. */
  failed: number;
  /** True when nothing was deleted because the shop is still only reporting. */
  dryRun: boolean;
}

const NOTHING: RemovalSummary = { removed: 0, due: 0, failed: 0, dryRun: true };

/**
 * The rows each sweep is allowed to touch.
 *
 * `panel_status` is compared against a literal, never against «not active»: the
 * column is NULL for every service on a panel that does not report one, and
 * NULL must mean «do not act». Written as an equality so that stays true no
 * matter what a panel starts sending.
 *
 * `FOR UPDATE SKIP LOCKED` and a CTE, for the reason rule nine gives: a `LIMIT`
 * inside a subquery bounds each re-execution rather than the batch, and this is
 * a batch whose size is the number of accounts destroyed.
 */
const EXPIRED_DUE = `
  WITH due AS MATERIALIZED (
    SELECT s.id
      FROM subscriptions s
     WHERE s.status = 'ACTIVE'
       AND s.remote_username IS NOT NULL
       AND s.panel_status IN ('limited', 'expired')
       AND s.expires_at IS NOT NULL
       AND s.expires_at <= to_timestamp(?1 / 1000.0) - make_interval(days => ?2)
     ORDER BY s.expires_at
     LIMIT ?3
     FOR UPDATE SKIP LOCKED
  )
  SELECT s.id, s.public_id, u.telegram_id, s.plan_name_at_sale, s.remote_username,
         s.provider_id, s.expires_at::text AS expires_at, s.panel_status,
         s.panel_online_at::text AS panel_online_at,
         FLOOR(EXTRACT(EPOCH FROM (to_timestamp(?1 / 1000.0) - s.expires_at)) / 86400)::int AS days
    FROM subscriptions s
    JOIN users u ON u.id = s.user_id
   WHERE s.id IN (SELECT id FROM due)`;

const VOLUME_DUE = `
  WITH due AS MATERIALIZED (
    SELECT s.id
      FROM subscriptions s
     WHERE s.status = 'ACTIVE'
       AND s.remote_username IS NOT NULL
       -- Only limited. The PHP's two overlapping lists leave exactly this one
       -- word; see the file header. An expired account is the other sweep's.
       AND s.panel_status = 'limited'
       -- Never connected means never removed here. The legacy returns on the
       -- same condition, and the customer who bought and never plugged it in
       -- belongs to the nudge, not to this.
       AND s.panel_online_at IS NOT NULL
       AND s.panel_online_at <= to_timestamp(?1 / 1000.0) - make_interval(days => ?2)
     ORDER BY s.panel_online_at
     LIMIT ?3
     FOR UPDATE SKIP LOCKED
  )
  SELECT s.id, s.public_id, u.telegram_id, s.plan_name_at_sale, s.remote_username,
         s.provider_id, s.expires_at::text AS expires_at, s.panel_status,
         s.panel_online_at::text AS panel_online_at,
         FLOOR(EXTRACT(EPOCH FROM (to_timestamp(?1 / 1000.0) - s.panel_online_at)) / 86400)::int AS days
    FROM subscriptions s
    JOIN users u ON u.id = s.user_id
   WHERE s.id IN (SELECT id FROM due)`;

export async function removeFinishedServices(
  db: D1Database,
  reason: RemovalReason,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  now: number = Date.now(),
): Promise<RemovalSummary> {
  const settings = await loadShopSettings(db);
  const on = reason === 'expired' ? settings.cron.remove_expired : settings.cron.remove_volume;
  // Off is the default and the common case. Returned before the query, so a
  // shop that never turns these on pays one cached settings read per cycle.
  if (!on) return NOTHING;

  const dryRun = settings.cronRemoveDryRun;
  const days =
    reason === 'expired' ? settings.removeAfterDays : settings.removeVolumeAfterDays;

  const { results } = await db
    .prepare(reason === 'expired' ? EXPIRED_DUE : VOLUME_DUE)
    .bind(now, days, BATCH)
    .all<DueRow>();
  const due = results ?? [];
  if (due.length === 0) return { removed: 0, due: 0, failed: 0, dryRun };

  if (dryRun) {
    // The whole point of the mode: say exactly what would have gone, by name,
    // and stop. `public_id` rather than the customer's telegram id — this line
    // is read in «رویدادها» by whoever is deciding whether to trust the sweep,
    // and it does not need to identify a person to do that.
    for (const row of due) {
      log.info('remove.would_have', {
        job: reason,
        ref: row.public_id,
        panel_status: row.panel_status,
        days: row.days,
        threshold: days,
      });
    }
    return { removed: 0, due: due.length, failed: 0, dryRun: true };
  }

  const providers = await providerContexts(db, due, fetchImpl);
  let removed = 0;
  let failed = 0;

  for (const row of due) {
    const provider = providers.get(row.provider_id);
    const adapter = provider ? adapterFor(provider.kind) : null;
    // A panel with no adapter, no credential, or no delete has nothing this
    // sweep can do. Not a failure — `manual` is exactly this, and there is no
    // remote account to remove.
    if (!provider || !adapter?.deleteAccount) continue;

    const result = await adapter.deleteAccount(provider.ctx, row.remote_username);
    if (!result.ok) {
      failed += 1;
      // Named panel, named account, HTTP status. Never a credential.
      log.warn('remove.panel_refused', {
        job: reason,
        ref: row.public_id,
        panel: provider.ctx.code,
        reason: result.reason,
        will_retry: result.retryable,
      });
      continue;
    }

    // The panel is done with it; now our row, and the customer's message, in
    // one transaction. The order matters: if this half fails the account is
    // already gone from the panel, and a subscription still marked ACTIVE
    // would be re-selected next cycle and deleted again — which is harmless
    // against a 404 but would message the customer twice. Marking it first is
    // not the answer either: that would leave a live account on a panel nobody
    // is tracking. So the write is guarded on the same status the SELECT used
    // and the message is enqueued beside it, and a crash between the two costs
    // one duplicate 404 rather than a customer's service.
    const told = await db.withSession(async (tx) => {
      const marked = await tx
        .prepare(
          `UPDATE subscriptions
              SET status = 'REMOVED', updated_at = now()
            WHERE id = ?1 AND status = 'ACTIVE'`,
        )
        .bind(row.id)
        .run();
      if (marked.meta.changes === 0) return false;
      if (row.telegram_id === null) return true;
      return enqueue(tx, {
        dedupeKey: `remove:${row.id}:${reason}`,
        chatId: row.telegram_id,
        text:
          reason === 'expired'
            ? menu.serviceRemovedExpired(row.plan_name_at_sale, row.days)
            : menu.serviceRemovedVolume(row.plan_name_at_sale, row.days),
      });
    });

    removed += 1;
    log.info('remove.done', {
      job: reason,
      ref: row.public_id,
      panel: provider.ctx.code,
      // False here means the account was not on the panel to begin with, which
      // is worth reading: somebody removed it by hand, or a previous sweep did
      // and the write that recorded it was lost.
      was_present: result.gone,
      told,
      days: row.days,
    });
  }

  return { removed, due: due.length, failed, dryRun: false };
}

/** The panels the due rows sit on, read once rather than per account. */
async function providerContexts(
  db: D1Database,
  due: DueRow[],
  fetchImpl: typeof globalThis.fetch,
): Promise<Map<number, { kind: string; ctx: ProviderContext }>> {
  const ids = [...new Set(due.map((r) => r.provider_id))];
  const { results } = await db
    .prepare(
      `SELECT pv.id, pv.code, pv.name, pv.kind, pv.base_url, pv.secret_ref,
              ps.sealed, pv.config
         FROM provisioning_providers pv
         LEFT JOIN provider_secrets ps ON ps.provider_id = pv.id
        WHERE pv.id = ANY(?1)`,
    )
    .bind(ids)
    .all<ProviderRow>();

  const out = new Map<number, { kind: string; ctx: ProviderContext }>();
  for (const row of results ?? []) {
    out.set(row.id, {
      kind: row.kind,
      ctx: {
        id: row.id,
        code: row.code,
        name: row.name,
        baseUrl: row.base_url,
        credentials: credentialsFor(row.secret_ref, row.sealed),
        config: row.config ?? {},
        fetch: fetchImpl,
      },
    });
  }
  return out;
}
