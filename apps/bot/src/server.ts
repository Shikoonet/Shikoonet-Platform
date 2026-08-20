/**
 * Node entry point. Reads config, opens one pool, polls until told to stop.
 *
 * Same boot discipline as the ingest worker: a missing setting fails here,
 * loudly, rather than producing odd behaviour at 3am.
 */

import { createPostgresD1 } from '@shikoo/db';
import { beat } from './heartbeat.js';
import { run } from './poll.js';
import { acquirePollerLock } from './singleton.js';
import { createTelegramApi, TELEGRAM_API_BASE } from './telegram.js';
import { disableCustomEmoji, setReportChatIdFallback } from './settings.js';

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is required`);
  }
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got ${JSON.stringify(raw)}`);
  }
  return n;
}

export async function start(): Promise<{ stop: () => Promise<void> }> {
  const { db, pool } = createPostgresD1({ connectionString: required('DATABASE_URL') });
  const token = required('TELEGRAM_BOT_TOKEN');

  // Before a single `getUpdates`. Telegram allows one poller per token and
  // Coolify starts the new container before stopping the old, so every deploy
  // has a window with two — which is 409s in the log and, worse, updates split
  // between a live process and one that is about to be killed. See
  // `singleton.ts`. This waits rather than exits: the window closes by itself
  // in seconds, and a process that gave up would leave the shop with no bot
  // while the deploy reported success.
  const lock = await acquirePollerLock(
    pool,
    token,
    () => {
      console.log('[bot] another poller holds this token — waiting for it to exit');
      // ponytail: one beat, not a keep-alive. A wait longer than the health
      // check's window marks this container unhealthy, and that is roughly
      // right — if the old poller has not exited in ninety seconds it is stuck,
      // and killing the new one changes nothing. Give the wait its own timer
      // only if a deploy is ever seen to flap here.
      beat();
    },
    (err) => {
      // The lock is gone the instant that connection is, so continuing would
      // mean polling without it — and a second poller could then start beside
      // us. Exiting is the only honest response; the container comes back and
      // takes the lock again.
      console.error('[bot] lost the poller lock connection — exiting', err);
      process.exit(1);
    },
  );

  const api = createTelegramApi({
    // Never logged, never echoed back — see telegram.ts.
    token,
    baseUrl: process.env.TELEGRAM_API_BASE ?? TELEGRAM_API_BASE,
    // There is no API that says whether the bot's owner has Telegram Premium,
    // so the bot learns it by being refused once and then stops asking.
    onCustomEmojiRefused: () => disableCustomEmoji(db),
  });

  // The bot's own username, learned rather than configured, so the referral
  // links it hands out cannot point at a different bot. A failure here is not
  // fatal: everything except that one screen works without it.
  void api
    .getMe()
    .then(async ({ username }) => {
      if (username === null) return;
      await db
        .prepare(
          `INSERT INTO settings (scope, key, value, updated_at, updated_by)
           VALUES ('bot', 'username', to_jsonb(?1::text), now(), 'bot')
           ON CONFLICT (scope, key) DO UPDATE
             SET value = EXCLUDED.value, updated_at = now(), updated_by = 'bot'`,
        )
        .bind(username)
        .run();
    })
    .catch((err: unknown) => {
      console.error('[bot] could not read our own username', err);
    });

  const controller = new AbortController();
  // One beat before the loop, so a container that has just acquired the lock is
  // healthy from its first second rather than during its first cycle.
  beat();
  // A channel id is negative and can be large, so it is parsed rather than run
  // through `positiveInt`. This is only a FALLBACK: the shop's own
  // `setting.Channel_Report` wins wherever it is set, and this covers a
  // database whose settings have never been migrated. Unset and unmigrated
  // means no report of any kind.
  //
  // Handed to `settings.ts` rather than to the poll loop, so the nightly report
  // and the flood-block report resolve the same value. As a poll option it
  // reached only the first of the two.
  const raw = process.env['REPORT_CHAT_ID'];
  const reportChatId = raw && Number.isSafeInteger(Number(raw)) ? Number(raw) : null;
  if (raw && reportChatId === null) {
    console.error(`[bot] REPORT_CHAT_ID=${raw} is not a number — no report will be sent`);
  }
  setReportChatIdFallback(reportChatId);

  const finished = run(db, api, {
    timeoutSec: positiveInt('TELEGRAM_POLL_TIMEOUT_SEC', 25),
    signal: controller.signal,
    onCycle: beat,
  });

  console.log('bot polling');

  return {
    async stop() {
      controller.abort();
      await finished;
      // Released before the pool closes, so the next container can start
      // polling immediately rather than waiting for this connection to time
      // out. `pool.end()` would release it anyway — this only makes the
      // handover fast, and a crash still releases it because Postgres drops
      // the lock with the connection.
      await lock.release();
      await pool.end();
    },
  };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  const started = start();
  const stop = async (): Promise<void> => {
    const s = await started;
    await s.stop();
  };
  started.catch((err: unknown) => {
    console.error('[bot] failed to start', err);
    process.exit(1);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      // A shutdown that throws must still exit. Hanging here is how a process
      // survives its own SIGTERM and then holds the bot token against the next
      // one, which Telegram answers with 409 to both.
      void stop()
        .catch((err: unknown) => {
          console.error('[bot] shutdown failed', err);
        })
        .finally(() => process.exit(0));
    });
  }
}
