/**
 * Whose name this panel wears.
 *
 * ## The guard that matters here is the source scan
 *
 * The rendering cases below prove the wiring, and they would keep passing if
 * somebody typed «شیکو» back into a fourth place tomorrow — the sidebar, a
 * heading, an `aria-label`, an empty state. The whole requirement is that OUR
 * name is not compiled into a bundle a reseller serves, and only a scan of the
 * source can say that.
 *
 * It reads the files rather than the built bundle on purpose: a test that
 * required `vite build` would be skipped the first time it was slow, and the
 * name it is looking for is a literal in the source either way.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BRAND_NAME } from '@shikoo/contracts';
import { brand, mark } from '../src/brand.js';
import { LoginPage } from '../src/LoginPage.js';

// `process.cwd()` rather than `import.meta.url`: these run under jsdom, where
// `import.meta.url` is an http URL and `fileURLToPath` refuses it. Vitest runs
// each package from its own root, which is what this is relative to.
const SRC = join(process.cwd(), 'src');
const INDEX_HTML = join(process.cwd(), 'index.html');

/** Every source file under `src/`, recursively. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sources(path));
    else if (/\.(ts|tsx|css|html)$/.test(entry)) out.push(path);
  }
  return out;
}

describe('the brand is not compiled in', () => {
  it('appears nowhere in the app source except as the fallback', async () => {
    const offenders: string[] = [];
    for (const path of sources(SRC)) {
      const text = readFileSync(path, 'utf8');
      if (!text.includes(DEFAULT_BRAND_NAME)) continue;
      // `brand.ts` is allowed to name it: that file's whole job is to hold the
      // fallback, and it imports the one definition from `@shikoo/contracts`
      // rather than retyping it. A second file naming it is the bug.
      if (path.endsWith(`${'brand'}.ts`)) continue;
      offenders.push(path.slice(SRC.length + 1).replace(/\\/g, '/'));
    }
    expect(offenders).toEqual([]);
  });

  it('is not in the static title either', () => {
    // `index.html` is served byte-for-byte by every installation, so a name in
    // it is a name a reseller cannot change. The tab is titled by `main.tsx`
    // once the server has said what to call it.
    const html = readFileSync(INDEX_HTML, 'utf8');
    expect(html).not.toContain(DEFAULT_BRAND_NAME);
    expect(html).toContain('<title>');
  });
});

describe('what the page draws', () => {
  it('signs in under whatever name the server gave', () => {
    // Not stubbed: `brand()` answers the module default here because no
    // `loadBrand()` has run, which is precisely the failure path — and the
    // point is that the card draws the resolved name rather than a literal.
    render(<LoginPage onSignedIn={() => undefined} />);
    expect(screen.getByText(brand())).toBeTruthy();
  });

  it('draws one whole character in the sidebar square', () => {
    // A lone surrogate here is a replacement box on somebody's panel.
    expect(Array.from(mark())).toHaveLength(1);
  });
});
