/**
 * One structured line per event, and the registry that lets those lines
 * outlive the container.
 *
 * ## Why this exists at all
 *
 * Two bugs paid for it. On 2026-08-15 `AUTO_MATCH_ENABLED` was off for an
 * afternoon and nothing said so; on 2026-08-18 `AUTO_FULFILLMENT_ENABLED` let
 * a customer pay and receive nothing, and both sides were silent. Neither was
 * findable afterwards, because the only record was `console.error('[bot] poll
 * cycle failed', err)` — no level, no identifier, nothing to group by — and
 * the only place it went was `docker logs`, which Coolify throws away with the
 * container on every deploy.
 *
 * ## Why sixty lines and no dependency
 *
 * pino and winston both do more than this, and neither leaves redaction where
 * it has to be: ours, readable, and in the same file as the thing it protects.
 * `JSON.stringify` on stdout is the whole transport, and it keeps every later
 * option open at zero code change — Grafana straight onto Postgres, Loki via
 * Alloy, a thirty-line `/metrics` — which is why the answer to «send the logs
 * to Prometheus» was «structured logs first».
 *
 * ## Two rules that are not negotiable
 *
 * **This never throws.** A logger that can fail is a second failure mode
 * sitting in the path of the first one. Every branch below is wrapped, and the
 * worst case is one line saying the logger itself broke.
 *
 * **A denied key never reaches the output.** Redaction is on the key name,
 * recursive, and applied before anything is serialised — not inside a
 * formatter, where the next call site would walk straight past it.
 */

/** Levels, in the order they escalate. `debug` is deliberately absent. */
export type LogLevel = 'info' | 'warn' | 'error';

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  cause?: SerializedError;
}

/** One line. This shape is also the shape of a row in `app_events`. */
export interface LogRecord {
  ts: string;
  level: LogLevel;
  svc: string;
  /**
   * A fixed dotted name (`settle.paid`, `ingest.sms.rejected`), never a
   * sentence. This is the thing you group by at 3am, so it has to be the same
   * string every time it happens.
   */
  evt: string;
  /** Correlation id — `u<update_id>` in the bot, a request id in the workers. */
  trace?: string;
  /** The one identifier this event is about: an order, a claim, a device. */
  ref?: string;
  fields: Record<string, unknown>;
  err?: SerializedError;
}

/**
 * Key names whose value is never written anywhere, matched as a substring of
 * the normalised key. A substring rather than an exact name because the same
 * secret arrives as `token`, `botToken`, `bot_token` and `access-token`, and a
 * list of exact spellings is a list someone forgets to extend.
 *
 * False positives are the intended direction of error: `country_code` being
 * redacted costs nothing, while an OTP reaching a log costs the rule in
 * CLAUDE.md that says OTPs are never stored, rendered or logged.
 */
const DENY = [
  'token',
  'secret',
  'password',
  'hmac',
  'apikey',
  'otp',
  'code',
  'authorization',
  'cookie',
  'body',
  'sms',
  // Half a panel credential. `GET /panels/:id/credential-username` is the one
  // route that hands it back, deliberately and to an ADMIN only; nothing is
  // meant to log it, and this is what makes that true rather than intended.
  // Matched as a substring, so `panelUsername`, `panel_username` and
  // `credentialUsername` are all covered.
  'username',
] as const;

const REDACTED = '[redacted]';

/** How deep redaction walks before it stops describing and starts summarising. */
const MAX_DEPTH = 6;

function isDenied(key: string): boolean {
  const norm = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return DENY.some((d) => norm.includes(d));
}

/**
 * Copies a value with every denied key replaced.
 *
 * `seen` is not an optimisation. A Postgres driver error holds a reference
 * back to its own client, and without this the first driver failure would spin
 * forever inside the logger — the one place that must not fail.
 */
function redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (depth >= MAX_DEPTH) return '[deep]';
  if (seen.has(value as object)) return '[circular]';
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = isDenied(k) ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}

/** The stack is kept, but bounded — the top of it is the part anyone reads. */
const MAX_STACK = 2000;

