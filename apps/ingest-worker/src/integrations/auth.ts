/**
 * HMAC verification for Mirzabot → Hub integration requests.
 * API replay window: 5 minutes (separate from 60s payment match window).
 */
import { INTEGRATION_REPLAY_WINDOW_MS } from '@shikoo/contracts';

export interface IntegrationAuthEnv {
  MIRZABOT_INTEGRATION_HMAC_SECRET?: string;
  MIRZABOT_INTEGRATION_ID?: string;
}

export async function verifyIntegrationHmac(
  secret: string,
  integrationId: string,
  eventId: string,
  timestampSec: string,
  method: string,
  path: string,
  rawBody: string,
  signatureHeader: string | undefined,
  expectedIntegrationId: string,
): Promise<{ ok: true } | { ok: false; code: string }> {
  if (integrationId !== expectedIntegrationId) {
    return { ok: false, code: 'INVALID_INTEGRATION_ID' };
  }
  const ts = Number.parseInt(timestampSec, 10);
  if (!Number.isFinite(ts)) return { ok: false, code: 'INVALID_TIMESTAMP' };
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - ts) * 1000 > INTEGRATION_REPLAY_WINDOW_MS) {
    return { ok: false, code: 'TIMESTAMP_EXPIRED' };
  }
  if (!signatureHeader?.startsWith('sha256=')) {
    return { ok: false, code: 'INVALID_SIGNATURE' };
  }
  const provided = signatureHeader.slice('sha256='.length);
  const bodyHash = await sha256Hex(rawBody);
  const payload = `${timestampSec}\n${method}\n${path}\n${bodyHash}`;
  const expected = await hmacSha256Hex(secret, payload);
  if (!timingSafeEqual(provided, expected)) {
    return { ok: false, code: 'INVALID_SIGNATURE' };
  }
  return { ok: true };
}

async function sha256Hex(data: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i)!;
  return out === 0;
}
