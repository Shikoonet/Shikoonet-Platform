/**
 * The badge field, once it can carry a premium emoji.
 *
 * Three things here are easy to get wrong and invisible from the screen if you
 * do: the picker must not appear when the shop has custom emoji OFF (the bot
 * strips the markup, so the operator would pick a glyph the customer never
 * sees), the tag must land at the FRONT and only once (the only shape
 * `keyboardFor` can turn into `icon_custom_emoji_id`), and the preview must
 * show what the BOT draws rather than the markup — it is labelled «در ربات:»
 * and a line that shows fifty characters of angle brackets is a preview of
 * something that never reaches a customer.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BadgeField } from '../src/pages/BadgeField.js';
import { RoleProvider } from '../src/role.js';

const TAG = '<tg-emoji emoji-id="5368324170671202286">🔥</tg-emoji>';

function mockPacks(customEmoji: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({
          ok: true,
          customEmoji,
          packs: [
            { id: 1, setName: 's', title: 'پک', syncedAt: null, emoji: [{ id: '5368324170671202286', fallback: '🔥' }] },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ),
  );
}

function draw(value: string, onChange = vi.fn()) {
  const r = render(
    <RoleProvider role="ADMIN">
      <BadgeField
        value={value}
        onChange={onChange}
        style={null}
        onStyleChange={() => {}}
        id="b"
        preview={`${value.trim() === '' ? '' : `${value.trim()} `}پلاتینیوم`}
      />
    </RoleProvider>,
  );
  return { ...r, onChange };
}

afterEach(() => vi.unstubAllGlobals());

describe('the picker appears only when the bot would actually send them', () => {
  it('is absent while the shop has custom emoji off', async () => {
    mockPacks(false);
    draw('');
    // Waited for, not asserted immediately: the absence has to survive the
    // fetch resolving, or this passes for the wrong reason.
    await waitFor(() => expect(screen.queryByText('ایموجی پریمیوم')).toBeNull());
  });

  it('is offered when the shop has them on', async () => {
    mockPacks(true);
    draw('');
    expect(await screen.findByText('ایموجی پریمیوم')).toBeTruthy();
  });
});

describe('one tag, at the front', () => {
  it('puts the tag before a badge that already has words', async () => {
    mockPacks(true);
    const { onChange } = draw('آف');
    await screen.findByText('ایموجی پریمیوم');
    fireEvent.click(screen.getByTitle('پک — 🔥'));
    expect(onChange).toHaveBeenCalledWith(`${TAG} آف`);
  });

  it('offers no second one — a button has one icon field, not a list', async () => {
    mockPacks(true);
    draw(`${TAG} آف`);
    await screen.findByText('ایموجی پریمیوم');
    expect((screen.getByTitle('پک — 🔥') as HTMLButtonElement).disabled).toBe(true);
  });

  it('«بدون ایموجی» removes the tag and keeps the words', async () => {
    mockPacks(true);
    const { onChange } = draw(`${TAG} آف`);
    await screen.findByText('ایموجی پریمیوم');
    fireEvent.click(screen.getByText('بدون ایموجی'));
    expect(onChange).toHaveBeenCalledWith('آف');
  });
});

describe('a chip that would not fit', () => {
  it('is disabled and says why, rather than looking pressable and doing nothing', async () => {
    mockPacks(true);
    // «۲۲ نویسه» plus « 🆕 نیو» goes over twenty-four.
    draw('ط'.repeat(22));
    const preset = (await screen.findByText('🆕 نیو')) as HTMLButtonElement;
    expect(preset.disabled).toBe(true);
    expect(preset.getAttribute('title')).toContain('24');
  });

  it('the emoji picker is closed to a badge that already carries a tag ANYWHERE', async () => {
    mockPacks(true);
    // Not at the front — pasted by hand. `startsWith` answered false here and
    // let a second tag be prepended, which the route then refuses by shape.
    draw(`آف ${TAG}`);
    await screen.findByText('ایموجی پریمیوم');
    expect((screen.getByTitle('پک — 🔥') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('the counter and the preview both measure what is drawn', () => {
  it('counts a tag as the one glyph it draws, not as fifty-three characters', async () => {
    mockPacks(true);
    draw(`${TAG} آف`);
    // «🔥 آف» — four.
    expect(await screen.findByText('4 از 24 نویسه روی دکمه')).toBeTruthy();
  });

  it('shows the button without any markup in it', async () => {
    mockPacks(true);
    const { container } = draw(`${TAG} آف`);
    await screen.findByText('ایموجی پریمیوم');
    const shown = container.textContent ?? '';
    expect(shown).not.toContain('<tg-emoji');
    expect(screen.getByText('🔥 آف پلاتینیوم')).toBeTruthy();
  });
});
