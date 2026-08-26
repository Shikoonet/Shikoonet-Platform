/**
 * Adding a panel from the dashboard, and the four ways it could hurt.
 *
 * The screen had an edit button and no add button because the credential lived
 * in `PANEL_<REF>` in the bot's environment and a dashboard cannot write one.
 * Now it can, sealed, and that moves real risk into this file:
 *
 *   1. the password reaching a browser, or `audit_logs`, in any form;
 *   2. a panel that exists, is ACTIVE, and cannot log in — worse than no panel,
 *      because routing sends paid orders to it and `retryable: false` refunds
 *      the customer;
 *   3. a REVIEWER writing any of it;
 *   4. the sealed value being something the bot cannot open.
 *
 * The fourth is checked by opening it the way the BOT does rather than by
 * calling `seal` again and comparing: two calls to one function agree with each
 * other whatever that function does.
 */

import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';
import { open, panelSecretKey, splitCredential } from '@shikoo/domain';

const ADMIN = 'admin@example.com';
const REVIEWER = 'reviewer-create@example.com';
const PREFIX = 'zz-create-';
const KEY = 'ab'.repeat(32);

/** Distinctive enough that finding it in a response cannot be a coincidence. */
const PASSWORD = 'zz-canary-panel-password-9f3a';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

async function post(path: string, body: unknown, email = ADMIN): Promise<Response> {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'http://localhost' },
      body: JSON.stringify(body),
    }),
    envAs(email),
  );
}

async function panelExists(code: string): Promise<boolean> {
  const row = await baseEnv.DB.prepare(`SELECT 1 FROM provisioning_providers WHERE code = ?1`)
    .bind(code)
    .first();
  return row !== null;
}

