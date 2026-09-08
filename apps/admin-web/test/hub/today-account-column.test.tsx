/**
 * The account column in «امروز» must not break an account number across lines.
 *
 * Walking staging at 1440px on 2026-09-07, the wide layout drew
 * «Auto: ****57.1» as three lines — `Auto:` / `****57.` / `1` — and the
 * identifier beside it as `10.5718857.` / `1`. A masked account number split
 * after a dot does not read as one value; it reads as two, and this is the
 * column an operator uses to decide whether a bank transfer belongs to the
 * claim in front of them.
 *
 * The compact layout (1200–1439px) already had this right: `AccountCell` caps
 * the display with `table-ellipsis` and hands the whole value to `title`. The
 * wide layout — the one almost everybody uses — printed the same string bare
 * into a `<td>` and let the browser wrap it wherever it liked.
 *
 * happy-dom lays nothing out, so what this pins is the contract: the cell
 * carries the class that means «one line, ellipsis, whole value in the
 * tooltip». The rendering itself is confirmed by walking staging.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createCache } from '../../src/hub/query.js';
import { TodayView } from '../../src/hub/TodayView.js';

const ROW = {
  id: 'tx-1',
  direction: 'IN',
  amount_irr: 1_000_000,
  balance_irr: 52_000_000,
  account_display: 'Auto: ****57.1',
  account_hint: '10.5718857.1',
  account_id: 'acc-1',
  device_display_name: 'پویان بابا',
  device_code: 'pouyan-dad',
  sms_ts: Date.parse('2026-09-07T11:43:58Z'),
  received_at: Date.parse('2026-09-07T11:43:56Z'),
  parser_id: 'compact-signed-v1',
  status: 'PROCESSED',
  is_new: false,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stub() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      String(url).includes('/api/v1/today')
        ? new Response(JSON.stringify({ ok: true, count: 1, items: [ROW] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          })
        : new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
    ),
  );
}

describe('the account column in «امروز»', () => {
  it('keeps the account name on one line, with the whole value in the tooltip', async () => {
    stub();
    render(<TodayView cache={createCache()} />);

    // One node holds the whole string. Before this, the value was printed bare
    // and the browser was free to wrap it after «Auto:» and again after the
    // dot inside the masked number.
    const cell = await waitFor(() => screen.getByTitle('Auto: ****57.1'));
    expect(cell.textContent).toBe('Auto: ****57.1');
    expect(cell.className).toContain('table-ellipsis');
  });
});
