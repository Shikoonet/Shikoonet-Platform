-- 0090 — a service has its own topic in the reports group.
--
-- Sam, 2026-09-20: beside the ten topics of 0049 — one per KIND of report —
-- one topic per service and per shelf: «سرویس تیتانیوم», «سرویس الماس»,
-- «قفسهٔ OpenVPN». An order's report lands in its service's topic when the
-- service has one, and in the kind's topic otherwise. When the service or the
-- shelf is deleted, its topic goes with it.
--
-- A column, not a settings row: the topic lives exactly as long as the
-- product row does, and the delete route reads it from the same SELECT that
-- refuses a product still in use. A shelf is a products row of its own
-- (`POST /stock/shelves`), so one column covers both.
--
-- NULL means «no topic yet», never 0 — the outbox sends no thread id for a
-- NULL, and a 0 on the wire is a 400 from Telegram. Existing rows stay NULL;
-- re-running «گروه گزارش‌ها» in the panel makes the missing ones.
--
-- Undone by dropping the column; the bot falls back to the kind's topic.
BEGIN;

ALTER TABLE products ADD COLUMN report_thread_id integer
  CHECK (report_thread_id IS NULL OR report_thread_id > 0);
COMMENT ON COLUMN products.report_thread_id IS
  'Telegram message_thread_id of this service''s topic in the reports group (Channel_Report). NULL = none made yet (0090).';

COMMIT;
