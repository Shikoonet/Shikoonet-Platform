/**
 * Normalize ingest JSON from Apple Shortcuts (often lowercase keys).
 */
export function normalizeIngestJson(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;

  const pick = (...keys: string[]): unknown => {
    for (const k of keys) {
      const v = o[k];
      if (v != null && v !== '') return v;
    }
    return undefined;
  };

  const apiKey = pick('apiKey', 'apikey', 'APIKey');
  const deviceId = pick('deviceId', 'deviceid', 'device_id');
  const deviceName = pick('deviceName', 'devicename', 'device_name');
  const message = pick('message', 'Message', 'content', 'Content', 'body', 'text');
  const sender = pick('sender', 'Sender', 'from', 'From');

  if (
    typeof apiKey !== 'string' ||
    typeof deviceId !== 'string' ||
    typeof deviceName !== 'string' ||
    typeof message !== 'string' ||
    typeof sender !== 'string'
  ) {
    return null;
  }

  const out: Record<string, unknown> = { apiKey, deviceId, deviceName, message, sender };

  const timestamp = pick('timestamp', 'Timestamp', 'time', 'date');
  if (timestamp != null) out.timestamp = timestamp;

  const checksum = pick('checksum', 'Checksum');
  if (checksum != null) out.checksum = checksum;

  return out;
}
