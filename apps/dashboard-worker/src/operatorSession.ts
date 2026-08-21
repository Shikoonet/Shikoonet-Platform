/**
 * The login that replaces Cloudflare Access.
 *
 * Everything that touches the database lives here; the cryptography is in
 * `@shikoo/domain`'s `operatorAuth.ts` and `totp.ts`, which have no database
 * handle and are tested exhaustively without one.
 *
 * ## What this now carries
 *
 * Access was an identity layer in front of the origin, and it is gone. These
 * four routes are the entire wall. That is the reason for every unglamorous
 * thing below — the lockout inside the UPDATE, the dummy hash on an unknown
 * email, the replay check on the TOTP step, the audit row on a refusal. None of
 * them are interesting and all of them are the difference between a login page
 * and a formality.
 *
 * ## One request, not two
 *
 * Login takes the password and the code together. The alternative — password
 * first, then a second request carrying a short-lived "half authenticated"
 * token — needs server-side state that exists only to be spent once, and every
 * bug in that state is a way to skip the second factor. Here there is no
 * intermediate state at all: an account with TOTP enabled and no code supplied
 * is answered `totp_required`, the form grows a field, and the browser posts
 * the same credentials again with the code.
 */

import type { Context, Hono } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';
import type { D1Database } from '@shikoo/database';
import { isRelaxedEnv, type AccessRole, type EnvName } from '@shikoo/contracts';
import {
  LOCKOUT_MINUTES,
  MAX_FAILED_ATTEMPTS,
  clientIp,
  fixedWindowRateLimit,
  hashPassword,
  hashSessionToken,
  newSessionToken,
  passwordProblem,
  verifyPassword,
  verifyTotp,
} from '@shikoo/domain';
import { audit } from './adminAudit.js';

export const SESSION_COOKIE = 'shikoo_session';

/** Twelve hours of inactivity, and thirty days no matter how active. */
const IDLE_HOURS = 12;

/**
 * How stale `last_seen_at` must be before a request bothers to slide it.
 *
 * Small enough that the idle window is still twelve hours to any accuracy
 * anybody cares about, large enough that a dashboard polling every few seconds
 * is not writing to the same row every time.
 */
const TOUCH_MINUTES = 5;
const ABSOLUTE_DAYS = 30;

/**
 * A hash of something nobody knows, used to answer an unknown email in the same
 * time a known one takes.
 *
 * Without it, "no such operator" returns in a millisecond and "wrong password"
 * returns in a hundred, which tells anybody who asks which addresses are real.
 * Built once at module load rather than per request.
 */
const DUMMY_HASH = hashPassword('a password nobody has, for constant time').catch(() => null);

/**
 * What the per-account lockout cannot see.
 *
 * `recordFailure` locks one address after five wrong guesses, which stops
 * somebody guessing *a* password. It does nothing about the two attacks that do
 * not target one address:
 *
 *   - **Cost.** Every attempt runs scrypt — on a miss against `DUMMY_HASH`, on
 *     purpose, so an unknown address costs the same as a known one. That
 *     constant time is a feature and a lever: an attacker posting invented
 *     addresses as fast as the socket allows spends this box's CPU and never
 *     trips a lockout, because there is no row to count against.
 *   - **Denial.** Five wrong guesses every fifteen minutes keeps a real
 *     operator permanently locked out, and the guesser needs no password.
 *
 * Two windows, and the pair matters. Per-IP is the one that actually
 * discriminates, but it only exists when the proxy names the client (see
 * `clientIp`); the global one holds regardless and is set far above what a
 * dashboard with a handful of operators ever produces, so it is a ceiling on
 * abuse rather than a limit on use.
 *
 * Module-level, so it is shared by every request in the process — the whole
 * point. It is also why this is a fixed window in memory rather than a row: a
 * limiter that writes to the database for each attempt hands the attacker a
 * second, cheaper way to spend the box.
 */
const LOGIN_WINDOW_MS = 60_000;
export const LOGIN_ATTEMPTS_PER_IP = 20;
export const LOGIN_ATTEMPTS_GLOBAL = 120;

