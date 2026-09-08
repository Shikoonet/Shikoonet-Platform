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
import { SHOP_SETTINGS, isLiveSetting } from '../src/shopSettings.js';

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
