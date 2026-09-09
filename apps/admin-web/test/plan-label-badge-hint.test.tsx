/**
 * The one thing a plan-button template can silently throw away.
 *
 * `checkPlanLabel` refuses a template with an unknown token or no token at all,
 * and it is right not to refuse one that omits `{badge}` — a shop is allowed to
 * want a bare «1 ماهه | 350,000 تومان». What it is not allowed to be is a
 * surprise: dropping the token stops the نشان typed on EVERY «محصولات» row from
 * being drawn, on every plan button at once, and neither screen says why.
 *
 * Three of the four presets one click away omit the token, so this is a state a
 * shop lands in by pressing a button, not by writing a template. That is the
 * whole reason the sentence exists and the whole reason it is a sentence rather
 * than a refusal.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RoleProvider } from '../src/role.js';
import { SettingsPage } from '../src/pages/SettingsPage.js';
import { api, type SettingRow } from '../src/api.js';

const TEMPLATE_ROW: SettingRow = {
  scope: 'shop',
  key: 'plan_button_template',
  // Live, and it has to be: the screen draws a control for a row only when the
  // shop reads it, and this whole test is about the control's hint.
  live: true,
  label: 'قالب دکمهٔ سرویس',
  hint: 'مثل {name} — {volume} گیگ — {days} روز.',
  kind: 'text',
  secret: false,
  value: '',
  isSet: false,
  updatedAt: '2026-09-02T00:00:00.000Z',
  updatedBy: null,
};

/** The hint, matched loosely: the assertion is about the token, not the wording. */
const HINT = /نشانِ پلن‌ها روی دکمه‌ها نشان داده نمی‌شود/;

// Typed with the body it receives, not as `() =>`: a zero-argument mock makes
// `mock.calls` a tuple of length nought, and reading `[0]` off it is a type
// error rather than the assertion it looks like.
const updateSetting = vi.fn(
  async (_body: Parameters<typeof api.updateSetting>[0]) =>
    ({ ok: true }) as Awaited<ReturnType<typeof api.updateSetting>>,
);

beforeEach(() => {
  vi.spyOn(api, 'settings').mockResolvedValue({
    ok: true,
    items: [TEMPLATE_ROW],
    hiddenCount: 0,
  });
  updateSetting.mockClear();
  vi.spyOn(api, 'updateSetting').mockImplementation(updateSetting);
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * `fireEvent`, not user-event: that package is not a dependency here and a hint
 * under a text field is not worth becoming one. The field is controlled, so one
 * change event is exactly what a keystroke does to it.
 */
async function openTheTemplateEditor() {
  render(
    <RoleProvider role="ADMIN">
      <SettingsPage />
    </RoleProvider>,
  );
  /*
   * No «ویرایش» step any more, and the row is found by its LABEL.
   *
   * «تنظیمات» was a table of 163 raw key/value rows where each field opened
   * behind an edit button; it is a form now, and every live setting is a
   * labelled control that is already there. The row is `plan_button_template`
   * either way — what changed is that a person can find it.
   */
  const field = await screen.findByLabelText('قالب دکمهٔ سرویس');
  return field;
}

function type(field: HTMLElement, value: string) {
  fireEvent.change(field, { target: { value } });
}

describe('the plan-button template', () => {
  it('says so when the template would drop every badge in the shop', async () => {
    const field = await openTheTemplateEditor();

    // A template that never mentions the badge. Legal, saveable, and lossy.
    type(field, '{duration} | {price}');
    await waitFor(() => expect(screen.getByText(HINT)).toBeTruthy());
  });

  it('stops saying it the moment the token is back', async () => {
    const field = await openTheTemplateEditor();

    type(field, '{badge} {duration} | {price}');
    await waitFor(() => expect(screen.getByText(/در ربات:/)).toBeTruthy());
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('saves a preset that was chosen with the mouse', async () => {
    /*
     * The field saves on blur, and a click on one of these buttons blurs it
     * FIRST — so the save that fires carries the old draft and the chosen
     * preset is never sent at all. On screen it looks saved: the input shows
     * the new template and nothing says otherwise.
     *
     * These buttons are the ordinary way to set this template — three of the
     * four presets exist precisely so nobody has to type the grammar — so the
     * ordinary path was the one that did not persist.
     */
    await openTheTemplateEditor();
    const preset = screen.getAllByRole('button', { name: /\{/ })[0]!;
    fireEvent.click(preset);

    await waitFor(() => expect(updateSetting).toHaveBeenCalled());
    const sent = updateSetting.mock.calls.at(-1)![0];
    expect(sent.key).toBe('plan_button_template');
    expect(sent.value).not.toBe('');
    expect((screen.getByLabelText('قالب دکمهٔ سرویس') as HTMLInputElement).value).toBe(sent.value);
  });

  it('stays quiet on an empty template, which means «leave it as it always was»', async () => {
    await openTheTemplateEditor();

    // Nothing typed. Empty is «not configured» — the bot falls back to the label
    // it has always drawn, badge and all — so a warning here would be a lie.
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('stays quiet while the template is refused, so one field says one thing', async () => {
    const field = await openTheTemplateEditor();

    type(field, '{prise}');
    await waitFor(() => expect(screen.getByText(/جزو فیلدهای مجاز نیست/)).toBeTruthy());
    // The badge hint would be true here too, and saying both at once buries the
    // one the operator has to act on.
    expect(screen.queryByText(HINT)).toBeNull();
  });
});
