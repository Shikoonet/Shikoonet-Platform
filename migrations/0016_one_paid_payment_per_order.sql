-- One order is paid once, and Postgres is what says so.
--
-- The wallet path wrote its payment row with
-- `ON CONFLICT (public_id) DO NOTHING`, which reads like a guard and is not
-- one: `public_id` is freshly minted on every call, so the conflict it waits
-- for cannot happen. Two `wpay` presses arriving together would each write a
-- PAID row for the same order, and the sale would be counted twice in every
-- report built on `payments`.
--
-- Nothing has produced that yet, because the poll loop handles updates one at a
-- time and the whole update runs in one transaction. But that is an argument
-- about today's caller, not a property of the data — exactly the kind of
-- application-level promise this project keeps in the schema instead. The day
-- a second writer appears (a webhook, a second process, an admin route) the
-- comment stays true and the invariant does not.
--
-- Partial and status-scoped on purpose. An order legitimately carries more than
-- one payment row: `checkoutFor` writes a CARD_TO_CARD row in PENDING when the
-- customer is shown a card, and a customer who then pays from their balance
-- gets a second, WALLET row. What must never happen twice is being PAID.
--
-- Verified against the migrated data before writing: zero orders in the
-- production import carry more than one PAID payment.

CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_one_paid_per_order
  ON payments (order_id)
  WHERE order_id IS NOT NULL AND status = 'PAID';
