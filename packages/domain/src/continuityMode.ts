/**
 * The switch that lets the shop keep selling when the bank SMS stops arriving.
 *
 * ## Why it exists
 *
 * Every delivery in this system is downstream of one fact: a bank credit was
 * matched to a claim. That is the right design and it has one failure mode —
 * when the evidence channel breaks, the shop stops. The SMS relay is one
 * Android phone (`sms-relay`), the parser is one registry of Persian bank
 * formats, and either of them being down means paying customers wait while
 * nothing is wrong with their payment.
 *
 * Continuity mode is the answer to that incident and to nothing else. It is
 * NOT a way to sell faster, and it is not «تایید همه». What it does is narrow:
 * a claim opened while the mode is on is fulfilled without waiting for
 * evidence, and is then **kept in a queue that says the evidence never came**.
 *
 * ## What it deliberately cannot do
 *
 * - It does not touch a claim that already exists. Turning it on fulfils
 *   nothing retroactively; the backlog is worked one row at a time by a human,
 *   through the manual approval that has always been there. A switch that
 *   drains a queue is a switch nobody can predict the cost of pressing.
 * - It does not write `VERIFIED`. A payment nobody has evidence for is spelled
 *   `FULFILLED_UNRECONCILED`, and every revenue query in the app keeps
 *   counting only what the bank confirmed. See `0043`.
 * - It does not stay on. Every activation carries an expiry and the read below
 *   is what enforces it, so the mode returns to NORMAL by itself even if the
 *   process that turned it on never runs again. There is no sweep to forget to
 *   schedule.
 *
 * ## Where the state lives
 *
 * One row of `settings`, which is the shop's existing convention for exactly
 * this: `(scope, key)` is the primary key, so the mode is a singleton without
 * a table, and `updated_by`/`updated_at` are already there. The audit trail is
 * `audit_logs`, which is append-only — this row is the current answer, not the
 * history.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';

type Db = D1Database | D1DatabaseSession;

export const CONTINUITY_SCOPE = 'pay' as const;
export const CONTINUITY_KEY = 'continuity_mode' as const;

/**
 * The longest a shop may run without payment evidence, in one activation.
 *
 * Six hours, and the number is an incident length rather than a business day
 * on purpose: this mode is on because something is broken, and an operator who
 * needs a seventh hour should have to look at the screen again and say so. An
 * activation that outlives the person who made it is how «temporary» becomes
 * the configuration.
 */
export const CONTINUITY_MAX_DURATION_MS = 6 * 60 * 60 * 1000;

/** The floor, so «فعال کن» cannot mean «already expired». */
export const CONTINUITY_MIN_DURATION_MS = 5 * 60 * 1000;

export type OperatingMode = 'NORMAL' | 'CONTINUITY';

export interface ContinuityState {
  mode: OperatingMode;
  /** Set whenever the mode is CONTINUITY; the epoch ms it turns itself off. */
  expiresAt: number | null;
  activatedAt: number | null;
  activatedBy: string | null;
  reason: string | null;
  /**
   * True when the stored row says active and the clock says otherwise.
   *
   * The caller needs this to explain a banner that has just gone away without
   * anybody pressing anything, and the deactivation audit needs it to say
   * `EXPIRED` rather than naming an operator who did nothing.
   */
  expired: boolean;
}

const OFF: ContinuityState = {
  mode: 'NORMAL',
  expiresAt: null,
  activatedAt: null,
  activatedBy: null,
  reason: null,
  expired: false,
};

interface StoredValue {
  active?: boolean;
  expiresAt?: number;
  activatedAt?: number;
  activatedBy?: string | null;
  reason?: string | null;
}

/**
 * The mode right now, with expiry applied at read time.
 *
 * Every caller that can fulfil an order asks this immediately before it acts,
 * so the six-hour cap is enforced by the read rather than by a cron that could
 * be down for the same reason the SMS relay is. A mode that expires only when
 * something else runs is a mode that does not expire.
 */
