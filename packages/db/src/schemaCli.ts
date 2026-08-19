/**
 * The schema ledger, from a terminal.
 *
 *   corepack pnpm --filter @shikoo/db schema status
 *   corepack pnpm --filter @shikoo/db schema up
 *   corepack pnpm --filter @shikoo/db schema baseline 0021_operator_auth.sql
 *
 * `DATABASE_URL` has no default, for the reason `packages/migrate` gives: this
 * writes DDL into whatever it is pointed at, and a destination it invents for
 * itself is a destination it can silently target on the night somebody forgets
 * to export one.
 *
 * Exit codes are the point of `status`: 0 when the database matches the
 * checkout, 1 when it does not. That makes it usable as a pre-deploy gate
 * rather than something a person has to read.
 *
 * `gate` asks the narrower question a starting container asks — see
 * `gateReasons`. It is what `deploy/entrypoint.sh` runs, and it differs from
 * `status` in exactly one case: a database ahead of the checkout is a warning
 * rather than a refusal, because that case is a rollback.
 */

import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { baseline, gateReasons, status, up } from './schema.js';

const DEFAULT_DIR = fileURLToPath(new URL('../../../migrations', import.meta.url));

function actor(): string {
  return process.env['USER'] ?? process.env['USERNAME'] ?? 'unknown';
}

async function main(): Promise<number> {
  const [cmd, arg] = process.argv.slice(2);
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) {
    console.error('DATABASE_URL is required: this applies DDL, so it is never guessed.');
    return 2;
  }
  const dir = process.env['MIGRATIONS_DIR'] ?? DEFAULT_DIR;
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    switch (cmd) {
      case 'status': {
        const s = await status(client, dir);
        console.log(`applied  ${s.applied.length}`);
        console.log(`pending  ${s.pending.length}${s.pending.length ? '  ' + s.pending.join(', ') : ''}`);
        for (const d of s.drifted) {
          console.error(`DRIFT    ${d.name} — applied ${d.expected.slice(0, 12)}, on disk ${d.found.slice(0, 12)}`);
        }
        for (const u of s.unknown) {
          console.error(`UNKNOWN  ${u} — applied here but not in this checkout`);
        }
        const clean = s.pending.length === 0 && s.drifted.length === 0 && s.unknown.length === 0;
        console.log(clean ? 'schema is current' : 'schema does NOT match this checkout');
        return clean ? 0 : 1;
      }
      case 'gate': {
        const { blocking, warnings } = gateReasons(await status(client, dir));
        for (const w of warnings) console.warn(`WARN  ${w}`);
        if (blocking.length === 0) {
          console.log('schema is safe to start on');
          return 0;
        }
        for (const b of blocking) console.error(`BLOCK ${b}`);
        console.error('refusing to start: apply the migrations first (SERVICE=migrate, or the schema CLI)');
        return 1;
      }
      case 'up': {
        const r = await up(client, dir, actor());
        if (r.alreadyCurrent) console.log('nothing to apply');
        else for (const n of r.applied) console.log(`applied  ${n}`);
        return 0;
      }
      case 'baseline': {
        if (!arg) {
          console.error('baseline needs the last migration this database already has');
          return 2;
        }
        const marked = await baseline(client, dir, arg, actor());
        console.log(`recorded ${marked.length} migration(s) as already applied, through ${arg}`);
        return 0;
      }
      default:
        console.error('usage: schema <status|gate|up|baseline <name>>');
        return 2;
    }
  } finally {
    await client.end();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  },
);
