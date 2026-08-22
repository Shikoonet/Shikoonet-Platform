/**
 * The login that replaced Cloudflare Access.
 *
 * Access was an identity layer in front of the origin. These routes are what is
 * left, so the cases worth writing are the ones that decide whether this is a
 * wall or a formality: the lockout actually locking, a wrong password and an
 * unknown address being told apart by nobody, a TOTP code that cannot be spent
 * twice, and a session that dies when it is revoked.
 *
 * Every assertion here goes through `app.fetch` rather than calling the helpers,
 * because the helpers agreeing with themselves is not the question.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashPassword, codeForStep, generateSecret, stepAt } from '@shikoo/domain';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app, type Env } from '../src/index.js';
import { LOGIN_ATTEMPTS_PER_IP, resetLoginLimits } from '../src/operatorSession.js';
import { MAX_FAILED_ATTEMPTS } from '@shikoo/domain';

const EMAIL = 'login@example.com';
const PASSWORD = 'a perfectly ordinary password';

/** No TEST_ACCESS_USER: the bypass would answer every one of these for free. */
const ENV = { ...baseEnv, TEST_ACCESS_USER: '' } as Env;

async function login(body: unknown, extra: Record<string, string> = {}): Promise<Response> {
  return app.fetch(
    new Request('https://example.com/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://example.com', ...extra },
      body: JSON.stringify(body),
    }),
    ENV,
  );
}

async function seedOperator(
  over: { totpSecret?: string; role?: string; password?: string } = {},
): Promise<void> {
  const now = Date.now();
  await baseEnv.DB.prepare(`DELETE FROM access_users WHERE email = ?1`).bind(EMAIL).run();
  await baseEnv.DB.prepare(
    `INSERT INTO access_users
       (id, email, role, active, created_at, updated_at, password_hash, totp_secret, totp_enabled)
     VALUES (?1, ?2, ?3, 1, ?4, ?4, ?5, ?6, ?7)`,
  )
    .bind(
      crypto.randomUUID(),
      EMAIL,
      over.role ?? 'ADMIN',
      now,
      await hashPassword(over.password ?? PASSWORD),
      over.totpSecret ?? null,
      over.totpSecret ? true : false,
    )
    .run();
}

/** The cookie a Set-Cookie header carries, or null. */
function sessionFrom(res: Response): string | null {
  const raw = res.headers.get('set-cookie');
  if (!raw) return null;
  const match = /shikoo_session=([^;]*)/.exec(raw);
  return match?.[1] ? match[1] : null;
}

beforeAll(applySchema);
beforeEach(seedOperator);
// The limiter is module-level, because it has to be shared by every request in
// the process. Without this each test would be charged for the one before it.
beforeEach(resetLoginLimits);

