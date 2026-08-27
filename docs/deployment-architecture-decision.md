# Two deployment pipelines, and which one runs

Two open pull requests each proposed a way to get a commit onto the staging
host. They are not complementary — running both means two things deciding to
deploy, which is the failure this document exists to prevent.

**PR #3 (server-side `deploy/autodeploy.sh`) is the selected architecture.**
Decided 2026-08-27.

## The comparison

| | **PR #2** — GitHub Actions drives it | **PR #3** — the server asks |
| --- | --- | --- |
| **Trigger** | `deploy.yml` called on push to `main`, plus `workflow_dispatch` for promote and rollback | `shikoo-autodeploy.timer` polls GitHub every 2 minutes |
| **Direction** | inbound: GitHub SSHes into the host | outbound: the host asks GitHub |
| **GitHub credentials** | the automatic `GITHUB_TOKEN` (for GHCR) | one fine-grained read-only PAT, on the server |
| **Coolify credentials** | `COOLIFY_TOKEN` in a per-environment file on the host | same, in `/etc/shikoo/autodeploy.env` |
| **SSH** | **required** — five `DEPLOY_*` secrets per environment, including a private key held by GitHub | **none**. Nothing external needs to reach the host |
| **CI-gate validation** | implicit: the deploy job runs after CI in the same workflow | explicit: the `push` run on that exact sha must be `completed`/`success`, and a job named `Required Quality Gate` inside it must have succeeded |
| **Approval validation** | none — a push to `main` deploys | the sha must be the merge result of a PR merged into `main`, with a current `APPROVED` review from someone other than the author, on the PR's final head |
| **Exact-SHA deployment** | **stronger**: builds one image, deploys it by digest (`build_pack=dockerimage`, tag `sha256-<hex>`) — the artifact CI tested is the artifact that runs | pins `git_commit_sha` and lets Coolify rebuild per application; the deployed sha is verified through `SOURCE_COMMIT`, but three rebuilds happen |
| **Rollback** | manual `workflow_dispatch` to any previous digest, plus automatic restore on failure | automatic on failure, to the previous recorded sha. No manual entry point |
| **Health checks** | per-app wait, smoke test, bot-singleton via `pg_locks` | per-app wait, `/health` + `/version`, session gate still 401, bot-singleton via `pg_locks` |
| **Secret storage** | GitHub Environment Secrets **and** host files — two places | host only |
| **Auto-deploy blast radius** | `deploy-staging` has **no `if:` guard** and `ci.yml` triggers on `push: branches: ['**']` — every push to every branch deploys; `deploy-production` fires on `main` gated only by `vars.PRODUCTION_AUTO_DEPLOY` | one timer, one lock, four gates before anything moves |
| **Duplicate-deployment risk** | GitHub's environment concurrency, plus a host `flock` | one `flock`, taken before any decision or API call |

## Why PR #3

The deciding property is not on the table above: **PR #2 has no approval gate.**
A push to `main` deploys, and this organisation is on GitHub Free, where branch
protection cannot be enforced. So under PR #2 a direct unreviewed push reaches
customers. PR #3 refuses one.

The second is the SSH surface. PR #2 needs GitHub to hold a private key that
opens a shell on the Coolify host, and needs that host reachable from the
internet. PR #3 needs neither: the host makes outbound calls only, and the
Coolify token never leaves loopback.

## What was ported out of PR #2

Both were genuinely better, and neither depended on its architecture:

1. **The bot singleton is proven from `pg_locks`, not from container count.**
   Counting containers cannot see the case that matters — an old container
   mid-exit still holding its advisory lock while a new one polls. PR #2 counted
   granted advisory locks in the `0x5368_0000` namespace, read out of
   `apps/bot/src/singleton.ts`. PR #3 does that now, and has tests for one
   container with two holders and for a healthy container holding none.

2. **The credential file is read as text, not `.`-sourced.** Sourcing makes
   every value a shell expression — a Coolify token beginning `N|` becomes a
   pipeline — and hands anybody who can write the file arbitrary code as root.
   PR #2 read values with `sed`; PR #3 does now too, and the quoting rule its
   README used to carry is gone.

## What remains unique to PR #2, and is not ported

**Build once, deploy the digest.** PR #2 builds a single image in CI, pushes it
to GHCR, and points Coolify at `build_pack=dockerimage` with the tag
`sha256-<hex>` — which Coolify reads as a digest pull. Three consequences PR #3
does not have:

* the artifact CI tested is bit-for-bit the artifact that runs, rather than
  three later rebuilds of the same commit;
* one build per deploy instead of three;
* a staging→production promotion that ships *the same digest*, which is what
  makes "it passed in staging" mean anything.

This was **not** ported, and that is a scope decision rather than a judgement
that it is wrong. It changes what CI does (build and push to GHCR), what
credential Coolify needs (a registry pull secret instead of a git source), and
the build pack on all three applications. It is also only half-useful until
there is a production environment to promote *to*, and today there is one host.

The Dockerfile now pins `node:22-slim` by digest, which closes the largest part
of the gap for a fraction of the cost — but **it does not close it**. `apt-get`
still fetches whatever Debian currently serves, and any network step is a moment
in time. Two builds of one commit are *closer* to identical, not identical. Only
build-once-deploy-the-digest makes the tested artifact and the deployed artifact
the same bytes.

**It should be revisited when production exists.** The digest mechanism and
PR #3's approval gate are compatible: nothing about pinning a digest requires
GitHub Actions to be the thing that decides.

Also unique, and deliberately not carried over: `promote.yml`, `rollback.yml`
and `deploy/host/provision-deploy-user.sh` — all three exist to serve the
Actions-driven model, and the `DEPLOY_*` secrets they read stay uncreated.
