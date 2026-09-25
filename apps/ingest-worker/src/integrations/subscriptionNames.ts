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

/**
 * «🔄 V3.7.8.1», «V 3.8» at the START of a config name — a dotted number, so a
 * server called «Germany V2» or «Germany v2.1 Fast» is not one (spec §6).
 */
const VERSION_NAME = /^\W*(V\s?\d+(?:\.\d+){1,3})\b/i;
/** Anywhere in the profile-title header, which usually carries the brand first. */
const VERSION_TITLE = /\bV\s?\d+(?:\.\d+){1,3}\b/i;
/** A config link starts with its scheme; an HTML page's URLs sit inside tags. */
const LINK = /^[a-z][a-z0-9+.-]*:\/\//i;
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

function versionOfName(name: string): string | null {
  const m = VERSION_NAME.exec(name);
  return m ? m[1]!.replace(/\s/g, '') : null;
}

function versionInTitle(title: string): string | null {
  const m = VERSION_TITLE.exec(title);
  return m ? m[0].replace(/\s/g, '') : null;
}

function linkLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => LINK.test(l));
}

/**
 * Null when the body holds no links — a login or error page is not a server
 * list, even when its tags carry URLs (final review, 2026-09-26: such a page
 * became «servers» that included the panel's own address).
 */
export function namesFromLinks(body: string, profileTitle: string | null): SubscriptionNames | null {
  const trimmed = body.trim();
  const plain = linkLines(trimmed);
  const lines = plain.length > 0 ? plain : linkLines(fromBase64(trimmed));
  if (lines.length === 0) return null;

  let version: string | null = null;
  const servers: string[] = [];
  for (const name of lines.map(nameOf)) {
    if (name === '') continue;
    const v: string | null = version === null ? versionOfName(name) : null;
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
    version = versionInTitle(title);
  }
  return { version, servers };
}

// ponytail: per-process cache and slot counter; one ingest instance runs, so
// this is the whole fleet. Move to Postgres if the service is ever scaled out.
const cache = new Map<string, { until: number; value: SubscriptionNames | null }>();
let inFlight = 0;
const waiting: (() => void)[] = [];

const pending = new Map<string, Promise<SubscriptionNames | null>>();

export function clearSubscriptionCache(): void {
  cache.clear();
  pending.clear();
}

/** A server list is a few kilobytes; a body past this is not one. */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * The body as text, or null past MAX_BODY_BYTES — read as a stream and
 * stopped there, since the timeout bounds how long, not how much (CodeRabbit,
 * 2026-09-26).
 */
async function textUpTo(res: Response, max: number): Promise<string | null> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(chunks).toString('utf8');
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
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
  // Callers asking for the same link while it is being read share that read,
  // rather than queueing duplicates behind each other on a slow panel.
  const already = pending.get(key);
  if (already) return already;

  const read = inSlot(async () => {
    try {
      const res = await (opts.fetchImpl ?? fetch)(key, {
        signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      if (!res.ok) return null;
      const body = await textUpTo(res, MAX_BODY_BYTES);
      return body === null ? null : namesFromLinks(body, res.headers.get('profile-title'));
    } catch {
      return null;
    }
  }).then((value) => {
    cache.set(key, { until: now + (value === null ? FAILURE_CACHE_MS : CACHE_MS), value });
    pending.delete(key);
    return value;
  });
  pending.set(key, read);
  return read;
}
