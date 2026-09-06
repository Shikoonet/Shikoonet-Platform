/**
 * `brand.ts` — whose name the panel wears.
 *
 * Small surface, and every case here is one somebody would actually type into
 * a deploy env file: an empty value meaning «no brand», a name pasted with a
 * newline on the end, a name longer than the header can hold.
 */

import { describe, expect, it } from 'vitest';
import { brandMark, brandName, DEFAULT_BRAND_NAME, MAX_BRAND_NAME } from '../src/brand.js';

describe('brandName', () => {
  it('takes a name as typed', () => {
    expect(brandName('نماینده‌نت')).toBe('نماینده‌نت');
  });

  it('falls back when the variable is not set', () => {
    // Our own installations set nothing, so this is the case that has to keep
    // every existing panel reading exactly as it does today.
    expect(brandName(undefined)).toBe(DEFAULT_BRAND_NAME);
    expect(brandName(null)).toBe(DEFAULT_BRAND_NAME);
  });

  it('falls back on an empty or whitespace value', () => {
    // `BRAND_NAME=` in an env file is «I set it and meant nothing by it», and a
    // panel with no name in the header looks broken rather than unbranded.
    expect(brandName('')).toBe(DEFAULT_BRAND_NAME);
    expect(brandName('   ')).toBe(DEFAULT_BRAND_NAME);
  });

  it('flattens a name that was pasted with a line break in it', () => {
    // The realistic malformed value: copied out of a document, or a shell
    // variable that kept its trailing newline. Two lines in the sidebar breaks
    // the layout, and `.trim()` alone would not touch one in the middle.
    expect(brandName('وی‌پی‌ان\nپلاس\n')).toBe('وی‌پی‌ان پلاس');
  });

  it('drops control characters rather than drawing them as nothing', () => {
    expect(brandName('a\u0000b\u001fc\u007fd')).toBe('a b c d');
  });

  it('cuts a name that is longer than the header can hold', () => {
    const long = 'ن'.repeat(MAX_BRAND_NAME + 20);
    expect(brandName(long)).toHaveLength(MAX_BRAND_NAME);
  });

  it('refuses a value that is not a string at all', () => {
    // It arrives over the wire as JSON, so a number or an object is a shape the
    // page could genuinely be handed.
    expect(brandName(42 as unknown as string)).toBe(DEFAULT_BRAND_NAME);
  });
});

describe('brandMark', () => {
  it('is the first letter of the name', () => {
    expect(brandMark('شیکو')).toBe('ش');
    expect(brandMark('Acme')).toBe('A');
  });

  it('takes a whole emoji rather than half of one', () => {
    // `'🌐'[0]` is a lone surrogate and draws as a replacement box. Derived with
    // `Array.from` for exactly this.
    expect(brandMark('🌐 نت')).toBe('🌐');
  });

  it('never returns an empty square', () => {
    expect(brandMark('')).toBe(DEFAULT_BRAND_NAME[0]);
  });
});
