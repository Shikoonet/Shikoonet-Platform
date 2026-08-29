/**
 * Device bookkeeping — split per the spec:
 *
 *   updateDeviceSeen  — every successful auth. Updates last_seen_at; updates
 *                       display_name if deviceName is non-empty AND different.
 *   markIngested      — only after a new transaction candidate has been
 *                       persisted. Updates last_success_at and bumps the
 *                       credential's last_used_at.
 */

import type { D1Database } from '@hub/database';
import { SQL } from '@hub/database';

export async function updateDeviceSeen(
  db: D1Database,
  deviceId: string,
  deviceName?: string,
): Promise<void> {
  const now = Date.now();
  await db.prepare(SQL.touchDeviceSeen).bind(deviceId, now).run();
  if (deviceName && deviceName.trim().length > 0) {
    const wanted = deviceName.trim();
    const current =
      (await db.prepare(`SELECT display_name FROM devices WHERE id = ?1`).bind(deviceId).first<{
        display_name: string | null;
      }>()) ?? null;
    const cur = current?.display_name ?? '';
    if (cur !== wanted) {
      await db
        .prepare(`UPDATE devices SET display_name = ?2, updated_at = ?3 WHERE id = ?1`)
        .bind(deviceId, wanted, now)
        .run();
    }
  }
}

export async function markIngested(
  db: D1Database,
  deviceId: string,
  credentialId: string,
): Promise<void> {
  const now = Date.now();
  await db.prepare(SQL.touchDeviceSuccess).bind(deviceId, now).run();
  await db.prepare(SQL.updateCredentialLastUsed).bind(credentialId, now).run();
}
