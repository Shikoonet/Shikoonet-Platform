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
    products: [],
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

describe('bulk delete (#383)', () => {
  it('one confirm, one DELETE per picked code, a refusal is reported not fatal', async () => {
    const rows = [
      code(1, 'PERCENT_OFF', { percent: 10 }),
      code(2, 'PERCENT_OFF', { percent: 20 }),
      code(3, 'PERCENT_OFF', { percent: 30, used: 4, state: 'USED_UP' }),
    ];
    const deletes: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === 'DELETE') {
          deletes.push(url);
          // The second one gained a redemption since the list loaded.
          if (url.endsWith('/discounts/2')) {
            return new Response(
              JSON.stringify({ ok: false, error: 'has_redemptions', detail: '1' }),
              { status: 409, headers: { 'content-type': 'application/json' } },
            );
          }
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ ok: true, total: rows.length, items: rows }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const confirm = vi.fn(() => true);
    vi.stubGlobal('confirm', confirm);

    render(
      <RoleProvider role="ADMIN">
        <DiscountsPage />
      </RoleProvider>,
    );
    await screen.findByText('C1');

    // A used code cannot be picked; «select all» skips it.
    const box = (c: string) => screen.getByLabelText(`انتخاب ${c}`) as HTMLInputElement;
    expect(box('C3').disabled).toBe(true);
    fireEvent.click(screen.getByLabelText('انتخاب همهٔ ردیف‌ها'));
    expect(box('C1').checked).toBe(true);
    expect(box('C2').checked).toBe(true);
    expect(box('C3').checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'حذف انتخاب‌شده‌ها (۲)' }));
    await screen.findByText(/حذف نشد/);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(deletes.map((u) => u.slice(u.lastIndexOf('/') + 1))).toEqual(['1', '2']);
    expect(screen.getByText(/حذف نشد/).textContent).toContain('۱ کد حذف شد؛ ۱ کد حذف نشد: C2');
  });
});

describe('a code can be for some services', () => {
  it('the form lists the services and sends the ticked ones as productIds', async () => {
    const posts: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (init?.method === 'POST') {
          posts.push(String(init.body));
          return json({ ok: true, discount: ROWS[0] });
        }
        if (url.includes('/catalog?')) {
          return json({
            ok: true,
            total: 2,
            items: [
              { id: 7, name: 'آلمان', configs: [] },
              { id: 9, name: 'فرانسه', configs: [] },
            ],
          });
        }
        return json({ ok: true, total: ROWS.length, items: ROWS });
      }),
    );
    render(
      <RoleProvider role="ADMIN">
        <DiscountsPage />
      </RoleProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'کد جدید' }));
    const scope = await screen.findByTestId('service-scope');
    expect([...scope.querySelectorAll('label')].map((l) => l.textContent?.trim())).toEqual([
      'آلمان',
      'فرانسه',
    ]);

    // A gift code charges a wallet; the service question is not asked.
    fireEvent.change(screen.getByLabelText('نوع'), { target: { value: 'GIFT_BALANCE' } });
    expect(screen.queryByTestId('service-scope')).toBeNull();
    fireEvent.change(screen.getByLabelText('نوع'), { target: { value: 'PERCENT_OFF' } });

    fireEvent.change(screen.getByLabelText('کد'), { target: { value: 'FR10' } });
    fireEvent.change(screen.getByLabelText('درصد'), { target: { value: '10' } });
    // Tick both, untick one: what is sent is what is ticked at the end.
    fireEvent.click(screen.getByLabelText('آلمان'));
    fireEvent.click(screen.getByLabelText('فرانسه'));
    fireEvent.click(screen.getByLabelText('آلمان'));
    fireEvent.click(screen.getByRole('button', { name: 'ساخت' }));
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    expect(JSON.parse(posts[0]!)).toMatchObject({ code: 'FR10', productIds: [9] });
  });
});
