/**
 * ایمپورت میرزابات — running the MySQL→Postgres migration from the panel.
 *
 * ## This file does not contain a migration
 *
 * `packages/migrate` is one: 18 steps in a single transaction, idempotent on
 * the legacy natural keys, with a `preflight` that refuses to start on a
 * blocker and a `verify` that rejects the whole run over one Rial. It is
 * exercised against the real production dump by ten test suites. Nothing here
 * re-implements any of that, and nothing here may: a transform rewritten in
 * this file is a bug already fixed over there, brought back.
 *
 * What was missing was a way to run it without a terminal, which is what an
 * admin doing a cutover has.
 *
 * ## The dump is not uploaded
 *
 * It is read from `IMPORT_DIR` on the server, put there over SCP. Three
 * problems disappear with that: nginx's 1 MB body limit and 60 s proxy
 * timeout, neither of which is configured in this repository; and a file
 * holding `marzban_panel.password_panel`, `admin.password` and roughly ten live
 * gateway keys in plaintext never crosses a browser.
 *
 * The client names a FILE, never a path. `resolveDump` refuses anything with a
 * separator in it and then checks the resolved result is still inside the
 * directory, because a name is attacker-controlled input at a trust boundary
 * even when the attacker has to be a signed-in admin first.
 *
 * ## Why the work is not in the request
 *
 * A full import is minutes of work over ~29,000 rows. The handler records a
 * row, starts the run and returns its id; the browser polls. There is no queue
 * and no scheduler, and adding one would buy only crash-resumption — which the
 * transaction already provides in a stronger form. A dashboard that dies half
 * way through leaves the database untouched, not half-imported.
 */

import { randomUUID } from 'node:crypto';
import { readdirSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import {
  captureReport,
  configFrom,
  connectMysql,
  connectPostgres,
  loadDump,
  migrate,
  preflight,
  summarise,
  verify,
  targetBaseline,
  DOMAINS,
  PANEL_DEFAULT_DOMAINS,
  type Domain,
  type ReportLine,
} from '@shikoo/migrate';
import { createLogger } from '@shikoo/domain';
import { audit, type Ident } from './adminAudit.js';

const log = createLogger('dashboard.import');

type Env = { DB: D1Database; IMPORT_DIR?: string; IMPORT_MYSQL_URL?: string };

/**
 * A run left RUNNING by a process that is no longer here.
 *
 * Nothing else can start while one exists, so it cannot simply be left. Two
 * hours is far past any real import — the production dump takes seconds — and
 * far short of a working day, so a stuck row clears itself without anybody
 * having to learn a maintenance command.
 */
const STALE_RUN_MS = 2 * 60 * 60 * 1000;

/** The scratch database the dump is loaded into. Never the platform's own. */
const SCRATCH_DATABASE = 'mirzabot_import';

const RunBody = z
  .object({
    file: z.string().min(1).max(255),
    domains: z.array(z.enum(DOMAINS as unknown as [Domain, ...Domain[]])).optional(),
  })
  .strict();

export interface DumpFile {
  name: string;
  bytes: number;
  modifiedAt: string;
}

/**
 * Turns a client-supplied name into a path inside `dir`, or throws.
 *
 * Two independent checks, because either alone has been enough to fail
 * somewhere: the name must be a bare basename, AND the resolved path must still
 * sit under the resolved directory. The second catches what the first would
 * miss on a platform whose separator rules surprise us.
 */
export function resolveDump(dir: string, name: string): string {
  if (name !== basename(name) || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw new Error('file must be a name inside the import directory, not a path');
  }
  if (!name.endsWith('.sql') && !name.endsWith('.sql.gz')) {
    throw new Error('file must be a .sql or .sql.gz dump');
  }
  const root = resolve(dir);
  const full = resolve(root, name);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error('resolved path escapes the import directory');
  }
  return full;
}

export function listDumps(dir: string): DumpFile[] {
  return readdirSync(dir)
    .filter((n) => n.endsWith('.sql') || n.endsWith('.sql.gz'))
    .flatMap((name) => {
      const st = statSync(resolve(dir, name));
      if (!st.isFile()) return [];
      return [{ name, bytes: st.size, modifiedAt: new Date(st.mtimeMs).toISOString() }];
    })
    .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
}

/** `mysql://user:pass@host:port` — the scratch server the dump is loaded into. */
function scratchMysql(url: string): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
} {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: u.port === '' ? 3306 : Number(u.port),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: SCRATCH_DATABASE,
  };
}

type Mode = 'PREFLIGHT' | 'DRY_RUN' | 'APPLY';

