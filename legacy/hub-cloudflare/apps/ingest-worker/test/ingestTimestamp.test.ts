import { describe, expect, it } from 'vitest';
import { normalizeIngestTimestamp, parseIngestTimestamp } from '../src/ingestTimestamp.js';

describe('parseIngestTimestamp', () => {
  it('accepts Android epoch-ms strings', () => {
    expect(parseIngestTimestamp('1735689600000')).toBe(1735689600000);
  });

  it('accepts iPhone ISO-8601 with Z suffix', () => {
    expect(parseIngestTimestamp('2026-08-07T14:06:45Z')).toBe(Date.parse('2026-08-07T14:06:45Z'));
  });

  it('accepts iPhone ISO-8601 with offset', () => {
    expect(parseIngestTimestamp('2026-08-07T17:06:45+03:00')).toBe(
      Date.parse('2026-08-07T17:06:45+03:00'),
    );
  });

  it('accepts Apple Shortcuts ISO variants', () => {
    expect(parseIngestTimestamp('2026-08-07T17:06:45+0300')).toBe(
      Date.parse('2026-08-07T17:06:45+0300'),
    );
    expect(parseIngestTimestamp('2026-08-07T17:06:45.123Z')).toBe(
      Date.parse('2026-08-07T17:06:45.123Z'),
    );
    expect(parseIngestTimestamp('2026-08-07')).toBe(Date.parse('2026-08-07'));
  });

  it('accepts epoch seconds as number (Shortcuts UNIX time)', () => {
    expect(parseIngestTimestamp(1_735_689_600)).toBe(1_735_689_600_000);
  });

  it('accepts epoch seconds as 10-digit string', () => {
    expect(parseIngestTimestamp('1735689600')).toBe(1_735_689_600_000);
  });

  it('rejects invalid timestamps', () => {
    expect(parseIngestTimestamp('not-a-number')).toBeNull();
    expect(parseIngestTimestamp('2026/08/07 14:06:45')).toBeNull();
  });

  it('normalizes to epoch-ms string', () => {
    expect(normalizeIngestTimestamp('2026-08-07T14:06:45.672Z')).toBe(
      String(Date.parse('2026-08-07T14:06:45.672Z')),
    );
  });
});
