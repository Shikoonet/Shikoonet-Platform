-- 0107_a_channel_post_goes_out_once.sql — Sam, 2026-09-26 (#473).
--
-- «پست کانال»: posting to the shop's channels from the panel. It replaces a
-- separate tool that sent text and buttons to one fixed channel, kept nothing,
-- and answered «Internal server error» to a post Telegram had accepted — so
-- the operator pressed send again, and the channel got it twice.
--
-- One row is one post, from the draft to the message in the channel:
--
--   DRAFT      being written. Every change to what it says clears its preview.
--   SCHEDULED  previewed, and waiting for its time — «now» is a time too.
--   SENDING    the bot has claimed it and is talking to Telegram.
--   SENT       in the channel. `message_id` is how it is edited, pinned and
--              deleted later; NULL when an operator confirmed by hand a post
--              whose send had no answer (see below).
--   FAILED     Telegram refused it. Nothing went out, so it can be sent again.
--
-- What goes out is a COPY of the preview the operator looked at in the
-- reports group (`preview_*`), with the keyboard that preview carried
-- (`reply_markup`) — not a second rendering of the text, which could differ
-- from what was checked.
--
-- A send whose answer never came (a timeout, a 5xx) stays SENDING and is
-- never sent again by itself: whether it reached the channel is unknown, and
-- a duplicate post cannot be taken back. An operator looks at the channel and
-- says which it was.
--
-- `chat_id` is always the numeric id: a channel's @username can change hands,
-- and a scheduled post must not follow the name to a stranger's channel.
-- `campaign_slug` names the «کمپین‌ها» row (#471) this post's buy button
-- counts starts for; no foreign key, the campaign outlives the post.
--
-- Undo: DROP TABLE channel_posts;

BEGIN;

CREATE TABLE channel_posts (
  id                  bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
  chat_id             bigint NOT NULL,
  chat_title          text   NOT NULL DEFAULT '',
  status              text   NOT NULL DEFAULT 'DRAFT'
                        CHECK (status IN ('DRAFT','SCHEDULED','SENDING','SENT','FAILED')),
  text                text   NOT NULL DEFAULT '' CHECK (length(text) <= 4096),
  media_kind          text   NOT NULL DEFAULT 'NONE' CHECK (media_kind IN ('NONE','PHOTO','VIDEO')),
  media_file_id       text,
  -- Rows of buttons, as the panel wrote them. `reply_markup` is what Telegram
  -- was actually handed, built from these at preview time.
  buttons             jsonb  NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(buttons) = 'array'),
  preview_chat_id     bigint,
  preview_message_id  bigint,
  reply_markup        jsonb,
  send_at             timestamptz,
  claimed_at          timestamptz,
  sent_at             timestamptz,
  message_id          bigint,
  error               text,
  campaign_slug       text,
  created_by          text   NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT channel_posts_media_has_a_file
    CHECK ((media_kind = 'NONE') = (media_file_id IS NULL)),
  CONSTRAINT channel_posts_preview_is_whole
    CHECK ((preview_chat_id IS NULL) = (preview_message_id IS NULL)),
  -- Nothing is scheduled that nobody has looked at.
  CONSTRAINT channel_posts_scheduled_is_previewed
    CHECK (status <> 'SCHEDULED'
           OR (send_at IS NOT NULL AND preview_message_id IS NOT NULL)),
  CONSTRAINT channel_posts_sending_is_claimed
    CHECK (status <> 'SENDING' OR claimed_at IS NOT NULL),
  CONSTRAINT channel_posts_sent_has_a_time
    CHECK (status <> 'SENT' OR sent_at IS NOT NULL)
);

-- The bot's sweep reads only what is due.
CREATE INDEX channel_posts_due ON channel_posts (send_at) WHERE status = 'SCHEDULED';

COMMIT;
