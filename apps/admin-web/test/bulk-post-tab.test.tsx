/**
 * ارسال گروهی: the second tab, and what it must not let an operator do.
 *
 * A broadcast is the least reversible button in the project, and the forward
 * adds one mistake the text path cannot make: a link that points somewhere the
 * operator did not mean. Nothing downstream catches that — the bot would
 * cheerfully forward whatever message really is at that id, to everybody.
 *
 * So the screen's job is to say what it understood BEFORE the press, and to
 * refuse to arm the button until it understood something. Both are asserted
 * here, along with the shape actually sent, because the page and the route
 * parse the same link with the same function and this is what proves the page
 * hands over the raw link rather than a re-derived guess.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BulkPage } from '../src/pages/BulkPage.js';

let sent: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        sent.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return {
          ok: true,
          status: 200,
          json: async () => ({ ok: true, queued: 3, reach: 3 }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, reach: 3, credit: null, broadcast: null, items: [] }),
      } as Response;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * The «پیام همگانی» card, scoped.
 *
 * Three cards on this page have a button labelled «ادامه» — the credit, the
 * message and the repricing — so an unscoped query finds all of them. Scoping
 * by card is also the honest assertion: what is being tested is this card's
 * button, not whichever one the DOM happens to list first.
 */
function messageCard(): HTMLElement {
  return screen.getByText('پیام همگانی').closest('.card') as HTMLElement;
}

/** The confirmation, addressed by the title it renders as its own label. */
function confirmBox(title: string): HTMLElement {
  return screen.getByRole('group', { name: title });
}

async function openPostTab() {
  render(<BulkPage />);
  await screen.findByText('پیام همگانی');
  fireEvent.click(within(messageCard()).getByRole('button', { name: 'لینک پست کانال' }));
  return within(messageCard()).getByLabelText('لینک پست') as HTMLInputElement;
}

describe('sending a channel post to every customer', () => {
  it('will not arm the button until the link reads as a post', async () => {
    const input = await openPostTab();
    const go = within(messageCard()).getByRole('button', {
      name: 'ادامه',
    }) as HTMLButtonElement;

    // Empty, then wrong, then right. The middle state is the one that matters:
    // «https://t.me/shikoonet» is the channel, not a post in it, and it is what
    // an operator copies from the channel's own header by mistake.
    expect(go.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'https://t.me/shikoonet' } });
    expect(go.disabled).toBe(true);
    fireEvent.change(input, { target: { value: 'https://t.me/shikoonet/137' } });
    await waitFor(() => expect(go.disabled).toBe(false));
  });

  it('says back what it understood, before anything is sent', async () => {
    const input = await openPostTab();
    fireEvent.change(input, { target: { value: 'https://t.me/shikoonet/137' } });

    // The channel and the number, in the operator's own digits. A link that
    // points at the wrong post is only catchable here.
    const said = await within(messageCard()).findByText(/@shikoonet/);
    expect(said.textContent).toContain('۱۳۷');
  });

  it('warns that the post is rehearsed first, on the confirmation itself', async () => {
    const input = await openPostTab();
    fireEvent.change(input, { target: { value: 'https://t.me/shikoonet/137' } });
    fireEvent.click(within(messageCard()).getByRole('button', { name: 'ادامه' }));

    expect(
      await within(confirmBox('این پست فوروارد شود؟')).findByText(/سایر گزارشات/),
    ).toBeTruthy();
    // And nothing has been sent by merely opening the confirmation.
    expect(sent).toEqual([]);
  });

  it('sends the link itself, not a re-derived guess at the post', async () => {
    const input = await openPostTab();
    fireEvent.change(input, { target: { value: 'https://t.me/shikoonet/137' } });
    fireEvent.click(within(messageCard()).getByRole('button', { name: 'ادامه' }));
    fireEvent.click(
      within(confirmBox('این پست فوروارد شود؟')).getByRole('button', { name: 'تایید' }),
    );

    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    const post = sent.find((s) => s.url.includes('/bulk/broadcast'));
    expect(post?.body['postLink']).toBe('https://t.me/shikoonet/137');
    // The two payloads are exclusive and the server refuses a request with
    // both, so the page must not send an empty body alongside.
    expect(post?.body['body']).toBeUndefined();
  });

  it('leaves the text tab exactly as it was', async () => {
    render(<BulkPage />);
    await screen.findByText('پیام همگانی');
    const box = within(messageCard()).getByLabelText('متن پیام') as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'سلام' } });
    fireEvent.click(within(messageCard()).getByRole('button', { name: 'ادامه' }));
    fireEvent.click(
      within(confirmBox('پیام همگانی فرستاده شود؟')).getByRole('button', { name: 'تایید' }),
    );

    await waitFor(() => expect(sent.length).toBeGreaterThan(0));
    const post = sent.find((s) => s.url.includes('/bulk/broadcast'));
    expect(post?.body['body']).toBe('سلام');
    expect(post?.body['postLink']).toBeUndefined();
  });
});
