/**
 * Noticing that the shop has been pointed at a different bot.
 *
 * The token is resolved once, at boot, because that is when the poller lock is
 * taken and the lock is keyed on the token (`singleton.ts`). So an operator who
 * connects a new bot from the dashboard cannot be served by re-reading a
 * variable — the old lock has to be released before the new token can take one,
 * and the only thing that does that in the right order is this process ending.
 *
 * Hence: watch, and exit. The caller decides what "exit" means; this file only
 * decides *when*, and its one job is to never fire on a database hiccup.
 *
 * ponytail: a poll, not a `LISTEN`. Thirty seconds is the same window
 * `settings.ts` already makes an admin wait for a switch, one extra query per
 * cycle is nothing beside `getUpdates`, and a notification channel would be a
 * second connection to keep alive for a change that happens once a year. Move
 * to `LISTEN/NOTIFY` if something else ever needs the same wake-up.
 */

import type { D1Database } from '@shikoo/database';
import { createLogger, resolveBotToken, sameSecret } from '@shikoo/domain';

const log = createLogger('bot');

/** Matches the settings cache, so an admin waits the same time for either. */
const EVERY_MS = 30_000;

/**
 * Calls `onChange` once, the first time the resolved token differs from
 * `current`. Returns a function that stops watching.
 *
 * A failed read never fires it. That distinction is the whole file: the danger
 * is not missing a change for thirty seconds, it is a connection reset being
 * read as "the operator disconnected the bot" and taking the shop down. So the
 * only thing that counts is a successful resolution that says something else.
 */
export function watchBotToken(
  db: D1Database,
  envName: string,
  current: string,
  onChange: () => void,
  everyMs = EVERY_MS,
): () => void {
  let fired = false;
  const timer = setInterval(() => {
    void (async () => {
      if (fired) return;
      let next: string | null;
      try {
        const resolved = await resolveBotToken(db, envName);
        // No token at all is NOT a change to act on. It means the row was
        // deleted and this service has no environment fallback — and killing a
        // working bot to run no bot is not an improvement anybody asked for.
        if (resolved === null) return;
        next = resolved.token;
      } catch (err) {
        // Including a row that will not open: the operator's key is wrong or
        // the row was edited, and the running bot is still the right one.
        log.warn('token_watch.read_failed', {}, err);
        return;
      }
      if (sameSecret(next, current)) return;
      fired = true;
      onChange();
    })();
  }, everyMs);
  // So this timer alone can never be the reason the process stays alive.
  timer.unref?.();
  return () => clearInterval(timer);
}