describe('POST /api/v1/auth/login', () => {
  it('accepts the right password and hands back a session', async () => {
    const res = await login({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(200);
    const token = sessionFrom(res);
    expect(token).toBeTruthy();

    // The session must actually open a door — a Set-Cookie nothing honours is
    // the failure this catches.
    const after = await app.request(
      '/api/v1/admin/customers',
      { headers: { cookie: `shikoo_session=${token}` } },
      ENV,
    );
    expect(after.status).toBe(200);
  });

  it('does not write to the session on every request, but still slides it', async () => {
    // The session row used to be UPDATEd by every authenticated request. The
    // cost was not the churn — it was the row lock, which made two requests
    // from one operator queue behind each other, and a dashboard that polls
    // makes those constantly.
    //
    // Both halves are asserted here, because dropping the write entirely would
    // also pass the first one and would quietly turn a twelve-hour idle window
    // into a fixed twelve-hour session.
    const token = sessionFrom(await login({ email: EMAIL, password: PASSWORD }));
    const hit = () =>
      app.request(
        '/api/v1/admin/customers',
        { headers: { cookie: `shikoo_session=${token}` } },
        ENV,
      );
    const seen = async () =>
      (await baseEnv.DB.prepare(
        `SELECT last_seen_at::text AS s, expires_at::text AS e FROM operator_sessions
            ORDER BY created_at DESC LIMIT 1`,
      ).first<{ s: string; e: string }>())!;

    await hit();
    const first = await seen();
    await hit();
    const second = await seen();
    // Same request, seconds apart: nothing was written.
    expect(second.s).toBe(first.s);
    expect(second.e).toBe(first.e);

    // Now age the row past the touch window. The next request must slide it,
    // or an operator working all day is logged out mid-edit.
    await baseEnv.DB.prepare(
      `UPDATE operator_sessions SET last_seen_at = now() - interval '10 minutes'
        WHERE token_hash IS NOT NULL`,
    ).run();
    await hit();
    const third = await seen();
    expect(third.s).not.toBe(first.s);
    expect(new Date(third.e).getTime()).toBeGreaterThan(new Date(first.e).getTime());
  });

  it('stores only the hash, so the table cannot give a session away', async () => {
    const token = sessionFrom(await login({ email: EMAIL, password: PASSWORD }));
    const row = await baseEnv.DB.prepare(
      `SELECT token_hash FROM operator_sessions ORDER BY created_at DESC LIMIT 1`,
    ).first<{ token_hash: string }>();
    expect(row?.token_hash).toBeTruthy();
    expect(row?.token_hash).not.toBe(token);
  });

  it('sets the cookie HttpOnly, so script cannot read it', async () => {
    const raw = (await login({ email: EMAIL, password: PASSWORD })).headers.get('set-cookie') ?? '';
    expect(raw.toLowerCase()).toContain('httponly');
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/Path=\//);
  });

  it('sets Secure on a production deployment', async () => {
    const res = await app.fetch(
      new Request('https://example.com/api/v1/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://example.com' },
        body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
      }),
      { ...ENV, ENV_NAME: 'production' } as Env,
    );
    expect((res.headers.get('set-cookie') ?? '').toLowerCase()).toContain('secure');
  });

  it('refuses a wrong password', async () => {
    const res = await login({ email: EMAIL, password: 'not it' });
    expect(res.status).toBe(401);
    expect(sessionFrom(res)).toBeNull();
  });

  it('answers an unknown address exactly as it answers a wrong password', async () => {
    // Anything that tells the two apart — the status, the body, the presence of
    // a cookie — hands an attacker a list of which operators exist.
    const wrong = await login({ email: EMAIL, password: 'not it' });
    const unknown = await login({ email: 'nobody@example.com', password: 'not it' });
    expect(unknown.status).toBe(wrong.status);
    expect(await unknown.json()).toEqual(await wrong.json());
  });

  it('refuses an operator who has no password set', async () => {
    // Rows migrated from the Access era have password_hash NULL. They must not
    // be treated as "no password required".
    await baseEnv.DB.prepare(`UPDATE access_users SET password_hash = NULL WHERE email = ?1`)
      .bind(EMAIL)
      .run();
    expect((await login({ email: EMAIL, password: '' })).status).toBe(401);
    expect((await login({ email: EMAIL, password: PASSWORD })).status).toBe(401);
  });

  it('refuses a deactivated operator', async () => {
    await baseEnv.DB.prepare(`UPDATE access_users SET active = 0 WHERE email = ?1`)
      .bind(EMAIL)
      .run();
    expect((await login({ email: EMAIL, password: PASSWORD })).status).toBe(401);
  });

  it('ignores case and surrounding space in the address', async () => {
    const res = await login({ email: `  ${EMAIL.toUpperCase()} `, password: PASSWORD });
    expect(res.status).toBe(200);
  });
});

