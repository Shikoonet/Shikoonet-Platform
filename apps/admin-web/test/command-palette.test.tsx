/**
 * One way to reach any of the thirty-one screens, and any customer on them.
 *
 * The 2026-09-07 review called cross-navigation the panel's central gap: thirty-one
 * sections, seven sidebar groups, and no way to say where you want to be. Slice 2
 * gave the rows doors; this gives the keyboard one.
 *
 * The sources are deliberately two and not five. A section is the thing an operator
 * asks for by name a hundred times a day, and a customer is the thing they arrive
 * holding — a telegram id pasted out of a support chat. Anything else is a screen
 * with its own search box already on it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommandPalette } from '../src/CommandPalette.js';
import type { PageId } from '../src/nav.js';

const customers = vi.fn(async (_p: unknown) => ({
  ok: true,
  total: 1,
  page: 1,
  pageSize: 5,
  items: [{ id: 7, telegramId: 7137494513, username: 'reza_kh', balanceIrr: 0 }],
}));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return { ...actual, api: { ...actual.api, customers: (p: unknown) => customers(p) } };
});

const go = vi.fn();
const draw = (opts: { visible?: (id: PageId) => boolean } = {}) =>
  render(<CommandPalette go={go} visible={opts.visible ?? (() => true)} />);

const openIt = () => fireEvent.keyDown(document, { key: 'k', ctrlKey: true });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  go.mockClear();
  customers.mockClear();
});

describe('the command palette', () => {
  it('opens on Ctrl+K and closes on Escape', () => {
    draw();
    expect(document.querySelector('dialog[open]')).toBeNull();
    openIt();
    expect(document.querySelector('dialog[open]')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.querySelector('dialog[open]')).toBeNull();
  });

  it('opens on «/» — but not while someone is typing into a field', () => {
    // Otherwise the slash key becomes unusable in every search box on the
    // panel, which is a worse trade than not having the shortcut.
    const { container } = draw();
    const field = document.createElement('input');
    container.appendChild(field);
    field.focus();
    fireEvent.keyDown(document, { key: '/' });
    expect(document.querySelector('dialog[open]')).toBeNull();

    field.blur();
    fireEvent.keyDown(document, { key: '/' });
    expect(document.querySelector('dialog[open]')).toBeTruthy();
  });

  it('goes to a section named in Persian', async () => {
    draw();
    openIt();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'کاربر' } });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(go).toHaveBeenCalledWith('customers');
  });

  it('offers only the sections this role may open', async () => {
    // The sidebar is filtered by role and this must be too, or the palette is a
    // door around it that answers 403.
    draw({ visible: (id) => id !== 'customers' });
    openIt();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'کاربر' } });
    expect(screen.queryByText('کاربران')).toBeNull();
  });

  it('finds a customer by telegram id and opens their card', async () => {
    draw();
    openIt();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '7137494513' } });

    await waitFor(() => expect(customers).toHaveBeenCalled());
    expect(customers.mock.calls[0]![0]).toMatchObject({ q: '7137494513', page: 1, pageSize: 5 });

    const hit = await screen.findByText(/reza_kh/);
    fireEvent.click(hit);
    expect(go).toHaveBeenCalledWith('customers', '?id=7');
  });

  it('asks the server once for a word typed one letter at a time', async () => {
    /*
     * Six keystrokes is six requests without a debounce, against a table with
     * fifteen thousand rows in it.
     *
     * The clock is advanced BETWEEN the keystrokes, and that is the whole test.
     * Written without it — six `fireEvent.change` calls in one tick — it passed
     * with `DEBOUNCE_MS` set to zero, because the effect cleanup clears the
     * previous timer before it can fire whatever the delay is. It proved the
     * cleanup and called it a debounce.
     *
     * 100ms apart, under the 250ms window: a real debounce collapses all six
     * into one, and no debounce at all sends six.
     */
    draw();
    openIt();
    const box = screen.getByRole('textbox');
    for (const v of ['7', '71', '713', '7137', '71374', '713749']) {
      fireEvent.change(box, { target: { value: v } });
      vi.advanceTimersByTime(100);
    }
    await waitFor(() => expect(customers).toHaveBeenCalled());
    expect(customers.mock.calls.length).toBe(1);
    expect(customers.mock.calls[0]![0]).toMatchObject({ q: '713749' });
  });

  it('does not ask about one letter', () => {
    draw();
    openIt();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '7' } });
    vi.advanceTimersByTime(1000);
    expect(customers).not.toHaveBeenCalled();
  });

  it('moves the selection with the arrow keys', () => {
    draw();
    openIt();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'آمار' } });
    // Two sections match: «آمار فروشگاه» and «آمار مالی». The second one is
    // reachable only if the arrow moves.
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(go).toHaveBeenCalledWith('statistics');
  });
});
