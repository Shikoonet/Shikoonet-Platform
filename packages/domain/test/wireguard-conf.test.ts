import { describe, expect, it } from 'vitest';
import { wireguardConfsFromLinks } from '../src/provisioning/wireguard.js';

/*
 * The expected .conf text here was not written by hand. Both fixtures were
 * produced by running PasarGuard 5.2.1's own code — the link from
 * `app/subscription/base.py` `_build_wireguard_components`, the config from
 * `app/subscription/wireguard.py` `WireGuardConfiguration.add` and
 * `_render_config`, copied verbatim — on the same inputs. So a pass means this
 * file agrees with the panel, not with itself (rule 6), down to the panel's
 * own inconsistency of writing `Reserved = 1,2,3` without the spaces it puts
 * in every other list.
 */
const FULL = {
  link:
    'wireguard://aB%2Bc%2FdE%3DfGhIjKlMnOpQrStUvWxYz0123456789%2B%2FAB%3D@de1.example.com:51820/' +
    '?publickey=Pv%2B%2FServerKey0123456789abcdefghijklmnopqrs%3D&address=10.8.0.7%2F32%2Cfd00%3A%3A7%2F128' +
    '&mtu=1280&allowedips=0.0.0.0%2F0%2C%3A%3A%2F0&keepalive=25&reserved=1%2C2%2C3&dns=1.1.1.1%2C8.8.8.8' +
    '&presharedkey=Psk%2B%2F0123456789abcdefghijklmnopqrstuvwxyzA%3D#Germany',
  conf: [
    '[Interface]',
    'PrivateKey = aB+c/dE=fGhIjKlMnOpQrStUvWxYz0123456789+/AB=',
    'Address = 10.8.0.7/32, fd00::7/128',
    'MTU = 1280',
    'Reserved = 1,2,3',
    'DNS = 1.1.1.1, 8.8.8.8',
    '',
    '[Peer]',
    'PublicKey = Pv+/ServerKey0123456789abcdefghijklmnopqrs=',
    'AllowedIPs = 0.0.0.0/0, ::/0',
    'Endpoint = de1.example.com:51820',
    'PresharedKey = Psk+/0123456789abcdefghijklmnopqrstuvwxyzA=',
    'PersistentKeepalive = 25',
  ].join('\n'),
};

const MINIMAL = {
  link:
    'wireguard://mInImAl0123456789abcdefghijklmnopqrstuvwxy%3D@203.0.113.4:443/' +
    '?publickey=Pv%2B%2FServerKey0123456789abcdefghijklmnopqrs%3D&address=10.8.0.9%2F32&allowedips=0.0.0.0%2F0' +
    '#%F0%9F%87%A9%F0%9F%87%AA%20%D8%A2%D9%84%D9%85%D8%A7%D9%86%20%E2%9C%85',
  conf: [
    '[Interface]',
    'PrivateKey = mInImAl0123456789abcdefghijklmnopqrstuvwxy=',
    'Address = 10.8.0.9/32',
    '',
    '[Peer]',
    'PublicKey = Pv+/ServerKey0123456789abcdefghijklmnopqrs=',
    'AllowedIPs = 0.0.0.0/0',
    'Endpoint = 203.0.113.4:443',
  ].join('\n'),
};

const VLESS = 'vless://11111111-2222-3333-4444-555555555555@de1.example.com:443?security=tls#Germany%20VLESS';

