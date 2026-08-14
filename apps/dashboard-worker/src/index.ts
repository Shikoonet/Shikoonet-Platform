import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { SQL, type D1Database, type D1PreparedStatement } from '@shikoo/database';
import {
  assertTransitionMatch,
  assertTransitionTransaction,
  assertTransitionClaim,
  resolveAccountByHint,
  previewUnassignedForHint,
  suggestMatchesForTransaction,
  rerunMatchingForUnassigned,
  listUnassignedForIdentifier,
  scoreMatch,
  DEFAULT_SCORER,
  isNewForTransaction,
  markTransactionRead,
  getSeenIdsForActor,
  buildAccountAssignmentPreview,
  applyAccountAssignmentPreview,
  declineAccountAssignmentPreview,
  assertTransitionStatus,
  auditActionForTransition,
  verifyMirzabotClaim,
  type AccountStatus,
  type D1Database as DomainD1Database,
} from '@shikoo/domain';
import { parseSms, normalizeText } from '@shikoo/sms-parser';
import {
  generateApiToken,
  sha256Hex,
  tokenPrefix,
  buildSmsRelayConfig,
  MIRZABOT_SOURCE,
} from '@shikoo/contracts';
import { lookupRole, verifyAccess } from './access.js';
import { securityHeaders, originGuard } from './security.js';
import { registerMirzabotRoutes, loadPaymentCardsForAccounts } from './mirzabotRoutes.js';
import { registerAnalyticsRoutes } from './analyticsRoutes.js';
import { registerBankRoutes } from './bankRoutes.js';
import { registerCustomerRoutes } from './customerRoutes.js';
import { registerAdminOverviewRoutes } from './adminOverviewRoutes.js';
import { registerProductRoutes } from './productRoutes.js';
import { registerPanelRoutes } from './panelRoutes.js';
import { registerDiscountRoutes } from './discountRoutes.js';
import { tehranDayFromUtc } from './tehranDay.js';

/**
 * Where the Android relay should post SMS.
 *
 * This used to fall back to a hard-coded `.workers.dev` hostname, which is the
 * wrong kind of default: the value ends up inside a configuration an admin
 * pastes into a phone, and a phone quietly posting to a host that is no longer
 * ours produces a relay that looks configured and delivers nothing. The
 * contract with that app is frozen (`POST /api/v1/sms`) and only its URL ever
 * changes — so the URL is the one thing that must be stated, not guessed.
 *
 * Returns null when unset, and the routes answer 503 rather than handing out a
 * configuration nobody can use.
 */
export function ingestUrl(env: { INGEST_URL?: string }): string | null {
  const url = env.INGEST_URL?.trim();
  return url === undefined || url === '' ? null : url;
}

const INGEST_URL_MISSING = {
  ok: false as const,
  error: 'ingest_url_not_configured',
  message: 'INGEST_URL is not set on this worker, so a relay configuration cannot be issued.',
};

export interface Env {
  DB: D1Database;
  TEST_ACCESS_USER?: string;
  ACCESS_AUD?: string;
  ACCESS_ISSUER?: string;
  /**
   * The audience tag of the *second* Cloudflare Access application — the one
   * in front of the shop's admin panel. Unset means the panel does not exist
   * on this deployment; it is never inferred from ACCESS_AUD, because that
   * would put the wallet and the catalog behind the payment operator's door.
   */
  ADMIN_ACCESS_AUD?: string;
  // "dev" | "production". Set in each wrangler config; drives the header badge.
  ENV_NAME?: string;
  // Injected at deploy time by scripts/release.sh via `wrangler deploy --var`,
  // because dev and production share one SPA bundle and one source tree.
  APP_VERSION?: string;
  // DEV-only feature flags. Production workers never set these.
  ENABLE_PURCHASE_TYPE?: string;
  DEV_BLOCK_DEVICE_ADMIN?: string;
  /** Where the Android relay posts. No default — see `ingestUrl` below. */
  INGEST_URL?: string;
  /** Comma-separated second hosts allowed to POST here. Same-origin is implicit. */
  ALLOWED_ORIGINS?: string;
}

type DB = D1Database;

// The ambient Cloudflare D1Database is gone; `@shikoo/database` re-exports the
// one real interface, which `@shikoo/domain` also uses. Same type on both
// sides now, so the cast that used to bridge them is just an identity.
function domainDb(db: DB): DomainD1Database {
  return db;
}

interface AppBindings {
  Bindings: Env;
  Variables: { identity: { email: string; role: import('@shikoo/contracts').AccessRole } };
}

/** Context of this app's routes — use instead of `any` on extracted handlers. */
type AppContext = Context<AppBindings>;

const app = new Hono<AppBindings>();

/**
 * Which surface a path belongs to.
 *
 * The shop's admin panel and the payment hub are two separate Cloudflare
 * Access applications with two separate audiences, so which one a request must
 * prove it came through is decided here, by path, before anything is verified.
 * `/admin` is the panel's page and `/api/v1/admin/*` is its API; everything
 * else is the payment hub.
 */
export function isAdminSurface(path: string): boolean {
  return path === '/admin' || path.startsWith('/admin/') || path.startsWith('/api/v1/admin/');
}

app.use('*', securityHeaders);
app.use('*', originGuard);
app.use('*', async (c, next) => {
  const admin = isAdminSurface(c.req.path);
  // Fails closed. A deployment that has not been given the admin application's
  // audience has no admin panel at all — it does not quietly fall back to the
  // payment hub's audience, which would put the shop's wallet and catalog
  // behind the payment operator's door. Same reasoning as INGEST_URL: a
  // missing setting answers 503, it does not improvise a default.
  if (admin && !c.env.TEST_ACCESS_USER && !c.env.ADMIN_ACCESS_AUD) {
    return c.json({ ok: false, error: 'admin_access_not_configured' }, 503);
  }
  const ident = await verifyAccess(
    c.req.raw,
    c.env,
    admin ? c.env.ADMIN_ACCESS_AUD : c.env.ACCESS_AUD,
  );
  if (!ident) return c.json({ ok: false, error: 'unauthorized' }, 401);
  const role = await lookupRole(c.env.DB, ident.email);
  if (!role) return c.json({ ok: false, error: 'forbidden' }, 403);
  c.set('identity', { email: ident.email, role });
  await next();
});

// DEV-only: block device-creation endpoints so an operator on the dev dashboard
// cannot accidentally fan out a real SMS-relay configuration to a phone.
if (typeof process === 'undefined' || process.env.NODE_ENV !== 'test') {
  app.use('/api/v1/devices/*', async (c, next) => {
    if (c.env?.DEV_BLOCK_DEVICE_ADMIN === 'true') {
      // Only block mutating endpoints; allow GET for read-only inspection.
      if (c.req.method !== 'GET') {
        return c.json({ ok: false, error: 'disabled_in_dev' }, 403);
      }
    }
    await next();
  });
}

app.get('/api/v1/health', (c) => c.json({ ok: true }));

// Which build is this? Dev and production sit behind the same Access policy and
// serve the same SPA bundle, so the header badge is the only way an operator can
// tell them apart. Kept behind auth like /health — no new public surface.
app.get('/api/v1/version', (c) =>
  c.json({
    ok: true,
    version: c.env.APP_VERSION ?? 'unknown',
    env: c.env.ENV_NAME ?? 'unknown',
  }),
);

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

/**
 * Every valid BANK_TRANSACTION received today must appear regardless of
 * account assignment / claim existence / match existence / status. We pick
 * the most reliable timestamp per row: bank_timestamp → sms_timestamp →
 * received_at (epoch ms from raw_sms_events). The day window is computed
 * in Asia/Tehran (the configured business timezone).
 */
const SELECT_TODAY_BASE = `
  SELECT t.id,
         t.direction,
         t.amount_irr,
         t.balance_irr,
         t.status,
         COALESCE(t.bank_timestamp, r.sms_timestamp, r.received_at) AS effective_ts,
         t.bank_timestamp,
         t.parser_id,
         t.confidence,
         t.financial_account_id,
         fa.display_name AS account_display,
         fa.account_hint AS account_hint,
         fa.bank_name AS account_bank,
         r.device_id AS device_id,
         r.sms_timestamp,
         r.received_at,
         d.display_name AS device_display_name,
         d.device_code AS device_code,
         (SELECT COUNT(*) FROM reconciliation_matches rm WHERE rm.transaction_candidate_id = t.id) AS match_count,
         dns.last_seen_transaction_at AS cursor_at,
         dns.last_seen_transaction_id AS cursor_id,
         dtr.seen_at AS seen_at
    FROM transaction_candidates t
    LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
    LEFT JOIN raw_sms_events r ON r.id = t.raw_sms_event_id
    LEFT JOIN devices d ON d.id = r.device_id
    LEFT JOIN dashboard_notification_state dns ON dns.actor_email = ?3
    LEFT JOIN dashboard_transaction_reads dtr
      ON dtr.actor_email = ?3 AND dtr.transaction_candidate_id = t.id
`;

app.get('/api/v1/today', async (c) => {
  const ident = c.get('identity');
  const { start, end } = tehranDayFromUtc(Date.now());
  const rows = await c.env.DB.prepare(
    `${SELECT_TODAY_BASE}
      WHERE COALESCE(t.bank_timestamp, r.sms_timestamp, r.received_at) BETWEEN ?1 AND ?2
        AND ${SQL.actionableTransactionWhereT}
        AND ${SQL.accountStatusWhere}
      ORDER BY effective_ts DESC
      LIMIT 500`,
  )
    .bind(start, end, ident.email)
    .all<{
      id: string;
      direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
      amount_irr: number | null;
      balance_irr: number | null;
      status: string;
      bank_timestamp: number | null;
      effective_ts: number;
      parser_id: string | null;
      confidence: number;
      financial_account_id: string | null;
      account_display: string | null;
      account_hint: string | null;
      account_bank: string | null;
      device_id: string | null;
      sms_timestamp: number;
      received_at: number;
      device_display_name: string | null;
      device_code: string | null;
      match_count: number;
      cursor_at: number | null;
      cursor_id: string | null;
      seen_at: number | null;
    }>();
  const items = rows.results.map((row) => ({
    id: row.id,
    direction: row.direction,
    amount_irr: row.amount_irr,
    balance_irr: row.balance_irr,
    status: row.status,
    bank_timestamp: row.bank_timestamp,
    sms_timestamp: row.sms_timestamp,
    received_at: row.received_at,
    effective_ts: row.effective_ts,
    parser_id: row.parser_id,
    financial_account_id: row.financial_account_id,
    account_display: row.account_display,
    account_hint: row.account_hint,
    account_bank: row.account_bank,
    device_id: row.device_id,
    device_display_name: row.device_display_name,
    device_code: row.device_code,
    has_match: Number(row.match_count ?? 0) > 0,
    is_new: isNewForTransaction(
      row.bank_timestamp,
      row.id,
      { at: row.cursor_at ?? null, id: row.cursor_id ?? null },
      row.seen_at,
    ),
    seen_at: row.seen_at ?? null,
  }));
  return c.json({ ok: true, count: items.length, items });
});

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------

app.get('/api/v1/devices', async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT d.id, d.device_code, d.display_name, d.description, d.active,
            d.last_seen_at, d.last_success_at, d.last_auth_failure_at,
            d.created_at, d.updated_at,
            (SELECT id FROM device_credentials dc
              WHERE dc.device_id = d.id AND dc.status = 'ACTIVE'
              ORDER BY dc.activated_at DESC NULLS LAST, dc.created_at DESC
              LIMIT 1) AS active_credential_id,
            (SELECT token_prefix FROM device_credentials dc
              WHERE dc.device_id = d.id AND dc.status = 'ACTIVE'
              ORDER BY dc.activated_at DESC NULLS LAST, dc.created_at DESC
              LIMIT 1) AS active_token_prefix,
            (SELECT last_used_at FROM device_credentials dc
              WHERE dc.device_id = d.id AND dc.status = 'ACTIVE'
              ORDER BY dc.activated_at DESC NULLS LAST, dc.created_at DESC
              LIMIT 1) AS active_last_used_at,
            (SELECT MAX(dc.created_at) FROM device_credentials dc
              WHERE dc.device_id = d.id) AS last_credential_created_at
       FROM devices d
      ORDER BY d.created_at DESC
      LIMIT 200`,
  ).all<{
    id: string;
    device_code: string;
    display_name: string;
    description: string | null;
    active: number;
    last_seen_at: number | null;
    last_success_at: number | null;
    last_auth_failure_at: number | null;
    created_at: number;
    updated_at: number;
    active_credential_id: string | null;
    active_token_prefix: string | null;
    active_last_used_at: number | null;
    last_credential_created_at: number | null;
  }>();
  return c.json({
    ok: true,
    items: rows.results.map((d) => ({
      id: d.id,
      device_code: d.device_code,
      display_name: d.display_name,
      description: d.description,
      active: d.active,
      last_seen_at: d.last_seen_at,
      last_success_at: d.last_success_at,
      last_auth_failure_at: d.last_auth_failure_at,
      created_at: d.created_at,
      updated_at: d.updated_at,
      credential: d.active_credential_id
        ? {
            id: d.active_credential_id,
            token_prefix: d.active_token_prefix,
            last_used_at: d.active_last_used_at,
          }
        : null,
      last_credential_created_at: d.last_credential_created_at,
    })),
  });
});

// ---------------------------------------------------------------------------
// Device administration — create + token issuance + rotate + revoke
// ---------------------------------------------------------------------------

const DeviceCodeRx = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;
const RESERVED_CODES = new Set([
  'admin',
  'api',
  'system',
  'root',
  'null',
  'undefined',
  'self',
  'me',
]);

function validateDeviceCode(raw: string): {
  ok: boolean;
  code: string;
  error?: string;
} {
  const code = raw.trim().toLowerCase();
  if (!code) return { ok: false, code: '', error: 'required' };
  if (code.length < 3 || code.length > 64) return { ok: false, code, error: 'length' };
  if (!DeviceCodeRx.test(code)) return { ok: false, code, error: 'format' };
  if (RESERVED_CODES.has(code)) return { ok: false, code, error: 'reserved' };
  return { ok: true, code };
}

const CreateDeviceBody = z
  .object({
    deviceCode: z.string().min(3).max(64),
    displayName: z.string().min(1).max(200),
    description: z.string().max(500).nullable().optional(),
  })
  .strict();

/**
 * POST /api/v1/devices
 *
 * Creates a device row + its first credential atomically.  Returns the
 * plaintext API token EXACTLY once in the response body.  The response
 * is sent with `Cache-Control: no-store` so browsers and proxies do not
 * retain it.
 */
app.post('/api/v1/devices', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  // Before anything is written: a device with no relay URL to hand back is a
  // device nobody can point at us.
  const relayUrl = ingestUrl(c.env);
  if (relayUrl === null) return c.json(INGEST_URL_MISSING, 503);
  const parsed = CreateDeviceBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const v = validateDeviceCode(parsed.data.deviceCode);
  if (!v.ok) {
    return c.json({ ok: false, error: 'invalid_device_code', reason: v.error }, 400);
  }
  if (!parsed.data.displayName.trim()) {
    return c.json({ ok: false, error: 'invalid_display_name' }, 400);
  }

  const deviceId = crypto.randomUUID();
  const credentialId = crypto.randomUUID();
  const apiKey = generateApiToken();
  const prefix = tokenPrefix(apiKey);
  const hash = await sha256Hex(apiKey);
  const now = Date.now();

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO devices
           (id, device_code, display_name, description, active,
            last_seen_at, last_success_at, last_auth_failure_at,
            created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, 1, NULL, NULL, NULL, ?5, ?5)`,
      ).bind(
        deviceId,
        v.code,
        parsed.data.displayName.trim(),
        parsed.data.description ?? null,
        now,
      ),
      c.env.DB.prepare(
        `INSERT INTO device_credentials
           (id, device_id, token_hash, token_prefix, status,
            created_at, activated_at, revoked_at, last_used_at)
         VALUES (?1, ?2, ?3, ?4, 'ACTIVE', ?5, ?5, NULL, NULL)`,
      ).bind(credentialId, deviceId, hash, prefix, now),
    ]);
  } catch (e) {
    const msg = String(e);
    if (msg.includes('UNIQUE') || msg.includes('device_code')) {
      return c.json({ ok: false, error: 'duplicate_device_code' }, 409);
    }
    return c.json({ ok: false, error: 'insert_failed' }, 500);
  }

  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'device.created',
      'DEVICE',
      deviceId,
      null,
      JSON.stringify({
        deviceCode: v.code,
        displayName: parsed.data.displayName.trim(),
        credentialId,
        tokenPrefix: prefix,
      }),
      null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({
    ok: true,
    device: {
      id: deviceId,
      deviceCode: v.code,
      displayName: parsed.data.displayName.trim(),
      description: parsed.data.description ?? null,
      active: true,
    },
    credential: {
      id: credentialId,
      apiKey,
      tokenPrefix: prefix,
      status: 'ACTIVE',
      shownOnce: true,
    },
    configuration: buildSmsRelayConfig(apiKey, v.code, parsed.data.displayName.trim(), relayUrl),
  });
});

async function findDeviceByIdOrCode(
  db: D1Database,
  idOrCode: string,
): Promise<{
  id: string;
  device_code: string;
  display_name: string;
  description: string | null;
  active: number;
  last_seen_at: number | null;
  last_success_at: number | null;
  last_auth_failure_at: number | null;
  created_at: number;
  updated_at: number;
} | null> {
  const row =
    (await db
      .prepare(
        `SELECT id, device_code, display_name, description, active,
                last_seen_at, last_success_at, last_auth_failure_at,
                created_at, updated_at
           FROM devices WHERE id = ?1 OR device_code = ?1 LIMIT 1`,
      )
      .bind(idOrCode)
      .first<{
        id: string;
        device_code: string;
        display_name: string;
        description: string | null;
        active: number;
        last_seen_at: number | null;
        last_success_at: number | null;
        last_auth_failure_at: number | null;
        created_at: number;
        updated_at: number;
      }>()) ?? null;
  return row;
}

/**
 * POST /api/v1/devices/:idOrCode/credentials
 *
 * Generate a NEW credential for an existing device.  Rejects if the
 * device already has an ACTIVE credential — the caller must use
 * `rotate` instead.
 *
 * Returns the same shape as the device creation endpoint, including the
 * one-time plaintext token.
 */
