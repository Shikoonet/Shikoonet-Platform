/**
 * The names a customer's app shows for a subscription, and the version line.
 *
 * Built from links shaped like the panel's `/links` body. The uuids and hosts
 * are placeholders; only the `#name` part matters here.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearSubscriptionCache,
  namesFromLinks,
  readSubscriptionNames,
} from '../src/integrations/subscriptionNames.js';

const enc = encodeURIComponent;
const PLAIN = [
  `vless://00000000-0000-0000-0000-000000000000@h.example:443?security=tls#${enc('🔄 V3.7.8.1')}`,
  `vless://00000000-0000-0000-0000-000000000000@h.example:443?security=tls#${enc('🇩🇪 آلمان ۱')}`,
  `trojan://secret@h.example:443#${enc('🇫🇮 Finland')}`,
  `vmess://${Buffer.from(JSON.stringify({ ps: '🇹🇷 Turkey', add: 'h.example' })).toString('base64')}`,
  `trojan://secret@h.example:443#${enc('🇫🇮 Finland')}`,
].join('\n');

describe('namesFromLinks', () => {
  it('reads every name, finds the version line, and drops repeats', () => {
    expect(namesFromLinks(PLAIN, null)).toEqual({
      version: 'V3.7.8.1',
      servers: ['🇩🇪 آلمان ۱', '🇫🇮 Finland', '🇹🇷 Turkey'],
    });
  });
  it('reads a base64 body the same way', () => {
    expect(namesFromLinks(Buffer.from(PLAIN).toString('base64'), null)?.servers).toHaveLength(3);
  });
  it('falls back to the profile-title header, plain or base64', () => {
    const noVersion = PLAIN.split('\n').slice(1).join('\n');
    expect(namesFromLinks(noVersion, 'Shikoonet V3.7.9')?.version).toBe('V3.7.9');
    const b64 = `base64:${Buffer.from('Shikoonet V3.8').toString('base64')}`;
    expect(namesFromLinks(noVersion, b64)?.version).toBe('V3.8');
    expect(namesFromLinks(noVersion, null)?.version).toBeNull();
  });
  it('does not take «V2» in a server name for a version', () => {
    const body = `trojan://s@h.example:443#${enc('Germany V2')}`;
    expect(namesFromLinks(body, null)).toEqual({ version: null, servers: ['Germany V2'] });
  });
  it('answers null for a body with no links at all — an HTML page is not a server list', () => {
    expect(namesFromLinks('<html><body>Login</body></html>', null)).toBeNull();
    expect(namesFromLinks('', null)).toBeNull();
  });
});

describe('readSubscriptionNames', () => {
  beforeEach(() => clearSubscriptionCache());
  const LINK = 'https://sub.example/sub/abc';
  function counting(body: string) {
    const calls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(body, { status: 200 });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  it('asks <link>/links and never a plain-http link', async () => {
    const f = counting(PLAIN);
    expect(await readSubscriptionNames(LINK, { fetchImpl: f.fetchImpl, now: 0 })).not.toBeNull();
    expect(f.calls).toEqual(['https://sub.example/sub/abc/links']);
    expect(
      await readSubscriptionNames('http://sub.example/sub/abc', { fetchImpl: f.fetchImpl, now: 0 }),
    ).toBeNull();
    expect(f.calls).toHaveLength(1);
  });
  it('keeps an answer five minutes, then asks again', async () => {
    const f = counting(PLAIN);
    await readSubscriptionNames(LINK, { fetchImpl: f.fetchImpl, now: 0 });
    await readSubscriptionNames(LINK, { fetchImpl: f.fetchImpl, now: 4 * 60_000 });
    expect(f.calls).toHaveLength(1);
    await readSubscriptionNames(LINK, { fetchImpl: f.fetchImpl, now: 5 * 60_000 + 1 });
    expect(f.calls).toHaveLength(2);
  });
  it('gives up at the timeout instead of holding the caller', async () => {
    const hang = ((_: unknown, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    const started = Date.now();
    expect(
      await readSubscriptionNames(LINK, { fetchImpl: hang, now: 0, timeoutMs: 50 }),
    ).toBeNull();
    expect(Date.now() - started).toBeLessThan(2000);
  });
  it('answers null for a panel error', async () => {
    const f = (async () => new Response('nope', { status: 502 })) as unknown as typeof fetch;
    expect(await readSubscriptionNames(LINK, { fetchImpl: f, now: 0 })).toBeNull();
  });
});
