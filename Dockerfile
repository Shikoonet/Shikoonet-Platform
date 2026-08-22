# One image, three services.
#
# The bot, ingest and the dashboard share a workspace, a database adapter and a
# contracts package, and they differ by one line: which entry point runs. Three
# Dockerfiles would be three copies of the same install drifting apart, so this
# builds once and `SERVICE` decides at start.
#
# ## Why TypeScript is still TypeScript at runtime
#
# Every workspace package resolves through `"main": "./src/index.ts"`, and the
# whole tree is written for `moduleResolution: "Bundler"` — imports have no file
# extension. A plain `tsc` emit is therefore not runnable under Node ESM, which
# is why `dist/server.js` never existed despite three systemd units naming it.
#
# So `tsx` does the resolving, and it is a real dependency of each app rather
# than a root devDependency. That distinction was the second reason the previous
# recipe could not work: `pnpm deploy --prod` prunes devDependencies. (It cannot
# run here at all, as it happens — this workspace does not set
# `inject-workspace-packages` — which is the third.)
#
# Bundling with esbuild was the earlier plan and is not needed once this is an
# image: its whole purpose was to avoid shipping `node_modules` to a server, and
# in an image `node_modules` is simply part of the artifact.

FROM node:22-slim AS base
# Two statements, not one: a variable is not yet defined within the ENV that
# declares it, so `PATH=$PNPM_HOME:$PATH` in the same line expands to an empty
# prefix and BuildKit warns about it.
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ---------------------------------------------------------------- dependencies
# Manifests first and source second, so editing a handler does not reinstall the
# workspace. `--frozen-lockfile` makes a lockfile that disagrees with a manifest
# a build failure rather than a silent resolution.
FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/bot/package.json                 apps/bot/
COPY apps/ingest-worker/package.json       apps/ingest-worker/
COPY apps/dashboard-worker/package.json    apps/dashboard-worker/
COPY apps/admin-web/package.json           apps/admin-web/
COPY packages/contracts/package.json       packages/contracts/
COPY packages/database/package.json        packages/database/
COPY packages/db/package.json              packages/db/
COPY packages/domain/package.json          packages/domain/
COPY packages/migrate/package.json         packages/migrate/
COPY packages/seed/package.json            packages/seed/
COPY packages/sms-parser/package.json      packages/sms-parser/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile

# ---------------------------------------------------------------------- build
# One single-page app. There were two — the payment hub at `/` and the shop
# admin panel at `/admin` — until they were merged on 2026-08-16; `/` is a
# redirect now. A missing build is a 500 rather than a failed deploy, so this
# stage failing is the cheaper of the two places to find out.
FROM deps AS build
COPY . .
RUN pnpm --filter @shikoo/admin-web build

# ------------------------------------------------------- production modules
# The same install, without anything only a developer needs.
#
# `pnpm deploy --prod` is the tool for this and cannot run here — the note at the
# top of this file gives the reason — but a second plain install with `--prod`
# does the same pruning, and it reuses the lockfile so nothing can resolve
# differently from the build above.
#
# It is a separate stage rather than a `prune` step inside `deps`, because the
# build genuinely needs the dev half: `pnpm --filter @shikoo/admin-web build`
# runs `tsc` and `vite`, both devDependencies.
FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/bot/package.json                 apps/bot/
COPY apps/ingest-worker/package.json       apps/ingest-worker/
COPY apps/dashboard-worker/package.json    apps/dashboard-worker/
COPY apps/admin-web/package.json           apps/admin-web/
COPY packages/contracts/package.json       packages/contracts/
COPY packages/database/package.json        packages/database/
COPY packages/db/package.json              packages/db/
COPY packages/domain/package.json          packages/domain/
COPY packages/migrate/package.json         packages/migrate/
COPY packages/seed/package.json            packages/seed/
COPY packages/sms-parser/package.json      packages/sms-parser/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --prod --frozen-lockfile

# -------------------------------------------------------------------- runtime
# A stage of its own, which it was not until 2026-08-22.
#
# `FROM build` shipped the build stage verbatim: vitest, playwright, eslint and
# typescript — 29 of the 290 installed packages — plus every test file and every
# e2e spec, in the image three public-facing services run from. Nothing executed
# them, which is exactly why nobody noticed: `pnpm audit --prod` reads the
# manifests and reports zero, while an image scanner reads what is actually in
# the layers and reports what a test runner drags in.
#
# What is copied is written out one line per workspace instead of `COPY . .`,
# and that is the point. The runtime needs `src` and nothing else beside it, so
# a package added later and forgotten here fails at boot with a module it cannot
# resolve — loudly, on the first deploy — rather than quietly shipping its tests
# along with everything else.
#
# `src` and not `dist`, still: every workspace resolves through
# `"main": "./src/index.ts"` and `tsx` does the resolving at runtime. The
# TypeScript IS the artifact here; see the note at the top of this file. The one
# exception is the SPA, which really is built, and is taken from `build` rather
# than from the context so a Windows-built `dist` can never ship.
FROM node:22-slim AS runtime
WORKDIR /app

