/**
 * Operator accounts, from a terminal.
 *
 *   corepack pnpm --filter @shikoo/dashboard operator list
 *   corepack pnpm --filter @shikoo/dashboard operator bootstrap sam@example.com ADMIN
 *   corepack pnpm --filter @shikoo/dashboard operator create sam@example.com ADMIN
 *   corepack pnpm --filter @shikoo/dashboard operator set-password sam@example.com
 *   corepack pnpm --filter @shikoo/dashboard operator enroll-totp sam@example.com
 *   corepack pnpm --filter @shikoo/dashboard operator disable-totp sam@example.com
 *   corepack pnpm --filter @shikoo/dashboard operator unlock sam@example.com
 *
 * This exists because of a bootstrap problem with exactly one solution. Cloudflare
 * Access is gone, so the only way into the panel is an operator row with a
 * password — and the screen that would create that row is behind the panel.
 * Somebody has to be able to make the first one from outside, once.
 *
 * The password is read from stdin, never from `process.argv`. An argument is
 * visible in `ps` to every user on the box and lands in the shell history file
 * of whoever typed it; a secret that has to be typed anyway costs nothing to
 * type into a prompt instead. Nothing here is logged, echoed back, or written
 * anywhere except as a hash.
 */

import { createInterface } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { createPostgresD1 } from '@shikoo/db';
import { BootstrapError, bootstrapOperator } from './bootstrapOperator.js';
import {
  generateSecret,
  hashPassword,
  otpauthUri,
  passwordProblem,
  verifyTotp,
} from '@shikoo/domain';

const ROLES = ['ADMIN', 'REVIEWER', 'READ_ONLY'];

/**
 * One interface for the whole run.
 *
 * Opening a fresh `readline` per question loses input: the first one buffers
 * everything already available on the stream and closing it throws the rest
 * away, so `set-password` read the password and then saw end-of-file where the
 * confirmation should have been — and wrote nothing, silently. Found by piping
 * two lines into it, which is also how the sim exercises it.
 *
 * `terminal` follows whether stdin actually is one. Forcing it true makes
 * readline try to drive a terminal that is not there.
 */
let rl: ReturnType<typeof createInterface> | null = null;
function reader(): ReturnType<typeof createInterface> {
  rl ??= createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
  return rl;
}

/**
 * Piped input, read once, handed out a line at a time.
 *
 * Not an optimisation. On a pipe, stdin reaches end-of-file while a question is
 * still pending; readline then emits `close` and simply never calls that
 * question's callback, so the promise never settles, the event loop empties and
 * Node exits **0** having written nothing. That is the worst possible failure
 * for this script — it looks like it set the password.
 *
 * A terminal has no EOF, so it keeps the interactive path.
 */
let piped: string[] | null = null;
async function pipedLines(): Promise<string[]> {
  if (piped) return piped;
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk as Buffer));
  piped = Buffer.concat(chunks).toString('utf8').split(/\r?\n/);
  return piped;
}

async function nextPipedLine(): Promise<string> {
  const lines = await pipedLines();
  if (lines.length === 0) throw new Error('expected another line on stdin, got end of input');
  return lines.shift() as string;
}

/**
 * Read one line without echoing it.
 *
 * Muting only means anything on a real terminal; piped input has nothing to
 * echo to a shoulder.
 */
async function askHidden(prompt: string): Promise<string> {
  if (stdin.isTTY !== true) {
    stdout.write(prompt);
    const line = await nextPipedLine();
    stdout.write('\n');
    return line;
  }
  return new Promise((resolve) => {
    stdout.write(prompt);
    const iface = reader();
    const muted = iface as unknown as { output: { write: (chunk: string) => void } | null };
    const out = muted.output;
    const write = out?.write.bind(out);
    if (out && write && stdin.isTTY === true) {
      out.write = (chunk: string) => {
        // Let the newline through so the cursor still moves on Enter.
        if (chunk.includes('\n')) write(chunk);
      };
    }
    iface.question('', (answer) => {
      if (out && write) out.write = write;
      stdout.write('\n');
      resolve(answer);
    });
  });
}

async function ask(prompt: string): Promise<string> {
  if (stdin.isTTY !== true) {
    stdout.write(prompt);
    return (await nextPipedLine()).trim();
  }
  return new Promise((resolve) => {
    reader().question(prompt, (answer) => resolve(answer.trim()));
  });
}

