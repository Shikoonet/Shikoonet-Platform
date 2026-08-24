# What is in here

`receipt-portrait.svg` — a card-to-card receipt at the shape customers actually
send: an «آسان پرداخت» transaction report screenshotted from a phone,
**591×1280, portrait, aspect 0.46**.

Sam supplied a real one on 2026-08-24. It earned its place immediately: before
it arrived, the only receipt this code had ever been shown was a landscape
placeholder I drew myself, and `.payment-receipt img { max-height: 320px }` was
written against that shape. It renders a 591×1280 screenshot **148px wide** —
and the four things an operator has to read off a receipt (مبلغ, شمارهٔ ارجاع,
and the last four digits of each card) sit mid-page at ordinary phone text size.
Deciding about money from that is deciding without looking.

## Why this one is drawn and his is not here

His photograph carries a customer's name, both card numbers and the bank
reference. A repository remembers a file long after it is deleted, so it stays
on disk and out of git — `.gitignore` covers
`apps/dashboard-worker/e2e/fixtures/*.local.*`, and his copy is
`receipt-portrait.local.jpg` if you have it.

Nothing is lost. Every assertion in `money-layout.spec.ts` is about **size**:
any 591×1280 image passes or fails them identically. And a fixture made of text
diffs, reviews, and can be read without opening an image editor — which a
photograph cannot.