let loginPerIp = fixedWindowRateLimit({ limit: LOGIN_ATTEMPTS_PER_IP, windowMs: LOGIN_WINDOW_MS });
let loginGlobal = fixedWindowRateLimit({ limit: LOGIN_ATTEMPTS_GLOBAL, windowMs: LOGIN_WINDOW_MS });

/**
 * Empties both windows. **Tests only.**
 *
 * They are module-level because they have to be shared by every request in the
 * process — which also means one test file's attempts count against the next
 * one's, and a suite that fails because an earlier suite signed in too often is
 * a flake nobody will diagnose twice. Exported rather than reached for through
 * the module object so it is visible here what tests are allowed to do to it.
 */
export function resetLoginLimits(): void {
  loginPerIp = fixedWindowRateLimit({ limit: LOGIN_ATTEMPTS_PER_IP, windowMs: LOGIN_WINDOW_MS });
  loginGlobal = fixedWindowRateLimit({ limit: LOGIN_ATTEMPTS_GLOBAL, windowMs: LOGIN_WINDOW_MS });
}

/**
 * Whether this login attempt may proceed at all, charged before any hashing.
 *
 * Deliberately ahead of the password work rather than after it: a limiter that
 * runs last still pays for what it is refusing.
 */
async function loginAllowed(env: AuthEnv, header: (name: string) => string | undefined) {
  const ip = clientIp(header, env.TRUSTED_PROXY_IP_HEADER);
  if (ip !== null && !(await loginPerIp.limit({ key: `login:${ip}` })).success) return false;
  return (await loginGlobal.limit({ key: 'login' })).success;
}

interface OperatorRow {
  id: string;
  email: string;
  role: AccessRole;
  password_hash: string | null;
  totp_secret: string | null;
  totp_enabled: boolean;
  totp_last_step: number | null;
  locked_until: string | null;
}

export interface OperatorIdentity {
  email: string;
  role: AccessRole;
}

/**
 * The slice of the environment this file needs.
 *
 * Named rather than written inline at each helper: Hono's `Context` is
 * invariant in its bindings, so two structurally identical inline types are not
 * assignable to one another and every helper ends up demanding a cast. Taking
 * `env` instead of the whole context sidesteps that entirely, and the helpers
 * become testable without building a request.
 */
export interface AuthEnv {
  DB: D1Database;
  TEST_ACCESS_USER?: string;
  ENV_NAME?: EnvName;
  /** The header the proxy sets to the real client address. See `clientIp`. */
  TRUSTED_PROXY_IP_HEADER?: string;
}

type AuthContext = Context<{ Bindings: AuthEnv }>;

/**
 * Whether the development identity bypass applies.
 *
 * It used to key off `ACCESS_ISSUER` being absent, which is meaningless now
 * that Access is gone. `ENV_NAME` is the only thing left that distinguishes a
 * deployment, and `server.ts` refuses to start when the two are set together —
 * two independent refusals, because one of them living in a single entry point
 * is how a bypass reaches production.
 *
 * Written as an allowlist. `!== 'production'` granted the bypass to staging, to
 * an unset variable and to every typo; an environment nobody has thought about
 * yet should not be the one that gets in.
 */
export function devBypassActive(env: { TEST_ACCESS_USER?: string; ENV_NAME?: EnvName }): boolean {
  return Boolean(env.TEST_ACCESS_USER) && isRelaxedEnv(env.ENV_NAME);
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const email = value.trim().toLowerCase();
  return email === '' || email.length > 254 ? null : email;
}

/**
 * Resolve a session cookie to an identity, and keep the session alive.
 *
 * One statement. The UPDATE is the check: a revoked, idle-expired or
 * too-old session matches no row, so there is no window between deciding a
 * session is live and treating it as live. Reading first and updating after
 * would let a session revoked on another device serve one more request, which
 * is precisely the request somebody revoked it to stop.
 *
 * `expires_at` slides forward on every request so an operator working all day
 * is not thrown out mid-edit, while `created_at` caps the whole thing at thirty
 * days regardless of activity.
 */
