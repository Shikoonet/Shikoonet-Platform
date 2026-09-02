/**
 * Device bookkeeping — split per the spec:
 *
 *   updateDeviceSeen  — every successful auth. Updates last_seen_at.
 *   markIngested      — only after a new transaction candidate has been
 *                       persisted. Updates last_success_at and bumps the
 *                       credential's last_used_at.
 *
 * ## Why `deviceName` is read and thrown away
 *
 * Until the dashboard grew a rename action, this function also wrote
 * `devices.display_name` from the `deviceName` field of the incoming SMS body,
 * "if non-empty AND different". That made the phone the last writer of the
 * name: the Android app is configured with a JSON blob this platform generated
 * at device-creation time, and it re-asserts that blob on every message.
 *
 * So an operator who renamed a device in the panel would watch the old name
 * come back the next time that phone relayed a bank SMS — a change that
 * appeared to save, and silently reverted minutes later with nothing in the
 * audit log to explain it. Two writers, no owner.
 *
 * The panel is the owner now. `deviceName` stays in the request contract
 * because the Android app's payload is frozen (`POST /api/v1/sms` is not ours
 * to change), and it is used for nothing: authentication is `device_code` plus
 * the key hash, and neither ever touched the name.
 */

import type { D1Database } from '@shikoo/database';
import { SQL } from '@shikoo/database';

export async function updateDeviceSeen(db: D1Database, deviceId: string): Promise<void> {
  await db.prepare(SQL.touchDeviceSeen).bind(deviceId, Date.now()).run();
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
