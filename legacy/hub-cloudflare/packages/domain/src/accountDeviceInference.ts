/** Infer primary SMS device for a financial account from recent parsed transactions. */

export interface DeviceObservation {
  deviceId: string;
  bankTimestamp: number;
}

export interface DeviceLookup {
  displayName: string | null;
  deviceCode: string | null;
}

export interface InferredPrimaryDevice {
  primaryDeviceId: string | null;
  primaryDeviceDisplayName: string | null;
  primaryDeviceCode: string | null;
  recentDeviceObservationCount: number;
  primaryDeviceObservationCount: number;
  deviceLastSeenAt: number | null;
  deviceAmbiguous: boolean;
}

export function inferPrimaryDevice(
  observations: DeviceObservation[],
  devices: Map<string, DeviceLookup>,
  limit = 20,
): InferredPrimaryDevice {
  const recent = observations
    .filter((o) => o.deviceId)
    .sort((a, b) => b.bankTimestamp - a.bankTimestamp)
    .slice(0, limit);

  if (recent.length === 0) {
    return {
      primaryDeviceId: null,
      primaryDeviceDisplayName: null,
      primaryDeviceCode: null,
      recentDeviceObservationCount: 0,
      primaryDeviceObservationCount: 0,
      deviceLastSeenAt: null,
      deviceAmbiguous: false,
    };
  }

  const counts = new Map<string, { count: number; latest: number }>();
  for (const o of recent) {
    const cur = counts.get(o.deviceId) ?? { count: 0, latest: 0 };
    cur.count += 1;
    cur.latest = Math.max(cur.latest, o.bankTimestamp);
    counts.set(o.deviceId, cur);
  }

  const ranked = [...counts.entries()].sort((a, b) => {
    if (b[1].count !== a[1].count) return b[1].count - a[1].count;
    return b[1].latest - a[1].latest;
  });

  const top = ranked[0]!;
  const deviceAmbiguous =
    ranked.length > 1 &&
    ranked[1]![1].count === top[1].count &&
    ranked[1]![1].latest === top[1].latest;

  const lookup = devices.get(top[0]);
  const displayName = lookup?.displayName?.trim() || lookup?.deviceCode || null;

  return {
    primaryDeviceId: top[0],
    primaryDeviceDisplayName: displayName,
    primaryDeviceCode: lookup?.deviceCode ?? null,
    recentDeviceObservationCount: recent.length,
    primaryDeviceObservationCount: top[1].count,
    deviceLastSeenAt: top[1].latest,
    deviceAmbiguous,
  };
}
