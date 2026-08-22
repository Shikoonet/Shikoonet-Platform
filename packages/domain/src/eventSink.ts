/**
 * The sink that makes a log line durable, and the prune that stops it growing
 * for ever.
 *
 * One implementation, registered by all three services in their `server.ts`.
 * The logger itself knows nothing about Postgres — it hands a record to
 * whatever was registered and moves on — which is what keeps `log.ts` usable
 * in a test, in a script, and in a process whose database is the thing that
 * broke.
 *
 * ## Everything here is best-effort, on purpose
 *
 * The record was already written to stdout before this runs. If the insert
 * fails, the line still exists in `docker logs`; if this were awaited or
 * allowed to throw, a database outage would turn every `log.error` in the
 * outage-handling path into a second error. So: not awaited, never rethrown.
 */

import type { D1Database } from '@shikoo/database';
import { alert, ALERTING_EVENTS } from './alert.js';
import type { EventSink, LogRecord } from './log.js';

export interface EventSinkOptions {
  /**
   * Where alerts go. Unset means no Telegram alerting — the rows are still
   * written, and that is the correct behaviour for a box with no admin
   * channel, which is every developer machine.
   */
  alertChatId?: number | null;
}

/** How long a row lives. Long enough to investigate last month, short enough to stay small. */
export const EVENT_RETENTION_DAYS = 30;

/**
 * `ALERT_CHAT_ID` as a number, or null.
 *
 * A channel id is negative and can be larger than a port, so it is parsed
 * rather than run through the services' `positiveInt`. Unparseable is treated
 * as unset — the alternative is a service that refuses to boot because of a
 * typo in an optional setting, which is a worse outage than no alerts.
 */
export function parseAlertChatId(raw: string | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export function createPostgresEventSink(db: D1Database, options: EventSinkOptions = {}): EventSink {
  const alertChatId = options.alertChatId ?? null;

  return (record: LogRecord): void => {
    void (async () => {
      await db
        .prepare(
          `INSERT INTO app_events (at, level, svc, evt, trace, ref, fields, err)
           VALUES (?1::timestamptz, ?2, ?3, ?4, ?5, ?6, ?7::jsonb, ?8)`,
        )
        .bind(
          record.ts,
          record.level,
          record.svc,
          record.evt,
          record.trace ?? null,
          record.ref ?? null,
          JSON.stringify(record.fields),
          record.err ? JSON.stringify(record.err) : null,
        )
        .run();
    })().catch((err: unknown) => {
      // Not through the logger. A sink failure reported by the logger would
      // reach the sink again, and a database that is down would recurse until
      // the stack ran out — during an incident, in the process that is
      // supposed to be describing it.
      console.error('[log] app_events insert failed', err);
    });

    if (alertChatId !== null && ALERTING_EVENTS.has(record.evt)) {
      void alert(db, alertChatId, record).catch((err: unknown) => {
        console.error('[log] alert enqueue failed', record.evt, err);
      });
    }
  };
}

/**
 * Drop events older than the retention window.
 *
 * Called from the bot's existing prune cycle rather than from a new timer:
 * there is already a place in `poll.ts` that runs housekeeping every couple of
 * hundred cycles, and a second scheduler would be a second thing to notice has
 * stopped.
 */
export async function pruneAppEvents(
  db: D1Database,
  days: number = EVENT_RETENTION_DAYS,
): Promise<number> {
  const done = await db
    .prepare(`DELETE FROM app_events WHERE at < now() - make_interval(days => ?1)`)
    .bind(days)
    .run();
  return done.meta.changes ?? 0;
}