app.post('/api/v1/devices/:idOrCode/credentials', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  // Before anything is written: a device with no relay URL to hand back is a
  // device nobody can point at us.
  const relayUrl = ingestUrl(c.env);
  if (relayUrl === null) return c.json(INGEST_URL_MISSING, 503);
  const idOrCode = c.req.param('idOrCode');
  const device = await findDeviceByIdOrCode(c.env.DB, idOrCode);
  if (!device) return c.json({ ok: false, error: 'device_not_found' }, 404);
  if (!device.active) return c.json({ ok: false, error: 'device_inactive' }, 409);

  const active = await c.env.DB.prepare(
    `SELECT id, token_prefix FROM device_credentials
      WHERE device_id = ?1 AND status = 'ACTIVE' LIMIT 1`,
  )
    .bind(device.id)
    .first<{ id: string; token_prefix: string }>();
  if (active) {
    return c.json({ ok: false, error: 'active_credential_exists' }, 409);
  }

  const credentialId = crypto.randomUUID();
  const apiKey = generateApiToken();
  const prefix = tokenPrefix(apiKey);
  const hash = await sha256Hex(apiKey);
  const now = Date.now();

  await c.env.DB.prepare(
    `INSERT INTO device_credentials
       (id, device_id, token_hash, token_prefix, status,
        created_at, activated_at, revoked_at, last_used_at)
     VALUES (?1, ?2, ?3, ?4, 'ACTIVE', ?5, ?5, NULL, NULL)`,
  )
    .bind(credentialId, device.id, hash, prefix, now)
    .run();

  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'device.credential_created',
      'DEVICE',
      device.id,
      null,
      JSON.stringify({
        deviceCode: device.device_code,
        credentialId,
        tokenPrefix: prefix,
      }),
      null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({
    ok: true,
    device: {
      id: device.id,
      deviceCode: device.device_code,
      displayName: device.display_name,
      description: device.description,
      active: device.active === 1,
    },
    credential: {
      id: credentialId,
      apiKey,
      tokenPrefix: prefix,
      status: 'ACTIVE',
      shownOnce: true,
    },
    configuration: buildSmsRelayConfig(apiKey, device.device_code, device.display_name, relayUrl),
  });
});

/**
 * POST /api/v1/devices/:idOrCode/credentials/rotate
 *
 * Atomic rotation: revoke the current ACTIVE credential and issue a new
 * one.  Returns the new plaintext token exactly once.  The old token
 * stops working immediately on success.
 */
app.post('/api/v1/devices/:idOrCode/credentials/rotate', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  // Before anything is written: a device with no relay URL to hand back is a
  // device nobody can point at us.
  const relayUrl = ingestUrl(c.env);
  if (relayUrl === null) return c.json(INGEST_URL_MISSING, 503);
  const idOrCode = c.req.param('idOrCode');
  const device = await findDeviceByIdOrCode(c.env.DB, idOrCode);
  if (!device) return c.json({ ok: false, error: 'device_not_found' }, 404);

  const newCredentialId = crypto.randomUUID();
  const apiKey = generateApiToken();
  const prefix = tokenPrefix(apiKey);
  const hash = await sha256Hex(apiKey);
  const now = Date.now();

  const active = await c.env.DB.prepare(
    `SELECT id, token_prefix FROM device_credentials
      WHERE device_id = ?1 AND status = 'ACTIVE' LIMIT 1`,
  )
    .bind(device.id)
    .first<{ id: string; token_prefix: string }>();

  const stmts = [];
  if (active) {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE device_credentials
            SET status = 'REVOKED', revoked_at = ?2
          WHERE id = ?1`,
      ).bind(active.id, now),
    );
  }
  stmts.push(
    c.env.DB.prepare(
      `INSERT INTO device_credentials
         (id, device_id, token_hash, token_prefix, status,
          created_at, activated_at, revoked_at, last_used_at)
       VALUES (?1, ?2, ?3, ?4, 'ACTIVE', ?5, ?5, NULL, NULL)`,
    ).bind(newCredentialId, device.id, hash, prefix, now),
  );
  await c.env.DB.batch(stmts);

  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'device.credential_rotated',
      'DEVICE',
      device.id,
      active
        ? JSON.stringify({ oldCredentialId: active.id, oldPrefix: active.token_prefix })
        : null,
      JSON.stringify({
        deviceCode: device.device_code,
        newCredentialId,
        tokenPrefix: prefix,
      }),
      null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();

  c.header('Cache-Control', 'no-store');
  c.header('Pragma', 'no-cache');
  return c.json({
    ok: true,
    device: {
      id: device.id,
      deviceCode: device.device_code,
      displayName: device.display_name,
      description: device.description,
      active: device.active === 1,
    },
    credential: {
      id: newCredentialId,
      apiKey,
      tokenPrefix: prefix,
      status: 'ACTIVE',
      shownOnce: true,
    },
    configuration: buildSmsRelayConfig(apiKey, device.device_code, device.display_name, relayUrl),
  });
});

/**
 * POST /api/v1/devices/:idOrCode/credentials/revoke
 *
 * Mark the current ACTIVE credential as REVOKED.  Future ingest with
 * that token is rejected.  Tested end-to-end in `test/device-auth.test.ts`.
 */
app.post('/api/v1/devices/:idOrCode/credentials/revoke', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const idOrCode = c.req.param('idOrCode');
  const device = await findDeviceByIdOrCode(c.env.DB, idOrCode);
  if (!device) return c.json({ ok: false, error: 'device_not_found' }, 404);

  const active = await c.env.DB.prepare(
    `SELECT id, token_prefix FROM device_credentials
      WHERE device_id = ?1 AND status = 'ACTIVE' LIMIT 1`,
  )
    .bind(device.id)
    .first<{ id: string; token_prefix: string }>();
  if (!active) return c.json({ ok: false, error: 'no_active_credential' }, 409);

  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE device_credentials
        SET status = 'REVOKED', revoked_at = ?2
      WHERE id = ?1`,
  )
    .bind(active.id, now)
    .run();

  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'device.credential_revoked',
      'DEVICE',
      device.id,
      JSON.stringify({ credentialId: active.id, tokenPrefix: active.token_prefix }),
      null,
      null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();

  return c.json({ ok: true });
});

/**
 * POST /api/v1/devices/:idOrCode/deactivate
 *
 * Sets `active = 0`.  Ingest rejects even with a valid token.  Historical
 * raw_sms_events and transactions are NEVER deleted.
 */
app.post('/api/v1/devices/:idOrCode/deactivate', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const idOrCode = c.req.param('idOrCode');
  const device = await findDeviceByIdOrCode(c.env.DB, idOrCode);
  if (!device) return c.json({ ok: false, error: 'device_not_found' }, 404);
  if (device.active === 0) return c.json({ ok: true, alreadyInactive: true });

  const now = Date.now();
  await c.env.DB.prepare(`UPDATE devices SET active = 0, updated_at = ?2 WHERE id = ?1`)
    .bind(device.id, now)
    .run();

  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'device.deactivated',
      'DEVICE',
      device.id,
      JSON.stringify({ deviceCode: device.device_code, active: 1 }),
      JSON.stringify({ deviceCode: device.device_code, active: 0 }),
      null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();

  return c.json({ ok: true });
});

/**
 * POST /api/v1/devices/:idOrCode/reactivate
 *
 * Sets `active = 1`.  Does NOT restore any revoked token.  The dashboard
 * must show "Token required" if the device has no ACTIVE credential.
 */
app.post('/api/v1/devices/:idOrCode/reactivate', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const idOrCode = c.req.param('idOrCode');
  const device = await findDeviceByIdOrCode(c.env.DB, idOrCode);
  if (!device) return c.json({ ok: false, error: 'device_not_found' }, 404);
  if (device.active === 1) return c.json({ ok: true, alreadyActive: true });

  const now = Date.now();
  await c.env.DB.prepare(`UPDATE devices SET active = 1, updated_at = ?2 WHERE id = ?1`)
    .bind(device.id, now)
    .run();

  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'device.reactivated',
      'DEVICE',
      device.id,
      JSON.stringify({ deviceCode: device.device_code, active: 0 }),
      JSON.stringify({ deviceCode: device.device_code, active: 1 }),
      null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();

  return c.json({ ok: true });
});

/**
 * GET /api/v1/devices/:idOrCode/delete-preview
 *
 * Reports reference counts and whether the device is safe to delete.
 * Always returns 200 with a body so the dashboard can render the preview.
 * Sets Cache-Control: private, no-store so Access + browser proxies do not
 * keep this response around.
 *
 * Rules (mirrored in DELETE):
 *   - device must be `active = 0`, else `device_must_be_inactive`.
 *   - raw_sms_events, financial_accounts, transaction_candidates referencing
 *     this device MUST be zero, else `device_in_use`.
 *   - credentials may be atomically deleted as part of the DELETE call.
 */
app.get('/api/v1/devices/:idOrCode/delete-preview', async (c) => {
  const ident = c.get('identity');
  if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
  c.header('Cache-Control', 'private, no-store');
  const idOrCode = c.req.param('idOrCode');
  const device = await findDeviceByIdOrCode(c.env.DB, idOrCode);
  if (!device) return c.json({ ok: false, error: 'device_not_found' }, 404);

  const refs = await loadDeviceDeleteReferences(c.env.DB, device.id);
  const blockingReasons: string[] = [];
  if (device.active === 1) blockingReasons.push('device_must_be_inactive');
  if (refs.rawSmsEvents > 0 || refs.financialAccounts > 0 || refs.transactions > 0) {
    blockingReasons.push('device_in_use');
  }
  return c.json({
    ok: true,
    device: {
      id: device.id,
      deviceCode: device.device_code,
      displayName: device.display_name,
      active: device.active === 1,
    },
    references: refs,
    canDelete: blockingReasons.length === 0,
    blockingReasons,
  });
});

/**
 * DELETE /api/v1/devices/:idOrCode
 *
 * ADMIN-only. Atomically:
 *   - rejects with 409 device_must_be_inactive if `active = 1`
 *   - rejects with 409 device_in_use if any raw_sms_events / financial_accounts /
 *     transaction_candidates still reference this device (these are NEVER
 *     cascade-deleted)
 *   - atomically deletes device_credentials rows for this device
 *   - deletes the devices row
 *   - writes an audit log entry containing only the device id, code,
 *     display name, and deletedCredentialCount — NO tokens, NO secrets,
 *     NO full SMS bodies.
 *
 * Sets Cache-Control: private, no-store.
 */
app.delete('/api/v1/devices/:idOrCode', async (c) => {
  const ident = c.get('identity');
  if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
  c.header('Cache-Control', 'private, no-store');
  const idOrCode = c.req.param('idOrCode');
  const device = await findDeviceByIdOrCode(c.env.DB, idOrCode);
  if (!device) return c.json({ ok: false, error: 'device_not_found' }, 404);

  const refs = await loadDeviceDeleteReferences(c.env.DB, device.id);
  if (device.active === 1) {
    return c.json(
      {
        ok: false,
        error: 'device_must_be_inactive',
        device: { id: device.id, deviceCode: device.device_code, active: true },
        references: refs,
      },
      409,
    );
  }
  if (refs.rawSmsEvents > 0 || refs.financialAccounts > 0 || refs.transactions > 0) {
    return c.json(
      {
        ok: false,
        error: 'device_in_use',
        device: { id: device.id, deviceCode: device.device_code, active: false },
        references: refs,
      },
      409,
    );
  }

  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM device_credentials WHERE device_id = ?1`).bind(device.id),
    c.env.DB.prepare(`DELETE FROM devices WHERE id = ?1`).bind(device.id),
    c.env.DB.prepare(SQL.insertAudit).bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'device.deleted',
      'DEVICE',
      device.id,
      JSON.stringify({
        deviceId: device.id,
        deviceCode: device.device_code,
        displayName: device.display_name,
        active: false,
      }),
      JSON.stringify({
        deviceId: device.id,
        deviceCode: device.device_code,
        displayName: device.display_name,
        deletedCredentialCount: refs.credentials,
      }),
      null,
      c.req.header('cf-ray') ?? null,
      now,
    ),
  ]);

  return c.json({
    ok: true,
    deleted: device.id,
    references: refs,
    deletedCredentialCount: refs.credentials,
  });
});

// ---------------------------------------------------------------------------
// Matches workspace — Suggested / Unmatched / Reviewed
// ---------------------------------------------------------------------------

interface MatchRowRaw {
  m_id: string;
  transaction_candidate_id: string;
  payment_claim_id: string;
  m_status: string;
  m_score: number;
  matching_reasons_json: string;
  mismatch_reasons_json: string;
  reviewed_by: string | null;
  reviewed_at: number | null;
  tx_id: string;
  tx_raw_sms_event_id: string;
  tx_direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
  tx_amount: number | null;
  tx_balance: number | null;
  tx_status: string;
  tx_ts: number | null;
  tx_sms_timestamp: number | null;
  tx_received_at: number | null;
  tx_account_id: string | null;
  tx_account_hint: string | null;
  claim_id: string;
  claim_amount: number;
  claim_ts: number;
  claim_status: string;
  claim_account_id: string | null;
  account_display: string | null;
  account_bank: string | null;
  device_id: string | null;
  device_display_name: string | null;
  device_code: string | null;
  cursor_at: number | null;
  cursor_id: string | null;
  seen_at: number | null;
}

const SELECT_MATCH_BASE = `
  SELECT m.id AS m_id,
         m.transaction_candidate_id,
         m.payment_claim_id,
         m.status AS m_status,
         m.score AS m_score,
         m.matching_reasons_json,
         m.mismatch_reasons_json,
         m.reviewed_by,
         m.reviewed_at,
         t.id AS tx_id,
         t.raw_sms_event_id AS tx_raw_sms_event_id,
         t.direction AS tx_direction,
         t.amount_irr AS tx_amount,
         t.balance_irr AS tx_balance,
         t.status AS tx_status,
         COALESCE(t.bank_timestamp, r.sms_timestamp, r.received_at) AS tx_ts,
         r.sms_timestamp AS tx_sms_timestamp,
         r.received_at AS tx_received_at,
         t.financial_account_id AS tx_account_id,
         fa.account_hint AS tx_account_hint,
         p.id AS claim_id,
         p.expected_amount_irr AS claim_amount,
         p.submitted_at AS claim_ts,
         p.status AS claim_status,
         p.target_financial_account_id AS claim_account_id,
         fa.display_name AS account_display,
         fa.bank_name AS account_bank,
         d.id AS device_id,
         d.display_name AS device_display_name,
         d.device_code AS device_code,
         dns.last_seen_transaction_at AS cursor_at,
         dns.last_seen_transaction_id AS cursor_id,
         dtr.seen_at AS seen_at
    FROM reconciliation_matches m
    JOIN transaction_candidates t ON t.id = m.transaction_candidate_id
    LEFT JOIN raw_sms_events r ON r.id = t.raw_sms_event_id
    LEFT JOIN devices d ON d.id = r.device_id
    JOIN payment_claims p ON p.id = m.payment_claim_id
    LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
    LEFT JOIN dashboard_notification_state dns ON dns.actor_email = ?1
    LEFT JOIN dashboard_transaction_reads dtr
      ON dtr.actor_email = ?1 AND dtr.transaction_candidate_id = t.id
`;

function mapMatchRow(r: MatchRowRaw) {
  let matching: string[] = [];
  let mismatching: string[] = [];
  try {
    matching = JSON.parse(r.matching_reasons_json) as string[];
  } catch {
    /* ignore */
  }
  try {
    mismatching = JSON.parse(r.mismatch_reasons_json) as string[];
  } catch {
    /* ignore */
  }
  return {
    match: {
      id: r.m_id,
      transaction_candidate_id: r.transaction_candidate_id,
      payment_claim_id: r.payment_claim_id,
      status: r.m_status,
      score: r.m_score,
      matching_reasons: matching,
      mismatch_reasons: mismatching,
      reviewed_by: r.reviewed_by,
      reviewed_at: r.reviewed_at,
    },
    transaction: {
      id: r.tx_id,
      raw_sms_event_id: r.tx_raw_sms_event_id,
      direction: r.tx_direction,
      amount_irr: r.tx_amount,
      balance_irr: r.tx_balance,
      status: r.tx_status,
      bank_timestamp: r.tx_ts,
      sms_timestamp: r.tx_sms_timestamp,
      received_at: r.tx_received_at,
      financial_account_id: r.tx_account_id,
      account_hint: r.tx_account_hint,
      is_new: isNewForTransaction(
        r.tx_ts,
        r.tx_id,
        { at: r.cursor_at ?? null, id: r.cursor_id ?? null },
        r.seen_at,
      ),
      seen_at: r.seen_at ?? null,
    },
    claim: {
      id: r.claim_id,
      financial_account_id: r.claim_account_id,
      expected_amount_irr: r.claim_amount,
      expected_at: r.claim_ts,
      status: r.claim_status,
    },
    account_display: r.account_display,
    account_bank: r.account_bank,
    device_id: r.device_id,
    device_display_name: r.device_display_name,
    device_code: r.device_code,
  };
}

app.get('/api/v1/matches/suggested', async (c) => {
  const ident = c.get('identity');
  const rows = await c.env.DB.prepare(
    `${SELECT_MATCH_BASE}
         WHERE m.status IN ('SUGGESTED','AUTO_VERIFIED')
           AND ${SQL.actionableTransactionWhereT}
           AND ${SQL.accountStatusWhere}
         ORDER BY m.created_at DESC
         LIMIT 500`,
  )
    .bind(ident.email)
    .all<MatchRowRaw>();
  return c.json({ ok: true, items: rows.results.map(mapMatchRow) });
});

app.get('/api/v1/matches/reviewed', async (c) => {
  const ident = c.get('identity');
  const rows = await c.env.DB.prepare(
    `${SELECT_MATCH_BASE}
         WHERE m.status IN ('CONFIRMED','REJECTED')
           AND ${SQL.actionableTransactionWhereT}
           AND ${SQL.accountStatusWhere}
         ORDER BY COALESCE(m.reviewed_at, m.updated_at) DESC
         LIMIT 500`,
  )
    .bind(ident.email)
    .all<MatchRowRaw>();
  return c.json({ ok: true, items: rows.results.map(mapMatchRow) });
});

/**
 * GET /api/v1/matches/reviewed/transactions
 *
 * Returns every transaction_candidate with a transaction_reviews row —
 * both Accepted and Rejected — joined to the account and device views so
 * the dashboard can show reviewer + reviewed time. Includes a 'review'
 * block (decision + reason + comment + reviewed_at + reviewed_by).
 */
app.get('/api/v1/matches/reviewed/transactions', async (c) => {
  const ident = c.get('identity');
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.direction, t.amount_irr, t.balance_irr, t.status,
            COALESCE(t.bank_timestamp, r.sms_timestamp, r.received_at) AS effective_ts,
            t.bank_timestamp, t.parser_id,
            r.sms_timestamp AS sms_timestamp,
            r.received_at AS received_at,
            t.financial_account_id,
            fa.display_name AS account_display, fa.account_hint AS account_hint,
            fa.bank_name AS account_bank,
            d.id AS device_id, d.display_name AS device_display_name, d.device_code AS device_code,
            tr.decision, tr.reviewed_by, tr.reviewer_role, tr.reason, tr.comment, tr.reviewed_at,
            dns.last_seen_transaction_at AS cursor_at,
            dns.last_seen_transaction_id AS cursor_id,
            dtr.seen_at AS seen_at
       FROM transaction_reviews tr
       JOIN transaction_candidates t ON t.id = tr.transaction_candidate_id
       LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
       LEFT JOIN raw_sms_events r ON r.id = t.raw_sms_event_id
       LEFT JOIN devices d ON d.id = r.device_id
       LEFT JOIN dashboard_notification_state dns ON dns.actor_email = ?2
       LEFT JOIN dashboard_transaction_reads dtr
         ON dtr.actor_email = ?2 AND dtr.transaction_candidate_id = t.id
      WHERE ${SQL.actionableTransactionWhereT}
        AND ${SQL.accountStatusWhere}
       ORDER BY tr.reviewed_at DESC
       LIMIT 500`,
  )
    .bind(null, ident.email)
    .all<{
      id: string;
      direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
      amount_irr: number | null;
      balance_irr: number | null;
      status: string;
      effective_ts: number;
      bank_timestamp: number | null;
      parser_id: string | null;
      sms_timestamp: number | null;
      received_at: number | null;
      financial_account_id: string | null;
      account_display: string | null;
      account_hint: string | null;
      account_bank: string | null;
      device_display_name: string | null;
      device_code: string | null;
      device_id: string | null;
      decision: 'ACCEPTED' | 'REJECTED';
      reviewed_by: string;
      reviewer_role: string;
      reason: string | null;
      comment: string | null;
      reviewed_at: number;
      cursor_at: number | null;
      cursor_id: string | null;
      seen_at: number | null;
    }>();
  return c.json({
    ok: true,
    items: rows.results.map((r) => ({
      id: r.id,
      direction: r.direction,
      amount_irr: r.amount_irr,
      balance_irr: r.balance_irr,
      status: r.status,
      bank_timestamp: r.bank_timestamp,
      sms_timestamp: r.sms_timestamp,
      received_at: r.received_at,
      effective_ts: r.effective_ts,
      parser_id: r.parser_id,
      financial_account_id: r.financial_account_id,
      account_display: r.account_display,
      account_hint: r.account_hint,
      account_bank: r.account_bank,
      device_display_name: r.device_display_name,
      device_code: r.device_code,
      device_id: r.device_id,
      is_new: isNewForTransaction(
        r.bank_timestamp,
        r.id,
        { at: r.cursor_at ?? null, id: r.cursor_id ?? null },
        r.seen_at,
      ),
      seen_at: r.seen_at ?? null,
      review: {
        decision: r.decision,
        reviewed_by: r.reviewed_by,
        reviewer_role: r.reviewer_role,
        reason: r.reason,
        comment: r.comment,
        reviewed_at: r.reviewed_at,
      },
    })),
  });
});