async function main(): Promise<number> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required — this writes credentials, so it is never guessed.');
    return 2;
  }
  const command = process.argv[2];
  const email = process.argv[3]?.trim().toLowerCase();
  const { db, pool } = createPostgresD1({ connectionString: url });

  try {
    if (command === 'list') {
      const rows = await db
        .prepare(
          `SELECT email, role, active, totp_enabled,
                  password_hash IS NOT NULL AS has_password, locked_until
             FROM access_users ORDER BY email`,
        )
        .all<{
          email: string;
          role: string;
          active: number;
          totp_enabled: boolean;
          has_password: boolean;
          locked_until: string | null;
        }>();
      for (const r of rows.results ?? []) {
        const flags = [
          r.active === 1 ? 'active' : 'DISABLED',
          r.has_password ? 'password' : 'NO PASSWORD',
          r.totp_enabled ? 'totp' : 'no totp',
          r.locked_until && new Date(r.locked_until) > new Date() ? 'LOCKED' : '',
        ].filter(Boolean);
        console.log(`${r.email.padEnd(34)} ${r.role.padEnd(10)} ${flags.join(' · ')}`);
      }
      if ((rows.results ?? []).length === 0) console.log('(no operators — nobody can sign in)');
      return 0;
    }

    if (!command || !email) {
      console.error(
        'usage: operator <list|bootstrap|create|set-password|enroll-totp|disable-totp|unlock> [email] [role] [--update] [--env NAME]',
      );
      return 2;
    }

    if (command === 'bootstrap') {
      // Both halves of «make the first account» in one run: the row and the
      // password it needs to be worth anything. See `bootstrapOperator.ts` for
      // why it is one step here and two in `create` + `set-password`.
      //
      // `--env` takes a value, so the role cannot be «the first argument that
      // is not a flag» — that finds `staging` when the role is left to default.
      const rest = process.argv.slice(4);
      let role: string | undefined;
      let expectEnv: string | undefined;
      let update = false;
      for (let i = 0; i < rest.length; i += 1) {
        const arg = rest[i] as string;
        if (arg === '--update') update = true;
        else if (arg === '--env') {
          expectEnv = rest[i + 1];
          i += 1;
        } else if (role === undefined) role = arg;
        else {
          console.error(`unexpected argument ${JSON.stringify(arg)}`);
          return 2;
        }
      }

      const password = await askHidden(`password for ${email}: `);
      if ((await askHidden('again: ')) !== password) {
        console.error('the two did not match. Nothing was changed.');
        return 1;
      }
      const result = await bootstrapOperator(db, {
        envName: process.env['ENV_NAME'],
        expectEnv,
        email,
        role,
        password,
        update,
        // Who ran it, for the audit row. Not an identity claim — nothing here
        // authenticates it — which is why the row's actor_role is SYSTEM.
        actor: process.env['SUDO_USER'] ?? process.env['USER'],
      });
      console.log(
        `${result.outcome} ${result.email} as ${result.role}` +
          (result.revokedSessions > 0
            ? `. ${result.revokedSessions} existing session(s) revoked.`
            : '.'),
      );
      return 0;
    }

    if (command === 'create') {
      const role = (process.argv[4] ?? 'ADMIN').toUpperCase();
      if (!ROLES.includes(role)) {
        console.error(`role must be one of ${ROLES.join(', ')}`);
        return 2;
      }
      // No password here. Creating the row and giving it a password are two
      // steps so that a half-finished create leaves an account nobody can use
      // rather than one anybody can.
      const res = await db
        .prepare(
          `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
           VALUES (?1, ?2, ?3, 1, ?4, ?4)
           ON CONFLICT (email) DO NOTHING`,
        )
        .bind(crypto.randomUUID(), email, role, Date.now())
        .run();
      if (res.meta.changes === 0) {
        console.error(`${email} already exists — use set-password`);
        return 1;
      }
      console.log(`created ${email} as ${role}. It cannot sign in until set-password runs.`);
      return 0;
    }

    const row = await db
      .prepare(`SELECT id, role FROM access_users WHERE email = ?1`)
      .bind(email)
      .first<{ id: string; role: string }>();
    if (!row) {
      console.error(`no operator ${email} — run: operator create ${email}`);
      return 1;
    }

    if (command === 'set-password') {
      const password = await askHidden(`new password for ${email}: `);
      const problem = passwordProblem(password);
      if (problem) {
        console.error(problem);
        return 1;
      }
      if ((await askHidden('again: ')) !== password) {
        console.error('the two did not match');
        return 1;
      }
      await db
        .prepare(
          `UPDATE access_users
              SET password_hash = ?2, password_updated_at = now(),
                  failed_attempts = 0, locked_until = NULL
            WHERE id = ?1`,
        )
        .bind(row.id, await hashPassword(password))
        .run();
      // Every existing session belonged to whoever knew the old password.
      const killed = await db
        .prepare(
          `UPDATE operator_sessions SET revoked_at = now()
            WHERE access_user_id = ?1 AND revoked_at IS NULL`,
        )
        .bind(row.id)
        .run();
      console.log(`password set. ${killed.meta.changes} existing session(s) revoked.`);
      return 0;
    }

    if (command === 'enroll-totp') {
      const secret = generateSecret();
      console.log('\nScan this in an authenticator app, or type the secret by hand:\n');
      console.log(`  ${otpauthUri(secret, email)}\n`);
      console.log(`  secret: ${secret}\n`);
      // Confirmed before it is enabled, deliberately. Turning on a second
      // factor the operator's app cannot produce locks them out of the panel
      // and there is no screen left to fix it from.
      const code = await ask('enter the six-digit code the app shows now: ');
      const check = verifyTotp(secret, code, Date.now());
      if (!check.ok) {
        console.error('that code does not match. Nothing was changed.');
        return 1;
      }
      await db
        .prepare(
          `UPDATE access_users
              SET totp_secret = ?2, totp_enabled = true, totp_last_step = ?3
            WHERE id = ?1`,
        )
        .bind(row.id, secret, check.step)
        .run();
      console.log('two-factor enabled. The code just used is already spent.');
      return 0;
    }

    if (command === 'disable-totp') {
      await db
        .prepare(
          `UPDATE access_users
              SET totp_enabled = false, totp_secret = NULL, totp_last_step = NULL
            WHERE id = ?1`,
        )
        .bind(row.id)
        .run();
      console.log('two-factor disabled.');
      return 0;
    }

    if (command === 'unlock') {
      await db
        .prepare(`UPDATE access_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?1`)
        .bind(row.id)
        .run();
      console.log('unlocked.');
      return 0;
    }

    console.error(`unknown command ${JSON.stringify(command)}`);
    return 2;
  } finally {
    rl?.close();
    await pool.end();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    // A refusal is a 1 — the operator did something wrong and can fix it. A 2
    // is this script being called wrongly. `deploy` scripts branch on these.
    process.exit(error instanceof BootstrapError ? 1 : 2);
  },
);
