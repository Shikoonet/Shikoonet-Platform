/**
 * A money figure is one word, whatever the column is doing.
 *
 * Staging, 2026-09-08: «۲٬۷۲۰٬۵۴۵ تومان» rendered as «۲٬۷۲۰٬۵۴» / «۵ تومان» on
 * «امروز» at 1440px. Two lines, and the first one is a smaller, entirely
 * plausible number — which is worse than a value cut off, because nothing
 * about it looks cut off.
 *
 * ## Why this is a stylesheet test and not a browser one
 *
 * It was written as an e2e first and thrown away, and the reason is worth
 * keeping. Against the seeded database the money column is never squeezed
 * enough to break — the assertion passed at 1440, passed at 780, and passed
 * with the whole CSS rule DELETED. A test that cannot fail is silent, not
 * green, and shipping one would have been the more expensive mistake.
 * Reproducing it needs staging's real device names and account hints.
 *
 * What can be asserted without a browser is the thing that was actually
 * wrong, and it is not «is nowrap set». `hub/styles.css` sets
 * `word-break: break-word` on every `.data-table` cell, and `word-break`
 * breaks INSIDE a number no matter what `white-space` says — measured in
 * Chromium the same day: `ws=nowrap wb=break-word` on a 150px cell. That file
 * had already written the lesson down at its own line 3039, about a different
 * property it could not override. So the claim is: a money cell turns
 * `word-break` back off, and does it from a selector that outranks the one
 * turning it on.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const THEME = readFileSync(resolve(process.cwd(), 'src/theme.css'), 'utf8');
const HUB = readFileSync(resolve(process.cwd(), 'src/hub/styles.css'), 'utf8');

/** (ids, classes+attrs+pseudo-classes, elements) — enough for these selectors. */
function specificity(sel: string): [number, number, number] {
  const s = sel.trim();
  return [
    (s.match(/#[\w-]+/g) ?? []).length,
    (s.match(/\.[\w-]+/g) ?? []).length + (s.match(/\[[^\]]+\]/g) ?? []).length,
    (s.match(/(^|[\s>+~])[a-z]+/g) ?? []).length,
  ];
}

const beats = (a: [number, number, number], b: [number, number, number]) =>
  a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];

/**
 * Every selector whose block sets `prop` to `value`.
 *
 * Walked backwards from the declaration rather than matched with one regex:
 * `([^{}]+)\{([^{}]*)\}` cannot see inside `@media`, and both stylesheets are
 * full of them. It found nothing at all and reported three confident failures,
 * which is the sort of green-or-red a broken instrument gives either way.
 */
function selectorsSetting(css: string, prop: string, value: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  // `\\s` and not `\s`: inside a template literal the single backslash is
  // dropped before `RegExp` ever sees it, and the pattern silently becomes
  // `word-breaks*:s*normal` — which matches nothing and fails every assertion
  // with total confidence.
  const decl = new RegExp(`${prop}\\s*:\\s*${value}\\s*[;}]`, 'g');
  for (const m of clean.matchAll(decl)) {
    const open = clean.lastIndexOf('{', m.index);
    if (open === -1) continue;
    const before = clean.slice(0, open);
    const start = Math.max(before.lastIndexOf('}'), before.lastIndexOf('{')) + 1;
    for (const sel of clean.slice(start, open).split(',')) {
      const t = sel.trim();
      if (t && !t.startsWith('@')) out.push(t);
    }
  }
  return out;
}

describe('a money cell', () => {
  it('is what the hub turns word-break ON for, which is the bug', () => {
    // The premise. If this ever stops being true the fix below is dead weight
    // and this test says so instead of passing quietly.
    const on = selectorsSetting(HUB, 'word-break', 'break-word');
    expect(on.some((s) => /\.data-table\s+td$/.test(s))).toBe(true);
  });

  it('turns it back off, from a selector that outranks the one turning it on', () => {
    // Both stylesheets, because the winning rule lives in the hub's own file:
    // naming `.data-table` from `theme.css` made it a class both define, and
    // `css-scope.test.ts` refuses that — correctly.
    const off = [
      ...selectorsSetting(THEME, 'word-break', 'normal'),
      ...selectorsSetting(HUB, 'word-break', 'normal'),
    ];
    expect(off.length).toBeGreaterThan(0);

    const culprit = specificity('.data-table td');
    const winners = off.filter((s) => /\.num|\.money/.test(s) && !beats(culprit, specificity(s)));
    expect(winners.length).toBeGreaterThan(0);
  });

  it('does not wrap at the space before «تومان» either', () => {
    const nowrap = [
      ...selectorsSetting(THEME, 'white-space', 'nowrap'),
      ...selectorsSetting(HUB, 'white-space', 'nowrap'),
    ];
    expect(nowrap.some((s) => /td\.num|td\.money/.test(s))).toBe(true);
  });
});