export async function readContinuityMode(
  db: Db,
  now: number = Date.now(),
): Promise<ContinuityState> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE scope = ?1 AND key = ?2`)
    .bind(CONTINUITY_SCOPE, CONTINUITY_KEY)
    .first<{ value: unknown }>();

  const value = parse(row?.value);
  if (!value?.active) return OFF;

  // An activation with no expiry is a row this code did not write — a hand
  // edit, a restore from an older dump, a future column that lost its default.
  // Read as OFF rather than as "on for ever": the failure this mode can cause
  // is selling without evidence, so the unreadable case has to fall to the
  // side that sells nothing.
  if (typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)) return OFF;

  const base: ContinuityState = {
    mode: 'CONTINUITY',
    expiresAt: value.expiresAt,
    activatedAt: typeof value.activatedAt === 'number' ? value.activatedAt : null,
    activatedBy: value.activatedBy ?? null,
    reason: value.reason ?? null,
    expired: false,
  };

  if (now >= value.expiresAt) return { ...base, mode: 'NORMAL', expired: true };
  return base;
}

function parse(raw: unknown): StoredValue | null {
  if (raw === null || raw === undefined) return null;
  // `jsonb` comes back parsed from the pg driver and as text from anything
  // that stringifies on the way out. Both are handled here rather than at the
  // three call sites.
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as StoredValue;
    } catch {
      return null;
    }
  }
  return typeof raw === 'object' ? (raw as StoredValue) : null;
}

export type ActivateFailure = 'REASON_REQUIRED' | 'DURATION_OUT_OF_RANGE' | 'NOT_CONFIRMED';

/**
 * Turn the mode on until `now + durationMs`.
 *
 * `confirmed` is a required argument and not a default. It is the machine-side
 * half of the warning dialog: a caller that forgot the dialog also forgot this,
 * and the route refuses rather than trusting that the screen asked.
 */
export async function activateContinuityMode(
  db: Db,
  args: {
    actorEmail: string;
    reason: string;
    durationMs: number;
    confirmed: boolean;
    now?: number;
  },
): Promise<{ ok: true; state: ContinuityState } | { ok: false; error: ActivateFailure }> {
  const reason = args.reason.trim();
  if (reason.length < 3) return { ok: false, error: 'REASON_REQUIRED' };
  if (!args.confirmed) return { ok: false, error: 'NOT_CONFIRMED' };
  if (
    !Number.isFinite(args.durationMs) ||
    args.durationMs < CONTINUITY_MIN_DURATION_MS ||
    args.durationMs > CONTINUITY_MAX_DURATION_MS
  ) {
    return { ok: false, error: 'DURATION_OUT_OF_RANGE' };
  }

  const now = args.now ?? Date.now();
  const state: ContinuityState = {
    mode: 'CONTINUITY',
    activatedAt: now,
    activatedBy: args.actorEmail,
    reason,
    expiresAt: now + args.durationMs,
    expired: false,
  };

  await write(db, args.actorEmail, {
    active: true,
    expiresAt: now + args.durationMs,
    activatedAt: now,
    activatedBy: args.actorEmail,
    reason,
  });
  return { ok: true, state };
}

/** Turn it off. Idempotent — turning off an off mode is not an error. */
export async function deactivateContinuityMode(
  db: Db,
  args: { actorEmail: string },
): Promise<ContinuityState> {
  await write(db, args.actorEmail, { active: false });
  return OFF;
}

async function write(db: Db, actorEmail: string, value: StoredValue): Promise<void> {
  await db
    .prepare(
      `INSERT INTO settings (scope, key, value, updated_at, updated_by)
       VALUES (?1, ?2, ?3::jsonb, now(), ?4)
       ON CONFLICT (scope, key) DO UPDATE
         SET value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    )
    .bind(CONTINUITY_SCOPE, CONTINUITY_KEY, JSON.stringify(value), actorEmail)
    .run();
}