export async function identityForToken(
  db: D1Database,
  token: string,
): Promise<OperatorIdentity | null> {
  const row = await db
    .prepare(
      // Reads on every request, writes only when the timestamp is actually
      // stale. It used to UPDATE unconditionally, and the cost was not the row
      // churn: every request took a row lock on the operator's session, so two
      // requests from one operator — which a polling dashboard makes constantly
      // — queued behind each other for no reason.
      //
      // The idle window is unchanged in the only sense that matters. Sliding at
      // most once per TOUCH_MINUTES means `expires_at` can be that
      // much behind a continuously active session, so the effective idle
      // timeout is IDLE_HOURS minus at most five minutes rather than exactly
      // IDLE_HOURS. Against a twelve-hour window that is
      // noise; against the lock it removes, it is the whole trade.
      //
      // `live` is read before `touched` writes: both CTEs see the same
      // snapshot, so the identity returned is the one the request authenticated
      // with regardless of whether the slide happened.
      `WITH live AS (
         SELECT id, access_user_id, last_seen_at
           FROM operator_sessions
          WHERE token_hash = ?1
            AND revoked_at IS NULL
            AND expires_at > now()
            AND created_at > now() - interval '${ABSOLUTE_DAYS} days'
       ), touched AS (
         UPDATE operator_sessions s
            SET last_seen_at = now(),
                expires_at   = now() + interval '${IDLE_HOURS} hours'
           FROM live
          WHERE s.id = live.id
            AND live.last_seen_at < now() - interval '${TOUCH_MINUTES} minutes'
       )
       SELECT u.email, u.role
         FROM live
         JOIN access_users u ON u.id = live.access_user_id
        WHERE u.active = 1`,
    )
    .bind(hashSessionToken(token))
    .first<{ email: string; role: AccessRole }>();
  return row ?? null;
}

/** The identity behind a cookie value, or the development bypass. */
export async function identityFor(
  env: AuthEnv,
  token: string | undefined,
): Promise<OperatorIdentity | null> {
  if (devBypassActive(env)) {
    const email = env.TEST_ACCESS_USER as string;
    // Still goes through `access_users`, so a test that grants READ_ONLY gets
    // READ_ONLY. Pinning ADMIN here made the bypass stronger than any real
    // login, which is the wrong direction for a thing that only exists in dev.
    const row = await env.DB.prepare(`SELECT role FROM access_users WHERE email = ?1 AND active = 1`)
      .bind(email)
      .first<{ role: AccessRole }>();
    return row ? { email, role: row.role } : null;
  }
  if (!token) return null;
  return identityForToken(env.DB, token);
}

/**
 * Secure on every deployed environment, and on any request that arrived over
 * https. Only local and test are allowed to fall back to the request's own
 * scheme, because only they are ever reached over plain http.
 *
 * The `__Host-` cookie prefix would be stronger and is deliberately not used:
 * it requires Secure, which a browser will not accept over plain http, so it
 * would make local development impossible while the production behaviour is
 * already covered by setting Secure here.
 */
