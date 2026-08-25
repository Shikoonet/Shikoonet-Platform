/**
 * The hub's stylesheet must not be able to paint the panel.
 *
 * Both sheets load into one document now. `styles.css` was written when it
 * owned the page — it set tokens on `:root`, painted `body`, and styled bare
 * `button`, `table` and `input` — and each of those, left alone, restyles a
 * panel screen that has nothing to do with payments. Every panel button was
 * gold for the length of one build.
 *
 * The comment at the top of that file says it is scoped. A comment is not
 * evidence, which is the whole lesson of `--workspace-concurrency=1`: this
 * reads the file and checks.
 *
 * What it allows through is deliberate and narrow:
 *
 *   - anything under `.hub`, which is the wrapper `HubSection` renders
 *   - `@keyframes` names and `@media` conditions, which select nothing
 *   - hub-only class names, which appear in no panel markup — prefixing all
 *     five hundred would be a 4,500-line diff buying nothing
 *
 * What it refuses is the shape that actually reaches out: a bare element
 * selector, or one of the nine class names both sheets define.
 */

import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Every source file under a directory, recursively. */
function filesUnder(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) filesUnder(p, out);
    else if (/\.(tsx?|html)$/.test(p)) out.push(p);
  }
  return out;
}

const CSS = readFileSync(resolve(process.cwd(), 'src/hub/styles.css'), 'utf8');
const PANEL_CSS = readFileSync(resolve(process.cwd(), 'src/theme.css'), 'utf8');

/** Selector text of every top-level rule, with comments and blocks stripped. */
function topLevelSelectors(css: string): string[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const selectors: string[] = [];
  let depth = 0;
  let buffer = '';
  for (const ch of noComments) {
    if (ch === '{') {
      if (depth === 0) selectors.push(buffer.trim());
      // An at-rule body (`@media`) holds rules of its own, and those reach just
      // as far as a top-level one. Counting depth rather than skipping means
      // they are collected too.
      depth++;
      buffer = '';
    } else if (ch === '}') {
      depth = Math.max(0, depth - 1);
      buffer = '';
    } else {
      buffer += ch;
    }
  }
  return selectors.filter(Boolean);
}

/** Class names a stylesheet defines, so the overlap is measured, not assumed. */
function classNames(css: string): Set<string> {
  return new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1]!));
}

describe('the hub stylesheet is scoped to .hub', () => {
  const selectors = topLevelSelectors(CSS)
    // `@media`/`@keyframes` conditions and frame percentages select nothing.
    .filter((s) => !s.startsWith('@'))
    .filter((s) => !/^(from|to|\d+%)$/.test(s.trim()));

  it('declares its design tokens on .hub, never on :root', () => {
    // The ten tokens both sheets define carry different values. On `:root` the
    // later sheet wins for the whole document, so the panel's accent turned
    // gold and its radii shrank — silently, because nothing errors.
    const rootRules = selectors.filter((s) =>
      s.split(',').some((part) => /(^|\s):root\s*$/.test(part.trim())),
    );
    expect(rootRules).toEqual([]);
  });

  it('has no bare element selector left at the document level', () => {
    const offenders = selectors.flatMap((rule) =>
      rule
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^[a-zA-Z]/.test(s) && !s.startsWith('.hub')),
    );
    expect(offenders).toEqual([]);
  });

  it('scopes every class name the panel also defines', () => {
    const shared = [...classNames(CSS)].filter((c) => classNames(PANEL_CSS).has(c) && c !== 'hub');
    // Not asserting a count: the point is that whatever the overlap turns out
    // to be, none of it is loose. A tenth colliding name added tomorrow has to
    // be scoped rather than merely counted.
    expect(shared.length).toBeGreaterThan(0);

    const loose = selectors.flatMap((rule) =>
      rule
        .split(',')
        .map((s) => s.trim())
        .filter((s) => !s.startsWith('.hub'))
        .filter((s) =>
          shared.some(
            (c) =>
              s.startsWith(`.${c}`) && /^[.:\s[]?$|^$/.test(s.slice(c.length + 1, c.length + 2)),
          ),
        ),
    );
    expect(loose).toEqual([]);
  });
});

/**
 * A badge that names a tone the stylesheet does not define is invisible, and
 * invisible in the way that is hardest to notice: it still renders, still
 * carries its text, and simply looks like every other badge on the screen.
 *
 * `StatusBadge` emits `status-badge status-badge--${tone}`. It used to be
 * `StatusChip` emitting `status-chip--${tone}`, and the rename moved the
 * component and half the stylesheet. `--verified` and `--neutral` were carried
 * over as doubled selectors; `--review`, `--waiting` and `--suspected` were
 * not, so the whole of «در انتظار بررسی» — three different kinds of attention
 * — drew three identical grey pills for weeks. Sam described that screen as
 * «نمیدونم چی به چیه».
 *
 * The tone union is the outside truth here, read from the component's own
 * source rather than restated: a tenth tone added tomorrow has to bring a rule
 * with it or fail here.
 */
