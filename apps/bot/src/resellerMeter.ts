/**
 * Reading the reseller meter, and enforcing the half the panel will not.
 *
 * ## Why the bot and not the dashboard
 *
 * The dashboard deliberately makes zero outbound calls — it reads this
 * database and nothing else, and that is a property worth keeping. The bot is
 * already the process that talks to panels every few minutes, so the meter is
 * read here, beside `syncSubscriptions`, and the dashboard reads the rows this
 * leaves behind.
 *
 * ## Why we read the panel rather than asking the reseller
 *
 * A franchise runs its own installation: its own bot, its own database, its
 * own dashboard. Asking it how much it used would be asking the billed party
 * to write their own invoice. The panel counts the traffic itself, and that
 * number is the one thing in the arrangement neither side can move.
 *
 * ## The half the panel does not do — measured, not assumed
 *
 * The plan for this feature assumed the panel would enforce a TERM the way it
 * enforces a volume cap. It does not: `GET /api/admins` on PasarGuard 5.2.1
 * carries no `expire`, `expire_at` or any equivalent — checked against the
 * live panel on 2026-09-07, not read off documentation, because that panel
 * answers 404 for `/openapi.json`.
 *
 * The volume half IS the panel's and is automatic: `data_limit` plus
 * `is_limited`, and the role's `disconnect_users_when_limited` stops that
 * admin's customers by itself. The term half is ours, and this file is where
 * it happens: a reseller past `expires_at` is moved to SUSPENDED here.
 *
 * **Suspending is a row in our database, not a call to the panel.** Nothing
 * here disables a panel admin, and that is deliberate: switching an admin off
 * cuts every one of their customers off mid-month, which is a decision an
 * operator makes on the «نمایندگان» screen with the consequence in front of
 * them — not something a sweep does at 3am because a date passed.
 */

import type { D1Database } from '@shikoo/database';
import { adapterFor, createLogger } from '@shikoo/domain';
import type { PanelAdmin, ProviderContext } from '@shikoo/domain';
import { credentialsFor } from './provision.js';

const log = createLogger('bot');

/**
 * How often the meter is read.
 *
 * Far longer than the subscription sweep's few minutes, and the reason is that
 * these two answer different questions. A customer's remaining volume is on a
 * screen they refresh; a reseller's usage is a monthly invoice. Reading it
 * every fifteen minutes would be ninety-six panel calls a day to move a number
 * nobody looks at until the end of the month.
 */
export const METER_INTERVAL_MS = 60 * 60 * 1000;

interface ResellerRow {
  id: number;
  provider_id: number;
  panel_admin_username: string;
  expires_at: string | null;
  code: string;
  name: string;
  kind: string;
  base_url: string | null;
  secret_ref: string | null;
  sealed: string | null;
  config: Record<string, unknown> | null;
}

export interface MeterSummary {
  /** Panels whose admin listing succeeded. */
  panels: number;
  /** Readings written. */
  readings: number;
  /** Panels that could not be listed. Their resellers are untouched. */
  failed: number;
  /** Resellers whose term ran out and were moved to SUSPENDED. */
  suspended: number;
  /**
   * Resellers we hold a row for whose admin the panel did not report.
   *
   * Counted rather than logged away because it is the shape of a real fault:
   * an admin renamed or deleted on the panel leaves a franchise that looks
   * healthy in our dashboard and is being billed from a stale reading.
   */
  missing: number;
}

const NOTHING: MeterSummary = {
  panels: 0,
  readings: 0,
  failed: 0,
  suspended: 0,
  missing: 0,
};

/**
 * True when it is worth asking the panels again.
 *
 * MAX for the same reason `sync.ts` uses MAX: a sweep advances every reseller
 * it read, so the newest reading is "when the last sweep ran". MIN would be
 * pinned forever by one reseller whose panel admin has gone, and the sweep
 * would then run on every cycle.
 *
 * A reseller with no reading at all makes this true, which is what gets a
 * newly-added franchise metered on the next pass rather than in an hour.
 */
