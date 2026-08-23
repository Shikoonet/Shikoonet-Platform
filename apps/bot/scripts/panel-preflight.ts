/**
 * Before cutover: does every plan point at groups that actually exist?
 *
 *   corepack pnpm --filter @shikoo/bot panel:preflight
 *
 * READ-ONLY against every panel. It logs in and issues two GETs. Nothing is
 * created, modified or deleted, no account is read by name, and no customer's
 * data is touched.
 *
 * WHY THIS EXISTS. On 2026-08-16 the delivery chain ran end to end against the
 * live PasarGuard panel for the first time. Creating an account with the
 * migrated configuration — `group_ids: [42, 2]`, carried straight across from
 * the 2026-08-11 dump — came back `404 "Group not found"`. Group 42 had been
 * deleted from the panel some time after the dump was taken. `marzban.ts`
 * classifies that as non-retryable, `provision.ts` turns it into FAILED, and
 * FAILED refunds the wallet in the same transaction. So on the first morning
 * after the switchover every VIP purchase would have failed and refunded in
 * front of the customer, and nothing in the repository would have said a word
 * beforehand.
 *
 * The failure is silent by construction: our configuration is a snapshot of a
 * panel that keeps changing without us. Nothing else in this project checks a
 * live panel against what we intend to send it.
 *
 * WHAT IT CHECKS, and why per plan rather than per panel: `planAttrs` overrides
 * `providerConfig`, so two plans on one panel can send different groups. The
 * body is not rebuilt here — `groupIdsFor` in `marzban.ts` is the same function
 * `provision` calls, so what is checked is what would be sent. A second copy of
 * that precedence rule would agree with itself and drift from the code.
 *
 * Exit code 0 when every configured group exists, 1 when a person needs to
 * look, 2 when the check itself could not run.
 */

import { createPostgresD1 } from '@shikoo/db';
import { adapterFor, groupIdsFor, type ProvisionRequest } from '@shikoo/domain';
import { credentialsFor } from '../src/provision.js';

interface PlanRow {
  plan_id: number;
  plan_name: string;
  product_name: string;
  plan_attrs: Record<string, unknown> | null;
  provider_id: number;
  provider_code: string;
  provider_name: string;
  provider_kind: string;
  provider_base_url: string | null;
  provider_secret_ref: string | null;
  provider_config: Record<string, unknown> | null;
}

/**
 * Every plan a customer could buy today, with the panel it would land on.
 *
 * All three statuses are required: a HIDDEN product's plans are not on sale, and
 * reporting them as broken would train the reader to skip the output. A
 * DISABLED panel is excluded for the same reason — it delivers nothing.
 */
const PLANS_SQL = `
  SELECT pl.id            AS plan_id,
         pl.name          AS plan_name,
         pr.name          AS product_name,
         pl.attrs         AS plan_attrs,
         pv.id            AS provider_id,
         pv.code          AS provider_code,
         pv.name          AS provider_name,
         pv.kind          AS provider_kind,
         pv.base_url      AS provider_base_url,
         pv.secret_ref    AS provider_secret_ref,
         pv.config        AS provider_config
    FROM product_plans pl
    JOIN products pr              ON pr.id = pl.product_id
    JOIN provisioning_providers pv ON pv.id = pr.provider_id
   WHERE pl.status = 'ACTIVE'
     AND pr.status = 'ACTIVE'
     AND pv.status = 'ACTIVE'
     AND pv.kind = 'pasarguard'
   ORDER BY pv.code, pr.name, pl.sort_order, pl.id`;

/**
 * The group ids this panel actually has.
 *
 * A thin wrapper now: the request itself moved onto the adapter as
 * `listGroups`, so this script and «مدیریت پنل‌ها» ask the panel the same
 * question with the same code. It had its own copy until 2026-08-23, which is
 * the drift `groupIdsFor` was extracted to prevent on the other side of exactly
 * this comparison — one half of a check reading the panel differently from the
 * other half is a check that agrees with itself.
 *
 * `error` rather than an empty set when the question cannot be asked. A panel
 * that is down is not a panel with no groups, and reporting the second for the
 * first sends somebody to edit configuration that was correct.
 */
