---
name: mirzabot-matching
description: Rules and architecture for Mirzabot payment claim ↔ bank transaction auto-verification. Use before changing anything in mirzabotMatch.ts, mirzabotVerify.ts, matching.ts, the ingest Mirzabot integration, or any claim/match approval route.
---

# Mirzabot auto-verification

Card-to-card Iranian payments. A Telegram bot (Mirzabot) shows a customer a
destination card, the customer pays from their own bank, taps "I paid", and
uploads a receipt. The Hub must decide whether an incoming bank CREDIT SMS is
_that_ payment.

## The product rule that overrides everything

AUTO_VERIFY only when exactly one claim and exactly one transaction can
possibly belong to each other. Everything else is SUGGEST (manual review).

Never auto-reject. Never auto-classify a receipt as fake — only an explicit
admin action may do that. False negatives are acceptable; a wrongly
auto-approved payment is not.

## Where decisions live

| Concern                                 | Owner                                             |
| --------------------------------------- | ------------------------------------------------- |
| Should this claim auto-verify?          | `packages/domain/src/mirzabotMatch.ts`            |
| Writing a verification                  | `packages/domain/src/mirzabotVerify.ts`           |
| Loading candidates, persisting outcomes | `apps/ingest-worker/src/integrations/mirzabot.ts` |

`mirzabotMatch.ts` is pure — it takes no database handle. Keep it that way.
Handlers, SQL, workers and the dashboard consume the decision; none of them may
re-derive it. The dashboard renders `suspect_reason` verbatim, so new reason
codes surface without UI work.

Entry points:

- `evaluateMirzabotGroup(claims, transactions, opts)` — group evaluation
- `evaluateClaimForAutoVerification(claim, transactions, competingClaims, opts)`

Both return `{ decision: 'AUTO_VERIFY' | 'SUGGEST' | 'WAIT', reason,
transactionId, diagnostics }`.

## AUTO_VERIFY conditions — all mandatory, no scoring may override

1. Live `MIRZABOT` claim (`PENDING` or `MATCH_SUGGESTED`), valid external order
   id, positive `expected_amount_irr`, non-null `paid_clicked_at`.
2. Card resolves to exactly one `payment_cards` row → exactly one
   `financial_accounts` row. Zero → `UNMAPPED_CARD`. More than one →
   `AMBIGUOUS_CARD_MAPPING`.
3. Account `status = 'ACTIVE'`, else `ACCOUNT_NOT_ACTIVE`.
4. Transaction `direction = 'CREDIT'` and `processing_disposition = 'ACTIONABLE'`.
5. `transaction.financial_account_id` equals the claim's target account exactly.
6. `transaction.amount_irr` equals `claim.expected_amount_irr` exactly. No
   tolerance, no rounding, no nearest-amount.
7. `ABS(bank_timestamp - paid_clicked_at) <= 300000`. **Exactly 5 minutes.** 4m59s
   and 5m eligible, 5m01s not, symmetric in both directions.
8. Transaction not already in a `CONFIRMED` or `AUTO_VERIFIED` match.
9. The external order has not already been verified.
10. Exactly one eligible transaction for the claim, else `AMBIGUOUS_TRANSACTIONS`.
11. Exactly one eligible claim for that transaction, else `AMBIGUOUS_CLAIMS`.

## Uniqueness is graph-shaped, not score-shaped

The engine builds a bipartite claim↔transaction graph and auto-verifies only
isolated 1↔1 components. Consequences that are easy to reintroduce by accident:

- Never pick "the closest in time", "the highest score", "the oldest claim",
  "the first transaction", or anything derived from upload or user order.
- Time distance inside the window is **not** a tiebreaker. If C1↔T1 is 5s and
  C2↔T1 is 45s, T1 is ambiguous and neither auto-verifies.
- Per-claim evaluation alone is not enough. Two claims that each see two
  transactions must all stay Suggested even though each claim individually
  "has a match".
- Results must not depend on claim ordering. There is a test asserting this.

## WAIT vs SUGGEST

A claim with no eligible transaction returns `WAIT` / `AWAITING_BANK_SMS` while
`now < receipt_submitted_at + 10 minutes`, because a qualifying SMS could still arrive.
Once that waiting period closes with still no evidence it settles as
`NO_TRANSACTION_AFTER_10M`.

`WAIT` is only ever returned for the no-transaction case. A reason that cannot
change with time (unmapped card, muted account, amount mismatch) suggests
immediately.

Because nothing re-runs on an idle system, `finalizeExpiredMirzabotWaits` sweeps
expired waits. It runs at the top of `handleMirzabotClaim` — before the new
claim joins the pool, otherwise the sweep consumes that claim's own decision —
and inside `rematchMirzabotClaimsForCreditTx`.

## Writing a verification

`verifyMirzabotClaim(db, {claimId, transactionId, mode, actorEmail})` is the
only path allowed to verify a Mirzabot claim. Automatic matching, the Suspects
approve route, and `/api/v1/match/approve` all go through it.

