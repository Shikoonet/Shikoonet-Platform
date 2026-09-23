/**
 * The page says when it is older than the server — 1 Mehr 1405, a tab opened
 * before the morning's release sent the old request and opened the books at
 * 15:22 instead of midnight.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { VersionBadge } from '../src/VersionBadge.js';

let served: string;
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, version: served, env: 'production' })));

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockClear();
  served = 'aaaaaaa1111';
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('VersionBadge', () => {
  it('stays quiet while the server runs the build this page was loaded with', async () => {
    render(<VersionBadge />);
    expect(await screen.findByText('vaaaaaaa')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(5 * 60 * 1000));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    expect(screen.queryByTestId('new-version')).toBeNull();
  });

  it('asks the operator to reload once the server has moved on', async () => {
    render(<VersionBadge />);
    await screen.findByText('vaaaaaaa');
    served = 'bbbbbbb2222';
    await act(() => vi.advanceTimersByTimeAsync(2 * 60 * 1000 + 1));
    const banner = await screen.findByTestId('new-version');
    expect(banner.textContent).toContain('bbbbbbb');
    expect(banner.textContent).toContain('تازه کردن صفحه');
    // The badge itself still names the build this page is running.
    expect(screen.getByText('vaaaaaaa')).toBeTruthy();
  });
});
