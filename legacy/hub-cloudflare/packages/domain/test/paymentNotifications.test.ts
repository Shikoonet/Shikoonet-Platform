import { describe, expect, it } from 'vitest';
import {
  getBellUnreadCounts,
  incomeEventKey,
  claimEventKey,
} from '../src/paymentNotifications.js';

describe('paymentNotifications bell scope', () => {
  it('exports income and claim event keys', () => {
    expect(incomeEventKey('tx-1')).toBe('income:tx-1');
    expect(claimEventKey('c-1')).toBe('claim:c-1');
  });

  it('getBellUnreadCounts returns income + botAutoVerified shape', async () => {
    const db = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ c: 0 }),
        }),
      }),
    };
    const counts = await getBellUnreadCounts(db as never, 'ops@example.com');
    expect(counts).toEqual({ income: 0, botAutoVerified: 0, total: 0 });
  });
});
