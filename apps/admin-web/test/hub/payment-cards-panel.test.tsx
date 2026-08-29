/**
 * The card row, and the click that a background save used to eat.
 *
 * Found by walking the screen on 2026-08-29, not by reasoning about it. Typing
 * a label and then pressing «روشن کن» wrote the label and left the card off:
 * the label saves on blur, the blur handler raised the panel-wide `busy` flag,
 * every button in the row carries `disabled={busy}`, and the click that was
 * already on its way landed on a disabled button. Nothing failed, nothing was
 * reported, and the card simply stayed as it was.
 *
 * The panel-wide flag exists so two writes cannot overlap, which mattered while
 * the route did a read-modify-write of the whole row. The route now writes only
 * the fields the body named, so a label save and a status change no longer have
 * an opinion about each other and the label save can stay out of the way.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PaymentCardsPanel } from '../../src/hub/AccountsView.js';

const CARD = {
  id: 'card-1',
  card_digits: '5047061674560137',
  display: '5047-0616-7456-0137',
  label: null,
  status: 'ACTIVE',
  display_weight: 1,
  bank_name: 'SHAHR',
  luhn_ok: true,
};

/** Every PATCH the panel sent, in order, as `[url, parsedBody]`. */
let sent: [string, Record<string, unknown>][] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        sent.push([url, JSON.parse(String(init.body))]);
        return { ok: true, status: 200, json: async () => ({ ok: true }) } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, items: [CARD] }),
      } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('editing a card', () => {
  it('saves a typed label AND the button pressed straight afterwards', async () => {
    render(<PaymentCardsPanel accountId="acc-1" />);
    await screen.findByText('5047-0616-7456-0137');

    const label = screen.getByLabelText('نام دلخواه');
    fireEvent.change(label, { target: { value: 'شهر - پویان' } });
    // Blur and click, in the order a real hand produces them: pressing a button
    // blurs the field first. The blur must not disable the button under it.
    fireEvent.blur(label);
    fireEvent.click(screen.getByRole('button', { name: 'خاموش کن' }));

    await waitFor(() => expect(sent).toHaveLength(2));
    expect(sent.map(([, body]) => body)).toEqual([
      { label: 'شهر - پویان' },
      { status: 'DISABLED' },
    ]);
  });

  it('sends only the field that changed, so one save cannot revert another', async () => {
    render(<PaymentCardsPanel accountId="acc-1" />);
    await screen.findByText('5047-0616-7456-0137');

    fireEvent.click(screen.getByRole('button', { name: 'خاموش کن' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]![1]).toEqual({ status: 'DISABLED' });
  });

  it('does not save a label the operator did not change', async () => {
    render(<PaymentCardsPanel accountId="acc-1" />);
    await screen.findByText('5047-0616-7456-0137');

    fireEvent.blur(screen.getByLabelText('نام دلخواه'));

    expect(sent).toHaveLength(0);
  });
});
