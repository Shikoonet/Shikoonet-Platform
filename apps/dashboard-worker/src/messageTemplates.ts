/**
 * The shop's ready-made messages to a customer, one list per screen.
 *
 * `('shop', <key>)` in `settings`, a JSON array of {key, text}. The first
 * list was «پیام به مشتری» on the payment review page (#320,
 * `review_messages`); the second is the same thing for the reseller-request
 * page (#330, `reseller_request_messages`) — Sam: «همینو می‌خوام برای
 * نماینده‌ها». One reader and one writer here, so the two screens cannot
 * drift on what a valid list is.
 *
 * A message's key is minted once and never renamed: the bot's outbox dedupes
 * on `<producer>:<row>:<key>`, so renaming a key would let the same text
 * reach the same person twice for the same row.
 */

import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import { audit, type Ident } from './adminAudit.js';

export const MessageTemplateItem = z
  .object({
    key: z.string().regex(/^[a-z0-9_-]{1,40}$/),
    text: z.string().trim().min(1).max(1000),
  })
  .strict();
export type MessageTemplate = z.infer<typeof MessageTemplateItem>;

export const MessageTemplateListBody = z
  .object({ items: z.array(MessageTemplateItem).max(50) })
  .strict();

export type MessageTemplateKey = 'review_messages' | 'reseller_request_messages';

export async function loadMessageTemplates(
  db: D1Database,
  key: MessageTemplateKey,
): Promise<MessageTemplate[]> {
  const row = await db
    .prepare(`SELECT value FROM settings WHERE scope = 'shop' AND key = ?1`)
    .bind(key)
    .first<{ value: unknown }>();
  const parsed = z.array(MessageTemplateItem).safeParse(row?.value ?? []);
  return parsed.success ? parsed.data : [];
}

/** Replaces the list; refuses two texts on one key. Audited as `setting.updated`. */
export async function saveMessageTemplates(
  db: D1Database,
  ident: Ident,
  key: MessageTemplateKey,
  items: MessageTemplate[],
): Promise<{ ok: true } | { ok: false; error: 'duplicate_key' }> {
  const keys = items.map((i) => i.key);
  if (new Set(keys).size !== keys.length) return { ok: false, error: 'duplicate_key' };
  const before = await loadMessageTemplates(db, key);
  await db
    .prepare(
      `INSERT INTO settings (scope, key, value, updated_by)
       VALUES ('shop', ?1, ?2::jsonb, ?3)
       ON CONFLICT (scope, key) DO UPDATE
         SET value = excluded.value, updated_at = now(), updated_by = excluded.updated_by`,
    )
    .bind(key, JSON.stringify(items), ident.email)
    .run();
  await audit(db, ident, 'setting.updated', 'SETTING', `shop/${key}`, { items: before }, { items }, null);
  return { ok: true };
}
