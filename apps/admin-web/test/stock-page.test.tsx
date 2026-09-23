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
import { ShelfPapers, StockPage } from '../src/pages/StockPage.js';

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
// The page loads these for the «قفسهٔ تازه» form: a shelf has to be filed under
// a category or it has no button anywhere in the shop.
const productCategories = vi.fn(async () => ({
  ok: true,
  items: [{ id: 1, name: 'اکانت‌ها', badge: null, buttonStyle: null }],
}));
let nextPlanId = 4242;
const createShelf = vi.fn(async (_b: unknown) => ({ ok: true, planId: nextPlanId }));
const shelfAttachments = vi.fn(async (_planId: number) => ({
  ok: true,
  deliveryNote: 'فایل را در OpenVPN Connect وارد کن.',
  items: [
    { id: 1, kind: 'document' as const, fileName: 'client.ovpn', sizeBytes: 4096, createdAt: '' },
    { id: 2, kind: 'video' as const, fileName: 'howto.mp4', sizeBytes: 9_000_000, createdAt: '' },
  ],
}));
const uploadShelfAttachment = vi.fn(
  async (_planId: number, _f: File, _kind: string, _p: (n: number) => void) => ({ id: 3 }),
);

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      stock: () => stock(),
      products: () => products(),
      addStockBulk: (b: { planId: number; text: string }) => addStockBulk(b),
      productCategories: () => productCategories(),
      createShelf: (b: unknown) => createShelf(b),
      shelfAttachments: (id: number) => shelfAttachments(id),
      uploadShelfAttachment: (id: number, f: File, k: string, p: (n: number) => void) =>
        uploadShelfAttachment(id, f, k, p),
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
  nextPlanId = 4242;
});

/** Fills «قفسهٔ تازه» and submits it. */
async function makeShelf(name: string) {
  fireEvent.click(screen.getByRole('button', { name: 'قفسهٔ تازه' }));
  fireEvent.change(document.querySelector('#shelf-name') as HTMLInputElement, {
    target: { value: name },
  });
  fireEvent.change(document.querySelector('#shelf-price') as HTMLInputElement, {
    target: { value: '250000' },
  });
  fireEvent.change(document.querySelector('#shelf-cat') as HTMLSelectElement, {
    target: { value: '1' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'ساختن قفسه' }));
  await waitFor(() =>
    expect(document.querySelector('#bulk-plan') as HTMLSelectElement | null).not.toBeNull(),
  );
}

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

describe('making a shelf', () => {
  it('opens the fill form ON the shelf it just made', async () => {
    // The plan list is fetched again after a shelf is created. Until it
    // arrives the picker does not contain the new shelf at all, so an operator
    // who does not wait picks from the shelves that ARE listed — every one of
    // them the wrong one — and the accounts land somewhere they were never
    // meant to be.
    draw();
    await waitFor(() => expect(products).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'قفسهٔ تازه' }));

    fireEvent.change(document.querySelector('#shelf-name') as HTMLInputElement, {
      target: { value: 'اسپاتیفای' },
    });
    fireEvent.change(document.querySelector('#shelf-price') as HTMLInputElement, {
      target: { value: '250000' },
    });
    fireEvent.change(document.querySelector('#shelf-cat') as HTMLSelectElement, {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'ساختن قفسه' }));

    await waitFor(() => expect(createShelf).toHaveBeenCalled());
    // Toman on the screen, IRR on the wire.
    expect(createShelf).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'اسپاتیفای', priceIrr: 2_500_000, categoryId: 1, userLimit: 1 }),
    );

    const picker = await waitFor(() => {
      const el = document.querySelector('#bulk-plan') as HTMLSelectElement | null;
      expect(el).not.toBeNull();
      return el!;
    });
    // The id the server returned, selected — not «انتخاب کنید…», and not some
    // other shelf that happened to be in the stale list.
    expect(picker.value).toBe('4242');
  });
});

