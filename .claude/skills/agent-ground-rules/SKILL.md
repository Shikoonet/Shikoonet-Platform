---
name: agent-ground-rules
description: The rules every shikoo-platform agent works under — graphify-first navigation, ponytail, the money invariants, redaction, the simulation environment, and the git gate. Preloaded into every agent via the `skills:` frontmatter field; read it directly if you are working without one.
---

# Ground rules

These are not suggestions. Hooks do not fire for subagents, so nothing enforces
these but you.

## graphify first, grep second

There is a knowledge graph at `graphify-out/`. Before any raw `Read` or `Grep`:

- `graphify query "<question>"` — scoped subgraph, far smaller than raw search
- `graphify path "<A>" "<B>"` — relationships
- `graphify explain "<concept>"` — one focused concept
- `graphify-out/wiki/index.md` — broad navigation

After you modify code: `graphify update .` (AST-only, no API cost).

## ponytail — level `full`

Stop at the first rung that holds: does it need to exist → already in the repo →
stdlib → native platform feature → installed dependency → one line → minimum code
that works. Deletion over addition. Boring over clever.

Never simplify away: input validation at a trust boundary, any money path, RBAC,
error handling that prevents data loss.

## Money invariants — these live in the database, not in code

- **Integer IRR everywhere.** Toman only at the bot edge, converted once
  (`amountToman * 10`). Ambiguous currency → `NEEDS_REVIEW`, never a guess.
- **One bank transaction verifies at most one claim; one claim settles once.**
  Enforced by a partial unique index in Postgres. Never move that guarantee into
  the application layer, and never weaken the index.
- **Auto-verify only for an isolated 1↔1 pair**: exact account, exact amount with
  no tolerance, `|bank_timestamp − paid_clicked_at| ≤ 300000ms`. Amount equality
  alone is never sufficient.
- **Never auto-reject.** Never fabricate a receipt.
- Schema changes go through versioned migrations. Zero runtime DDL — the old bot
  ran `SHOW COLUMNS` on every Telegram update and that must not come back.
- `audit_logs` is append-only.

## Never store, render, or log

OTP codes, `apiKey`, bot tokens, HMAC keys, raw SMS bodies, card digits beyond
the last 4. Strip the key from the request before downstream code sees it.

## Testing

- The simulation environment is the test surface. `pnpm sim:up` brings up two
  databases — Postgres on `5433` and MySQL on `3307` with the production dump.
  - **The fake panel EXISTS**: `sim/fake-panel.mjs` (`pnpm sim:panel`, port
    8790), and `apps/bot/test/actions.test.ts` already uses it. It answers what
    our own adapter sends, so agreement with it proves consistency with
    ourselves and nothing about the real panel — rule 6.
  - **The fake Telegram is deliberately NOT built** — Sam's decision,
    2026-08-15. Bot behaviour is walked on the real test bot instead.
  - Playwright exists: `apps/dashboard-worker/playwright.config.ts` and `e2e/`.
- **Database tests run serially, and only one thing makes that true.** The root
  script is `pnpm -r --workspace-concurrency=1 --no-bail test`. It used to say
  here that the absence of `--parallel` was enough; **that was wrong** and it
  cost a real bug. Without `--parallel`, pnpm keeps topological ORDER but still
  runs unrelated packages at the same time — `apps/bot` and
  `apps/dashboard-worker` are siblings, and the second truncates
  `payment_cards`, `financial_accounts` and `payment_claims` out from under the
  first. Only `--workspace-concurrency=1` serialises them.
- `pnpm` is not on PATH here. Use `corepack pnpm ...`.

### `pnpm test` is NOT the gate — it is a third of it

Two PRs went green locally on 2026-08-29 and red in CI within minutes of each
other, both on checks the root script never runs. Before claiming a branch is
ready, run all three:

| gate | command | what it catches that `pnpm test` cannot |
| --- | --- | --- |
| unit + db | `corepack pnpm -r --workspace-concurrency=1 --no-bail test` | — |

The root `coverage`, `test`, `lint` and `typecheck` scripts shell out to a bare
`pnpm`, which is not on PATH on this machine — run the inner command through
`corepack pnpm` yourself rather than the root script.
| **coverage floors** | `corepack pnpm --filter @shikoo/sms-parser --filter @shikoo/domain --filter @shikoo/contracts --workspace-concurrency=1 exec vitest run --coverage` | `thresholds` only applies when `--coverage` is passed. `vitest.coverage.ts` floors `sms-parser`, `domain` and `contracts`; adding SQL-shaped code to `domain` whose only test lives in another package drops the statement figure and fails the build. |
| **browser** | `corepack pnpm -F @shikoo/dashboard exec playwright test` | 104 scenarios, and several **pin counts by hand** — the sidebar's section count and how many a READ_ONLY is offered. Adding one section to `nav.ts` breaks three specs, and nothing in `pnpm test` says so. |

