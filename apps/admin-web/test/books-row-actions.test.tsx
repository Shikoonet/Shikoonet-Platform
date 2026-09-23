/**
 * What a «دفتر بانک» row lets the operator do — Sam, 1 Mehr 1405: «اصلا
 * نمیدونم چی به چیه». An unclaimed deposit links to «واریزی‌ها», where a
 * deposit is given its owner; an unexplained withdrawal opens the ledger form
 * already on that SMS, as a cost or a partner's draw; a reseller's deposit
 * says whose; and no row offers a button the server would refuse.
 */

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { BooksPage } from '../src/pages/BooksPage.js';
import type { BankMovement } from '../src/api.js';

const ACC = 'acc-resalat';
const AT = Date.parse('2026-09-23T08:26:00Z'); // 1 Mehr 1405, 11:56 Tehran

const MOVES: BankMovement[] = [
  { id: 'tx-unclaimed', kind: 'sms', direction: 'CREDIT', amountIrr: 1_200_000, balanceIrr: null, bankTimestamp: AT + 3_000, matched: false, offBooks: null, expense: null, offBooksEligible: true, inQueue: true, reseller: null },
  { id: 'tx-resold', kind: 'sms', direction: 'CREDIT', amountIrr: 4_560_000, balanceIrr: null, bankTimestamp: AT + 2_000, matched: false, offBooks: null, expense: null, offBooksEligible: false, inQueue: false, reseller: 'نمایندهٔ شمال' },
  { id: 'tx-sold', kind: 'sms', direction: 'CREDIT', amountIrr: 2_500_000, balanceIrr: null, bankTimestamp: AT + 1_000, matched: true, offBooks: null, expense: null, offBooksEligible: false, inQueue: false, reseller: null },
  { id: 'tx-7m', kind: 'sms', direction: 'DEBIT', amountIrr: 70_000_000, balanceIrr: null, bankTimestamp: AT, matched: false, offBooks: null, expense: null, offBooksEligible: true, inQueue: false, reseller: null },
];

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      booksOpening: async () => ({ ok: true, opening: null, now: { walletIrr: 0, accounts: 0, missing: 0 } }),
      booksStatement: async () => ({ ok: true, accounts: [], totals: null, opening: { openedAt: AT - 86_400_000, walletIrr: 0, accounts: 1 } }),
      booksOffBooks: async () => ({ ok: true, items: [] }),
      booksMovements: async () => ({ ok: true, items: MOVES }),
      booksStatementCsvUrl: () => '#',
    },
  };
});
vi.mock('../src/hub/api.js', () => ({
  api: { accounts: async () => ({ items: [{ id: ACC, display_name: 'رسالت-پگاه', active: 1, card_last_four: null }] }) },
}));

async function open() {
  render(<BooksPage role="ADMIN" />);
  fireEvent.change(await screen.findByLabelText('حساب', { selector: 'select' }), { target: { value: ACC } });
  const row = async (id: string) => (await screen.findByTestId(`movement-${id}`)) as HTMLElement;
  return row;
}

describe('the buttons on a «دفتر بانک» row', () => {
  it('sends an unclaimed deposit to «واریزی‌ها», on exactly that deposit', async () => {
    const row = await open();
    const link = within(await row('tx-unclaimed')).getByText('وصل کن به سفارش') as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/admin/payments?tab=income&q=tx-unclaimed');
    expect(within(await row('tx-unclaimed')).getByText('خارج از دفتر')).toBeTruthy();
  });

  it('opens the ledger form on an unexplained withdrawal, as a cost or as a partner draw', async () => {
    const row = await open();
    const r = await row('tx-7m');
    const base = `/admin/expenses?account=${ACC}&amount=7000000&date=2026-09-23&tx=tx-7m`;
    expect(within(r).getByText('هزینه').getAttribute('href')).toBe(base);
    expect(within(r).getByText('برداشت شریک').getAttribute('href')).toBe(`${base}&kind=PARTNER_DRAW`);
    expect(within(r).getByText('خارج از دفتر')).toBeTruthy();
  });

  it('names the reseller, and offers nothing the server would refuse', async () => {
    const row = await open();
    const r = await row('tx-resold');
    expect(within(r).getByText('نمایندگی — نمایندهٔ شمال')).toBeTruthy();
    expect(within(r).queryByText('خارج از دفتر')).toBeNull();
    expect(within(r).queryByText('وصل کن به سفارش')).toBeNull();
    // A sale is done: nothing to press.
    expect(within(await row('tx-sold')).queryByRole('button')).toBeNull();
    expect(within(await row('tx-sold')).queryByRole('link')).toBeNull();
  });
});
