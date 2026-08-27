/**
 * The button that reports whether the copy actually happened.
 *
 * `clipboard.test.ts` covers `copyText` itself — the secure-context problem and
 * the `execCommand` fallback. This file covers the only thing the button adds
 * on top of it, which is the part an admin sees: a copy that FAILED must say so.
 * On a panel opened over plain http the clipboard API is absent, and a button
 * that always said «کپی شد» would have somebody paste the previous clipboard
 * into a message to a customer without noticing.
 *
 * The lazy `getText` is tested too, and it is not a micro-optimisation: this
 * button is drawn once per row in a 25-row table, and its payload in that table
 * is a whole event serialised to JSON. Evaluating on render would build all 25
 * for the one click that lands on a single row.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { CopyButton } from '../src/CopyButton.js';
import * as clipboard from '../src/clipboard.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('CopyButton', () => {
  it('copies exactly what the thunk returns', async () => {
    const copy = vi.spyOn(clipboard, 'copyText').mockResolvedValue(true);
    render(<CopyButton getText={() => '7150294821'} label="کپی آیدی" title="t" />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(copy).toHaveBeenCalledWith('7150294821'));
  });

  it('says «کپی شد» only when the copy succeeded', async () => {
    vi.spyOn(clipboard, 'copyText').mockResolvedValue(true);
    render(<CopyButton getText={() => 'x'} label="کپی" title="t" />);

    fireEvent.click(screen.getByRole('button'));

    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('کپی شد'));
  });

  it('says «کپی نشد» when the clipboard refused — the case http produces', async () => {
    vi.spyOn(clipboard, 'copyText').mockResolvedValue(false);
    render(<CopyButton getText={() => 'x'} label="کپی" title="t" />);

    fireEvent.click(screen.getByRole('button'));

    // The assertion that matters: a failed copy must NOT read as a success.
    await waitFor(() => expect(screen.getByRole('button').textContent).toBe('کپی نشد'));
  });

  it('builds its text on the click and not on the render', async () => {
    const getText = vi.fn(() => 'x');
    vi.spyOn(clipboard, 'copyText').mockResolvedValue(true);
    render(<CopyButton getText={getText} label="کپی" title="t" />);

    expect(getText).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button'));
    expect(getText).toHaveBeenCalledTimes(1);

    // Awaited so the state update the click schedules lands inside the test
    // rather than after it, which React reports as an un-acted update.
    await waitFor(() => expect(screen.getByRole('button').textContent).toContain('کپی شد'));
  });
});
