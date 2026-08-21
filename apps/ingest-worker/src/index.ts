import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { MiddlewareHandler } from 'hono';
import { z } from 'zod';
import { INGEST_PATH, MAX_BODY_BYTES, type EnvName } from '@shikoo/contracts';
import { ingest } from './ingest.js';
import { normalizeIngestTimestamp } from './ingestTimestamp.js';
import { normalizeIngestJson } from './ingestBody.js';
import { verifyIntegrationHmac } from './integrations/auth.js';
import { handleMirzabotClaim, MirzabotClaimBody, MIRZABOT_CLAIMS_PATH, finalizeExpiredMirzabotWaits } from './integrations/mirzabot.js';
import { flushWebhookDeliveries } from './integrations/webhook.js';
import type { MirzabotClaimPayload } from '@shikoo/contracts';
import { clientIp, type RateLimit } from '@shikoo/domain';

export interface Env {
  DB: D1Database;
  // Optional so a test can leave them out; production wires both in server.ts.
  DEVICE_LIMIT?: RateLimit;
  IP_LIMIT?: RateLimit;
  /**
   * Which environment this is. A union rather than a string, so a comparison
   * against `'prod'` stops compiling — see `parseEnvName`. It gates
   * `assertProductionConfig`, which is what forces a decision on the two
   * switches that decide whether money is ever verified.
   */
  ENV_NAME?: EnvName;
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
  /**
   * The header the reverse proxy sets to the real client address — `X-Real-IP`
   * for the nginx terminator in front of this. Named rather than guessed,
   * because trusting a header means trusting whoever can set it: unset, the
   * per-IP limit is skipped instead of putting the whole fleet in one bucket.
   */
  TRUSTED_PROXY_IP_HEADER?: string;
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

/**
 * The cap on a claim from the PHP bot.
 *
 * `MirzabotClaimBody` is a dozen short fields. Its own cap rather than the SMS
 * one because this route reads the whole body **before** it can authenticate
 * anything: the HMAC is over the raw bytes, so they have to exist first. A small
 * number here is the difference between an attacker with no credential spending
 * a few kilobytes of our memory and spending as much as they can send.
 */
const MIRZABOT_MAX_BODY_BYTES = 4 * 1024;

/**
 * The configured cap, or the built-in one.
 *
 * `Number.parseInt` on an unset or malformed value used to produce `NaN`, and
 * `n > NaN` is false — so a typo in `INGEST_MAX_BODY_BYTES` did not widen the
 * limit, it **removed** it. `server.ts` refuses to start on a bad value, so this
 * fallback only covers the tests and anything that builds `Env` by hand.
 */
function maxBodyBytes(env: Env): number {
  const raw = env.INGEST_MAX_BODY_BYTES;
  if (raw === undefined || raw === '') return MAX_BODY_BYTES;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n > 0 ? n : MAX_BODY_BYTES;
}

/**
 * Refuse an oversized body before it is in memory, counting real bytes.
 *
 * Three things were wrong with what this replaces, and they compounded:
 *
 *   - `Content-Length` was consulted **only when present**, so a chunked
 *     request skipped the check entirely;
 *   - `c.req.json()` then parsed whatever arrived, so the allocation happened
 *     before anything measured it;
 *   - the second check ran after the parse on `JSON.stringify(body).length`,
 *     which counts UTF-16 code units. A Persian SMS is two bytes per character
 *     in UTF-8 and one unit here, so the number being compared to a limit named
 *     `_BYTES` was about half the bytes.
 *
 * Hono's own middleware does the right thing on both paths: a declared
 * `Content-Length` over the cap is refused outright, and a chunked body is
 * counted as it streams and aborted mid-flight. A *lying* `Content-Length` does
 * not open a hole here because Node's HTTP parser hands the request exactly the
 * declared number of bytes — the surplus is not ours to allocate.
 *
 * Built per request rather than registered once, because the cap comes from
 * `c.env` and the app object is shared with tests that pass their own.
 */
function limitBody(max: (env: Env) => number): MiddlewareHandler<{ Bindings: Env }> {
  return (c, next) =>
    bodyLimit({
      maxSize: max(c.env),
      onError: (ctx) =>
        ctx.json({ ok: false, error: 'too_large', code: 'PAYLOAD_TOO_LARGE' }, 413),
    })(c, next);
}

const app = new Hono<{ Bindings: Env }>();

app.get('/health', (c) => c.json({ ok: true }));

// Post-deploy smoke test target: confirms which build answers on this hostname.
//
// It could not do that until 2026-08-22. `APP_VERSION` was fed by the retired
// Cloudflare release script and by nothing since, so this answered the literal
// string `dev` on every build including production — an endpoint whose whole
// purpose is telling two builds apart, giving the same answer for all of them.
// It answers the deployed commit sha now; see `resolveAppVersion`.
//
// Still unauthenticated, and that is a smaller claim than the sentence here
// used to make. No bindings, no config, no counts — but now a commit sha and
// an environment name, on the one hostname that has to be public. The sha names
// a commit in a private repository, so it is a fingerprint rather than a key,
// and this is the only hostname whose build cannot be confirmed from the panel's
// own gated `/api/v1/version`. Reviewed and kept, not overlooked. If it is ever
// closed, note that the device credential lives in the POST body rather than a
// header, so a gate here costs a new mechanism rather than a reused one.
app.get('/version', (c) =>
  c.json({
    ok: true,
    version: c.env.APP_VERSION ?? 'unknown',
    env: c.env.ENV_NAME ?? 'unknown',
  }),
);

app.post(INGEST_PATH, limitBody(maxBodyBytes), async (c) => {
  // Skipped rather than shared when the address cannot be known. The old
  // `?? 'unknown'` put every device in one bucket, so a single busy phone
  // rate-limited the whole fleet — and the header it read is client-controlled
  // now that nothing strips it. See `clientIp`. The per-device limit below and
  // the device's own credential still apply either way.
  const ip = clientIp((name) => c.req.header(name), c.env.TRUSTED_PROXY_IP_HEADER);
  if (c.env.IP_LIMIT && ip !== null) {
    const allowed = await c.env.IP_LIMIT.limit({ key: `ip:${ip}` });
    if (!allowed.success) {
      return c.json({ ok: false, error: 'rate_limited', code: 'RATE_LIMITED' }, 429);
    }
  }

  // Read, then parse, and only the parse is guarded.
  //
  // `c.req.json()` inside the try was doing both, and the limiter reports an
  // oversize body by erroring the body stream — so a 64 KB payload came back
  // `bad_json` 400 while `bodyLimit` never got to answer. The size failure has
  // to leave this handler for the middleware to turn it into a 413, and a
  // `catch` around the read is what stopped it. That is a whole class of bug:
  // a broad catch converts somebody else's signal into your own error.
  const text = await c.req.text();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
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

app.post(MIRZABOT_CLAIMS_PATH, limitBody(() => MIRZABOT_MAX_BODY_BYTES), async (c) => {
  if (c.env.MIRZABOT_INTEGRATION_ENABLED !== 'true') {
    return c.json({ ok: false, error: 'integration_disabled' }, 404);
  }
  const secret = c.env.MIRZABOT_INTEGRATION_HMAC_SECRET;
  const integrationId = c.env.MIRZABOT_INTEGRATION_ID ?? 'mirzabot-test';
  if (!secret) {
    return c.json({ ok: false, error: 'integration_not_configured' }, 503);
  }

  // Charged before the body is read and long before the HMAC is computed. This
  // route authenticates over the raw bytes, so an unauthenticated caller gets to
  // make us read and hash whatever they send; without a limit here the only cost
  // to them is bandwidth. The claim path had no rate limit of any kind.
  const ip = clientIp((name) => c.req.header(name), c.env.TRUSTED_PROXY_IP_HEADER);
  if (c.env.IP_LIMIT && ip !== null) {
    const allowed = await c.env.IP_LIMIT.limit({ key: `claim:${ip}` });
    if (!allowed.success) {
      return c.json({ ok: false, error: 'rate_limited' }, 429);
    }
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
 *
 * The outbox is flushed on its own line rather than left to the matcher.
 * `finalizeExpiredMirzabotWaits` returns without running any matching when no
 * group is due, and the matcher is the only thing that used to flush — so a
 * delivery that failed at 03:00 waited for the next customer to pay before it
 * was retried. On a quiet night that is hours, and the notice it is holding is
 * a customer's order that the legacy bot has not been told to fulfil.
 *
 * It runs even when the integration is switched off. `flushWebhookDeliveries`
 * makes that decision itself, from `AUTO_FULFILLMENT_ENABLED`, and gating it
 * here as well would put the same rule in two places for them to disagree in.
 */
export async function runScheduledSweep(env: Env): Promise<void> {
  await finalizeExpiredMirzabotWaits(env.DB, mirzabotMatchOptions(env));
  const flushed = await flushWebhookDeliveries(env.DB, env);
  if (flushed.dead > 0) {
    // The only voice a dead notice has today. A DEAD row means a paid customer
    // whose order the legacy bot was never successfully told about, and it will
    // not be retried again — see the outbox note in `webhook.ts`.
    console.error(`[sweep] ${flushed.dead} fulfilment notice(s) gave up and need a person`);
  }
}
