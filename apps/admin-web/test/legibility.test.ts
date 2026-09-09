/**
 * The panel's text is readable.
 *
 * Measured on staging 2026-09-09, `/admin/customers`: every customer link that
 * slice 2 put on nine screens renders `color: rgb(0, 0, 238)`. That is not a
 * colour anyone chose — it is the browser's default for an unvisited link, and
 * it is there because `theme.css` has no rule for `a` at all. Against the
 * panel's near-black surface it measures about 2:1, so the ids in the
 * «آیدی عددی» column are the least legible text on the screen, and they are
 * the column the whole slice exists to make clickable.
 *
 * ## Why the formula and not a screenshot
 *
 * The stylesheet agreeing with itself proves nothing here — the question is
 * whether a human can read it, and the answer to that lives outside this
 * repository, in WCAG 2.1's contrast definition. So the ratio is computed from
 * the spec's own arithmetic and compared to its own threshold (4.5:1 for body
 * text). Rule 6 of CLAUDE.md: check against the outside truth, not against the
 * code under test.
 *
 * ## Why two backgrounds
 *
 * `--surface-1` is translucent, so a link inside a card sits on the card
 * colour composited over the page. Both are dark, but they are not the same
 * dark, and a link has to clear the bar on whichever is lighter — so both are
 * measured and both must pass.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const THEME = readFileSync(resolve(process.cwd(), 'src/theme.css'), 'utf8');
const NO_COMMENTS = THEME.replace(/\/\*[\s\S]*?\*\//g, '');

type Rgb = [number, number, number];
type Rgba = [number, number, number, number];

/** `#rgb`, `#rrggbb`, `rgb(...)` and `rgba(...)`. Enough for this stylesheet. */
function parseColour(raw: string): Rgba {
  const v = raw.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(v);
  if (hex) {
    const h = hex[1]!;
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    return [
      parseInt(full.slice(0, 2), 16),
      parseInt(full.slice(2, 4), 16),
      parseInt(full.slice(4, 6), 16),
      1,
    ];
  }
  const fn = /^rgba?\(([^)]+)\)$/i.exec(v);
  if (fn) {
    const parts = fn[1]!.split(/[,/]/).map((p) => Number(p.trim()));
    return [parts[0]!, parts[1]!, parts[2]!, parts[3] ?? 1];
  }
  throw new Error(`not a colour this test can read: «${raw}»`);
}

