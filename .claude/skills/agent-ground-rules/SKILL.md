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

- The simulation environment is the test surface. **Today `pnpm sim:up` brings up
  two databases only** — Postgres on `5433` and MySQL on `3307` with the
  production dump. The fake Telegram API and fake provisioning panel do not exist
  yet; they arrive with the bot in phase 4. Do not write a test that assumes them.
- **Database tests run serially.** The root `test` script is `pnpm -r test`, not
  `--parallel`: several packages share one Postgres and `TRUNCATE` between cases,
  so running them at once makes them erase each other.
- **The live bot server is read-only.** Never test against it and never against
  real customer data. Its bugs are the admin's job (`BUGS-FOR-ADMIN.md`).
- Pin the clock: `vi.spyOn(Date, 'now').mockReturnValue(NOW_MS)` in `beforeEach`,
  restore in `afterEach`. Never hardcode a date — it goes green today and red
  forever tomorrow.
- Deterministic fixtures: fixed seed, never `Date.now()`, never `Math.random()`.
- No `.only` / `.skip` / `.todo` without a FIXME naming what unblocks it.

## Git

Do not commit unless explicitly asked. **Never push, ever** — that decision is
Sam's and requires the five-part report first.

## Windows file operations

Bulk moves are copy → verify → delete: `robocopy <src> <dst> /E`, count the
destination, then remove the source. `Move-Item` on a large folder once
half-completed while reporting an error and the follow-up `Remove-Item -Recurse`
destroyed a repository including its `.git` (2026-08-12). Never have a shell cwd
inside the directory being moved.
