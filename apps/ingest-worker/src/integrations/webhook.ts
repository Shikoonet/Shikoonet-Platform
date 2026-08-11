import type { MirzabotVerifiedWebhook } from '@shikoo/contracts';
import { MIRZABOT_CLAIMS_PATH } from '@shikoo/contracts';

export interface WebhookEnv {
  MIRZABOT_WEBHOOK_URL?: string;
  MIRZABOT_INTEGRATION_HMAC_SECRET?: string;
  MIRZABOT_INTEGRATION_ID?: string;
  AUTO_FULFILLMENT_ENABLED?: string;
}

export async function deliverMirzabotVerifiedWebhook(
  env: WebhookEnv,
  payload: MirzabotVerifiedWebhook,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (env.AUTO_FULFILLMENT_ENABLED !== 'true') return { ok: true };
  const url = env.MIRZABOT_WEBHOOK_URL;
  const secret = env.MIRZABOT_INTEGRATION_HMAC_SECRET;
  const integrationId = env.MIRZABOT_INTEGRATION_ID ?? 'mirzabot-test';
  if (!url || !secret) return { ok: false, error: 'webhook_not_configured' };

  const body = JSON.stringify(payload);
  const ts = Math.floor(Date.now() / 1000).toString();
  const bodyHash = await sha256Hex(body);
  const signPayload = `${ts}\nPOST\n/api/v1/integrations/payment-hub/verified\n${bodyHash}`;
  const signature = `sha256=${await hmacSha256Hex(secret, signPayload)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'X-Integration-Id': integrationId,
      'X-Event-Id': payload.eventId,
      'X-Timestamp': ts,
      'X-Signature': signature,
    },
    body,
  });
  if (!res.ok) return { ok: false, error: `http_${res.status}` };
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

export { MIRZABOT_CLAIMS_PATH };
