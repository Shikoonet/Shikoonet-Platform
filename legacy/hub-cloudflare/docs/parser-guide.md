# Parser Guide

How to extend the SMS parser. The parser is deterministic and stateless: same
input → same output. No LLM, no external service.

## Layers

1. **Normalize** — `packages/sms-parser/src/normalize.ts`. Pure function.

   - Persian/Arabic digit normalization (`۰۱۲۳...` → `0123...`).
   - ZWNJ (`‌`) and NBSP (` `) stripping.
   - Thousand-separator handling (`,` and `،`).
   - Currency keyword detection (`ریال`, `تومان`, `IRR`, `TOMAN`).
   - AMBIGUOUS detection when both currency types appear in the same text.

2. **Parsers** — one file per classifier in `packages/sms-parser/src/parsers/`.
   Each parser exports a `SmsParser` with `id`, `version`, `supports(text)`,
   `parse(text) → ParseResult`.

3. **Registry** — `parsers/registry.ts`. The order matters: the first
   parser whose `supports()` returns true wins.

## Adding a new parser

1. Create `parsers/<name>.ts`:

   ```ts
   import type { NormalizedSms, ParseResult } from '@hub/contracts';
   import { type SmsParser, matched } from './types.js';

   const MY_KEYWORDS = /(?:my-pattern|another-pattern)/i;

   export const myParser: SmsParser = {
     id: 'my-parser',
     version: '1.0.0',
     supports(input: NormalizedSms): boolean {
       return MY_KEYWORDS.test(input.text);
     },
     parse(input: NormalizedSms): ParseResult {
       // ... compute amount, direction, accountHint, ref, confidence
       return matched(
         'BANK_CREDIT',
         'CREDIT',
         amountIrr,
         balanceIrr,
         accountHint,
         ref,
         this.id,
         this.version,
         evidence,
       );
     },
   };
   ```

2. Add to `registry.ts` BEFORE more general parsers. The order is intentional:

   - `otpParser` first (OTP bodies must always be redacted).
   - `promoParser` next.
   - `creditParser` before `debitParser` (a body with both keywords is credit
     by convention — see dispute policy).
   - `balanceParser` for balance-only messages.
   - `unknownParser` last as the catch-all.

3. Add unit tests in `packages/sms-parser/test/parsers.test.ts`. Every
   parser must have at least:
   - `supports` true on a positive example.
   - `supports` false on a negative example (no keyword match).
   - `parse` returns the expected `direction`, `amountIrr`, `balanceIrr`,
     `accountHint`, `classification`.

## Money rules

- All money in D1 is **IRR** (integer).
- When a body uses `تومان`, the parser multiplies by 10 to get IRR.
- When both `ریال` and `تومان` appear, the parser emits `AMBIGUOUS_CURRENCY`
  in `warnings` and stores `amountIrr = null`. The transaction status is
  `NEEDS_REVIEW` until a human resolves it.
- Amounts are integers. Decimals (e.g. `500.25 تومان`) are rounded to the
  nearest IRR.

## Account hint extraction

If the body contains `*1234` (asterisk + 4 digits) or `IR123456789012345678901234`
(IBAN-shaped), the parser stores the trailing digits in `accountHint`. The
ingest Worker matches `accountHint` against `financial_accounts.card_last_four`
or `account_last_four`. If no match, `financial_account_id` is null and the
matcher falls back to score-only suggestions.

## Confidence

Each parser sets `confidence` in `[0, 1]`. The matcher uses it as a prior:
high-confidence parses need less corroboration to reach `SUGGESTED`. Low-
confidence parses (`< 0.4`) always land in `NEEDS_REVIEW`.

## Versioning

- Bump `version` on any change to `supports()` or `parse()` behavior.
- Bump `version` on `id` change (which is a new parser, semantically).
- The ingest Worker writes `parser_id` + `parser_version` onto every row, so
  audit can trace which version produced which transaction.
