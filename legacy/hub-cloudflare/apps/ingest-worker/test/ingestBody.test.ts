import { describe, expect, it } from 'vitest';
import { normalizeIngestJson } from '../src/ingestBody.js';

describe('normalizeIngestJson', () => {
  it('maps Shortcuts lowercase apikey to apiKey', () => {
    const out = normalizeIngestJson({
      apikey: 'abcdefgh',
      deviceId: 'iphone',
      deviceName: 'iphone',
      message: 'hello',
      sender: 'BANK',
    });
    expect(out?.apiKey).toBe('abcdefgh');
  });
});
