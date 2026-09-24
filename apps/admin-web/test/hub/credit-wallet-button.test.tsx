/**
 * «شارژ کیف پول» on a deposit row, and its dialog.
 *
 * On every deposit (Sam, 2026-09-23): a wrong amount has no expired invoice
 * to name its customer, and it is exactly the money that needs this door.
 * Where the hint names a customer the dialog starts from them; otherwise the
 * operator finds one by Telegram id or username.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { IncomeRow } from '../../src/hub/financialHub.js';
import { CreditWalletModal } from '../../src/hub/PaymentsView.js';
import { api } from '../../src/hub/api.js';
import { api as adminApi, type CustomerListPage } from '../../src/api.js';
import type { IncomeItem } from '../../src/hub/paymentReview.js';

vi.mock('../../src/hub/api.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/hub/api.js')>('../../src/hub/api.js');
  return { ...actual, api: { ...actual.api, creditDepositToWallet: vi.fn() } };
});
vi.mock('../../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/api.js')>('../../src/api.js');
  return { ...actual, api: { ...actual.api, customers: vi.fn() } };
});

function deposit(expiredInvoice: NonNullable<IncomeItem['expiredInvoice']> | null): IncomeItem {
  return {
    id: 'tx-late',
    amountIrr: 1_200_000,
    amountToman: 120_000,
    bankTimestamp: 1_790_000_000_000,
    accountId: 'acc-1',
    accountDisplay: 'Melli',
    accountBank: 'Melli',
    accountHint: '1234',
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

const invoice = { publicId: 'inv0000001', invoiceAt: 1_789_998_000_000, others: 0 };
const named = { ...invoice, customer: { id: 501, telegramId: '1', username: 'late_payer' } };

describe('«شارژ کیف پول» on a deposit row', () => {
  it('is offered on a late deposit whose expired invoice names its customer', () => {
    const onCreditWallet = renderRow(deposit(named));
    fireEvent.click(screen.getByRole('button', { name: 'شارژ کیف پول' }));
    expect(onCreditWallet).toHaveBeenCalledTimes(1);
  });

  it('is offered on a deposit with no hint too — a wrong amount has none', () => {
    const onCreditWallet = renderRow(deposit(null));
    fireEvent.click(screen.getByRole('button', { name: 'شارژ کیف پول' }));
    expect(onCreditWallet).toHaveBeenCalledTimes(1);
  });
});

describe('the «شارژ کیف پول» dialog', () => {
  it('asks whose it is when no invoice says, and credits the customer picked', async () => {
    vi.mocked(adminApi.customers).mockResolvedValue({
      ok: true,
      total: 1,
      page: 1,
      pageSize: 5,
      items: [{ id: 42, telegramId: 700000001, username: null }],
    } as unknown as CustomerListPage);
    vi.mocked(api.creditDepositToWallet).mockResolvedValue({
      ok: true,
      amountIrr: 1_200_000,
      balanceIrr: 1_200_000,
      notified: true,
    });
    const onDone = vi.fn();
    render(<CreditWalletModal item={deposit(null)} onClose={() => {}} onDone={onDone} onError={() => {}} />);

    const submit = screen.getByRole<HTMLButtonElement>('button', { name: 'شارژ کیف پول' });
    fireEvent.change(screen.getByLabelText('دلیل'), { target: { value: 'مبلغ را اشتباه زد' } });
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/آیدی عددی/), { target: { value: '700000001' } });
    fireEvent.click(screen.getByRole('button', { name: 'جستجو' }));
    fireEvent.click(await screen.findByRole('button', { name: '700000001' }));
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(adminApi.customers).toHaveBeenCalledWith({ q: '700000001', page: 1, pageSize: 5 });
    expect(api.creditDepositToWallet).toHaveBeenCalledWith('tx-late', {
      userId: 42,
      reason: 'مبلغ را اشتباه زد',
    });
  });

  it('starts from the customer the expired invoice names', async () => {
    vi.mocked(api.creditDepositToWallet).mockResolvedValue({
      ok: true,
      amountIrr: 1_200_000,
      balanceIrr: 1_200_000,
      notified: true,
    });
    const onDone = vi.fn();
    render(<CreditWalletModal item={deposit(named)} onClose={() => {}} onDone={onDone} onError={() => {}} />);

    fireEvent.change(screen.getByLabelText('دلیل'), { target: { value: 'بعد از انقضا' } });
    fireEvent.click(screen.getByRole('button', { name: 'شارژ کیف پول' }));

    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.creditDepositToWallet).toHaveBeenLastCalledWith('tx-late', {
      userId: 501,
      reason: 'بعد از انقضا',
    });
  });

  // 1 Mehr 1405: the customer had been credited by hand already, and the
  // same deposit was paid in a second time.
  it('shows a hand credit since the deposit, and pays only when the operator goes on', async () => {
    const refused = Object.assign(new Error('409: hand_credited'), {
      status: 409,
      body: {
        ok: false,
        error: 'hand_credited',
        handCredit: { amountIrr: 1_200_000, note: 'اشتباه واریزی', actor: 'sam@example.com', at: 1_790_002_000_000 },
      },
    });
    vi.mocked(api.creditDepositToWallet)
      .mockRejectedValueOnce(refused)
      .mockResolvedValueOnce({ ok: true, amountIrr: 1_200_000, balanceIrr: 2_400_000, notified: true });
    const onDone = vi.fn();
    const onError = vi.fn();
    render(<CreditWalletModal item={deposit(named)} onClose={() => {}} onDone={onDone} onError={onError} />);

    fireEvent.change(screen.getByLabelText('دلیل'), { target: { value: 'مبلغ اشتباه' } });
    fireEvent.click(screen.getByRole('button', { name: 'شارژ کیف پول' }));

    const warning = await screen.findByTestId('hand-credited');
    expect(warning.textContent).toContain('۱۲۰٬۰۰۰');
    expect(warning.textContent).toContain('«اشتباه واریزی»');
    expect(warning.textContent).toContain('sam@example.com');
    expect(onDone).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'می‌دانم، باز هم شارژ کن' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(api.creditDepositToWallet).toHaveBeenLastCalledWith('tx-late', {
      userId: 501,
      reason: 'مبلغ اشتباه',
      despiteHandCredit: true,
    });
  });
});
