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
COPY apps/dashboard-web/package.json       apps/dashboard-web/
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
# Both single-page apps, because one process serves both: the payment hub at `/`
# and the shop admin panel at `/admin`. `deploy/README.md` documented only the
# first for a while, and a missing build is a 500 rather than a failed deploy.
FROM deps AS build
COPY . .
RUN pnpm --filter @shikoo/dashboard-web --filter @shikoo/admin-web build

# -------------------------------------------------------------------- runtime
FROM build AS runtime

# Absolute, because the defaults in `server.ts` are relative to the working
# directory and would resolve outside /app.
ENV SPA_DIST=/app/apps/dashboard-web/dist
ENV ADMIN_DIST=/app/apps/admin-web/dist
ENV NODE_ENV=production

# Deliberately no HEALTHCHECK. Coolify's own health check is used instead, and
# it has to differ per service: ingest and the dashboard answer `/health`, while
# the bot opens no port at all — it long-polls outward, which is the reason it
# needs no inbound rule, no certificate and no DNS name. A Dockerfile
# HEALTHCHECK takes precedence over the panel, so defining one here would force
# all three to be checked the same way.

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