function cookieIsSecure(env: AuthEnv, url: string): boolean {
  if (!isRelaxedEnv(env.ENV_NAME)) return true;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * How long a dead session row is kept after it stops being usable.
 *
 * Long enough to answer "where was my account signed in from last week?" on
 * «نشست‌های من», which is the only reason to keep one at all past its expiry.
 */
const SESSION_RETENTION_DAYS = 30;

/**
 * Clears out sessions that expired or were revoked a month ago.
 *
 * There was no cleanup of any kind: expiry is enforced at read time, so rows
 * accumulated for the life of the database along with their index and their
 * addresses. Not urgent — an operator logs in a few times a day — but a table
 * that only grows is one nobody chose.
 *
 * Done at login rather than by a scheduler, because the dashboard has none and
 * inventing one for a monthly DELETE would be the larger thing to maintain.
 * Logins are rare, the statement is a single indexed range, and it runs after
 * the session is issued so it cannot delay or fail a sign-in — a failure here
 * is logged and nothing else.
 */
async function pruneDeadSessions(c: AuthContext): Promise<void> {
  try {
    await c.env.DB.prepare(
      `DELETE FROM operator_sessions
        WHERE expires_at < now() - make_interval(days => ?1)
           OR (revoked_at IS NOT NULL AND revoked_at < now() - make_interval(days => ?1))`,
    )
      .bind(SESSION_RETENTION_DAYS)
      .run();
  } catch (err) {
    console.error('[dashboard] could not prune expired operator sessions', err);
  }
}

async function issueSession(c: AuthContext, operatorId: string): Promise<void> {
  const { token, hash } = newSessionToken();
  await c.env.DB.prepare(
    `INSERT INTO operator_sessions (id, access_user_id, token_hash, expires_at, ip, user_agent)
     VALUES (?1, ?2, ?3, now() + interval '${IDLE_HOURS} hours', ?4, ?5)`,
  )
    .bind(
      crypto.randomUUID(),
      operatorId,
      hash,
      // Same source as the rate limiter, and for the same reason. This used to
      // read `cf-connecting-ip` then `x-forwarded-for`, both of which any client
      // can now set to anything — so «نشست‌های من» showed an address the visitor
      // chose, which is worse than showing none: an operator checking where
      // their account has been signed in from would be reading the attacker's
      // fiction as evidence.
      clientIp((name) => c.req.header(name), c.env.TRUSTED_PROXY_IP_HEADER),
      (c.req.header('user-agent') ?? '').slice(0, 300) || null,
    )
    .run();

  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: cookieIsSecure(c.env, c.req.url),
    sameSite: 'Lax',
    path: '/',
    maxAge: IDLE_HOURS * 3600,
  });

  // After the cookie, so nothing about signing in depends on it.
  await pruneDeadSessions(c);
}

/**
 * Count a failure and lock the account, in one statement.
 *
 * Never count-then-act. Two wrong guesses arriving together would each read the
 * same count and each write the same number back, so five attempts would take
 * as many tries as the attacker had parallel connections.
 */
async function recordFailure(db: D1Database, email: string): Promise<void> {
  await db
    .prepare(
      `UPDATE access_users
          SET failed_attempts = failed_attempts + 1,
              locked_until = CASE
                WHEN failed_attempts + 1 >= ${MAX_FAILED_ATTEMPTS}
                THEN now() + interval '${LOCKOUT_MINUTES} minutes'
                ELSE locked_until
              END
        WHERE email = ?1`,
    )
    .bind(email)
    .run();
}

