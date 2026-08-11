/**
 * Migration CLI.
 *
 *   pnpm --filter @shikoo/migrate preflight   read both sources, check, write nothing
 *   pnpm --filter @shikoo/migrate migrate     preflight, then migrate, then verify
 *   pnpm --filter @shikoo/migrate verify      compare the two sides again
 *
 * `migrate` refuses to run if pre-flight reports a blocker. Pass --force only
 * when a human has read the blockers and decided they are acceptable — it is
 * recorded in the output so the decision is never invisible.
 */

import { connectMysql, connectPostgres, loadConfig, report } from './db.js';
import { migrate } from './migrate.js';
import { preflight, summarise } from './preflight.js';
import { verify } from './verify.js';

const command = process.argv[2] ?? 'preflight';
const force = process.argv.includes('--force');

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
        await migrate(cfg, my, pgc);
        return (await verify(cfg, my, pgc)) ? 0 : 1;
      }

      case 'verify':
        return (await verify(cfg, my, pgc)) ? 0 : 1;

      default:
        console.error(`unknown command: ${command}`);
        console.error('usage: cli.ts <preflight|migrate|verify> [--force]');
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
