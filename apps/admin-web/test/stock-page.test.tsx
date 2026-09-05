/**
 * «قفسهٔ انبار» — the half of the bulk form that only exists in a browser.
 *
 * Parsing, per-line verdicts and every refusal live on the server and are
 * asserted there (`apps/dashboard-worker/test/stock.test.ts`); the client is a
 * passthrough and there is nothing to prove about it twice. What CANNOT be
 * asserted anywhere else is the ordering: reading a file is asynchronous, and
 * the box the operator presses «افزودن» on has to be the box they were looking
 * at. A read that arrives late and replaces newer text sends a different set of
 * accounts to a shelf than the one on the screen — and every row on that shelf
 * is a working account somebody pays for.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { StockPage } from '../src/pages/StockPage.js';

const stock = vi.fn(async () => ({
  ok: true,
  total: 0,
  page: 1,
  pageSize: 50,
  items: [],
  shelves: [],
}));
const products = vi.fn(async () => ({
  ok: true,
  total: 1,
  sellableTotal: 1,
  page: 1,
  pageSize: 100,
  items: [
    {
      id: 7,
      name: 'یک‌ماهه',
      badge: null,
      buttonStyle: null,
      priceIrr: 9_000_000,
      durationDays: 30,
      volumeGb: null,
      userLimit: null,
      status: 'ACTIVE',
      sortOrder: 0,
      rowIndex: null,
      deliveryNote: null,
      productDeliveryNote: null,
      product: {
        id: 3,
        code: 'gpt',
        name: 'چت‌جی‌پی‌تی',
        kind: 'ai_account',
        status: 'ACTIVE',
        description: null,
        sortOrder: 0,
        categoryId: 1,
        resellersOnly: false,
        oncePerUser: false,
        groupIds: null,
      },
      provider: null,
      categoryName: 'اکانت‌ها',
      ordersCount: 0,
    },
  ],
  providers: [],
}));
const addStockBulk = vi.fn(async (_b: { planId: number; text: string }) => ({
  ok: true,
  added: 0,
  skipped: [],
}));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      stock: () => stock(),
      products: () => products(),
      addStockBulk: (b: { planId: number; text: string }) => addStockBulk(b),
    },
  };
});

/**
 * A File whose `text()` this test decides when to settle.
 *
 * happy-dom's own File resolves on its own schedule, which is exactly the thing
 * being pinned here — the test has to hold one read open while another
 * finishes, or it is asserting nothing about the order.
 */
function slowFile(name: string, body: string) {
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const file = new File([body], name, { type: 'text/csv' });
  Object.defineProperty(file, 'text', {
    value: async () => {
      await gate;
      return body;
    },
  });
  return { file, release };
}

const draw = () =>
  render(
    <RoleProvider role="ADMIN">
      <StockPage />
    </RoleProvider>,
  );

async function openBulkForm() {
  draw();
  await waitFor(() => expect(products).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'افزودن گروهی' }));
  return document.querySelector('#bulk-text') as HTMLTextAreaElement;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('filling a shelf from a file', () => {
  it('drops a read that lands after a newer one', async () => {
    const box = await openBulkForm();
    const picker = document.querySelector('#bulk-file') as HTMLInputElement;

    const first = slowFile('old.csv', 'old@mail.test,OLD-PASSWORD');
    const second = slowFile('new.csv', 'new@mail.test,NEW-PASSWORD');

    fireEvent.change(picker, { target: { files: [first.file] } });
    fireEvent.change(picker, { target: { files: [second.file] } });

    // The second pick finishes first, then the first one comes back late.
    second.release();
    await waitFor(() => expect(box.value).toContain('NEW-PASSWORD'));
    first.release();
    await new Promise((r) => setTimeout(r, 0));

    // The stale read must not have replaced it. Without the guard the operator
    // presses «افزودن به قفسه» on OLD-PASSWORD while reading NEW-PASSWORD.
    expect(box.value).toContain('NEW-PASSWORD');
    expect(box.value).not.toContain('OLD-PASSWORD');
  });

  it('lets typing win over a file still being read', async () => {
    const box = await openBulkForm();
    const picker = document.querySelector('#bulk-file') as HTMLInputElement;

    const picked = slowFile('slow.csv', 'file@mail.test,FROM-FILE');
    fireEvent.change(picker, { target: { files: [picked.file] } });
    fireEvent.change(box, { target: { value: 'typed@mail.test,TYPED' } });

    picked.release();
    await new Promise((r) => setTimeout(r, 0));

    expect(box.value).toBe('typed@mail.test,TYPED');
  });
});