beforeAll(async () => {
  await applySchema();
  const now = Date.now();
  for (const [email, role] of [
    [ADMIN, 'ADMIN'],
    [REVIEWER, 'REVIEWER'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT OR IGNORE INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)`,
    )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }
});

beforeEach(async () => {
  process.env['PANEL_SECRET_KEY'] = KEY;
  await baseEnv.DB.prepare(`DELETE FROM provisioning_providers WHERE code LIKE ?1`)
    .bind(`${PREFIX}%`)
    .run();
  // TRUNCATE, not DELETE: `audit_logs` refuses a DELETE by rule, and this
  // beforeEach discovering that is the guard working.
  await baseEnv.DB.prepare(`TRUNCATE audit_logs CASCADE`).run();
});

afterAll(() => {
  delete process.env['PANEL_SECRET_KEY'];
});

const BODY = {
  code: `${PREFIX}one`,
  name: 'پنل تازه',
  kind: 'pasarguard' as const,
  baseUrl: 'https://panel.invalid',
  credential: { username: 'admin', password: PASSWORD },
};

/**
 * A panel that answers, and one that does not.
 *
 * «وضعیت خودکار» probes on the way in, so a create with an unreachable address
 * is DISABLED — and the only way to write a test about the other branch is to
 * be the panel. `panel.invalid` is deliberately unresolvable, so anything not
 * stubbed here fails for real rather than by arrangement.
 */
function panelAnswers(): void {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/api/admin/token')) {
      return new Response(JSON.stringify({ access_token: 'tok' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/groups')) {
      return new Response(JSON.stringify({ groups: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // The reachability GET on the base URL, and anything else.
    return new Response('', { status: 200 });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('creating a panel', () => {
  it('creates it ACTIVE when the panel answers, with a credential the bot can open', async () => {
    panelAnswers();
    const res = await post('/api/v1/admin/panels', BODY);
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      panel: { id: number; status: string; hasSecretRef: boolean };
    };
    expect(json.panel.status).toBe('ACTIVE');
    expect(json.panel.hasSecretRef).toBe(true);

    const row = await baseEnv.DB.prepare(
      `SELECT sealed FROM provider_secrets WHERE provider_id = ?1`,
    )
      .bind(json.panel.id)
      .first<{ sealed: string }>();
    expect(row, 'no sealed row was written').not.toBeNull();
    expect(splitCredential(open(row!.sealed, panelSecretKey()))).toEqual({
      username: 'admin',
      password: PASSWORD,
    });
  });

  /**
   * The half that used to be missing, and the one the file header calls the
   * second way this can hurt: «a panel that exists, is ACTIVE, and cannot log
   * in — worse than no panel, because routing sends paid orders to it and
   * `retryable: false` refunds the customer».
   *
   * Until 2026-08-26 having a password was treated as proof the password
   * WORKED. `panel.invalid` does not resolve, so this is the real failure, not
   * a stubbed one.
   */
  it('creates it DISABLED when the address does not answer, and says why', async () => {
    const res = await post('/api/v1/admin/panels', BODY);
    expect(res.status).toBe(201);
    const json = (await res.json()) as {
      panel: { status: string };
      probe?: { reachable: boolean; authenticated: boolean };
    };
    expect(json.panel.status).toBe('DISABLED');
    expect(json.probe?.reachable, 'the screen cannot explain a status it was not told about').toBe(
      false,
    );
    expect(json.probe?.authenticated).toBe(false);
  });

  it('creates it DISABLED when the panel answers but refuses the login', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input instanceof Request ? input.url : input);
      // Reached, and the login rejected: the password is wrong, not the address.
      return url.endsWith('/api/admin/token')
        ? new Response('{}', { status: 401 })
        : new Response('', { status: 200 });
    });
    const res = await post('/api/v1/admin/panels', BODY);
    const json = (await res.json()) as {
      panel: { status: string };
      probe?: { reachable: boolean; authenticated: boolean };
    };
    expect(json.panel.status).toBe('DISABLED');
    expect(json.probe?.reachable).toBe(true);
    expect(json.probe?.authenticated).toBe(false);
  });

  it('never lets the password back out, at any key or depth', async () => {
    const created = await post('/api/v1/admin/panels', BODY);
    expect(await created.text(), 'the create response echoed it').not.toContain(PASSWORD);

    const list = await app.fetch(new Request('http://localhost/api/v1/admin/panels'), envAs(ADMIN));
    expect(await list.text(), 'the list leaked it').not.toContain(PASSWORD);
  });

  it('keeps the password out of audit_logs and records the shape instead', async () => {
    const res = await post('/api/v1/admin/panels', BODY);
    const { panel } = (await res.json()) as { panel: { id: number } };
    const log = await baseEnv.DB.prepare(
      `SELECT action, after_json::text AS after FROM audit_logs
        WHERE entity_type = 'PROVISIONING_PROVIDER' AND entity_id = ?1`,
    )
      .bind(String(panel.id))
      .first<{ action: string; after: string }>();
    expect(log?.action).toBe('catalog.panel_created');
    expect(log?.after).not.toContain(PASSWORD);
    // The fact an incident needs, without the value.
    expect(log?.after).toContain('hasCredential');
  });

  it('creates a loginable kind without a credential as DISABLED, not ACTIVE', async () => {
    // Postgres defaults status to ACTIVE, and routing asks whether a panel is
    // ACTIVE — not whether it can log in. An ACTIVE panel with no password
    // takes a paid order and refunds it in front of the customer.
    const res = await post('/api/v1/admin/panels', {
      code: `${PREFIX}nocred`,
      name: 'بی‌رمز',
      kind: 'pasarguard',
      baseUrl: 'https://panel.invalid',
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { panel: { status: string; hasSecretRef: boolean } };
    expect(json.panel.status).toBe('DISABLED');
    expect(json.panel.hasSecretRef).toBe(false);
  });

  it('leaves a kind with nothing to log into ACTIVE', async () => {
    // `manual` is fulfilled by a person. Forcing it DISABLED would make the
    // guard above a bug of its own.
    const res = await post('/api/v1/admin/panels', {
      code: `${PREFIX}manual`,
      name: 'دستی',
      kind: 'manual',
    });
    const json = (await res.json()) as { panel: { status: string } };
    expect(json.panel.status).toBe('ACTIVE');
  });

  it('refuses a duplicate code with 409 rather than a 500 from the index', async () => {
    expect((await post('/api/v1/admin/panels', BODY)).status).toBe(201);
    expect((await post('/api/v1/admin/panels', BODY)).status).toBe(409);
  });

  it('refuses a username containing a colon, which would move the split', async () => {
    // `ad:min` + `secret` seals as `ad:min:secret`, which opens as username
    // `ad` and password `min:secret` — a password nobody typed. Refused at the
    // door instead.
    const res = await post('/api/v1/admin/panels', {
      ...BODY,
      code: `${PREFIX}colon`,
      credential: { username: 'ad:min', password: PASSWORD },
    });
    expect(res.status).toBe(400);
  });

  it('refuses a REVIEWER, and writes nothing', async () => {
    const res = await post('/api/v1/admin/panels', { ...BODY, code: `${PREFIX}rev` }, REVIEWER);
    expect(res.status).toBe(403);
    expect(await panelExists(`${PREFIX}rev`), 'the row must not exist after a 403').toBe(false);
  });

  it('says the server is misconfigured rather than silently losing the password', async () => {
    // An operator typed a correct password and PANEL_SECRET_KEY is unset. A
    // generic failure sends them back to retype it; 503 tells the truth. And
    // nothing may be half-written.
    delete process.env['PANEL_SECRET_KEY'];
    const res = await post('/api/v1/admin/panels', { ...BODY, code: `${PREFIX}nokey` });
    expect(res.status).toBe(503);
    expect((await res.json()) as { error: string }).toMatchObject({ error: 'secret_key_missing' });
    expect(await panelExists(`${PREFIX}nokey`), 'nothing may be written').toBe(false);
  });
});

describe('replacing a credential', () => {

  /**
   * A password on its own, which is all the screen can send.
   *
   * No route in this app hands a stored username back — the sealed blob is the
   * only copy — so the edit form's username box is empty on a panel that already
   * has a credential. The first version required both, which meant a correct
   * password typed under a label reading «پسورد جدید (خالی = بدون تغییر)» was
   * dropped in silence and the panel came back «ورود پذیرفته نشد». Found by
   * typing one into the browser, not by reading the code.
   *
   * Asserted by OPENING the sealed value the way the bot does, so the username
   * really is the one that was already there rather than an empty string that
   * happens to seal cleanly.
   */
  it('replaces the password alone, keeping the username already sealed', async () => {
    const created = await post('/api/v1/admin/panels', BODY);
    const { panel } = (await created.json()) as { panel: { id: number } };

    const res = await post(`/api/v1/admin/panels/${panel.id}/credentials`, {
      password: 'zz-second-password-4c1d',
    });
    expect(res.status).toBe(200);

    const row = await baseEnv.DB.prepare(
      `SELECT sealed FROM provider_secrets WHERE provider_id = ?1`,
    )
      .bind(panel.id)
      .first<{ sealed: string }>();
    expect(splitCredential(open(row!.sealed, panelSecretKey()))).toEqual({
      username: 'admin',
      password: 'zz-second-password-4c1d',
    });
  });

  it('records the username it filled in, and never the password', async () => {
    const created = await post('/api/v1/admin/panels', BODY);
    const { panel } = (await created.json()) as { panel: { id: number } };
    await post(`/api/v1/admin/panels/${panel.id}/credentials`, { password: PASSWORD });

    const log = await baseEnv.DB.prepare(
      `SELECT after_json::text AS after FROM audit_logs
        WHERE action = 'catalog.panel_credential_set' AND entity_id = ?1`,
    )
      .bind(String(panel.id))
      .first<{ after: string }>();
    // The username is an operational fact somebody needs during an incident.
    // It has to be the REAL one, not the empty string a missing field would
    // otherwise leave behind.
    expect(log?.after).toContain('"username":"admin"');
    expect(log?.after).not.toContain(PASSWORD);
  });

  /**
   * The one case where the username cannot be filled in for you.
   *
   * A panel with nothing sealed has no username to inherit, and inventing one
   * would seal `:password` — a credential that logs in as nobody and fails at
   * the panel with a message about the password.
   */
  it('refuses a password alone on a panel that has no credential yet', async () => {
    const created = await post('/api/v1/admin/panels', {
      ...BODY,
      code: `${PREFIX}nocred`,
      credential: undefined,
    });
    const { panel } = (await created.json()) as { panel: { id: number } };

    const res = await post(`/api/v1/admin/panels/${panel.id}/credentials`, {
      password: 'zz-orphan-password',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain('یوزرنیم');

    const row = await baseEnv.DB.prepare(`SELECT 1 FROM provider_secrets WHERE provider_id = ?1`)
      .bind(panel.id)
      .first();
    expect(row, 'a credential was sealed with no username').toBeNull();
  });
  it('replaces in place rather than keeping a history of passwords', async () => {
    const res = await post('/api/v1/admin/panels', BODY);
    const { panel } = (await res.json()) as { panel: { id: number } };

    const second = await post(`/api/v1/admin/panels/${panel.id}/credentials`, {
      username: 'admin2',
      password: 'zz-second-password',
    });
    expect(second.status).toBe(200);

    const rows = await baseEnv.DB.prepare(
      `SELECT sealed FROM provider_secrets WHERE provider_id = ?1`,
    )
      .bind(panel.id)
      .all<{ sealed: string }>();
    expect(rows.results, 'a second row would be a stored password history').toHaveLength(1);
    expect(splitCredential(open(rows.results[0]!.sealed, panelSecretKey()))).toEqual({
      username: 'admin2',
      password: 'zz-second-password',
    });
  });

  it('refuses a REVIEWER', async () => {
    const res = await post('/api/v1/admin/panels', BODY);
    const { panel } = (await res.json()) as { panel: { id: number } };
    const denied = await post(
      `/api/v1/admin/panels/${panel.id}/credentials`,
      { username: 'x', password: 'y' },
      REVIEWER,
    );
    expect(denied.status).toBe(403);
  });
});

describe('تست ارتباط', () => {
  /**
   * The regression this file exists for most.
   *
   * The first version inferred reachability from the adapter's failure — and
   * `AccountsResult` reports a DNS failure and a refused login with the same
   * shape. Measured against the real PasarGuard test panel on 2026-08-23, a
   * hostname that does not resolve came back `reachable: true`, so the screen
   * told an operator "پنل جواب داد ولی ورود پذیرفته نشد" about an address that
   * does not exist — sending them to check a password that was never wrong.
   *
   * `.invalid` is reserved by RFC 2606 and can never resolve, so this asserts
   * the distinction without depending on anybody's network being down.
   */
  it('says not-reachable for an address that does not resolve, not wrong-password', async () => {
    const created = await post('/api/v1/admin/panels', BODY);
    const { panel } = (await created.json()) as { panel: { id: number } };

    const res = await post(`/api/v1/admin/panels/${panel.id}/test`, {});
    expect(res.status).toBe(200);
    const out = (await res.json()) as { reachable: boolean; authenticated: boolean };
    expect(out.authenticated).toBe(false);
    expect(out.reachable, 'an unresolvable host must not be reported as reachable').toBe(false);
  }, 30_000);

  it('does not draw a green tick for a kind with nothing to log into', async () => {
    // `manual` is fulfilled by a person. Answering "OK" here would teach an
    // operator to trust a mark that means nothing.
    const created = await post('/api/v1/admin/panels', {
      code: `${PREFIX}manual2`,
      name: 'دستی',
      kind: 'manual',
    });
    const { panel } = (await created.json()) as { panel: { id: number } };
    const out = (await (await post(`/api/v1/admin/panels/${panel.id}/test`, {})).json()) as {
      untestable?: boolean;
      authenticated: boolean;
    };
    expect(out.authenticated).toBe(false);
    expect(out.untestable).toBe(true);
  }, 30_000);

  it('refuses a REVIEWER, because the reply distinguishes a live panel from a dead one', async () => {
    const created = await post('/api/v1/admin/panels', BODY);
    const { panel } = (await created.json()) as { panel: { id: number } };
    const denied = await post(`/api/v1/admin/panels/${panel.id}/test`, {}, REVIEWER);
    expect(denied.status).toBe(403);
  });
});

describe('the address, normalised the way the legacy wizard asked for by hand', () => {
  /**
   * `panel/panels.php` printed four rules and trusted the operator to apply
   * them. Each one applied wrongly saves a panel that answers 404 and looks
   * configured, and the operator finds out when a paying customer's order
   * fails. They are enforced here instead of printed.
   */
  const CASES: ReadonlyArray<[string, string]> = [
    // /dashboard is the panel's web UI; the API is at the root.
    ['https://pasa.example.com/dashboard', 'https://pasa.example.com'],
    ['https://pasa.example.com/DASHBOARD/', 'https://pasa.example.com'],
    // A trailing slash doubles into `//api/...` on some builds.
    ['https://pasa.example.com/', 'https://pasa.example.com'],
    ['https://pasa.example.com///', 'https://pasa.example.com'],
    // :443 on https is the default, and keeping it makes the stored address
    // differ from the one everything else compares against.
    ['https://pasa.example.com:443', 'https://pasa.example.com'],
    ['http://pasa.example.com:80/dashboard/', 'http://pasa.example.com'],
    // A non-default port is NOT dropped — that one is load-bearing.
    ['https://pasa.example.com:8443/', 'https://pasa.example.com:8443'],
    // A sub-path that is not /dashboard survives.
    ['https://pasa.example.com/panel/', 'https://pasa.example.com/panel'],
  ];

  for (const [typed, stored] of CASES) {
    it(`stores ${typed} as ${stored}`, async () => {
      const code = `${PREFIX}url-${CASES.findIndex(([t]) => t === typed)}`;
      const res = await post('/api/v1/admin/panels', { ...BODY, code, baseUrl: typed });
      expect(res.status).toBe(201);
      const json = (await res.json()) as { panel: { baseUrl: string } };
      expect(json.panel.baseUrl).toBe(stored);
    });
  }

  it('refuses an address with no scheme instead of guessing one', async () => {
    // Guessing https for an http-only panel fails at TLS with a message about
    // certificates; guessing http sends the password in clear.
    const res = await post('/api/v1/admin/panels', {
      ...BODY,
      code: `${PREFIX}noscheme`,
      baseUrl: 'pasa.example.com',
    });
    expect(res.status).toBe(400);
    expect((await res.json()) as { detail?: string }).toMatchObject({
      detail: expect.stringContaining('http'),
    });
  });

  it('does not strip a host that merely happens to be called dashboard', async () => {
    // The rule is about a trailing PATH segment, not the hostname.
    const res = await post('/api/v1/admin/panels', {
      ...BODY,
      code: `${PREFIX}dashhost`,
      baseUrl: 'https://dashboard.example.com',
    });
    const json = (await res.json()) as { panel: { baseUrl: string } };
    expect(json.panel.baseUrl).toBe('https://dashboard.example.com');
  });
});
