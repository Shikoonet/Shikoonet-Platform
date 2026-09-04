/**
 * The one link a broadcast can be built from, and what Telegram takes instead.
 *
 * An operator announcing something has a channel post, and Telegram's «copy
 * link» hands them `https://t.me/shikoonet/137`. `forwardMessage` does not take
 * a URL; it takes `from_chat_id` and `message_id`. This turns one into the other
 * and refuses everything else.
 *
 * ## Why it lives in contracts
 *
 * Both ends parse. The page parses so the operator can see what was understood
 * before committing eleven thousand messages to it, and the route parses again
 * because a browser is not a trust boundary. One implementation, because two
 * that agree today is how a link comes to mean two different posts.
 *
 * ## What it refuses, and why that is the interesting half
 *
 * A link accepted wrongly does not fail visibly — it forwards SOME OTHER
 * message to every customer the shop has. So the shape is closed rather than
 * open: a known host, a username of the length Telegram actually issues, and
 * every path segment after it a plain decimal number. `t.me/joinchat/AAAA` and
 * `t.me/+AbCd` fall out of that without needing a list of reserved words to
 * keep up to date.
 */

/** A post Telegram can be asked to forward. */
export interface ChannelPostRef {
  /** `@username` or a `-100…` id — what `from_chat_id` accepts. */
  chat: string;
  messageId: number;
}

/** The hosts Telegram itself hands out links on. */
const HOSTS = new Set(['t.me', 'telegram.me', 'telegram.dog']);

/** Telegram's own rule for a public username. */
const USERNAME = /^[A-Za-z0-9_]{4,32}$/;

/**
 * A ceiling on the message id.
 *
 * Not decoration: `Number('99999999999999')` is a perfectly good number, and a
 * pasted phone number or timestamp would sail through a `> 0` check and be
 * forwarded as whatever message happens to sit there. Telegram issues ids well
 * inside a signed 32-bit range, so anything past it is a typo rather than a post.
 */
const MAX_MESSAGE_ID = 2_147_483_647;

/** `null` for anything this cannot read as a post. Never a guess. */
export function parseChannelPostLink(raw: string): ChannelPostRef | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // `URL` needs a scheme and operators paste `t.me/…` without one. Added rather
  // than hand-splitting, so the host is decided by the same parser a browser
  // uses — `https://t.me.evil.example/…` is a different host and it says so.
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    return null;
  }
  if (!HOSTS.has(url.hostname.toLowerCase())) return null;

  const parts = url.pathname.split('/').filter((p) => p !== '');
  // The web-preview form of the same post.
  if (parts[0] === 's') parts.shift();

  const head = parts.shift();
  if (head === undefined) return null;

  let chat: string;
  if (head === 'c') {
    // A private channel: the link carries the internal id and `-100` is the
    // prefix that turns it back into a chat id.
    const internal = parts.shift();
    if (internal === undefined || !/^[0-9]{5,17}$/.test(internal)) return null;
    chat = `-100${internal}`;
  } else {
    if (!USERNAME.test(head)) return null;
    chat = `@${head}`;
  }

  // Everything left must be a plain number: a forum-topic link carries the
  // topic first and the message last, and anything non-numeric here means the
  // link was never a post — an invite, a sticker set, a proxy.
  if (parts.length === 0 || !parts.every((p) => /^[0-9]+$/.test(p))) return null;

  const messageId = Number(parts[parts.length - 1]);
  if (messageId < 1 || messageId > MAX_MESSAGE_ID) return null;
  return { chat, messageId };
}
