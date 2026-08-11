import { describe, expect, it } from 'vitest';
import { inferPrimaryDevice } from '../src/accountDeviceInference.js';

describe('inferPrimaryDevice', () => {
  it('picks most frequent device with latest tie-break', () => {
    const devices = new Map([
      ['d1', { displayName: 'Phone A', deviceCode: 'a-01' }],
      ['d2', { displayName: 'Phone B', deviceCode: 'b-01' }],
    ]);
    const result = inferPrimaryDevice(
      [
        { deviceId: 'd1', bankTimestamp: 100 },
        { deviceId: 'd2', bankTimestamp: 300 },
        { deviceId: 'd1', bankTimestamp: 200 },
        { deviceId: 'd1', bankTimestamp: 150 },
      ],
      devices,
    );
    expect(result.primaryDeviceId).toBe('d1');
    expect(result.primaryDeviceDisplayName).toBe('Phone A');
    expect(result.primaryDeviceObservationCount).toBe(3);
    expect(result.recentDeviceObservationCount).toBe(4);
  });

  it('marks ambiguous when top devices tie on count and latest', () => {
    const devices = new Map([
      ['d1', { displayName: 'A', deviceCode: 'a' }],
      ['d2', { displayName: 'B', deviceCode: 'b' }],
    ]);
    const result = inferPrimaryDevice(
      [
        { deviceId: 'd1', bankTimestamp: 100 },
        { deviceId: 'd2', bankTimestamp: 100 },
      ],
      devices,
    );
    expect(result.deviceAmbiguous).toBe(true);
  });
});
