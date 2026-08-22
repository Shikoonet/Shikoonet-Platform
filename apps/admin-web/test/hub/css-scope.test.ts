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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