interface RunOutcome {
  ok: boolean;
  report: ReportLine[];
  samples: Record<string, unknown>;
  error: string | null;
  dump: { sha256: string; bytes: number } | null;
}

/**
 * Loads the dump and runs the requested phase.
 *
 * Writes nothing to Postgres of its own — `migrate` owns the transaction, and
 * it either commits everything or leaves the database exactly as it found it.
 */
async function runImport(
  mode: Mode,
  dumpPath: string,
  domains: Domain[],
  mysqlUrl: string,
  postgresUrl: string,
): Promise<RunOutcome> {
  const lines: ReportLine[] = [];
  const release = captureReport(lines);
  const cfg = configFrom({
    mysql: scratchMysql(mysqlUrl),
    postgres: { connectionString: postgresUrl },
    // No D1 export beside a panel-driven import, so the hub domain stands down
    // rather than failing: `d1Table` reads an absent export as zero rows.
  });

  let my: Awaited<ReturnType<typeof connectMysql>> | null = null;
  let pgc: Awaited<ReturnType<typeof connectPostgres>> | null = null;
  try {
    const loaded = await loadDump(cfg, dumpPath);
    const dump = { sha256: loaded.sha256, bytes: loaded.bytes };
    my = await connectMysql(cfg);
    pgc = await connectPostgres(cfg);

    const findings = await preflight(cfg, my, pgc);
    if (!summarise(findings)) {
      return {
        ok: false,
        report: lines,
        samples: {},
        error: 'preflight reported a blocker; nothing was run',
        dump,
      };
    }
    if (mode === 'PREFLIGHT') {
      return { ok: true, report: lines, samples: {}, error: null, dump };
    }

    // What the target already held, taken before a single row is written.
    //
    // `verify` compares whole-table totals, which is right for a cutover into
    // an empty database and wrong for the merge this panel performs: on a
    // database holding anything at all, every total would read as off by
    // whatever was already there. Subtracting the baseline makes the check
    // about what THIS import moved.
    const baseline = await targetBaseline(pgc);

    const result = await migrate(cfg, my, pgc, {
      commit: mode === 'APPLY',
      domains,
      samples: 5,
      // A dry run verifies inside its own transaction, while the rows still
      // exist. This is the whole reason a dry run means anything: a run that
      // resolves every owner to null throws nothing and reports ok on every
      // line, and only the counts and the money catch it.
      ...(mode === 'DRY_RUN'
        ? { beforeSettle: () => verify(cfg, my!, pgc!, domains, baseline) }
        : {}),
    });
    const ok =
      mode === 'APPLY' ? await verify(cfg, my, pgc, domains, baseline) : result.verified;
    return {
      ok,
      report: lines,
      samples: result.samples,
      error: ok ? null : 'verification failed: the two sides do not agree',
      dump,
    };
  } finally {
    release();
    if (my) await my.end().catch(() => undefined);
    if (pgc) await pgc.end().catch(() => undefined);
  }
}

