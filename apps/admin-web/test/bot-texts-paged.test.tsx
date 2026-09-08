/**
 * «متن‌های ربات», a page at a time.
 *
 * The 2026-09-07 walk measured this screen at eighteen thousand pixels: every
 * text the bot can say, all of them at once, each with a five-row textarea
 * behind an edit button. Finding one meant scrolling past ninety.
 *
 * Paged in the browser rather than on the server, deliberately: the whole set
 * is a hundred-odd short strings, the screen already loads all of them to
 * count how many are customised, and a server round-trip per page would be a
 * request to answer a question the page has already answered.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { BotTextsPage } from '../src/pages/BotContentPages.js';
import { RoleProvider } from '../src/role.js';

const ROWS = Array.from({ length: 30 }, (_, i) => ({
  key: `TEXT_${i}`,
  value: `جملهٔ شمارهٔ ${i}`,
  hint: `جایی که جملهٔ ${i} دیده می‌شود`,
  screen: 'main',
  placeholders: [] as string[],
  customised: false,
}));

const botTexts = vi.fn(async () => ({
  ok: true,
  items: ROWS,
  maxLength: 4096,
  customEmoji: false,
  screens: [{ id: 'main', title: 'منوی اصلی' }],
}));

vi.mock('../src/api.js', async () => {
  const actual = await vi.importActual<typeof import('../src/api.js')>('../src/api.js');
  return {
    ...actual,
    api: {
      botTexts: () => botTexts(),
      // , not  — the page reads .
      emojiPacks: async () => ({ ok: true, packs: [] }),
    },
  };
});

const draw = () =>
  render(
    <RoleProvider role="ADMIN">
      <BotTextsPage />
    </RoleProvider>,
  );

afterEach(() => {
  botTexts.mockClear();
});

describe('the bot texts screen', () => {
  it('shows a page of them, not all ninety', async () => {
    draw();
    expect(await screen.findByText('جملهٔ شمارهٔ 0')).toBeTruthy();
    // Twenty-five of thirty.
    expect(screen.getByText('جملهٔ شمارهٔ 24')).toBeTruthy();
    expect(screen.queryByText('جملهٔ شمارهٔ 25')).toBeNull();
  });

  it('says which page it is on, and moves', async () => {
    draw();
    await screen.findByText('جملهٔ شمارهٔ 0');
    fireEvent.click(screen.getByRole('button', { name: 'بعدی' }));
    expect(screen.getByText('جملهٔ شمارهٔ 25')).toBeTruthy();
    expect(screen.queryByText('جملهٔ شمارهٔ 0')).toBeNull();
  });

  it('goes back to the first page when the search changes', async () => {
    // Otherwise a search from page three shows «چیزی پیدا نشد» over results
    // that are on page one — the screen answering a question nobody asked.
    draw();
    await screen.findByText('جملهٔ شمارهٔ 0');
    fireEvent.click(screen.getByRole('button', { name: 'بعدی' }));
    expect(screen.getByText('جملهٔ شمارهٔ 25')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('جستجو'), { target: { value: 'جملهٔ شمارهٔ 1' } });
    expect(screen.getByText('جملهٔ شمارهٔ 1')).toBeTruthy();
  });
});