export function registerAuthRoutes(app: Hono<never>): void {
  const routes = app as unknown as Hono<{ Bindings: AuthEnv }>;

  routes.post('/api/v1/auth/login', async (c) => {
    // Before the body is read and long before scrypt runs, because the cost is
    // what is being refused.
    if (!(await loginAllowed(c.env, (name) => c.req.header(name)))) {
      return c.json({ ok: false, error: 'rate_limited' }, 429);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      email?: unknown;
      password?: unknown;
      code?: unknown;
    };
    const email = normalizeEmail(body.email);
    const password = typeof body.password === 'string' ? body.password : '';
    const code = typeof body.code === 'string' ? body.code : '';

    // One sentence for every way this can fail short of a lockout. Telling an
    // attacker whether the address exists, or whether the password was right
    // but the code wrong, hands them half the answer.
    const refuse = () => c.json({ ok: false, error: 'invalid_credentials' }, 401);

    if (!email || password === '') {
      await DUMMY_HASH;
      return refuse();
    }

    const row = await c.env.DB.prepare(
      `SELECT id, email, role, password_hash, totp_secret, totp_enabled,
              totp_last_step, locked_until
         FROM access_users
        WHERE email = ?1 AND active = 1`,
    )
      .bind(email)
      .first<OperatorRow>();

    if (!row) {
      // Spend the same time a real row costs, then say the same thing.
      await verifyPassword(password, await DUMMY_HASH);
      return refuse();
    }

    if (row.locked_until !== null && new Date(row.locked_until).getTime() > Date.now()) {
      // The one case that is told apart, and deliberately: an operator locked
      // out by somebody else guessing needs to know why they cannot get in,
      // and the account is already known to exist by the time this fires.
      await audit(
        c.env.DB,
        { email, role: row.role },
        'auth.login.locked',
        'access_user',
        row.id,
        null,
        null,
        null,
      );
      return c.json({ ok: false, error: 'account_locked', until: row.locked_until }, 423);
    }

    if (!(await verifyPassword(password, row.password_hash))) {
      await recordFailure(c.env.DB, email);
      await audit(
        c.env.DB,
        { email, role: row.role },
        'auth.login.failed',
        'access_user',
        row.id,
        null,
        null,
        null,
      );
      return refuse();
    }

    if (row.totp_enabled) {
      if (code === '') {
        // Not a failure: the password was right and the form needs one more
        // field. It does not count towards the lockout for the same reason.
        return c.json({ ok: false, error: 'totp_required' }, 401);
      }
      const totp = verifyTotp(row.totp_secret ?? '', code, Date.now());
      // A code stays valid across the drift window for about ninety seconds, so
      // without the step check the same six digits can be spent twice.
      if (!totp.ok || (row.totp_last_step !== null && totp.step <= row.totp_last_step)) {
        await recordFailure(c.env.DB, email);
        await audit(
          c.env.DB,
          { email, role: row.role },
          'auth.totp.failed',
          'access_user',
          row.id,
          null,
          null,
          null,
        );
        return refuse();
      }
      // Guarded so two requests racing with one code cannot both consume it.
      const consumed = await c.env.DB.prepare(
        `UPDATE access_users
            SET totp_last_step = ?2
          WHERE id = ?1 AND (totp_last_step IS NULL OR totp_last_step < ?2)`,
      )
        .bind(row.id, totp.step)
        .run();
      if (consumed.meta.changes === 0) return refuse();
    }

    await c.env.DB.prepare(
      `UPDATE access_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?1`,
    )
      .bind(row.id)
      .run();

    await issueSession(c, row.id);
    await audit(
      c.env.DB,
      { email, role: row.role },
      'auth.login',
      'access_user',
      row.id,
      null,
      { totp: row.totp_enabled },
      null,
    );
    return c.json({ ok: true, email: row.email, role: row.role });
  });

  routes.post('/api/v1/auth/logout', async (c) => {
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      await c.env.DB.prepare(
        `UPDATE operator_sessions SET revoked_at = now()
          WHERE token_hash = ?1 AND revoked_at IS NULL`,
      )
        .bind(hashSessionToken(token))
        .run();
    }
    setCookie(c, SESSION_COOKIE, '', {
      httpOnly: true,
      secure: cookieIsSecure(c.env, c.req.url),
      sameSite: 'Lax',
      path: '/',
      maxAge: 0,
    });
    return c.json({ ok: true });
  });


  /**
   * An operator changing their own password.
   *
   * There was no way to do this until 2026-08-22. The auth surface was three
   * routes — login, logout, me — and `scripts/operator.ts` was the only thing
   * that could write a password hash, which means it needed a shell on the
   * server. So an operator who suspected their password was known could not act
   * on it, and the one who lost it had to ask somebody with SSH. Neither is a
   * decision anybody made; the CLI exists to create the *first* account, and
   * that job was quietly doing this one too.
   *
   * Registered here, which puts it above the `app.use('*')` gate in
   * `index.ts` — so it checks the session itself rather than inheriting the
   * check, exactly as `/api/v1/auth/me` does two routes down. Written out
   * rather than relied upon: a route added here later and NOT doing this is
   * public, and it would look identical.
   *
   * The current password is what re-authenticates, not the session. A session
   * is a bearer token on a laptop somebody may have walked away from; without
   * this check, everything a stolen cookie could do would end with the account
   * itself. And a wrong one counts towards the same lockout a wrong login does,
   * because otherwise this route is an unlimited guessing oracle for the one
   * credential the session does not already grant.
   */
  routes.post('/api/v1/auth/password', async (c) => {
    const ident = await identityFor(c.env, getCookie(c, SESSION_COOKIE));
    if (!ident) return c.json({ ok: false, error: 'unauthorized' }, 401);

    const body = (await c.req.json().catch(() => ({}))) as {
      current?: unknown;
      next?: unknown;
    };
    const current = typeof body.current === 'string' ? body.current : '';
    const next = typeof body.next === 'string' ? body.next : '';

    const row = await c.env.DB.prepare(
      `SELECT id, role, password_hash, locked_until
         FROM access_users WHERE email = ?1 AND active = 1`,
    )
      .bind(ident.email)
      .first<{
        id: string;
        role: AccessRole;
        password_hash: string | null;
        locked_until: string | null;
      }>();
    // The row can be gone or disabled between the session being issued and now.
    if (!row) return c.json({ ok: false, error: 'unauthorized' }, 401);

    if (row.locked_until !== null && new Date(row.locked_until).getTime() > Date.now()) {
      return c.json({ ok: false, error: 'account_locked', until: row.locked_until }, 423);
    }

    if (!(await verifyPassword(current, row.password_hash))) {
      await recordFailure(c.env.DB, ident.email);
      await audit(
        c.env.DB,
        ident,
        'auth.password.refused',
        'access_user',
        row.id,
        null,
        null,
        null,
      );
      return c.json({ ok: false, error: 'invalid_credentials' }, 401);
    }

    // The same rule the CLI applies, from the same function — twelve characters
    // and four distinct ones. A second copy of the policy here is a second
    // policy the day one of them changes.
    const problem = passwordProblem(next);
    if (problem) return c.json({ ok: false, error: 'weak_password', detail: problem }, 400);

    // Not a security property — the check above already passed — but a person
    // who types the same thing twice meant to change something and did not.
    if (next === current) {
      return c.json(
        { ok: false, error: 'unchanged', detail: 'رمز تازه با رمز فعلی یکی است.' },
        400,
      );
    }

    const hash = await hashPassword(next);
    const token = getCookie(c, SESSION_COOKIE);
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE access_users
            SET password_hash = ?2, password_updated_at = now(),
                failed_attempts = 0, locked_until = NULL
          WHERE id = ?1`,
      ).bind(row.id, hash),
      // Every other session, and only the others. The CLI revokes all of them
      // because it is used when nobody can get in; here the person changing the
      // password is holding one, and signing them out of the screen they are
      // standing on teaches them to avoid the button. What must not survive is
      // a session somewhere else — which is the entire reason to change a
      // password you still know.
      c.env.DB.prepare(
        `UPDATE operator_sessions
            SET revoked_at = now()
          WHERE access_user_id = ?1 AND revoked_at IS NULL
            AND token_hash <> ?2`,
      ).bind(row.id, hashSessionToken(token ?? '')),
    ]);

    await audit(c.env.DB, ident, 'auth.password.changed', 'access_user', row.id, null, null, null);
    return c.json({ ok: true });
  });

  routes.get('/api/v1/auth/me', async (c) => {
    const ident = await identityFor(c.env, getCookie(c, SESSION_COOKIE));
    if (!ident) return c.json({ ok: false, error: 'unauthorized' }, 401);
    const row = await c.env.DB.prepare(
      `SELECT totp_enabled, password_hash IS NOT NULL AS has_password
         FROM access_users WHERE email = ?1`,
    )
      .bind(ident.email)
      .first<{ totp_enabled: boolean; has_password: boolean }>();
    return c.json({
      ok: true,
      email: ident.email,
      role: ident.role,
      totpEnabled: Boolean(row?.totp_enabled),
      hasPassword: Boolean(row?.has_password),
    });
  });
}

/** Paths that must answer before anybody has an identity. */
export function isPublicAuthPath(path: string): boolean {
  return path === '/api/v1/auth/login' || path === '/api/v1/auth/logout';
}

/**
 * The gate. Replaces the Cloudflare Access middleware.
 *
 * Static assets stay behind it exactly as they were: the login page is served
 * by the SPA shell, which is reached because `server.ts` answers the document
 * request itself. Anything under `/api/` that is not a login route needs a
 * session.
 */
/** Read the session cookie off a Hono context of any binding shape. */
export function sessionCookie(c: { req: { header: (name: string) => string | undefined } }): string | undefined {
  const raw = c.req.header('cookie');
  if (!raw) return undefined;
  for (const part of raw.split(';')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    if (part.slice(0, at).trim() === SESSION_COOKIE) return part.slice(at + 1).trim();
  }
  return undefined;
}
