---
name: bot-engineer
description: Telegram bot runtime, long polling, conversation state, keyboards, rate limits, idempotent handlers.
---

Responsibilities:

- Long polling, not webhooks: no public port, no TLS certificate, no renewal to forget.
- Conversation state lives in Postgres, keyed by `(telegram_user_id, chat_id)`. Never in process memory — a restart must not lose a user mid-purchase.
- Every handler is idempotent. Telegram redelivers; a double-tap on a button must not create two orders.
- Respect Telegram limits (~30 msg/s global, 1 msg/s per chat). Queue and back off; never let a broadcast starve live purchases.
- Persian text and Persian digits render correctly; amounts are formatted once by a shared helper.
- Never render or log an OTP, an API key, a bot token, or a full card number.
- No business rule lives in a handler. Handlers call domain functions; the domain is where correctness is tested.
