/**
 * The one table the panel's ledgers are made of.
 *
 * The 2026-09-07 walk called these «۳۱ صفحهٔ جدا»: five tables with five
 * copies of a search box and a pager, none of which could be sorted, dated or
 * taken away — and every one of them clipped on a phone, because a `<table>`
 * with nine columns cannot be anything else at 390px.
 *
 * Everything below is asserted on what the SERVER is asked for, not on what
 * the browser does to twenty-five loaded rows. Sorting a page of a 8,960-row
 * ledger in the browser is the lie `narrowed` was written to stop.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ListPage, type Column, type FetchParams } from '../src/ListPage.js';
import { RoleProvider } from '../src/role.js';

interface Row {
  id: number;
  who: string;
  amount: number;
}

const ROWS: Row[] = [
  { id: 1, who: '@reza', amount: 300_000 },
  { id: 2, who: '@sara', amount: 100_000 },
];

const COLUMNS: Column<Row>[] = [
  { key: 'who', label: 'کاربر', cell: (r) => r.who },
  { key: 'total_irr', label: 'مبلغ', sort: 'total_irr', cell: (r) => String(r.amount) },
];

function draw(overrides: Partial<Parameters<typeof ListPage<Row>>[0]> = {}) {
  const fetchPage = vi.fn(async (_p: FetchParams) => ({ total: 2, items: ROWS }));
  const utils = render(
    <RoleProvider role="ADMIN">
      <ListPage<Row>
        page="orders"
        unit="سفارش"
        filterLabel="وضعیت"
        filterOptions={[['COMPLETED', 'تکمیل شده']]}
        columns={COLUMNS}
        rowKey={(r) => r.id}
        fetchPage={fetchPage}
        {...overrides}
      />
    </RoleProvider>,
  );
  return { ...utils, fetchPage };
}

afterEach(() => {
  window.history.replaceState(null, '', '/');
});

describe('the shared ledger table', () => {
  it('asks the server to sort, rather than sorting the page it already has', async () => {
    const { fetchPage } = draw();
    await screen.findByText('@reza');

    fireEvent.click(screen.getByRole('button', { name: /مبلغ/ }));

    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    expect(fetchPage.mock.calls[1]![0]).toMatchObject({ sort: 'total_irr', dir: 'asc' });
  });

  it('keeps the sort in the address, so the screen can be sent to somebody', async () => {
    draw();
    await screen.findByText('@reza');
    fireEvent.click(screen.getByRole('button', { name: /مبلغ/ }));
    // Read back through URLSearchParams, not off the raw string: the writer
    // uses it too and it percent-encodes the colon, so a substring match on
    // `total_irr:asc` fails on a URL that is perfectly correct.
    await waitFor(() =>
      expect(new URLSearchParams(window.location.search).get('sort_orders')).toBe('total_irr:asc'),
    );
  });

  it('sends a date range as calendar days', async () => {
    const { fetchPage } = draw({ dateRange: true });
    await screen.findByText('@reza');

    // `DateField` is three selects — day, month, year — because a Persian date
    // is spoken that way and the browser's own picker is Gregorian whatever the
    // page language says.
    fireEvent.change(screen.getByLabelText('سال از'), { target: { value: '1405' } });
    fireEvent.change(screen.getByLabelText('ماه از'), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('روز از'), { target: { value: '1' } });
    fireEvent.click(screen.getByRole('button', { name: 'جست‌وجو' }));

    await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
    // Jalali in, ISO out — the API speaks calendar days in Gregorian and the
    // operator does not. 1 Shahrivar 1405 is 2026-08-23.
    expect(fetchPage.mock.calls.at(-1)![0]).toMatchObject({ from: '2026-08-23' });
  });

  it('offers the same rows as a file, carrying every filter that is on screen', async () => {
    draw({ csvUrl: (p) => `/api/v1/admin/orders?${new URLSearchParams(p as never)}&format=csv` });
    await screen.findByText('@reza');

    fireEvent.change(screen.getByLabelText('وضعیت'), { target: { value: 'COMPLETED' } });
    await waitFor(() => {
      const a = screen.getByRole('link', { name: /خروجی CSV/ });
      expect(a.getAttribute('href')).toContain('filter=COMPLETED');
      expect(a.getAttribute('href')).toContain('format=csv');
    });
  });

  it('labels every cell, which is what lets a phone read the table as cards', async () => {
    draw();
    await screen.findByText('@reza');
    const cells = document.querySelectorAll('tbody tr:first-child td');
    expect([...cells].map((c) => c.getAttribute('data-label'))).toEqual(['کاربر', 'مبلغ']);
  });

  it('hides the export from an operator who may not take one', async () => {
    render(
      <RoleProvider role="REVIEWER">
        <ListPage<Row>
          page="orders"
          unit="سفارش"
          filterLabel="وضعیت"
          filterOptions={[]}
          columns={COLUMNS}
          rowKey={(r) => r.id}
          csvUrl={() => '/x?format=csv'}
          fetchPage={async () => ({ total: 2, items: ROWS })}
        />
      </RoleProvider>,
    );
    await screen.findByText('@reza');
    expect(screen.queryByRole('link', { name: /خروجی CSV/ })).toBeNull();
  });
});