/**
 * Unmatched incoming: every PARSED / NEEDS_REVIEW / MATCH_SUGGESTED
 * transaction with NO reconciliation_matches row. The "reason no match"
 * is computed explicitly so the dashboard can show the user why each
 * row is sitting here.
 */
app.get('/api/v1/matches/unmatched', async (c) => {
  const ident = c.get('identity');
  const rows = await c.env.DB.prepare(
    `SELECT t.id,
              t.direction,
              t.amount_irr,
              t.balance_irr,
              t.status,
              COALESCE(t.bank_timestamp, r.sms_timestamp, r.received_at) AS effective_ts,
              t.bank_timestamp,
              t.parser_id,
              t.parser_evidence_json,
              t.financial_account_id,
              fa.display_name AS account_display,
              fa.account_hint AS account_hint,
              fa.bank_name AS account_bank,
              r.device_id AS device_id,
              r.sms_timestamp,
              r.received_at,
              d.display_name AS device_display_name,
              d.device_code AS device_code,
              (SELECT COUNT(*) FROM payment_claims c
                 WHERE c.expected_amount_irr = t.amount_irr
                   AND c.status IN ('PENDING','MATCH_SUGGESTED')
                   AND ABS(c.submitted_at - COALESCE(t.bank_timestamp, r.sms_timestamp, r.received_at)) <= ?1
                   AND (c.target_financial_account_id IS NULL OR c.target_financial_account_id = t.financial_account_id)
              ) AS eligible_claim_count,
              dns.last_seen_transaction_at AS cursor_at,
              dns.last_seen_transaction_id AS cursor_id,
              dtr.seen_at AS seen_at
         FROM transaction_candidates t
         LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
         LEFT JOIN raw_sms_events r ON r.id = t.raw_sms_event_id
         LEFT JOIN devices d ON d.id = r.device_id
         LEFT JOIN dashboard_notification_state dns ON dns.actor_email = ?3
         LEFT JOIN dashboard_transaction_reads dtr
           ON dtr.actor_email = ?3 AND dtr.transaction_candidate_id = t.id
        WHERE t.status IN ('PARSED','NEEDS_REVIEW','MATCH_SUGGESTED')
          AND NOT EXISTS (SELECT 1 FROM reconciliation_matches rm WHERE rm.transaction_candidate_id = t.id)
          AND ${SQL.actionableTransactionWhereT}
          AND ${SQL.accountStatusWhere}
          AND NOT EXISTS (SELECT 1 FROM transaction_reviews tr WHERE tr.transaction_candidate_id = t.id)
        ORDER BY effective_ts DESC
        LIMIT 500`,
  )
    .bind(DEFAULT_SCORER.timeWindowMs, null, ident.email)
    .all<{
      id: string;
      direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
      amount_irr: number | null;
      balance_irr: number | null;
      status: string;
      effective_ts: number;
      bank_timestamp: number | null;
      parser_id: string | null;
      parser_evidence_json: string;
      financial_account_id: string | null;
      account_display: string | null;
      account_hint: string | null;
      account_bank: string | null;
      device_display_name: string | null;
      device_code: string | null;
      device_id: string | null;
      sms_timestamp: number | null;
      received_at: number | null;
      eligible_claim_count: number;
      cursor_at: number | null;
      cursor_id: string | null;
      seen_at: number | null;
    }>();
  const items = await Promise.all(
    rows.results.map(async (row) => {
      const reasons: string[] = [];
      if (!row.financial_account_id) reasons.push('no_account_assigned');
      if ((row.eligible_claim_count ?? 0) === 0) reasons.push('no_eligible_claim');
      if (row.status === 'NEEDS_REVIEW') reasons.push('parser_warnings');
      if (row.parser_id === 'unknown' || !row.parser_id) reasons.push('parser_unmatched');
      let warnings: string[] = [];
      try {
        const ev = JSON.parse(row.parser_evidence_json) as { warnings?: string[] };
        warnings = ev.warnings ?? [];
      } catch {
        /* ignore */
      }
      if (warnings.length > 0 && !reasons.includes('parser_warnings')) {
        reasons.push(`warnings:${warnings.join(',')}`);
      }
      // Detected identifiers + review row in two cheap indexed lookups.
      const idents = await c.env.DB.prepare(SQL.listDetectedIdentifiersForTx).bind(row.id).all<{
        identifier_type: 'ACCOUNT_NUMBER' | 'CARD_LAST_FOUR' | 'IBAN' | 'ACCOUNT_HINT';
        normalized_value: string;
        display_value_masked: string;
        parser_id: string;
        confidence: number;
      }>();
      const reviewRow = await c.env.DB.prepare(SQL.getTransactionReview).bind(row.id).first<{
        decision: 'ACCEPTED' | 'REJECTED';
        reviewed_by: string;
        reviewer_role: string;
        reason: string | null;
        comment: string | null;
        reviewed_at: number;
      }>();
      return {
        id: row.id,
        direction: row.direction,
        amount_irr: row.amount_irr,
        balance_irr: row.balance_irr,
        status: row.status,
        bank_timestamp: row.bank_timestamp,
        sms_timestamp: row.sms_timestamp,
        received_at: row.received_at,
        effective_ts: row.effective_ts,
        parser_id: row.parser_id,
        financial_account_id: row.financial_account_id,
        account_display: row.account_display,
        // Populate the compatibility `account_hint` from the best detected
        // identifier when the tx has no resolved account. ACCOUNT_HINT is
        // preferred over ACCOUNT_NUMBER (the former is what parsers like
        // Melli emit for their short shape like "17000"); both are better
        // than CARD_LAST_FOUR / IBAN for "what account was this".
        account_hint: row.account_hint ?? idents.results[0]?.normalized_value ?? null,
        account_bank: row.account_bank,
        device_id: row.device_id,
        device_display_name: row.device_display_name,
        device_code: row.device_code,
        reason_no_match: reasons.length > 0 ? reasons : ['unknown'],
        eligible_claim_count: row.eligible_claim_count ?? 0,
        warnings,
        detected_identifiers: idents.results.map((i) => ({
          type: i.identifier_type,
          normalized_value: i.normalized_value,
          masked_value: i.display_value_masked,
          parser_id: i.parser_id,
          confidence: i.confidence,
        })),
        review: reviewRow
          ? {
              decision: reviewRow.decision,
              reviewed_by: reviewRow.reviewed_by,
              reviewer_role: reviewRow.reviewer_role,
              reason: reviewRow.reason,
              comment: reviewRow.comment,
              reviewed_at: reviewRow.reviewed_at,
            }
          : null,
        is_new: isNewForTransaction(
          row.bank_timestamp,
          row.id,
          { at: row.cursor_at ?? null, id: row.cursor_id ?? null },
          row.seen_at,
        ),
        seen_at: row.seen_at ?? null,
      };
    }),
  );
  c.header('Cache-Control', 'private, no-store');
  return c.json({ ok: true, items });
});

// Backwards-compat: legacy /api/v1/matches routes to the suggested list.
app.get('/api/v1/matches', async (c) => {
  const rows = await c.env.DB.prepare(
    `${SELECT_MATCH_BASE}
         WHERE m.status IN ('SUGGESTED','AUTO_VERIFIED')
           AND ${SQL.actionableTransactionWhereT}
           AND ${SQL.accountStatusWhere}
         ORDER BY m.created_at DESC
         LIMIT 500`,
  ).all<MatchRowRaw>();
  const items = rows.results.map((r) => {
    const mapped = mapMatchRow(r);
    return {
      match: {
        id: mapped.match.id,
        transaction_candidate_id: mapped.match.transaction_candidate_id,
        payment_claim_id: mapped.match.payment_claim_id,
        status: mapped.match.status as 'SUGGESTED' | 'NEEDS_REVIEW' | 'CONFIRMED' | 'REJECTED',
        score: mapped.match.score,
      },
      transaction: {
        id: mapped.transaction.id,
        raw_sms_event_id: mapped.transaction.raw_sms_event_id,
        direction: mapped.transaction.direction,
        amount_irr: mapped.transaction.amount_irr,
        balance_irr: mapped.transaction.balance_irr,
        status: mapped.transaction.status,
        bank_timestamp: mapped.transaction.bank_timestamp,
        financial_account_id: mapped.transaction.financial_account_id,
      },
      claim: {
        id: mapped.claim.id,
        financial_account_id: mapped.claim.financial_account_id,
        expected_amount_irr: mapped.claim.expected_amount_irr,
        expected_at: mapped.claim.expected_at,
        status: mapped.claim.status,
      },
      account_display: mapped.account_display,
    };
  });
  return c.json({ ok: true, items });
});

// ---------------------------------------------------------------------------
// Accounts — list, totals, create, update, deactivate, identifier assign
// ---------------------------------------------------------------------------

const ACCOUNT_BASE_SELECT = `
  SELECT fa.id, fa.bank_name, fa.display_name, fa.owner_label, fa.account_type,
         fa.account_hint, fa.card_last_four, fa.account_last_four, fa.iban,
         fa.device_id, fa.active, fa.status, fa.parser_configuration,
         fa.created_at, fa.updated_at,
         d.display_name AS device_display_name
    FROM financial_accounts fa
    LEFT JOIN devices d ON d.id = fa.device_id
`;

app.get('/api/v1/accounts', async (c) => {
  const rows = await c.env.DB.prepare(
    `${ACCOUNT_BASE_SELECT} ORDER BY fa.created_at DESC LIMIT 200`,
  ).all<{
    id: string;
    bank_name: string;
    display_name: string;
    owner_label: string | null;
    account_type: string;
    account_hint: string | null;
    card_last_four: string | null;
    account_last_four: string | null;
    iban: string | null;
    device_id: string | null;
    active: number;
    parser_configuration: string;
    created_at: number;
    updated_at: number;
    device_display_name: string | null;
  }>();
  const items = await Promise.all(
    rows.results.map(async (row) => {
      const idents = await c.env.DB.prepare(
        `SELECT id, kind, value, label FROM financial_account_identifiers
             WHERE financial_account_id = ?1 ORDER BY kind, value`,
      )
        .bind(row.id)
        .all<{
          id: string;
          kind: string;
          value: string;
          label: string | null;
        }>();
      return { ...row, additional_identifiers: idents.results };
    }),
  );
  const cardsByAccount = await loadPaymentCardsForAccounts(
    c.env.DB,
    items.map((row) => row.id),
  );
  return c.json({
    ok: true,
    items: items.map((row) => ({
      ...row,
      payment_cards: cardsByAccount.get(row.id) ?? [],
    })),
  });
});

/**
 * Approved totals per account with date-range filter. Filters supported:
 *   - today      : today (Asia/Tehran)
 *   - last_7_days: 7×24h rolling back from now
 *   - last_30_days: 30×24h rolling back from now
 *   - all_time   : no lower bound
 *
 * Approved CREDIT total: sum of amount_irr for transactions with status
 * APPROVED whose CONFIRMED match exists. Each transaction counted once
 * regardless of how many non-confirmed match rows it has.
 *
 * Unmatched/pending CREDIT total: sum of amount_irr for transactions
 * with status in (PARSED, NEEDS_REVIEW, MATCH_SUGGESTED, MATCHED).
 */
type TotalsRange = 'today' | 'last_7_days' | 'last_30_days' | 'all_time';
function rangeBounds(range: TotalsRange): { start: number; end: number | null } {
  if (range === 'all_time') return { start: 0, end: null };
  const now = Date.now();
  if (range === 'today') {
    const { start, end } = tehranDayFromUtc(now);
    return { start, end };
  }
  const days = range === 'last_7_days' ? 7 : 30;
  return { start: now - days * 24 * 60 * 60 * 1000, end: null };
}

app.get('/api/v1/accounts/totals', async (c) => {
  const range = (c.req.query('range') ?? 'all_time') as TotalsRange;
  if (!['today', 'last_7_days', 'last_30_days', 'all_time'].includes(range)) {
    return c.json({ ok: false, error: 'invalid_range' }, 400);
  }
  const { start, end } = rangeBounds(range);

  const rows = await c.env.DB.prepare(
    `${ACCOUNT_BASE_SELECT}
        WHERE fa.active = 1
          AND ${SQL.accountStatusWhereFa}
        ORDER BY fa.display_name ASC
        LIMIT 500`,
  ).all<{
    id: string;
    bank_name: string;
    display_name: string;
    owner_label: string | null;
    account_type: string;
    account_hint: string | null;
    card_last_four: string | null;
    account_last_four: string | null;
    iban: string | null;
    device_id: string | null;
    active: number;
    parser_configuration: string;
    created_at: number;
    updated_at: number;
    device_display_name: string | null;
  }>();
  const items = [];
  for (const row of rows.results) {
    const params: (string | number)[] = [row.id];
    let where = `t.financial_account_id = ?1
                  AND COALESCE(t.bank_timestamp, r.sms_timestamp, r.received_at) >= ?2`;
    params.push(start);
    if (end !== null) {
      where += ` AND COALESCE(t.bank_timestamp, r.sms_timestamp, r.received_at) < ?${params.length + 1}`;
      params.push(end);
    }
    // Approved CREDIT: tx with CONFIRMED match row.
    const approved = await c.env.DB.prepare(
      `SELECT
           COALESCE(SUM(t.amount_irr), 0) AS total_irr,
           COUNT(DISTINCT t.id) AS count
           FROM transaction_candidates t
           LEFT JOIN raw_sms_events r ON r.id = t.raw_sms_event_id
          WHERE ${where}
            AND EXISTS (SELECT 1 FROM reconciliation_matches rm
                         WHERE rm.transaction_candidate_id = t.id
                           AND rm.status = 'CONFIRMED')
            AND t.amount_irr IS NOT NULL
            AND ${SQL.actionableTransactionWhereT}`,
    )
      .bind(...params)
      .first<{ total_irr: number; count: number }>();
    const pending = await c.env.DB.prepare(
      `SELECT
           COALESCE(SUM(t.amount_irr), 0) AS total_irr,
           COUNT(DISTINCT t.id) AS count
           FROM transaction_candidates t
           LEFT JOIN raw_sms_events r ON r.id = t.raw_sms_event_id
          WHERE ${where}
            AND t.status IN ('PARSED','NEEDS_REVIEW','MATCH_SUGGESTED','MATCHED')
            AND NOT EXISTS (SELECT 1 FROM reconciliation_matches rm
                             WHERE rm.transaction_candidate_id = t.id
                               AND rm.status = 'CONFIRMED')
            AND t.amount_irr IS NOT NULL
            AND ${SQL.actionableTransactionWhereT}`,
    )
      .bind(...params)
      .first<{ total_irr: number; count: number }>();
    const latest = await c.env.DB.prepare(
      `SELECT t.id, COALESCE(t.bank_timestamp, r.sms_timestamp, r.received_at) AS ts,
                t.amount_irr, t.direction, t.status
           FROM transaction_candidates t
           LEFT JOIN raw_sms_events r ON r.id = t.raw_sms_event_id
          WHERE t.financial_account_id = ?1
            AND ${SQL.actionableTransactionWhereT}
          ORDER BY COALESCE(t.bank_timestamp, r.sms_timestamp, r.received_at) DESC
          LIMIT 1`,
    )
      .bind(row.id)
      .first<{
        id: string;
        ts: number;
        amount_irr: number | null;
        direction: string;
        status: string;
      }>();
    items.push({
      account_id: row.id,
      display_name: row.display_name,
      bank_name: row.bank_name,
      account_hint: row.account_hint,
      approved_credit_total_irr: approved?.total_irr ?? 0,
      approved_credit_count: approved?.count ?? 0,
      pending_credit_total_irr: pending?.total_irr ?? 0,
      pending_credit_count: pending?.count ?? 0,
      latest_incoming:
        latest && latest.ts >= start && (end === null || latest.ts < end) ? latest : null,
    });
  }
  return c.json({ ok: true, range, items });
});

