/**
 * What «نمایندگان» draws, in the three states that are about money.
 *
 * The route tests assert the numbers; these assert that the SCREEN keeps apart
 * the pairs that look identical and mean opposite things:
 *
 *   - never metered  vs  metered at nothing
 *   - no cap         vs  a cap of zero
 *
 * The second is here because it was a real defect: the page divided by
 * `dataLimitBytes` after ruling out only `null`, so a cap of zero — a state
 * the adapter deliberately preserves — rendered as «NaN٪» or «Infinity٪».
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { ResellersPage } from '../src/pages/ResellersPage.js';
import { ApiError, type PanelItem, type ResellerRow } from '../src/api.js';

const GIB = 1024 ** 3;
const resellers = vi.fn();
const resellerReadings = vi.fn();
const panels = vi.fn();
const createReseller = vi.fn();
const setResellerStatus = vi.fn();
const updateReseller = vi.fn();
const customers = vi.fn();
const customer = vi.fn();

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      resellers: () => resellers(),
      resellerReadings: (id: number) => resellerReadings(id),
      panels: () => panels(),
      createReseller: (body: unknown) => createReseller(body),
      setResellerStatus: (id: number, status: string) => setResellerStatus(id, status),
      updateReseller: (id: number, patch: unknown) => updateReseller(id, patch),
      customers: (p: unknown) => customers(p),
      customer: (id: number) => customer(id),
    },
  };
});

function row(over: Partial<ResellerRow>): ResellerRow {
  return {
    id: 1,
    name: 'نمایندهٔ نمونه',
    status: 'ACTIVE',
    telegramId: '-1',
    username: 'agent',
    providerId: 1,
    providerName: 'پنل',
    panelAdminUsername: 'agent_admin',
    dataLimitBytes: 100 * GIB,
    expiresAt: null,
    installationUrl: null,
    note: null,
    billableBytes: 50 * GIB,
    latestUsedBytes: 50 * GIB,
    latestTotalUsers: 7,
    latestPanelStatus: 'active',
    latestPanelIsLimited: false,
    lastReadAt: '2026-09-07T09:00:00Z',
    readings: 1,
    ...over,
  };
}

function draw(items: ResellerRow[]) {
  resellers.mockResolvedValue({ ok: true, items });
  render(
    <RoleProvider role="ADMIN">
      <ResellersPage />
    </RoleProvider>,
  );
}

/** Only the fields the form reads; the rest of a panel is not its business. */
function panel(over: Partial<PanelItem>): PanelItem {
  const base = { id: 1, name: 'پنل پاسارگارد', kind: 'pasarguard', resellerSale: null };
  return { ...base, ...over } as PanelItem;
}

