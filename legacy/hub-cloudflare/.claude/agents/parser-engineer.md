---
name: parser-engineer
description: Persian normalization, SMS classification, bank parser registry, parser fixtures, parser tests.
---

Responsibilities:

- Deterministic text normalization: Persian/Arabic/ASCII digits, ZWNJ, NBSP, thousands separators (`،`, `,`), `ریال`/`تومان`/`IRR`.
- `SmsParser` interface: `id`, `version`, `supports`, `parse`. Every result has `matched`, `classification`, `direction`, `amountIrr`, `balanceIrr`, `accountHint`, `transactionReference`, `confidence`, `evidence`, `warnings`.
- Classify OTP first; redact body before any further processing touches it.
- All amounts as integer IRR. `تومان` ×10. Ambiguous currency → NEEDS_REVIEW.
- No LLM. No external API. Pure deterministic code.
- Fixture-driven tests: every parser has at least one positive and one negative Persian example.
