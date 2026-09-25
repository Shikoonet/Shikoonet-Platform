/**
 * The free trial («اکانت تست»), asked for through two doors: the shop bot's
 * «سرویس تست رایگان» button and the support bot (n8n) through the ingest
 * server. One quota, one panel list, one claim — these lived in `apps/bot`
 * until 2026-09-25, when the second door needed exactly the same rules.
 */
import { randomBytes } from 'node:crypto';
import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import { trialFor, type TrialSettings } from './provisioning/index.js';

type Db = D1Database | D1DatabaseSession;

/**
 * The panel has an address and the bot has a credential for it.
 *
 * Spelled the way the adapter reads them: `marzban.ts` refuses on a falsy
 * `baseUrl`, and `credentialsFor` on a falsy `secret_ref`, so an empty string
 * is «missing» here too — the importer copies `url_panel` verbatim and only the
 * dashboard's edit route turns '' into NULL. Both spellings of «has a
 * credential» count, for the reason `panelRoutes` counts both: panels wired
 * before `provider_secrets` resolve through the environment.
 *
 * What this cannot see is whether `PANEL_<REF>` is actually set in the process
 * that will deliver. A panel whose variable went missing on a redeploy still
 * passes here and still fails after payment; the dashboard's panel screen is
 * where that shows.
 *
 * One fragment for the shop, the trial list and the support door, so they
 * cannot drift. Over the alias `pr`.
 */
export const PANEL_WIRED_SQL = `
        NULLIF(pr.base_url, '') IS NOT NULL
        AND (
              NULLIF(pr.secret_ref, '') IS NOT NULL
           OR EXISTS (SELECT 1 FROM provider_secrets ps WHERE ps.provider_id = pr.id)
            )`;

/** `setting.limit_usertest_all`, which is 1 in production. */
export const DEFAULT_TRIAL_QUOTA = 1;

/**
 * The trial allowance, where zero means «none» rather than «unset».
 *
 * Capped at 10 for the same reason every other limit is capped: a mistyped
 * row must not become an unbounded giveaway of accounts on a panel that costs
 * real money to run.
 */
export function trialQuota(value: number | null): number {
  if (value === null || !Number.isSafeInteger(value) || value < 0) return DEFAULT_TRIAL_QUOTA;
  return Math.min(value, 10);
}

/**
 * Ten hex characters, the shape production already uses for `payments.public_id`
 * ('b5baf9f689'), so support staff read one format everywhere. Collisions are
 * caught by the UNIQUE index rather than assumed away.
 */
export function newPublicId(): string {
  return randomBytes(5).toString('hex');
}

/**
 * The support door's own switch («تست از پشتیبانی»). Size and length are the
 * panel's trial numbers, read by `trialFor` with its legacy fallbacks — so the
 * two doors can never disagree about what a trial on this panel is.
 */
export function supportTrialFor(config: Record<string, unknown>): TrialSettings {
  return trialFor({ ...config, trial_enabled: config['support_trial_enabled'] === true });
}

/** What the delivery sweep may build for a TRIAL order on this panel: either door. */
export function deliverableTrialFor(config: Record<string, unknown>): TrialSettings {
  const shop = trialFor(config);
  return shop.enabled ? shop : supportTrialFor(config);
}

export interface TrialPanelRow {
  providerId: number;
  name: string;
  shop: TrialSettings;
  support: TrialSettings;
}

/**
 * Every panel this customer could be given a trial on, with both doors' answers.
 *
 * A panel with no address or no credential cannot create an account, and a
 * trial that fails is worse than one never offered — the customer has spent
 * their one free account on nothing. A panel hidden from this customer is
 * hidden here too: a panel they may not buy from is not one they may take a
 * free account on either.
 *
 * The trial settings are read in TypeScript rather than in SQL, because
 * `trialFor` is where the legacy fallbacks and the megabytes live, and a
 * second reading of them in a WHERE clause is exactly the pair that drifts.
 */
export async function trialPanels(db: Db, userId: number): Promise<TrialPanelRow[]> {
  const rows = await db
    .prepare(
      `SELECT pr.id AS provider_id, pr.name AS name, pr.config AS config
         FROM provisioning_providers pr
         JOIN users u ON u.id = ?1
        WHERE pr.status = 'ACTIVE'
          AND ${PANEL_WIRED_SQL}
          AND NOT EXISTS (
                SELECT 1 FROM provider_hidden_users h
                 WHERE h.provider_id = pr.id AND h.user_id = u.id
              )
        ORDER BY pr.sort_order, pr.id`,
    )
    .bind(userId)
    .all<{ provider_id: number; name: string; config: Record<string, unknown> | null }>();
  return (rows.results ?? []).map((r) => ({
    providerId: r.provider_id,
    name: r.name,
    shop: trialFor(r.config ?? {}),
    support: supportTrialFor(r.config ?? {}),
  }));
}

export interface ClaimedTrial {
  id: number;
  publicId: string;
}

/**
 * Spends one trial and writes the free order, or returns null when the quota is gone.
 *
 * Legacy read `limit_usertest`, compared it in PHP and wrote it back
 * (`index.php:3132`), so two taps in one second both passed. Here the
 * comparison IS the WHERE clause: Postgres takes the row lock, and the second
 * statement sees the incremented value and matches nothing.
 *
 * The counter moves BEFORE the order exists, so a failure between the two
 * spends a trial nobody received. That is the safe direction, and it is only
 * reachable inside one transaction — the caller's — so in practice both land
 * or neither does. Failing the other way would hand out unlimited free
 * accounts to anybody who can make an insert fail.
 *
 * `providerId` must come from `trialPanels` for this same customer, never
 * straight from a callback or a request body.
 */
export async function claimTrial(
  tx: D1DatabaseSession,
  userId: number,
  providerId: number,
  quotaPerUser: number,
): Promise<ClaimedTrial | null> {
  if (!Number.isSafeInteger(quotaPerUser) || quotaPerUser <= 0) return null;

  const claimed = await tx
    .prepare(
      `UPDATE users
          SET test_quota_used = test_quota_used + 1, updated_at = now()
        WHERE id = ?1 AND test_quota_used < ?2
        RETURNING test_quota_used`,
    )
    .bind(userId, quotaPerUser)
    .first<{ test_quota_used: number }>();
  if (!claimed) return null;

  const row = await tx
    .prepare(
      // PAID with no payment behind it, which is the whole shape of a free
      // fulfilment: the provisioning sweep reads PAID and does not ask how it
      // got there. completed_at stays null until the sweep sets it.
      `INSERT INTO orders
         (public_id, user_id, kind, provider_id, quantity,
          unit_price_irr, discount_irr, total_irr, status)
       VALUES (?1, ?2, 'TRIAL', ?3, 1, 0, 0, 0, 'PAID')
       RETURNING id, public_id`,
    )
    .bind(newPublicId(), userId, providerId)
    .first<{ id: number; public_id: string }>();
  if (!row) throw new Error('trial order insert returned no row');
  return { id: row.id, publicId: row.public_id };
}

/**
 * `bot/limit_usertest_all` through `trialQuota`, read the way `settings.ts`
 * reads a number: JSON null, '' or a non-number are «unset».
 */
export async function readTrialQuota(db: Db): Promise<number> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE scope = 'bot' AND key = 'limit_usertest_all'`)
    .first<{ value: unknown }>();
  const raw = row?.value;
  if (raw === null || raw === undefined) return trialQuota(null);
  const text = (typeof raw === 'string' ? raw : String(raw)).trim();
  if (text === '') return trialQuota(null);
  const n = Number(text);
  return trialQuota(Number.isFinite(n) ? n : null);
}
