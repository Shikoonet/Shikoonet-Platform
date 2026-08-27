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
import { execFileSync } from 'node:child_process';
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
      process.env[key] = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
    }
  }
}

loadSimEnv();

/**
 * Keep the loopback servers out of any HTTP proxy.
 *
 * Playwright's `webServer.url` readiness probe runs in this process and honours
 * `HTTP_PROXY`. On a machine with a VPN client exporting
 * `HTTP_PROXY=http://127.0.0.1:10808` — which is the normal state of the shell
 * this suite is run from — every probe of `http://127.0.0.1:8799/api/v1/health`
 * is answered **503 by the proxy**, including before the server is started. The
 * failure reads as "Timed out waiting from config.webServer" while the server
 * log right above it says `dashboard listening`, which sends you looking at the
 * server for an hour.
 */
process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1', 'localhost'].filter(Boolean).join(',');
process.env.no_proxy = process.env.NO_PROXY;

/**
 * A port this machine will actually let us bind.
 *
 * Not a constant, and this cost a run to find out. Windows keeps blocks of TCP
 * ports reserved for Hyper-V (`netsh interface ipv4 show excludedportrange`),
 * and **the blocks move when Docker Desktop restarts**. On 2026-08-24 a restart
 * put 8725–8824 out of reach, which is both ports this suite had hardcoded, and
 * the whole run died on `listen EACCES 127.0.0.1:8799` — an error that reads as
 * "something else is running" when nothing is.
 *
 * So the ports are probed rather than declared. `server.listen(0)` would be
 * simpler still, but the two servers have to be named in `webServer.url` before
 * they start, so the number must be known up front.
 */
function freePort(from: number, key: string): number {
  // Decided once, in the runner, and handed to the workers through the
  // environment. A spec importing this file re-evaluates it in its own process,
  // and probing again there returned a DIFFERENT port — the servers listened on
  // one number while every `page.goto` used another, which arrives as
  // ERR_CONNECTION_REFUSED and reads as "the server did not start".
  const already = process.env[key];
  if (already) return Number(already);
  // Wide, because the reserved blocks MOVE and they are not small. This span
  // was 200 ports when it was written on 2026-08-24; the next Docker Desktop
  // restart put 8424–9523 out of reach in one contiguous block and swallowed
  // the entire window, so the suite died in the config before a single test
  // ran. Probing 200 ports proved the mechanism and then failed at the first
  // change of weather. Anything under 1024 is privileged and anything over
  // ~49151 is the ephemeral range Windows hands out to clients, so this stays
  // inside the registered band and simply keeps looking.
  const SPAN = 8000;
  for (let port = from; port < from + SPAN; port++) {
    if (taken.has(port)) continue;
    try {
      // A real bind is the only proof. A reserved range refuses at bind time
      // and is invisible to anything that merely checks for a listener.
      execFileSync(
        process.execPath,
        [
          '-e',
          `const s=require('net').createServer();s.on('error',()=>process.exit(1));s.listen(${port},'127.0.0.1',()=>s.close(()=>process.exit(0)))`,
        ],
        { stdio: 'ignore' },
      );
      taken.add(port);
      process.env[key] = String(port);
      return port;
    } catch {
      // Reserved, or in use. Both mean "not this one".
    }
  }
  throw new Error(`no free port in ${from}..${from + SPAN}`);
}

const taken = new Set<number>();

// Not 8788: the local dashboard is often already running on that port, and
// `reuseExistingServer` would then quietly test whatever it happens to be
// serving, with whatever environment it happens to have.
const PORT = freePort(8799, 'E2E_PORT');

/**
 * A second server, without `TEST_ACCESS_USER`.
 *
 * The login form cannot be walked on the first one: the bypass signs an
 * identity in before the form is ever drawn, so a spec there would assert
 * against a panel that is already open. Two ports is the smallest way to have
 * both — the bypass for the twelve specs that are about the panel, and a real
 * front door for the ones that are about getting through it.
 */
export const LOGIN_PORT = freePort(PORT + 1, 'E2E_LOGIN_PORT');

const spaPath = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

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
  // `list` for a human reading the job log, `json` for the aggregator.
  //
  // `Required Quality Gate` asserts the scenario COUNT, not just the exit code:
  // a suite that silently collected 40 of its 104 scenarios — a bad shard
  // split, a `describe.skip`, a testDir that stopped matching — exits 0 and
  // reads as green. The json report is the only thing that can tell the
  // difference. It carries titles, files and outcomes; the page content lives
  // in the trace, which is uploaded only on failure and only after scrubbing.
  reporter: process.env.CI
    ? [['list'], ['json', { outputFile: 'playwright-report.json' }]]
    : 'html',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'retain-on-failure',
  },
  webServer: [
    {
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
        // Required since 2026-08-18 — `server.ts` refuses to start without it
        // rather than defaulting to `local`, because that default was what let a
        // mistyped `ENV_NAME` switch off every production guard silently.
        ENV_NAME: 'local',
        // The SPA build, absolute because `server.ts` resolves its default
        // against the working directory. `import.meta.url` is a file: URL, whose
        // pathname on Windows carries a leading slash before the drive letter.
        ADMIN_DIST: spaPath('../admin-web/dist'),
      },
    },
    {
      // No `--env-file`: that is where `TEST_ACCESS_USER` comes from, and the
      // whole point of this one is not having it. `loadSimEnv` above already
      // put `DATABASE_URL` in this process, so it is passed on explicitly.
      command: 'tsx src/server.ts',
      url: `http://127.0.0.1:${LOGIN_PORT}/api/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      env: {
        PORT: String(LOGIN_PORT),
        ENV_NAME: 'local',
        DATABASE_URL: process.env.DATABASE_URL ?? '',
        // Emptied on purpose, and this is the whole trick. Playwright merges
        // `process.env` into a webServer's environment, and `loadSimEnv` put
        // `TEST_ACCESS_USER` there — so dropping `--env-file` was not enough:
        // this server inherited the bypass anyway and served an already-open
        // panel. Every login spec failed against a page that was signed in.
        TEST_ACCESS_USER: '',
        ADMIN_DIST: spaPath('../admin-web/dist'),
      },
    },
  ],
});
