/**
 * What happened after a retention rule messaged people.
 *
 * Read from what already exists — the outbox row that was sent, the service
 * it was about, and the code redemptions — rather than a table of sends. The
 * dedupe key `retention:<rule>:<sub>:<expiresEpoch>` carries the two facts a
 * funnel needs: which service, and which expiry the message was about.
 *
 *   sent       messages Telegram accepted for this rule
 *   usedCode   of those customers, how many redeemed the rule's code after
 *              the message (0 when the rule has no code)
 *   stayed     the service's expiry moved past the one the message was about
 *              — a renewal or added time
 *   left       that expiry has passed and nothing moved it
 *   pending    not yet expired, not yet renewed
 *
 * ponytail: split_part on the key is the ceiling. A `retention_sends` table is
 * the upgrade if this query ever shows in the nightly report's timings.
 */

import type { D1Database } from '@shikoo/database';

export interface RetentionFunnel {
  sent: number;
  usedCode: number;
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
         SELECT split_part(n.dedupe_key, ':', 3)::bigint AS sub_id,
                split_part(n.dedupe_key, ':', 4)::bigint AS expires_epoch,
                n.sent_at
           FROM bot_notifications n
          WHERE n.dedupe_key LIKE 'retention:' || ?1 || ':%'
            AND n.status = 'SENT')
       SELECT count(*)::int AS sent,
              count(*) FILTER (WHERE ?2::bigint IS NOT NULL AND EXISTS (
                SELECT 1 FROM discount_redemptions r
                 WHERE r.code_id = ?2 AND r.user_id = s.user_id
                   AND r.created_at >= sent.sent_at))::int AS used_code,
              count(*) FILTER (WHERE extract(epoch FROM s.expires_at) > sent.expires_epoch)::int AS stayed,
              count(*) FILTER (WHERE extract(epoch FROM s.expires_at) <= sent.expires_epoch
                                 AND s.expires_at < now())::int AS left_,
              count(*) FILTER (WHERE extract(epoch FROM s.expires_at) <= sent.expires_epoch
                                 AND s.expires_at >= now())::int AS pending
         FROM sent
         JOIN subscriptions s ON s.id = sent.sub_id`,
    )
    .bind(ruleKey, codeId)
    .first<{ sent: number; used_code: number; stayed: number; left_: number; pending: number }>();
  return {
    sent: row?.sent ?? 0,
    usedCode: row?.used_code ?? 0,
    stayed: row?.stayed ?? 0,
    left: row?.left_ ?? 0,
    pending: row?.pending ?? 0,
  };
}
