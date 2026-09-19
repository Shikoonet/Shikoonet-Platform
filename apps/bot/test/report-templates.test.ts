/**
 * The reports group reads exactly like mirzabot's — Sam, 2026-09-19.
 *
 * Rule 6: a test that agrees with the code proves nothing. The external truth
 * here is `legacy/mirzabot-php/lang/fa.php` — the TRACKED copy, which is the
 * release Sam's live bot runs (`SOURCE.md`); `legacy/mirzabot-php/src/` is
 * the upstream clone, identical in every string below but excluded from git,
 * so CI cannot read it. This file parses the tracked one and compares — every
 * default in the registry must be the legacy string with its `%s` slots named
 * and its HTML tags dropped, whitespace oddities included. The rendered
 * reports are then checked against the same strings, filled by hand the way
 * `sprintf` fills them.
 *
 * The key names are this release's; upstream renamed them later
 * (`accountCreateReportAfterPay` → `accountCreatedAfterPay`, and so on). The
 * strings did not move.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TEXTS, REPORT_TOPIC_TITLES, type TextKey } from '@shikoo/contracts';
import * as menu from '../src/menu.js';

const FA = readFileSync(
  new URL('../../../legacy/mirzabot-php/lang/fa.php', import.meta.url),
  'utf8',
);

/** A section's anchor, so a key that appears in two sections is not confused. */
const SECTION = {
  any: "<?php",
  spam: "'spam' => [",
  // The service-status block, found by the one key only it has.
  status: "'on_hold' => '❌ متصل نشده'",
} as const;

/** The PHP single-quoted string at `'key' => '…'` after the anchor. */
function legacy(section: keyof typeof SECTION, key: string): string {
  const at = FA.indexOf(SECTION[section]);
  expect(at, `section ${section}`).toBeGreaterThan(-1);
  // A block's keys sit on both sides of its anchor; 4 KB either way covers
  // the largest of them and no neighbour that repeats a key.
  const from = section === 'any' ? 0 : Math.max(0, at - 4096);
  const m = new RegExp(`'${key}'\\s*=>\\s*'((?:[^'\\\\]|\\\\.)*)'`).exec(FA.slice(from));
  expect(m, `${section}.${key}`).not.toBeNull();
  return m![1]!.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
}

/** `%s` → `{name}` and the tags gone — what the registry must hold. */
function template(section: keyof typeof SECTION, key: string, names: string[]): string {
  const raw = legacy(section, key).replace(/<\/?(code|b|a)\b[^>]*>/g, '');
  const parts = raw.split('%s');
  expect(parts.length - 1, `${key} slots`).toBe(names.length);
  return parts.map((p, i) => (i === 0 ? p : `{${names[i - 1]}}${p}`)).join('');
}

/** `sprintf` by hand. */
function sprintf(section: keyof typeof SECTION, key: string, ...args: (string | number)[]): string {
  const raw = legacy(section, key).replace(/<\/?(code|b|a)\b[^>]*>/g, '');
  let i = 0;
  return raw.replace(/%s/g, () => String(args[i++]));
}