describe('a second shelf does not inherit the first one', () => {
  it('starts the fill form over, on the shelf just made', async () => {
    // The fill form stays open after a successful paste, on purpose. Make
    // shelf A, fill it, make shelf B — the banner says B, and without a fresh
    // form the picker and the pasted text are still A's. B's accounts land on
    // A's shelf, and each one is a live credential the next person to buy A
    // receives.
    draw();
    await waitFor(() => expect(products).toHaveBeenCalled());

    await makeShelf('اسپاتیفای');
    const box = document.querySelector('#bulk-text') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'spot@mail.test,SPOT' } });
    expect((document.querySelector('#bulk-plan') as HTMLSelectElement).value).toBe('4242');

    nextPlanId = 5353;
    await makeShelf('اوپن‌وی‌پی‌ان');

    const picker = document.querySelector('#bulk-plan') as HTMLSelectElement;
    const text = document.querySelector('#bulk-text') as HTMLTextAreaElement;
    expect(picker.value).toBe('5353');
    expect(text.value).toBe('');
  });
});

/**
 * The papers on a shelf (#377). What the server refuses is asserted there
 * (`shelf-attachments.test.ts`); what only the browser can do is refuse the
 * 48 MiB file BEFORE sending a byte of it, and pick the kind from the file.
 */
describe('a shelf’s papers', () => {
  async function openPapers() {
    stock.mockResolvedValueOnce({
      ok: true,
      total: 0,
      page: 1,
      pageSize: 50,
      items: [],
      shelves: [
        {
          planId: 7,
          planName: 'یک‌ماهه',
          productName: 'OpenVPN',
          available: 3,
          reserved: 0,
          used: 1,
          attachments: 2,
        },
      ] as never[],
    });
    draw();
    fireEvent.click(await screen.findByRole('button', { name: 'پیوست‌ها (۲)' }));
    await waitFor(() => expect(shelfAttachments).toHaveBeenCalledWith(7));
    await screen.findByText('client.ovpn');
    return screen.getByLabelText(/^فایل \(مثلاً \.ovpn\)/) as HTMLInputElement;
  }

  it('shows the note and the files in order, and sends a video as a video', async () => {
    const input = await openPapers();
    expect((screen.getByLabelText('توضیح — زیر پیام تحویل') as HTMLTextAreaElement).value).toBe(
      'فایل را در OpenVPN Connect وارد کن.',
    );
    const names = [...document.querySelectorAll('td.ltr')].map((td) => td.textContent);
    expect(names).toEqual(['client.ovpn', 'howto.mp4']);

    const video = new File(['x'], 'setup.mp4', { type: 'video/mp4' });
    fireEvent.change(input, { target: { files: [video] } });
    await waitFor(() => expect(uploadShelfAttachment).toHaveBeenCalledTimes(1));
    expect(uploadShelfAttachment.mock.calls[0]![2]).toBe('video');
  });

  it('refuses a file past 48 MiB before uploading it', async () => {
    const input = await openPapers();
    const big = new File([''], 'big.mp4', { type: 'video/mp4' });
    Object.defineProperty(big, 'size', { value: 48 * 1024 * 1024 + 1 });
    fireEvent.change(input, { target: { files: [big] } });
    await screen.findByText(/در کانال بگذارش/);
    expect(uploadShelfAttachment).not.toHaveBeenCalled();
  });
});

/*
 * «سرویس‌ها» can have two services' drawers open at once, each with its own
 * papers card. With one fixed id per page, the second card's label pointed at
 * the FIRST card's input, and the file was filed under the other config
 * (CodeRabbit on #428). Each card owns its inputs now.
 */
describe('two papers cards on one page', () => {
  it('sends each card\'s file to its own plan', async () => {
    render(
      <RoleProvider role="ADMIN">
        <ShelfPapers shelf={{ planId: 7, planName: 'یک', productName: 'A' }} onClose={() => {}} onChanged={() => {}} withNote={false} />
        <ShelfPapers shelf={{ planId: 8, planName: 'دو', productName: 'B' }} onClose={() => {}} onChanged={() => {}} withNote={false} />
      </RoleProvider>,
    );
    await waitFor(() => expect(shelfAttachments).toHaveBeenCalledWith(8));

    const inputs = screen.getAllByLabelText(/^فایل \(مثلاً \.ovpn\)/) as HTMLInputElement[];
    expect(inputs).toHaveLength(2);
    expect(inputs[0]!.id).not.toBe(inputs[1]!.id);

    // Through the SECOND card's label — the path that used to reach the first.
    fireEvent.change(inputs[1]!, { target: { files: [new File(['x'], 'two.ovpn')] } });
    await waitFor(() => expect(uploadShelfAttachment).toHaveBeenCalledTimes(1));
    expect(uploadShelfAttachment.mock.calls[0]![0]).toBe(8);
  });
});
