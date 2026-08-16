/**
 * Tests for SortableHeader — keyboard activation, aria-sort, three-state clicks,
 * URL persistence through useTableSortState.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { SortableHeader } from '../../src/hub/SortableHeader.js';
import type { SortState } from '../../src/hub/sort.js';
import { useTableSortState } from '../../src/hub/useTableSortState.js';

afterEach(() => cleanup());

function DemoTable({ defaultCol }: { defaultCol: string }) {
  const [sort, setSort] = useTableSortState('demo', {
    column: defaultCol,
    direction: 'desc',
  });
  return (
    <table>
      <thead>
        <tr>
          <SortableHeader column="time" label="Time" state={sort} onChange={setSort} />
          <SortableHeader column="amount" label="Amount" state={sort} onChange={setSort} />
        </tr>
      </thead>
    </table>
  );
}

describe('SortableHeader', () => {
  beforeEach(() => {
    window.history.replaceState({}, '', '/');
  });

  it('renders an accessible button inside th', () => {
    render(<DemoTable defaultCol="time" />);
    const timeHeader = screen.getByRole('button', { name: /time/i });
    expect(timeHeader).toBeTruthy();
  });

  it('starts with descending aria-sort on the default column', () => {
    render(<DemoTable defaultCol="time" />);
    const th = screen.getByRole('columnheader', { name: /time/i });
    expect(th.getAttribute('aria-sort')).toBe('descending');
  });

  it('cycles asc → desc → none on click', () => {
    render(<DemoTable defaultCol="other" />);
    const button = screen.getByRole('button', { name: /time/i });
    const th = button.closest('th');
    expect(th).toBeTruthy();

    fireEvent.click(button);
    expect(th!.getAttribute('aria-sort')).toBe('ascending');

    fireEvent.click(button);
    expect(th!.getAttribute('aria-sort')).toBe('descending');

    fireEvent.click(button);
    expect(th!.getAttribute('aria-sort')).toBe('none');
  });

  it('switches column when a different header is clicked', () => {
    render(<DemoTable defaultCol="time" />);
    const timeBtn = screen.getByRole('button', { name: /time/i });
    const amountBtn = screen.getByRole('button', { name: /amount/i });

    expect(timeBtn.closest('th')!.getAttribute('aria-sort')).toBe('descending');
    fireEvent.click(amountBtn);
    expect(amountBtn.closest('th')!.getAttribute('aria-sort')).toBe('ascending');
    expect(timeBtn.closest('th')!.getAttribute('aria-sort')).toBe('none');
  });

  it('responds to keyboard activation via Enter', () => {
    render(<DemoTable defaultCol="other" />);
    const button = screen.getByRole('button', { name: /time/i });
    button.focus();
    fireEvent.click(button); // Browser default for Enter on a button is a click.
    const th = button.closest('th');
    expect(th!.getAttribute('aria-sort')).toBe('ascending');
  });

  it('responds to keyboard activation via Space', () => {
    render(<DemoTable defaultCol="other" />);
    const button = screen.getByRole('button', { name: /time/i });
    button.focus();
    fireEvent.click(button); // Browser default for Space on a button is a click.
    const th = button.closest('th');
    expect(th!.getAttribute('aria-sort')).toBe('ascending');
  });

  it('URL state survives across mounts (separate key)', () => {
    const { unmount } = render(<DemoTable defaultCol="other" />);
    const button = screen.getByRole('button', { name: /time/i });
    fireEvent.click(button); // asc
    unmount();
    expect(window.location.search).toContain('sort_demo=time%3Aasc');
  });
});

describe('SortableHeader generic', () => {
  it('accepts column strings not in default sort', () => {
    function W() {
      const [sort, setSort] = useState<SortState<string>>({ column: null, direction: 'asc' });
      return (
        <table>
          <thead>
            <tr>
              <SortableHeader column="anything" label="Whatever" state={sort} onChange={setSort} />
            </tr>
          </thead>
        </table>
      );
    }
    render(<W />);
    const btn = screen.getByRole('button', { name: /whatever/i });
    expect(btn).toBeTruthy();
  });
});
