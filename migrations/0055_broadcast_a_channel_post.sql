-- ارسال گروهی could send exactly one thing: a body of text.
--
-- `broadcasts` had one payload column — `body text NOT NULL CHECK (body <> '')`
-- from 0018 — and the send was one line: `api.sendMessage(chatId, text)`. No
-- photo, no buttons, no `parse_mode`. `forwardMessage` and `copyMessage` did
-- not appear anywhere in the repository.
--
-- What Sam actually announces with is a channel post: images, formatting, and
-- a link he already has in his clipboard as `https://t.me/shikoonet/137`. No
-- `text` column can carry that, and retyping the post into a textarea loses
-- everything that made it worth posting.
--
-- ## Why the source is NAMED here rather than forwarded by an admin
--
-- Mirzabot has this feature and does it the other way round (`admin.php:805`,
-- `typeservice-forwardmessage`): the admin forwards the post into the bot's
-- private chat, and the bot re-forwards from the ADMIN'S chat. That model
-- cannot work here. Our composer is a web page — there is no admin chat for
-- the bot to forward out of, and the operator may not even be at Telegram when
-- they press the button. So the post is identified by the pair Telegram's own
-- API takes, `from_chat_id` and `message_id`, and stored as such.
--
-- ## Why `body` becomes nullable
--
-- A forwarded broadcast has no body of its own. Keeping the NOT NULL by
-- stuffing the link into `body` would make one column mean two things and
-- force the send path to guess which — the shape that produces «why did eleven
-- thousand customers receive a URL». The CHECK below says it once instead: a
-- broadcast carries text, or it names a post. Never both, never neither.
--
-- Nothing back-fills, because there is nothing to back-fill: every existing row
-- has a body and lands in the first branch of the CHECK unchanged.

BEGIN;

ALTER TABLE broadcasts
  ADD COLUMN source_chat       text,
  ADD COLUMN source_message_id bigint,
  ALTER COLUMN body DROP NOT NULL;

-- The old CHECK only knew about `body` and would refuse every forward.
ALTER TABLE broadcasts DROP CONSTRAINT broadcasts_body_check;

ALTER TABLE broadcasts ADD CONSTRAINT broadcasts_payload_check CHECK (
  (body IS NOT NULL AND body <> ''
     AND source_chat IS NULL AND source_message_id IS NULL)
  OR
  -- `@username` or a numeric `-100…` id: exactly what `forwardMessage` accepts
  -- as `from_chat_id`, and never a `t.me/…` URL — the same refusal
  -- `required_channels` makes, for the same reason. A URL reaches Telegram as
  -- a chat that does not exist, and the failure is one line in a log.
  (body IS NULL
     AND source_chat ~ '^(@[A-Za-z0-9_]{4,32}|-100[0-9]{5,17})$'
     AND source_message_id IS NOT NULL AND source_message_id > 0)
);

COMMIT;