describe('the lockout', () => {
  it('closes the door after five wrong guesses, and then refuses the right password', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await login({ email: EMAIL, password: `guess ${i}` })).status).toBe(401);
    }
    const locked = await login({ email: EMAIL, password: PASSWORD });
    expect(locked.status).toBe(423);
    expect(((await locked.json()) as { error: string }).error).toBe('account_locked');
  });

  it('counts each simultaneous guess, because the count lives in the UPDATE', async () => {
    // The race the guard exists for. Read-then-write would let five parallel
    // guesses all read zero and all write one, so the lockout would cost an
    // attacker nothing but connections.
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => login({ email: EMAIL, password: `parallel ${i}` })),
    );
    const row = await baseEnv.DB.prepare(
      `SELECT failed_attempts, locked_until FROM access_users WHERE email = ?1`,
    )
      .bind(EMAIL)
      .first<{ failed_attempts: number; locked_until: string | null }>();
    expect(row?.failed_attempts).toBe(5);
    expect(row?.locked_until).not.toBeNull();
  });

  it('forgets the failures once the right password arrives', async () => {
    for (let i = 0; i < 3; i += 1) await login({ email: EMAIL, password: 'wrong' });
    expect((await login({ email: EMAIL, password: PASSWORD })).status).toBe(200);
    const row = await baseEnv.DB.prepare(
      `SELECT failed_attempts, locked_until FROM access_users WHERE email = ?1`,
    )
      .bind(EMAIL)
      .first<{ failed_attempts: number; locked_until: string | null }>();
    expect(row?.failed_attempts).toBe(0);
    expect(row?.locked_until).toBeNull();
  });

  it('opens again once the lock has expired', async () => {
    for (let i = 0; i < 5; i += 1) await login({ email: EMAIL, password: 'wrong' });
    await baseEnv.DB.prepare(
      `UPDATE access_users SET locked_until = now() - interval '1 minute' WHERE email = ?1`,
    )
      .bind(EMAIL)
      .run();
    expect((await login({ email: EMAIL, password: PASSWORD })).status).toBe(200);
  });
});

describe('the second factor', () => {
  const SECRET = generateSecret();

  beforeEach(async () => {
    await seedOperator({ totpSecret: SECRET });
  });

  it('asks for a code rather than letting the password alone in', async () => {
    const res = await login({ email: EMAIL, password: PASSWORD });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('totp_required');
    expect(sessionFrom(res)).toBeNull();
  });

  it('accepts the current code', async () => {
    const code = codeForStep(SECRET, stepAt(Date.now()));
    const res = await login({ email: EMAIL, password: PASSWORD, code });
    expect(res.status).toBe(200);
    expect(sessionFrom(res)).toBeTruthy();
  });

  it('refuses the same code a second time', async () => {
    // A code is live for about ninety seconds across the drift window, which is
    // long enough for somebody who read it over a shoulder to spend it again.
    const code = codeForStep(SECRET, stepAt(Date.now()));
    expect((await login({ email: EMAIL, password: PASSWORD, code })).status).toBe(200);
    const replay = await login({ email: EMAIL, password: PASSWORD, code });
    expect(replay.status).toBe(401);
    expect(sessionFrom(replay)).toBeNull();
  });

  it('refuses a wrong code even with the right password', async () => {
    const res = await login({ email: EMAIL, password: PASSWORD, code: '000000' });
    expect(res.status).toBe(401);
    expect(sessionFrom(res)).toBeNull();
  });

  it('refuses a right code with a wrong password', async () => {
    const code = codeForStep(SECRET, stepAt(Date.now()));
    expect((await login({ email: EMAIL, password: 'wrong', code })).status).toBe(401);
  });

  it('counts a bad code towards the lockout', async () => {
    for (let i = 0; i < 5; i += 1) {
      await login({ email: EMAIL, password: PASSWORD, code: '000000' });
    }
    const code = codeForStep(SECRET, stepAt(Date.now()));
    expect((await login({ email: EMAIL, password: PASSWORD, code })).status).toBe(423);
  });

  it('does not count a missing code, because that is the form asking', async () => {
    for (let i = 0; i < 6; i += 1) await login({ email: EMAIL, password: PASSWORD });
    const row = await baseEnv.DB.prepare(
      `SELECT failed_attempts FROM access_users WHERE email = ?1`,
    )
      .bind(EMAIL)
      .first<{ failed_attempts: number }>();
    expect(row?.failed_attempts).toBe(0);
  });
});

