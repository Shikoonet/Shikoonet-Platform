/**
 * «کدهای تخفیف» — Sam, 2026-09-12: «اصلاً معلوم نیست قرار است این کد برای
 * حجم باشد یا برای پول». A ۲۰٪ that comes off the price and a ۲۰٪ that goes
 * onto the volume looked the same, so every kind now names its family first,
 * and the create form says in one sentence what the customer gets.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { DiscountsPage } from '../src/pages/DiscountsPage.js';

function code(id: number, kind: string, extra: Record<string, unknown>) {
  return {
    id,
    code: `C${id}`,
    kind,
    amountIrr: null,
    percent: null,
    bonusGb: null,
    maxUses: null,
    used: 0,
    appliesTo: 'ALL',
    firstPurchaseOnly: false,
    resellersOnly: false,
    product: null,
    provider: null,
    expiresAt: null,
    createdAt: '2026-09-12T08:00:00.000Z',
    usesPerUser: 1,
    status: 'ACTIVE',
    targetUser: null,
    state: 'USABLE',
    ...extra,
  };
}

const ROWS = [
  code(1, 'PERCENT_OFF', { percent: 20 }),
  code(2, 'BONUS_PERCENT', { percent: 20 }),
  code(3, 'BONUS_GB', { bonusGb: 30 }),
];

function mockApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, total: ROWS.length, items: ROWS }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('a code says which family it belongs to', () => {
  it('lists money and volume percents under different names', async () => {
    mockApi();
    render(
      <RoleProvider role="ADMIN">
        <DiscountsPage />
      </RoleProvider>,
    );
    const money = (await screen.findByText('C1')).closest('tr')!;
    const volume = screen.getByText('C2').closest('tr')!;
    const gb = screen.getByText('C3').closest('tr')!;
    expect(money.textContent).toContain('پول · درصد از قیمت');
    expect(volume.textContent).toContain('حجم · درصد اضافه');
    expect(volume.textContent).toContain('+۲۰٪ حجم');
    expect(gb.textContent).toContain('حجم · گیگ اضافه');
    expect(gb.textContent).toContain('+۳۰ گیگ');
  });

  it('the form groups kinds by what they do and explains the chosen one', async () => {
    mockApi();
    render(
      <RoleProvider role="ADMIN">
        <DiscountsPage />
      </RoleProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'کد جدید' }));
    const select = screen.getByLabelText('نوع') as HTMLSelectElement;
    const groups = [...select.querySelectorAll('optgroup')].map((g) => g.label);
    expect(groups).toEqual(['از قیمت کم می‌کند', 'به حجم اضافه می‌کند — قیمت همان می‌ماند']);

    expect(screen.getByTestId('kind-hint').textContent).toContain('قیمت پلن به همین درصد کم می‌شود');
    fireEvent.change(select, { target: { value: 'BONUS_PERCENT' } });
    expect(screen.getByTestId('kind-hint').textContent).toContain('قیمت عوض نمی‌شود');
    expect(screen.getByTestId('kind-hint').textContent).toContain('۱۲ گیگ');
  });
});