Adding a section to `nav.ts` means four hand-kept numbers, not one:
`nav.test.tsx`'s list, `panel.spec.ts`, `sections.spec.ts`, and
`roles.spec.ts`'s `OFFERED_TO_A_READER` when the section is readable by a
reader. They are tripwires on purpose — update them in the commit that earns
it, never by deriving them from `NAV`.

### Three ways a local e2e run lies to you

All three cost time on 2026-08-29, and the worst of them shows up as GREEN.

1. **Playwright serves the BUILT bundle, not your source.** `webServer` points
   at `apps/admin-web/dist`. Without `corepack pnpm -F @shikoo/admin-web build`
   first, you are testing whatever branch built that folder last. The three
   counting specs passed for me against a sidebar that had the *previous*
   branch's section in it — a green run proving nothing, which is rule 6
   wearing a browser. CI is safe because its job builds first; you are not.
2. **The full suite truncates the simulation database, and e2e needs it
   seeded.** Run `corepack pnpm -F @shikoo/seed seed:sim` between
   `pnpm test` and Playwright, or watch specs fail with «run seed:sim».
3. **A dirty database can make the seed itself fail once.** The money specs
   mutate accounts, and a seed straight after them died on
   `payment_cards_financial_account_id_fkey` and then succeeded on a second
   run. If the seed fails with a foreign key, run it again before believing
   anything about it.

And when a spec fails, **prove whose fault it is before fixing it**: run that
one spec file, freshly built and freshly seeded, on your branch and on
`origin/main`. Five «failures» on 2026-08-29 passed identically on both — they
were leftover local state, and CI never saw them.
- **The live bot server is read-only.** Never test against it and never against
  real customer data. Its bugs are the admin's job (`BUGS-FOR-ADMIN.md`).
- Pin the clock: `vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)` in `beforeEach`,
  restore in `afterEach`. Never hardcode a date — it goes green today and red
  forever tomorrow.
- Deterministic fixtures: fixed seed, never `Date.now()`, never `Math.random()`.
- No `.only` / `.skip` / `.todo` without a FIXME naming what unblocks it.

## How work ships — Sam's standing rule, 2026-08-29

Every change follows this and nothing skips a step:

```
branch → PR (opened FIRST) → work → CI green
      → an APPROVED review from a human who is not the author
      → @Isusami merges to `main`
      → `Deploy Staging` fires by itself → shikoo-dev.chopon.uk
      → `Promote Production` — a MANUAL dispatch, only when we mean to show it
```

- **The PR comes first, not last.** Open it as soon as the branch has one
  commit so the work is visible while it happens rather than arriving
  finished. **Not as a draft** — the token here cannot mark a PR ready for
  review (`markPullRequestReadyForReview` answers FORBIDDEN), so a draft is a
  PR only a human can unblock.

### A merge is not enough — the deploy gate asks two more questions

Learned the hard way on 2026-08-29: PR #25 merged, CI went green, and
`Deploy Staging` **refused in eleven seconds**. `main` moved and staging did
not — a divergence whose only symptom is one failed workflow run.

`deploy/approval-gate.sh` runs in `owner-or-approved` mode with
`SOLO_DEPLOY_OWNER=Isusami`. For a PR written by anyone else — `arshiajacki`
included — BOTH of these must be true:

1. **An APPROVED review from a human other than the author**, sitting on the
   PR's **FINAL head commit**. Push one more commit after the approval and it
   is stale; the gate recomputes against the new head. Self-approvals and bot
   reviews are excluded before the count is taken.
2. **`Isusami` must be the one who clicks Merge.** «Reviewed is not sufficient
   on its own» is the script's own comment: a PR that is approved and then
   merged by its author still fails.

So «Sam approves the merge» is not the gate. The gate is: somebody else
approves the PR on GitHub, and the owner merges it. Report it that way rather
than announcing a merge as if it shipped — until `Deploy Staging` is green,
nothing reached staging.

Any `CHANGES_REQUESTED` review outranks all of it: somebody having looked and
said no beats any policy about who may ship.
- **Pushing your own feature branch is routine.** It reaches nobody.
- **Merging to `main` is not.** It is the step that reaches staging and starts
  the road to customers, so it needs Sam's word and the five-part report first:
  commits with SHAs, `git diff --stat`, what is withheld as private, which tests
  went green with the date and the environment, and the PR text.
- **`Promote Production` is never automatic and never yours.** Staging deploys
  itself from `main`; production is a hand-dispatched workflow.
- **Never commit to `dev`.** That branch is an abandoned 2026-08-26 experiment,
  131 commits behind and red. `shikoo-dev` is an ENVIRONMENT, fed from `main`.
- Never commit plans, notes, `CLAUDE.md`, or anything under `.notes/`.

## Windows file operations

Bulk moves are copy → verify → delete: `robocopy <src> <dst> /E`, count the
destination, then remove the source. `Move-Item` on a large folder once
half-completed while reporting an error and the follow-up `Remove-Item -Recurse`
destroyed a repository including its `.git` (2026-08-12). Never have a shell cwd
inside the directory being moved.