/** The `:root` token table, so a rule that says `var(--accent)` can be followed. */
function rootTokens(css: string): Map<string, string> {
  const block = /:root\s*\{([^}]*)\}/.exec(css);
  if (!block) throw new Error('theme.css has no :root block');
  const out = new Map<string, string>();
  for (const line of block[1]!.split(';')) {
    const m = /^\s*(--[\w-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (m) out.set(m[1]!, m[2]!);
  }
  return out;
}

const TOKENS = rootTokens(NO_COMMENTS);

function resolveValue(value: string): string {
  let v = value.trim();
  // One level of indirection is all this stylesheet uses; the loop is a fence,
  // not a feature.
  for (let i = 0; i < 5; i += 1) {
    const m = /^var\(\s*(--[\w-]+)\s*\)$/.exec(v);
    if (!m) return v;
    const next = TOKENS.get(m[1]!);
    if (next === undefined) throw new Error(`:root does not define ${m[1]}`);
    v = next.trim();
  }
  throw new Error(`var() chain does not settle for «${value}»`);
}

/**
 * Every rule in the sheet, in document order, at-rules descended into.
 *
 * The first version of this counted braces and treated `@media` as one block,
 * which meant the rules INSIDE it were never looked at — while the comment
 * above it claimed the opposite, in the same breath as citing
 * `money-never-breaks.test.ts:52` for making that exact mistake. Proven with a
 * three-line stylesheet: the rule inside the media query was dropped and the
 * only thing reported was the top-level one.
 *
 * So at-rules are recursed into rather than skipped over. Document order is
 * preserved, which is what lets the caller take the last declaration as the
 * winner for equal specificity.
 */
function eachRule(css: string, visit: (selector: string, body: string) => void): void {
  let i = 0;
  let selStart = 0;
  while (i < css.length) {
    const ch = css[i];
    if (ch === '{') {
      const selector = css.slice(selStart, i).trim();
      let depth = 1;
      let j = i + 1;
      while (j < css.length && depth > 0) {
        if (css[j] === '{') depth += 1;
        else if (css[j] === '}') depth -= 1;
        j += 1;
      }
      const body = css.slice(i + 1, j - 1);
      // `@media`, `@supports`, `@layer` — the body holds rules, not
      // declarations. `@font-face` holds declarations and no selector matches
      // it, so recursing costs nothing and finds nothing.
      if (selector.startsWith('@')) eachRule(body, visit);
      else visit(selector, body);
      i = j;
      selStart = j;
    } else if (ch === '}') {
      i += 1;
      selStart = i;
    } else {
      i += 1;
    }
  }
}

/**
 * The value `prop` ends up with for `selector`, or null if nothing sets it.
 *
 * Last declaration wins, which is what the cascade does at equal specificity —
 * and every rule for a bare `a` has the same specificity, so a media query
 * later in the file really is the one that decides.
 */
function declaredValue(css: string, selector: string, prop: string): string | null {
  let found: string | null = null;
  eachRule(css, (sel, body) => {
    if (!sel.split(',').some((s) => s.trim() === selector)) return;
    const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;}]+)`, 'g');
    let hit: RegExpExecArray | null;
    while ((hit = m.exec(body))) found = hit[1]!.trim();
  });
  return found;
}

/** WCAG 2.1 relative luminance. */
function luminance([r, g, b]: Rgb): number {
  const chan = (n: number) => {
    const s = n / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

function over([r, g, b, a]: Rgba, bg: Rgb): Rgb {
  return [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
}

function contrast(fg: Rgb, bg: Rgb): number {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

describe('text is readable on the panel background', () => {
  const body = over(parseColour(resolveValue('var(--bg-body)')), [0, 0, 0]);
  const card = over(parseColour(resolveValue('var(--surface-1)')), body);

  it('colours a plain <a> at all', () => {
    // Without this the panel takes the browser's `#0000EE`, which is what
    // staging was serving.
    expect(declaredValue(NO_COMMENTS, 'a', 'color')).not.toBeNull();
  });

  it('clears 4.5:1 on the page and inside a card', () => {
    const declared = declaredValue(NO_COMMENTS, 'a', 'color');
    expect(declared).not.toBeNull();
    const link = over(parseColour(resolveValue(declared!)), body);

    expect(contrast(link, body)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(link, card)).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * Tokens that colour text a person has to READ, against the two grounds the
   * panel puts them on.
   *
   * `--text-dim` is not decoration: it carries «چیزی یافت نشد» in an empty
   * table — which is the ONLY text on the screen when a table is empty — the
   * sidebar's group labels, and the device code on a device card. Measured at
   * about 3.1:1 before this, which is below the bar for body text at any size
   * the panel uses it at.
   */
  it.each([['--text-muted'], ['--text-dim']])('%s clears 4.5:1 on both grounds', (token) => {
    const fg = over(parseColour(resolveValue(`var(${token})`)), body);
    expect(contrast(fg, body)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(fg, card)).toBeGreaterThanOrEqual(4.5);
  });

  it('reads a rule inside a media query, which the first parser did not', () => {
    /*
     * The instrument, checked against a stylesheet whose answer is known.
     *
     * The first version of `declaredValue` counted braces and handed `@media`
     * back as a single block, so the rules inside it were never visited — and
     * every assertion above would have passed over a link colour overridden
     * there. `money-never-breaks.test.ts` records the same trap at its line 52;
     * this one repeats it while citing it.
     */
    const sheet = [
      'a { color: #111111; }',
      '@media (max-width: 720px) { a { color: #222222; } }',
    ].join('\n');
    expect(declaredValue(sheet, 'a', 'color')).toBe('#222222');
    // And a plain sheet still works, so the fix did not trade one blindness
    // for another.
    expect(declaredValue('a { color: #333333; }', 'a', 'color')).toBe('#333333');
    expect(declaredValue('b { color: #333333; }', 'a', 'color')).toBeNull();
  });

  it('measures the browser default as the failure it is', () => {
    // Guards the instrument: if this arithmetic ever called `#0000EE` legible,
    // the two tests above would pass over the very bug they were written for.
    expect(contrast(over(parseColour('#0000EE'), body), body)).toBeLessThan(4.5);
    // And a colour that plainly IS legible has to come out above the bar, or
    // the test is merely rejecting everything.
    expect(contrast(over(parseColour('#ffffff'), body), body)).toBeGreaterThanOrEqual(4.5);
  });
});
