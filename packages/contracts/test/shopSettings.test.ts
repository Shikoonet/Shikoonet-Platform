/**
 * The registry and the code must name the same settings.
 *
 * A list of keys maintained by hand rots in both directions, and each way costs
 * something different: a key the bot reads and the registry omits is a setting
 * the panel cannot change — invisible, and indistinguishable from «the shop
 * ignores it». A key in the registry that nothing reads is a control that
 * promises to do something and does nothing.
 *
 * So this asks the SOURCE rather than trusting a copy of it, which is the rule
 * this repository has been bitten for breaking: a sentence about the code is
 * not evidence about the code.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHOP_SETTINGS, isLiveSetting, shopSetting } from '../src/shopSettings.js';
import { REPORT_KINDS, reportTopicKey } from '../src/reportTopics.js';

const ROOT = resolve(process.cwd(), '..', '..');

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (/\.ts$/.test(p) && !/\.test\.ts$/.test(p)) out.push(p);
  }
  return out;
}

const SOURCES = [join(ROOT, 'apps', 'bot', 'src'), join(ROOT, 'apps', 'dashboard-worker', 'src')]
  .flatMap((d) => sourceFiles(d))
  .map((p) => readFileSync(p, 'utf8'))
  .join('\n');

/** `settingText(db, 'bot', 'daywarn')` and its two siblings. */
const READ = /setting(?:Text|Number|Is)\(\s*[^,]+,\s*'([a-z]+)'\s*,\s*'([^']+)'/g;

describe('the live-settings registry', () => {
  it('covers every key the bot and the dashboard read by name', () => {
    const missing: string[] = [];
    for (const m of SOURCES.matchAll(READ)) {
      const [, scope, key] = m;
      if (!isLiveSetting(scope!, key!)) missing.push(`${scope}/${key}`);
    }
    // Named rather than counted: a failure has to say WHICH key, or the next
    // person reads forty lines of registry looking for it.
    expect([...new Set(missing)]).toEqual([]);
  });

  it('covers the keys that are BUILT rather than typed out', () => {
    /*
     * The scan above cannot see these and never could.
     *
     * `loadShopSettings` reads the ten report topics as ``text(`topic_${k}`)``
     * — one template literal, ten keys, and a regex looking for a quoted string
     * matches none of them. The registry called all ten dead, the bot read all
     * ten every time it sent a report, and the cast on that line is what kept
     * the two from ever meeting: `as ShopSettingKey` told the compiler the
     * question had been answered.
     *
     * So the expectation is built from `REPORT_KINDS` — the same list the bot
     * loops over — and not from `SHOP_SETTINGS`, which is the thing under test.
     */
    const dead = REPORT_KINDS.map((k) => reportTopicKey(k)).filter(
      (key) => !isLiveSetting('bot', key),
    );
    expect(dead).toEqual([]);
  });

  it('says, for each switch, the exact words its reader recognises', () => {
    /*
     * A switch writes a value some other code has to recognise, and in this
     * shop no two of them agree on what that value is.
     *
     *   `Bot_Status`      off is exactly `botstatusoff`      (`isOff`)
     *   `statuscopycart`  off is exactly `0`                 (`isOff`)
     *   the cron toggles  on is `true`, off is `false`       (`bool`)
     *   `roll_Status`     on is exactly `rolleon`            (`===`)
     *
     * A form that writes a generic `'on'`/`'off'` for all of them is not a
     * form that turns things on and off — it is one that writes a word nobody
     * reads. `'off'` is not `botstatusoff`, so pressing «ربات روشن است» to
     * close the shop would have left the shop open and selling.
     */
    for (const s of SHOP_SETTINGS) {
      if (s.kind !== 'bool') continue;
      expect(s.truth, `${s.scope}/${s.key} truth`).toBeTruthy();
      expect(s.truth?.on, `${s.scope}/${s.key} on`).toBeTruthy();
      expect(s.truth?.off, `${s.scope}/${s.key} off`).toBeTruthy();
      expect(s.truth?.on, `${s.scope}/${s.key}`).not.toBe(s.truth?.off);
    }
  });

  it('takes those words from the reader, not from a second opinion', () => {
    /*
     * Read out of `apps/bot/src/settings.ts` itself, so the registry cannot
     * drift from the code that consumes it. `isOff(text('K'), 'W')` is the
     * whole rule for seven of the switches: `W` is the ONLY value that means
     * off, and everything else — including `'off'` — means on.
     */
    const IS_OFF = /isOff\(\s*text\('([^']+)'\)\s*,\s*'([^']*)'\s*\)/g;
    const wrong: string[] = [];
    let seen = 0;
    for (const m of SOURCES.matchAll(IS_OFF)) {
      const [, key, offWord] = m;
      seen += 1;
      const entry = SHOP_SETTINGS.find((s) => s.key === key);
      if (!entry) {
        wrong.push(`${key}: not in the registry`);
      } else if (entry.truth?.off !== offWord) {
        wrong.push(`${key}: reader says «${offWord}», registry says «${entry.truth?.off}»`);
      }
    }
    // Without this the regex could stop matching — a rename, a reformat — and
    // the loop would pass over nothing at all.
    expect(seen, 'isOff calls found in the bot source').toBeGreaterThanOrEqual(7);
    expect(wrong).toEqual([]);
  });

  it('never writes the word «on» to a switch whose reader has its own', () => {
    // The failure this whole block exists for, stated once as a fact rather
    // than as a mechanism: `Bot_Status` must not be written as `'on'`/`'off'`.
    const botStatus = shopSetting('bot', 'Bot_Status');
    expect(botStatus?.truth).toEqual({ on: 'botstatuson', off: 'botstatusoff', unknown: 'on' });
  });

  it('lists nothing twice', () => {
    const seen = SHOP_SETTINGS.map((s) => `${s.scope}/${s.key}`);
    expect(seen.length).toBe(new Set(seen).size);
  });

  it('gives every entry a label and a sentence, because the screen prints both', () => {
    for (const s of SHOP_SETTINGS) {
      expect(s.label.trim(), `${s.scope}/${s.key} label`).not.toBe('');
      expect(s.hint.trim(), `${s.scope}/${s.key} hint`).not.toBe('');
    }
  });

  it('does not offer the three things this shop decided not to have', () => {
    /*
     * Not an oversight in either direction.
     *
     * `Lottery_*` and `Dice` — Sam, 2026-08-20: «ما گردونه شانس نداریم». It ran
     * on the PHP bot (1,677 spins, the last on 07-28), so somebody reading the
     * imported settings will find it and think there is a gap. There is a
     * decision.
     *
     * `ticket*` — the department system is off in production and all seven of
     * its tickets are unread (Sam, 08-22).
     *
     * A key in this registry is a promise that changing it changes the shop.
     * For these three that promise would be false.
     */
    for (const gone of ['Lottery_Status', 'Lottery_Price', 'Dice', 'ticketstatus']) {
      expect(SHOP_SETTINGS.some((s) => s.key === gone), gone).toBe(false);
    }
  });

  it('marks a money setting as money, so the form asks in Toman', () => {
    // The shop stores integer Rial everywhere and speaks Toman only at an edge.
    // A form is an edge, and one that asks for «۵۰۰۰۰» meaning Rial when the
    // operator meant Toman is off by a factor of ten in the direction that
    // stops sales.
    for (const key of ['minbalancecart', 'maxbalancecart']) {
      expect(SHOP_SETTINGS.find((s) => s.key === key)?.kind, key).toBe('irr');
    }
  });
});
