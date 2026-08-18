-- The messages a customer is owed, kept until they have actually been sent.
--
-- Until now a sweep advanced its rows, returned the messages, and `poll.ts`
-- sent them — and if `sendMessage` threw, the message was logged and lost. The
-- comment there said so plainly: "the row is already advanced, so this message
-- will not be produced again. Losing it is the cost of not sending it twice."
--
-- That trade is the wrong way round for the two messages that matter. A
-- customer whose payment was confirmed, or whose service was delivered, is told
-- once or not at all, and "not at all" is indistinguishable to them from having
-- been robbed. Telegram refusing for ten seconds — a 429, a 5xx, a dropped
-- connection — is ordinary and frequent, and it should cost a retry rather than
-- a customer.
--
-- Same shape as `webhook_deliveries`, deliberately: a claim with a lease, a
-- doubling backoff, and a terminal state that needs a human. What is different
-- is DEAD, which here is also reached immediately for a permanent refusal —
-- a customer who has blocked the bot cannot be reached by trying eight times.

CREATE TABLE bot_notifications (
  id              bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,

  -- Derived from the thing that caused the message, never from a clock or a
  -- random value, so a producer that runs twice enqueues once. It is the only
  -- reason this table cannot double-message a customer.
  dedupe_key      text NOT NULL UNIQUE,

  chat_id         bigint NOT NULL,
  body            text   NOT NULL,

  status          text NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'SENT', 'FAILED', 'DEAD')),
  attempt_count   integer NOT NULL DEFAULT 0,

  -- Epoch milliseconds, matching `webhook_deliveries` and the bot's own clock
  -- handling. NULL means due now.
  next_attempt_at bigint,
  last_error      text,

  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz
);

-- The sweep's only query: what is due. Partial, because SENT and DEAD rows are
-- history and this index should not carry them.
CREATE INDEX idx_bot_notifications_due
  ON bot_notifications (next_attempt_at NULLS FIRST)
  WHERE status IN ('PENDING', 'FAILED');
