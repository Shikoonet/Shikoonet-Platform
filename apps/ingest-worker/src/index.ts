import { Hono } from 'hono';
import { z } from 'zod';
import { INGEST_PATH, MAX_BODY_BYTES } from '@shikoo/contracts';
import { ingest } from './ingest.js';
import { normalizeIngestTimestamp } from './ingestTimestamp.js';
import { normalizeIngestJson } from './ingestBody.js';
import { verifyIntegrationHmac } from './integrations/auth.js';
import { handleMirzabotClaim, MirzabotClaimBody, MIRZABOT_CLAIMS_PATH, finalizeExpiredMirzabotWaits } from './integrations/mirzabot.js';
import type { MirzabotClaimPayload } from '@shikoo/contracts';
import type { RateLimit } from './rateLimit.js';

export interface Env {
  DB: D1Database;
  // Optional so a test can leave them out; production wires both in server.ts.
  DEVICE_LIMIT?: RateLimit;
  IP_LIMIT?: RateLimit;
  // "dev" | "production". Set in each wrangler config.
  ENV_NAME?: string;
  // Injected at deploy time by scripts/release.sh via `wrangler deploy --var`.
  APP_VERSION?: string;
  INGEST_MAX_BODY_BYTES?: string;
  // `LOG_SMS_BODY` was declared here and passed through from the environment
  // and read by nothing, so `deploy/README.md`'s "leave unset" instruction
  // protected nothing and implied a switch that could turn the logging on.
  // Removed rather than implemented: a raw bank SMS body is never written to a
  // log, and a setting that suggests otherwise is worse than no setting.
  MIRZABOT_INTEGRATION_ENABLED?: string;
  MIRZABOT_INTEGRATION_HMAC_SECRET?: string;
  MIRZABOT_INTEGRATION_ID?: string;
  AUTO_MATCH_ENABLED?: string;
  AUTO_FULFILLMENT_ENABLED?: string;
  MIRZABOT_WEBHOOK_URL?: string;
}

type D1Database = import('@shikoo/database').D1Database;

const Body = z
  .object({
    apiKey: z.string().min(8).max(256),
    deviceId: z.string().min(1).max(64),
    deviceName: z.string().min(1).max(128),
    message: z.string().min(1).max(4096),
    sender: z.string().min(1).max(64),
    timestamp: z.union([z.string().min(1), z.number().finite(), z.null()]).optional(),
    checksum: z.union([z.string().regex(/^[0-9a-f]{32}$/i), z.null()]).optional(),
  })
  .strict();

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

// Post-deploy smoke test target: confirms which build answers on this hostname.
// Exposes nothing an attacker can act on — no bindings, no config, no counts.
app.get('/version', (c) =>
  c.json({
    ok: true,
    version: c.env.APP_VERSION ?? 'unknown',
    env: c.env.ENV_NAME ?? 'unknown',
  }),
);

