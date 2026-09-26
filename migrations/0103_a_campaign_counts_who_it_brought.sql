-- 0103_a_campaign_counts_who_it_brought.sql — Sam, 2026-09-26 (#471).
--
-- «کمپین‌ها». A campaign is a slug in a Telegram deep link,
-- `t.me/<bot>?start=c_<slug>`. The bot records every customer who arrives on
-- one, and the dashboard counts what those customers bought afterwards.
--
-- Until now campaigns lived in a separate tool — a Cloudflare Worker and its
-- own D1 database — which counted landing-page views and button presses. Its
-- button opened the bot with no payload, so it never knew whether anybody
-- started the bot, let alone paid, and its two screens disagreed about the
-- same campaign. This is the part of the funnel only the shop can see.
--
--   1. `campaigns` — the slug, its name, and where it is advertised. No
--      DELETE route: archiving keeps the history readable, and a slug that
--      was printed on an ad must not come back meaning something else.
--
--   2. `campaign_starts` — one row per campaign and customer. Pressing the
--      same link twice counts once; a customer reached by two campaigns is in
--      both. `is_new_user` is whether that /start created the customer: a
--      channel post mostly reaches people who already buy, and their money is
--      not the campaign's in the way a newcomer's is.
--
-- The slug pattern is Telegram's: «c_» plus the slug must fit the
-- 64-character start parameter, which carries only [A-Za-z0-9_-].
--
-- RESTRICT on the campaign, CASCADE on the customer: a campaign with starts
-- cannot be deleted from under its numbers, and a reset that re-imports
-- `users` takes their starts with them.
--
-- Undo: DROP TABLE campaign_starts; DROP TABLE campaigns;

BEGIN;

CREATE TABLE campaigns (
  id          bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  slug        text   NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{2,61}$'),
  name        text   NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 100),
  source      text   NOT NULL DEFAULT '' CHECK (length(source) <= 100),
  note        text   NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  status      text   NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaign_starts (
  campaign_id  bigint      NOT NULL REFERENCES campaigns(id) ON DELETE RESTRICT,
  user_id      bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  is_new_user  boolean     NOT NULL,
  first_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, user_id)
);

-- The report joins a campaign's starters to their orders by customer, and a
-- deleted customer is found through here.
CREATE INDEX campaign_starts_user_id ON campaign_starts (user_id);

COMMIT;
