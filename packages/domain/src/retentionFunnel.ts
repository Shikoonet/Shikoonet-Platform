/**
 * What happened after a retention rule messaged people.
 *
 * Read from what already exists — the outbox rows that were sent, the
 * service each was about, and the code redemptions — rather than a table of
 * sends. The dedupe key `retention:<rule>:<sub>:<expiresEpoch>:<day>`
 * carries which service and which expiry; a person is counted once however
 * many days of the window they were written to.
 *
 *   sent         PEOPLE this rule reached — not messages, not services: a
 *                person with two services on the panel is one
 *   usedCode     of those, how many redeemed the rule's code after their
 *                first message (0 when the rule has no code)
 *   usedOutside  PEOPLE outside that list who redeemed the code — not
 *                redemptions, one person twice is one — a code that leaked, or one the shop also gave
 *                out by hand. Sam, 2026-09-20: «کسایی خارج از این گروه»
 *   stayed       the service's expiry moved past the one the message was
 *                about — a renewal or added time
 *   left         that expiry has passed and nothing moved it
 *   pending      not yet expired, not yet renewed
 *
 * «did not use» is `sent − usedCode` and the screen does that subtraction.
 *
 * `messages` counts ROWS of the outbox, not people — what the operator sees
 * as «in the queue», «delivered», «could not be delivered» — and `today` is
 * the rows the sweep wrote since Tehran midnight. Sam, 2026-09-20: «چند نفر
 * تو کیو هستن، چند نفر بد کردن، چند نفر رسیده».
 *
 * ponytail: split_part on the key is the ceiling. A `retention_sends` table is
 * the upgrade if this query ever shows in the nightly report's timings.
 */

import type { D1Database } from '@shikoo/database';

export interface RetentionFunnel {
  sent: number;
  usedCode: number;
  usedOutside: number;
  stayed: number;
  left: number;
  pending: number;
  messages: { queued: number; sent: number; dead: number; today: number };
}

export async function retentionFunnel(
  db: D1Database,
  ruleKey: string,
  codeId: number | null,
): Promise<RetentionFunnel> {
  const row = await db
    .prepare(
      // The rule is matched on its own key SEGMENT, not with LIKE: a rule key
      // may contain `_`, which LIKE reads as «any one character», and the
      // prefix test alone would fold `r_a` and `rXa` into one funnel. The
      // expiry is compared as the sweep wrote it — `::bigint` on both sides —
      // because a fractional second on the live column would otherwise read
      // as «moved» against its own truncated copy in the key.
      `WITH rows AS (
         SELECT n.dedupe_key, n.status, n.sent_at, n.created_at
           FROM bot_notifications n
          WHERE n.dedupe_key LIKE 'retention:%'
            AND split_part(n.dedupe_key, ':', 2) = ?1),
       sent AS (
         SELECT DISTINCT ON (sub_id) sub_id, expires_epoch, sent_at
           FROM (SELECT split_part(dedupe_key, ':', 3)::bigint AS sub_id,
                        split_part(dedupe_key, ':', 4)::bigint AS expires_epoch,
                        sent_at
                   FROM rows WHERE status = 'SENT') x
          ORDER BY sub_id, sent_at),
       -- One row per PERSON: the first service of theirs this rule reached
       -- stands for them, so somebody with two services is one in every
       -- count rather than two in «sent» and two in «stayed».
       people AS (
         SELECT DISTINCT ON (s.user_id)
                sent.sub_id, sent.expires_epoch, sent.sent_at, s.user_id,
                extract(epoch FROM s.expires_at)::bigint AS expires_now, s.expires_at
           FROM sent JOIN subscriptions s ON s.id = sent.sub_id
          ORDER BY s.user_id, sent.sent_at)
       SELECT (SELECT count(*) FROM people)::int AS sent,
              (SELECT count(*) FROM people p
                WHERE ?2::bigint IS NOT NULL AND EXISTS (
                  SELECT 1 FROM discount_redemptions r
                   WHERE r.code_id = ?2 AND r.user_id = p.user_id
                     AND r.created_at >= p.sent_at))::int AS used_code,
              (SELECT count(DISTINCT r.user_id) FROM discount_redemptions r
                WHERE ?2::bigint IS NOT NULL AND r.code_id = ?2
                  AND r.user_id NOT IN (SELECT user_id FROM people))::int AS used_outside,
              (SELECT count(*) FROM people WHERE expires_now > expires_epoch)::int AS stayed,
              (SELECT count(*) FROM people
                WHERE expires_now <= expires_epoch AND expires_at < now())::int AS left_,
              (SELECT count(*) FROM people
                WHERE expires_now <= expires_epoch AND expires_at >= now())::int AS pending,
              (SELECT count(*) FROM rows WHERE status IN ('PENDING', 'FAILED'))::int AS queued,
              (SELECT count(*) FROM rows WHERE status = 'SENT')::int AS msg_sent,
              (SELECT count(*) FROM rows WHERE status = 'DEAD')::int AS dead,
              (SELECT count(*) FROM rows
                WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Tehran') AT TIME ZONE 'Asia/Tehran')::int AS today`,
    )
    .bind(ruleKey, codeId)
    .first<{
      sent: number;
      used_code: number;
      used_outside: number;
      stayed: number;
      left_: number;
      pending: number;
      queued: number;
      msg_sent: number;
      dead: number;
      today: number;
    }>();
  return {
    sent: row?.sent ?? 0,
    usedCode: row?.used_code ?? 0,
    usedOutside: row?.used_outside ?? 0,
    stayed: row?.stayed ?? 0,
    left: row?.left_ ?? 0,
    pending: row?.pending ?? 0,
    messages: {
      queued: row?.queued ?? 0,
      sent: row?.msg_sent ?? 0,
      dead: row?.dead ?? 0,
      today: row?.today ?? 0,
    },
  };
}