app.post(INGEST_PATH, async (c) => {
  const max = Number.parseInt(c.env.INGEST_MAX_BODY_BYTES ?? String(MAX_BODY_BYTES), 10);
  const lenHeader = c.req.header('content-length');
  if (lenHeader && Number.parseInt(lenHeader, 10) > max) {
    return c.json({ ok: false, error: 'too_large', code: 'PAYLOAD_TOO_LARGE' }, 413);
  }

  const ipKey = c.req.header('cf-connecting-ip') ?? 'unknown';
  if (c.env.IP_LIMIT) {
    const ip = await c.env.IP_LIMIT.limit({ key: ipKey });
    if (!ip.success) {
      return c.json({ ok: false, error: 'rate_limited', code: 'RATE_LIMITED' }, 429);
    }
  }

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ ok: false, error: 'bad_json', code: 'BAD_REQUEST' }, 400);
  }

  const parsed = Body.safeParse(normalizeIngestJson(raw) ?? raw);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid_body', code: 'BAD_REQUEST' }, 400);
  }

  const normalizedTimestamp =
    parsed.data.timestamp == null
      ? String(Date.now())
      : normalizeIngestTimestamp(parsed.data.timestamp);
  if (normalizedTimestamp == null) {
    return c.json({ ok: false, error: 'invalid_timestamp', code: 'BAD_REQUEST' }, 400);
  }

  const ingestBody = {
    ...parsed.data,
    timestamp: normalizedTimestamp,
    checksum: parsed.data.checksum ?? '',
  };

  // Body-size cap AFTER parse (Content-Length can be missing or lie).
  if (JSON.stringify(ingestBody).length > max) {
    return c.json({ ok: false, error: 'too_large', code: 'PAYLOAD_TOO_LARGE' }, 413);
  }

  const deviceKey = parsed.data.deviceId;
  if (c.env.DEVICE_LIMIT) {
    const dev = await c.env.DEVICE_LIMIT.limit({ key: deviceKey });
    if (!dev.success) {
      return c.json({ ok: false, error: 'rate_limited', code: 'RATE_LIMITED' }, 429);
    }
  }

  // apiKey must reach ingest() for authentication; ingest() does not persist
  // it and never includes it in audit/result payloads.
  const result = await ingest(c.env.DB, ingestBody, {
    mirzabot: {
      enabled: c.env.MIRZABOT_INTEGRATION_ENABLED === 'true',
      autoMatchEnabled: c.env.AUTO_MATCH_ENABLED === 'true',
      webhookEnv: c.env,
    },
  });
  if (!result.ok) {
    return c.json(result, result.code === 'UNAUTHORIZED' ? 401 : 500);
  }
  return c.json(result, 200);
});

app.post(MIRZABOT_CLAIMS_PATH, async (c) => {
  if (c.env.MIRZABOT_INTEGRATION_ENABLED !== 'true') {
    return c.json({ ok: false, error: 'integration_disabled' }, 404);
  }
  const secret = c.env.MIRZABOT_INTEGRATION_HMAC_SECRET;
  const integrationId = c.env.MIRZABOT_INTEGRATION_ID ?? 'mirzabot-test';
  if (!secret) {
    return c.json({ ok: false, error: 'integration_not_configured' }, 503);
  }

  const rawBody = await c.req.text();
  const auth = await verifyIntegrationHmac(
    secret,
    c.req.header('X-Integration-Id') ?? '',
    c.req.header('X-Event-Id') ?? '',
    c.req.header('X-Timestamp') ?? '',
    'POST',
    MIRZABOT_CLAIMS_PATH,
    rawBody,
    c.req.header('X-Signature'),
    integrationId,
  );
  if (!auth.ok) {
    return c.json({ ok: false, error: auth.code }, 401);
  }

  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return c.json({ ok: false, error: 'bad_json' }, 400);
  }
  const parsed = MirzabotClaimBody.safeParse(json);
  if (!parsed.success) {
    return c.json({ ok: false, error: 'invalid_body' }, 400);
  }
  if (parsed.data.eventId !== c.req.header('X-Event-Id')) {
    return c.json({ ok: false, error: 'event_id_mismatch' }, 400);
  }

  try {
    const result = await handleMirzabotClaim(c.env.DB, parsed.data as MirzabotClaimPayload, {
      autoMatchEnabled: c.env.AUTO_MATCH_ENABLED === 'true',
      webhookEnv: c.env,
    });
    return c.json(result, 200);
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'internal';
    if (msg === 'IRR_AMOUNT_MISMATCH') {
      return c.json({ ok: false, error: msg }, 400);
    }
    return c.json({ ok: false, error: 'internal' }, 500);
  }
});

export { app };

/**
 * Options the scheduled sweep needs. Exported so server.ts can run it on a
 * timer without importing the Worker-era plumbing.
 */
export function mirzabotMatchOptions(env: Env) {
  return {
    enabled: env.MIRZABOT_INTEGRATION_ENABLED === 'true',
    autoMatchEnabled: env.AUTO_MATCH_ENABLED === 'true',
    webhookEnv: env,
  };
}

/**
 * The cron body, previously a Worker `scheduled()` handler. Claims that were
 * left waiting past their window get finalised here.
 */
export async function runScheduledSweep(env: Env): Promise<void> {
  await finalizeExpiredMirzabotWaits(env.DB, mirzabotMatchOptions(env));
}
