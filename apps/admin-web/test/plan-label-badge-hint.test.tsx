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
  secret: false,
  value: '',
  isSet: false,
  updatedAt: '2026-09-02T00:00:00.000Z',
  updatedBy: null,
};

/** The hint, matched loosely: the assertion is about the token, not the wording. */
const HINT = /نشانِ پلن‌ها روی دکمه‌ها نشان داده نمی‌شود/;

beforeEach(() => {
  vi.spyOn(api, 'settings').mockResolvedValue({
    ok: true,
    items: [TEMPLATE_ROW],
    hiddenCount: 0,
  });
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
  await waitFor(() => screen.getByText('plan_button_template'));
  fireEvent.click(screen.getByRole('button', { name: 'ویرایش' }));
  // The only `textbox` on the screen: the search field above is `type="search"`,
  // which is a `searchbox`, and the scope filter is a `combobox`.
  return screen.getByRole('textbox');
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