async function panelGroupIds(
  baseUrl: string,
  credentials: { username: string; password: string },
): Promise<{ ids: Set<number> } | { error: string }> {
  const adapter = adapterFor('pasarguard');
  if (!adapter?.listGroups) return { error: 'the pasarguard adapter cannot list groups' };
  const result = await adapter.listGroups({
    id: 0,
    code: 'preflight',
    name: 'preflight',
    baseUrl,
    credentials,
    config: {},
    fetch,
  });
  if (!result.ok) return { error: result.reason };
  return { ids: new Set(result.groups.map((g) => g.id)) };
}

/**
 * The group ids a create for this plan would carry.
 *
 * Everything except `planAttrs` and `providerConfig` is filler — `groupIdsFor`
 * reads only those two — but the request is built in full so that the day
 * somebody makes the group choice depend on the volume or the expiry, this
 * stops compiling instead of quietly checking the wrong thing.
 */
function intendedGroups(row: PlanRow): unknown {
  const request: ProvisionRequest = {
    username: 'preflight',
    volumeGb: null,
    durationDays: null,
    note: 'preflight',
    providerConfig: row.provider_config ?? {},
    planAttrs: row.plan_attrs ?? {},
    expiresAt: null,
  };
  return groupIdsFor(request);
}

async function main(): Promise<number> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required');
    return 2;
  }
  const { db, pool } = createPostgresD1({ connectionString: url });
  let rows: PlanRow[];
  try {
    rows = (await db.prepare(PLANS_SQL).all<PlanRow>()).results ?? [];
  } finally {
    // The panel calls below take seconds each; holding a pool open past the one
    // query it was for is how a script ends up waiting on its own connection.
    await pool.end();
  }
  if (rows.length === 0) {
    console.error('no active plan reaches an active pasarguard panel — nothing to check');
    return 2;
  }

  const byPanel = new Map<string, PlanRow[]>();
  for (const row of rows) {
    const list = byPanel.get(row.provider_code);
    if (list) list.push(row);
    else byPanel.set(row.provider_code, [row]);
  }

  let problems = 0;
  for (const [code, plans] of byPanel) {
    const first = plans[0]!;
    const label = `${code} — ${first.provider_name}`;
    console.log(`\n${label}   (${plans.length} plan${plans.length === 1 ? '' : 's'})`);

    if (!first.provider_base_url) {
      console.log('  ✗ no base_url configured — every order on this panel fails and refunds');
      problems += plans.length;
      continue;
    }
    const credentials = credentialsFor(first.provider_secret_ref);
    if (!credentials) {
      const ref = first.provider_secret_ref;
      console.log(
        ref
          ? `  ✗ PANEL_${ref.toUpperCase().replace(/[^A-Z0-9]/g, '_')} is not set in this environment`
          : "  ✗ no secret_ref — nothing names this panel's credentials",
      );
      problems += plans.length;
      continue;
    }

    const groups = await panelGroupIds(first.provider_base_url, credentials);
    if ('error' in groups) {
      console.log(`  ✗ ${groups.error}`);
      problems += plans.length;
      continue;
    }
    const have = [...groups.ids].sort((a, b) => a - b);
    console.log(`  panel has groups: ${have.length > 0 ? have.join(', ') : '(none)'}`);

    for (const plan of plans) {
      const intended = intendedGroups(plan);
      // The importer gave every migrated plan its product's name, so joining the
      // two prints the same sentence twice and pushes the verdict off the line.
      const name =
        plan.product_name === plan.plan_name
          ? plan.plan_name
          : `${plan.product_name} · ${plan.plan_name}`;
      if (intended === undefined) {
        // Not a fault. The panel decides, exactly as it does for a plan that
        // was always meant to inherit the panel's default group.
        console.log(`  · ${name} — sends no group_ids`);
        continue;
      }
      if (!Array.isArray(intended)) {
        console.log(`  ✗ ${name} — group_ids is not a list: ${JSON.stringify(intended)}`);
        problems += 1;
        continue;
      }
      const missing = intended.filter((id) => typeof id !== 'number' || !groups.ids.has(id));
      if (missing.length === 0) {
        console.log(`  ✓ ${name} — ${JSON.stringify(intended)}`);
      } else {
        console.log(
          `  ✗ ${name} — sends ${JSON.stringify(intended)}, panel does not have ${JSON.stringify(missing)}`,
        );
        problems += 1;
      }
    }
  }

  console.log('');
  if (problems === 0) {
    console.log('every active plan points at groups this panel has.');
    return 0;
  }
  console.log(`${problems} plan${problems === 1 ? '' : 's'} would fail on delivery and refund.`);
  console.log('fix the configuration before cutover — a customer sees this as a failed purchase.');
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
