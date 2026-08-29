/**
 * Migration CLI.
 *
 *   pnpm --filter @shikoo/migrate preflight   read both sources, check, write nothing
 *   pnpm --filter @shikoo/migrate migrate     preflight, then migrate, then verify
 *   pnpm --filter @shikoo/migrate verify      compare the two sides again
 *
 * `--dry-run` runs every step against the real tables and then rolls back, so
 * the constraints that matter are the ones actually enforced.
 * `--domains=core,sales` narrows the run; the default is every domain.
 *
 * `migrate` refuses to run if pre-flight reports a blocker. Pass --force only
 * when a human has read the blockers and decided they are acceptable — it is
 * recorded in the output so the decision is never invisible.
 */

import { connectMysql, connectPostgres, loadConfig, report } from './db.js';
import { DOMAINS, migrate, type Domain } from './migrate.js';
import { preflight, summarise } from './preflight.js';
import { verify } from './verify.js';

const command = process.argv[2] ?? 'preflight';
const force = process.argv.includes('--force');
const dryRun = process.argv.includes('--dry-run');

/**
 * `--domains=core,sales`. Absent means every domain, so the CLI keeps doing
 * exactly what it did before this flag existed.
 */
function selectedDomains(): Domain[] | undefined {
  const arg = process.argv.find((a) => a.startsWith('--domains='));
  if (arg === undefined) return undefined;
  const names = arg.slice('--domains='.length).split(',').filter(Boolean);
  const unknown = names.filter((n) => !DOMAINS.includes(n as Domain));
  if (unknown.length > 0) {
    throw new Error(`unknown domain(s): ${unknown.join(', ')}. Known: ${DOMAINS.join(', ')}`);
  }
  return names as Domain[];
}

async function main(): Promise<number> {
  const cfg = loadConfig();
  const my = await connectMysql(cfg);
  const pgc = await connectPostgres(cfg);

  try {
    switch (command) {
      case 'preflight': {
        const findings = await preflight(cfg, my, pgc);
        return summarise(findings) ? 0 : 1;
      }

      case 'migrate': {
        const findings = await preflight(cfg, my, pgc);
        const safe = summarise(findings);
        if (!safe && !force) return 1;
        if (!safe) report.warn('--force: proceeding despite blockers');
        const domains = selectedDomains();
        await migrate(cfg, my, pgc, { commit: !dryRun, ...(domains ? { domains } : {}) });
        // A dry run has already rolled back, so there is nothing on the target
        // to compare against and `verify` would report every total as missing.
        if (dryRun) {
          report.warn('dry run: rolled back, so verification was not run');
          return 0;
        }
        return (await verify(cfg, my, pgc, domains)) ? 0 : 1;
      }

      case 'verify':
        return (await verify(cfg, my, pgc, selectedDomains())) ? 0 : 1;

      default:
        console.error(`unknown command: ${command}`);
        console.error(
      'usage: cli.ts <preflight|migrate|verify> [--force] [--dry-run] [--domains=a,b]',
    );
        return 2;
    }
  } finally {
    await my.end();
    await pgc.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    report.fail(err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack) console.error(err.stack);
    process.exit(1);
  },
);
