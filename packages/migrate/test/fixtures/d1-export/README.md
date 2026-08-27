# Synthetic D1 export, for CI

`preflight()` reads a `wrangler d1 export` directory alongside the MySQL
source. The real one lives under `legacy/hub-cloudflare/.production-backups/`,
is git-ignored, and holds real payment claims and device credentials.

These files are the same shape and none of the content is real. The layout is
`wrangler`'s own: a one-element array whose first element has a `results` key.

Two tables carry rows because `preflight` reasons about them — `payment_cards`
(Luhn) and `financial_accounts` (the card's owner). The rest are present and
empty on purpose: a table that is MISSING and a table that is EMPTY must not
look the same to the inventory, and `d1Table` throws ENOENT on the first.

`payment_cards` holds one Luhn-valid card in the 0000 range no issuer uses,
and one that fails the checksum so preflight has something to refuse — the
same pairing the MySQL fixture uses, on the other side of the join, so the
«exists in one system only» report has both directions to exercise.
