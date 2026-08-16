/**
 * The browser half of the end-to-end walk.
 *
 * `docs/STATUS.md` has carried "Playwright environment not built" as immediate
 * debt since the stack moved off Workers: `@playwright/test` was a dependency
 * here with no config and no spec, and the only specs in the tree were the old
 * hub's, under `legacy/`.
 *
 * It lives in this package rather than in a new `e2e/` workspace, which is what
 * the plan first called for. That call was made when the walk still had a bot
 * half, and a suite spanning the bot and the dashboard belonged to neither. The
 * bot half is a supervised pre-release walk now — the fake Telegram was thrown
 * away on 2026-08-15 precisely because it could not prove what a real client
 * proves — so what is left is this app's own SPA against this app's own server.
 * A workspace for that would be a package.json, a lockfile entry and a second
 * copy of a dependency this package already declares.
 *
 * Not part of `pnpm test`: it needs a server, a browser and a database that the
 * unit suites do not. Run it deliberately with `pnpm e2e`.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@playwright/test';

/**
 * The same file the server is started with, read here too.
 *
 * `--env-file` on the server covers the server. The runner is a separate
 * process, and both the global setup and the specs need the same database and
 * the same identity — otherwise the setup grants a role to one address while
 * the browser signs in as another, which is a 403 that looks like a bug in the
 * panel. Read rather than required, so a missing file is a clear message.
 */
function loadSimEnv(): void {
  const path = fileURLToPath(new URL('../../sim/.env.local', import.meta.url));
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    throw new Error(`${path} is missing — the simulation environment is not set up`);
  }
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    // An explicit environment variable wins, so a one-off run can point
    // somewhere else without editing the file.
    if (process.env[key] === undefined) {
      process.env[key] = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
}

loadSimEnv();

// Not 8788: the local dashboard is often already running on that port, and
// `reuseExistingServer` would then quietly test whatever it happens to be
// serving, with whatever environment it happens to have.
const PORT = 8799;

const spaPath = (relative: string): string =>
  fileURLToPath(new URL(relative, import.meta.url));

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  // Serial, and not for speed: these specs write to the same shop-wide rows
  // (a bot text, a keyboard layout, a switch) and then assert on them. Parallel
  // workers would be two admins editing one setting and asserting each other's
  // value — the flake would look like a product bug.
  workers: 1,
  fullyParallel: false,
  // A `.only` left in a spec silently narrows the suite to one test while the
  // run still reports success.
  forbidOnly: Boolean(process.env.CI),
  reporter: process.env.CI ? 'list' : 'html',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: {
    // The same entry point production runs, not a test double: `server.ts` is
    // where the SPA mounts, where `/admin` is split from `/`, and where a
    // mistake in any of that would not show up in a route-level test.
    // `--env-file` rather than an env block of our own, and the reason is a
    // bug this config had for one run: it invented `dev@shikoo.local` as the
    // test identity, and every request came back 403. `TEST_ACCESS_USER` only
    // skips the Access JWT — the role still has to exist in `access_users`, and
    // the only address the seed runner grants ADMIN is the one written in
    // `sim/.env.local`. Reading that file means the identity, the database and
    // the panel credentials are the same ones every other local command uses.
    command: 'tsx --env-file=../../sim/.env.local src/server.ts',
    url: `http://127.0.0.1:${PORT}/api/v1/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      // The two SPA builds, absolute because `server.ts` resolves its defaults
      // against the working directory. `import.meta.url` is a file: URL, whose
      // pathname on Windows carries a leading slash before the drive letter.
      SPA_DIST: spaPath('../dashboard-web/dist'),
      ADMIN_DIST: spaPath('../admin-web/dist'),
    },
  },
});
