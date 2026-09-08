/**
 * WHERE the two halves of continuity mode are drawn, which is a correctness
 * question and not a cosmetic one.
 *
 * The strip used to be a flex item inside `.shikoonet-header__right`. That div
 * is the `auto` track of `.shikoonet-header__bar`'s two-column grid, so the
 * strip's own content width set the track — and the `minmax(0, 1fr)` track
 * beside it, the one holding the payment tabs, measured **zero pixels** on a
 * 1440px viewport. The warning about continuity mode removed the navigation of
 * the screen it was warning about.
 *
 * jsdom computes no layout, so this asserts the CONTAINMENT that caused it
 * rather than the width that resulted. That is the durable half: any future
 * change that puts the strip back inside the controls row fails here, and the
 * zero-width follows from the containment, not the other way round.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { ContinuityBanner, ContinuityButton } from '../../src/hub/ContinuityBanner.js';
import { App } from '../../src/App.js';
import { RoleProvider } from '../../src/role.js';

const ON = {
  mode: 'CONTINUITY' as const,
  expiresAt: Date.now() + 3_600_000,
  activatedBy: 'someone@example.com',
  reason: 'relay down',
};
const OFF = { mode: 'NORMAL' as const, expiresAt: null, activatedBy: null, reason: null };

const noop = async () => {};

function draw(node: React.ReactNode) {
  return render(<RoleProvider role="ADMIN">{node}</RoleProvider>);
}

beforeEach(() => vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000));
afterEach(() => vi.restoreAllMocks());

describe('the strip and the button are two different things', () => {
  it('the strip draws nothing while the shop is NORMAL, so the header gains no empty row', () => {
    const { container } = draw(<ContinuityBanner state={OFF} onChanged={noop} />);
    expect(container.querySelector('.continuity-banner')).toBeNull();
  });

  it('the button draws nothing while the mode is ON — there is nothing to turn on', () => {
    const { container } = draw(<ContinuityButton state={ON} onChanged={noop} />);
    expect(container.querySelector('.continuity-open')).toBeNull();
  });

  it('neither draws before the first read answers', () => {
    const { container } = draw(
      <>
        <ContinuityButton state={null} onChanged={noop} />
        <ContinuityBanner state={null} onChanged={noop} />
      </>,
    );
    expect(container.querySelector('.continuity-banner')).toBeNull();
    expect(container.querySelector('.continuity-open')).toBeNull();
  });

  it('a REVIEWER sees the warning but is offered no way to change it', () => {
    render(
      <RoleProvider role="REVIEWER">
        <ContinuityBanner state={ON} onChanged={noop} />
      </RoleProvider>,
    );
    expect(screen.getByText('حالت تداوم فعال است')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'خاموش کن' })).toBeNull();
  });
});

describe('latin text inside an RTL strip', () => {
  it('isolates the activating address and the operator’s reason', async () => {
    const { container } = draw(<ContinuityBanner state={ON} onChanged={noop} />);
    await waitFor(() => expect(container.querySelector('.continuity-banner')).not.toBeNull());

    // Without `dir`, these were drawn in a different order from the one they
    // read in — an address and free text a person typed, dropped into an RTL
    // flow.
    expect(container.querySelector('.continuity-banner__by')?.getAttribute('dir')).toBe('auto');
    expect(
      container.querySelector('.continuity-banner__reason [dir]')?.getAttribute('dir'),
    ).toBe('auto');
  });
});

describe('the strip is not in the controls row — the containment that starved the tabs', () => {
  beforeEach(() => {
    // Every panel in the header reads something. The shape does not matter
    // here; what matters is that the header renders far enough to place its
    // children.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown) => {
        const url = String(input);
        /*
         * Two answers, and everything else REFUSED — the pattern
         * `nav.test.tsx` established.
         *
         * Answering every call with one generic body is what broke the first
         * version: `/overview` came back shaped like a list, `DashboardPage`
         * read fields that were not there and threw, React unmounted the whole
         * tree, and the assertion reported «expected null not to be null» about
         * a panel that had crashed. A refused request is caught by the screen
         * that made it and the shell still draws — which is the thing under
         * test.
         */
        if (url.endsWith('/me')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, email: 'a@b.c', role: 'ADMIN' }) };
        }
        if (url.includes('/continuity-mode')) {
          return { ok: true, status: 200, json: async () => ({ ok: true, ...ON }) };
        }
        return Promise.reject(new Error('not stubbed'));
      }),
    );
  });

  it('renders the banner outside the header controls, and the header keeps its row', { timeout: 15_000 }, async () => {
    /*
     * Rewritten on 2026-09-08 when the two shells became one.
     *
     * The bug and the assertion are unchanged: the strip must not be a flex
     * item beside the controls, because there its own content width sets the
     * track and the one next to it — the payment tabs — collapses to zero. Only
     * the header it is placed in changed, from `.shikoonet-header` to the
     * panel's own `.app-header`, so the test now drives `<App/>`. Asserting
     * against a component that no longer renders would have been a test that
     * passes about nothing.
     */
    const { container } = render(<App />);
    await waitFor(() => expect(container.querySelector('.continuity-banner')).not.toBeNull());

    // THE assertion, in its new home.
    expect(container.querySelector('.app-header__tools .continuity-banner')).toBeNull();
    expect(container.querySelector('.app-header .continuity-banner')).toBeNull();
    // A sibling of the header, not a descendant of it.
    expect(container.querySelector('header.app-header + .continuity-banner')).not.toBeNull();
    // And the row that would have been starved still exists to be measured.
    expect(container.querySelector('.app-header__tools')).not.toBeNull();
  });
});
