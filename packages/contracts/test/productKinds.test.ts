import { describe, expect, it } from 'vitest';
import { PRODUCT_KINDS, PRODUCT_KIND_FIELDS, configName, fieldsNotForKind } from '../src/index.js';

describe('which config fields a kind has', () => {
  it('names a field only for the kinds that have it, and every kind has a duration', () => {
    for (const kind of PRODUCT_KINDS) expect(PRODUCT_KIND_FIELDS[kind]).toContain('durationDays');
    expect(PRODUCT_KIND_FIELDS.spotify).not.toContain('volumeGb');
    expect(PRODUCT_KIND_FIELDS.ai_account).toEqual(['durationDays']);
  });

  it('refuses a field that is present and set, and nothing that is absent or cleared', () => {
    expect(fieldsNotForKind('spotify', { volumeGb: 50 })).toEqual(['volumeGb']);
    expect(fieldsNotForKind('spotify', { priceIrr: 1 } as never)).toEqual([]);
    // Clearing a field the kind lost is how a legacy row gets tidied.
    expect(fieldsNotForKind('spotify', { volumeGb: null })).toEqual([]);
    expect(fieldsNotForKind('ai_account', { volumeGb: 1, userLimit: 2 })).toEqual([
      'volumeGb',
      'userLimit',
    ]);
    expect(fieldsNotForKind('vpn', { volumeGb: 1, userLimit: 2, durationDays: 3 })).toEqual([]);
    // Not this function's job: the CHECK constraint refuses the kind itself.
    expect(fieldsNotForKind('robot', { volumeGb: 1 })).toEqual([]);
  });
});

describe('the suggested name follows the kind', () => {
  const shape = { durationDays: 30, volumeGb: null, userLimit: 1 };
  it('says nothing about volume for a kind that has none', () => {
    expect(configName(shape, 'spotify')).toBe('۱ ماهه - تک کاربر');
    expect(configName(shape, 'ai_account')).toBe('۱ ماهه');
    // The default is the VPN shape, which is what every caller before today got.
    expect(configName(shape)).toBe('۱ ماهه - نامحدود - تک کاربر');
  });
});
