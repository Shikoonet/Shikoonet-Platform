/**
 * What happened after a retention rule messaged people.
 *
 * Read from what already exists — the outbox rows that were sent, the
 * service each was about, and the code redemptions — rather than a table of
 * sends. The dedupe key `retention:<rule>:<sub>:<expiresEpoch>:<day>`
 * carries which service and which expiry; a person is counted once however
 * many days of the window they were written to.
 *
 *   sent         PEOPLE (services) this rule reached — not messages
 *   usedCode     of those, how many redeemed the rule's code after their
 *                first message (0 when the rule has no code)
 *   usedOutside  redemptions of that code by people this rule never
 *                messaged — a code that leaked, or one the shop also gave
 *                out by hand. Sam, 2026-09-20: «کسایی خارج از این گروه»
 *   stayed       the service's expiry moved past the one the message was
 *                about — a renewal or added time
 *   left         that expiry has passed and nothing moved it
 *   pending      not yet expired, not yet renewed
 *
 * «did not use» is `sent − usedCode` and the screen does that subtraction.
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
}

export async function retentionFunnel(
  db: D1Database,
  ruleKey: string,
  codeId: number | null,
): Promise<RetentionFunnel> {
  const row = await db
    .prepare(
      `WITH sent AS (
         SELECT DISTINCT ON (sub_id) sub_id, expires_epoch, sent_at
           FROM (SELECT split_part(n.dedupe_key, ':', 3)::bigint AS sub_id,
                        split_part(n.dedupe_key, ':', 4)::bigint AS expires_epoch,
                        n.sent_at
                   FROM bot_notifications n
                  WHERE n.dedupe_key LIKE 'retention:' || ?1 || ':%'
                    AND n.status = 'SENT') x
          ORDER BY sub_id, sent_at),
       people AS (
         SELECT sent.sub_id, sent.expires_epoch, sent.sent_at, s.user_id, s.expires_at
           FROM sent JOIN subscriptions s ON s.id = sent.sub_id)
       SELECT (SELECT count(*) FROM people)::int AS sent,
              (SELECT count(*) FROM people p
                WHERE ?2::bigint IS NOT NULL AND EXISTS (
                  SELECT 1 FROM discount_redemptions r
                   WHERE r.code_id = ?2 AND r.user_id = p.user_id
                     AND r.created_at >= p.sent_at))::int AS used_code,
              (SELECT count(*) FROM discount_redemptions r
                WHERE ?2::bigint IS NOT NULL AND r.code_id = ?2
                  AND r.user_id NOT IN (SELECT user_id FROM people))::int AS used_outside,
              (SELECT count(*) FROM people
                WHERE extract(epoch FROM expires_at) > expires_epoch)::int AS stayed,
              (SELECT count(*) FROM people
                WHERE extract(epoch FROM expires_at) <= expires_epoch AND expires_at < now())::int AS left_,
              (SELECT count(*) FROM people
                WHERE extract(epoch FROM expires_at) <= expires_epoch AND expires_at >= now())::int AS pending`,
    )
    .bind(ruleKey, codeId)
    .first<{
      sent: number;
      used_code: number;
      used_outside: number;
      stayed: number;
      left_: number;
      pending: number;
    }>();
  return {
    sent: row?.sent ?? 0,
    usedCode: row?.used_code ?? 0,
    usedOutside: row?.used_outside ?? 0,
    stayed: row?.stayed ?? 0,
    left: row?.left_ ?? 0,
    pending: row?.pending ?? 0,
  };
}
