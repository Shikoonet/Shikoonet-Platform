/**
 * The shop's own plan-button label: what may be saved, and what gets drawn.
 *
 * Two properties carry the feature, and each has a failure mode that is silent
 * rather than loud:
 *
 *   · a slot with no value must take its stranded separator with it. The
 *     visible bug is «1 ماهه |  | 350,000 تومان» on every unlimited plan, and
 *     nothing throws — the button just looks broken to the customer.
 *   · a template that names a field which does not exist must be refused on
 *     the way IN. Accepted, it draws the literal characters `{prise}` on a
 *     button, and the first person to find out is somebody trying to buy.
 */

import { describe, expect, it } from 'vitest';

import { checkPlanLabel, renderPlanLabel, PLAN_LABEL_PRESETS } from '../src/planLabel.js';

const FULL = {
  name: '۱ ماهه · نامحدود · چند کاربره',
  badge: '⭐ ویژه',
  duration: '1 ماهه',
  volume: 'نامحدود',
  users: 'چند کاربره',
  price: '350,000 تومان',
};

describe('renderPlanLabel', () => {
  it('fills the slots in the order the shop wrote them', () => {
    expect(renderPlanLabel('{duration} | {volume} | {price}', FULL)).toBe(
      '1 ماهه | نامحدود | 350,000 تومان',
    );
  });

  it('is the two-part and three-part layouts, from one template each', () => {
    expect(renderPlanLabel('{duration} | {volume} {price}', FULL)).toBe(
      '1 ماهه | نامحدود 350,000 تومان',
    );
    expect(renderPlanLabel('{duration} | {volume} | {price}', FULL)).toBe(
      '1 ماهه | نامحدود | 350,000 تومان',
    );
  });

  it('takes the stranded separator with an empty slot', () => {
    // The plan has no badge. Without the collapse this reads «| 1 ماهه».
    expect(renderPlanLabel('{badge} | {duration} | {price}', { ...FULL, badge: '' })).toBe(
      '1 ماهه | 350,000 تومان',
    );
  });

  it('keeps the space around the separator that survives', () => {
    // The regression this is here for: collapsing «1 ماهه |  | x» by eating
    // the leading space too produced «1 ماهه| x».
    expect(renderPlanLabel('{duration} | {volume} | {price}', { ...FULL, volume: '' })).toBe(
      '1 ماهه | 350,000 تومان',
    );
  });

  it('drops a trailing separator when the last slot is empty', () => {
    expect(renderPlanLabel('{duration} | {users}', { ...FULL, users: '' })).toBe('1 ماهه');
  });

  it('leaves an unknown slot alone rather than deleting the text around it', () => {
    // It cannot be saved through `checkPlanLabel`, but a row edited by hand
    // must still render something a human can recognise as wrong.
    expect(renderPlanLabel('{duration} {prise}', FULL)).toBe('1 ماهه {prise}');
  });

  it('renders every preset the panel offers', () => {
    for (const preset of PLAN_LABEL_PRESETS) {
      const drawn = renderPlanLabel(preset, FULL);
      expect(drawn).not.toBe('');
      expect(drawn).not.toMatch(/\{[a-zA-Z]/);
      expect(drawn).not.toMatch(/\s\s|^[\s|·—-]|[\s|·—-]$/);
    }
  });
});

describe('checkPlanLabel', () => {
  it('accepts a template that names known fields', () => {
    expect(checkPlanLabel('{duration} | {volume} | {price}')).toBeNull();
  });

  it('refuses a field that does not exist, and names it', () => {
    const problem = checkPlanLabel('{duration} | {prise}');
    expect(problem?.token).toBe('prise');
  });

  it('refuses a template with no field at all', () => {
    // Every plan would draw the same button and nothing would tell two of them
    // apart — the bug `planMenu` was rewritten to fix.
    expect(checkPlanLabel('خرید اشتراک')).not.toBeNull();
  });

  it('refuses an empty template, which is not the same as unset', () => {
    expect(checkPlanLabel('   ')).not.toBeNull();
  });

  it('refuses more than one line — a button has one', () => {
    expect(checkPlanLabel('{duration}\n{price}')).not.toBeNull();
  });

  it('refuses a template too long to fit a phone', () => {
    expect(checkPlanLabel(`{duration}${'ـ'.repeat(200)}`)).not.toBeNull();
  });

  it('accepts every preset the panel offers', () => {
    for (const preset of PLAN_LABEL_PRESETS) {
      expect(checkPlanLabel(preset), preset).toBeNull();
    }
  });
});
