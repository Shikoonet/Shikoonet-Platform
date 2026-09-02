/**
 * The four per-panel settings the old bot had and this one had dropped.
 *
 * Every expectation here is measured against something outside this file: the
 * production dump for the stored values, and the PHP for the units and the
 * arithmetic. Asserting that `trialFor` agrees with `trialFor` would prove
 * nothing, and getting the units wrong is not a cosmetic failure — a trial
 * measured in the wrong unit hands out a thousand times what the shop meant.
 */

import { describe, expect, it } from 'vitest';
import {
  downgradeGroupsFor,
  remoteUsernameFor,
  trialFor,
  usernameShapeFor,
} from '../src/index.js';

describe('روش ساخت نام کاربری — the shapes a panel may give an account name', () => {
  it('defaults to the Telegram id, which is what three of the five live panels do', () => {
    expect(usernameShapeFor({}).mode).toBe('TELEGRAM_ID');
    expect(remoteUsernameFor(369469521, 'inv-ce4c9a')).toBe('369469521_invce4c9a');
  });

  /**
   * The five values in the production dump, read out of `marzban_panel` on
   * 2026-09-02 rather than copied from `lang/fa.php`. Panel 1's has NO spaces
   * around its plus sign while the others do; that asymmetry is in the data and
   * is exactly the kind of thing a hand-written fixture smooths away.
   */
  it('reads every MethodUsername the production panels actually carry', () => {
    const live = [
      ['آیدی عددی+عدد ترتیبی', 'TELEGRAM_ID'],
      ['آیدی عددی + حروف و عدد رندوم', 'TELEGRAM_ID'],
      ['متن دلخواه + عدد رندوم', 'PANEL_TEXT'],
    ] as const;
    for (const [stored, expected] of live) {
      expect(usernameShapeFor({ MethodUsername: stored }).mode).toBe(expected);
    }
  });

  it('prefers the key an admin writes over the Persian phrase underneath it', () => {
    const config = { username_mode: 'TELEGRAM_USERNAME', MethodUsername: 'آیدی عددی+عدد ترتیبی' };
    expect(usernameShapeFor(config).mode).toBe('TELEGRAM_USERNAME');
  });

  it('falls to the Telegram id for a phrase nobody has translated', () => {
    // The two «customer types their own name» modes land here, and so does a
    // `lang/fa.php` somebody edited. Falling back is the only safe direction:
    // the alternative is a username of `undefined_...` on a paid order.
    expect(usernameShapeFor({ MethodUsername: 'نام کاربری دلخواه' }).mode).toBe('TELEGRAM_ID');
    expect(usernameShapeFor({ MethodUsername: 'something new' }).mode).toBe('TELEGRAM_ID');
  });

  it('builds each mode with the order id as the suffix, so a retry reproduces it', () => {
    const order = 'inv-7b1f';
    const byId = remoteUsernameFor(55, order, { mode: 'TELEGRAM_ID' });
    const byText = remoteUsernameFor(55, order, { mode: 'PANEL_TEXT', panelText: 'Vip' });
    const byName = remoteUsernameFor(55, order, {
      mode: 'TELEGRAM_USERNAME',
      telegramUsername: 'Sam_Shikoo',
    });

    expect(byId).toBe('55_inv7b1f');
    expect(byText).toBe('vip_inv7b1f');
    expect(byName).toBe('sam_shikoo_inv7b1f');

    // The property the whole design turns on: same order in, same name out.
    // Legacy cannot say this of five of its eight modes.
    expect(remoteUsernameFor(55, order, { mode: 'PANEL_TEXT', panelText: 'Vip' })).toBe(byText);
  });

  it('falls back to the id rather than producing a name starting with an underscore', () => {
    // `none` is legacy's own default for `namecustom` and two production panels
    // carry it, so this is not a hypothetical input — but a THREE letter one, so
    // it survives. The ones that must not are the unusable ones.
    expect(remoteUsernameFor(7, 'inv-1', { mode: 'PANEL_TEXT', panelText: 'none' })).toBe(
      'none_inv1',
    );
    expect(remoteUsernameFor(7, 'inv-1', { mode: 'PANEL_TEXT', panelText: 'وی‌پی‌ان' })).toBe(
      '7_inv1',
    );
    expect(remoteUsernameFor(7, 'inv-1', { mode: 'PANEL_TEXT', panelText: '12' })).toBe('7_inv1');
    expect(remoteUsernameFor(7, 'inv-1', { mode: 'TELEGRAM_USERNAME', telegramUsername: null })).toBe(
      '7_inv1',
    );
  });

  it('caps the prefix, which legacy does nowhere and the panel answers 422 about', () => {
    const long = 'a'.repeat(80);
    const name = remoteUsernameFor(7, 'inv-1', { mode: 'PANEL_TEXT', panelText: long });
    expect(name).toBe(`${'a'.repeat(32)}_inv1`);
  });
});

