# Reconciliation Rules

How `payment_claims` are matched to `transaction_candidates` and surfaced
to the dashboard.

## State machines

```
PENDING  ─▶ MATCH_SUGGESTED ─▶ VERIFIED
                │
                └─▶ REJECTED  (with reason)
                       │
                       └─▶ FAKE_RECEIPT  (admin mark)
```

`packages/domain/src/state.ts` defines every transition and throws
`IllegalTransitionError` on invalid moves. Both Workers use these checks
before mutating D1.

## Scoring (`packages/domain/src/score.ts`)

The matcher scores a `(transaction, claim, account)` triple on five axes:

| Axis            | Weight | Description                                                                                                            |
| --------------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| Amount exact    | 0.5    | `1.0` if `claim.expected_amount_irr == tx.amount_irr`; decays linearly to `0` over ±10%.                               |
| Amount in range | 0.2    | `1.0` if the claim's amount band (claim amount ± tolerance) contains the tx.                                           |
| Account match   | 0.2    | `1.0` if `claim.target_financial_account_id == tx.financial_account_id`; `0.5` if the device is shared; `0` otherwise. |
| Reference match | 0.05   | `1.0` if the SMS reference appears in the claim's metadata.                                                            |
| Time proximity  | 0.05   | `1.0` if within ±5 minutes; decays linearly to `0` at ±2 hours.                                                        |

A **strong** match (single open claim + score ≥ 0.85) becomes
`MATCH_SUGGESTED`. Anything else becomes `NEEDS_REVIEW`. Only `ADMIN` or
`REVIEWER` roles can promote a `MATCH_SUGGESTED` to `VERIFIED` via the
dashboard's **Approve** action.

## Decision rule

```
if claims.length == 1 and score >= 0.85:
    suggestion = MATCH_SUGGESTED
else:
    suggestion = NEEDS_REVIEW
```

Multiple matches with the same transaction are allowed in D1 (partial unique
index enforces no duplicates per `(transaction_candidate_id, payment_claim_id)`
to avoid the same pair being inserted twice).

## Rejection

A reviewer can reject with one of nine reasons (`RejectionReason` enum in
`@hub/contracts`). `FAKE_RECEIPT` is the special one — it flips the claim
status to `FAKE_RECEIPT` (not just `REJECTED`) and triggers an audit action
`claim.fake_receipt`. This is reserved for when the customer uploaded a
doctored receipt.

## Idempotency

Re-running the matcher on the same `(tx, claim)` is safe because of the
unique index. A repeated `INSERT OR IGNORE` returns the existing row.

## Audit trail

Every transition writes a row to `audit_logs`:

- `reconciliation.suggested` — system, when the matcher proposes a match.
- `match.approved` — admin/reviewer.
- `match.rejected` — admin/reviewer.
- `claim.fake_receipt` — admin/reviewer, when the rejection reason is
  `FAKE_RECEIPT`.

Audit rows are append-only — no updates, no deletes.

## Configuration

`DEFAULT_SCORER` in `packages/domain/src/score.ts` holds the weights. To
change weights, edit the constant and redeploy the ingest Worker. There is
no per-tenant override — the project assumes a single tenant.
