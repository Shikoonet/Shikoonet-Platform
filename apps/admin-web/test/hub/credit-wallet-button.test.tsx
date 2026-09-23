/**
 * «شارژ کیف پول» on a deposit row: offered only where the expired-invoice hint
 * names a customer to pay. A deposit with no hint, or whose invoice's customer
 * is gone, has nobody to credit — «تخصیص» and «رد» stay its doors.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { IncomeRow } from '../../src/hub/financialHub.js';
import type { IncomeItem } from '../../src/hub/paymentReview.js';

function deposit(expiredInvoice: NonNullable<IncomeItem['expiredInvoice']> | null): IncomeItem {
  return {
    id: 'tx-late',
    amountIrr: 1_200_000,
    amountToman: 120_000,
    bankTimestamp: 1_790_000_000_000,
    accountId: 'acc-1',
    accountDisplay: 'Melli',
    accountBank: 'Melli',
    accountHint: '4006',
    reference: null,
    statusLabel: '',
    expiredInvoice,
  };
}

function renderRow(item: IncomeItem, onCreditWallet = vi.fn()) {
  render(
    <ul>
      <IncomeRow
        item={item}
        onAssign={() => {}}
        onMarkReseller={() => {}}
        onDecline={() => {}}
        onDuplicate={() => {}}
        onCreditWallet={onCreditWallet}
      />
    </ul>,
  );
  return onCreditWallet;
}

const invoice = { publicId: 'e8bc048bee', invoiceAt: 1_789_998_000_000, others: 0 };

describe('«شارژ کیف پول» on a deposit row', () => {
  it('is offered for a late deposit whose expired invoice names its customer', () => {
    const onCreditWallet = renderRow(
      deposit({ ...invoice, customer: { id: 17175, telegramId: '1', username: 'm1599p' } }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'شارژ کیف پول' }));
    expect(onCreditWallet).toHaveBeenCalledTimes(1);
  });

  it('is not offered without a hint, or when the customer is gone', () => {
    renderRow(deposit(null));
    expect(screen.queryByRole('button', { name: 'شارژ کیف پول' })).toBeNull();
    screen.getByRole('button', { name: 'تخصیص' });
  });

  it('is not offered when the invoice’s customer was deleted', () => {
    renderRow(deposit({ ...invoice, customer: null }));
    expect(screen.queryByRole('button', { name: 'شارژ کیف پول' })).toBeNull();
  });
});
