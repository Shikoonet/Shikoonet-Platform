-- 0075_the_reference_is_searchable.sql — issue #306, 2026-09-18.
--
-- A customer rings: «پرداخت کردم، پیگیری فلان». The tracking number they read
-- off their receipt is the bank SMS's reference, which the parser has always
-- extracted into `transaction_candidates.transaction_reference` — and which
-- nothing on the dashboard could search for. The payments list now filters
-- claims by it, through the match that ties a claim to its transaction.
--
-- Partial, because the column is NULL on every SMS the parser could not read a
-- reference from, and a lookup by reference never wants those rows. The
-- production table is tens of thousands of rows and an equality filter on an
-- unindexed text column is a sequential scan per keystroke.
CREATE INDEX idx_tx_reference
  ON transaction_candidates(transaction_reference)
  WHERE transaction_reference IS NOT NULL;