export function registerImportRoutes(app: Hono<{ Bindings: Env; Variables: { identity: Ident } }>) {
  for (const [suffix, mode] of [
    ['preflight', 'PREFLIGHT'],
    ['dry-run', 'DRY_RUN'],
    ['apply', 'APPLY'],
  ] as const) {
    app.post(`/api/v1/admin/import/${suffix}`, async (c) => {
      const ident = c.get('identity');
      if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

      const parsed = RunBody.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
      const domains = [...(parsed.data.domains ?? PANEL_DEFAULT_DOMAINS)];

      const dir = c.env.IMPORT_DIR ?? process.env['IMPORT_DIR'];
      const mysqlUrl = c.env.IMPORT_MYSQL_URL ?? process.env['IMPORT_MYSQL_URL'];
      const postgresUrl = process.env['DATABASE_URL'];
      if (dir === undefined || mysqlUrl === undefined || postgresUrl === undefined) {
        return c.json(
          {
            ok: false,
            error: 'import_not_configured',
            detail: 'IMPORT_DIR و IMPORT_MYSQL_URL روی سرور تنظیم نشده‌اند.',
          },
          503,
        );
      }

      let dumpPath: string;
      try {
        dumpPath = resolveDump(dir, parsed.data.file);
        if (!statSync(dumpPath).isFile()) throw new Error('not a file');
      } catch {
        return c.json({ ok: false, error: 'invalid_file' }, 400);
      }

      // An APPLY is gated on a dry run of the same file having passed. That is
      // not ceremony: the dry run IS the real migration measured against the
      // real constraints, so this is the difference between "we think this
      // imports" and "this imported, and we threw the result away".
      if (mode === 'APPLY') {
        const proven = await c.env.DB.prepare(
          `SELECT id FROM import_runs
            WHERE mode = 'DRY_RUN' AND status = 'SUCCEEDED' AND dump_path = ?1
            ORDER BY started_at DESC LIMIT 1`,
        )
          .bind(dumpPath)
          .first<{ id: string }>();
        if (!proven) {
          return c.json(
            {
              ok: false,
              error: 'dry_run_required',
              detail: 'اول یک اجرای آزمایشی موفق روی همین فایل لازم است.',
            },
            409,
          );
        }
      }

      // Clear a run abandoned by a process that is gone, so one crash does not
      // block every future import.
      await c.env.DB.prepare(
        `UPDATE import_runs
            SET status = 'FAILED', finished_at = now(),
                error = 'the process ended before the import finished'
          WHERE status = 'RUNNING' AND started_at < now() - make_interval(secs => ?1)`,
      )
        .bind(STALE_RUN_MS / 1000)
        .run();

      const id = randomUUID();
      try {
        await c.env.DB.prepare(
          `INSERT INTO import_runs (id, mode, status, dump_path, domains, started_by)
           VALUES (?1, ?2, 'RUNNING', ?3, ?4::jsonb, ?5)`,
        )
          .bind(id, mode, dumpPath, JSON.stringify(domains), ident.email)
          .run();
      } catch {
        // `idx_import_runs_one_active` refused it. The guard is the index, not
        // a count this handler took a moment earlier and then acted upon.
        return c.json(
          {
            ok: false,
            error: 'import_already_running',
            detail: 'یک ایمپورت در حال اجراست؛ تا پایانش صبر کن.',
          },
          409,
        );
      }

      await audit(
        c.env.DB,
        ident,
        `import.${mode.toLowerCase()}`,
        'IMPORT_RUN',
        id,
        null,
        { file: basename(dumpPath), domains },
        null,
      );

      // Deliberately not awaited: the run outlives this request. Every failure
      // path inside settles the row, so a RUNNING row always ends.
      void (async () => {
        try {
          const outcome = await runImport(mode, dumpPath, domains, mysqlUrl, postgresUrl);
          await c.env.DB.prepare(
            `UPDATE import_runs
                SET status = ?2, finished_at = now(), report = ?3::jsonb,
                    samples = ?4::jsonb, error = ?5, dump_sha256 = ?6, dump_bytes = ?7
              WHERE id = ?1`,
          )
            .bind(
              id,
              outcome.ok ? 'SUCCEEDED' : 'FAILED',
              JSON.stringify(outcome.report),
              JSON.stringify(outcome.samples),
              outcome.error,
              outcome.dump?.sha256 ?? null,
              outcome.dump?.bytes ?? null,
            )
            .run();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log.error('import.failed', { runId: id, mode, error: message });
          await c.env.DB.prepare(
            `UPDATE import_runs SET status='FAILED', finished_at=now(), error=?2 WHERE id=?1`,
          )
            .bind(id, message)
            .run()
            .catch(() => undefined);
        }
      })();

      return c.json({ ok: true, id, mode, domains });
    });
  }

  // ADMIN for reads as well as writes: a run report is the whole shop's shape,
  // and `access.ts` keeps the same path out of a READ_ONLY sidebar.
  app.get('/api/v1/admin/import/files', (c) => {
    if (c.get('identity').role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const dir = c.env.IMPORT_DIR ?? process.env['IMPORT_DIR'];
    if (dir === undefined) {
      return c.json(
        { ok: false, error: 'import_dir_unset', detail: 'IMPORT_DIR روی سرور تنظیم نشده است.' },
        503,
      );
    }
    try {
      return c.json({ ok: true, dir, items: listDumps(dir) });
    } catch {
      return c.json(
        { ok: false, error: 'import_dir_unreadable', detail: 'پوشهٔ ایمپورت خوانده نشد.' },
        503,
      );
    }
  });

  app.get('/api/v1/admin/import/runs', async (c) => {
    if (c.get('identity').role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const rows = await c.env.DB.prepare(
      `SELECT id, mode, status, dump_path, dump_bytes, domains, error, started_by,
              started_at, finished_at
         FROM import_runs ORDER BY started_at DESC LIMIT 25`,
    ).all<Record<string, unknown>>();
    return c.json({ ok: true, items: rows.results ?? [] });
  });

  app.get('/api/v1/admin/import/runs/:id', async (c) => {
    if (c.get('identity').role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const row = await c.env.DB.prepare('SELECT * FROM import_runs WHERE id = ?1')
      .bind(c.req.param('id'))
      .first<Record<string, unknown>>();
    if (!row) return c.json({ ok: false, error: 'not_found' }, 404);
    return c.json({ ok: true, run: row });
  });
}