const AccountCreate = z
  .object({
    bank_name: z.string().min(1).max(120),
    display_name: z.string().min(1).max(200),
    owner_label: z.string().max(200).nullable().optional(),
    account_type: z.enum(['CARD', 'ACCOUNT', 'IBAN', 'OTHER']),
    account_hint: z.string().max(64).nullable().optional(),
    card_last_four: z
      .string()
      .regex(/^\d{4}$/)
      .nullable()
      .optional(),
    account_last_four: z
      .string()
      .regex(/^\d{4}$/)
      .nullable()
      .optional(),
    iban: z.string().max(64).nullable().optional(),
    device_id: z.string().nullable().optional(),
  })
  .strict();

app.post('/api/v1/accounts', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const parsed = AccountCreate.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const body = parsed.data;
  const id = crypto.randomUUID();
  const now = Date.now();
  // Build the fai rows in the same atomic batch as the financial_accounts
  // insert so the auto-assign resolver (which probes
  // financial_account_identifiers in addition to the canonical columns) sees
  // a consistent state. account_hint is the most common case (e.g. an
  // account number like 7001018246497) — it's mapped to the ACCOUNT_HINT
  // kind on the fai side so the resolver picks it up regardless of which
  // path the parser emits.
  const faiStmts: D1PreparedStatement[] = [];
  if (body.account_hint) {
    faiStmts.push(
      c.env.DB.prepare(
        `INSERT INTO financial_account_identifiers
           (id, financial_account_id, kind, value, label, created_at)
         VALUES (?1, ?2, 'ACCOUNT_HINT', ?3, NULL, ?4)`,
      ).bind(crypto.randomUUID(), id, body.account_hint, now),
    );
  }
  if (body.card_last_four) {
    faiStmts.push(
      c.env.DB.prepare(
        `INSERT INTO financial_account_identifiers
           (id, financial_account_id, kind, value, label, created_at)
         VALUES (?1, ?2, 'CARD_LAST_FOUR', ?3, NULL, ?4)`,
      ).bind(crypto.randomUUID(), id, body.card_last_four, now),
    );
  }
  if (body.account_last_four) {
    faiStmts.push(
      c.env.DB.prepare(
        `INSERT INTO financial_account_identifiers
           (id, financial_account_id, kind, value, label, created_at)
         VALUES (?1, ?2, 'ACCOUNT_LAST_FOUR', ?3, NULL, ?4)`,
      ).bind(crypto.randomUUID(), id, body.account_last_four, now),
    );
  }
  if (body.iban) {
    faiStmts.push(
      c.env.DB.prepare(
        `INSERT INTO financial_account_identifiers
           (id, financial_account_id, kind, value, label, created_at)
         VALUES (?1, ?2, 'IBAN', ?3, NULL, ?4)`,
      ).bind(crypto.randomUUID(), id, body.iban, now),
    );
  }
  try {
    const stmts: D1PreparedStatement[] = [
      c.env.DB.prepare(
        `INSERT INTO financial_accounts
           (id, bank_name, display_name, owner_label, account_type,
            account_hint, card_last_four, account_last_four, iban, device_id,
            active, parser_configuration, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 1, '{}', ?11, ?11)`,
      ).bind(
        id,
        body.bank_name,
        body.display_name,
        body.owner_label ?? null,
        body.account_type,
        body.account_hint ?? null,
        body.card_last_four ?? null,
        body.account_last_four ?? null,
        body.iban ?? null,
        body.device_id ?? null,
        now,
      ),
    ];
    await c.env.DB.batch([...stmts, ...faiStmts]);
  } catch (e) {
    const msg = String(e);
    if (
      msg.includes('UNIQUE') ||
      msg.includes('idx_fa_unique_active') ||
      msg.includes('idx_fai_unique_active_value')
    ) {
      return c.json({ ok: false, error: 'ACCOUNT_IDENTIFIER_AMBIGUOUS' }, 409);
    }
    return c.json({ ok: false, error: 'insert_failed' }, 500);
  }
  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'account.created',
      'ACCOUNT',
      id,
      null,
      JSON.stringify(body),
      null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();
  return c.json({ ok: true, id });
});

const AccountUpdate = AccountCreate.partial().extend({
  active: z.boolean().optional(),
});

app.patch('/api/v1/accounts/:id', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const parsed = AccountUpdate.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const id = c.req.param('id');
  const before = await c.env.DB.prepare(`SELECT * FROM financial_accounts WHERE id = ?1`)
    .bind(id)
    .first();
  if (!before) return c.json({ ok: false, error: 'not_found' }, 404);
  const fields: string[] = [];
  const values: (string | number | null)[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(parsed.data)) {
    if (v === undefined) continue;
    fields.push(`${k} = ?${i++}`);
    values.push(v as string | number | null);
  }
  if (fields.length === 0) return c.json({ ok: true });
  fields.push(`updated_at = ?${i++}`);
  values.push(Date.now());
  values.push(id);
  try {
    await c.env.DB.prepare(`UPDATE financial_accounts SET ${fields.join(', ')} WHERE id = ?${i}`)
      .bind(...(values as unknown[]))
      .run();
  } catch (e) {
    const msg = String(e);
    if (msg.includes('UNIQUE') || msg.includes('idx_fa_unique_active')) {
      return c.json({ ok: false, error: 'ACCOUNT_IDENTIFIER_AMBIGUOUS' }, 409);
    }
    return c.json({ ok: false, error: 'update_failed' }, 500);
  }
  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'account.updated',
      'ACCOUNT',
      id,
      JSON.stringify(before),
      JSON.stringify(parsed.data),
      null,
      c.req.header('cf-ray') ?? null,
      Date.now(),
    )
    .run();
  return c.json({ ok: true });
});

app.post('/api/v1/accounts/:id/deactivate', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE financial_accounts SET active = 0, updated_at = ?2 WHERE id = ?1`)
    .bind(id, now)
    .run();
  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'account.deactivated',
      'ACCOUNT',
      id,
      null,
      null,
      null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Account lifecycle endpoints — Accept / Mute / Unmute / Decline / Restore.
//
// All five routes share the same shape:
//
//   POST /api/v1/accounts/:id/accept  | PENDING → ACTIVE     (review-queued only)
//   POST /api/v1/accounts/:id/mute    | ACTIVE → MUTED
//   POST /api/v1/accounts/:id/unmute  | MUTED → ACTIVE
//   POST /api/v1/accounts/:id/decline | PENDING|ACTIVE|MUTED → DECLINED
//   POST /api/v1/accounts/:id/restore | DECLINED → PENDING
//
// Status transitions are validated by `assertTransitionStatus` in
// @shikoo/domain. Illegal transitions return 409 with a typed error. The
// `decline` endpoint accepts (PENDING, ACTIVE, MUTED) — the body's
// optional `from` is informational only; the server enforces the truth
// from the DB row.
//
// Every successful transition writes one audit row tagged with the
// dedicated action. No raw SMS body, no full identifier value — only
// the account id + status before/after + referrer (cf-ray).
//
// READ_ONLY actors are forbidden from any transition (the transition
// is a state mutation, not a read).
// ---------------------------------------------------------------------------

const VALID_TRANSITION_FROM_FOR: Record<string, AccountStatus[]> = {
  accept: ['PENDING'],
  mute: ['ACTIVE'],
  unmute: ['MUTED'],
  decline: ['PENDING', 'ACTIVE', 'MUTED'],
  restore: ['DECLINED'],
};

async function loadAccountForTransition(
  db: DB,
  accountId: string,
): Promise<{ id: string; status: AccountStatus; display_name: string } | null> {
  const row = await db
    .prepare(`SELECT id, status, display_name FROM financial_accounts WHERE id = ?1`)
    .bind(accountId)
    .first<{ id: string; status: string; display_name: string }>();
  if (!row) return null;
  return { id: row.id, status: row.status as AccountStatus, display_name: row.display_name };
}

async function applyStatusTransition(
  c: AppContext,
  accountId: string,
  action: 'accept' | 'mute' | 'unmute' | 'decline' | 'restore',
  from: AccountStatus,
  to: AccountStatus,
  now: number,
): Promise<Response> {
  const ident = c.get('identity');
  const check = assertTransitionStatus(from, to);
  if (!check.ok) {
    return c.json(
      { ok: false, error: check.reason, from: check.reason === 'illegal_transition' ? check.from : undefined, to: check.reason === 'illegal_transition' ? check.to : undefined },
      409,
    );
  }
  // Defence in depth: a race between two admins could send two transitions
  // before either commits. Verify the row is still in `from` before UPDATE.
  const upd = await c.env.DB.prepare(
    `UPDATE financial_accounts
        SET status = ?2, updated_at = ?3
      WHERE id = ?1 AND status = ?4`,
  )
    .bind(accountId, to, now, from)
    .run();
  if (!upd.meta.changes) {
    return c.json({ ok: false, error: 'status_changed' }, 409);
  }
  // Audit row. before/after store only the status, the id, and the
  // display_name — never the full account_hint or any identifiers.
  const auditAction = auditActionForTransition(from, to);
  await c.env.DB
    .prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      auditAction,
      'ACCOUNT',
      accountId,
      JSON.stringify({ status: from }),
      JSON.stringify({ status: to }),
      action,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();
  return c.json({ ok: true, status: to, from });
}

function makeStatusRoute(
  action: 'accept' | 'mute' | 'unmute' | 'decline' | 'restore',
  to: AccountStatus,
) {
  const validFrom = VALID_TRANSITION_FROM_FOR[action] ?? [];
  return async (c: AppContext) => {
    const ident = c.get('identity');
    if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
    const id = c.req.param('id');
    if (!id) return c.json({ ok: false, error: 'missing_id' }, 400);
    const account = await loadAccountForTransition(c.env.DB, id);
    if (!account) return c.json({ ok: false, error: 'account_not_found' }, 404);
    if (!validFrom.includes(account.status)) {
      return c.json(
        { ok: false, error: 'illegal_transition', from: account.status, to },
        409,
      );
    }
    return applyStatusTransition(c, id, action, account.status, to, Date.now());
  };
}

app.post('/api/v1/accounts/:id/accept', makeStatusRoute('accept', 'ACTIVE'));
app.post('/api/v1/accounts/:id/mute', makeStatusRoute('mute', 'MUTED'));
app.post('/api/v1/accounts/:id/unmute', makeStatusRoute('unmute', 'ACTIVE'));
app.post('/api/v1/accounts/:id/decline', makeStatusRoute('decline', 'DECLINED'));
app.post('/api/v1/accounts/:id/restore', makeStatusRoute('restore', 'PENDING'));

/**
 * GET /api/v1/accounts/pending — the review queue.
 *
 * Lists every PENDING account (auto-discovered and not yet reviewed)
 * plus every DECLINED account (so admins can Restore them). Both lists
 * share the same membership predicate `isReviewQueueMember` on the
 * domain side; the SQL keeps the predicate co-located.
 */
app.get('/api/v1/accounts/pending', async (c) => {
  const rows = await c.env.DB.prepare(
    `${ACCOUNT_BASE_SELECT}
        WHERE fa.active = 1
          AND fa.status IN ('PENDING','DECLINED')
        ORDER BY (fa.status = 'PENDING') DESC, fa.created_at DESC
        LIMIT 500`,
  ).all<{
    id: string;
    bank_name: string;
    display_name: string;
    owner_label: string | null;
    account_type: string;
    account_hint: string | null;
    card_last_four: string | null;
    account_last_four: string | null;
    iban: string | null;
    device_id: string | null;
    active: number;
    status: string;
    parser_configuration: string;
    created_at: number;
    updated_at: number;
    device_display_name: string | null;
  }>();
  const items = await Promise.all(
    rows.results.map(async (row) => {
      const idents = await c.env.DB
        .prepare(
          `SELECT id, kind, value, label FROM financial_account_identifiers
             WHERE financial_account_id = ?1 ORDER BY kind, value`,
        )
        .bind(row.id)
        .all<{
          id: string;
          kind: string;
          value: string;
          label: string | null;
        }>();
      return { ...row, additional_identifiers: idents.results };
    }),
  );
  const cardsByAccount = await loadPaymentCardsForAccounts(
    c.env.DB,
    items.map((row) => row.id),
  );
  return c.json({
    ok: true,
    items: items.map((row) => ({
      ...row,
      payment_cards: cardsByAccount.get(row.id) ?? [],
    })),
  });
});

/**
 * Account deletion — permanent removal of an INACTIVE financial_accounts row.
 *
 * Rules (must hold simultaneously):
 *   1. account exists
 *   2. account.active = 0        — otherwise 409 account_must_be_inactive
 *   3. no transactions, payment_claims, or other FK references that would
 *      silently SET NULL on cascade — otherwise 409 account_in_use
 *
 * The deletion is atomic via D1 `batch`. ON DELETE CASCADE removes
 * financial_account_identifiers; ON DELETE SET NULL wipes the
 * financial_account_id backrefs on transactions + claims (intentional:
 * we keep the history, just detach the account). The audit row records
 * { account_id, display_name, deleted_identifier_count } with no secrets.
 */
interface AccountRefCounts {
  transactions: number;
  paymentClaims: number;
  identifiers: number;
}

async function countAccountReferences(db: DB, accountId: string): Promise<AccountRefCounts> {
  const [txRes, claimRes, identRes] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS n FROM transaction_candidates WHERE financial_account_id = ?1`)
      .bind(accountId)
      .first<{ n: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM payment_claims WHERE target_financial_account_id = ?1`)
      .bind(accountId)
      .first<{ n: number }>(),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM financial_account_identifiers WHERE financial_account_id = ?1`,
      )
      .bind(accountId)
      .first<{ n: number }>(),
  ]);
  return {
    transactions: txRes?.n ?? 0,
    paymentClaims: claimRes?.n ?? 0,
    identifiers: identRes?.n ?? 0,
  };
}

/**
 * Reference counts used by both the preview and DELETE handler. None of
 * these tables cascades on device delete, so any non-zero count means the
 * device is still in use and MUST be blocked.
 */
async function loadDeviceDeleteReferences(
  db: DB,
  deviceId: string,
): Promise<{
  rawSmsEvents: number;
  financialAccounts: number;
  credentials: number;
  transactions: number;
}> {
  const [smsRes, acctRes, credRes, txRes] = await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS n FROM raw_sms_events WHERE device_id = ?1`)
      .bind(deviceId)
      .first<{ n: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM financial_accounts WHERE device_id = ?1`)
      .bind(deviceId)
      .first<{ n: number }>(),
    db
      .prepare(`SELECT COUNT(*) AS n FROM device_credentials WHERE device_id = ?1`)
      .bind(deviceId)
      .first<{ n: number }>(),
    // Transactions join through raw_sms_events. Use the join rather than
    // a denormalised device_id column (which does not exist).
    db
      .prepare(
        `SELECT COUNT(*) AS n
           FROM transaction_candidates tc
           JOIN raw_sms_events r ON r.id = tc.raw_sms_event_id
          WHERE r.device_id = ?1`,
      )
      .bind(deviceId)
      .first<{ n: number }>(),
  ]);
  return {
    rawSmsEvents: smsRes?.n ?? 0,
    financialAccounts: acctRes?.n ?? 0,
    credentials: credRes?.n ?? 0,
    transactions: txRes?.n ?? 0,
  };
}

app.get('/api/v1/accounts/:id/delete-preview', async (c) => {
  const ident = c.get('identity');
  if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
  const id = c.req.param('id');
  c.header('Cache-Control', 'private, no-store');
  const account = await c.env.DB.prepare(
    `SELECT id, display_name, bank_name, active FROM financial_accounts WHERE id = ?1`,
  )
    .bind(id)
    .first<{ id: string; display_name: string; bank_name: string; active: number }>();
  if (!account) return c.json({ ok: false, error: 'not_found' }, 404);
  const refs = await countAccountReferences(c.env.DB, id);
  // "in_use" = there is history attached. The two FK columns use ON DELETE
  // SET NULL so the DELETE itself would succeed, but the spec forbids
  // silent detachment: we block the call when history exists and require
  // reassignment / merge first.
  const inUse = refs.transactions > 0 || refs.paymentClaims > 0;
  const blockingReasons: string[] = [];
  if (account.active === 1) blockingReasons.push('account_must_be_inactive');
  if (inUse) blockingReasons.push('account_in_use');
  return c.json({
    ok: true,
    account: {
      id: account.id,
      displayName: account.display_name,
      bank: account.bank_name,
      active: account.active === 1,
    },
    references: {
      transactions: refs.transactions,
      paymentClaims: refs.paymentClaims,
      matches: 0, // matches reference transactions, not accounts directly
      identifiers: refs.identifiers,
    },
    canDelete: blockingReasons.length === 0,
    blockingReasons,
  });
});

