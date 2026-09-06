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
 * ## The dump arrives one of two ways, and both end in the same directory
 *
 * Every run reads from `IMPORT_DIR` on the server. A file gets there over SCP,
 * or — since 2026-09-01, at Sam's explicit instruction — through
 * `POST /import/upload` from the panel.
 *
 * **The reasons upload was refused were real, and only one of them was ever
 * about the code.** They are recorded here rather than deleted, because the
 * next person to read this file deserves the trade rather than the verdict:
 *
 *   * *The dump carries plaintext secrets* — `marzban_panel.password_panel`,
 *     `admin.password` and roughly ten `PaySetting` gateway keys. That has not
 *     changed. What changed is who was being protected from what: the file is
 *     already on the admin's own laptop, already crossed the internet once to
 *     get there, and the browser leg is TLS to a host the same admin is already
 *     authenticated against. It is written `0600` and never read back out.
 *   * *nginx's 1 MB body limit* — a real wall, and the edge config lives on the
 *     server rather than in this repository, so the code cannot fix it. See
 *     `deploy/README.md` › «The edge»: `client_max_body_size` must be raised or
 *     every upload dies at 413. A 413 has no JSON body, so the client says so
 *     in words instead of showing `undefined`.
 *   * *the 60 s proxy timeout* — the 2026-08-11 production dump is 5.84 MB and
 *     `MAX_DUMP_BYTES` caps any dump at 48 MB. Neither is a minute of upload on
 *     a usable link. No chunking, no resume, no session state: if dumps ever
 *     grow past what one request can carry, that is when to write it.
 *
 * The client names a FILE, never a path — on upload exactly as on run.
 * `resolveDump` refuses anything with a separator in it and then checks the
 * resolved result is still inside the directory, because a name is
 * attacker-controlled input at a trust boundary even when the attacker has to
 * be a signed-in admin first.
 *
 * ## The report is written while the run is still going
 *
 * `captureReport` fills an array as the migration prints, and that array used
 * to be handed to Postgres once, at the end. For the minutes an APPLY takes,
 * the panel therefore had one word — «در حال اجرا» — and a spinner, which is
 * indistinguishable from a hang at exactly the moment somebody is watching the
 * riskiest button in the product. The array is now flushed into the row every
 * `PROGRESS_FLUSH_MS`, and the poll the browser was already doing renders it.
 *
 * No socket, no stream, no queue: the storage and the poll both already
 * existed, and this is one `setInterval` between them.
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
import { createWriteStream, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import type { EnvName } from '@shikoo/contracts';
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
  applyUndo,
  dropUndo,
  claimImportLock,
  previewReset,
  resetShopData,
  undoSchemaFor,
  DOMAINS,
  dumpSha256,
  MAX_DUMP_BYTES,
  PANEL_DEFAULT_DOMAINS,
  type Domain,
  type ReportLine,
} from '@shikoo/migrate';
import { createLogger } from '@shikoo/domain';
import { audit, type Ident } from './adminAudit.js';

const log = createLogger('dashboard.import');

type Env = {
  DB: D1Database;
  /**
   * The name of THIS box, as `server.ts` read it at boot with `parseEnvName`.
   * The reset route compares the operator's typed phrase against it; nothing
   * the browser sends can change it.
   */
  ENV_NAME: EnvName;
  IMPORT_DIR?: string;
  IMPORT_MYSQL_URL?: string;
};

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

/**
 * How often a run's report so far is written to its row.
 *
 * Paired with the browser's one-second poll, so a line appears within about two
 * seconds of the step that printed it. Shorter would write more often than
 * anybody reads; longer and the staircase stops feeling attached to the button.
 */
const PROGRESS_FLUSH_MS = 1500;

const RunBody = z
  .object({
    file: z.string().min(1).max(255),
    domains: z.array(z.enum(DOMAINS as unknown as [Domain, ...Domain[]])).optional(),
  })
  .strict();

/**
 * The typed confirmation a reset takes.
 *
 * Only the phrase — there is nothing else to send, and `.strict()` so a field
 * somebody invents (a `force`, a `keep`) is a 400 rather than something
 * quietly ignored on the one route where being ignored would matter most.
 */
