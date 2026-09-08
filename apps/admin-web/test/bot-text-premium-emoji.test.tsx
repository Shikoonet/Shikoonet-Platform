/**
 * What «متن‌های ربات» and the keyboard preview show where a Premium emoji is.
 *
 * A custom emoji is stored as `<tg-emoji emoji-id="…">👋</tg-emoji>` — fifty
 * characters of markup around one glyph. Telegram renders it for a Premium
 * owner and falls back to the glyph for everybody else, and `stripCustomEmoji`
 * is how the bot itself computes that fallback before it sends anything.
 *
 * The panel printed the markup. On staging on 2026-09-07 the list of 251 texts
 * showed rows like `به شیکو خوش آمدید <tg-emoji emoji-id="536832417…">👋`,
 * which tells an operator nothing about what a customer reads and hides the
 * sentence they came to check inside an id.
 *
 * `BadgeField` already had this right (`badge-field-premium-emoji.test.tsx`),
 * and the helper it uses is the same one. The rule: the markup is what gets
 * SAVED, the glyph is what gets SHOWN.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { BotTextsPage, KeyboardPage } from '../src/pages/BotContentPages.js';
import { RoleProvider } from '../src/role.js';

const TAG = '<tg-emoji emoji-id="5368324170671202286">👋</tg-emoji>';

function stub(body: Record<string, unknown>) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const u = String(url);
      // The emoji packs are a separate request the page swallows on failure.
      if (u.includes('emoji-packs')) {
        return new Response(JSON.stringify({ ok: true, customEmoji: true, packs: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a premium emoji in the panel', () => {
  it('shows the glyph in the list of texts, not the markup', async () => {
    stub({
      ok: true,
      maxLength: 4096,
      customEmoji: true,
      screens: [{ id: 'main', label: 'خوش‌آمد و منوی اصلی' }],
      items: [
        {
          key: 'welcome',
          screen: 'main',
          hint: 'اولین پیام بعد از /start',
          placeholders: [],
          default: `به شیکو خوش آمدید ${TAG}`,
          value: `به شیکو خوش آمدید ${TAG}`,
          customised: false,
          updatedAt: null,
          updatedBy: null,
        },
      ],
    });

    render(
      <RoleProvider role="ADMIN">
        <BotTextsPage />
      </RoleProvider>,
    );

    await waitFor(() => expect(screen.getByText(/به شیکو خوش آمدید/)).toBeTruthy());
    expect(document.body.textContent).toContain('👋');
    expect(document.body.textContent).not.toContain('tg-emoji');
    expect(document.body.textContent).not.toContain('5368324170671202286');
  });

  it('shows the glyph on a keyboard button in the preview', async () => {
    stub({
      ok: true,
      menu: 'main',
      menus: [{ id: 'main', label: 'منوی اصلی', hint: '' }],
      customised: true,
      maxLabelLength: 64,
      buttons: [
        {
          action: 'buy',
          label: `${TAG} خرید اشتراک`,
          rowIndex: 0,
          colIndex: 0,
          visible: true,
          style: null,
        },
      ],
      actions: [{ action: 'buy', label: 'خرید اشتراک', hint: 'خرید سرویس جدید' }],
    });

    render(
      <RoleProvider role="ADMIN">
        <KeyboardPage />
      </RoleProvider>,
    );

    await waitFor(() => expect(screen.getByText(/خرید اشتراک/)).toBeTruthy());
    // The chip in the preview is a picture of a Telegram button. Markup on it
    // is markup the operator is being told the customer will see.
    const preview = document.querySelector('.kb-grid') ?? document.body;
    expect(preview.textContent).not.toContain('tg-emoji');
  });
});
