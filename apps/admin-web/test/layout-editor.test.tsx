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
 *
 * The gestures are driven through the KEYBOARD path wherever both would do.
 * Not because dragging matters less — it is the gesture an admin actually
 * uses — but because both call the same `move()`, and jsdom's drag events carry
 * no real dataTransfer, so a suite written entirely on drags would be testing
 * the event plumbing rather than the moves. One drag test is here for the
 * plumbing.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { LayoutEditor, type LayoutButton } from '../src/pages/LayoutEditor.js';
import type { LayoutItem, LayoutScope } from '../src/api.js';

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
      <LayoutEditor
        scope="category:7"
        items={items}
        screenText="کدام را می‌خواهید؟"
        onSaved={() => {}}
      />
    </RoleProvider>,
  );
}

/** The chip carrying this label. */
function chip(label: string): HTMLElement {
  return screen.getByText(label).closest('.kb-chip') as HTMLElement;
}

/** Move a chip with the arrow keys — the same `move()` a drag calls. */
function press(label: string, key: string) {
  fireEvent.keyDown(chip(label), { key });
}

function saveButton(): HTMLElement {
  return screen.getByRole('button', { name: 'ذخیرهٔ چیدمان' });
}

async function save() {
  fireEvent.click(saveButton());
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
    press('سه ماهه', 'ArrowUp');
    const [scope, items] = await save();

    expect(scope).toBe('category:7');
    expect(items.map((i) => i.id).sort()).toEqual([11, 22, 33]);
  });

  it('makes the array order the column order', async () => {
    // Nothing about `sortOrder` is sent; the position in this array IS the
    // position on the row, which deletes the whole class of «two buttons claim
    // column 2».
    draw();
    press('سه ماهه', 'ArrowUp');
    let [, items] = await save();
    expect(items).toEqual([
      { id: 11, rowIndex: 0 },
      { id: 22, rowIndex: 0 },
      { id: 33, rowIndex: 1 },
    ]);

    // Right is BACK in an RTL row, so this is «one place earlier».
    press('سه ماهه', 'ArrowRight');
    [, items] = await save();
    expect(items).toEqual([
      { id: 22, rowIndex: 0 },
      { id: 11, rowIndex: 0 },
      { id: 33, rowIndex: 1 },
    ]);
  });

  it('lands a dragged button in front of the one it was dropped on', async () => {
    // The plumbing test. Everything else here goes through the keyboard, so
    // this is what would notice if `onDragStart` stopped recording which chip
    // is moving, or the row stopped accepting the drop.
    draw();
    fireEvent.dragStart(chip('شش ماهه'));
    fireEvent.dragOver(chip('یک ماهه'));
    fireEvent.drop(chip('یک ماهه'));

    const [, items] = await save();
    expect(items).toEqual([
      { id: 33, rowIndex: 0 },
      { id: 11, rowIndex: 0 },
      { id: 22, rowIndex: 1 },
    ]);
  });

  it('never sends a gap or a row that goes backwards', async () => {
    // Not a restatement of the server's rule — it is why this editor works in
    // rows instead of in numbers. Serialising from the rows renumbers them, so
    // the state is unreachable rather than refused.
    draw();
    press('یک ماهه', 'ArrowDown');
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

  it('will not save a screen nobody changed', () => {
    // An arrangement that was only looked at is not an edit, and posting it
    // would write an audit row saying the shop had been rearranged.
    draw();
    expect(saveButton()).toHaveProperty('disabled', true);
    press('سه ماهه', 'ArrowUp');
    expect(saveButton()).toHaveProperty('disabled', false);
  });

  it('refuses a ninth button on a row Telegram would reject', () => {
    // The read path clamps this too (`groupIntoRows`), the route refuses it,
    // and the CHECK constraint bounds the column. This is the first of the
    // four, and the only one that stops an admin producing the state at all: a
    // keyboard Telegram rejects takes the whole message down, not one button.
    const eight: LayoutButton[] = Array.from({ length: 8 }, (_, n) => ({
      id: n + 1,
      label: `دکمه ${n + 1}`,
      rowIndex: 0,
    }));
    draw([...eight, { id: 9, label: 'نهم', rowIndex: 1 }]);

    press('نهم', 'ArrowUp');
    // The move was refused, so nothing changed, so there is nothing to save.
    expect(saveButton()).toHaveProperty('disabled', true);
  });
});
