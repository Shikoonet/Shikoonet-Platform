/**
 * The names a customer's app shows for a subscription, and the version line
 * support keeps asking about («عدد بالای کانفیگ‌ها باید آخرین نسخه باشد»).
 *
 * Read from `<subscription>/links` — the same body the customer's app
 * downloads — so the list is exactly what they see. No admin login: the
 * subscription link is its own credential, which is also why only https is
 * read and why nothing but names ever leaves this module.
 */
export interface SubscriptionNames {
  version: string | null;
  servers: string[];
}

/** «V3.7.8.1», «V 3.8» — a dotted number, so a server called «Germany V2» is not one. */
const VERSION = /\bV\s?\d+(?:\.\d+){1,3}\b/i;
const CACHE_MS = 5 * 60_000;
const FAILURE_CACHE_MS = 60_000;
/** Short on purpose: the support bot is waiting on this answer with a customer on the line. */
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_IN_FLIGHT = 4;

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function fromBase64(s: string): string {
  return Buffer.from(s, 'base64').toString('utf8');
}

/** The display name of one link: `#name` for most schemes, the JSON `ps` for vmess. */
function nameOf(line: string): string {
  if (line.toLowerCase().startsWith('vmess://')) {
    try {
      const ps = (JSON.parse(fromBase64(line.slice('vmess://'.length))) as { ps?: unknown }).ps;
      return typeof ps === 'string' ? ps.trim() : '';
    } catch {
      return '';
    }
  }
  const at = line.lastIndexOf('#');
  return at < 0 ? '' : safeDecode(line.slice(at + 1)).trim();
}

function versionIn(text: string): string | null {
  const m = VERSION.exec(text);
  return m ? m[0].replace(/\s/g, '') : null;
}

/** Null when the body holds no links at all — a login page is not a server list. */
export function namesFromLinks(body: string, profileTitle: string | null): SubscriptionNames | null {
  const trimmed = body.trim();
  const text = trimmed.includes('://') ? trimmed : fromBase64(trimmed);
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes('://'));
  if (lines.length === 0) return null;

  let version: string | null = null;
  const servers: string[] = [];
  for (const name of lines.map(nameOf)) {
    if (name === '') continue;
    const v: string | null = version === null ? versionIn(name) : null;
    if (v !== null) {
      version = v;
      continue;
    }
    if (!servers.includes(name)) servers.push(name);
  }
  if (version === null && profileTitle !== null) {
    const title = profileTitle.startsWith('base64:')
      ? fromBase64(profileTitle.slice('base64:'.length))
      : profileTitle;
    version = versionIn(title);
  }
  return { version, servers };
}

// ponytail: per-process cache and slot counter; one ingest instance runs, so
// this is the whole fleet. Move to Postgres if the service is ever scaled out.
const cache = new Map<string, { until: number; value: SubscriptionNames | null }>();
let inFlight = 0;
const waiting: (() => void)[] = [];

export function clearSubscriptionCache(): void {
  cache.clear();
}

/** At most MAX_IN_FLIGHT reads of the panel at once: it has been knocked over by our own retries before. */
async function inSlot<T>(fn: () => Promise<T>): Promise<T> {
  while (inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => waiting.push(r));
  inFlight += 1;
  try {
    return await fn();
  } finally {
    inFlight -= 1;
    waiting.shift()?.();
  }
}

export async function readSubscriptionNames(
  link: string,
  opts: { fetchImpl?: typeof fetch; now?: number; timeoutMs?: number } = {},
): Promise<SubscriptionNames | null> {
  const now = opts.now ?? Date.now();
  let url: URL;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/links`;
  const key = url.toString();

  const hit = cache.get(key);
  if (hit && hit.until > now) return hit.value;

  const value = await inSlot(async () => {
    try {
      const res = await (opts.fetchImpl ?? fetch)(key, {
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      return namesFromLinks(await res.text(), res.headers.get('profile-title'));
    } catch {
      return null;
    }
  });
  cache.set(key, { until: now + (value === null ? FAILURE_CACHE_MS : CACHE_MS), value });
  return value;
}
