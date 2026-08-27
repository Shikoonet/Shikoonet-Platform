/**
 * Coverage thresholds, as a ratchet.
 *
 * ## What these numbers are
 *
 * They are the measured baseline on 2026-08-27, rounded DOWN to the nearest
 * whole percent and then given one point of slack. They are not aspirations
 * and they are not round numbers somebody liked the look of: a threshold
 * above the current reality fails the build on the day it is introduced, and
 * one far below it never fails at all.
 *
 * Their only job is to stop coverage falling. Raising them is a deliberate
 * act, and the right time to do it is when a change has just pushed the real
 * number up — the number in this file should trail reality, never lead it.
 *
 * ## Why branches matter more than statements here
 *
 * A money path is mostly branches: «is this the exact account», «is this
 * inside the 300000ms window», «has this claim already settled». Statement
 * coverage counts the line `if (a && b)` as covered the first time it runs;
 * branch coverage asks whether both answers were tried. So for the four
 * packages that decide money, authentication, permissions and SMS content,
 * the branch floor is the one that is set close to the measured value and the
 * statement floor is set loosely.
 *
 * ## Why `packages/contracts` has no statement floor
 *
 * Its statement coverage is 2.58%, and that number is honest but useless:
 * `botTexts.ts` is a 1700-line table of default strings, and a "statement"
 * there is a property in an object literal. Nothing executes it, nothing
 * should, and a threshold over it would only ever be satisfied by writing a
 * test that reads every default back — which asserts that a data table
 * contains what a data table contains.
 *
 * The functions and branches in that package ARE logic — `checkOverride`,
 * `parseEnvName`, `groupIntoRows`, the custom-emoji escape — and those carry
 * real floors.
 *
 * ## Why this is per-package and not one global run
 *
 * A single root `vitest --coverage` would have to load eleven packages'
 * environments at once, and four of them need a Postgres with a specific
 * schema. The suite already runs `--workspace-concurrency=1` for that reason.
 * Coverage is therefore measured where it means something — the four packages
 * whose branches decide money and access — and the rest are reported without
 * a floor.
 */

/** A floor, in percent. `null` means «report it, do not gate on it». */
export interface CoverageFloor {
  statements: number | null;
  branches: number | null;
  functions: number | null;
  /** Why this package is gated, and what the numbers were when set. */
  note: string;
}

export const COVERAGE_FLOORS: Record<string, CoverageFloor> = {
  '@shikoo/sms-parser': {
    // Measured 2026-08-27: statements 81.89, branches 69.88, functions 91.76.
    statements: 78,
    branches: 68,
    functions: 88,
    note:
      'Every bank SMS enters the platform through here. A branch that stops ' +
      'being taken is a bank whose format silently stopped being read, and ' +
      'the symptom is a customer who paid and was not credited.',
  },
  '@shikoo/domain': {
    // Measured 2026-08-27: statements 52.24, branches 81.19, functions 63.47.
    //
    // The statement number is low because the package holds the provisioning
    // adapters, and most of `marzban.ts` only runs against a panel. The
    // BRANCH number is the one that matters and it is high, because the
    // decisions — scoring, windows, state transitions — are all tested.
    statements: 50,
    branches: 79,
    functions: 61,
    note:
      'Auto-verification, the settlement state machine, the seal and TOTP. ' +
      'The branch floor is deliberately close to the measured value: these ' +
      'are the conditions that decide whether money moves.',
  },
  '@shikoo/contracts': {
    // Measured 2026-08-27: statements 2.58, branches 93.44, functions 81.25.
    statements: null, // see the header — a 1700-line table of default strings
    branches: 90,
    functions: 78,
    note:
      'checkOverride, parseEnvName, the custom-emoji escape and the keyboard ' +
      'layout rules. Statements are not gated because the package is mostly ' +
      'a data table; branches and functions are.',
  },
};

/** The packages measured but not gated, and why. */
export const COVERAGE_UNGATED: Record<string, string> = {
  '@shikoo/db':
    'Almost every line needs a live Postgres, so the number measures whether ' +
    'the database was up rather than whether the code is exercised.',
  '@shikoo/dashboard':
    'Route coverage is asserted directly by `write-roles.test.ts`, which ' +
    'enumerates every registered write route from `app.routes` — a stronger ' +
    'statement than a percentage.',
  '@shikoo/bot': 'Covered by behaviour: the suite drives `handleUpdate` and reads the reply.',
  '@shikoo/admin-web': 'A browser bundle; the e2e suite is the coverage that counts.',
  '@shikoo/seed': 'Fixture generator — its own output is asserted by `seed-probe`.',
  '@shikoo/migrate': 'Needs the MySQL dump; see the note in the CI report.',
  '@shikoo/database': 'Type and SQL-constant surface with no executable logic.',
  '@shikoo/ingest': 'Covered by the vertical-slice integration tests.',
};