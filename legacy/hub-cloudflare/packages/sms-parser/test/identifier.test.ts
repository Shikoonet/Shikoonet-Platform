import { describe, it, expect } from 'vitest';
import { normalizeIdentifier, maskIdentifier } from '../src/identifier.js';

describe('normalizeIdentifier', () => {
  it('keeps ASCII digits as-is', () => {
    const r = normalizeIdentifier('300422286226');
    expect(r.normalizedValue).toBe('300422286226');
    expect(r.digitsOnlyValue).toBe('300422286226');
    expect(r.lastFour).toBe('6226');
    expect(r.displayValueMasked).toBe('********6226');
  });

  it('converts Persian digits to ASCII', () => {
    const r = normalizeIdentifier('۳۰۰۴۲۲۲۸۶۲۲۶');
    expect(r.normalizedValue).toBe('300422286226');
    expect(r.digitsOnlyValue).toBe('300422286226');
    expect(r.lastFour).toBe('6226');
  });

  it('converts Arabic-Indic digits to ASCII', () => {
    const r = normalizeIdentifier('٣٠٠٤٢٢٢٨٦٢٢٦');
    expect(r.normalizedValue).toBe('300422286226');
    expect(r.digitsOnlyValue).toBe('300422286226');
  });

  it('strips bidi and zero-width controls', () => {
    const r = normalizeIdentifier('‪300422286226‬');
    expect(r.normalizedValue).toBe('300422286226');
  });

  it('strips U+FEFF, U+200E, U+200F, U+202A-U+202E, U+2066-U+2069', () => {
    const all = ['﻿', '‎', '‏', '‪', '‫', '‬', '‭', '‮', '⁦', '⁧', '⁨', '⁩'];
    for (const ch of all) {
      const r = normalizeIdentifier(`${ch}110.9992.2377306.1${ch}`);
      expect(r.normalizedValue).toBe('110.9992.2377306.1');
    }
  });

  it('preserves embedded dots in dotted account identifiers', () => {
    const r = normalizeIdentifier('110.9992.2377306.1');
    expect(r.normalizedValue).toBe('110.9992.2377306.1');
    expect(r.digitsOnlyValue).toBe('110999223773061');
    expect(r.lastFour).toBe('3061');
  });

  it('removes ASCII/Arabic/Persian commas and spaces', () => {
    const r = normalizeIdentifier('1,950,000');
    expect(r.normalizedValue).toBe('1950000');
    expect(r.digitsOnlyValue).toBe('1950000');
  });

  it('handles mixed Persian digits + dashes (card-on-file)', () => {
    // Dashes are preserved in normalizedValue (separator visible) but stripped
    // from digitsOnlyValue so callers can match a card number regardless of
    // the dash layout.
    const r = normalizeIdentifier('۱۲۳۴-۵۶۷۸-۹۰۱۲-۳۴۵۶');
    expect(r.normalizedValue).toBe('1234-5678-9012-3456');
    expect(r.digitsOnlyValue).toBe('1234567890123456');
    expect(r.lastFour).toBe('3456');
  });
  it('returns empty for null/undefined', () => {
    expect(normalizeIdentifier(null).normalizedValue).toBe('');
    expect(normalizeIdentifier(undefined).normalizedValue).toBe('');
    expect(normalizeIdentifier('').normalizedValue).toBe('');
  });

  it('maskIdentifier preserves dots and reveals the last 4 digits', () => {
    // Input: 110.9992.2377306.1 (15 digits, 3 dots).
    // Last 4 digits: 3, 0, 6, 1. The dot between 6 and 1 is preserved so
    // the visible chunk reads "306.1" in its original position.
    expect(maskIdentifier('110.9992.2377306.1')).toBe('***.****.****306.1');
    expect(maskIdentifier('300422286226')).toBe('********6226');
  });

  it('maskIdentifier masks short values entirely', () => {
    expect(maskIdentifier('1234')).toBe('****');
    expect(maskIdentifier('12')).toBe('**');
  });
});
