/**
 * The rule's shape, refused whole when any part is wrong — the bot reads
 * with the same function the panel refuses with, so a list this accepts is
 * a list the bot acts on exactly.
 */

import { describe, expect, it } from 'vitest';
import {
  RETENTION_DEFAULT_TEXT,
  RETENTION_DEFAULT_TEXT_AFTER,
  RETENTION_LIMITS,
  discountLabel,
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
    expect(out).toEqual([{ ...good, name: 'x', codeId: 3, textAfter: '' }]);
  });

  it('a rule saved before textAfter existed reads back with an empty one; a blank one is empty too', () => {
    expect(parseRetentionRules([good])?.[0]?.textAfter).toBe('');
    expect(parseRetentionRules([{ ...good, textAfter: '   ' }])?.[0]?.textAfter).toBe('');
    expect(parseRetentionRules([{ ...good, textAfter: 'بعد' }])?.[0]?.textAfter).toBe('بعد');
    expect(parseRetentionRules([{ ...good, textAfter: 'x'.repeat(RETENTION_LIMITS.text + 1) }])).toBeNull();
    expect(parseRetentionRules([{ ...good, textAfter: 5 }])).toBeNull();
  });

  it('the default texts use only declared placeholders', () => {
    for (const t of [RETENTION_DEFAULT_TEXT, RETENTION_DEFAULT_TEXT_AFTER]) {
      const slots = [...t.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]);
      expect(slots.length).toBeGreaterThan(0);
      for (const slot of slots) expect(['days', 'service', 'username', 'code', 'discount', 'renewButton']).toContain(slot);
    }
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
    const out = renderRetentionText('{days}/{service}/{username}/{code}/{discount}/{renewButton}/{x}', {
      days: '2',
      service: 'S',
      username: 'u',
      code: 'C',
      discount: 'D',
      renewButton: 'R',
    });
    expect(out).toBe('2/S/u/C/D/R/{x}');
  });
});

describe('discountLabel', () => {
  it('says the offer the way the code was made', () => {
    expect(discountLabel({ kind: 'PERCENT_OFF', percent: 30, amountIrr: null, bonusGb: null })).toBe('30٪');
    expect(discountLabel({ kind: 'AMOUNT_OFF', percent: null, amountIrr: 500_000, bonusGb: null })).toBe('50,000 تومان');
    expect(discountLabel({ kind: 'BONUS_GB', percent: null, amountIrr: null, bonusGb: 10 })).toBe('10 گیگ حجم اضافه');
    expect(discountLabel({ kind: 'BONUS_PERCENT', percent: 20, amountIrr: null, bonusGb: null })).toBe('20٪ حجم اضافه');
    expect(discountLabel({ kind: 'GIFT_BALANCE', percent: null, amountIrr: 100_000, bonusGb: null })).toBe('10,000 تومان شارژ کیف پول');
  });
});

describe('retentionDedupeKey', () => {
  it('names the rule, the service, the expiry and the day of the window', () => {
    expect(retentionDedupeKey('r1', 42, 1_700_000_000, 3)).toBe('retention:r1:42:1700000000:3');
    expect(retentionDedupeKey('r1', 42, 1_700_000_000, -2)).toBe('retention:r1:42:1700000000:-2');
  });
});
