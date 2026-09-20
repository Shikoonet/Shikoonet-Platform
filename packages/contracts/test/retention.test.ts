/**
 * The rule's shape, refused whole when any part is wrong — the bot reads
 * with the same function the panel refuses with, so a list this accepts is
 * a list the bot acts on exactly.
 */

import { describe, expect, it } from 'vitest';
import {
  RETENTION_LIMITS,
  parseRetentionRules,
  renderRetentionText,
  retentionDedupeKey,
} from '../src/retention.js';

const good = {
  key: 'r_abc123',
  name: 'خرید اولی‌ها',
  enabled: true,
  providerId: 7,
  daysBefore: 1,
  daysAfter: 0,
  onlyService: true,
  codeId: null,
  text: 'سلام {code}',
};

describe('parseRetentionRules', () => {
  it('accepts a good list and trims the name', () => {
    const out = parseRetentionRules([{ ...good, name: '  x  ', codeId: 3 }]);
    expect(out).toEqual([{ ...good, name: 'x', codeId: 3 }]);
  });

  it('is null on anything that is not a list', () => {
    expect(parseRetentionRules(null)).toBeNull();
    expect(parseRetentionRules({})).toBeNull();
    expect(parseRetentionRules('[]')).toBeNull();
  });

  it.each([
    ['bad key', { key: 'Has Space' }],
    ['duplicate key', null],
    ['empty name', { name: '  ' }],
    ['long name', { name: 'x'.repeat(RETENTION_LIMITS.name + 1) }],
    ['missing enabled', { enabled: undefined }],
    ['provider 0', { providerId: 0 }],
    ['fractional days', { daysBefore: 1.5 }],
    ['days before too big', { daysBefore: RETENTION_LIMITS.daysBefore + 1 }],
    ['days after too big', { daysAfter: RETENTION_LIMITS.daysAfter + 1 }],
    ['window of nothing', { daysBefore: 0, daysAfter: 0 }],
    ['code as string', { codeId: '3' }],
    ['empty text', { text: '' }],
    ['long text', { text: 'x'.repeat(RETENTION_LIMITS.text + 1) }],
  ])('refuses %s', (_name, change) => {
    const list = change === null ? [good, { ...good }] : [{ ...good, ...change }];
    expect(parseRetentionRules(list)).toBeNull();
  });

  it('refuses more than the ceiling', () => {
    const list = Array.from({ length: RETENTION_LIMITS.rules + 1 }, (_, i) => ({ ...good, key: `k${i}` }));
    expect(parseRetentionRules(list)).toBeNull();
    expect(parseRetentionRules(list.slice(1))).toHaveLength(RETENTION_LIMITS.rules);
  });
});

describe('renderRetentionText', () => {
  it('fills known slots and leaves unknown ones', () => {
    const out = renderRetentionText('{days}/{service}/{username}/{code}/{renewButton}/{x}', {
      days: '2',
      service: 'S',
      username: 'u',
      code: 'C',
      renewButton: 'R',
    });
    expect(out).toBe('2/S/u/C/R/{x}');
  });
});

describe('retentionDedupeKey', () => {
  it('names the rule, the service and the expiry', () => {
    expect(retentionDedupeKey('r1', 42, 1_700_000_000)).toBe('retention:r1:42:1700000000');
  });
});
