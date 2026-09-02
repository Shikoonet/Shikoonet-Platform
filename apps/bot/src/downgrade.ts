/**
 * What happens to an account when its service ends.
 *
 * Today: nothing. The row keeps saying ACTIVE, `menu.serviceState` works out
 * from `expires_at` that it has run out, and the account on the panel goes on
 * carrying every inbound it was sold. The customer's app keeps connecting until
 * the panel notices the expiry itself, and when it does the subscription link
 * simply stops returning configs — no message, no explanation, on a screen we
 * do not control.
 *
 * «اینباند اکانت غیرفعال» is the old bot's answer and this is ours: move the
 * account onto a group the shop set aside for it. A group with one slow inbound,
 * or one that only resolves the panel's own page. The link keeps working, the
 * app keeps updating, and what it shows says «this ran out» instead of nothing.
 *
 * ## Why this is a sweep and not a moment
 *
 * There is no moment. `sync.ts` deliberately refuses to write `status` from the
 * panel — «a panel clock that is wrong must not be able to shorten what a
 * customer paid for» — so nothing in this system ever fires "this service just
 * expired". `expires_at` is ours, it is already indexed for exactly this
 * question, and a sweep over it needs no new source of truth.
 *
 * ## What legacy does, and the two things it gets wrong
 *
 * `NoticationsService.php:196` does the same move and stashes the account's old
 * proxies in `invoice.uuid` — a column named for something else, restored by
 * three copies of the same six lines. The copies disagree: the cron saves
 * `$userData['uuid']`, the webhook saves `$data['proxies']`.
 *
 * And its guard is wrong. `active_inbound_expire` has no expiry check of its
 * own; the only filter is the cron's invoice query, which INCLUDES
 * `Status = 'active'`. On a panel with the feature switched on it therefore
 * fires against services that have not ended. Ours asks `expires_at < now()`
 * and asks it in the statement.
 *
 * ## Nothing has ever run this
 *
 * Measured in the production dump on 2026-09-02: `inbound_deactive` is the
 * string `1` on all five panels — the value `admin.php:766` binds when a panel
 * is created, never the `proto*tag` the menu writes. Panel 8 has the feature ON
 * with that value, and `explode('*', '1')` gives a one-element array whose `[1]`
 * is undefined. So there is no behaviour to preserve here and nothing to
 * migrate: `downgrade_group_ids` starts empty on every panel and this sweep does
 * nothing until somebody sets one.
 */

import type { D1Database } from '@shikoo/database';
import { adapterFor, createLogger, downgradeGroupsFor, type ProviderContext } from '@shikoo/domain';
import { credentialsFor } from './provision.js';

const log = createLogger('bot');

/**
 * How many accounts one pass will move.
 *
 * One `PUT /api/user/{u}` each, plus a read in front of it, so this is a
 * request budget rather than a row budget. The panel that throttled us into a
 * TLS-completes-HTTP-never state on 2026-08-24 is the reason there is a ceiling
 * at all.
 */
const BATCH = 50;

export interface DowngradeSummary {
  /** Accounts moved onto their panel's downgrade groups. */
  moved: number;
  /** Accounts the panel refused or could not be reached about. Retried next pass. */
  failed: number;
}

interface DueRow {
  id: number;
  remote_username: string;
  provider_id: number;
  provider_code: string;
  provider_name: string;
  provider_kind: string;
  provider_base_url: string | null;
  provider_secret_ref: string | null;
  provider_sealed: string | null;
  provider_config: Record<string, unknown> | null;
}

/**
 * Moves every ended service onto its panel's downgrade groups.
 *
 * `LIMIT` inside a subquery is not a limit — the planner may re-execute it per
 * outer row — so the batch is read first and acted on second. Here that is free:
 * the acting is a network call per row and could never have been one statement.
 */
export async function downgradeExpired(
  db: D1Database,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<DowngradeSummary> {
  const { results } = await db
    .prepare(
      // `expires_at < now()` in the statement, not in TypeScript after the read:
      // the legacy version's whole bug is that its filter lives somewhere else
      // and stopped agreeing with what it claimed to do.
      //
      // ON_HOLD is excluded along with everything else that is not ACTIVE. An
      // on-hold service has not started, so it has not ended.
      `SELECT s.id, s.remote_username,
              pv.id AS provider_id, pv.code AS provider_code, pv.name AS provider_name,
              pv.kind AS provider_kind, pv.base_url AS provider_base_url,
              pv.secret_ref AS provider_secret_ref, ps.sealed AS provider_sealed,
              pv.config AS provider_config
         FROM subscriptions s
         JOIN provisioning_providers pv ON pv.id = s.provider_id
         LEFT JOIN provider_secrets ps ON ps.provider_id = pv.id
        WHERE s.status = 'ACTIVE'
          AND s.downgraded_at IS NULL
          AND s.remote_username IS NOT NULL
          AND s.expires_at IS NOT NULL
          AND s.expires_at < now()
        ORDER BY s.expires_at
        LIMIT ?1`,
    )
    .bind(BATCH)
    .all<DueRow>();

  const summary: DowngradeSummary = { moved: 0, failed: 0 };

  for (const row of results ?? []) {
    const groups = downgradeGroupsFor(row.provider_config ?? {});
    // The panel has not been given a downgrade group. Not a failure and not
    // worth a log line every pass: it is the state every panel starts in.
    if (groups === null) continue;

    const adapter = adapterFor(row.provider_kind);
    if (!adapter.act) continue;

    const provider: ProviderContext = {
      id: row.provider_id,
      code: row.provider_code,
      name: row.provider_name,
      baseUrl: row.provider_base_url,
      credentials: credentialsFor(row.provider_secret_ref, row.provider_sealed),
      config: row.provider_config ?? {},
      fetch: fetchImpl,
    };

    const result = await adapter.act(
      { kind: 'SET_GROUPS', username: row.remote_username, groupIds: groups },
      provider,
    );

    if (!result.ok) {
      summary.failed++;
      // Left un-marked on purpose, so the next pass tries again. A panel that
      // is down must not cost the customer the downgrade quietly — and must not
      // cost us the record that it never happened.
      log.warn('downgrade.refused', { ref: row.provider_code, reason: result.reason });
      continue;
    }

    // Marked only after the panel agreed. The other order — mark, then call —
    // would leave a row claiming a move that never happened, and nothing would
    // ever look at it again.
    //
    // The cost of this order is the opposite crash: the panel moved and the
    // process died before this statement, so the next pass moves it again and
    // reads the DOWNGRADE groups as «before». That is why the renewal path
    // treats an unusable `groups_before_downgrade` as «whatever the plan gives a
    // new account» rather than trusting it blindly.
    await db
      .prepare(
        `UPDATE subscriptions
            SET downgraded_at = now(),
                groups_before_downgrade = ?2::jsonb,
                updated_at = now()
          WHERE id = ?1 AND downgraded_at IS NULL`,
      )
      .bind(
        row.id,
        result.groupIdsBefore === undefined ? null : JSON.stringify(result.groupIdsBefore),
      )
      .run();
    summary.moved++;
  }

  return summary;
}