describe('every badge tone the component can emit', () => {
  const COMPONENT = readFileSync(resolve(process.cwd(), 'src/hub/paymentsComponents.tsx'), 'utf8');

  /** `StatusBadgeTone`'s members, parsed out of the union declaration. */
  const TONES = (() => {
    const decl = /export type StatusBadgeTone =([\s\S]*?);/.exec(COMPONENT);
    if (!decl) throw new Error('StatusBadgeTone is not declared the way this test reads it');
    return [...decl[1]!.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]!);
  })();

  it('parses the union rather than trusting a copy of it', () => {
    // If the shape of the declaration changes, the sweep below would silently
    // check nothing. This is the tripwire for that.
    expect(TONES.length).toBeGreaterThanOrEqual(7);
    expect(TONES).toContain('no-transfer');
  });

  it('has a rule in the stylesheet', () => {
    const defined = new Set(
      [...CSS.matchAll(/\.status-badge--([a-z-]+)/g)].map((m) => m[1]!),
    );
    expect(TONES.filter((t) => !defined.has(t))).toEqual([]);
  });

  it('is defined after the base rule, whose border shorthand would win', () => {
    // `.status-badge` sets `border: 1px solid transparent`. Equal specificity,
    // so source order decides: a modifier above the base loses its
    // `border-color` outright. `--verified` did, for as long as it existed.
    const base = CSS.indexOf('\n.status-badge {');
    expect(base).toBeGreaterThan(-1);
    const early = TONES.filter((t) => {
      const at = CSS.indexOf(`\n.status-badge--${t} {`);
      return at > -1 && at < base;
    });
    expect(early).toEqual([]);
  });
});

/**
 * A rule whose class no file mentions cannot reach the browser.
 *
 * `hub/styles.css` is on its way out — the five money screens move onto
 * `theme.css` primitives and the file gets deleted. Until then it keeps
 * accumulating rules for markup that has already been rewritten: 801 lines of
 * it were removed on 2026-08-25, whole families at a time — `.payment-row*`
 * (the list before `hub-list-row`), `.payments-nav__*` (before `ops-nav`),
 * `.drawer-*` (the component was deleted three commits ago).
 *
 * This makes the file one-way. It is a source-level check, which is weaker
 * than asking a browser what it rendered — a class can be written and never
 * used — but what it catches, it catches with certainty: if the string is in
 * no file, nothing can put it in the DOM.
 *
 * `test/` and `e2e/` count as source. A Playwright spec selects by class, and
 * calling one dead would turn the browser run red — the slowest place to find
 * out.
 */
describe('rules for markup that no longer exists', () => {
  const SOURCE = [
    resolve(process.cwd(), 'src'),
    resolve(process.cwd(), 'test'),
    resolve(process.cwd(), '../dashboard-worker/e2e'),
  ]
    .flatMap((d) => filesUnder(d))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');

  /**
   * Prefixes that appear immediately before an interpolation, e.g. the
   * `status-badge--` of `` `status-badge--${tone}` ``.
   *
   * Without this the sweep reports every badge tone as dead, because no file
   * contains the string `status-badge--verified`. A census whose output is a
   * delete list has to answer "unknown", not "dead", when it cannot tell.
   */
  const DYNAMIC = [
    ...new Set([...SOURCE.matchAll(/([a-zA-Z_][\w-]*)\$\{/g)].map((m) => m[1]!)),
  ].filter((p) => p.length > 2);

  const mentioned = (c: string) => SOURCE.includes(c) || DYNAMIC.some((p) => c.startsWith(p));

  it('knows about interpolated class names', () => {
    // The tripwire for the sweep below: if this stops holding, every dynamic
    // class reads as dead and the assertion after it becomes noise.
    expect(DYNAMIC).toContain('status-badge--');
    expect(mentioned('status-badge--verified')).toBe(true);
  });

  it('are not in the stylesheet', () => {
    const dead = topLevelSelectors(CSS).flatMap((rule) =>
      rule
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((arm) => {
          // Inside :not()/:is()/:where()/:has() a dead class only narrows the
          // match — the rule still fires, so it is not evidence of death.
          const outside = arm.replace(/:(?:not|is|where|has)\([^()]*\)/g, ' ');
          const named = [...outside.matchAll(/\.([a-zA-Z_][\w-]*)/g)].map((m) => m[1]!);
          return named.length > 0 && named.some((c) => !mentioned(c));
        }),
    );
    expect(dead).toEqual([]);
  });
});
