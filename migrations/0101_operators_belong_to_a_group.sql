-- 0101_operators_belong_to_a_group.sql — issue #363, 2026-09-25.
--
-- Three roles decided everything a dashboard operator could see or change.
-- «Sends broadcasts but does not see orders» had no name among them. So an
-- operator now belongs to a GROUP, and a group says per sidebar page whether
-- it is not there, readable, or editable.
--
-- The three roles do not go. They become the three built-in groups, and they
-- keep meaning exactly what they meant: their `permissions` stay '{}' and the
-- worker reads `role` for them through the same checks as before. Only a
-- group the owner makes is read from `permissions`. A built-in reviewer that
-- quietly gained a delete, or lost a page, would be a change nobody asked for.
--
-- `group_id` is the source of truth from here on and `role` follows it,
-- kept by the trigger below:
--   * the owner and admin groups are ADMIN, reviewer REVIEWER, any other group
--     READ_ONLY — so an older image, rolled back onto this schema, reads a
--     custom group as the narrowest role there is rather than a wider one;
--   * a writer that still sets only `role` (the bootstrap CLI, the seed, ~80
--     tests' ON CONFLICT … SET role) moves the operator into the matching
--     built-in group, rather than leaving `group_id` saying «admin» for an
--     operator it just demoted.
--
-- Above the admins stands one OWNER (Sam, 2026-09-25): the only account that
-- manages admins — makes, demotes, removes them, sets their password, clears
-- their second factor. Stored as ADMIN, so everything an admin may do outside
-- «دسترسی‌ها» the owner may too. Nobody becomes owner here: `operator.ts
-- set-owner` names one, on the server, and moves the title if there was one.
-- Until then admins manage admins exactly as before.
--
-- Three CHECKs (audit_logs.actor_role, comments.author_role,
-- transaction_reviews.reviewer_role) and the bot still speak in roles, which
-- is why the column stays.

BEGIN;

CREATE TABLE access_groups (
  id          text PRIMARY KEY,
  name        text NOT NULL UNIQUE,
  -- {PageId: 'view'|'edit'}; an absent key is «none». Unread for built-ins.
  permissions jsonb NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(permissions) = 'object'
           AND NOT jsonb_path_exists(permissions, '$.* ? (@ != "view" && @ != "edit")')),
  created_at  bigint NOT NULL,
  updated_at  bigint NOT NULL,
  -- Who may operate the shop stays the owner's: a group that can edit
  -- «دسترسی‌ها» can set another operator's password, or edit itself.
  CHECK (id = 'admin' OR permissions->>'access' IS DISTINCT FROM 'edit')
);

INSERT INTO access_groups (id, name, created_at, updated_at)
VALUES ('owner',     'مالک',          (extract(epoch FROM now()) * 1000)::bigint, (extract(epoch FROM now()) * 1000)::bigint),
       ('admin',     'مدیر',          (extract(epoch FROM now()) * 1000)::bigint, (extract(epoch FROM now()) * 1000)::bigint),
       ('reviewer',  'بازبین پرداخت', (extract(epoch FROM now()) * 1000)::bigint, (extract(epoch FROM now()) * 1000)::bigint),
       ('read_only', 'فقط مشاهده',    (extract(epoch FROM now()) * 1000)::bigint, (extract(epoch FROM now()) * 1000)::bigint);

ALTER TABLE access_users
  ADD COLUMN group_id text REFERENCES access_groups(id) ON DELETE RESTRICT,
  -- The owner's «ورود دومرحله‌ای اجباری». Stored here, enforced by the TOTP
  -- enrolment change that follows; false changes nothing for anybody.
  ADD COLUMN totp_required boolean NOT NULL DEFAULT false;

UPDATE access_users
   SET group_id = CASE role WHEN 'ADMIN' THEN 'admin' WHEN 'REVIEWER' THEN 'reviewer' ELSE 'read_only' END;

ALTER TABLE access_users ALTER COLUMN group_id SET NOT NULL;

CREATE OR REPLACE FUNCTION access_user_role_follows_group() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.group_id IS NULL)
     OR (TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role
         AND NEW.group_id IS NOT DISTINCT FROM OLD.group_id) THEN
    NEW.group_id := CASE NEW.role WHEN 'ADMIN' THEN 'admin'
                                  WHEN 'REVIEWER' THEN 'reviewer'
                                  ELSE 'read_only' END;
  END IF;
  NEW.role := CASE WHEN NEW.group_id IN ('owner', 'admin') THEN 'ADMIN'
                   WHEN NEW.group_id = 'reviewer' THEN 'REVIEWER'
                   ELSE 'READ_ONLY' END;
  RETURN NEW;
END;
$$;

-- Fires before NOT NULL is checked, so an INSERT that names only one of the
-- two columns passes.
CREATE TRIGGER trg_access_user_role_follows_group
  BEFORE INSERT OR UPDATE OF role, group_id ON access_users
  FOR EACH ROW
  EXECUTE FUNCTION access_user_role_follows_group();

-- One owner, held by the database rather than by whoever checks first.
CREATE UNIQUE INDEX access_users_one_owner ON access_users (group_id) WHERE group_id = 'owner';

COMMIT;
