# corpus — every text shape production has sent us

One file per bank, one shape per block, blocks separated by a blank line. The
first line of a block is `# <sender> — <what it is>`; the rest is the body as
the phone relayed it, digits changed. `corpus.test.ts` parses every block and
fails if a *named* parser did not read it — a generic parser guessing, or
nothing at all, is a red test.

This is the loop: «بانک‌ها › پیامک‌های بی‌پارسر» → CSV → a block here → red →
a parser → green → «بازخوانی» on production. Never delete a block; a shape a
bank stopped sending is still a shape it sent.
