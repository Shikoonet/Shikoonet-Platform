/**
 * The review queue must say what the bank's first text on a new number said.
 *
 * 2026-09-19, production: «Auto: ****5261 · SHAHR · 400788235261» and nothing
 * else — Sam could not tell a card purchase from a deposit without opening the
 * database. The card now carries the first text: direction, amount, balance,
 * the bank's clock.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AccountsView } from '../../src/hub/AccountsView.js';
import { createCache } from '../../src/hub/query.js';

const pending = {
  id: 'acc-5261',
  bank_name: 'SHAHR',
  display_name: 'Auto: ****5261',
  owner_label: null,
  account_type: 'ACCOUNT',
  account_hint: '400788235261',
  card_last_four: null,
  account_last_four: null,
  iban: null,
  device_id: null,
  active: 1,
  status: 'PENDING',
  parser_configuration: '{}',
  created_at: Date.UTC(2026, 8, 19, 11, 39),
  updated_at: Date.UTC(2026, 8, 19, 11, 39),
  first_seen_direction: 'DEBIT',
  first_seen_amount_irr: 13_900_000,
  first_seen_balance_irr: 67_243_500,
  first_seen_at: Date.UTC(2026, 8, 17, 13, 30),
};

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, items: [pending], totals: {}, accounts: [pending] }) }) as Response),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a number nobody registered, in the review queue', () => {
  it('shows what its first text said: a withdrawal, the amount, the balance, the bank clock', async () => {
    render(<AccountsView cache={createCache()} />);
    const seen = await screen.findByTestId('first-seen');
    expect(seen.textContent).toContain('برداشت');
    expect(seen.textContent).toContain('۱٬۳۹۰٬۰۰۰');
    expect(seen.textContent).toContain('۶٬۷۲۴٬۳۵۰');
    expect(seen.textContent).toContain('۱۴۰۵/۰۶/۲۶');
  });
});