describe('wireguardConfsFromLinks', () => {
  it('renders every field the way PasarGuard renders it', () => {
    expect(wireguardConfsFromLinks(FULL.link).map((c) => c.conf)).toEqual([FULL.conf]);
  });

  it('renders a bare inbound, with a Persian-and-emoji remark', () => {
    expect(wireguardConfsFromLinks(MINIMAL.link).map((c) => c.conf)).toEqual([MINIMAL.conf]);
  });

  // A `links` body is every protocol the account has, one per line — the
  // WireGuard lines are picked out and the rest left alone.
  it('keeps only the WireGuard lines of a mixed subscription, in order', () => {
    const body = [VLESS, FULL.link, '', MINIMAL.link, 'trojan://x@y:1#z'].join('\r\n');
    expect(wireguardConfsFromLinks(body).map((c) => c.conf)).toEqual([FULL.conf, MINIMAL.conf]);
  });

  // The gate: an account with no WireGuard host is simply not a WireGuard
  // buyer, and nothing upstream has to know which plans are.
  it('returns nothing for a subscription with no WireGuard host', () => {
    expect(wireguardConfsFromLinks([VLESS, 'trojan://x@y:1#z'].join('\n'))).toEqual([]);
    expect(wireguardConfsFromLinks('')).toEqual([]);
  });

  // Skipped, never completed with a guess: a config that imports cleanly and
  // routes nothing is worse than none.
  it('skips a link missing what a tunnel cannot start without', () => {
    const noServerKey = FULL.link.replace(/publickey=[^&]+&/, '');
    const noPrivateKey = FULL.link.replace(/^wireguard:\/\/[^@]+@/, 'wireguard://@');
    const noPort = FULL.link.replace(':51820/', '/');
    expect(wireguardConfsFromLinks([noServerKey, noPrivateKey, noPort, MINIMAL.link].join('\n'))).toEqual([
      { fileName: 'wireguard.conf', conf: MINIMAL.conf },
    ]);
  });

  it('keeps the brackets of an IPv6 endpoint', () => {
    const v6 = MINIMAL.link.replace('203.0.113.4', '[2001:db8::1]');
    expect(wireguardConfsFromLinks(v6)[0]!.conf).toContain('Endpoint = [2001:db8::1]:443');
  });

  it('matches query names case-blind, as the subscription page does', () => {
    const upper = MINIMAL.link.replace('publickey=', 'PublicKey=').replace('allowedips=', 'AllowedIPs=');
    expect(wireguardConfsFromLinks(upper).map((c) => c.conf)).toEqual([MINIMAL.conf]);
  });
});

/*
 * The WireGuard app names the tunnel after the file, and refuses a name it
 * cannot use: Android allows 15 characters of [A-Za-z0-9_=+.-], Windows 32 of
 * the same. A file named for the stricter one imports on both.
 */
describe('the file name is a tunnel name both apps accept', () => {
  const VALID = /^[A-Za-z0-9_=+.-]{1,15}$/;
  const stem = (c: { fileName: string }) => c.fileName.replace(/\.conf$/, '');

  it('keeps an ASCII remark', () => {
    expect(wireguardConfsFromLinks(FULL.link)[0]!.fileName).toBe('Germany.conf');
  });

  it('falls back when the remark has nothing usable — Persian and emoji', () => {
    expect(wireguardConfsFromLinks(MINIMAL.link)[0]!.fileName).toBe('wireguard.conf');
  });

  it('cuts a long remark to fifteen', () => {
    const long = FULL.link.replace('#Germany', '#Frankfurt%20Premium%20Node%2007');
    const name = stem(wireguardConfsFromLinks(long)[0]!);
    expect(name).toMatch(VALID);
    expect(name.startsWith('Frankfurt')).toBe(true);
  });

  it('numbers several configs so no two files share a tunnel', () => {
    const confs = wireguardConfsFromLinks([FULL.link, FULL.link, MINIMAL.link].join('\n'));
    const names = confs.map(stem);
    expect(names).toEqual(['Germany-1', 'Germany-2', 'wireguard-3']);
    for (const n of names) expect(n).toMatch(VALID);
  });

  it('stays valid when the suffix has to eat into a long name', () => {
    const long = FULL.link.replace('#Germany', '#ABCDEFGHIJKLMNOPQRSTU');
    const names = wireguardConfsFromLinks([long, long].join('\n')).map(stem);
    for (const n of names) expect(n).toMatch(VALID);
    expect(new Set(names).size).toBe(2);
  });
});
