/**
 * A link in the panel is readable.
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
 * The value `prop` ends up with for `selector`, or null if nothing sets it.
 *
 * Brace-counted rather than matched with `([^{}]+)\{([^{}]*)\}`, which cannot
 * see inside `@media` — the mistake `money-never-breaks.test.ts` records at its
 * own line 52, where a broken instrument reported three confident failures.
 * Last declaration wins, which is what the cascade does for equal specificity.
 */
function declaredValue(css: string, selector: string, prop: string): string | null {
  let found: string | null = null;
  let depth = 0;
  let blockStart = 0;
  let selStart = 0;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      if (depth === 0) blockStart = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        const sel = css.slice(selStart, blockStart).trim();
        const body = css.slice(blockStart + 1, i);
        if (sel.split(',').some((s) => s.trim() === selector)) {
          const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*([^;}]+)`, 'g');
          let hit: RegExpExecArray | null;
          while ((hit = m.exec(body))) found = hit[1]!.trim();
        }
        selStart = i + 1;
      } else if (depth === 1) {
        // Leaving a nested rule inside `@media`: the next selector starts here.
        selStart = i + 1;
      }
    } else if (depth === 1 && ch === '{') {
      selStart = i + 1;
    }
  }
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

describe('a link is readable on the panel background', () => {
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

  it('measures the browser default as the failure it is', () => {
    // Guards the instrument: if this arithmetic ever called `#0000EE` legible,
    // the two tests above would pass over the very bug they were written for.
    expect(contrast(over(parseColour('#0000EE'), body), body)).toBeLessThan(4.5);
    // And a colour that plainly IS legible has to come out above the bar, or
    // the test is merely rejecting everything.
    expect(contrast(over(parseColour('#ffffff'), body), body)).toBeGreaterThanOrEqual(4.5);
  });
});