app.delete('/api/v1/accounts/:id', async (c) => {
  const ident = c.get('identity');
  if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const account = await c.env.DB.prepare(
    `SELECT id, display_name, bank_name, active FROM financial_accounts WHERE id = ?1`,
  )
    .bind(id)
    .first<{ id: string; display_name: string; bank_name: string; active: number }>();
  if (!account) return c.json({ ok: false, error: 'not_found' }, 404);
  const refs = await countAccountReferences(c.env.DB, id);
  // Active accounts can never be deleted (must be deactivated first).
  if (account.active === 1) {
    return c.json(
      {
        ok: false,
        error: 'account_must_be_inactive',
        references: refs,
      },
      409,
    );
  }
  // Inactive accounts with history are blocked — we do not silently detach.
  if (refs.transactions > 0 || refs.paymentClaims > 0) {
    return c.json(
      {
        ok: false,
        error: 'account_in_use',
        references: refs,
      },
      409,
    );
  }
  // Delete the account row; CASCADE removes its identifiers; idempotent
  // (no other rows reference the account now).
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(`DELETE FROM financial_accounts WHERE id = ?1`).bind(id),
    c.env.DB.prepare(SQL.insertAudit).bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'account.deleted',
      'ACCOUNT',
      id,
      JSON.stringify({
        displayName: account.display_name,
        bank: account.bank_name,
        deletedIdentifierCount: refs.identifiers,
      }),
      null,
      null,
      c.req.header('cf-ray') ?? null,
      now,
    ),
  ]);
  return c.json({ ok: true, deleted: id, references: refs });
});

const AnalyzeBody = z.object({ body: z.string().min(1).max(8000) }).strict();

/**
 * Sample SMS analyzer — runs the real parser registry against the
 * provided body and reports detected identifiers. Does NOT persist the
 * raw SMS anywhere; transient only.
 */
app.post('/api/v1/accounts/analyze', async (c) => {
  const parsed = AnalyzeBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const normalized = normalizeText(parsed.data.body);
  const result = parseSms({
    raw: parsed.data.body,
    text: normalized.text,
    sender: 'SAMPLE',
    timestamp: Date.now(),
    deviceId: 'sample',
  });
  const candidates = [result.accountHint, result.balanceIrr?.toString() ?? null].filter(
    (x): x is string => Boolean(x),
  );
  // Compute the matches so the user sees what assigning the identifier
  // would do to existing unassigned transactions.
  const previews: Array<{ hint: string; would_assign: number }> = [];
  for (const hint of candidates) {
    const count = await previewUnassignedForHint(domainDb(c.env.DB), hint);
    previews.push({ hint, would_assign: count });
  }
  return c.json({
    ok: true,
    normalized: normalized.text,
    parser_id: result.parserId,
    parser_version: result.parserVersion,
    classification: result.classification,
    direction: result.direction,
    amount_irr: result.amountIrr,
    balance_irr: result.balanceIrr,
    bank_timestamp: result.evidence?.bankTimestamp ?? null,
    account_hint: result.accountHint,
    card_last_four: result.balanceIrr ? String(result.balanceIrr).slice(-4) : null,
    transaction_reference: result.transactionReference,
    warnings: result.warnings,
    identifiers: previews,
  });
});

const AddIdentifierBody = z
  .object({
    kind: z.enum(['ACCOUNT_HINT', 'CARD_LAST_FOUR', 'ACCOUNT_LAST_FOUR', 'IBAN', 'OTHER']),
    value: z.string().min(1).max(64),
    label: z.string().max(120).nullable().optional(),
    assign_historical: z.boolean().optional(),
  })
  .strict();

/**
 * Add an identifier to an existing account, then optionally trigger a
 * historical backfill that updates only transactions with
 * financial_account_id = NULL. Never overwrites a non-NULL account.
 */
