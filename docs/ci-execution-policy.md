# CI execution policy

What runs, when, what it costs, and how to put it back.

The authoritative description of each job lives in the header of
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml). This file is the
operational summary: the matrix, the classifier rules, the budget, and the
rollback.

---

## The constraint

GitHub Free, private repository: **2,000 Actions minutes a month.** Every job is
billed rounded UP to the whole minute, so nine jobs cost at least nine minutes
however fast they are.

Measured over 2026-08-01→09-01, every run billed individually from GitHub's own
job timestamps:

| | runs | billed |
| --- | ---: | ---: |
| `ci.yml` | 292 | 3,863 |
| deploy + production workflows | 31 | 100 |
| **August actual** | **323** | **3,963** |

Two facts drove the 2026-09-01 Phase 2 restructure.

**Twenty-one billed minutes bought twelve and a half minutes of testing.**
Measured per phase across the nine jobs of run `33528524468`:

| phase | seconds |
| --- | ---: |
| actual test execution | 751 |
| per-job minute rounding | 257 |
| service container starts (4 × Postgres/MySQL) | 119 |
| building `rhysd/actionlint` from source | 40 |
| node/pnpm setup, five times | 34 |
| checkout, six times | 19 |
| `pnpm install`, five times | 13 |

Note the last row. Installing dependencies fewer times — the obvious lever — was
measured and **not** taken: five installs cost thirteen seconds between them,
because `setup-node`'s pnpm cache already works. The money was in rounding,
container starts, and one Docker action.

**Ninety-three of the 133 pushes to `main` were direct pushes**, resolved one at
a time against `GET /commits/{sha}/pulls`. Under the previous shape each ran the
complete 23-minute fallback — 2,139 minutes a month — on commits
[`deploy/approval-gate.sh`](../deploy/approval-gate.sh) condition 1 already
refuses to deploy.

---

## The matrix

| event | jobs | billed |
| --- | --- | ---: |
| Draft PR | `checks` + gate | **4** |
| Draft PR, docs-only | `checks` (no Node) + gate | **3** |
| Ready PR, `apps/admin-web` only | `checks` + `integration-e2e` + gate | **11** |
| Ready PR, `apps/bot` only | `checks` + `integration-db` + gate | **10** |
| Ready PR, complete gate | `checks` + both executors + gate | **16–17** |
| `main`, proven | `checks` (plan only) + `image` + gate | **4** |
| `main`, direct push | `checks` (plan only) + gate → **BLOCKED** | **2** |
| `main`, unproven for any other reason | complete gate + `image` | **17–18** |

Before Phase 2: Draft 6, Ready 21, main proven 4, main fallback 23.

### What each job runs

**`checks`** — classification, then the static half (actionlint, ShellCheck,
gitleaks, the deny-list, typecheck, ESLint, architecture boundaries), then the
three suites that need no database (`@shikoo/contracts`, `@shikoo/sms-parser`,
`@shikoo/admin-web`). One checkout, one install.

**`integration-db`** — `db:hub`, `db:services`, the migration rehearsal, the
money invariants and the image checks. One Postgres, one MySQL, one install.

**`integration-e2e`** — the Playwright browser walk and the 22 deploy bash
suites plus the two CI selector suites.

**`image`** — the deployable artifact. A `main` job only.

**`Required Quality Gate`** — the one check a ruleset should require. Name
unchanged, and every deploy script still looks for exactly that string.

### Why two integration executors and not one

Measured, not guessed. One combined executor is 606s → **11 billed**. Split, it
is 289s + 359s → 5 + 6 = **11 billed**. Identical cost, so the split is free,
and it buys back about four minutes of wall time and keeps a failing database
suite from delaying the browser walk's result.

### The one real regression

The integration executors now **wait for `checks`**, because GitHub publishes a
job's outputs only when the job ends. A Ready PR's gate finishes in roughly nine
minutes of wall time instead of three and a half. Minutes were the constraint,
not latency.

---

## Classifier rules

[`tools/ci-plan.sh`](../tools/ci-plan.sh). **Unknown runs everything** — an empty
file list, a truncated one, an unrecognised event, or a path matching no rule all
fall through to the complete gate.

**Only `apps/` and documentation may be selected away.** Everything else runs the
complete gate: every shared package, the lockfile, workspace configuration,
`tools/`, `deploy/`, `.github/`, `migrations/`, `sim/`, the Dockerfile, and every
path nobody has thought of yet. That is deliberately blunt — the brief's
must-always-run list (contracts, database adapters, domain logic, migrations,
authentication, money/wallet/order/payment, SMS parsing, bot singleton
behaviour, deployment scripts, workflows, CI classification, test
infrastructure) lives entirely outside `apps/`, so "not an app and not
documentation ⇒ everything" covers the whole list by construction rather than by
a pattern list somebody has to keep in step with it.

Within `apps/`, a `package.json`, `tsconfig*.json`, `vite.config.*`,
`vitest.config.*` or `playwright.config.*` also forces the complete gate: the app
map is a statement about what imports what, so it says nothing about a file that
*changes* the dependency graph or how the app is built.