# Manifests and the pruned module tree, together, because pnpm's per-package
# `node_modules` are symlinks into the root store and only mean anything beside
# the package.json files they were installed from.
COPY --from=prod-deps /app ./

COPY packages/contracts/src   packages/contracts/src
COPY packages/database/src    packages/database/src
COPY packages/db/src          packages/db/src
COPY packages/domain/src      packages/domain/src
COPY packages/migrate/src     packages/migrate/src
COPY packages/seed/src        packages/seed/src
COPY packages/sms-parser/src  packages/sms-parser/src
COPY apps/bot/src             apps/bot/src
COPY apps/ingest-worker/src   apps/ingest-worker/src
COPY apps/dashboard-worker/src apps/dashboard-worker/src
COPY apps/dashboard-worker/scripts apps/dashboard-worker/scripts

# The schema ledger reads these at boot and `SERVICE=migrate` applies them.
COPY migrations migrations

COPY --from=build /app/apps/admin-web/dist apps/admin-web/dist

# Absolute, because the default in `server.ts` is relative to the working
# directory and would resolve outside /app.
ENV ADMIN_DIST=/app/apps/admin-web/dist
ENV NODE_ENV=production

# Bind to every interface, because in here that is what "reachable" means.
#
# The default in `server.ts` is `127.0.0.1` and stays that way: on a laptop it
# is the right answer, and a server that binds every interface by default is
# one somebody exposes without deciding to. Inside a container it is the wrong
# answer in the worst way — the process starts, the health check curls
# 127.0.0.1 from inside and passes, and nothing outside can reach it. A
# service that looks healthy and answers nobody.
#
# So the value is set where the fact is known, rather than left to whoever
# writes the next environment file to remember.
ENV HOST=0.0.0.0

# The health check has to live here, not in the panel.
#
# Coolify's own check shells `curl` (falling back to `wget`) into the container,
# and this image has neither — `node:22-slim` ships no HTTP client but Node
# itself. Enabled in the panel, it would mark all three services unhealthy while
# all three were fine, which is the worse failure: a red light that means
# nothing teaches you to ignore the light.
#
# So Node does it, and reads `SERVICE` to know what it is checking. Three
# behaviours, deliberately unequal:
#
#   ingest      GET /health              expects 200
#   dashboard   GET /api/v1/health       expects 200
#   bot         heartbeat file age       expects < 90s
#
# The dashboard used to be expected to answer 401: every path sat behind the
# Cloudflare Access middleware and this probe runs from inside the container,
# where no Access JWT existed and never would. Access is gone (2026-08-16) and
# `/api/v1/health` is now deliberately outside the session gate — for exactly
# this probe, and because it reveals nothing. 401 is still accepted so an older
# image and a newer one report the same thing while a deploy is half done.
#
# The bot's branch used to be `process.exit(0)` — its own comment admitted it
# proved only that PID 1 is alive, which Docker already knew. That was fair
# while exiting was the bot's only interesting failure. It is not any more: a
# process that is alive and NOT polling is the shape of every failure it has
# now — a cycle wedged on a request, Postgres unreachable so every cycle throws,
# or (since singleton.ts) a poller waiting for another to release the token. In
# all three the container is up and no customer is being answered.
#
# So it reads a file whose mtime the poll loop bumps once per completed cycle.
# 90s is three 25-second polls plus slack; with retries=3 a container has to be
# silent for about four and a half minutes before it is called unhealthy, which
# is longer than any backoff the loop takes by itself.
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 CMD ["node","-e","const s=process.env.SERVICE;if(s==='bot'){const f=process.env.BOT_HEARTBEAT_PATH||require('path').join(require('os').tmpdir(),'shikoo-bot-alive');try{process.exit(Date.now()-require('fs').statSync(f).mtimeMs<90000?0:1)}catch{process.exit(1)}}if(s!=='ingest'&&s!=='dashboard')process.exit(1);const p=process.env.PORT||(s==='ingest'?8787:8788);const u='http://127.0.0.1:'+p+(s==='ingest'?'/health':'/api/v1/health');fetch(u).then(r=>process.exit(r.status===200||(s==='dashboard'&&r.status===401)?0:1),()=>process.exit(1))"]

# Not root. Nothing here writes to the filesystem; the image ships with a user
# that could not anyway.
USER node

# `--chmod`, rather than trusting the mode the file arrives with.
#
# It arrived with 100644 and the image built perfectly and then could not start
# a single container: `exec: "/usr/local/bin/entrypoint.sh": permission denied`,
# on the first real deploy, after everything else had already worked. A plain
# `COPY` carries the source file's mode, and that mode is a bit in the git index
# which a Windows checkout, a zip export or an archive extraction will not
# reproduce — so the image was depending on how it happened to be fetched.
#
# The obvious repair is a `RUN chmod +x` on the next line, and it fails too:
# `USER node` is already in force above, the file belongs to root, and an
# unprivileged chmod on somebody else's file is «Operation not permitted». The
# flag does it at copy time instead, as root, in the layer that was being
# written anyway.
#
# The committed mode is fixed as well, but this is the half that cannot regress.
COPY --chmod=0755 deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
