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
  holder_name: null,
  status: 'ACTIVE',
  queue_position: 3,
  held_until: null,
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
  it('saves a typed holder name AND the button pressed straight afterwards', async () => {
    render(<PaymentCardsPanel accountId="acc-1" accountActive audience={1} />);
    await screen.findByText('5047-0616-7456-0137');

    const name = screen.getByLabelText('نام صاحب کارت — روی فاکتور مشتری');
    fireEvent.change(name, { target: { value: 'پویان بهمن' } });
    // Blur and click, in the order a real hand produces them: pressing a button
    // blurs the field first. The blur must not disable the button under it.
    fireEvent.blur(name);
    fireEvent.click(screen.getByRole('button', { name: 'خاموش کن' }));

    await waitFor(() => expect(sent).toHaveLength(2));
    // `holderName`, the column the bot's invoice reads — not `label`, which
    // this field wrote until 0068 while the invoice never looked at it.
    expect(sent.map(([, body]) => body)).toEqual([
      { holderName: 'پویان بهمن' },
      { status: 'DISABLED' },
    ]);
  });

  it('sends only the field that changed, so one save cannot revert another', async () => {
    render(<PaymentCardsPanel accountId="acc-1" accountActive audience={1} />);
    await screen.findByText('5047-0616-7456-0137');

    fireEvent.click(screen.getByRole('button', { name: 'خاموش کن' }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]![1]).toEqual({ status: 'DISABLED' });
  });

  it('does not save a name the operator did not change', async () => {
    render(<PaymentCardsPanel accountId="acc-1" accountActive audience={1} />);
    await screen.findByText('5047-0616-7456-0137');

    fireEvent.blur(screen.getByLabelText('نام صاحب کارت — روی فاکتور مشتری'));

    expect(sent).toHaveLength(0);
  });
});

/**
 * The badge is the only place a card's real state is written down.
 *
 * `rotateCard` requires the card to be ACTIVE **and** its account to be in
 * service. So a card that is ACTIVE on an account somebody switched off is one
 * the bot will never hand out — and while the badge read `pc.status` alone it
 * said «در گردش» about exactly that card. Sam's «کارت‌ها را نشان نداد» had no
 * screen that could explain it.
 */
describe('what the badge says when the account is off', () => {
  it('does not claim a card is in rotation when its account is not', async () => {
    render(<PaymentCardsPanel accountId="acc-1" accountActive={false} audience={1} />);
    await screen.findByText('5047-0616-7456-0137');

    // Neither «در گردش» (a lie) nor «خاموش» (true of the card, and it points
    // the operator at the wrong switch).
    expect(screen.queryByText('در گردش')).toBeNull();
    expect(await screen.findByText('حساب خاموش است')).toBeTruthy();
  });

  it('still says «در گردش» when both switches are on', async () => {
    render(<PaymentCardsPanel accountId="acc-1" accountActive audience={1} />);
    expect(await screen.findByText('در گردش')).toBeTruthy();
  });

  it('names the customer switch when that is the one that is off (0090)', async () => {
    render(<PaymentCardsPanel accountId="acc-1" accountActive audience={0} />);
    await screen.findByText('5047-0616-7456-0137');

    expect(screen.queryByText('در گردش')).toBeNull();
    expect(screen.queryByText('حساب خاموش است')).toBeNull();
    expect(await screen.findByText('پنهان از مشتری')).toBeTruthy();
  });

  it('says a reseller-only card is in rotation for resellers, not customers (0104)', async () => {
    render(<PaymentCardsPanel accountId="acc-1" accountActive audience={2} />);

    expect(await screen.findByText('در گردش نماینده')).toBeTruthy();
    expect(screen.queryByText('در گردش')).toBeNull();
    expect(screen.queryByText('پنهان از مشتری')).toBeNull();
  });
});

/**
 * The bakery queue, on the screen. `display_weight` left with migration 0064
 * — a plain queue has nothing for a weight to divide — and what replaced the
 * select is the two facts an operator asks about: where the card stands, and
 * whether a customer has it right now. Both come from the route, already
 * computed the way the bot computes them.
 */
describe('the queue badges', () => {
  it('shows the card’s place in the line, and no weight control', async () => {
    render(<PaymentCardsPanel accountId="acc-1" accountActive audience={1} />);
    await screen.findByText('5047-0616-7456-0137');

    expect(screen.getByText('نوبت ۳')).toBeTruthy();
    expect(screen.queryByLabelText('سهم از نمایش')).toBeNull();
  });

  it('says a customer has the card while an invoice holds it', async () => {
    vi.mocked(fetch).mockImplementation(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ ok: true, items: [{ ...CARD, held_until: Date.UTC(2026, 8, 15, 10, 0) }] }),
      }) as Response,
    );
    render(<PaymentCardsPanel accountId="acc-1" accountActive audience={1} />);
    await screen.findByText('5047-0616-7456-0137');

    // The help text below the list says the same words; the badge is the claim.
    expect(screen.getByText(/در دست مشتری تا/, { selector: '.badge' })).toBeTruthy();
  });

  it('shows neither for a card that is off — it is not in the line', async () => {
    render(<PaymentCardsPanel accountId="acc-1" accountActive={false} audience={1} />);
    await screen.findByText('5047-0616-7456-0137');

    expect(screen.queryByText(/نوبت/, { selector: '.badge' })).toBeNull();
  });
});
