/**
 * The arrangement editor, judged by the request body it sends.
 *
 * Two tests this file deliberately does NOT contain, for the reason rule 6
 * gives: reading `rowIndex` back after setting it would pass with the whole
 * serialiser deleted, and comparing the on-screen rows to `groupIntoRows` would
 * compare `groupIntoRows` with itself — the chips ARE that function's output.
 *
 * What is left is the only thing this component is responsible for: turning
 * what an admin did with their hands into the exact array the server writes
 * positions from. Array ORDER is column order and `sortOrder` is never sent, so
 * the body is the whole contract.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { LayoutEditor } from '../src/pages/LayoutEditor.js';
import type { LayoutItem, LayoutScope } from '../src/api.js';
import type { LayoutButton } from '../src/pages/LayoutEditor.js';

const saveCatalogLayout = vi.fn(async (_scope: LayoutScope, _items: LayoutItem[]) => ({ ok: true }));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: { saveCatalogLayout: (s: LayoutScope, i: LayoutItem[]) => saveCatalogLayout(s, i) },
  };
});

/** Three unarranged buttons — the state every screen is in before anybody touches it. */
const THREE: LayoutButton[] = [
  { id: 11, label: 'یک ماهه', hint: '۱۰۰٬۰۰۰ تومان', rowIndex: null },
  { id: 22, label: 'سه ماهه', hint: '۲۵۰٬۰۰۰ تومان', rowIndex: null },
  { id: 33, label: 'شش ماهه', hint: '۴۵۰٬۰۰۰ تومان', rowIndex: null },
];

function draw(items: LayoutButton[] = THREE) {
  render(
    <RoleProvider role="ADMIN">
      <LayoutEditor scope="category:7" items={items} onSaved={() => {}} />
    </RoleProvider>,
  );
}

/** The chip carrying this label, so its own controls can be pressed. */
function chip(label: string): HTMLElement {
  return screen.getByText(label).closest('.preview-button') as HTMLElement;
}

function press(label: string, title: string) {
  fireEvent.click(within(chip(label), title));
}

function within(el: HTMLElement, title: string): HTMLElement {
  const found = el.querySelector(`button[title="${title}"]`);
  if (!found) throw new Error(`no «${title}» on this chip`);
  return found as HTMLElement;
}

async function save() {
  fireEvent.click(screen.getByRole('button', { name: 'ذخیرهٔ چیدمان' }));
  await waitFor(() => expect(saveCatalogLayout).toHaveBeenCalled());
  return saveCatalogLayout.mock.calls.at(-1)!;
}

beforeEach(() => saveCatalogLayout.mockClear());
afterEach(() => vi.restoreAllMocks());

describe('the arrangement editor', () => {
  it('sends every button of the screen, even the ones nobody moved', async () => {
    // A save names the WHOLE screen. The server refuses a partial one, because
    // the rows it was not told about would keep their old positions and
    // interleave with the new ones — so a page that posted only what changed
    // would be refused every time, and correctly.
    draw();
    press('سه ماهه', 'به ردیف بالا');
    const [scope, items] = await save();

    expect(scope).toBe('category:7');
    expect(items.map((i) => i.id).sort()).toEqual([11, 22, 33]);
  });

  it('makes the array order the column order', async () => {
    // Two on the first row, and then swapped. Nothing about `sortOrder` is
    // sent; the position in this array IS the position on the row, which is
    // what deletes the whole class of «two buttons claim column 2».
    draw();
    press('سه ماهه', 'به ردیف بالا');
    let [, items] = await save();
    expect(items).toEqual([
      { id: 11, rowIndex: 0 },
      { id: 22, rowIndex: 0 },
      { id: 33, rowIndex: 1 },
    ]);

    press('سه ماهه', 'یک جا به راست');
    [, items] = await save();
    expect(items).toEqual([
      { id: 22, rowIndex: 0 },
      { id: 11, rowIndex: 0 },
      { id: 33, rowIndex: 1 },
    ]);
  });

  it('never sends a gap or a row that goes backwards', async () => {
    // Not a restatement of the server's rule — it is why the editor works in
    // rows instead of in numbers. Emptying the middle row here would leave
    // rows 0 and 2 in the numbers if positions were stored on the chips;
    // serialising from the rows renumbers them, so the state is unreachable
    // rather than refused.
    draw();
    press('یک ماهه', 'به ردیف پایین');
    const [, items] = await save();

    const rows = items.map((i) => i.rowIndex);
    expect(rows).toEqual([...rows].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(new Set(rows)).toEqual(new Set([0, 1]));
  });

  it('sends null for every button when the arrangement is taken away', async () => {
    // «برداشتن چیدمان» is not «delete the rows» — it is the state a screen
    // ships in, which the bot reads as one button per row.
    const arranged = THREE.map((b, n) => ({ ...b, rowIndex: n === 2 ? 1 : 0 }));
    draw(arranged);
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: 'برداشتن چیدمان' }));

    await waitFor(() => expect(saveCatalogLayout).toHaveBeenCalled());
    const [, items] = saveCatalogLayout.mock.calls.at(-1)!;
    expect(items).toEqual([
      { id: 11, rowIndex: null },
      { id: 22, rowIndex: null },
      { id: 33, rowIndex: null },
    ]);
  });

  it('offers «برداشتن چیدمان» only when there is one to take away', async () => {
    draw();
    expect(screen.getByRole('button', { name: 'برداشتن چیدمان' })).toHaveProperty('disabled', true);
  });

  it('will not put a ninth button on a row Telegram would reject', async () => {
    // The read path clamps this too (`groupIntoRows`), and the route refuses
    // it, and the CHECK constraint bounds the column. This is the first of the
    // four, and the only one that stops an admin producing the state at all: a
    // keyboard Telegram rejects takes the whole message down, not one button.
    const eight = Array.from({ length: 8 }, (_, n) => ({
      id: n + 1,
      label: `دکمه ${n + 1}`,
      rowIndex: 0,
    }));
    draw([...eight, { id: 9, label: 'نهم', rowIndex: 1 }]);
    expect(within(chip('نهم'), 'به ردیف بالا')).toHaveProperty('disabled', true);
  });
});