| changed path | `unit` | `db` | `e2e` | `deploy_suites` |
| --- | :-: | :-: | :-: | :-: |
| `apps/admin-web/**` | ✔ | | ✔ | |
| `apps/dashboard-worker/**` | | ✔ | ✔ | |
| `apps/bot/**` | | ✔ | | |
| `apps/ingest-worker/**` | | ✔ | | |
| docs only | | | | |
| anything else | ✔ | ✔ | ✔ | ✔ |

The union is taken across every changed path.

### Why the table is safe to hand-write

It isn't, on its own — so it is checked rather than trusted.
[`tools/test/ci-suite-map.test.sh`](../tools/test/ci-suite-map.test.sh)
recomputes the reverse-dependency closure from the workspace's own
`package.json` files and `.github/ci-baseline.json`, and fails if a change to any
application selects less than the graph requires. `apps/ingest-worker` already
depends on `@shikoo/dashboard` — an app importing another app — so
"one directory, one suite" was never true here by luck.

### Why selection is safe at all

The previous shape refused to select, and said why: teaching the verifier which
suites were deliberately absent makes a verifier that can be talked into
accepting the wrong one. Three things answer that:

1. [`tools/ci-verify-gate.ts`](../tools/ci-verify-gate.ts) is not taught to
   *accept* an absence. It is handed the plan and requires the reported set to
   equal it **exactly** — a suite that reported when the plan said it would not
   is as red as one that is missing.
2. [`tools/ci-main-provenance.sh`](../tools/ci-main-provenance.sh) **re-derives**
   the same expectation from GitHub's own file list and `main`'s own copy of the
   classifier. It never reads the plan the branch published.
3. Condition 6 of that proof already refuses any pull request that touched
   `.github/`, `tools/ci-*` or the baseline — so a branch cannot weaken the
   classifier, go green, and have `main` believe it.

---

## `main`, and the three answers

**`main-proven`** — the complete gate already passed on this exact tree. The
image is rebuilt and re-verified anyway: a Docker build is the one thing here
that is not hermetic.

**`main-blocked`** — a direct push. GitHub answered and no merged pull request
claims the sha. `approval-gate.sh` condition 1 already refuses to deploy such a
commit, so the complete gate is not spent on it and the gate reports **BLOCKED**.

That verdict is a **failure**, not a skip. `deploy-staging.yml`'s `gate` job
starts only on `workflow_run.conclusion == 'success'`, so a blocked verdict is a
second refusal stacked on the existing one, never a way past it.

> **The cost, stated plainly:** a direct push's breakage is not measured until
> the next pull request builds on it. It cannot ship in the meantime, and that
> pull request runs the complete gate against a base containing it.

`association=none` is set on exactly one line of the provenance proof, reached
only when the API returned 200 *and* jq counted zero. A timeout, a 500, an
unparseable body, two claimants, or any later failure all leave it `unknown`,
and `unknown` runs the complete fallback.

**`main-full`** — every other way of failing to prove provenance. Deploy Staging
can consume these, so they get the complete gate.

---

## Operating rule

The Free plan has no branch protection: `GET /rulesets` and
`GET /branches/main/protection` both answer 403 «Upgrade to GitHub Pro». That
also rules out a merge queue.

> **Never merge until `Required Quality Gate` is green on the exact final Ready
> pull request head.**

Nothing in the repository can enforce this. What limits the damage if it is
broken is the provenance proof: a draft's green gate sits over a run in which
every executor skipped, the proof re-derives the expectation with
`IS_DRAFT=false`, and `main` runs the complete gate before Deploy Staging can
consume anything.

**Prefer a pull request to a direct push to `main`.** A direct push cannot be
deployed and is no longer tested, so it buys nothing but an untested `main`.

---

## Rollback

One small pull request, reverting three files. Nothing outside `.github/` and
`tools/` changes, and no deploy script, environment, server or repository
setting is touched by either direction.

```bash
git checkout -b revert/ci-consolidate-executors origin/main
git revert --no-commit <merge-sha-of-this-PR>
git commit -m 'revert(ci): back to the nine-job shape'
```

If only part of it needs to go back:

| symptom | revert |
| --- | --- |
| a suite is flaky now that suites share one Postgres | `tools/ci-integration.sh` + the two executor jobs in `ci.yml` — restore `db-shard`, `migrations`, `e2e`, `deploy-suites` as separate jobs with their own service containers |
| a change is being selected away that should not be | `tools/ci-plan.sh` only — make the `apps/*` branch fall through to `everything`, one line. The verifier and the provenance proof both follow the plan, so they need no change |
| direct pushes to `main` must be tested again | `tools/ci-plan.sh` only — delete the `ASSOCIATION = 'none'` branch. `main-full` is the fallthrough, so removing it restores the previous behaviour exactly |
| actionlint's pinned binary will not download | `ci.yml` only — restore `uses: rhysd/actionlint@03d0035246f3e81f36aed592ffb4bebf33a03106` and drop the install step. Costs 40s and one billed minute per run |

Reverting `tools/ci-plan.sh` alone is always safe: every consumer reads the
plan, and the plan's fallthrough is the complete gate.

After any revert, `.github/ci-baseline.json`'s `shard` labels must match the job
names again, or `tools/test/ci-suite-map.test.sh` fails — which is the point.