const REGISTRY: [TextKey, keyof typeof SECTION, string, string[]][] = [
  ['REPORT_PURCHASE', 'any', 'accountCreateReportAfterPay', ['first', 'telegramId', 'username', 'config', 'panel', 'days', 'plan', 'volume', 'balanceBefore', 'balanceAfter', 'tracking', 'userType', 'phone', 'price', 'finalPrice', 'time']],
  ['REPORT_FIRST_PURCHASE', 'any', 'firstPurchaseLabel', []],
  ['REPORT_RENEWAL', 'any', 'renewReportAdminFn', ['telegramId', 'username', 'config', 'panel', 'plan', 'volume', 'days', 'price', 'balanceBefore', 'time']],
  ['REPORT_ADD_VOLUME', 'any', 'extraVolumeReportAdminFn', ['telegramId', 'volume', 'price', 'config', 'balanceBefore']],
  ['REPORT_ADD_TIME', 'any', 'extraTimeReportAdminFn', ['telegramId', 'days', 'price', 'config']],
  ['REPORT_TRIAL', 'any', 'testAccountReportAdmin', ['telegramId', 'username', 'config', 'name', 'panel', 'hours', 'mb', 'tracking', 'userType', 'phone', 'time']],
  ['REPORT_PAYMENT', 'any', 'newPaymentAutoConfirm', ['telegramId', 'amount', 'method']],
  ['REPORT_NEW_USER', 'any', 'newUser', ['name', 'username', 'telegramId']],
  ['SPAM_BLOCKED_REPORT', 'spam', 'spamedReport', ['telegramId']],
  ['REPORT_DISCOUNT_USED', 'any', 'discountCodeUsedAdminFn', ['username', 'telegramId', 'code']],
  ['REPORT_COMMISSION', 'any', 'affiliateCommissionPaidLogFn', ['amount', 'referrer', 'buyer', 'time']],
  ['REPORT_CRON_VOLUME_TITLE', 'any', 'notifVolumeCronTitle', []],
  ['REPORT_CRON_TIME_TITLE', 'any', 'notifTimeCronTitle', []],
  ['REPORT_CRON_SERVICE', 'any', 'notifServiceUsername', ['config']],
  ['REPORT_CRON_STATUS', 'any', 'notifServiceStatus', ['status']],
  ['REPORT_CRON_REMAINING_VOLUME', 'any', 'notifRemainingVolume', ['volume']],
  ['REPORT_CRON_REMAINING_DAYS', 'any', 'notifRemainingDays', ['days']],
  ['REPORT_CRON_DELETE', 'any', 'notifDeleteCronInfo', ['config', 'status', 'days', 'volume']],
  ['REPORT_CRON_DELETE_VOLUME', 'any', 'notifVolumeDeleteCronInfo', ['config', 'status', 'days', 'volume', 'lastSeen']],
  ['REPORT_NIGHT_AGENTS_TITLE', 'any', 'dailyTopAgentsTitle', []],
  ['REPORT_NIGHT_AGENT_ROW', 'any', 'dailyTopAgentRow', ['telegramId', 'username', 'total']],
  ['REPORT_NIGHT', 'any', 'dailyBotReport', ['renewals', 'renewalsToman', 'orders', 'ordersToman', 'trials', 'volumeGb', 'newUsers']],
  ['REPORT_NIGHT_PANELS_TITLE', 'any', 'dailyPanelsReportTitle', []],
  ['REPORT_NIGHT_PANEL_ROW', 'any', 'dailyPanelReportRow', ['panel', 'orders', 'ordersToman', 'volumeGb']],
];

/** 2026-09-19 11:30:00 UTC — 15:00:00 Tehran, 1405/06/28. */
const AT = Date.UTC(2026, 8, 19, 11, 30, 0);
const STAMP = '1405/06/28 15:00:00';

