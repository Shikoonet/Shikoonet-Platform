/**
 * The acceptance test for «somebody can sign in to this environment», run
 * against a process that is actually running.
 *
 *   corepack pnpm --filter @shikoo/dashboard verify-login [base-url]
 *
 * `operator-login.test.ts` already proves the login route's behaviour, and it
 * proves it against `app.fetch` — the routes agreeing with themselves. What it
 * cannot prove is that the container in front of you has a database with an
 * account in it, a cookie that survives the proxy, and a session that the next
 * request actually finds. That is what this is for, and it is the reason it
 * exists as a script rather than another test: there is nothing to assert until
 * a deployment exists.
 *
 * It creates its own throwaway operator, uses it, and deletes it. The password
 * is generated here, held in memory, and never printed, never written to disk
 * and never passed as an argument — so running this leaves no credential
 * behind and needs none to start. The account it leaves behind is none.
 *
 * Refuses to run anywhere but staging unless `--env` names somewhere else, for
 * the same reason `bootstrapOperator.ts` does: it writes an ADMIN row.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createPostgresD1 } from '@shikoo/db';
import { hashPassword } from '@shikoo/domain';
import { DEFAULT_ENV } from './bootstrapOperator.js';

/** `.invalid` is reserved by RFC 2606 — this address can never be a real one. */
const EMAIL = 'verify-login.probe@staging.invalid';

const checks: { ok: boolean; label: string; detail: string }[] = [];
function check(label: string, ok: boolean, detail = ''): void {
  checks.push({ ok, label, detail });
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const envIndex = args.indexOf('--env');
  const expect = envIndex === -1 ? DEFAULT_ENV : args[envIndex + 1];
  const envName = process.env['ENV_NAME'];
  if (envName !== expect) {
    console.error(
      `this creates and deletes an ADMIN row, so it runs only where ENV_NAME is ${JSON.stringify(expect)} — ` +
        `this process has ${envName === undefined ? 'no ENV_NAME at all' : JSON.stringify(envName)}`,
    );
    return 2;
  }
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is required');
    return 2;
  }
  const base = (args.find((a) => a.startsWith('http')) ?? 'http://127.0.0.1:8788').replace(
    /\/$/,
    '',
  );
  // Same host as the request, which is what `originGuard` compares. Sending the
  // public hostname while talking to a loopback port is a 403 that looks like a
  // login failure.
  const origin = new URL(base).origin;

  const password = `${randomBytes(18).toString('base64url')}aA1!`;
  const { db, pool } = createPostgresD1({ connectionString: url });

  const post = async (path: string, body: unknown, cookie?: string): Promise<Response> =>
    fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });

  try {
    // Written straight in, hashed by the same function the login route
    // verifies with. The CLI is exercised by its own tests; what is under test
    // here is the deployment, so this keeps the setup to one statement.
    await db.prepare(`DELETE FROM access_users WHERE email = ?1`).bind(EMAIL).run();
    const now = Date.now();
    await db
      .prepare(
        `INSERT INTO access_users
           (id, email, role, active, created_at, updated_at, password_hash, password_updated_at)
         VALUES (?1, ?2, 'ADMIN', 1, ?3, ?3, ?4, now())`,
      )
      .bind(randomUUID(), EMAIL, now, await hashPassword(password))
      .run();

    const anon = await fetch(`${base}/api/v1/auth/me`);
    check('no session is refused', anon.status === 401, String(anon.status));

    const wrong = await post('/api/v1/auth/login', { email: EMAIL, password: 'not the password' });
    check('wrong password is refused', wrong.status === 401, String(wrong.status));

    const good = await post('/api/v1/auth/login', { email: EMAIL, password });
    check('correct password signs in', good.status === 200, String(good.status));
    const raw = good.headers.get('set-cookie') ?? '';
    check(
      'cookie is HttpOnly and SameSite',
      /shikoo_session=/.test(raw) && /HttpOnly/i.test(raw) && /SameSite/i.test(raw),
      raw.replace(/shikoo_session=[^;]+/, 'shikoo_session=<redacted>'),
    );
    const cookie = (raw.match(/shikoo_session=[^;]+/) ?? [''])[0];

    const me = await fetch(`${base}/api/v1/auth/me`, { headers: { cookie } });
    check('the session reaches a protected route', me.status === 200, String(me.status));

    const bye = await post('/api/v1/auth/logout', {}, cookie);
    check('logout is accepted', bye.status === 200, String(bye.status));

    const after = await fetch(`${base}/api/v1/auth/me`, { headers: { cookie } });
    // The one that catches a logout which only clears the cookie: the same
    // cookie value is replayed, and the server has to refuse it on its own.
    check('the cookie is dead after logout', after.status === 401, String(after.status));

    const live = await db
      .prepare(
        `SELECT COUNT(*)::int AS n FROM operator_sessions s
           JOIN access_users u ON u.id = s.access_user_id
          WHERE u.email = ?1 AND s.revoked_at IS NULL`,
      )
      .bind(EMAIL)
      .first<{ n: number }>();
    check('no live session row is left', (live?.n ?? -1) === 0, `${live?.n ?? '?'} live`);
  } finally {
    await db.prepare(`DELETE FROM access_users WHERE email = ?1`).bind(EMAIL).run();
    await pool.end();
  }

  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.label}${c.detail ? `  — ${c.detail}` : ''}`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(
    failed === 0
      ? `\nall ${checks.length} checks passed against ${base}`
      : `\n${failed} of ${checks.length} checks FAILED against ${base}`,
  );
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