It re-checks the hard facts (live claim, actionable CREDIT, same account, equal
amount, neither side consumed) and then writes. Rules for changing it:

- **Never use `INSERT OR IGNORE` for a consuming match.** The partial unique
  indexes `idx_match_one_confirmed_per_tx/claim` (migration 0001) and
  `idx_match_one_auto_per_tx/claim` (0011) are what stop an auto matcher and an
  admin from both spending one transaction. `OR IGNORE` silently swallows the
  conflict while the following statements still mark the claim verified.
- Claim and transaction updates must be guarded on non-terminal status.
- The function re-reads the row afterwards, because the upsert's `WHERE` guard
  can skip silently.

The ±5m window and the uniqueness rules are deliberately **not** re-imposed on
manual approval — resolving that ambiguity is exactly what the admin is doing.

## Do not let the generic matcher near Mirzabot claims

`suggestMatchesForTransaction` in `packages/domain/src/matching.ts` scores on
`submitted_at` (receipt upload time) and accepts claims with a null account. It
excludes `source_system = 'MIRZABOT'` in SQL. Removing that filter reintroduces
the original bug: correct 1↔1 payments landing in Suggested with matches built
on the wrong timestamp and wrong account.

## Reason codes

`UNMAPPED_CARD`, `AMBIGUOUS_CARD_MAPPING`, `ACCOUNT_NOT_ACTIVE`,
`NO_TRANSACTION`, `AMOUNT_MISMATCH`, `OUTSIDE_AUTO_MATCH_WINDOW`,
`AMBIGUOUS_TRANSACTIONS`, `AMBIGUOUS_CLAIMS`, `TRANSACTION_ALREADY_CONSUMED`,
`DUPLICATE_ORDER`, `DUPLICATE_EVENT`, `RECEIPT_REUSED`, `PARSER_FAILURE_NEARBY`,
`INTEGRATION_ERROR`. Defined in `packages/contracts/src/mirzabot.ts`.

`PARSER_FAILURE_NEARBY` is declared but nothing emits it.
`AMBIGUOUS_CARD_MAPPING` is unreachable while `payment_cards.card_digits` is
`UNIQUE`; it is defensive.

## Idempotency and identity

- `integration_events.event_id` is the primary key — replayed `eventId` is a
  no-op returning `duplicateEvent: true`.
- `payment_claims.external_order_id` is unique and formatted
  `mirzabot:test:<orderId>`. Resubmitting a settled order returns
  `DUPLICATE_ORDER` and never re-opens it.
- `payment_claims.card_digits` (migration 0012) stores the card so a claim
  created before its card was mapped can recover on a later matcher run.
  Without it, card→account resolution could only ever happen once.
- Claims are never merged by `telegramUserId`. One order, one claim.

## Testing

- `packages/domain/test/mirzabotMatch.test.ts` — decision matrix and invariants.
  The critical invariant: adding one more valid competing claim _or_ transaction
  to an AUTO_VERIFY scenario must downgrade it to SUGGEST.
- `apps/ingest-worker/test/mirzabot-integration.test.ts` — end to end, including
  the auto-vs-manual race.
- `apps/dashboard-worker/test/mirzabot-approval.test.ts` — manual approval guards.

Two traps when writing tests here:

1. `@cloudflare/vitest-pool-workers` isolates storage **per test**. State does
   not carry between `it` blocks; make each one self-contained.
2. WAIT behaviour is relative to the live clock. Anchor those tests on
   `Date.now()`, not on a fixed past epoch constant.

Worker test files build their schema from explicit migration imports. A file
that exercises Mirzabot code must import `0011` and `0012` or it fails with
"no such table: payment_cards". Do **not** add `0011` to the seed tests — the
seed generator emits multiple auto-verified matches per claim and violates its
unique index.

## Staging

D1 `payment-hub-staging`. Deploy from `apps/ingest-worker` and
`apps/dashboard-worker` with `pnpm exec wrangler deploy` (build
`@hub/dashboard-web` first). Secrets and the SMS injector credential live in
`.staging-test.env` (gitignored). Inject a synthetic bank SMS with:

```bash
source .staging-test.env
pnpm inject:staging-sms -- --amount-toman <N> --account-hint <hint> \
  --bank-timestamp-ms <paid_clicked_at + 20000>
```

Pin `--bank-timestamp-ms` relative to the claim's `paid_clicked_at`; injecting
at wall-clock "now" drifts outside the 5m window while you are typing.

## Card assignment (Mirzabot bot — not Hub)

Temporary card leases, load balancing, and order snapshots live in the
**Mirzabot PHP repo**, not in this Payment Hub codebase. See skill
`mirzabot-card-assignment` and `scripts/deploy-card-assignment-*.sh`.
Do not change matching logic when changing card assignment.