describe('the report templates are mirzabot’s, read from fa.php', () => {
  it.each(REGISTRY)('%s is fa.php’s %s', (key, section, legacyKey, names) => {
    expect(DEFAULT_TEXTS.raw(key)).toBe(template(section, legacyKey, names));
  });

  it('creates the topics with fa.php’s titles, trailing spaces trimmed', () => {
    const titles = {
      buyreport: legacy('any', 'btn_report_buy_1'),
      otherservice: legacy('any', 'btn_report_buy_2'),
      reporttest: legacy('any', 'btn_account_report'),
      otherreport: legacy('any', 'btn_report_1'),
      errorreport: legacy('any', 'err_error_report'),
      paymentreport: legacy('any', 'btn_report_2'),
      porsantreport: legacy('any', 'titleTopic'),
      reportnight: legacy('any', 'reportNight'),
      reportcron: legacy('any', 'reportCron'),
      backupfile: legacy('any', 'btn_bot_backup'),
    };
    for (const [kind, title] of Object.entries(titles)) {
      expect(REPORT_TOPIC_TITLES[kind as keyof typeof REPORT_TOPIC_TITLES]).toBe(title.trim());
    }
  });

  it('stamps the time as jdate("Y/m/d H:i:s") in Tehran', () => {
    expect(menu.jalaliStamp(AT)).toBe(STAMP);
  });

  it('fills the purchase report the way function.php:1143 does', () => {
    const text = menu.purchaseReport({
      firstPurchase: true,
      telegramId: 123,
      username: 'sam',
      config: 'sam_1',
      panel: 'آلمان',
      days: 30,
      plan: 'یک ماهه',
      volumeGb: 50,
      balanceBeforeIrr: 2_500_000,
      balanceAfterIrr: 500_000,
      tracking: 'ord1',
      tier: null,
      priceIrr: 2_000_000,
      finalPriceIrr: 2_000_000,
      atMs: AT,
    });
    expect(text).toBe(
      sprintf('any', 'accountCreateReportAfterPay', legacy('any', 'firstPurchaseLabel'), 123, 'sam', 'sam_1', 'آلمان', 30, 'یک ماهه', 50, '250,000', '50,000', 'ord1', 'f', 'none', '200,000', '200,000', STAMP),
    );
    // Not the first purchase: the marker line is empty, as `$textonebuy = ""`.
    expect(menu.purchaseReport({
      firstPurchase: false, telegramId: 1, username: null, config: 'c', panel: 'p', days: null, plan: 'x',
      volumeGb: null, balanceBeforeIrr: 0, balanceAfterIrr: 0, tracking: 't', tier: 'n', priceIrr: 0, finalPriceIrr: 0, atMs: AT,
    })).toBe(sprintf('any', 'accountCreateReportAfterPay', '', 1, '', 'c', 'p', 0, 'x', 0, '0', '0', 't', 'n', 'none', '0', '0', STAMP));
  });

  it('fills the trial report in hours and megabytes', () => {
    expect(menu.trialReport({
      telegramId: 9, username: 'u', config: 'test_9', name: 'Sam', panel: 'p', days: 1, volumeGb: 0.5,
      tracking: 'tr', tier: null, atMs: AT,
    })).toBe(sprintf('any', 'testAccountReportAdmin', 9, 'u', 'test_9', 'Sam', 'p', 24, 512, 'tr', 'f', 'none', STAMP));
  });

  it('fills the payment, new-user, discount and commission reports', () => {
    expect(menu.paymentReport({ telegramId: 5, amountIrr: 1_000_000, method: 'کارت به کارت' }))
      .toBe(sprintf('any', 'newPaymentAutoConfirm', 5, '100,000', 'کارت به کارت'));
    expect(menu.newUserReport({ name: 'علی', username: 'ali', telegramId: 7 }))
      .toBe(sprintf('any', 'newUser', 'علی', 'ali', 7));
    expect(menu.discountUsedReport({ username: 'ali', telegramId: 7, code: 'OFF10' }))
      .toBe(sprintf('any', 'discountCodeUsedAdminFn', 'ali', 7, 'OFF10'));
    expect(menu.commissionReport({ amountIrr: 200_000, referrerTelegramId: 1, buyerTelegramId: 2, atMs: AT }))
      .toBe(sprintf('any', 'affiliateCommissionPaidLogFn', '20,000', 1, 2, STAMP));
    expect(menu.spamBlockedReport(44)).toBe(sprintf('spam', 'spamedReport', 44));
  });

  it('glues the cron notices as NoticationsService.php does', () => {
    expect(menu.cronVolumeNotice({ config: 'c1', status: 'active', remaining: '2.5 GB' })).toBe(
      legacy('any', 'notifVolumeCronTitle') +
        sprintf('any', 'notifServiceUsername', 'c1') +
        sprintf('any', 'notifServiceStatus', 'active') +
        sprintf('any', 'notifRemainingVolume', '2.5 GB'),
    );
    expect(menu.cronTimeNotice({ config: 'c1', status: 'active', days: 2 })).toBe(
      legacy('any', 'notifTimeCronTitle') +
        sprintf('any', 'notifServiceUsername2', 'c1') +
        sprintf('any', 'notifServiceStatus2', 'active') +
        sprintf('any', 'notifRemainingDays', 2),
    );
    expect(menu.cronDeleteNotice({ config: 'c1', status: '🔚 پایان زمان سرویس', days: -3, remaining: '0 B' }))
      .toBe(sprintf('any', 'notifDeleteCronInfo', 'c1', '🔚 پایان زمان سرویس', -3, '0 B'));
    for (const st of ['active', 'limited', 'disabled', 'expired', 'on_hold'] as const) {
      expect(menu.panelStatusLabel(st)).toBe(legacy('status', st));
    }
    expect(menu.panelStatusLabel(null)).toBe(legacy('status', 'unknown'));
  });

  it('builds the three nightly messages from statusday.php’s pieces', () => {
    expect(menu.nightlyAgentsReport([{ telegramId: 1, username: 'a', totalIrr: 1_000_000 }])).toBe(
      legacy('any', 'dailyTopAgentsTitle') + sprintf('any', 'dailyTopAgentRow', 1, 'a', '100,000'),
    );
    expect(menu.nightlyReport({ renewals: 1, renewalsIrr: 10, orders: 2, ordersIrr: 20, trials: 3, volumeGb: 4, newUsers: 5 }))
      .toBe(sprintf('any', 'dailyBotReport', 1, '1', 2, '2', 3, 4, 5));
    expect(menu.nightlyPanelsReport([{ name: 'p', orders: 1, ordersIrr: 0, volumeGb: 10 }]))
      .toBe(legacy('any', 'dailyPanelsReportTitle') + sprintf('any', 'dailyPanelReportRow', 'p', 1, '0', 10));
  });
});