async function isDue(db: D1Database, now: number): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT MAX(s.taken_at) AS newest
         FROM reseller_accounts r
         LEFT JOIN reseller_usage_snapshots s ON s.reseller_id = r.id
        WHERE r.status = 'ACTIVE'`,
    )
    .first<{ newest: string | null }>();
  if (!row || row.newest === null) return true;
  return Date.parse(row.newest) <= now - METER_INTERVAL_MS;
}

/**
 * Moves every ACTIVE reseller whose term has run out to SUSPENDED.
 *
 * Done before the reading rather than after, so a reseller who expired
 * overnight is not metered one last time and then suspended — the reading
 * would be attributed to a period they had already left.
 *
 * The `expires_at <= now` comparison is bound rather than `now()` so the sweep
 * has one clock, the caller's, the same rule the rest of the bot follows.
 */
async function suspendExpired(db: D1Database, now: number): Promise<number> {
  const { results } = await db
    .prepare(
      `UPDATE reseller_accounts
          SET status = 'SUSPENDED', updated_at = now()
        WHERE status = 'ACTIVE'
          AND expires_at IS NOT NULL
          AND expires_at <= to_timestamp(?1 / 1000.0)
        RETURNING id`,
    )
    .bind(now)
    .all<{ id: number }>();
  const suspended = results ?? [];
  for (const row of suspended) {
    // Named at warn: a franchise going dark is something an operator wants to
    // find in the log without going looking for it.
    log.warn('reseller.term_ended', { ref: String(row.id) });
  }
  return suspended.length;
}

/**
 * Reads the meter for every ACTIVE reseller, one listing per panel.
 *
 * Returns a summary rather than notifications: none of this is news for a
 * customer, and a reseller hears about their own usage from their own
 * installation.
 */
export async function meterResellers(
  db: D1Database,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
  now: number = Date.now(),
): Promise<MeterSummary> {
  if (!(await isDue(db, now))) return NOTHING;

  const summary: MeterSummary = { ...NOTHING };
  summary.suspended = await suspendExpired(db, now);

  // Read AFTER the suspension above, so a reseller whose term just ended is
  // already out of this set.
  const { results } = await db
    .prepare(
      `SELECT r.id, r.provider_id, r.panel_admin_username, r.expires_at::text AS expires_at,
              pv.code, pv.name, pv.kind, pv.base_url, pv.secret_ref, ps.sealed, pv.config
         FROM reseller_accounts r
         JOIN provisioning_providers pv ON pv.id = r.provider_id
         LEFT JOIN provider_secrets ps ON ps.provider_id = pv.id
        WHERE r.status = 'ACTIVE'
        ORDER BY r.provider_id, r.id`,
    )
    .all<ResellerRow>();
  const resellers = results ?? [];
  if (resellers.length === 0) return summary;

  // Grouped so ten franchises on one panel cost one request, not ten. The same
  // decision `syncSubscriptions` makes, for the same reason.
  const byPanel = new Map<number, ResellerRow[]>();
  for (const row of resellers) {
    const list = byPanel.get(row.provider_id);
    if (list) list.push(row);
    else byPanel.set(row.provider_id, [row]);
  }

  for (const [, rows] of byPanel) {
    const first = rows[0]!;
    const adapter = adapterFor(first.kind);
    // `manual` has no admins. Not a failure — there is no remote side to ask,
    // and a reseller on such a panel simply has no meter.
    if (!adapter.listPanelAdmins) continue;

    const provider: ProviderContext = {
      id: first.provider_id,
      code: first.code,
      name: first.name,
      baseUrl: first.base_url,
      credentials: credentialsFor(first.secret_ref, first.sealed),
      config: first.config ?? {},
      fetch: fetchImpl,
    };

    const listed = await adapter.listPanelAdmins(provider);
    if (!listed.ok) {
      summary.failed++;
      // The reason names the panel and an HTTP status, never a credential.
      log.warn('reseller.panel_skipped', { ref: first.code, reason: listed.reason });
      continue;
    }
    summary.panels++;

    // Lowercased on both sides because the unique index on
    // `reseller_accounts` is on `lower(panel_admin_username)` — matching case
    // sensitively here would silently meter nobody the day an operator typed
    // the name with a capital.
    const admins = new Map<string, PanelAdmin>();
    for (const admin of listed.admins) admins.set(admin.username.toLowerCase(), admin);

    for (const row of rows) {
      const admin = admins.get(row.panel_admin_username.toLowerCase());
      if (!admin) {
        summary.missing++;
        log.warn('reseller.admin_missing', { ref: first.code });
        continue;
      }
      // A counter the panel could not report leaves a GAP in the ledger rather
      // than a reading of zero. Zero is «used nothing», which is what an
      // invoice would be built on — and it looks identical to a franchise that
      // has stopped selling. See `PanelAdmin.lifetimeUsedBytes`.
      if (admin.usedBytes === null || admin.lifetimeUsedBytes === null) {
        log.warn('reseller.unreadable_meter', { ref: first.code });
        continue;
      }

      await db
        .prepare(
          // `taken_at` is BOUND, not `now()`.
          //
          // The gate above reads `MAX(taken_at)` and compares it against the
          // caller's clock. Letting the database stamp the row would mean the
          // sweep decides with one clock and records with another, and any
          // difference between them — a container whose time drifted, a test
          // that pins `Date.now` — turns the interval gate into either a sweep
          // that never runs or one that runs on every cycle. Found by a test
          // pinning the clock, which is what CLAUDE.md rule 5 is for.
          `INSERT INTO reseller_usage_snapshots
             (reseller_id, used_bytes, lifetime_used_bytes, data_limit_bytes,
              total_users, panel_status, panel_is_limited, taken_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, to_timestamp(?8 / 1000.0))`,
        )
        .bind(
          row.id,
          admin.usedBytes,
          admin.lifetimeUsedBytes,
          admin.dataLimitBytes,
          admin.totalUsers,
          admin.status,
          admin.limited,
          now,
        )
        .run();
      summary.readings++;
    }
  }

  return summary;
}