beforeEach(() => {
  vi.clearAllMocks();
  resellerReadings.mockResolvedValue({ ok: true, items: [] });
  panels.mockResolvedValue({
    ok: true,
    items: [panel({}), panel({ id: 2, name: 'پنل مرزبان', kind: 'marzban' })],
  });
  createReseller.mockResolvedValue({ ok: true, id: 9 });
  setResellerStatus.mockResolvedValue({ ok: true });
  updateReseller.mockResolvedValue({ ok: true });
  // Internal id 42 is the customer whose telegram id is 5550001.
  customers.mockResolvedValue({
    ok: true,
    total: 1,
    page: 1,
    pageSize: 10,
    items: [{ id: 42, telegramId: 5550001, username: 'north_agent' }],
  });
  customer.mockResolvedValue({
    ok: true,
    customer: { id: 77, telegramId: 5550077, username: 'approved_one' },
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState(null, '', '/');
});

describe('the two pairs that look the same and are not', () => {
  it('says «هنوز خوانده نشده» rather than a zero', async () => {
    // A franchise nobody has metered and one that used nothing are the same
    // number on an invoice and opposite facts. Only the first can be null.
    draw([row({ billableBytes: null, latestUsedBytes: null, lastReadAt: null, readings: 0 })]);

    await waitFor(() => expect(screen.getByText('هنوز خوانده نشده')).toBeTruthy());
    // Anchored: an unanchored «۰ گیگ» also matches «۱۰۰ گیگ», which is how a
    // test can pass for a reason it did not mean.
    expect(screen.queryByText(/^۰ گیگ$/)).toBeNull();
    // And the capacity cell says what was BOUGHT, with no usage figure beside
    // it, because there is no reading to put there.
    expect(screen.getByText('۱۰۰ گیگ خریده')).toBeTruthy();
  });

  it('draws no percentage for an unlimited reseller', async () => {
    draw([row({ dataLimitBytes: null })]);

    await waitFor(() => expect(screen.getByText('نامحدود')).toBeTruthy());
  });

  it('does not divide by a cap of zero', async () => {
    /**
     * The defect this test exists for. `data_limit: 0` is what the panel
     * reports for an admin allowed to use nothing — a real state the adapter
     * refuses to collapse into `null` — and the page used to divide by it.
     * `NaN٪` and `Infinity٪` are both worse than a sentence.
     */
    draw([row({ dataLimitBytes: 0, billableBytes: 3 * GIB })]);

    await waitFor(() => expect(screen.getByText(/با سقف صفر/)).toBeTruthy());
    expect(screen.queryByText(/NaN|Infinity/)).toBeNull();
  });

  it('says so plainly when a zero cap has been used against by nothing', async () => {
    draw([row({ dataLimitBytes: 0, billableBytes: 0, latestUsedBytes: 0 })]);

    await waitFor(() => expect(screen.getByText('سقف صفر')).toBeTruthy());
  });

  it('shows the billable total even when the panel counter was reset', async () => {
    // `used` back at nothing, lifetime carrying on: the bill must not shrink.
    draw([row({ billableBytes: 249 * GIB, latestUsedBytes: 9 * GIB })]);

    await waitFor(() => expect(screen.getByText(/۲۴۹ گیگ از ۱۰۰ گیگ/)).toBeTruthy());
  });

  it('badges a franchise the panel stopped by itself', async () => {
    draw([row({ latestPanelIsLimited: true })]);

    await waitFor(() => expect(screen.getByText('به سقف رسیده')).toBeTruthy());
  });
});

describe('the boundary', () => {
  it('draws no customer of the reseller, only a count', async () => {
    // Their customers never reach this database, so the screen has nothing to
    // draw but a number. Asserted so a future column cannot quietly become a
    // list of somebody else's subscribers.
    draw([row({ latestTotalUsers: 7 })]);

    await waitFor(() => expect(screen.getByText('۷')).toBeTruthy());
    expect(screen.queryByRole('link', { name: /کاربر|مشتری/ })).toBeNull();
  });
});

const type = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

const pickedText = () => screen.getByTestId('reseller-picked').textContent;

/** Finds the customer by what the operator knows, and picks them. */
async function pickUser() {
  type('کاربر — آیدی عددی تلگرام یا @یوزرنیم', '5550001');
  fireEvent.click(screen.getByRole('button', { name: 'جست‌وجو' }));
  fireEvent.click(await screen.findByRole('button', { name: '@north_agent · 5550001' }));
}

async function openForm() {
  draw([]);
  fireEvent.click(await screen.findByRole('button', { name: 'ثبت نماینده' }));
  await screen.findByRole('option', { name: 'پنل پاسارگارد' });
}

describe('«ثبت نماینده»', () => {
  it('links an admin that already exists on the panel, with no volume typed', async () => {
    await openForm();
    await pickUser();
    type('پنل', '2');
    type('یوزرنیم ادمین روی پنل', 'Agent.One');
    type('نام نماینده', 'نمایندهٔ شمال');
    fireEvent.click(screen.getByRole('button', { name: 'ثبت نماینده' }));

    await waitFor(() => expect(createReseller).toHaveBeenCalledTimes(1));
    expect(createReseller.mock.calls[0]![0]).toEqual({
      userId: 42,
      providerId: 2,
      panelAdminUsername: 'Agent.One',
      name: 'نمایندهٔ شمال',
      dataLimitBytes: null,
      expiresAtMs: null,
      installationUrl: null,
      note: null,
      status: 'ACTIVE',
    });
  });

  it('leaves a new panel to the bot, on PasarGuard only, refusing a bad name', async () => {
    await openForm();
    fireEvent.click(screen.getByLabelText('پنل جدید بسازد'));
    // The bot creates admins on PasarGuard alone today.
    expect(screen.queryByRole('option', { name: 'پنل مرزبان' })).toBeNull();

    await pickUser();
    type('پنل', '1');
    type('نام نماینده', 'نمایندهٔ جنوب');
    type('یوزرنیم ادمین جدید', 'علی agent');
    const submit = screen.getByRole('button', { name: 'ثبت نماینده' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(screen.getByLabelText('یوزرنیم ادمین جدید').getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('فقط حروف انگلیسی، عدد، نقطه، خط تیره و زیرخط؛ ۳ تا ۳۴ کاراکتر'))
      .toBeTruthy();
    fireEvent.click(submit);
    expect(createReseller).not.toHaveBeenCalled();

    type('یوزرنیم ادمین جدید', 'ab');
    expect(submit.disabled).toBe(true);

    type('یوزرنیم ادمین جدید', 'south_agent-1');
    // A deadline is the first instant after that Tehran day: Tehran is UTC+3:30,
    // so the end of 1 October 2026 there is 20:30 UTC on the 1st.
    type('مهلت (خالی = بی‌مهلت)', '2026-10-01');
    fireEvent.click(submit);

    await waitFor(() => expect(createReseller).toHaveBeenCalledTimes(1));
    expect(createReseller.mock.calls[0]![0]).toMatchObject({
      userId: 42,
      providerId: 1,
      panelAdminUsername: 'south_agent-1',
      status: 'PENDING',
      dataLimitBytes: null,
      expiresAtMs: Date.UTC(2026, 9, 1, 20, 30),
    });
  });

  it('warns when the panel has no reseller price table yet', async () => {
    await openForm();
    fireEvent.click(screen.getByLabelText('پنل جدید بسازد'));
    type('پنل', '1');
    expect(screen.getByText(/«فروش به نماینده» روی این پنل تنظیم نشده/)).toBeTruthy();
  });

  it('says in Persian that the panel admin is taken', async () => {
    createReseller.mockRejectedValueOnce(
      new ApiError(409, 'that panel admin is already taken', null),
    );
    await openForm();
    await pickUser();
    type('پنل', '1');
    type('یوزرنیم ادمین روی پنل', 'agent');
    type('نام نماینده', 'نماینده');
    fireEvent.click(screen.getByRole('button', { name: 'ثبت نماینده' }));

    expect(await screen.findByText('این ادمین پنل قبلاً به نمایندهٔ دیگری وصل شده است.'))
      .toBeTruthy();
  });

  it('opens on the user an approved request links to, and names them', async () => {
    window.history.replaceState(null, '', '/resellers?user=77');
    draw([]);

    await waitFor(() => expect(pickedText()).toBe('انتخاب‌شده: @approved_one · 5550077'));
    expect(customer).toHaveBeenCalledWith(77);
    await screen.findByRole('option', { name: 'پنل پاسارگارد' });
    type('پنل', '1');
    type('یوزرنیم ادمین روی پنل', 'agent');
    type('نام نماینده', 'نماینده');
    fireEvent.click(screen.getByRole('button', { name: 'ثبت نماینده' }));
    await waitFor(() => expect(createReseller).toHaveBeenCalledTimes(1));
    expect(createReseller.mock.calls[0]![0]).toMatchObject({ userId: 77 });
  });

  it('finds the user by telegram id through the customers search, and sends OUR id', async () => {
    await openForm();
    // Nobody picked: nothing can be sent.
    expect(screen.getByText('هنوز کاربری انتخاب نشده.')).toBeTruthy();
    await pickUser();

    expect(customers).toHaveBeenCalledWith({ q: '5550001', page: 1, pageSize: 10 });
    expect(pickedText()).toBe('انتخاب‌شده: @north_agent · 5550001');
    expect(
      screen.getByRole('button', { name: '@north_agent · 5550001' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('says the user must /start the bot first when nobody matches', async () => {
    customers.mockResolvedValueOnce({ ok: true, total: 0, page: 1, pageSize: 10, items: [] });
    await openForm();
    type('کاربر — آیدی عددی تلگرام یا @یوزرنیم', '@nobody');
    fireEvent.keyDown(screen.getByLabelText('کاربر — آیدی عددی تلگرام یا @یوزرنیم'), {
      key: 'Enter',
    });

    expect(
      await screen.findByText('این کاربر هنوز ربات را استارت نکرده — اول باید یک بار /start بزند.'),
    ).toBeTruthy();
    type('پنل', '1');
    type('یوزرنیم ادمین روی پنل', 'agent');
    type('نام نماینده', 'نماینده');
    expect((screen.getByRole('button', { name: 'ثبت نماینده' }) as HTMLButtonElement).disabled)
      .toBe(true);
  });
});

describe('the status buttons', () => {
  const names = (who: string) =>
    ['تعلیق', 'فعال‌سازی', 'بستن'].filter(
      (l) => screen.queryByRole('button', { name: `${l} ${who}` }) !== null,
    );

  it('draws only the moves the server accepts from each status', async () => {
    draw([
      row({ id: 1, name: 'الف', status: 'PENDING', dataLimitBytes: null }),
      row({ id: 2, name: 'ب', status: 'ACTIVE' }),
      row({ id: 3, name: 'پ', status: 'SUSPENDED' }),
      row({ id: 4, name: 'ت', status: 'CLOSED' }),
    ]);
    await screen.findByText('الف');

    expect(names('الف')).toEqual(['بستن']);
    expect(names('ب')).toEqual(['تعلیق', 'بستن']);
    expect(names('پ')).toEqual(['فعال‌سازی', 'بستن']);
    expect(names('ت')).toEqual([]);
    // A row the bot has not created yet has no volume to show.
    expect(screen.getByText('هنوز ساخته نشده')).toBeTruthy();
    expect(screen.getByText('در انتظار ساخت')).toBeTruthy();
  });

  it('reactivates a suspended row with its own button', async () => {
    draw([row({ id: 3, name: 'پ', status: 'SUSPENDED' })]);
    fireEvent.click(await screen.findByRole('button', { name: 'فعال‌سازی پ' }));

    await waitFor(() => expect(setResellerStatus).toHaveBeenCalledWith(3, 'ACTIVE'));
  });

  it('asks before closing, and closes nothing on «no»', async () => {
    vi.mocked(window.confirm).mockReturnValueOnce(false);
    draw([row({ id: 2, name: 'ب', status: 'ACTIVE' })]);
    fireEvent.click(await screen.findByRole('button', { name: 'بستن ب' }));
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(setResellerStatus).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'بستن ب' }));
    await waitFor(() => expect(setResellerStatus).toHaveBeenCalledWith(2, 'CLOSED'));
  });

  it('says a refused transition in Persian', async () => {
    setResellerStatus.mockRejectedValueOnce(new ApiError(409, 'transition_refused', null));
    draw([row({ id: 2, name: 'ب', status: 'ACTIVE' })]);
    fireEvent.click(await screen.findByRole('button', { name: 'تعلیق ب' }));

    expect(await screen.findByText(/این تغییر وضعیت پذیرفته نشد/)).toBeTruthy();
  });
});

describe('editing a reseller', () => {
  it('removes the deadline with null, and sends nothing else', async () => {
    draw([row({ id: 2, name: 'ب', expiresAt: '2026-10-01T20:30:00Z' })]);
    fireEvent.click(await screen.findByRole('button', { name: 'ویرایش ب' }));
    fireEvent.click(screen.getByRole('button', { name: 'برداشتن مهلت' }));

    await waitFor(() => expect(updateReseller).toHaveBeenCalledTimes(1));
    expect(updateReseller.mock.calls[0]).toEqual([2, { expiresAtMs: null }]);
  });

  it('sends only what changed', async () => {
    draw([row({ id: 2, name: 'ب', note: null })]);
    fireEvent.click(await screen.findByRole('button', { name: 'ویرایش ب' }));
    // No deadline to remove.
    expect(screen.queryByRole('button', { name: 'برداشتن مهلت' })).toBeNull();
    type('مهلت تازه (الان: بدون سررسید)', '2026-10-01');
    type('یادداشت', 'قرارداد سالانه');
    fireEvent.click(screen.getByRole('button', { name: 'ذخیره' }));

    await waitFor(() => expect(updateReseller).toHaveBeenCalledTimes(1));
    expect(updateReseller.mock.calls[0]).toEqual([
      2,
      { note: 'قرارداد سالانه', expiresAtMs: Date.UTC(2026, 9, 1, 20, 30) },
    ]);
  });
});