describe('اکانت تست — the two numbers, in the units the PHP actually uses', () => {
  it('is off when the panel never said otherwise', () => {
    expect(trialFor({}).enabled).toBe(false);
  });

  it('is off on every production panel, because all five are OFFTestAccount', () => {
    // Measured 2026-09-02. This is why turning the feature on changes nothing
    // for anybody until an admin sets it deliberately.
    const live = { TestAccount: 'OFFTestAccount', val_usertest: '1000', time_usertest: '12' };
    expect(trialFor(live).enabled).toBe(false);
  });

  /**
   * `index.php:3064` is `'data_limit' => $marzban_list_get['val_usertest'] * 1048576`
   * and `index.php:3063` is `strtotime("+" . $marzban_list_get['time_usertest'] . "hours")`.
   * So 1000 is a thousand MEGABYTES and 12 is twelve HOURS — not 1000 GB and not
   * 12 days, which is what the field names and the bot's own `{day}` placeholder
   * suggest.
   */
  it('reads the legacy columns as megabytes and hours', () => {
    const trial = trialFor({
      TestAccount: 'ONTestAccount',
      val_usertest: '1000',
      time_usertest: '12',
    });
    expect(trial.enabled).toBe(true);
    expect(trial.volumeGb).toBeCloseTo(1000 / 1024, 6);
    expect(trial.durationHours).toBe(12);
  });

  it('prefers the keys an admin writes, in gigabytes and hours', () => {
    const trial = trialFor({
      trial_enabled: true,
      trial_volume_gb: 2,
      trial_duration_hours: 24,
      TestAccount: 'OFFTestAccount',
      val_usertest: '1000',
      time_usertest: '12',
    });
    expect(trial).toEqual({ enabled: true, volumeGb: 2, durationHours: 24 });
  });

  it('refuses to be on with a number missing, which legacy does not', () => {
    // A panel switched on with nothing to give answers a customer's tap with a
    // failed provision — and they have spent their one free account on it.
    expect(trialFor({ trial_enabled: true, trial_volume_gb: 2 }).enabled).toBe(false);
    expect(trialFor({ trial_enabled: true, trial_duration_hours: 12 }).enabled).toBe(false);
    expect(trialFor({ trial_enabled: true, trial_volume_gb: 0, trial_duration_hours: 12 }).enabled)
      .toBe(false);
  });
});

describe('گروه اکانت غیرفعال — where an ended service goes', () => {
  it('is nothing until somebody sets it', () => {
    expect(downgradeGroupsFor({})).toBeNull();
    expect(downgradeGroupsFor({ downgrade_group_ids: [] })).toBeNull();
  });

  /**
   * `inbound_deactive` is the string `1` on all five production panels —
   * `admin.php:766` binds it from `$inboundid` at creation and the menu that
   * would write `<protocol>*<tag>` has never been used. Panel 8 has
   * `inboundstatus = oninbounddisable`, so the feature is ON there with a value
   * `explode('*', '1')` turns into a one-element array. There is nothing to
   * migrate, and this test is what says so out loud.
   */
  it('does not read the legacy column, which has never held a usable value', () => {
    expect(downgradeGroupsFor({ inboundstatus: 'oninbounddisable', inbound_deactive: '1' }))
      .toBeNull();
    expect(downgradeGroupsFor({ inbound_deactive: 'vless*VLESS_TCP' })).toBeNull();
  });

  it('takes group ids and drops anything that is not one', () => {
    expect(downgradeGroupsFor({ downgrade_group_ids: [3, '4', 0, -1, 'x', null] })).toEqual([3, 4]);
  });
});
