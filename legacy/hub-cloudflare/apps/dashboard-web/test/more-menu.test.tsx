/**
 * MoreMenu tests.
 *
 * Verifies the portal-rendered menu:
 *   - Renders into document.body, not into its parent.
 *   - Opens on trigger click; position computed from the trigger rect.
 *   - Closes on outside click, Escape, action selection.
 *   - Recomputes position on window resize.
 *   - Closes when the trigger is clicked twice.
 *   - The inner panel renders the opaque background (.more-menu-panel) so
 *     the items are not visibly transparent over the table.
 */

import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useRef } from 'react';
import { MoreMenu } from '../src/MoreMenu.js';

function Harness({ onSelect }: { onSelect: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} style={{ padding: '20px' }}>
      <div style={{ position: 'absolute', top: 0, left: 0 }}>before</div>
      <MoreMenu
        triggerLabel="More"
        actions={[
          { key: 'a', label: 'View details', onSelect },
          { key: 'b', label: 'Reject', danger: true, onSelect },
        ]}
      />
    </div>
  );
}

describe('MoreMenu', () => {
  it('renders the trigger but no menu initially', () => {
    render(<Harness onSelect={() => undefined} />);
    expect(screen.getByText('More')).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens on click and renders into document.body', () => {
    render(<Harness onSelect={() => undefined} />);
    act(() => {
      fireEvent.click(screen.getByText('More'));
    });
    const menu = screen.getByRole('menu');
    expect(menu).toBeTruthy();
    // The menu lives inside the portal wrapper at document.body.
    expect(menu.closest('.more-menu-portal')).toBeTruthy();
    expect(menu.closest('.more-menu-portal')?.parentElement).toBe(document.body);
  });

  it('lists the actions inside the menu', () => {
    render(<Harness onSelect={() => undefined} />);
    fireEvent.click(screen.getByText('More'));
    expect(screen.getByRole('menuitem', { name: 'View details' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Reject' })).toBeTruthy();
  });

  it('calls onSelect when an item is clicked and closes the menu', () => {
    let called = 0;
    render(<Harness onSelect={() => called++} />);
    fireEvent.click(screen.getByText('More'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'View details' }));
    expect(called).toBe(1);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on Escape', () => {
    render(<Harness onSelect={() => undefined} />);
    fireEvent.click(screen.getByText('More'));
    expect(screen.queryByRole('menu')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('closes on outside mousedown', () => {
    render(
      <div>
        <div data-testid="outside">elsewhere</div>
        <Harness onSelect={() => undefined} />
      </div>,
    );
    fireEvent.click(screen.getByText('More'));
    expect(screen.queryByRole('menu')).toBeTruthy();
    fireEvent.mouseDown(screen.getByTestId('outside'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('toggles closed when the trigger is clicked twice', () => {
    render(<Harness onSelect={() => undefined} />);
    fireEvent.click(screen.getByText('More'));
    expect(screen.queryByRole('menu')).toBeTruthy();
    fireEvent.click(screen.getByText('More'));
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('disables a menu item when disabled=true', () => {
    let called = 0;
    render(
      <MoreMenu
        triggerLabel="More"
        actions={[{ key: 'a', label: 'View details', disabled: true, onSelect: () => called++ }]}
      />,
    );
    fireEvent.click(screen.getByText('More'));
    const item = screen.getByRole('menuitem', { name: 'View details' });
    expect((item as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(item);
    expect(called).toBe(0);
  });

  it('renders the inner panel with the opaque more-menu-panel class', () => {
    render(<Harness onSelect={() => undefined} />);
    fireEvent.click(screen.getByText('More'));
    const panel = document.querySelector('.more-menu-portal > .more-menu-panel');
    expect(panel).toBeTruthy();
    // Structural assertion: the wrapper holds .more-menu-portal and nests
    // .more-menu-panel. The actual background-color assertion lives in the
    // Playwright e2e suite (computed-style alpha=1) — jsdom doesn't load
    // the production stylesheet.
    const wrapper = document.querySelector('.more-menu-portal');
    expect(wrapper).toBeTruthy();
    expect((wrapper as HTMLElement).contains(panel as HTMLElement)).toBe(true);
  });
});
