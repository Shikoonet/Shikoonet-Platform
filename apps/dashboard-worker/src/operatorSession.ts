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
  hashPassword,
  hashSessionToken,
  newSessionToken,
  verifyPassword,
  verifyTotp,
} from '@shikoo/domain';
import { audit } from './adminAudit.js';

export const SESSION_COOKIE = 'shikoo_session';

/** Twelve hours of inactivity, and thirty days no matter how active. */
const IDLE_HOURS = 12;
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
      `WITH live AS (
         UPDATE operator_sessions
            SET last_seen_at = now(),
                expires_at   = now() + interval '${IDLE_HOURS} hours'
          WHERE token_hash = ?1
            AND revoked_at IS NULL
            AND expires_at > now()
            AND created_at > now() - interval '${ABSOLUTE_DAYS} days'
          RETURNING access_user_id
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
      c.req.header('cf-connecting-ip') ?? c.req.header('x-forwarded-for') ?? null,
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