app.post('/api/v1/accounts/:id/identifier', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const parsed = AddIdentifierBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const accountId = c.req.param('id');
  const { kind, value, label, assign_historical } = parsed.data;
  const exists = await c.env.DB.prepare(`SELECT id FROM financial_accounts WHERE id = ?1`)
    .bind(accountId)
    .first();
  if (!exists) return c.json({ ok: false, error: 'not_found' }, 404);
  // Detect ambiguity up-front.
  const probe = await resolveAccountByHint(domainDb(c.env.DB), value);
  if (probe.status === 'ACCOUNT_IDENTIFIER_AMBIGUOUS') {
    return c.json(
      { ok: false, error: 'ACCOUNT_IDENTIFIER_AMBIGUOUS', matches: probe.matches },
      409,
    );
  }
  if (probe.status === 'OK' && probe.accountId !== accountId) {
    return c.json(
      { ok: false, error: 'identifier_owned_by_other_account', owner: probe.accountId },
      409,
    );
  }

  const now = Date.now();
  let preview = 0;
  let updated = 0;
  if (kind === 'ACCOUNT_HINT') {
    preview = await previewUnassignedForHint(domainDb(c.env.DB), value);
    if (assign_historical) {
      // Mirror into the canonical column AND backfill.
      try {
        await c.env.DB.prepare(
          `UPDATE financial_accounts SET account_hint = ?2, updated_at = ?3 WHERE id = ?1`,
        )
          .bind(accountId, value, now)
          .run();
      } catch (e) {
        const msg = String(e);
        if (msg.includes('UNIQUE') || msg.includes('idx_fa_unique_active')) {
          return c.json({ ok: false, error: 'ACCOUNT_IDENTIFIER_AMBIGUOUS' }, 409);
        }
        throw e;
      }
      // Backfill: only NULL financial_account_id rows whose evidence hint matches.
      // JSON predicate without JSON1 is approximated by selecting rows then
      // updating from JS. The LIMIT in previewUnassignedForHint caps the scan.
      const rows = await c.env.DB.prepare(
        `SELECT id, parser_evidence_json FROM transaction_candidates t
            WHERE t.financial_account_id IS NULL
              AND ${SQL.actionableTransactionWhereT}
            ORDER BY t.created_at DESC LIMIT 5000`,
      ).all<{ id: string; parser_evidence_json: string }>();
      const ids: string[] = [];
      for (const r of rows.results) {
        try {
          const ev = JSON.parse(r.parser_evidence_json) as { accountHint?: string };
          if (ev.accountHint === value) ids.push(r.id);
        } catch {
          /* ignore */
        }
      }
      if (ids.length > 0) {
        // Bulk update via batch.
        const stmts = ids.map((id) =>
          c.env.DB.prepare(
            `UPDATE transaction_candidates
                  SET financial_account_id = ?2, updated_at = ?3
                WHERE id = ?1 AND financial_account_id IS NULL`,
          ).bind(id, accountId, now),
        );
        await c.env.DB.batch(stmts);
        updated = ids.length;
        // Rerun matching for newly-assigned txs.
        for (const id of ids) {
          const tx = await c.env.DB.prepare(
            `SELECT id, amount_irr, direction, financial_account_id, transaction_reference, bank_timestamp
                 FROM transaction_candidates WHERE id = ?1`,
          )
            .bind(id)
            .first<{
              id: string;
              amount_irr: number | null;
              direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
              financial_account_id: string | null;
              transaction_reference: string | null;
              bank_timestamp: number | null;
            }>();
          if (tx && tx.amount_irr !== null && tx.bank_timestamp !== null) {
            await suggestMatchesForTransaction(domainDb(c.env.DB), { tx });
          }
        }
      }
    }
  } else if (kind === 'CARD_LAST_FOUR') {
    try {
      await c.env.DB.prepare(
        `UPDATE financial_accounts SET card_last_four = ?2, updated_at = ?3 WHERE id = ?1`,
      )
        .bind(accountId, value, now)
        .run();
    } catch (e) {
      const msg = String(e);
      if (msg.includes('UNIQUE') || msg.includes('idx_fa_unique_active')) {
        return c.json({ ok: false, error: 'ACCOUNT_IDENTIFIER_AMBIGUOUS' }, 409);
      }
      throw e;
    }
  } else if (kind === 'ACCOUNT_LAST_FOUR') {
    try {
      await c.env.DB.prepare(
        `UPDATE financial_accounts SET account_last_four = ?2, updated_at = ?3 WHERE id = ?1`,
      )
        .bind(accountId, value, now)
        .run();
    } catch (e) {
      const msg = String(e);
      if (msg.includes('UNIQUE') || msg.includes('idx_fa_unique_active')) {
        return c.json({ ok: false, error: 'ACCOUNT_IDENTIFIER_AMBIGUOUS' }, 409);
      }
      throw e;
    }
  } else if (kind === 'IBAN') {
    try {
      await c.env.DB.prepare(
        `UPDATE financial_accounts SET iban = ?2, updated_at = ?3 WHERE id = ?1`,
      )
        .bind(accountId, value, now)
        .run();
    } catch (e) {
      const msg = String(e);
      if (msg.includes('UNIQUE') || msg.includes('idx_fa_unique_active')) {
        return c.json({ ok: false, error: 'ACCOUNT_IDENTIFIER_AMBIGUOUS' }, 409);
      }
      throw e;
    }
  } else {
    // OTHER / arbitrary: store in the additional_identifiers table.
    try {
      await c.env.DB.prepare(
        `INSERT INTO financial_account_identifiers
             (id, financial_account_id, kind, value, label, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      )
        .bind(crypto.randomUUID(), accountId, kind, value, label ?? null, now)
        .run();
    } catch (e) {
      const msg = String(e);
      if (msg.includes('UNIQUE')) {
        return c.json({ ok: false, error: 'ACCOUNT_IDENTIFIER_AMBIGUOUS' }, 409);
      }
      throw e;
    }
  }
  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'account.identifier_added',
      'ACCOUNT',
      accountId,
      null,
      JSON.stringify({ kind, value, assign_historical: !!assign_historical, updated }),
      null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();
  return c.json({ ok: true, kind, value, preview, updated });
});

/** Rerun matching on demand — useful after backfills. */
app.post('/api/v1/accounts/rerun-matching', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const result = await rerunMatchingForUnassigned(domainDb(c.env.DB), { limit: 500 });
  return c.json({ ok: true, ...result });
});

// ---------------------------------------------------------------------------
// Per-account "Re-run account assignment" — staged preview/apply/decline.
//
// Hard invariants:
//   * NO mutation of transactions or assignments on preview.
//   * Decline is a single UPDATE on the preview row (no rollback).
//   * Apply routes each selected item through assignAccountForTx, which
//     itself enforces MANUAL/ACCOUNT_MERGE protection + idempotency on
//     identical triples.
//   * Apply writes one audit_logs row (account.assignment_rerun_applied)
//     with no raw SMS bodies.
// ---------------------------------------------------------------------------

app.post('/api/v1/accounts/:accountId/rerun-assignment-preview', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const accountId = c.req.param('accountId');
  if (!accountId) return c.json({ ok: false, error: 'missing_account' }, 400);
  const result = await buildAccountAssignmentPreview(domainDb(c.env.DB), accountId, ident.email);
  if (result.kind === 'no_account') return c.json({ ok: false, error: 'account_not_found' }, 404);
  if (result.kind === 'inactive') return c.json({ ok: false, error: 'account_inactive' }, 409);
  if (result.kind === 'not_operable')
    return c.json({ ok: false, error: 'account_not_operable' }, 409);
  const p = result.preview;
  return c.json({
    ok: true,
    previewId: p.previewId,
    expiresAt: p.expiresAt,
    counts: p.counts,
    items: p.items.map((i) => ({
      id: i.id,
      transactionId: i.transactionCandidateId,
      disposition: i.disposition,
      identifierType: i.identifierType,
      normalizedIdentifier: i.normalizedIdentifier,
      currentAccountId: i.currentAccountId,
      currentAssignmentSource: i.currentAssignmentSource,
      bankTimestamp: i.bankTimestamp,
      amountIrr: i.amountIrr,
      selected: i.selected,
    })),
  });
});

app.post('/api/v1/accounts/:accountId/rerun-assignment/:previewId/apply', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const accountId = c.req.param('accountId');
  const previewId = c.req.param('previewId');
  if (!accountId || !previewId) return c.json({ ok: false, error: 'missing_params' }, 400);

  // Body is optional: { selectedTxIds: string[] }.
  let selectedTxIds: string[] | null = null;
  try {
    const body = (await c.req.json().catch(() => null)) as { selectedTxIds?: string[] } | null;
    if (body && Array.isArray(body.selectedTxIds)) {
      selectedTxIds = body.selectedTxIds.filter((s) => typeof s === 'string');
    }
  } catch {
    // ignore — body is optional
  }

  const result = await applyAccountAssignmentPreview(
    domainDb(c.env.DB),
    accountId,
    previewId,
    ident.email,
    selectedTxIds,
    Date.now(),
    { actorRole: ident.role, requestId: c.req.header('cf-ray') ?? null },
  );

  if (result.kind === 'not_found') return c.json({ ok: false, error: 'preview_not_found' }, 404);
  if (result.kind === 'expired') return c.json({ ok: false, error: 'preview_expired' }, 409);
  if (result.kind === 'wrong_status')
    return c.json({ ok: false, error: 'preview_wrong_status', status: result.status }, 409);
  const r = result.result;
  return c.json({
    ok: true,
    previewId: r.previewId,
    applied: r.applied,
    skipped: r.skipped,
    conflicts: r.conflicts,
    manualPreserved: r.manualPreserved,
    affectedTxIds: r.affectedTxIds,
  });
});

app.post('/api/v1/accounts/:accountId/rerun-assignment/:previewId/decline', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const accountId = c.req.param('accountId');
  const previewId = c.req.param('previewId');
  if (!accountId || !previewId) return c.json({ ok: false, error: 'missing_params' }, 400);

  const result = await declineAccountAssignmentPreview(
    domainDb(c.env.DB),
    accountId,
    previewId,
    ident.email,
  );
  if (result.kind === 'not_found') return c.json({ ok: false, error: 'preview_not_found' }, 404);
  if (result.kind === 'expired') return c.json({ ok: false, error: 'preview_expired' }, 409);
  if (result.kind === 'wrong_status')
    return c.json({ ok: false, error: 'preview_wrong_status', status: result.status }, 409);
  return c.json({ ok: true, previewId });
});

// ---------------------------------------------------------------------------
// Comments (unchanged)
// ---------------------------------------------------------------------------

const CommentGet = z.object({
  type: z.enum(['MATCH', 'TRANSACTION', 'CLAIM']),
  id: z.string(),
});

app.get('/api/v1/comments', async (c) => {
  const parsed = CommentGet.safeParse({
    type: c.req.query('type'),
    id: c.req.query('id'),
  });
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_query' }, 400);
  const rows = await c.env.DB.prepare(
    `SELECT id, body, author_email, created_at FROM comments WHERE entity_type = ?1 AND entity_id = ?2 ORDER BY created_at ASC LIMIT 200`,
  )
    .bind(parsed.data.type, parsed.data.id)
    .all<{
      id: string;
      body: string;
      author_email: string;
      created_at: number;
    }>();
  return c.json({ ok: true, items: rows.results });
});

const CommentPost = z
  .object({
    entityType: z.enum(['MATCH', 'TRANSACTION', 'CLAIM']),
    entityId: z.string(),
    body: z.string().min(1).max(2000),
  })
  .strict();

app.post('/api/v1/comment', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const parsed = CommentPost.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const now = Date.now();
  await c.env.DB.prepare(SQL.insertComment)
    .bind(
      crypto.randomUUID(),
      parsed.data.entityType,
      parsed.data.entityId,
      ident.email,
      ident.role,
      parsed.data.body,
      now,
    )
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Match approve / reject (unchanged semantics)
// ---------------------------------------------------------------------------

const ApproveBody = z
  .object({
    transactionCandidateId: z.string(),
    matchId: z.string(),
    comment: z.string().max(2000).optional(),
  })
  .strict();

app.post('/api/v1/match/approve', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const parsed = ApproveBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const tx = await c.env.DB.prepare(
    `SELECT id, status, direction, processing_disposition FROM transaction_candidates WHERE id = ?1`,
  )
    .bind(parsed.data.transactionCandidateId)
    .first<{
      id: string;
      status: import('@shikoo/contracts').TransactionStatus;
      direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
      processing_disposition: 'ACTIONABLE' | 'OUTGOING_IGNORED' | 'ADMIN_EXCLUDED';
    }>();
  if (!tx) return c.json({ ok: false, error: 'not_found' }, 404);
  // CREDIT-only: a DEBIT-bearing match row must never be approved.
  if (tx.processing_disposition !== 'ACTIONABLE' || tx.direction !== 'CREDIT') {
    return c.json({ ok: false, error: 'outgoing_transaction_not_actionable' }, 409);
  }
  const match = await c.env.DB.prepare(`SELECT * FROM reconciliation_matches WHERE id = ?1`)
    .bind(parsed.data.matchId)
    .first<{
      id: string;
      transaction_candidate_id: string;
      payment_claim_id: string;
      status: import('@shikoo/contracts').MatchStatus;
    }>();
  if (!match || match.transaction_candidate_id !== tx.id) {
    return c.json({ ok: false, error: 'mismatch' }, 400);
  }
  try {
    assertTransitionTransaction(tx.status, 'APPROVED');
    assertTransitionMatch(match.status, 'CONFIRMED');
  } catch {
    return c.json({ ok: false, error: 'illegal_transition' }, 409);
  }
  const claim = await c.env.DB.prepare(
    `SELECT status, source_system FROM payment_claims WHERE id = ?1`,
  )
    .bind(match.payment_claim_id)
    .first<{ status: import('@shikoo/contracts').ClaimStatus; source_system: string }>();
  if (claim) {
    try {
      assertTransitionClaim(claim.status, 'VERIFIED');
    } catch {
      return c.json({ ok: false, error: 'illegal_claim_transition' }, 409);
    }
    // Mirzabot claims have exactly one verification path, so that its
    // amount/account/single-use guards cannot be sidestepped from here.
    if (claim.source_system === MIRZABOT_SOURCE) {
      const verified = await verifyMirzabotClaim(domainDb(c.env.DB), {
        claimId: match.payment_claim_id,
        transactionId: tx.id,
        mode: 'ADMIN_APPROVED',
        actorEmail: ident.email,
      });
      if (!verified.ok) return c.json({ ok: false, error: verified.error.toLowerCase() }, 409);
      return c.json({ ok: true, matchId: verified.matchId, transactionId: verified.transactionId });
    }
  }
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(SQL.updateTransactionStatus).bind(tx.id, 'APPROVED', now),
    c.env.DB.prepare(SQL.updateMatchStatus).bind(match.id, 'CONFIRMED', ident.email, now),
    ...(claim
      ? [c.env.DB.prepare(SQL.updateClaimStatus).bind(match.payment_claim_id, 'VERIFIED', now)]
      : []),
  ]);
  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'match.approved',
      'MATCH',
      match.id,
      JSON.stringify({
        txStatus: tx.status,
        matchStatus: match.status,
        claimStatus: claim?.status ?? null,
      }),
      JSON.stringify({ txStatus: 'APPROVED', matchStatus: 'CONFIRMED', claimStatus: 'VERIFIED' }),
      parsed.data.comment ?? null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();
  if (parsed.data.comment) {
    await c.env.DB.prepare(SQL.insertComment)
      .bind(
        crypto.randomUUID(),
        'MATCH',
        match.id,
        ident.email,
        ident.role,
        parsed.data.comment,
        now,
      )
      .run();
  }
  return c.json({ ok: true });
});

const RejectBody = z
  .object({
    matchId: z.string(),
    reason: z.enum([
      'FAKE_RECEIPT',
      'NO_BANK_TRANSACTION',
      'DUPLICATE',
      'WRONG_AMOUNT',
      'WRONG_ACCOUNT',
      'EXPIRED',
      'REFUNDED',
      'TEST_PAYMENT',
      'OTHER',
    ]),
    comment: z.string().max(2000).optional(),
  })
  .strict();

app.post('/api/v1/match/reject', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const parsed = RejectBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const match = await c.env.DB.prepare(`SELECT * FROM reconciliation_matches WHERE id = ?1`)
    .bind(parsed.data.matchId)
    .first<{
      id: string;
      payment_claim_id: string;
      transaction_candidate_id: string;
      status: import('@shikoo/contracts').MatchStatus;
    }>();
  if (!match) return c.json({ ok: false, error: 'not_found' }, 404);
  try {
    assertTransitionMatch(match.status, 'REJECTED');
  } catch {
    return c.json({ ok: false, error: 'illegal_transition' }, 409);
  }
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(SQL.updateMatchStatus).bind(match.id, 'REJECTED', ident.email, now),
    c.env.DB.prepare(SQL.updateClaimStatus).bind(
      match.payment_claim_id,
      parsed.data.reason === 'FAKE_RECEIPT' ? 'FAKE_RECEIPT' : 'REJECTED',
      now,
    ),
  ]);
  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      parsed.data.reason === 'FAKE_RECEIPT' ? 'claim.fake_receipt' : 'match.rejected',
      'MATCH',
      match.id,
      JSON.stringify({ matchStatus: match.status }),
      JSON.stringify({ matchStatus: 'REJECTED', reason: parsed.data.reason }),
      parsed.data.comment ?? null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Transaction-level account assignment and reviews
// ---------------------------------------------------------------------------

/**
 * Map a detected-identifier type to the matching canonical column on
 * financial_accounts. Used to decide whether assigning a transaction via
 * this identifier should also stamp the canonical column on the account.
 */
const IDENTIFIER_COLUMN: Record<
  'ACCOUNT_NUMBER' | 'CARD_LAST_FOUR' | 'IBAN' | 'ACCOUNT_HINT',
  'account_hint' | 'card_last_four' | 'account_last_four' | 'iban' | null
> = {
  ACCOUNT_NUMBER: 'account_hint',
  CARD_LAST_FOUR: 'card_last_four',
  IBAN: 'iban',
  ACCOUNT_HINT: 'account_hint',
};

const AssignAccountBody = z
  .object({
    accountId: z.string().min(1),
    identifier: z
      .object({
        type: z.enum(['ACCOUNT_NUMBER', 'CARD_LAST_FOUR', 'IBAN', 'ACCOUNT_HINT']),
        normalizedValue: z.string().min(1).max(128),
        maskedValue: z.string().max(128).optional(),
      })
      .optional(),
    saveIdentifierToAccount: z.boolean().optional(),
    backfillHistorical: z.boolean().optional(),
  })
  .strict();

/**
 * POST /api/v1/transactions/:transactionId/assign-account
 *
 * Single transaction assignment, plus optional identifier save and
 * historical backfill. Never overwrites a non-NULL account silently.
 *
 * Flow:
 *   1. Verify tx + account exist, account is active.
 *   2. If saveIdentifierToAccount: probe for an existing active account
 *      that already owns this identifier. If owned by a different active
 *      account → 409 `identifier_conflict` with that account's id +
 *      display_name so the UI can show the conflict.
 *   3. Stamp the identifier onto the target account (UPDATE canonical
 *      column first when available, INSERT into financial_account_identifiers
 *      otherwise). On UNIQUE collision → 409 `identifier_conflict`.
 *   4. Assign the selected tx via the shared `assignAccountForTx` helper
 *      with source='MANUAL' — this writes the history row + supersedes
 *      any prior active row, idempotent on identical triples.
 *   5. If backfillHistorical: invoke `backfillAssignmentsForIdentifier`,
 *      which iterates ONLY rows with `financial_account_id IS NULL` and
 *      writes HISTORICAL_BACKFILL rows. Each row is wrapped in try/catch
 *      so one bad row doesn't break the batch.
 *   6. Rerun matching for the affected transactions.
 *   7. Audit with a single 'transaction.account_assigned' row.
 */
app.post('/api/v1/transactions/:transactionId/assign-account', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const parsed = AssignAccountBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const txId = c.req.param('transactionId');
  const body = parsed.data;

  // 1. Verify the tx.
  const tx = await c.env.DB.prepare(
    `SELECT id, financial_account_id, amount_irr, direction, bank_timestamp, status, processing_disposition
       FROM transaction_candidates WHERE id = ?1`,
  )
    .bind(txId)
    .first<{
      id: string;
      financial_account_id: string | null;
      amount_irr: number | null;
      direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
      bank_timestamp: number | null;
      status: string;
      processing_disposition: 'ACTIONABLE' | 'OUTGOING_IGNORED' | 'ADMIN_EXCLUDED';
    }>();
  if (!tx) return c.json({ ok: false, error: 'transaction_not_found' }, 404);

  // 1a. CREDIT-only guard: a DEBIT or non-actionable row must never be
  //     assigned. Direct user request → 409.
  if (tx.processing_disposition !== 'ACTIONABLE' || tx.direction !== 'CREDIT') {
    return c.json({ ok: false, error: 'outgoing_transaction_not_actionable' }, 409);
  }

  // 1a. Idempotent same-account: if already assigned to this account, treat
  //     the request as a no-op success and still (re)run identifier/backfill
  //     if requested. Matches the spec's "no duplicate INSERT for
  //     same-target-account".
  const alreadySameAccount = tx.financial_account_id === body.accountId;

  // 1b. Guard against silently overwriting a different active account.
  if (tx.financial_account_id && tx.financial_account_id !== body.accountId) {
    return c.json(
      {
        ok: false,
        error: 'already_assigned_to_other_account',
        currentAccountId: tx.financial_account_id,
      },
      409,
    );
  }

  // 2. Verify the account.
  const account = await c.env.DB.prepare(
    `SELECT id, active, display_name FROM financial_accounts WHERE id = ?1`,
  )
    .bind(body.accountId)
    .first<{ id: string; active: number; display_name: string }>();
  if (!account) return c.json({ ok: false, error: 'account_not_found' }, 404);
  if (!account.active) return c.json({ ok: false, error: 'account_inactive' }, 409);

  const now = Date.now();

  // 3. If saveIdentifierToAccount: probe for an existing owner first so
  //    we can return a structured 409 with the conflicting account's
  //    id + display_name. Never expose raw SQL or stack traces.
  let identifierSaved = false;
  if (body.saveIdentifierToAccount && body.identifier) {
    const idType = body.identifier.type;
    const normalizedValue = body.identifier.normalizedValue;

    // Probe canonical columns first.
    const COLUMN_FOR_TYPE: Record<string, string | null> = {
      ACCOUNT_NUMBER: 'account_hint',
      CARD_LAST_FOUR: 'card_last_four',
      IBAN: 'iban',
      ACCOUNT_HINT: 'account_hint',
    };
    const columnToProbe = COLUMN_FOR_TYPE[idType];

    let owner: { id: string; display_name: string } | null = null;
    if (columnToProbe) {
      const row = await c.env.DB.prepare(
        `SELECT id, display_name FROM financial_accounts
            WHERE id != ?1 AND active = 1 AND ${columnToProbe} = ?2
            LIMIT 1`,
      )
        .bind(body.accountId, normalizedValue)
        .first<{ id: string; display_name: string }>();
      owner = row ?? null;
    }
    // If the canonical column didn't find an owner, check the identifiers table.
    if (!owner) {
      const row = await c.env.DB.prepare(
        `SELECT fa.id AS id, fa.display_name AS display_name
             FROM financial_account_identifiers fai
             JOIN financial_accounts fa ON fa.id = fai.financial_account_id
            WHERE fai.kind = ?1
              AND fai.value = ?2
              AND fa.id != ?3
              AND fa.active = 1
            LIMIT 1`,
      )
        .bind(idType, normalizedValue, body.accountId)
        .first<{ id: string; display_name: string }>();
      owner = row ?? null;
    }
    if (owner) {
      return c.json(
        {
          ok: false,
          error: 'identifier_conflict',
          conflict: 'owned_by_other_account',
          existingAccountId: owner.id,
          existingAccountDisplayName: owner.display_name,
        },
        409,
      );
    }

    // 3a. Stamp the identifier — UPDATE canonical column when the type
    //     maps to one, INSERT into financial_account_identifiers otherwise.
    //     Both paths share a single D1 batch.
    const stmts: D1PreparedStatement[] = [];
    const targetColumn = IDENTIFIER_COLUMN[idType];
    if (targetColumn) {
      stmts.push(
        c.env.DB.prepare(
          `UPDATE financial_accounts SET ${targetColumn} = ?2, updated_at = ?3 WHERE id = ?1`,
        ).bind(body.accountId, normalizedValue, now),
      );
    } else {
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO financial_account_identifiers
             (id, financial_account_id, kind, value, label, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        ).bind(crypto.randomUUID(), body.accountId, idType, normalizedValue, null, now),
      );
    }
    try {
      await c.env.DB.batch(stmts);
      identifierSaved = true;
    } catch (e) {
      const msg = String(e);
      // UNIQUE on financial_account_identifiers(kind, value) — the row was
      // inserted in a parallel request. Re-probe and return the conflict.
      if (msg.includes('UNIQUE') || msg.includes('idx_fa_unique_active')) {
        const owner2 = await c.env.DB.prepare(
          `SELECT fa.id AS id, fa.display_name AS display_name
               FROM financial_account_identifiers fai
               JOIN financial_accounts fa ON fa.id = fai.financial_account_id
              WHERE fai.kind = ?1
                AND fai.value = ?2
                AND fa.id != ?3
                AND fa.active = 1
              LIMIT 1`,
        )
          .bind(idType, normalizedValue, body.accountId)
          .first<{ id: string; display_name: string }>();
        if (owner2) {
          return c.json(
            {
              ok: false,
              error: 'identifier_conflict',
              conflict: 'owned_by_other_account',
              existingAccountId: owner2.id,
              existingAccountDisplayName: owner2.display_name,
            },
            409,
          );
        }
        return c.json(
          {
            ok: false,
            error: 'account_identifier_ambiguous',
            conflict: 'ambiguous_resolution',
          },
          409,
        );
      }
      // Non-UNIQUE error — fail loudly but never expose raw SQL/stack.
      console.error('assign-account: identifier save failed', msg);
      return c.json({ ok: false, error: 'identifier_save_failed' }, 500);
    }
  }

  // 4. Assign the main tx via the shared history writer.
  //    Idempotent on identical triples; AUTO can never overwrite MANUAL
  //    (we're calling with MANUAL here, so no preservation check needed).
  const mainResult = await assignAccountForTx(
    domainDb(c.env.DB),
    {
      transactionCandidateId: txId,
      financialAccountId: body.accountId,
      source: 'MANUAL',
      identifierType: body.identifier?.type ?? null,
      normalizedIdentifier: body.identifier?.normalizedValue ?? null,
      assignedBy: ident.email,
      metadata: { reason: 'manual_assign' },
    },
    now,
  );

  // Skip the already-assigned-to-same-account path so the response is
  // idempotent and the open Modal stays silent.
  void alreadySameAccount;
  void mainResult;

  // 5. Backfill historical (unassigned txs matching the identifier).
  let backfilled = 0;
  if (body.backfillHistorical && body.identifier) {
    const bfResult = await backfillAssignmentsForIdentifier(
      domainDb(c.env.DB),
      body.identifier.type,
      body.identifier.normalizedValue,
      body.accountId,
      ident.email,
      now,
    );
    backfilled = bfResult.assigned;
  }

  // 6. Rerun matching for the affected transactions. Per-row try/catch so
  //    a single bad row doesn't 500 the whole batch.
  const txIdsToRematch = new Set<string>([txId]);
  if (body.backfillHistorical && body.identifier) {
    const targets = await listUnassignedForIdentifier(
      domainDb(c.env.DB),
      body.identifier.type,
      body.identifier.normalizedValue,
      5000,
    );
    for (const t of targets) txIdsToRematch.add(t.txId);
  }
  for (const id of txIdsToRematch) {
    try {
      const ttx = await c.env.DB.prepare(
        `SELECT id, amount_irr, direction, financial_account_id, transaction_reference, bank_timestamp
             FROM transaction_candidates WHERE id = ?1`,
      )
        .bind(id)
        .first<{
          id: string;
          amount_irr: number | null;
          direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
          financial_account_id: string | null;
          transaction_reference: string | null;
          bank_timestamp: number | null;
        }>();
      if (ttx && ttx.amount_irr !== null && ttx.bank_timestamp !== null) {
        await suggestMatchesForTransaction(domainDb(c.env.DB), { tx: ttx });
      }
    } catch (e) {
      console.error('assign-account: rematch failed', id, String(e));
      // continue — partial rematch is better than a 500
    }
  }

  // 7. Audit. Single row summarises the operation; per-row assignment
  //    history is already in transaction_account_assignments.
  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'transaction.account_assigned',
      'TRANSACTION',
      txId,
      JSON.stringify({ previousAccountId: tx.financial_account_id }),
      JSON.stringify({
        accountId: body.accountId,
        identifier: body.identifier ?? null,
        identifierSaved,
        backfilled,
      }),
      null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();

  return c.json({
    ok: true,
    txId,
    accountId: body.accountId,
    identifierSaved,
    backfilled,
  });
});

const ReviewBody = z.object({
  reason: z
    .enum(['false_parse', 'duplicate', 'irrelevant', 'wrong_amount', 'other'])
    .nullable()
    .optional(),
  comment: z.string().max(2000).optional(),
});

const REJECT_REASONS = new Set(['false_parse', 'duplicate', 'irrelevant', 'wrong_amount', 'other']);

/**
 * POST /api/v1/transactions/:transactionId/accept
 *
 * Accept a transaction as a valid bank record. Requires an assigned
 * financial account (otherwise the dashboard can't report which books the
 * amount belongs to). Distinct from "approve match": this does NOT create
 * a reconciliation_match row, does NOT touch any payment_claim status.
 *
 * The accept decision lives in transaction_reviews; the tx.status stays
 * in its current value (PARSED/NEEDS_REVIEW/MATCH_SUGGESTED). The Unmatched
 * endpoint filters by the absence of a review row so accepted transactions
 * vanish from "active" and surface via the Reviewed endpoint.
 */
app.post('/api/v1/transactions/:transactionId/accept', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const txId = c.req.param('transactionId');
  const tx = await c.env.DB.prepare(
    `SELECT id, financial_account_id FROM transaction_candidates WHERE id = ?1`,
  )
    .bind(txId)
    .first<{ id: string; financial_account_id: string | null }>();
  if (!tx) return c.json({ ok: false, error: 'transaction_not_found' }, 404);
  if (!tx.financial_account_id) {
    return c.json(
      {
        ok: false,
        error: 'account_required',
        detail: 'Assign an account before accepting this transaction.',
      },
      409,
    );
  }
  const now = Date.now();
  await c.env.DB.prepare(SQL.upsertTransactionReview)
    .bind(crypto.randomUUID(), txId, 'ACCEPTED', ident.email, ident.role, null, null, now, now)
    .run();
  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'transaction.accepted',
      'TRANSACTION',
      txId,
      null,
      JSON.stringify({ accountId: tx.financial_account_id }),
      null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();
  return c.json({ ok: true, decision: 'ACCEPTED' });
});

/**
 * POST /api/v1/transactions/:transactionId/reject
 *
 * Reject an unmatched transaction — invalid parse, irrelevant SMS,
 * duplicate, etc. Records a transaction_reviews row and transitions the
 * transaction to IGNORED so the matcher service never picks it up again.
 */
app.post('/api/v1/transactions/:transactionId/reject', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const parsed = ReviewBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const reason = parsed.data.reason ?? null;
  if (reason && !REJECT_REASONS.has(reason)) {
    return c.json({ ok: false, error: 'invalid_reason' }, 400);
  }
  const txId = c.req.param('transactionId');
  const tx = await c.env.DB.prepare(`SELECT id, status FROM transaction_candidates WHERE id = ?1`)
    .bind(txId)
    .first<{ id: string; status: string }>();
  if (!tx) return c.json({ ok: false, error: 'transaction_not_found' }, 404);
  const now = Date.now();
  await c.env.DB.batch([
    c.env.DB.prepare(SQL.upsertTransactionReview).bind(
      crypto.randomUUID(),
      txId,
      'REJECTED',
      ident.email,
      ident.role,
      reason,
      parsed.data.comment ?? null,
      now,
      now,
    ),
    c.env.DB.prepare(SQL.updateTransactionStatus).bind(txId, 'IGNORED', now),
    // Delete any suggested-but-not-confirmed matches so a manual reject
    // is durable. CONFIRMED rows stay — that path requires an explicit
    // match.reject call.
    c.env.DB.prepare(
      `DELETE FROM reconciliation_matches
        WHERE transaction_candidate_id = ?1 AND status IN ('SUGGESTED','AUTO_VERIFIED')`,
    ).bind(txId),
  ]);
  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'transaction.rejected',
      'TRANSACTION',
      txId,
      JSON.stringify({ previousStatus: tx.status }),
      JSON.stringify({ decision: 'REJECTED', reason, comment: parsed.data.comment ?? null }),
      reason,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();
  return c.json({ ok: true, decision: 'REJECTED' });
});

// ---------------------------------------------------------------------------
// Account backfill endpoints — preview + apply
// ---------------------------------------------------------------------------

const BackfillPreviewBody = z
  .object({
    identifierType: z.enum(['ACCOUNT_NUMBER', 'CARD_LAST_FOUR', 'IBAN', 'ACCOUNT_HINT']),
    normalizedValue: z.string().min(1).max(128),
  })
  .strict();

/**
 * POST /api/v1/accounts/:accountId/backfill-preview
 *
 * Count how many currently-unassigned transactions have a detected
 * identifier that matches the given (type, normalizedValue). Returns the
 * transaction ids so the UI can show which rows will move.
 */
app.post('/api/v1/accounts/:accountId/backfill-preview', async (c) => {
  const parsed = BackfillPreviewBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const accountId = c.req.param('accountId');
  const account = await c.env.DB.prepare(`SELECT id FROM financial_accounts WHERE id = ?1`)
    .bind(accountId)
    .first();
  if (!account) return c.json({ ok: false, error: 'not_found' }, 404);
  const targets = await listUnassignedForIdentifier(
    domainDb(c.env.DB),
    parsed.data.identifierType,
    parsed.data.normalizedValue,
    5000,
  );
  return c.json({
    ok: true,
    matchingUnassignedCount: targets.length,
    transactionIds: targets.map((t) => t.txId),
  });
});

/**
 * POST /api/v1/accounts/:accountId/backfill
 *
 * Update only transactions where financial_account_id IS NULL. Rerun
 * matching for the affected rows.
 */
app.post('/api/v1/accounts/:accountId/backfill', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const parsed = BackfillPreviewBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const accountId = c.req.param('accountId');
  const account = await c.env.DB.prepare(`SELECT id, active FROM financial_accounts WHERE id = ?1`)
    .bind(accountId)
    .first<{ id: string; active: number }>();
  if (!account) return c.json({ ok: false, error: 'not_found' }, 404);
  if (!account.active) return c.json({ ok: false, error: 'account_inactive' }, 409);
  const targets = await listUnassignedForIdentifier(
    domainDb(c.env.DB),
    parsed.data.identifierType,
    parsed.data.normalizedValue,
    5000,
  );
  const now = Date.now();
  let changed = 0;
  if (targets.length > 0) {
    const stmts = targets.map((t) =>
      c.env.DB.prepare(
        `UPDATE transaction_candidates
            SET financial_account_id = ?2, updated_at = ?3
          WHERE id = ?1 AND financial_account_id IS NULL`,
      ).bind(t.txId, accountId, now),
    );
    const results = await c.env.DB.batch(stmts);
    changed = results.reduce((acc, r) => acc + (r.meta?.changes ?? 0), 0);
    // Rerun matching for the changed transactions only.
    for (const t of targets) {
      const ttx = await c.env.DB.prepare(
        `SELECT id, amount_irr, direction, financial_account_id, transaction_reference, bank_timestamp
           FROM transaction_candidates WHERE id = ?1`,
      )
        .bind(t.txId)
        .first<{
          id: string;
          amount_irr: number | null;
          direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
          financial_account_id: string | null;
          transaction_reference: string | null;
          bank_timestamp: number | null;
        }>();
      if (ttx && ttx.amount_irr !== null && ttx.bank_timestamp !== null) {
        await suggestMatchesForTransaction(domainDb(c.env.DB), { tx: ttx });
      }
    }
  }
  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'account.backfill',
      'ACCOUNT',
      accountId,
      null,
      JSON.stringify({
        identifierType: parsed.data.identifierType,
        normalizedValue: parsed.data.normalizedValue,
        changed,
      }),
      null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();
  return c.json({ ok: true, changed });
});

// ---------------------------------------------------------------------------
// Create-account-and-assign — atomic when possible
// ---------------------------------------------------------------------------

const CreateAccountFromTransactionBody = z
  .object({
    bank_name: z.string().min(1).max(120),
    display_name: z.string().min(1).max(200),
    owner_label: z.string().max(200).nullable().optional(),
    account_type: z.enum(['CARD', 'ACCOUNT', 'IBAN', 'OTHER']),
    identifier: z
      .object({
        type: z.enum(['ACCOUNT_NUMBER', 'CARD_LAST_FOUR', 'IBAN', 'ACCOUNT_HINT']),
        normalizedValue: z.string().min(1).max(128),
        maskedValue: z.string().max(128).optional(),
      })
      .optional(),
    backfillHistorical: z.boolean().optional(),
  })
  .strict();

/**
 * POST /api/v1/transactions/:transactionId/create-account
 *
 * Creates a new financial_accounts row (plus optional identifier), then
 * assigns the calling transaction and runs the historical backfill. The
 * account create + assign pair always lands together — if the backfill is
 * skipped on error, the account is still created and the current tx is
 * still assigned.
 */
app.post('/api/v1/transactions/:transactionId/create-account', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const parsed = CreateAccountFromTransactionBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const txId = c.req.param('transactionId');
  const tx = await c.env.DB.prepare(
    `SELECT id, financial_account_id FROM transaction_candidates WHERE id = ?1`,
  )
    .bind(txId)
    .first<{ id: string; financial_account_id: string | null }>();
  if (!tx) return c.json({ ok: false, error: 'transaction_not_found' }, 404);

  const body = parsed.data;
  const accountId = `account-${crypto.randomUUID()}`;
  const now = Date.now();

  try {
    await c.env.DB.prepare(
      `INSERT INTO financial_accounts
         (id, bank_name, display_name, owner_label, account_type,
          account_hint, card_last_four, account_last_four, iban, device_id,
          active, parser_configuration, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, 1, '{}', ?10, ?10)`,
    )
      .bind(
        accountId,
        body.bank_name,
        body.display_name,
        body.owner_label ?? null,
        body.account_type,
        null,
        null,
        null,
        null,
        now,
      )
      .run();
  } catch (e) {
    const msg = String(e);
    if (msg.includes('UNIQUE')) {
      return c.json({ ok: false, error: 'ACCOUNT_IDENTIFIER_AMBIGUOUS' }, 409);
    }
    throw e;
  }

  // Stamp the canonical column when applicable, otherwise store in the
  // additional_identifiers table.
  if (body.identifier) {
    const column = IDENTIFIER_COLUMN[body.identifier.type];
    const norm = body.identifier.normalizedValue;
    try {
      if (column) {
        await c.env.DB.prepare(
          `UPDATE financial_accounts SET ${column} = ?2, updated_at = ?3 WHERE id = ?1`,
        )
          .bind(accountId, norm, now)
          .run();
      } else {
        await c.env.DB.prepare(
          `INSERT INTO financial_account_identifiers
             (id, financial_account_id, kind, value, label, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
          .bind(crypto.randomUUID(), accountId, body.identifier.type, norm, null, now)
          .run();
      }
    } catch (e) {
      // The account exists but the identifier save failed — surface 409
      // so the UI can show the partial success and roll back the account.
      await c.env.DB.prepare(`DELETE FROM financial_accounts WHERE id = ?1`).bind(accountId).run();
      const msg = String(e);
      if (msg.includes('UNIQUE')) {
        return c.json({ ok: false, error: 'ACCOUNT_IDENTIFIER_AMBIGUOUS' }, 409);
      }
      throw e;
    }
  }

  // Assign the source transaction.
  await c.env.DB.prepare(
    `UPDATE transaction_candidates
        SET financial_account_id = ?2, updated_at = ?3
      WHERE id = ?1 AND financial_account_id IS NULL`,
  )
    .bind(txId, accountId, now)
    .run();

  let backfilled = 0;
  if (body.backfillHistorical && body.identifier) {
    const targets = await listUnassignedForIdentifier(
      domainDb(c.env.DB),
      body.identifier.type,
      body.identifier.normalizedValue,
      5000,
    );
    if (targets.length > 0) {
      const stmts = targets.map((t) =>
        c.env.DB.prepare(
          `UPDATE transaction_candidates
              SET financial_account_id = ?2, updated_at = ?3
            WHERE id = ?1 AND financial_account_id IS NULL`,
        ).bind(t.txId, accountId, now),
      );
      await c.env.DB.batch(stmts);
      backfilled = targets.length;
    }
  }

  // Rerun matching for the source tx (and the backfilled rows).
  const sourceTx = await c.env.DB.prepare(
    `SELECT id, amount_irr, direction, financial_account_id, transaction_reference, bank_timestamp
       FROM transaction_candidates WHERE id = ?1`,
  )
    .bind(txId)
    .first<{
      id: string;
      amount_irr: number | null;
      direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
      financial_account_id: string | null;
      transaction_reference: string | null;
      bank_timestamp: number | null;
    }>();
  if (sourceTx && sourceTx.amount_irr !== null && sourceTx.bank_timestamp !== null) {
    await suggestMatchesForTransaction(domainDb(c.env.DB), { tx: sourceTx });
  }

  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'transaction.account_created_and_assigned',
      'TRANSACTION',
      txId,
      JSON.stringify({ financial_account_id: tx.financial_account_id }),
      JSON.stringify({
        accountId,
        displayName: body.display_name,
        bankName: body.bank_name,
        identifier: body.identifier ?? null,
        backfilled,
      }),
      null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();

  return c.json({ ok: true, accountId, backfilled });
});

