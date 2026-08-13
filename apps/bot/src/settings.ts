/**
 * The admin's settings, read from the table the migration filled.
 *
 * Until now nothing read `settings` — it existed so the migration had somewhere
 * to put 51 columns of a single-row MySQL table, and `docs/STATUS.md` said so
 * plainly. This is the first reader, and it exists because the alternative is
 * hard-coding the admin's own support handle into our source.
 *
 * Values are stored as JSON, and what MySQL handed over was text — so `10` is
 * the string `"10"` and a missing setting is the JSON `null`. Both are handled
 * here rather than at every call site.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';

type Db = D1Database | D1DatabaseSession;

export type SettingScope = 'bot' | 'shop' | 'pay' | 'panel';

/** The raw value, or null when the row is missing or holds JSON null. */
async function read(db: Db, scope: SettingScope, key: string): Promise<unknown> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE scope = ?1 AND key = ?2`)
    .bind(scope, key)
    .first<{ value: unknown }>();
  return row?.value ?? null;
}

/**
 * A setting as text, or null.
 *
 * An empty string is null too: the legacy row uses `''` for "not set" in
 * several places, and a support handle of `''` would render as `@`.
 */
export async function settingText(
  db: Db,
  scope: SettingScope,
  key: string,
): Promise<string | null> {
  const value = await read(db, scope, key);
  if (value === null || value === undefined) return null;
  const text = typeof value === 'string' ? value : String(value);
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * A setting as a number, or null when it is missing or not a number.
 *
 * Never throws and never guesses: a percentage that cannot be read is not a
 * percentage of zero, it is a percentage that must not be applied.
 */
export async function settingNumber(
  db: Db,
  scope: SettingScope,
  key: string,
): Promise<number | null> {
  const text = await settingText(db, scope, key);
  if (text === null) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/** Whether a switch-shaped setting holds exactly the value that means "on". */
export async function settingIs(
  db: Db,
  scope: SettingScope,
  key: string,
  on: string,
): Promise<boolean> {
  return (await settingText(db, scope, key)) === on;
}