describe('logout and me', () => {
  it('revokes the session it was given', async () => {
    const token = sessionFrom(await login({ email: EMAIL, password: PASSWORD }));
    const cookie = `shikoo_session=${token}`;

    const out = await app.fetch(
      new Request('https://example.com/api/v1/auth/logout', {
        method: 'POST',
        headers: { cookie, origin: 'https://example.com' },
      }),
      ENV,
    );
    expect(out.status).toBe(200);

    const after = await app.request('/api/v1/admin/customers', { headers: { cookie } }, ENV);
    expect(after.status).toBe(401);
  });

  it('answers 401 with no session and the identity with one', async () => {
    expect((await app.request('/api/v1/auth/me', {}, ENV)).status).toBe(401);

    const token = sessionFrom(await login({ email: EMAIL, password: PASSWORD }));
    const res = await app.request(
      '/api/v1/auth/me',
      { headers: { cookie: `shikoo_session=${token}` } },
      ENV,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ email: EMAIL, role: 'ADMIN', totpEnabled: false });
  });

  it('never returns the TOTP secret', async () => {
    await seedOperator({ totpSecret: generateSecret() });
    const code = codeForStep(
      (await baseEnv.DB.prepare(`SELECT totp_secret FROM access_users WHERE email = ?1`)
        .bind(EMAIL)
        .first<{ totp_secret: string }>())!.totp_secret,
      stepAt(Date.now()),
    );
    const token = sessionFrom(await login({ email: EMAIL, password: PASSWORD, code }));
    const res = await app.request(
      '/api/v1/auth/me',
      { headers: { cookie: `shikoo_session=${token}` } },
      ENV,
    );
    const body = JSON.stringify(await res.json());
    expect(body).not.toContain('totpSecret');
    expect(body).not.toContain('totp_secret');
  });
});

describe('the rate limit in front of the login', () => {
  /** With the proxy header named, so the per-IP window is the one under test. */
  const ENV_BEHIND_PROXY = { ...ENV, TRUSTED_PROXY_IP_HEADER: 'x-real-ip' } as Env;

  async function attempt(ip: string, body: unknown = {}): Promise<Response> {
    return app.fetch(
      new Request('https://example.com/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://example.com',
          'x-real-ip': ip,
        },
        body: JSON.stringify(body),
      }),
      ENV_BEHIND_PROXY,
    );
  }

  it('stops one address after its window is spent', async () => {
    // The attack the per-account lockout cannot see: invented addresses. There
    // is no row to count against, so every attempt is free of the lockout and
    // costs a full scrypt — the constant-time answer that hides which addresses
    // exist is exactly what makes the flood expensive for us and cheap for them.
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_IP; i++) {
      const r = await attempt('203.0.113.9', { email: `nobody${i}@example.com`, password: 'x' });
      expect(r.status).toBe(401);
    }
    const over = await attempt('203.0.113.9', { email: 'nobody@example.com', password: 'x' });
    expect(over.status).toBe(429);
  });

  it('does not lock everybody else out with one attacker', async () => {
    // The other half, and the reason the key is the address rather than a
    // constant: the old `?? 'unknown'` would have put this operator in the same
    // bucket as the flood above and answered them 429 too.
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_IP + 5; i++) {
      await attempt('203.0.113.9', { email: `nobody${i}@example.com`, password: 'x' });
    }
    const honest = await attempt('198.51.100.4', { email: EMAIL, password: PASSWORD });
    expect(honest.status).toBe(200);
  });

  it('cannot be side-stepped by rotating a header we were not told to trust', async () => {
    // The bypass, exactly. `x-real-ip` is what the proxy vouches for and stays
    // fixed — this is one attacker. `cf-connecting-ip` and `x-forwarded-for`
    // change on every request, which is all it took under the old code: it read
    // `cf-connecting-ip` unconditionally, so each request landed in a fresh
    // bucket and the limit was bypassed by typing a header name.
    for (let i = 0; i < LOGIN_ATTEMPTS_PER_IP; i++) {
      const r = await app.fetch(
        new Request('https://example.com/api/v1/auth/login', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://example.com',
            'x-real-ip': '198.51.100.200',
            'cf-connecting-ip': `10.1.0.${i}`,
            'x-forwarded-for': `10.2.0.${i}`,
          },
          body: JSON.stringify({ email: `nobody${i}@example.com`, password: 'x' }),
        }),
        ENV_BEHIND_PROXY,
      );
      expect(r.status).toBe(401);
    }
    const over = await app.fetch(
      new Request('https://example.com/api/v1/auth/login', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://example.com',
          'x-real-ip': '198.51.100.200',
          'cf-connecting-ip': '10.1.0.99',
          'x-forwarded-for': '10.2.0.99',
        },
        body: JSON.stringify({ email: 'nobody@example.com', password: 'x' }),
      }),
      ENV_BEHIND_PROXY,
    );
    expect(over.status).toBe(429);
  });

  it('records no address on the session when none can be trusted', async () => {
    // «نشست‌های من» showing an address the visitor chose is worse than showing
    // none: an operator checking where their account has been used would be
    // reading the attacker's fiction as evidence. Every header the old code
    // consulted is sent here, and none of them may reach the row.
    await login(
      { email: EMAIL, password: PASSWORD },
      {
        'x-real-ip': '203.0.113.55',
        'cf-connecting-ip': '203.0.113.56',
        'x-forwarded-for': '203.0.113.57',
      },
    );
    const row = await baseEnv.DB.prepare(
      `SELECT s.ip FROM operator_sessions s
         JOIN access_users u ON u.id = s.access_user_id
        WHERE u.email = ?1 ORDER BY s.created_at DESC LIMIT 1`,
    )
      .bind(EMAIL)
      .first<{ ip: string | null }>();
    expect(row?.ip).toBeNull();
  });

  it('records the address the proxy vouched for', async () => {
    const r = await attempt('203.0.113.77', { email: EMAIL, password: PASSWORD });
    expect(r.status).toBe(200);
    const row = await baseEnv.DB.prepare(
      `SELECT s.ip FROM operator_sessions s
         JOIN access_users u ON u.id = s.access_user_id
        WHERE u.email = ?1 ORDER BY s.created_at DESC LIMIT 1`,
    )
      .bind(EMAIL)
      .first<{ ip: string | null }>();
    expect(row?.ip).toBe('203.0.113.77');
  });
});