/**
 * GET /api/v1/transactions/:transactionId/review — fetch the existing
 * review row for the UI (allows the dashboard to render Reviewed → Accepted
 * / Rejected details without another round-trip).
 */
app.get('/api/v1/transactions/:transactionId/review', async (c) => {
  const txId = c.req.param('transactionId');
  const row = await c.env.DB.prepare(SQL.getTransactionReview).bind(txId).first<{
    id: string;
    decision: 'ACCEPTED' | 'REJECTED';
    reviewed_by: string;
    reviewer_role: string;
    reason: string | null;
    comment: string | null;
    reviewed_at: number;
    created_at: number;
    updated_at: number;
  }>();
  if (!row) return c.json({ ok: true, review: null });
  return c.json({ ok: true, review: row });
});

// ---------------------------------------------------------------------------
// Notification bell + assignment history
// ---------------------------------------------------------------------------
import {
  assignAccountForTx,
  backfillAssignmentsForIdentifier,
  getActiveAssignment,
  setNotificationState,
  getNotificationState,
  getNotificationCounts,
  getPaymentEventUnreadCounts,
  getBellUnreadCounts,
  markPaymentEventsReadAll,
  listAssignmentHistory,
} from '@shikoo/domain';

const ChangeAccountBody = z
  .object({
    accountId: z.string().min(1).nullable(),
    reason: z.string().max(500).optional(),
  })
  .strict();

/**
 * POST /api/v1/transactions/:id/change-account
 *
 * MANUAL assignment. Always succeeds (modulo non-existent accounts) and
 * supersedes any prior active assignment. The previous row is marked
 * inactive and `replaced_assignment_id` points at the new one; the prior
 * `assigned_by` is preserved in the audit log.
 *
 * `accountId: null` clears the assignment — the tx returns to NEEDS_REVIEW
 * matching against ALL accounts.
 */
app.post('/api/v1/transactions/:id/change-account', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const parsed = ChangeAccountBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const txId = c.req.param('id');
  const body = parsed.data;

  const tx = await c.env.DB.prepare(
    `SELECT id, direction, processing_disposition FROM transaction_candidates WHERE id = ?1`,
  )
    .bind(txId)
    .first<{
      id: string;
      direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
      processing_disposition: 'ACTIONABLE' | 'OUTGOING_IGNORED' | 'ADMIN_EXCLUDED';
    }>();
  if (!tx) return c.json({ ok: false, error: 'transaction_not_found' }, 404);

  // CREDIT-only guard: changing account on a DEBIT or non-actionable row
  // is never allowed. Direct user request → 409.
  if (tx.processing_disposition !== 'ACTIONABLE' || tx.direction !== 'CREDIT') {
    return c.json({ ok: false, error: 'outgoing_transaction_not_actionable' }, 409);
  }

  if (body.accountId) {
    const account = await c.env.DB.prepare(
      `SELECT id, active FROM financial_accounts WHERE id = ?1`,
    )
      .bind(body.accountId)
      .first<{ id: string; active: number }>();
    if (!account) return c.json({ ok: false, error: 'account_not_found' }, 404);
    if (!account.active) return c.json({ ok: false, error: 'account_inactive' }, 409);
  }

  const previous = await getActiveAssignment(domainDb(c.env.DB), txId);
  const result = await assignAccountForTx(
    domainDb(c.env.DB),
    {
      transactionCandidateId: txId,
      financialAccountId: body.accountId,
      source: 'MANUAL',
      assignedBy: ident.email,
      metadata: { reason: body.reason ?? null },
    },
    Date.now(),
  );

  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'transaction.account_changed',
      'TRANSACTION',
      txId,
      JSON.stringify({
        previousAccountId: previous?.financial_account_id ?? null,
        previousAssignmentId: previous?.id ?? null,
      }),
      JSON.stringify({
        newAccountId: body.accountId,
        newAssignmentId: result.assignmentId,
        reason: body.reason ?? null,
      }),
      null,
      c.req.header('cf-ray') ?? null,
      Date.now(),
    )
    .run();

  // Rerun matching against the new account id so the bell re-counts.
  if (tx && body.accountId) {
    const txRow = await c.env.DB.prepare(
      `SELECT id, amount_irr, direction, financial_account_id, transaction_reference, bank_timestamp
         FROM transaction_candidates WHERE id = ?1`,
    )
      .bind(txId)
      .first<{
        id: string;
        amount_irr: number | null;
        direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
        financial_account_id: string | null;
        transaction_reference: string | null;
        bank_timestamp: number | null;
      }>();
    if (txRow && txRow.amount_irr !== null && txRow.bank_timestamp !== null) {
      await suggestMatchesForTransaction(domainDb(c.env.DB), { tx: txRow });
    }
  }

  return c.json({
    ok: true,
    txId,
    status: result.status,
    accountId: result.accountId,
    assignmentId: result.assignmentId,
  });
});

/**
 * GET /api/v1/transactions/:id/assignment-history
 */
app.get('/api/v1/transactions/:id/assignment-history', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const txId = c.req.param('id');
  const rows = await listAssignmentHistory(domainDb(c.env.DB), txId, 100);
  return c.json({
    ok: true,
    items: rows.map((r) => ({
      id: r.id,
      accountId: r.financial_account_id,
      source: r.assignment_source,
      identifierType: r.identifier_type,
      normalizedIdentifier: r.normalized_identifier,
      assignedBy: r.assigned_by,
      assignedAt: r.assigned_at,
      replacedAssignmentId: r.replaced_assignment_id,
      active: r.active === 1,
    })),
  });
});

/**
 * GET /api/v1/accounts/:id/references
 *
 * Per-account drill-down: which transactions / claims / identifiers / historical
 * assignments reference this account. Used by the ReferencesModal before
 * merge / move.
 */
app.get('/api/v1/accounts/:id/references', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const id = c.req.param('id');
  const account = await c.env.DB.prepare(
    `SELECT id, display_name, bank_name, active FROM financial_accounts WHERE id = ?1`,
  )
    .bind(id)
    .first<{ id: string; display_name: string; bank_name: string; active: number }>();
  if (!account) return c.json({ ok: false, error: 'not_found' }, 404);

  const refs = await countAccountReferences(c.env.DB, id);

  // Pull a small preview of recent transactions + claims.
  const transactions = await c.env.DB.prepare(
    `SELECT id, direction, amount_irr, balance_irr, bank_timestamp, status
       FROM transaction_candidates t
      WHERE t.financial_account_id = ?1
        AND ${SQL.actionableTransactionWhereT}
      ORDER BY t.bank_timestamp DESC
      LIMIT 50`,
  )
    .bind(id)
    .all<{
      id: string;
      direction: string;
      amount_irr: number | null;
      balance_irr: number | null;
      bank_timestamp: number | null;
      status: string;
    }>();
  const claims = await c.env.DB.prepare(
    `SELECT id, external_order_id, expected_amount_irr, submitted_at, status
       FROM payment_claims
      WHERE target_financial_account_id = ?1
      ORDER BY submitted_at DESC
      LIMIT 50`,
  )
    .bind(id)
    .all<{
      id: string;
      external_order_id: string;
      expected_amount_irr: number;
      submitted_at: number;
      status: string;
    }>();

  return c.json({
    ok: true,
    account: {
      id: account.id,
      displayName: account.display_name,
      bank: account.bank_name,
      active: account.active === 1,
    },
    references: {
      totals: refs,
      transactions: transactions.results,
      paymentClaims: claims.results,
    },
  });
});

/**
 * POST /api/v1/payment-claims/:id/change-account
 *
 * Like change-account for transactions, but for payment claims. The
 * matching engine is NOT re-run here — the next scan picks the move up.
 */
app.post('/api/v1/payment-claims/:id/change-account', async (c) => {
  const ident = c.get('identity');
  if (ident.role === 'READ_ONLY') return c.json({ ok: false, error: 'forbidden' }, 403);
  const parsed = ChangeAccountBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const claimId = c.req.param('id');
  const body = parsed.data;

  const claim = await c.env.DB.prepare(
    `SELECT id, target_financial_account_id FROM payment_claims WHERE id = ?1`,
  )
    .bind(claimId)
    .first<{ id: string; target_financial_account_id: string | null }>();
  if (!claim) return c.json({ ok: false, error: 'claim_not_found' }, 404);

  if (body.accountId) {
    const account = await c.env.DB.prepare(
      `SELECT id, active FROM financial_accounts WHERE id = ?1`,
    )
      .bind(body.accountId)
      .first<{ id: string; active: number }>();
    if (!account) return c.json({ ok: false, error: 'account_not_found' }, 404);
    if (!account.active) return c.json({ ok: false, error: 'account_inactive' }, 409);
  }
  const now = Date.now();
  await c.env.DB.prepare(
    `UPDATE payment_claims SET target_financial_account_id = ?2, updated_at = ?3 WHERE id = ?1`,
  )
    .bind(claimId, body.accountId, now)
    .run();

  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'payment_claim.account_changed',
      'CLAIM',
      claimId,
      JSON.stringify({ previousAccountId: claim.target_financial_account_id }),
      JSON.stringify({ newAccountId: body.accountId, reason: body.reason ?? null }),
      null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();

  return c.json({ ok: true, claimId, accountId: body.accountId });
});

