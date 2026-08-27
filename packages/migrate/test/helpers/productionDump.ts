/**
 * Is the PRODUCTION dump loaded, as opposed to any MySQL at all?
 *
 * ## Why this exists
 *
 * The ten `*.mysql.test.ts` files gated themselves on «can I connect to a
 * MySQL». That was a proxy for «do I have the real dump», and it held for as
 * long as the only MySQL anyone ever ran was the one the dump initialises.
 *
 * `synthetic-migration.test.ts` broke the proxy on purpose: it loads a
 * synthetic legacy database so the migration TOOLING can be exercised in CI.
 * The moment that existed, a MySQL was reachable on a runner, all ten
 * un-skipped, and they failed on assertions like
 *
 *     expected 2 to be 31          (expired discount codes)
 *     expected 2 to be greater than 100   (customers)
 *
 * which is them working correctly. Those numbers are the point of those
 * tests: they are statements about the ACTUAL dataset that is going to be
 * migrated, and rewriting them to match a fixture would turn a
 * data-migration acceptance check into a test that asserts a fixture
 * contains what the fixture contains.
 *
 * So the predicate now says what it means. Two flags, two questions:
 *
 *     MIGRATE_FIXTURE_MYSQL=1     a synthetic legacy DB is loaded
 *                                 → `synthetic-migration.test.ts` runs
 *                                 → set by CI
 *
 *     MIGRATE_PRODUCTION_DUMP=1   the real dump is loaded
 *                                 → the ten run
 *                                 → set on the machine that holds it, never
 *                                   in CI, because CI must never see it
 *
 * ## Why not detect it by counting rows
 *
 * «more than a hundred users means it is production» would work today and is
 * the wrong shape: it decides what a database IS by looking at how much is in
 * it, so a fixture that grew, or a production dump taken early in the shop's
 * life, would both be misread — silently, and in the direction that runs
 * production assertions against synthetic data.
 *
 * An explicit flag is a person saying which database this is. That is the
 * only thing that can actually know.
 */

/**
 * Whether the ten dump-gated suites should run.
 *
 * `undefined` when they should, a sentence explaining why not when they
 * should not — so the caller can put the reason in `describe.skipIf`'s
 * message rather than skipping in silence.
 */
export function productionDumpAbsent(): string | null {
  if (process.env['MIGRATE_PRODUCTION_DUMP'] === '1') return null;
  return (
    'MIGRATE_PRODUCTION_DUMP is not set. These assertions are about the real ' +
    'Mirzabot dataset (row counts, real discount codes, the 963 customers who ' +
    'never accepted the rules), so they only mean anything against the dump ' +
    'itself. Load it and export MIGRATE_PRODUCTION_DUMP=1 to run them. The ' +
    'migration TOOLING is covered in CI by synthetic-migration.test.ts.'
  );
}