const ResetBody = z.object({ confirm: z.string().min(1).max(64) }).strict();

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

/**
 * The import directory, made to exist.
 *
 * `IMPORT_DIR` names a path; nothing guarantees anything is there. On the
 * staging box on 2026-09-01 the variable was set and the directory was not, and
 * the panel answered «پوشهٔ ایمپورت خوانده نشد» — a 503 whose only cure was a
 * second, undocumented ops step. Creating it is one syscall and turns a
 * two-step setup into one.
 *
 * 0700 because of what lands here: a dump carries `password_panel`,
 * `admin.password` and roughly ten gateway keys in plaintext. `recursive`
 * makes it a no-op when the directory is already there, which is the normal
 * case and the one a persistent volume produces.
 *
 * It does NOT create a missing MOUNT. If the volume is gone this makes a plain
 * directory inside the container, uploads work, and they vanish with the next
 * deploy — the same as any other unmounted path, and better than refusing.
 */
function ensureImportDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
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
  /** The schema holding this run's row keys, or null when nothing was kept. */
  undoSchema: string | null;
}

/**
 * Loads the dump and runs the requested phase.
 *
 * Writes nothing to Postgres of its own — `migrate` owns the transaction, and
 * it either commits everything or leaves the database exactly as it found it.
 */
async function runImport(
  mode: Mode,
  /** The `import_runs` row this belongs to; names the undo schema. */
  runId: string,
  dumpPath: string,
  domains: Domain[],
  mysqlUrl: string,
  postgresUrl: string,
  /**
   * The dump this run was AUTHORISED to import, or null for a run that needs no
   * authorisation.
   *
   * The APPLY gate hashes the file, finds a dry run that proved those bytes,
   * and then hands the request on. Between those two moments the file can
   * change — an upload, an SCP, a second admin — and the gate would have proved
   * a dump that is no longer the one about to be loaded. CodeRabbit found this
   * on PR #48 and asked for a lock shared by the upload route and the run
   * route.
   *
   * This is stronger than that lock and smaller than it. A reservation can only
   * exclude the writers that agree to take it, and the dump directory has a
   * writer that never will: `scp`, which is how every dump arrived before the
   * panel could upload one and how they will keep arriving. So the check is not
   * «did anybody else hold the door», it is «are these the bytes I was allowed
   * to import», asked of the file that was actually read, after it was read.
   * Nothing can pass that by winning a race.
   *
   * Passed through to `loadDump`, which owns the one definition of dump
   * identity and refuses before a byte reaches the scratch database.
   */
  expectSha: string | null,
  /**
   * Where the report accumulates.
   *
   * Owned by the caller rather than created here, which is the whole of the
   * live-progress feature: the caller can read the array while this function is
   * still filling it. Passing it in beats a callback per line — `captureReport`
   * already appends, and an array somebody else may read is a smaller thing to
   * reason about than a stream of events.
   */
  lines: ReportLine[] = [],
): Promise<RunOutcome> {
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
    // The digest the gate approved goes with it: `loadDump` refuses the file
    // before anything reaches MySQL if the bytes are not the ones proven.
    const loaded = await loadDump(cfg, dumpPath, expectSha ?? undefined);
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
        undoSchema: null,
      };
    }
    if (mode === 'PREFLIGHT') {
      return { ok: true, report: lines, samples: {}, error: null, dump, undoSchema: null };
    }

    // What the target already held, taken before a single row is written.
    //
    // `verify` compares whole-table totals, which is right for a cutover into
    // an empty database and wrong for the merge this panel performs: on a
    // database holding anything at all, every total would read as off by
    // whatever was already there. Subtracting the baseline makes the check
    // about what THIS import moved.
    const baseline = await targetBaseline(pgc);

    // Only an APPLY leaves anything to take back. A dry run would record a
    // schema and then roll it back with everything else, which is correct and
    // also pointless; a pre-flight never reaches this call at all.
    const undoSchema = mode === 'APPLY' ? undoSchemaFor(runId) : null;
    const result = await migrate(cfg, my, pgc, {
      commit: mode === 'APPLY',
      domains,
      samples: 5,
      ...(undoSchema === null ? {} : { undoSchema }),
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
      // Recorded even when the verify disagreed. For an APPLY the verify runs
      // AFTER the commit, so the rows are already there — and a run that
      // committed rows the two sides cannot agree about is precisely the one
      // an operator most needs to be able to take back.
      //
      // But only when the recording holds something. A second APPLY of the same
      // dump inserts nothing (the migration is idempotent on the legacy keys),
      // and keeping a schema name for that empty recording would put a
      // «بازگرداندن» button on the screen that the server is bound to refuse.
      undoSchema: result.undoRows > 0 ? undoSchema : null,
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
    // Sorted and deduplicated, because this set is not only run — it is
    // STORED and later COMPARED. `['sales','catalog']` and `['catalog','sales']`
    // are the same import and must not read as two different proofs.
    const domains = [...new Set(parsed.data.domains ?? PANEL_DEFAULT_DOMAINS)].sort();

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

      /**
       * An APPLY is gated on a dry run that actually proves THIS import.
       *
       * The gate is not ceremony: a dry run IS the real migration measured
       * against the real constraints, so it is the difference between «we think
       * this imports» and «this imported, and we threw the result away».
       *
       * It matched on `dump_path` and nothing else until 2026-09-01, and
       * CodeRabbit found both ways through it on PR #42. Both are ordinary
       * cutover moves, not attacks:
       *
       *   * **A refreshed file.** `dump_path` is a name inside `IMPORT_DIR`, not
       *     content. Copying a newer dump over the same name is how a dump is
       *     refreshed, and the APPLY then committed a file no dry run had ever
       *     read. Now the gate compares `dump_sha256` — the identity the run
       *     itself recorded, computed here by the same `dumpSha256` the loader
       *     uses, so the two cannot drift.
       *
       *   * **A widened scope.** A dry run of `catalog` unlocked an APPLY of
       *     `sales`, whose transforms had never been exercised. `domains @> …`
       *     is jsonb containment: every domain being applied must appear in the
       *     domains that were proven. A dry run of more than you apply still
       *     counts, which is the useful direction.
       *
       * Hashing the file costs one read of at most `MAX_DUMP_BYTES`, once, when
       * an operator presses APPLY. That is the price of the promise this gate
       * makes, and it is paid on the one request that must not be cheap.
       */
      // Carried to the run, which re-checks it against the bytes it actually
      // loaded. See `runImport`'s `expectSha`.
      let provenSha: string | null = null;
      if (mode === 'APPLY') {
        let sha: string;
        try {
          sha = dumpSha256(dumpPath);
        } catch {
          return c.json({ ok: false, error: 'invalid_file' }, 400);
        }
        provenSha = sha;

        const proven = await c.env.DB.prepare(
          `SELECT id FROM import_runs
            WHERE mode = 'DRY_RUN' AND status = 'SUCCEEDED'
              AND dump_sha256 = ?1
              AND domains @> ?2::jsonb
            ORDER BY started_at DESC LIMIT 1`,
        )
          .bind(sha, JSON.stringify(domains))
          .first<{ id: string }>();
        if (!proven) {
          // One message for both misses on purpose. Telling an operator which
          // half failed would mean saying «that file changed» or «you widened
          // the scope», and the answer to either is the same single action.
          return c.json(
            {
              ok: false,
              error: 'dry_run_required',
              detail:
                'اول یک اجرای آزمایشی موفق روی همین فایل و همین بخش‌ها لازم است. ' +
                'اگر فایل عوض شده یا بخش تازه‌ای اضافه کرده‌ای، اجرای آزمایشی باید دوباره انجام شود.',
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
        const lines: ReportLine[] = [];
        /**
         * Publishes the report so far, every `PROGRESS_FLUSH_MS`.
         *
         * `status = 'RUNNING'` in the WHERE clause is not decoration. The timer
         * is cleared before the settling UPDATE below, but «cleared» only means
         * no NEW tick starts — a tick already awaiting its write would land
         * afterwards and overwrite the final report with a snapshot taken one
         * line short. The predicate makes that write hit nothing.
         *
         * Failures are swallowed on purpose: this is a progress bar. A row that
         * cannot take an interim report must not be the reason an import that
         * is otherwise fine reports failure.
         */
        const flush = setInterval(() => {
          void c.env.DB.prepare(
            `UPDATE import_runs SET report = ?2::jsonb WHERE id = ?1 AND status = 'RUNNING'`,
          )
            .bind(id, JSON.stringify(lines))
            .run()
            .catch(() => undefined);
        }, PROGRESS_FLUSH_MS);

        try {
          const outcome = await runImport(
            mode,
            id,
            dumpPath,
            domains,
            mysqlUrl,
            postgresUrl,
            provenSha,
            lines,
          );
          clearInterval(flush);
          await c.env.DB.prepare(
            `UPDATE import_runs
                SET status = ?2, finished_at = now(), report = ?3::jsonb,
                    samples = ?4::jsonb, error = ?5, dump_sha256 = ?6, dump_bytes = ?7,
                    undo_schema = ?8
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
              outcome.undoSchema,
            )
            .run();
        } catch (err) {
          clearInterval(flush);
          const message = err instanceof Error ? err.message : String(err);
          log.error('import.failed', { runId: id, mode, error: message });
          // The report goes in beside the error. A run that threw half way
          // through has the more useful half of its output in `lines`, and
          // losing it was why «چه چیزی شکست» used to mean reading the container
          // log over SSH.
          await c.env.DB.prepare(
            `UPDATE import_runs
                SET status='FAILED', finished_at=now(), error=?2, report=?3::jsonb
              WHERE id=?1`,
          )
            .bind(id, message, JSON.stringify(lines))
            .run()
            .catch(() => undefined);
        } finally {
          clearInterval(flush);
        }
      })();

      return c.json({ ok: true, id, mode, domains });
    });
  }

  /**
   * Puts a dump into `IMPORT_DIR` from the browser.
   *
   * ## The body is the file, and nothing else
   *
   * Not `multipart/form-data`. Multipart exists to carry several fields at
   * once, there is exactly one field here, and every parser for it either
   * buffers the whole body in memory or pulls in a dependency. `fetch` and
   * `XMLHttpRequest` both send a `File` as a raw body, so the name travels in
   * the query string — where `resolveDump` already knows how to distrust it —
   * and the bytes go straight from the socket to the disk.
   *
   * ## Written aside, then renamed
   *
   * A failed upload must not leave something that looks like a dump. The bytes
   * land in `<name>.part`, and only a complete request renames it into place.
   * `rename` inside one directory is atomic on every filesystem this runs on,
   * so `listDumps` never sees a half-written file and a dry run can never read
   * one. The `.part` suffix is also outside what `listDumps` will show and what
   * `resolveDump` will accept, so a leftover from a dropped connection is inert
   * rather than merely unlikely to be chosen.
   *
   * ## The cap is enforced here, not discovered later
   *
   * `MAX_DUMP_BYTES` is the loader's limit, imported rather than restated. It
   * is counted as the stream arrives and the write is destroyed the moment it
   * is passed, so an oversized upload costs the disk what it had written and
   * not one byte more. Checking `content-length` instead would be checking a
   * number the client chose.
   *
   * ## What overwriting means now
   *
   * Uploading over an existing name is allowed, because refreshing a dump is a
   * normal cutover move. It is safe only because of what PR #42 changed: APPLY
   * is gated on the dry run's `dump_sha256`, so replacing a file invalidates
   * its own proof and the next APPLY is refused until a new dry run reads the
   * new bytes. Before that gate this route would have been a way to swap the
   * file out from under a passed dry run.
   */
  app.post('/api/v1/admin/import/upload', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const dir = c.env.IMPORT_DIR ?? process.env['IMPORT_DIR'];
    if (dir === undefined) {
      return c.json(
        { ok: false, error: 'import_dir_unset', detail: 'IMPORT_DIR روی سرور تنظیم نشده است.' },
        503,
      );
    }

    // Separately from the name check below, because the two failures need
    // different answers: a directory that cannot be made is the server's
    // problem, and «this file cannot be imported» would send the operator
    // looking at their own filename.
    try {
      ensureImportDir(dir);
    } catch {
      return c.json(
        { ok: false, error: 'import_dir_unreadable', detail: 'پوشهٔ ایمپورت روی سرور ساخته نشد.' },
        503,
      );
    }

    let target: string;
    try {
      target = resolveDump(dir, c.req.query('name') ?? '');
    } catch {
      return c.json(
        {
          ok: false,
          error: 'invalid_file',
          detail: 'نام فایل باید یک نام ساده با پسوند .sql یا .sql.gz باشد.',
        },
        400,
      );
    }

    // A run in flight is reading the directory it is about to be handed a new
    // file in. Refusing is a one-line guard; working out which file a running
    // import holds open, on which platform, is not.
    const running = await c.env.DB.prepare(
      `SELECT id FROM import_runs WHERE status = 'RUNNING' LIMIT 1`,
    ).first<{ id: string }>();
    if (running) {
      return c.json(
        {
          ok: false,
          error: 'import_already_running',
          detail: 'یک ایمپورت در حال اجراست؛ تا پایانش صبر کن.',
        },
        409,
      );
    }

    const body = c.req.raw.body;
    if (body === null) {
      return c.json({ ok: false, error: 'empty_upload', detail: 'فایلی فرستاده نشد.' }, 400);
    }

    const part = `${target}.part`;
    let bytes = 0;
    let tooBig = false;
    try {
      // `wx` — create, and fail if it is already there.
      //
      // Two uploads of the same name would otherwise both open `<name>.part`,
      // interleave their bytes into one file, and the second rename would put
      // the mixture where a dump belongs. The exclusive create makes that
      // unrepresentable rather than unlikely: the loser gets EEXIST from the
      // filesystem, which is one atomic operation and needs no lock of ours.
      //
      // 0600: the file holds panel passwords and gateway keys in plaintext, and
      // the default umask would have let every account on the box read them.
      const out = createWriteStream(part, { flags: 'wx', mode: 0o600 });
      const counted = Readable.fromWeb(body as Parameters<typeof Readable.fromWeb>[0]).map(
        (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_DUMP_BYTES) {
            tooBig = true;
            throw new Error('too large');
          }
          return chunk;
        },
      );
      await pipeline(counted, out);
      if (bytes === 0) throw new Error('empty');
      renameSync(part, target);
    } catch (err) {
      // EEXIST means another upload of this name owns the .part right now, so
      // it is emphatically NOT ours to delete — removing it would hand the
      // other request a stream writing to an unlinked inode and leave nothing
      // to rename.
      const busy = (err as NodeJS.ErrnoException).code === 'EEXIST';
      if (!busy) rmSync(part, { force: true });
      if (busy) {
        return c.json(
          {
            ok: false,
            error: 'upload_in_progress',
            detail: 'همین فایل الان در حال آپلود است؛ تا پایانش صبر کن.',
          },
          409,
        );
      }
      if (tooBig) {
        return c.json(
          {
            ok: false,
            error: 'dump_too_large',
            detail: `دامپ نباید از ${Math.floor(MAX_DUMP_BYTES / 1024 / 1024)} مگابایت بزرگ‌تر باشد.`,
          },
          413,
        );
      }
      if (bytes === 0) {
        return c.json({ ok: false, error: 'empty_upload', detail: 'فایلی فرستاده نشد.' }, 400);
      }
      // The message, never the bytes. Whatever went wrong here happened while
      // holding plaintext panel passwords.
      log.error('import.upload_failed', {
        name: basename(target),
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(
        { ok: false, error: 'upload_failed', detail: 'فایل روی سرور نوشته نشد.' },
        500,
      );
    }

    // The name and the size. Not the checksum: hashing here would read 48 MB
    // back off the disk to tell an operator something the dry run tells them
    // anyway, and it is the dry run's hash that gates anything.
    await audit(c.env.DB, ident, 'import.upload', 'IMPORT_FILE', basename(target), null, {
      file: basename(target),
      bytes,
    }, null);

    return c.json({ ok: true, name: basename(target), bytes });
  });

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
      ensureImportDir(dir);
      return c.json({ ok: true, dir, items: listDumps(dir) });
    } catch {
      return c.json(
        { ok: false, error: 'import_dir_unreadable', detail: 'پوشهٔ ایمپورت خوانده نشد.' },
        503,
      );
    }
  });

  /**
   * Takes back exactly the rows one APPLY inserted.
   *
   * ## Why this is not a restore
   *
   * Sam's choice on 2026-09-02, offered against «rewind the whole database»:
   * only the rows this run wrote go. A purchase somebody made after the
   * import survives it. `undo.ts` explains how the set is decided —
   * `xmin = pg_current_xact_id()::xid`, asked inside the migration's own
   * transaction, which is Postgres's own answer to «what did this transaction
   * insert» and cannot drift from a list somebody has to maintain.
   *
   * ## One transaction, and the row is part of it
   *
   * The delete, the `undone_at` stamp and the DROP of the recording all
   * settle together on the raw client. Split across two connections, a crash
   * in between leaves either a row claiming an undo that did not happen or a
   * schema nothing points at — and the second one is worse, because the next
   * reader has no way to tell it from a recording still waiting to be used.
   *
   * ## What it refuses, and why each refusal is not paranoia
   *
   *   * **A run with no recording.** A pre-flight wrote nothing and a dry run
   *     rolled its recording back; there is nothing to take.
   *   * **A run already undone.** `undone_at` is the guard, checked in the
   *     same statement that sets it, so two operators pressing at once cannot
   *     both win.
   *   * **While an import is running.** The other run is writing to the very
   *     tables this deletes from, and the two would deadlock at best.
   *
   * A foreign key that refuses is NOT worked around. If something created
   * later depends on an imported row, the whole undo rolls back and says so —
   * which is the honest answer, and the one that keeps this from quietly
   * becoming the restore it is not.
   */
  app.post('/api/v1/admin/import/runs/:id/undo', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const postgresUrl = process.env['DATABASE_URL'];
    if (postgresUrl === undefined) {
      return c.json({ ok: false, error: 'import_not_configured' }, 503);
    }

    const id = c.req.param('id');
    const run = await c.env.DB.prepare(
      `SELECT id, mode, undo_schema, undone_at FROM import_runs WHERE id = ?1`,
    )
      .bind(id)
      .first<{ id: string; mode: string; undo_schema: string | null; undone_at: string | null }>();
    if (!run) return c.json({ ok: false, error: 'not_found' }, 404);
    if (run.undo_schema === null) {
      return c.json(
        {
          ok: false,
          error: 'nothing_to_undo',
          detail: 'این اجرا چیزی روی دیتابیس ننوشته، پس چیزی برای برگرداندن نیست.',
        },
        409,
      );
    }
    if (run.undone_at !== null) {
      return c.json(
        { ok: false, error: 'already_undone', detail: 'این ایمپورت قبلاً برگردانده شده.' },
        409,
      );
    }

    // Read for the message, not for the decision. The decision is
    // `claimImportLock` inside the transaction below: a new APPLY can insert
    // its RUNNING row in the gap between this SELECT and the DELETEs, and then
    // the two would be writing and deleting the same tables at once.
    const busy = await c.env.DB.prepare(
      `SELECT id FROM import_runs WHERE status = 'RUNNING' LIMIT 1`,
    ).first<{ id: string }>();
    if (busy) {
      return c.json(
        {
          ok: false,
          error: 'import_already_running',
          detail: 'یک ایمپورت در حال اجراست؛ تا پایانش صبر کن.',
        },
        409,
      );
    }

    const pgc = await connectPostgres(
      configFrom({
        mysql: { database: SCRATCH_DATABASE },
        postgres: { connectionString: postgresUrl },
      }),
    );
    try {
      await pgc.query('BEGIN');
      // The actual guard, held for this transaction and released by Postgres
      // on COMMIT or ROLLBACK however this ends. An import takes the same one.
      if (!(await claimImportLock(pgc))) {
        await pgc.query('ROLLBACK');
        return c.json(
          {
            ok: false,
            error: 'import_already_running',
            detail: 'یک ایمپورت در حال اجراست؛ تا پایانش صبر کن.',
          },
          409,
        );
      }
      const result = await applyUndo(pgc, run.undo_schema);
      // A recording that holds nothing must not be spent. Stamping it undone
      // and dropping it would turn «this run wrote nothing» into «this run has
      // been taken back», which is a different sentence and unrecoverable.
      if (result.total === 0) {
        await pgc.query('ROLLBACK');
        return c.json(
          {
            ok: false,
            error: 'nothing_to_undo',
            detail: 'این اجرا چیزی روی دیتابیس ننوشته، پس چیزی برای برگرداندن نیست.',
          },
          409,
        );
      }
      // `undone_at IS NULL` again, in the statement. The read above was a
      // courtesy to the operator; this is the guard, and it is the difference
      // between a check and a race this codebase has been bitten by before.
      const stamped = await pgc.query(
        `UPDATE import_runs SET undone_at = now(), undone_by = $2
          WHERE id = $1 AND undone_at IS NULL`,
        [id, ident.email],
      );
      if (stamped.rowCount !== 1) throw new Error('the run was undone by somebody else');
      await dropUndo(pgc, run.undo_schema);
      await pgc.query('COMMIT');

      await audit(c.env.DB, ident, 'import.undo', 'IMPORT_RUN', id, null, {
        removed: result.removed,
        total: result.total,
      }, null);

      return c.json({ ok: true, removed: result.removed, total: result.total });
    } catch (err) {
      await pgc.query('ROLLBACK').catch(() => undefined);
      const message = err instanceof Error ? err.message : String(err);
      log.error('import.undo_failed', { runId: id, error: message });
      return c.json({ ok: false, error: 'undo_failed', detail: message }, 409);
    } finally {
      await pgc.end().catch(() => undefined);
    }
  });

  /**
   * What a reset would remove, before anything is removed.
   *
   * The pattern is `/accounts/:id/references` before `DELETE /accounts/:id`: a
   * destructive button says what it will cost before it is armed, and the
   * number is read out of the database rather than written into the screen.
   *
   * ADMIN even though it only reads. The answer is a table-by-table census of
   * the whole shop — how many customers, how many orders, how much history —
   * which is the same shape of thing the run report is ADMIN for.
   *
   * It deliberately does NOT return the environment's name. That is the one
   * thing the operator has to know for themselves; see the POST below.
   */
  app.get('/api/v1/admin/import/reset/preview', async (c) => {
    if (c.get('identity').role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const postgresUrl = process.env['DATABASE_URL'];
    if (postgresUrl === undefined) {
      return c.json({ ok: false, error: 'import_not_configured' }, 503);
    }

    const pgc = await connectPostgres(
      configFrom({
        mysql: { database: SCRATCH_DATABASE },
        postgres: { connectionString: postgresUrl },
      }),
    );
    try {
      const preview = await previewReset(pgc);
      return c.json({ ok: true, ...preview });
    } finally {
      await pgc.end().catch(() => undefined);
    }
  });

  /**
   * Empties the shop's data, keeping only what makes this installation
   * reachable. `reset.ts` holds the list and the reasoning.
   *
   * ## Why it exists next to «بازگرداندن» rather than instead of it
   *
   * Undo takes back one run. It is the right tool and it will always be able
   * to fail, because it DELETEs and a foreign key from a row created after the
   * import holds a veto — `409 undo_failed`, with nothing beyond it. Sam's
   * requirement on 2026-09-03 was a button that cannot land there: a reseller
   * imports, works for a month, and wants a clean page for a new dump. That is
   * `TRUNCATE … CASCADE`, which no key can refuse.
   *
   * ## The confirmation is the environment's own name, as the SERVER reads it
   *
   * The first write route on this panel to take a typed phrase, and the phrase
   * is not «DELETE» or the shop's name — it is `ENV_NAME`, compared against
   * `c.env.ENV_NAME`, which `server.ts` built at boot with `parseEnvName` from
   * the process environment. Nothing the browser sends can move it, and this
   * route never tells the caller what it is.
   *
   * Sam's decision, and it is the same lesson CLAUDE.md records under «روی
   * سرور، اول بپرس این کدام محیط است»: a `uuid` in a notes file read as
   * «dashboard» and turned out to be production. The only confirmation worth
   * anything here is one that cannot be satisfied without first finding out
   * which box you are standing on.
   *
   * ## The audit row is written after the commit, and that is not an oversight
   *
   * `audit_logs` is not in KEEP — it is this shop's history, telegram ids and
   * amounts included, and a reseller handing an installation over is handing
   * that over too. So the reset empties it, and the log then opens with the one
   * row that says what happened to it. Written after COMMIT for exactly that
   * reason: inside the transaction it would be truncated by the statement it
   * is recording.
   */
  app.post('/api/v1/admin/import/reset', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const postgresUrl = process.env['DATABASE_URL'];
    if (postgresUrl === undefined) {
      return c.json({ ok: false, error: 'import_not_configured' }, 503);
    }

    const parsed = ResetBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);

    // The binding only. `start()` parses `process.env.ENV_NAME` once and hands
    // the result to every request, so reading the environment again here would
    // be a SECOND source for the one value that decides whether this box may be
    // emptied — and the two can disagree.
    const envName = c.env.ENV_NAME;
    if (!envName) {
      // Nothing to compare against is not «anything matches». A box that
      // cannot say which box it is has no business running this.
      //
      // Truthiness rather than `=== undefined || === ''`: with the fallback
      // gone the binding is the narrow union `parseEnvName` produces, and the
      // typechecker now REFUSES a comparison against `''` — which is the
      // clearest possible statement that there was a second, unvalidated
      // source before this. This still catches both at run time.
      return c.json({ ok: false, error: 'import_not_configured' }, 503);
    }
    if (parsed.data.confirm.trim() !== envName) {
      return c.json(
        {
          ok: false,
          error: 'wrong_confirmation',
          detail: 'عبارت تایید با نام این محیط یکی نیست.',
        },
        400,
      );
    }

    // Read for the message; the decision is `claimImportLock` below. An import
    // writing into the tables this truncates is the one thing that can make a
    // reset fail, and a SELECT taken a moment earlier cannot stop it.
    const busy = await c.env.DB.prepare(
      `SELECT id FROM import_runs WHERE status = 'RUNNING' LIMIT 1`,
    ).first<{ id: string }>();
    if (busy) {
      return c.json(
        {
          ok: false,
          error: 'import_already_running',
          detail: 'یک ایمپورت در حال اجراست؛ تا پایانش صبر کن.',
        },
        409,
      );
    }

    const pgc = await connectPostgres(
      configFrom({
        mysql: { database: SCRATCH_DATABASE },
        postgres: { connectionString: postgresUrl },
      }),
    );
    try {
      await pgc.query('BEGIN');
      if (!(await claimImportLock(pgc))) {
        await pgc.query('ROLLBACK');
        return c.json(
          {
            ok: false,
            error: 'import_already_running',
            detail: 'یک ایمپورت در حال اجراست؛ تا پایانش صبر کن.',
          },
          409,
        );
      }
      const result = await resetShopData(pgc);
      await pgc.query('COMMIT');

      await audit(
        c.env.DB,
        ident,
        'import.reset',
        'IMPORT_RESET',
        envName,
        null,
        { removed: result.removed, total: result.total, undoSchemas: result.undoSchemas },
        null,
      );
      log.info('import.reset', { total: result.total, tables: result.removed.length });

      return c.json({ ok: true, removed: result.removed, total: result.total });
    } catch (err) {
      await pgc.query('ROLLBACK').catch(() => undefined);
      const message = err instanceof Error ? err.message : String(err);
      // The KEEP guard lands here, and its message names the table it caught.
      log.error('import.reset_failed', { error: message });
      return c.json({ ok: false, error: 'reset_failed', detail: message }, 409);
    } finally {
      await pgc.end().catch(() => undefined);
    }
  });
  app.get('/api/v1/admin/import/runs', async (c) => {
    if (c.get('identity').role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
    const rows = await c.env.DB.prepare(
      `SELECT id, mode, status, dump_path, dump_bytes, domains, error, started_by,
              started_at, finished_at, undo_schema, undone_at, undone_by
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