const MoveReferencesBody = z
  .object({
    targetAccountId: z.string().min(1),
    options: z
      .object({
        reassignTransactions: z.boolean().default(true),
        reassignClaims: z.boolean().default(true),
        moveIdentifiers: z.boolean().default(true),
        deleteSource: z.boolean().default(false),
      })
      .default({}),
    reason: z.string().max(500).optional(),
  })
  .strict();

/**
 * POST /api/v1/accounts/:id/move-references-preview
 *
 * Returns counts of what would move under each option. Does NOT mutate.
 */
app.post('/api/v1/accounts/:id/move-references-preview', async (c) => {
  const ident = c.get('identity');
  if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
  const sourceId = c.req.param('id');
  const parsed = MoveReferencesBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const targetId = parsed.data.targetAccountId;
  if (sourceId === targetId) {
    return c.json({ ok: false, error: 'same_account' }, 400);
  }
  const target = await c.env.DB.prepare(`SELECT id, active FROM financial_accounts WHERE id = ?1`)
    .bind(targetId)
    .first<{ id: string; active: number }>();
  if (!target) return c.json({ ok: false, error: 'target_not_found' }, 404);
  if (!target.active) return c.json({ ok: false, error: 'target_inactive' }, 409);

  const refs = await countAccountReferences(c.env.DB, sourceId);
  const identifiers = await c.env.DB.prepare(
    `SELECT id, kind, value, label FROM financial_account_identifiers WHERE financial_account_id = ?1`,
  )
    .bind(sourceId)
    .all<{ id: string; kind: string; value: string; label: string | null }>();

  return c.json({
    ok: true,
    sourceId,
    targetId,
    counts: {
      transactions: refs.transactions,
      paymentClaims: refs.paymentClaims,
      identifiers: identifiers.results.length,
    },
    identifiers: identifiers.results,
  });
});

/**
 * POST /api/v1/accounts/:id/move-references
 *
 * Atomic move: ALL transaction_account_assignments on this account get
 * re-pointed to the target (with `assignment_source='ACCOUNT_MERGE'`),
 * transaction_candidates + payment_claims are updated, financial_account_identifiers
 * are moved, and optionally the source is deleted.
 *
 * On any failure the batch is rolled back (D1 `batch` is atomic). The
 * caller can re-run with `deleteSource: false` if they want to keep the
 * (now-empty) source.
 */
app.post('/api/v1/accounts/:id/move-references', async (c) => {
  const ident = c.get('identity');
  if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
  const sourceId = c.req.param('id');
  const parsed = MoveReferencesBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const { targetAccountId, options, reason } = parsed.data;
  if (sourceId === targetAccountId) {
    return c.json({ ok: false, error: 'same_account' }, 400);
  }
  const target = await c.env.DB.prepare(`SELECT id, active FROM financial_accounts WHERE id = ?1`)
    .bind(targetAccountId)
    .first<{ id: string; active: number }>();
  if (!target) return c.json({ ok: false, error: 'target_not_found' }, 404);
  if (!target.active) return c.json({ ok: false, error: 'target_inactive' }, 409);

  const source = await c.env.DB.prepare(
    `SELECT id, display_name, bank_name, active FROM financial_accounts WHERE id = ?1`,
  )
    .bind(sourceId)
    .first<{ id: string; display_name: string; bank_name: string; active: number }>();
  if (!source) return c.json({ ok: false, error: 'source_not_found' }, 404);

  const now = Date.now();
  const stmts = [];

  // 1. Move transactions: rewrite historical assignment rows to the target
  //    with `ACCOUNT_MERGE` source, then update `transaction_candidates`.
  if (options.reassignTransactions) {
    const txRows = await c.env.DB.prepare(
      `SELECT id FROM transaction_candidates WHERE financial_account_id = ?1`,
    )
      .bind(sourceId)
      .all<{ id: string }>();
    for (const tx of txRows.results) {
      const current = await getActiveAssignment(domainDb(c.env.DB), tx.id);
      if (current) {
        stmts.push(
          c.env.DB.prepare(
            `UPDATE transaction_account_assignments SET active = 0 WHERE id = ?1`,
          ).bind(current.id),
        );
      }
      stmts.push(
        c.env.DB.prepare(
          `INSERT INTO transaction_account_assignments
            (id, transaction_candidate_id, financial_account_id, assignment_source,
             identifier_type, normalized_identifier, assigned_by, assigned_at,
             replaced_assignment_id, active, metadata_json)
           VALUES (?1, ?2, ?3, 'ACCOUNT_MERGE', NULL, NULL, ?4, ?5, ?6, 1, ?7)`,
        ).bind(
          crypto.randomUUID(),
          tx.id,
          targetAccountId,
          ident.email,
          now,
          current ? current.id : null,
          JSON.stringify({
            sourceAccountId: sourceId,
            targetAccountId,
            reason: reason ?? null,
            priorSource: current?.assignment_source ?? null,
          }),
        ),
      );
      stmts.push(
        c.env.DB.prepare(
          `UPDATE transaction_candidates SET financial_account_id = ?2, updated_at = ?3 WHERE id = ?1`,
        ).bind(tx.id, targetAccountId, now),
      );
    }
  }

  // 2. Move payment claims.
  if (options.reassignClaims) {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE payment_claims SET target_financial_account_id = ?2, updated_at = ?3 WHERE target_financial_account_id = ?1`,
      ).bind(sourceId, targetAccountId, now),
    );
  }

  // 3. Move identifiers. Use the canonical columns first; fall back to the
  //    identifiers table. Conflicts on UNIQUE indexes are surfaced as
  //    `identifier_conflict` and the batch aborts.
  if (options.moveIdentifiers) {
    const idents = await c.env.DB.prepare(
      `SELECT id, kind, value, label FROM financial_account_identifiers WHERE financial_account_id = ?1`,
    )
      .bind(sourceId)
      .all<{ id: string; kind: string; value: string; label: string | null }>();
    for (const ident of idents.results) {
      stmts.push(
        c.env.DB.prepare(
          `UPDATE financial_account_identifiers SET financial_account_id = ?2 WHERE id = ?1`,
        ).bind(ident.id, targetAccountId),
      );
    }
  }

  // 4. Run the batch.
  try {
    if (stmts.length > 0) await c.env.DB.batch(stmts);
  } catch (e) {
    const msg = String(e);
    if (msg.includes('UNIQUE')) {
      return c.json(
        {
          ok: false,
          error: 'identifier_conflict',
          detail: 'target account already owns one of the moved identifiers',
        },
        409,
      );
    }
    throw e;
  }

  // 5. Optionally delete the source.
  let deletedSource = false;
  if (options.deleteSource) {
    const remaining = await countAccountReferences(c.env.DB, sourceId);
    if (remaining.transactions > 0 || remaining.paymentClaims > 0) {
      return c.json(
        {
          ok: false,
          error: 'delete_source_blocked',
          remaining,
        },
        409,
      );
    }
    await c.env.DB.batch([
      c.env.DB.prepare(
        `DELETE FROM financial_account_identifiers WHERE financial_account_id = ?1`,
      ).bind(sourceId),
      c.env.DB.prepare(`DELETE FROM financial_accounts WHERE id = ?1`).bind(sourceId),
    ]);
    deletedSource = true;
  }

  // 6. Audit.
  await c.env.DB.prepare(SQL.insertAudit)
    .bind(
      crypto.randomUUID(),
      ident.email,
      ident.role,
      'account.references_moved',
      'ACCOUNT',
      sourceId,
      JSON.stringify({
        displayName: source.display_name,
        bank: source.bank_name,
      }),
      JSON.stringify({
        targetAccountId,
        options,
        reason: reason ?? null,
        deletedSource,
      }),
      null,
      c.req.header('cf-ray') ?? null,
      now,
    )
    .run();

  return c.json({
    ok: true,
    sourceId,
    targetAccountId,
    deletedSource,
    options,
  });
});

/**
 * GET /api/v1/notifications/counts
 *
 * Returns the bell's count snapshot for the current actor. The bell polls
 * this every 5 seconds (matches the existing dashboard cadence).
 */
app.get('/api/v1/notifications/counts', async (c) => {
  const ident = c.get('identity');
  const db = domainDb(c.env.DB);
  const state = await getNotificationState(db, ident.email);
  const counts = await getNotificationCounts(
    db,
    {
      at: state.last_seen_transaction_at,
      id: state.last_seen_transaction_id,
    },
    ident.email,
  );
  const paymentEvents = await getPaymentEventUnreadCounts(db, ident.email);
  const bell = await getBellUnreadCounts(db, ident.email);
  const unread = bell.total;
  return c.json({
    ok: true,
    counts: {
      new: counts.new,
      unassigned: counts.unassigned,
      unmatched: counts.unmatched,
      suggested: counts.suggested,
      total: counts.unassigned + counts.unmatched + counts.suggested,
      unread,
      incomeUnread: bell.income,
      botAutoVerifiedUnread: bell.botAutoVerified,
      paymentEvents,
    },
    cursor: {
      at: state.last_seen_transaction_at,
      id: state.last_seen_transaction_id,
    },
    updatedAt: state.updated_at,
  });
});

const MarkReadBody = z
  .object({
    lastSeenTransactionAt: z.number().int().nonnegative(),
    lastSeenTransactionId: z.string().min(1),
  })
  .strict();

/**
 * POST /api/v1/notifications/mark-read
 *
 * Advance the actor's cursor to a SPECIFIC transaction (per-item click).
 * The cursor is only ever advanced forward — a smaller (at, id) tuple
 * is a no-op so polling or replayed clicks can't roll back read state.
 */
app.post('/api/v1/notifications/mark-read', async (c) => {
  const ident = c.get('identity');
  const parsed = MarkReadBody.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const now = Date.now();
  const current = await getNotificationState(domainDb(c.env.DB), ident.email);
  // Forward-only: only advance if the new cursor is strictly past the current.
  const nextAt = parsed.data.lastSeenTransactionAt;
  const nextId = parsed.data.lastSeenTransactionId;
  const curAt = current.last_seen_transaction_at ?? -1;
  const curId = current.last_seen_transaction_id ?? '';
  const isForward = nextAt > curAt || (nextAt === curAt && nextId > curId);
  if (isForward) {
    await setNotificationState(domainDb(c.env.DB), ident.email, nextAt, nextId, now);
  }
  return c.json({ ok: true, advanced: isForward });
});

/**
 * POST /api/v1/notifications/mark-all-read
 *
 * Advance the actor's cursor to the latest transaction currently visible
 * (i.e. the row the bell would render as the head of the recent list).
 * Operational counts remain unchanged.
 */
app.post('/api/v1/notifications/mark-all-read', async (c) => {
  const ident = c.get('identity');
  const db = domainDb(c.env.DB);
  const head = await c.env.DB.prepare(
    `SELECT id, bank_timestamp FROM transaction_candidates
      ORDER BY bank_timestamp DESC, id DESC LIMIT 1`,
  ).first<{ id: string; bank_timestamp: number | null }>();
  const now = Date.now();
  if (!head || head.bank_timestamp === null) {
    await setNotificationState(db, ident.email, now, 'cursor', now);
  } else {
    const current = await getNotificationState(db, ident.email);
    const curAt = current.last_seen_transaction_at ?? -1;
    const curId = current.last_seen_transaction_id ?? '';
    const isForward =
      head.bank_timestamp > curAt || (head.bank_timestamp === curAt && head.id > curId);
    if (isForward) {
      await setNotificationState(db, ident.email, head.bank_timestamp, head.id, now);
    }
  }
  for (const tab of ['income', 'bot_auto_verified'] as const) {
    await markPaymentEventsReadAll(db, ident.email, tab);
  }
  return c.json({ ok: true, advanced: true });
});

/**
 * POST /api/v1/notifications/transactions/:transactionId/seen
 *
 * Mark ONE transaction as seen by the authenticated actor. The mark is
 * upserted into `dashboard_transaction_reads` (PK = actor_email, tx_id),
 * so re-marking the same row just refreshes `seen_at`.
 *
 * Does NOT change transaction status, review state, match state, or
 * account assignment. Does NOT log the SMS body. Does NOT advance the
 * global cursor — that is the job of POST /mark-all-read.
 *
 * Returns the updated unread count so the bell can decrement its badge
 * immediately without waiting for the next poll.
 */
app.post('/api/v1/notifications/transactions/:transactionId/seen', async (c) => {
  const ident = c.get('identity');
  const transactionId = c.req.param('transactionId');
  if (!transactionId) return c.json({ ok: false, error: 'missing_id' }, 400);

  // Verify the transaction exists. Cheap PK lookup. We don't load the
  // full row — we only need to know whether to insert a read or 404.
  const exists = await c.env.DB.prepare(
    'SELECT 1 AS one FROM transaction_candidates WHERE id = ?1 LIMIT 1',
  )
    .bind(transactionId)
    .first<{ one: number }>();
  if (!exists) return c.json({ ok: false, error: 'not_found' }, 404);

  const now = Date.now();
  await markTransactionRead(domainDb(c.env.DB), ident.email, transactionId, now);

  // Recompute the "new" count so the bell can refresh its badge without
  // a separate poll. We reuse the existing helper — same definition as
  // the GET /counts endpoint. The actor email is required so the count
  // excludes rows the actor has explicitly marked seen.
  const state = await getNotificationState(domainDb(c.env.DB), ident.email);
  const counts = await getNotificationCounts(
    domainDb(c.env.DB),
    {
      at: state.last_seen_transaction_at,
      id: state.last_seen_transaction_id,
    },
    ident.email,
  );

  return c.json({
    ok: true,
    is_new: false,
    seen_at: now,
    unread: counts.new,
  });
});

/**
 * GET /api/v1/notifications/seen-ids
 *
 * Returns the actor's full per-row seen-id map (`transaction_id ->
 * seen_at_ms`). The dashboard's client cache uses this as an overlay on
 * top of the per-row `is_new` returned by the list endpoints, so that
 * optimistic dismissals survive page reloads and a second browser logged
 * in as the same Access user sees the same read state.
 *
 * The map is bounded in practice by the actor's session lifetime; the
 * supporting index keeps the read cheap.
 */
app.get('/api/v1/notifications/seen-ids', async (c) => {
  const ident = c.get('identity');
  const seen = await getSeenIdsForActor(domainDb(c.env.DB), ident.email);
  return c.json({ ok: true, seen_at_by_id: seen });
});

/**
 * GET /api/v1/notifications/recent?limit=20
 *
 * Recent transactions that the bell might highlight (newest first).
 * Powers the dropdown's "Recent activity" list.
 */
app.get('/api/v1/notifications/recent', async (c) => {
  const ident = c.get('identity');
  const limit = Math.min(50, Math.max(1, Number(c.req.query('limit') ?? '20')));
  const rows = await c.env.DB.prepare(
    `SELECT t.id, t.direction, t.amount_irr, t.balance_irr, t.status,
            t.bank_timestamp, t.financial_account_id,
            fa.display_name AS account_display,
            (SELECT COUNT(*) FROM reconciliation_matches rm
               WHERE rm.transaction_candidate_id = t.id) AS match_count,
            dns.last_seen_transaction_at AS cursor_at,
            dns.last_seen_transaction_id AS cursor_id,
            dtr.seen_at AS seen_at
       FROM transaction_candidates t
       LEFT JOIN financial_accounts fa ON fa.id = t.financial_account_id
       LEFT JOIN dashboard_notification_state dns ON dns.actor_email = ?2
       LEFT JOIN dashboard_transaction_reads dtr
         ON dtr.actor_email = ?2 AND dtr.transaction_candidate_id = t.id
      ORDER BY t.bank_timestamp DESC, t.created_at DESC
      LIMIT ?1`,
  )
    .bind(limit, ident.email)
    .all<{
      id: string;
      direction: string;
      amount_irr: number | null;
      balance_irr: number | null;
      status: string;
      bank_timestamp: number | null;
      financial_account_id: string | null;
      account_display: string | null;
      match_count: number;
      cursor_at: number | null;
      cursor_id: string | null;
      seen_at: number | null;
    }>();
  const items = rows.results.map((r) => ({
    id: r.id,
    direction: r.direction,
    amount_irr: r.amount_irr,
    balance_irr: r.balance_irr,
    status: r.status,
    bank_timestamp: r.bank_timestamp,
    accountId: r.financial_account_id,
    accountDisplay: r.account_display,
    hasMatch: Number(r.match_count ?? 0) > 0,
    is_new: isNewForTransaction(
      r.bank_timestamp,
      r.id,
      { at: r.cursor_at ?? null, id: r.cursor_id ?? null },
      r.seen_at,
    ),
    seen_at: r.seen_at ?? null,
  }));
  return c.json({ ok: true, items });
});

// ---------------------------------------------------------------------------
// Admin: cleanup tool for historical DEBIT rows.
// ---------------------------------------------------------------------------
import {
  applyCleanupOutgoing,
  dryRunCleanupOutgoing,
  type CleanupDryRunReport,
} from './admin/cleanup-debits.js';

app.post('/api/v1/admin/cleanup-debits/dry-run', async (c) => {
  const ident = c.get('identity');
  if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
  const report = await dryRunCleanupOutgoing(
    c.env.DB as unknown as Parameters<typeof dryRunCleanupOutgoing>[0],
  );
  return c.json({ ok: true, report });
});

const ApplyCleanupSchema = z
  .object({
    dryRunReport: z.unknown(),
    confirm: z.literal(true),
  })
  .strict();

app.post('/api/v1/admin/cleanup-debits/apply', async (c) => {
  const ident = c.get('identity');
  if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);
  const parsed = ApplyCleanupSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
  const report = parsed.data.dryRunReport as CleanupDryRunReport;
  if (!report || !Array.isArray(report.rows)) {
    return c.json({ ok: false, error: 'invalid_dry_run_report' }, 400);
  }
  const result = await applyCleanupOutgoing(
    c.env.DB as unknown as Parameters<typeof applyCleanupOutgoing>[0],
    report,
    ident.email,
    ident.role,
  );
  return c.json({ ok: true, ...result });
});

registerMirzabotRoutes(app);
registerAnalyticsRoutes(app);
registerBankRoutes(app);
registerCustomerRoutes(app);
registerAdminOverviewRoutes(app);
registerProductRoutes(app);
registerPanelRoutes(app);
registerDiscountRoutes(app);

export default app;
export { app };

// ponytail: this exists — sample-analyzer `scoreMatch` import kept so future
// scorer variants don't require a second import edit. Remove if unused.
void scoreMatch;
