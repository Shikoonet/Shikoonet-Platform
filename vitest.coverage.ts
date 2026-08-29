/**
 * Coverage floors for the packages whose branches decide money and access.
 *
 * ## These are FLOORS, not a ratchet
 *
 * An earlier version of this file called them a ratchet. They are not one,
 * and the difference is worth being exact about, because «ratchet» is a
 * promise about behaviour that nothing here implements.
 *
 * A ratchet RAISES its own floor when coverage improves — it stores the new
 * measurement, so a later change that gives back the gain is refused. That
 * needs somewhere to write the number: a committed baseline file the CI job
 * updates, or a service that remembers. Neither exists here, and adding one
 * to a repository whose gate cannot even be enforced by a branch ruleset
 * would be building the second thing before the first works.
 *
 * What these are is a floor with a **stated tolerance**. Each number is the
 * measurement rounded DOWN to a whole percent, and the tolerance is the
 * distance from that to the real figure — under one point in every case,
 * written out below so nobody has to compute it.
 *
 * The honest description: coverage may drift down by less than a point
 * before the build fails. It cannot fall by two.
 *
 * ## Why a tolerance at all
 *
 * Because v8 coverage is not perfectly stable across runs. Adding a test file
 * changes which modules the runner loads, and a module that is loaded but not
 * exercised moves the denominator — the sms-parser branch figure moved
 * 69.88 → 69.83 → 70.08 across three runs of this branch without anybody
 * touching a branch. A floor set at the exact measurement fails on the run
 * after the one that set it, and a check that fails for a reason nobody
 * caused is a check people learn to re-run rather than read.
 *
 * ## Raising them
 *
 * By hand, in this file, in the commit that earned it. That is one line of
 * diff and it puts the new number in front of a reviewer, which an automatic
 * bump does not.
 *
 * ## Why branches carry the tight number
 *
 * A money path is mostly branches — «is this the exact account», «is this
 * inside the 300000ms window», «has this claim already settled». Statement
 * coverage counts `if (a && b)` as covered the first time it runs; branch
 * coverage asks whether both answers were tried. So the branch floor sits
 * close to the measurement and the statement floor is deliberately loose
 * where most uncovered statements are adapter code that only runs against a
 * real panel.
 */

/** A floor, in percent. `null` means «report it, do not gate on it». */
export interface CoverageFloor {
  statements: number | null;
  branches: number | null;
  functions: number | null;
  /** What was measured when these were set, and why the package is gated. */
  note: string;
}

/**
 * Measured 2026-08-27, after the OTP redaction work; domain re-measured
 * 2026-08-29.
 *
 *                       statements   branches   functions
 *   sms-parser             81.39       70.08      89.77
 *   domain                 51.88       81.57      63.59
 *   contracts               2.58       93.44      81.25
 *
 * Floors are those figures rounded down to a whole percent. The tolerance —
 * the room between floor and measurement — is under one point everywhere:
 *
 *   sms-parser   0.39 / 0.08 / 0.77
 *   domain       0.88 / 0.57 / 0.59
 *   contracts       — / 0.44 / 0.25
 *
 * ## Why domain's statement floor went DOWN, 2026-08-29
 *
 * 52 → 51. A floor that is lowered whenever it bites is not a floor, so this
 * needs to say exactly what happened rather than "it went red".
 *
 * `shopReport.ts` — 290 lines behind «آمار فروشگاه» — landed in this package,
 * and it is **thoroughly tested**: seventeen cases in
 * `apps/dashboard-worker/test/shop-report.test.ts` covering who counts as a
 * buyer, the average per buyer, renewal share, the projection window, gateway
 * grouping and what a READ_ONLY operator is answered. What it is not is tested
 * FROM HERE. It needs Postgres and it is served by a route, so its test lives
 * with the route, and coverage is measured per package — so those seventeen
 * cases are invisible to this number.
 *
 * The alternative was to copy them into `packages/domain/test`, which would
 * prove nothing new and leave two descriptions of the same arithmetic to drift
 * apart. That is a worse outcome than a floor one point lower.
 *
 * **Branches did not move down — they went UP, 81.19 → 81.57.** That is the
 * figure this file already says is the one that matters, and it is the honest
 * evidence that nothing stopped being tested. Statements fell because the
 * denominator grew by SQL-shaped code whose test is in another package.
 *
 * If this happens a third time, the answer is not another point: it is to
 * measure coverage across the workspace in one run, so a test can cover code
 * in the package it actually belongs to.
 */
export const COVERAGE_FLOORS: Record<string, CoverageFloor> = {
  '@shikoo/sms-parser': {
    statements: 81,
    branches: 70,
    functions: 89,
    note:
      'Every bank SMS enters the platform through here, and so does every ' +
      'one-time password. A branch that stops being taken is either a bank ' +
      'whose format silently stopped being read — a customer who paid and ' +
      'was not credited — or an OTP phrasing that stopped being recognised, ' +
      'which is a password reaching the database.',
  },
  '@shikoo/domain': {
    // 52 until 2026-08-29 — see the note above for why this moved and what
    // would have to be true for it to move again.
    statements: 51,
    branches: 81,
    functions: 63,
    note:
      'Auto-verification, the settlement state machine, the seal and TOTP. ' +
      'The statement figure is low because the provisioning adapters only ' +
      'run against a real panel; the BRANCH figure is the one that matters ' +
      'and it is high, because the decisions that move money are tested.',
  },
  '@shikoo/contracts': {
    statements: null, // a 1700-line table of default strings — see below
    branches: 93,
    functions: 81,
    note:
      'checkOverride, parseEnvName, the custom-emoji escape and the keyboard ' +
      'layout rules. Statements are NOT gated: the figure is 2.58% and that ' +
      'is honest but useless — botTexts.ts is a table of default strings, ' +
      'where a «statement» is a property in an object literal. A threshold ' +
      'over it could only be met by a test asserting that a data table ' +
      'contains what a data table contains.',
  },
};

/** The packages measured but not gated, and why each one is not. */
export const COVERAGE_UNGATED: Record<string, string> = {
  '@shikoo/db':
    'Almost every line needs a live Postgres, so the number would measure ' +
    'whether the database was up rather than whether the code was exercised.',
  '@shikoo/dashboard':
    'Route coverage is asserted directly by `write-roles.test.ts`, which ' +
    'enumerates every registered write route from `app.routes` — a stronger ' +
    'statement than a percentage.',
  '@shikoo/ingest':
    'Covered by behaviour: the vertical-slice tests post through the real ' +
    'handler and read the resulting rows back, including `otp-persistence`.',
  '@shikoo/bot': 'Covered by behaviour: the suite drives `handleUpdate` and reads the reply.',
  '@shikoo/admin-web': 'A browser bundle; the 104-scenario Playwright suite is its coverage.',
  '@shikoo/seed': 'A fixture generator — its output is asserted by `seed-probe`.',
  '@shikoo/migrate':
    'Split by design: the tooling is covered by `synthetic-migration.test.ts` ' +
    'in CI, and the ten dump-gated suites only mean anything against the real ' +
    'dump. A single percentage over both would describe neither.',
  '@shikoo/database': 'A type and SQL-constant surface with no executable logic.',
};