describe('the audit trail', () => {
  it('records the login and the refusal, and neither carries the password', async () => {
    await login({ email: EMAIL, password: 'wrong' });
    await login({ email: EMAIL, password: PASSWORD });
    const rows = await baseEnv.DB.prepare(
      `SELECT action, before_json, after_json FROM audit_logs
        WHERE actor_email = ?1 ORDER BY created_at`,
    )
      .bind(EMAIL)
      .all<{ action: string; before_json: string | null; after_json: string | null }>();
    const actions = (rows.results ?? []).map((r) => r.action);
    expect(actions).toContain('auth.login.failed');
    expect(actions).toContain('auth.login');
    const dump = JSON.stringify(rows.results);
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain('wrong');
  });
});

/**
 * The table that only ever grew.
 *
 * `operator_sessions` had no cleanup of any kind: expiry is enforced when a
 * session is read, so an expired or revoked row sat there for the life of the
 * database, with its index and the address it recorded. Not urgent — an
 * operator logs in a few times a day — but a table nobody chose to keep is one
 * nobody is watching either.
 *
 * The rows below are aged in the database rather than by mocking a clock,
 * because the statement under test compares against `now()` inside Postgres. A
 * pinned `Date.now()` would not reach it.
 */
describe('what a login clears up after itself', () => {
  /** Labelled by `token_hash`, because `id` is a uuid column. */
  async function sessionsNamed(prefix: string): Promise<string[]> {
    const { results } = await baseEnv.DB.prepare(
      `SELECT token_hash FROM operator_sessions WHERE token_hash LIKE ?1 ORDER BY token_hash`,
    )
      .bind(`${prefix}%`)
      .all<{ token_hash: string }>();
    return (results ?? []).map((r) => r.token_hash);
  }

  it('deletes sessions that died a month ago and keeps the rest', async () => {
    const operator = await baseEnv.DB.prepare(`SELECT id FROM access_users WHERE email = ?1`)
      .bind(EMAIL)
      .first<{ id: string }>();

    const put = async (label: string, sql: string): Promise<void> => {
      await baseEnv.DB.prepare(
        `INSERT INTO operator_sessions (id, access_user_id, token_hash, expires_at, revoked_at)
         VALUES (?1, ?2, ?3, ${sql})`,
      )
        .bind(crypto.randomUUID(), operator!.id, label)
        .run();
    };
    await put('prune-old-expired', `now() - interval '40 days', NULL`);
    await put('prune-old-revoked', `now() + interval '1 hour', now() - interval '40 days'`);
    await put('prune-recent-expired', `now() - interval '2 days', NULL`);
    await put('prune-live', `now() + interval '1 hour', NULL`);

    expect(await sessionsNamed('prune-')).toHaveLength(4);
    expect((await login({ email: EMAIL, password: PASSWORD })).status).toBe(200);

    // Only what has been dead longer than the retention window. A session that
    // expired two days ago is still what «نشست‌های من» answers "where was I
    // signed in from?" with, which is the only reason to keep one at all.
    expect(await sessionsNamed('prune-')).toEqual(['prune-live', 'prune-recent-expired']);
  });
});

