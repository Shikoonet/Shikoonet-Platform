/**
 * «دسته‌بندی‌ها» — the two things Sam saw broken on staging, 2026-09-11.
 *
 * 1. A category whose badge is a premium emoji drew the TAG on its card:
 *    `<tg-emoji emoji-id="…">👋</tg-emoji>` as fifty characters of text. The
 *    editor one click away already drew the glyph, so the card is asserted to
 *    do the same — and to never contain the markup.
 *
 * 2. «چیدمان سرویس‌ها» opened the arrangement editor INSIDE the card that
 *    was clicked. A phone-sized preview inside one cell of a card grid stretched
 *    every card in the row to a thousand pixels, and two cards could hold two
 *    editors at once. There is one place for the editor — above the grid — and
 *    at most one of it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { CategoriesPage } from '../src/pages/CategoriesPage.js';

const TAGGED = '<tg-emoji emoji-id="5368324170671202286">👋</tg-emoji>';

const CATEGORIES = [
  {
    id: 1,
    name: 'سرویس الماس',
    badge: TAGGED,
    buttonStyle: 'primary',
    active: true,
    sortOrder: 0,
    rowIndex: null,
    productsCount: 3,
    planCount: 5,
    sellableCount: 5,
  },
  {
    id: 2,
    name: 'OPENVPN',
    badge: null,
    buttonStyle: null,
    active: true,
    sortOrder: 1,
    rowIndex: null,
    productsCount: 2,
    planCount: 2,
    sellableCount: 2,
  },
];

function service(id: number, name: string) {
  return {
    id,
    code: `svc-${id}`,
    name,
    kind: 'vpn',
    status: 'ACTIVE',
    description: null,
    sortOrder: 0,
    categoryId: 1,
    categoryName: 'سرویس الماس',
    resellersOnly: false,
    oncePerUser: false,
    groupIds: null,
    rowIndex: null,
    deliveryNote: null,
    badge: null,
    buttonStyle: null,
    panel: null,
    configs: [],
  };
}

function mockApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown) => {
      const url = String(input);
      const json = (body: unknown) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      if (url.includes('/product-categories')) return json({ ok: true, items: CATEGORIES });
      if (url.includes('/catalog')) {
        return json({ ok: true, total: 2, items: [service(10, 'الماس'), service(11, 'طلایی')], panels: [] });
      }
      if (url.includes('/settings')) return json({ ok: true, settings: { customEmoji: false } });
      if (url.includes('/emoji-packs')) return json({ ok: true, items: [] });
      return json({ ok: true, items: [] });
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('the category card', () => {
  it('draws a premium-emoji badge as its glyph, never as the tag', async () => {
    mockApi();
    const { container } = render(
      <RoleProvider role="ADMIN">
        <CategoriesPage />
      </RoleProvider>,
    );
    await screen.findByText('سرویس الماس');
    expect(container.textContent).not.toContain('<tg-emoji');
    expect(container.querySelector('.cat-card__emoji')?.textContent).toBe('👋');
  });
});

describe('the arrangement editor has one home', () => {
  it('opens above the grid, not inside the card, and only one at a time', async () => {
    mockApi();
    const { container } = render(
      <RoleProvider role="ADMIN">
        <CategoriesPage />
      </RoleProvider>,
    );
    await screen.findByText('سرویس الماس');

    const tierButtons = screen.getAllByRole('button', { name: 'چیدمان سرویس‌ها' });
    fireEvent.click(tierButtons[0]!);
    await waitFor(() => expect(container.querySelector('.arrange')).not.toBeNull());
    expect(container.querySelector('.cat-card .arrange')).toBeNull();
    expect(container.querySelectorAll('.arrange')).toHaveLength(1);
    expect(screen.getByText(/سرویس‌های «سرویس الماس»/)).toBeTruthy();

    // The header's own editor replaces it rather than stacking on it.
    fireEvent.click(screen.getByRole('button', { name: 'چیدمان در ربات' }));
    await waitFor(() => expect(screen.getByText('صفحهٔ اول فروشگاه')).toBeTruthy());
    expect(container.querySelectorAll('.arrange')).toHaveLength(1);
    expect(screen.queryByText(/سرویس‌های «سرویس الماس»/)).toBeNull();
  });
});