export function serializeError(err: unknown, depth = 0): SerializedError {
  if (!(err instanceof Error)) {
    return { name: 'NonError', message: String(err) };
  }
  const out: SerializedError = {
    name: err.name,
    // Driver errors from `packages/db` carry the failing statement in the
    // message on purpose. The parameters are not in it — they travel
    // separately and go through the same deny-list as any other field.
    message: err.message,
  };
  if (typeof err.stack === 'string') out.stack = err.stack.slice(0, MAX_STACK);
  if (err.cause !== undefined && depth < 2) out.cause = serializeError(err.cause, depth + 1);
  return out;
}

/**
 * Where a record goes to become durable. Registered once per service in its
 * `server.ts`, after the pool is open.
 *
 * Fire-and-forget by contract: it takes a record, returns nothing, and owns
 * its own failures. The logger will not await it and will not learn whether it
 * worked — if the sink could push an error back, a broken database would
 * become a broken logger at the exact moment the log is the only witness left.
 */
export type EventSink = (record: LogRecord) => void;

let sink: EventSink | null = null;

export function setEventSink(next: EventSink | null): void {
  sink = next;
}

/**
 * `info` events that are still worth a row.
 *
 * Everything at `warn` and `error` is persisted; `info` is stdout only,
 * because the volume there is the poll loop. These few are the exceptions —
 * the points where money changed hands, which is the history you want even on
 * the days nothing went wrong.
 */
export const PERSISTED_INFO_EVENTS: ReadonlySet<string> = new Set([
  'settle.paid',
  'provision.delivered',
  'wallet.credited',
  'match.auto_verified',
]);

function writeLine(record: LogRecord): void {
  const line = JSON.stringify(record);
  // stdout for every level. Splitting errors onto stderr reads well in a
  // terminal and badly everywhere else: a collector then has two streams to
  // interleave, and the ordering between them is not guaranteed.
  if (typeof process !== 'undefined' && typeof process.stdout?.write === 'function') {
    process.stdout.write(`${line}\n`);
  } else {
    console.log(line);
  }
}

export interface Logger {
  info(evt: string, fields?: Record<string, unknown>, err?: unknown): void;
  warn(evt: string, fields?: Record<string, unknown>, err?: unknown): void;
  error(evt: string, fields?: Record<string, unknown>, err?: unknown): void;
  /** A child carrying a correlation id — one per Telegram update, one per request. */
  with(bound: { trace?: string; ref?: string }): Logger;
}

function emit(
  svc: string,
  bound: { trace?: string; ref?: string },
  level: LogLevel,
  evt: string,
  fields?: Record<string, unknown>,
  err?: unknown,
): void {
  try {
    const { trace, ref, ...rest } = fields ?? {};
    const record: LogRecord = {
      // Through `Date.now()` rather than `new Date()` so a test can pin the
      // clock the way rule 5 requires, and so every timestamp in a process
      // comes from one source.
      ts: new Date(Date.now()).toISOString(),
      level,
      svc,
      evt,
      fields: redact(rest, 0, new WeakSet()) as Record<string, unknown>,
    };
    const t = trace ?? bound.trace;
    const r = ref ?? bound.ref;
    if (t !== undefined && t !== null) record.trace = String(t);
    if (r !== undefined && r !== null) record.ref = String(r);
    if (err !== undefined) record.err = serializeError(err);

    writeLine(record);

    if (sink !== null && (level !== 'info' || PERSISTED_INFO_EVENTS.has(evt))) {
      sink(record);
    }
  } catch (loggerFailure) {
    // Deliberately the only place in this file that gives up on structure. If
    // `JSON.stringify` was what threw, printing more JSON is not the answer.
    try {
      console.error('[log] logger failed', evt, loggerFailure);
    } catch {
      /* nothing left to try */
    }
  }
}

export function createLogger(svc: string, bound: { trace?: string; ref?: string } = {}): Logger {
  return {
    info: (evt, fields, err) => emit(svc, bound, 'info', evt, fields, err),
    warn: (evt, fields, err) => emit(svc, bound, 'warn', evt, fields, err),
    error: (evt, fields, err) => emit(svc, bound, 'error', evt, fields, err),
    with: (next) => createLogger(svc, { ...bound, ...next }),
  };
}