describe('POST /api/v1/auth/password', () => {
  const NEXT = 'a different and equally ordinary password';

  async function change(token: string | null, body: unknown): Promise<Response> {
    return app.fetch(
      new Request('https://example.com/api/v1/auth/password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          origin: 'https://example.com',
          ...(token === null ? {} : { cookie: `shikoo_session=${token}` }),
        },
        body: JSON.stringify(body),
      }),
      ENV,
    );
  }

  /** A door, so a session is judged by what it opens rather than by its row. */
  const opens = async (token: string | null): Promise<number> =>
    (
      await app.request(
        '/api/v1/admin/customers',
        { headers: { cookie: `shikoo_session=${token ?? ''}` } },
        ENV,
      )
    ).status;

  it('changes the password, judged by the login and not by the row', async () => {
    // There was no route at all until 2026-08-22: the auth surface was login,
    // logout and me, and only `scripts/operator.ts` could write a hash — which
    // means only somebody with a shell on the server could. Asserted through
    // two logins rather than by reading `password_hash`, because a hash this
    // file wrote and then recognised proves only that hashing is deterministic.
    const token = sessionFrom(await login({ email: EMAIL, password: PASSWORD }));
    expect((await change(token, { current: PASSWORD, next: NEXT })).status).toBe(200);

    expect((await login({ email: EMAIL, password: PASSWORD })).status).toBe(401);
    expect((await login({ email: EMAIL, password: NEXT })).status).toBe(200);
  });

  it('revokes every OTHER session and leaves this one standing', async () => {
    // The whole point of changing a password you still know is the session you
    // cannot see — a borrowed laptop, a machine at the shop. Revoking all of
    // them instead would sign the operator out of the screen they are standing
    // on, which teaches people not to press the button.
    const mine = sessionFrom(await login({ email: EMAIL, password: PASSWORD }));
    const elsewhere = sessionFrom(await login({ email: EMAIL, password: PASSWORD }));
    expect(await opens(elsewhere)).toBe(200);

    expect((await change(mine, { current: PASSWORD, next: NEXT })).status).toBe(200);

    expect(await opens(elsewhere)).toBe(401);
    expect(await opens(mine)).toBe(200);
  });

  it('refuses without a session, before it reads the body', async () => {
    // Registered above the `app.use('*')` gate in index.ts, like /auth/me — so
    // it does this check itself. A route added there that forgets is public and
    // looks identical.
    expect((await change(null, { current: PASSWORD, next: NEXT })).status).toBe(401);
    expect((await login({ email: EMAIL, password: PASSWORD })).status).toBe(200);
  });

  it('refuses the wrong current password, and charges it to the lockout', async () => {
    // Otherwise a stolen cookie is an unlimited guessing oracle for the one
    // credential it does not already carry.
    const token = sessionFrom(await login({ email: EMAIL, password: PASSWORD }));
    for (let n = 0; n < MAX_FAILED_ATTEMPTS; n += 1) {
      expect((await change(token, { current: 'not it', next: NEXT })).status).toBe(401);
    }
    const locked = await baseEnv.DB.prepare(
      `SELECT locked_until FROM access_users WHERE email = ?1`,
    )
      .bind(EMAIL)
      .first<{ locked_until: string | null }>();
    expect(locked?.locked_until).not.toBeNull();
    // And the real password is refused too now, which is what a lockout means.
    expect((await change(token, { current: PASSWORD, next: NEXT })).status).toBe(423);
  });

  it('applies the same policy the CLI applies, and changes nothing when it fails', async () => {
    const token = sessionFrom(await login({ email: EMAIL, password: PASSWORD }));
    const res = await change(token, { current: PASSWORD, next: 'short' });
    expect(res.status).toBe(400);
    // The message comes from `passwordProblem`, so the panel and the terminal
    // cannot drift into two different rules.
    expect(((await res.json()) as { detail: string }).detail).toContain('12');
    expect((await login({ email: EMAIL, password: PASSWORD })).status).toBe(200);
  });

  it('refuses a change that changes nothing', async () => {
    const token = sessionFrom(await login({ email: EMAIL, password: PASSWORD }));
    expect((await change(token, { current: PASSWORD, next: PASSWORD })).status).toBe(400);
  });
});
