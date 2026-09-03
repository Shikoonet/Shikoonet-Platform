/**
 * The shop's own reports, and the topic each one goes to.
 *
 * Sam, 2026-09-03: a Telegram group with a topic per kind of report, «مثل
 * میرزا و فاکسیما». Both legacy bots build these by hand at every send site —
 * mirzabot has the same four-line `sendReport` copied into seven API files, and
 * inlines the `if (strlen($groupid) > 0)` guard everywhere else. This is the
 * one place instead.
 *
 * ## Everything goes through the outbox
 *
 * `enqueue` and not a direct send, for the reason `alert()` already works that
 * way: a report is a side effect of something that has already happened, and it
 * must not be able to fail the thing it is reporting on. The dedupe key does
 * the rest — a sweep that runs twice, or two sweeps overlapping, produce one
 * message rather than two.
 *
 * ## It is silent when it is not configured, and that is the normal state
 *
 * No group set, or a topic still at zero, and nothing is sent or is sent to the
 * group's General topic. Every one of these is new, so the shop that has not
 * made the topics yet keeps exactly the behaviour it has today.
 */

import type { D1DatabaseSession } from '@shikoo/database';
import type { ReportKind } from '@shikoo/contracts';
import { enqueue } from './notify.js';
import type { ShopSettings } from './settings.js';

export interface ReportTarget {
  reportChatId: ShopSettings['reportChatId'];
  reportTopics: ShopSettings['reportTopics'];
}

/**
 * Queues one report. Returns whether a row was written.
 *
 * `dedupeKey` must be derived from the thing being reported — the order's
 * public id, the payment's — and never from a clock. `report:` prefixes it here
 * so a report and a customer-facing message about the same order cannot
 * collide on one key, which would silently drop whichever came second.
 */
export async function report(
  tx: D1DatabaseSession,
  shop: ReportTarget,
  kind: ReportKind,
  dedupeKey: string,
  text: string,
): Promise<boolean> {
  if (shop.reportChatId === null) return false;
  return enqueue(tx, {
    dedupeKey: `report:${kind}:${dedupeKey}`,
    chatId: shop.reportChatId,
    text,
    threadId: shop.reportTopics[kind],
  });
}
