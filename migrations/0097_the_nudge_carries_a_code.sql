-- 0097_the_nudge_carries_a_code.sql — 2026-09-23.
--
-- Sam: the «started and never bought» nudge (0057) hands each person a
-- personal 20% code for a first purchase, valid two days from the send. The
-- code is a `discount_codes` row the sweep mints per person — targeted, once,
-- first purchase only — so nothing here but the two numbers the cron screen
-- edits, and `settingsRoutes` refuses to invent a row.
--
-- 20 is what Sam asked for. The switch itself stays where it was: a shop
-- whose nudge is off is still sending nothing.

INSERT INTO settings (scope, key, value) VALUES
  ('bot', 'nudge_discount_percent', '20'::jsonb),
  ('bot', 'nudge_discount_days',    '2'::jsonb)
ON CONFLICT (scope, key) DO NOTHING;
