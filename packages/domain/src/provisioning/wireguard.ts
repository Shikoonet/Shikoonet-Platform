/**
 * A PasarGuard account's WireGuard configs, as the files a WireGuard app imports.
 *
 * Sam, 2026-09-22: a WireGuard buyer should get the config itself and its QR
 * code, not only the subscription link. The panel already knows how — its
 * subscription page has a «download .conf» button — but that button is
 * client-side: the page is handed the account's `links` and converts each
 * `wireguard://` one in the browser. There is nothing to download from.
 *
 * So the same conversion runs here, on the text `GET <subscription>/links`
 * returns: one link per line, plain. The format is PasarGuard 5.2.1's own,
 * read from its source rather than its documentation (which lists no
 * WireGuard format at all):
 *
 *   `app/subscription/base.py` `_build_wireguard_components` writes
 *     wireguard://{quote(private_key)}@{address}:{port}/?{urlencode(payload)}#{quote(remark)}
 *   with `publickey` and `address` always, and `mtu`, `allowedips`,
 *   `keepalive`, `reserved`, `dns`, `presharedkey` when the inbound sets them;
 *   `app/subscription/wireguard.py` `WireGuardConfiguration.add` renders the
 *   same fields to the .conf this file reproduces, key for key and in order.
 *
 * Not `GET <subscription>/wireguard`, though 5.2.1 has that format: it answers
 * with a ZIP of .conf files, and reading a zip container is either a new
 * dependency or a hand-written parser, for bytes the `links` format already
 * carries as text.
 *
 * The private key is in the link and therefore in what this returns. That is
 * not new exposure — the subscription URL, which is stored and shown to the
 * customer, yields the same key to anyone who holds it — but it means none of
 * this is ever logged.
 */

export interface WireguardConf {
  /** A tunnel name every WireGuard client accepts, plus `.conf`. */
  fileName: string;
  /** The .conf text, as PasarGuard's own renderer would write it. */
  conf: string;
}

const SCHEME = 'wireguard://';

/**
 * Android's WireGuard app caps a tunnel name at 15 characters from
 * `[A-Za-z0-9_=+.-]` — the kernel's interface-name limit — and Windows at 32
 * from the same set. The app takes the name from the file name on import and
 * refuses one it cannot use, so the file is named for the stricter of the two.
 * PasarGuard remarks are routinely Persian or carry a status emoji, which
 * leaves nothing usable; `wireguard` is the fallback.
 */
const TUNNEL_NAME_MAX = 15;

function tunnelName(remark: string, index: number, total: number): string {
  const suffix = total > 1 ? `-${index + 1}` : '';
  const base =
    remark
      .replace(/[^A-Za-z0-9_=+.-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '') || 'wireguard';
  return base.slice(0, TUNNEL_NAME_MAX - suffix.length).replace(/[-.]+$/, '') + suffix;
}

/** Query names are matched case-blind, as the subscription page matches them. */
function param(params: URLSearchParams, name: string): string {
  for (const [key, value] of params) {
    if (key.toLowerCase() === name) return value.trim();
  }
  return '';
}

/** `a,b` → `a, b`, which is how the panel writes every list in a .conf. */
function list(value: string): string {
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .join(', ');
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * One `wireguard://` link to its .conf text, or null when it lacks what a
 * tunnel cannot start without — a private key, the server's public key, an
 * address, an endpoint. A null is skipped, never guessed at: a config with a
 * made-up AllowedIPs is worse than no config, because it imports cleanly and
 * then quietly routes the wrong traffic.
 */
function confText(link: string): { remark: string; conf: string } | null {
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  const q = url.searchParams;
  const privateKey = decode(url.username);
  const publicKey = param(q, 'publickey');
  const address = param(q, 'address');
  // A non-special scheme keeps an IPv6 host's brackets in `hostname`; one
  // written without them never parsed as a URL in the first place.
  const host = url.hostname;
  if (!privateKey || !publicKey || !address || !host || !url.port) return null;

  const iface = [`PrivateKey = ${privateKey}`, `Address = ${list(address)}`];
  const mtu = param(q, 'mtu');
  if (mtu) iface.push(`MTU = ${mtu}`);
  const reserved = param(q, 'reserved');
  if (reserved) iface.push(`Reserved = ${reserved}`);
  const dns = param(q, 'dns');
  if (dns) iface.push(`DNS = ${list(dns)}`);

  const peer = [`PublicKey = ${publicKey}`];
  const allowedIps = param(q, 'allowedips');
  if (allowedIps) peer.push(`AllowedIPs = ${list(allowedIps)}`);
  peer.push(`Endpoint = ${host}:${url.port}`);
  const presharedKey = param(q, 'presharedkey');
  if (presharedKey) peer.push(`PresharedKey = ${presharedKey}`);
  const keepalive = param(q, 'keepalive');
  if (keepalive) peer.push(`PersistentKeepalive = ${keepalive}`);

  return {
    remark: decode(url.hash.replace(/^#/, '')),
    conf: ['[Interface]', ...iface, '', '[Peer]', ...peer].join('\n'),
  };
}

/**
 * Every WireGuard config in a `links` subscription body, in the panel's order.
 *
 * An account with no WireGuard host gets `[]`, and that is the whole gate:
 * nothing upstream has to know which plans are WireGuard ones.
 */
export function wireguardConfsFromLinks(body: string): WireguardConf[] {
  const found = body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.toLowerCase().startsWith(SCHEME))
    .map(confText)
    .filter((c): c is { remark: string; conf: string } => c !== null);
  return found.map((c, i) => ({
    fileName: `${tunnelName(c.remark, i, found.length)}.conf`,
    conf: c.conf,
  }));
}
