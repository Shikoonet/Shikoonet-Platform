/**
 * Credit every wallet, message every customer — from the web panel.
 *
 * These two were reachable only from the bot's admin panel, which made them the
 * last two of its twelve permissions with no equivalent here. The plan for one
 * panel says the bot's surface must be a strict subset of the web's, and
 * `test/bot-subset.test.ts` fails the build if it stops being one.
 *
 * They do not reimplement anything. `creditEveryone` and `queueBroadcast` moved
 * to `@shikoo/domain` and both surfaces call the same two functions, so the
 * idempotency key, the snapshot of recipients and the append-only wallet entry
 * are one implementation rather than two that agree today.
 *
 * ## What the client supplies, and why
 *
 * `batchId` and `broadcastId` come from the browser, not from here. That looks
 * backwards until you ask what a retry means: a double-submitted form, or a
 * request whose response was lost on a flaky connection, has to land on the
 * *same* batch or eleven thousand customers get credited twice. The id is
 * generated when the operator opens the form and travels with the confirmation
 * — which is exactly what the bot does with its session. An id minted here
 * would be new on every attempt and the idempotency key would never collide.
 *
 * ## The ceiling
 *
 * The per-person bound is the shop's own card-to-card limit, the same one a
 * single correction has. The number that actually stops a mistake is the total
 * on the confirmation screen: an extra zero is invisible in «۵۰٬۰۰۰ تومان» and
 * unmissable multiplied by the reach.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';

import { MAX_SINGLE_PAYMENT_IRR, parseChannelPostLink } from '@shikoo/contracts';
import type { EnvName } from '@shikoo/contracts';
import {
  MAX_MESSAGE_LENGTH,
  activeCustomerCount,
  applyBulkPrice,
  creditEveryone,
  previewBulkPrice,
  queueBroadcast,
  type BroadcastContent,
} from '@shikoo/domain';
import { audit, type Ident } from './adminAudit.js';
import { botTelegram, type BotCallEnv } from './telegramCall.js';

/**
 * A v4 UUID, which is what `newBatchId()` produces on the bot side. Bounded
 * rather than "any string": this value becomes part of a database key, and the
 * shape is the cheapest guard against a client that sends something reused or
 * attacker-chosen.
 */
const UUID = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, 'expected a uuid');

const CreditBody = z
  .object({
    amountIrr: z.number().int().min(1).max(MAX_SINGLE_PAYMENT_IRR),
    batchId: UUID,
    note: z.string().trim().min(1).max(500).default('web admin panel — bulk credit'),
  })
  .strict();

/**
 * A bulk price change.
 *
 * `amount` means IRR when the mode is FIXED and whole percent when it is
 * PERCENT, which is why it is bounded twice rather than once — a 500% rise is
 * a typo and a 500 IRR rise is fifty Toman. The narrower bound is applied after
 * parsing, where the mode is known. (The ceiling is 500, not the 200 an earlier
 * version of this sentence named: five times is a repricing an operator might
 * really mean, and past that it is a slipped keyboard.)
 *
 * A percentage decrease is capped at 99 rather than 100, and that cap is now
 * belt to the floor's braces rather than the only guard. It was written when
 * `bulkPrice` refused only prices BELOW zero, so -100% — "make everything free"
 * — walked through. The floor refuses zero itself now, which also closes the
 * doors this cap never reached: a FIXED decrease equal to the price, or within
 * five Rial of it.
 */
const PriceBody = z
  .object({
    providerId: z.number().int().positive().nullable().default(null),
    mode: z.enum(['PERCENT', 'FIXED']),
    direction: z.enum(['UP', 'DOWN']),
    amount: z.number().int().min(1),
    /**
     * The same key the credit and broadcast routes take, for the same reason
     * and more urgently: a price change COMPOUNDS. Two deliveries of "up 10%"
     * are 21%, and there is no undo — the rounding is lossy, so no percentage
     * puts back what a percentage took. This was the only irreversible action
     * on the screen and the only one without a key.
     */
    operationId: UUID,
  })
  .strict()
  .refine((v) => v.mode === 'FIXED' || v.amount <= (v.direction === 'DOWN' ? 99 : 500), {
    message: 'percentage out of range',
    path: ['amount'],
  })
  .refine((v) => v.mode === 'PERCENT' || v.amount <= MAX_SINGLE_PAYMENT_IRR, {
    message: 'amount out of range',
    path: ['amount'],
  });

/**
 * A broadcast is one of two things, and the union is what keeps them apart.
 *
 * `.strict()` on both halves is the part doing the work: a request carrying
 * BOTH a body and a link matches neither branch and is refused here, rather
 * than reaching the CHECK on `broadcasts` as a 500.
 *
 * The link is bounded at 500 characters and validated by shape afterwards.
 * `required_channels` refuses a `t.me/…` URL for its `chat_ref` and this
 * accepts nothing else — the two are not inconsistent: there the URL is the
 * mistake, here it is the input, because a URL is what Telegram's own «copy
 * link» puts in the operator's clipboard.
 */
const BroadcastBody = z.union([
  z
    .object({
      body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
      broadcastId: UUID,
    })
    .strict(),
  z
    .object({
      postLink: z.string().trim().min(1).max(500),
      broadcastId: UUID,
    })
    .strict(),
]);

/**
 * Forwards the post once, where a person will see it, before anybody else does.
 *
 * Returns Telegram's own `description` on refusal. That field is the whole
 * value of this check: «chat not found», «message to forward not found» and
 * «bot is not a member of the channel chat» are three different things for an
 * operator to go and fix, and without it all three arrive as «it did not work».
 *
 * It goes to the report group's «گزارش تست» topic — the topic that exists for
 * exactly this, a place the shop's own people watch and no customer does.
 */
async function rehearseForward(
  env: BotCallEnv,
  fromChat: string,
  messageId: number,
): Promise<
  { ok: true } | { ok: false; status: 409 | 422 | 502 | 503; error: string; detail: string }
> {
  const rows = await env.DB.prepare(
    `SELECT key, value FROM settings
      WHERE scope = 'bot' AND key IN ('Channel_Report', 'topic_reporttest')`,
  ).all<{ key: string; value: unknown }>();
  const setting = new Map((rows.results ?? []).map((r) => [r.key, String(r.value ?? '').trim()]));

  const rawChat = setting.get('Channel_Report') ?? '';
  const chatId = /^-?[0-9]{1,19}$/.test(rawChat) ? Number(rawChat) : null;
  if (chatId === null || chatId === 0) {
    return {
      ok: false,
      status: 409,
      error: 'no_report_group',
      detail:
        'برای فوروارد پست، اول باید گروه گزارش وصل باشد — پست یک بار آن‌جا آزمایش می‌شود تا اگر ربات به کانال دسترسی ندارد، شما ببینیدش نه یازده هزار مشتری.',
    };
  }
  // Zero and negative are «not configured» — legacy's own sentinels, and what
  // the bot's settings reader treats as absent. An unset topic lands in the
  // group's General, which is a fine place for a rehearsal.
  const rawTopic = Number(setting.get('topic_reporttest') ?? '');
  const threadId = Number.isSafeInteger(rawTopic) && rawTopic > 0 ? rawTopic : null;

  const bot = await botTelegram(env);
  if (!bot.ok) return bot;

  let reply;
  try {
    reply = await bot.call('forwardMessage', {
      chat_id: chatId,
      from_chat_id: fromChat,
      message_id: messageId,
      ...(threadId === null ? {} : { message_thread_id: threadId }),
    });
  } catch {
    // Telegram could not be reached at all, which is not the same as Telegram
    // saying no — nothing about the post has been learned, so nothing is queued
    // and the operator is asked to try again rather than to fix a link.
    return { ok: false, status: 502, error: 'telegram_unreachable', detail: 'تلگرام جواب نداد.' };
  }
  if (reply.ok !== true) {
    return {
      ok: false,
      status: 422,
      error: 'post_unreachable',
      detail: `تلگرام این پست را فوروارد نکرد: ${reply.description ?? 'بدون توضیح'} — معمولاً یعنی ربات ادمین آن کانال نیست، یا پست پاک شده.`,
    };
  }
  return { ok: true };
}

export function registerBulkRoutes(
  app: Hono<{
    // Wider than `{ DB }` since 0055: forwarding a channel post means calling
    // Telegram from here, once, before anything is queued.
    Bindings: { DB: D1Database; ENV_NAME?: EnvName; TELEGRAM_BOT_TOKEN?: string };
    Variables: { identity: Ident };
  }>,
) {
  /** How many customers either action would reach. Readable by any operator. */
  app.get('/api/v1/admin/bulk/reach', async (c) => {
    return c.json({ ok: true, reach: await activeCustomerCount(c.env.DB) });
  });

  /**
   * What went out from this screen most recently, and who sent it.
   *
   * The idempotency key `bulk:<batch>:<user>` stops one submission being
   * applied twice. It cannot stop a second *decision* — a fresh batch id is a
   * new, legitimate charge, and the route is right to apply it. What was
   * missing is the only thing that prevents the mistake this screen actually
   * invites: an operator who cannot see that somebody credited everyone twenty
   * minutes ago, and does it again.
   *
   * Read out of `audit_logs` rather than kept in a table of its own. The rows
   * are already written on every send — including a retry that credited
   * nothing, which is deliberately in the log — and they are append-only, so
   * this cannot disagree with what happened.
   *
   * Any operator may read it. Seeing that a charge went out is not the same
   * power as making one, and a REVIEWER who cannot see it is the person most
   * likely to ask an ADMIN to send it again.
   */
  app.get('/api/v1/admin/bulk/recent', async (c) => {
    const { results } = await c.env.DB.prepare(
      `SELECT DISTINCT ON (action)
              action, actor_email, after_json, created_at
         FROM audit_logs
        WHERE action IN ('customers.bulk_credited', 'customers.broadcast_queued')
        ORDER BY action, created_at DESC`,
    ).all<{ action: string; actor_email: string; after_json: unknown; created_at: number }>();

    const of = (action: string) => {
      const row = (results ?? []).find((r) => r.action === action);
      if (!row) return null;
      const after =
        typeof row.after_json === 'string'
          ? (JSON.parse(row.after_json) as Record<string, unknown>)
          : ((row.after_json ?? {}) as Record<string, unknown>);
      return {
        by: row.actor_email,
        at: Number(row.created_at),
        // `wallets` for a credit, `recipients` for a broadcast — how many rows
        // the send actually wrote, which is 0 on a retry.
        count: Number(after['wallets'] ?? after['recipients'] ?? 0),
        amountIrr: after['amount_irr'] === undefined ? null : Number(after['amount_irr']),
      };
    };

    return c.json({
      ok: true,
      credit: of('customers.bulk_credited'),
      broadcast: of('customers.broadcast_queued'),
    });
  });

  app.post('/api/v1/admin/bulk/credit', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const parsed = CreditBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const { amountIrr, batchId, note } = parsed.data;

    const reach = await activeCustomerCount(c.env.DB);
    if (reach === 0) return c.json({ ok: false, error: 'no_active_customers' }, 409);

    const credited = await creditEveryone(c.env.DB, batchId, amountIrr, ident.email, note);
    // Written even when `credited` is 0, because 0 is the answer to a retry and
    // «this batch was submitted twice» is worth having in the log.
    await audit(
      c.env.DB,
      ident,
      'customers.bulk_credited',
      'CUSTOMER',
      batchId,
      null,
      { amount_irr: amountIrr, wallets: credited },
      null,
    );
    return c.json({ ok: true, credited, reach });
  });

  /**
   * Queues one announcement for every active customer — text, or a channel post.
   *
   * ## The rehearsal, and why it is not optional
   *
   * A forward can fail for reasons no amount of validating the LINK will catch:
   * the bot was never added to the channel, it was removed last week, the post
   * was deleted, the channel went private. None of those are visible from here
   * and all of them fail identically — per recipient, eleven thousand times,
   * after the operator has walked away.
   *
   * So the post is forwarded ONCE, into the shop's own report group, before a
   * single recipient row is written. If Telegram refuses, the operator reads
   * Telegram's own sentence while they are still standing at the screen, and
   * nothing was queued. If it succeeds, they can also SEE what is about to go
   * out, which is the other half of what a rehearsal is for.
   *
   * The report group is required rather than skipped-when-absent: a shop with
   * nowhere to show the rehearsal has nowhere to show the failure either, and
   * «we could not check» silently becoming «we did not check» is the whole
   * failure mode this exists to prevent.
   */
  app.post('/api/v1/admin/bulk/broadcast', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const parsed = BroadcastBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const { broadcastId } = parsed.data;

    const reach = await activeCustomerCount(c.env.DB);
    if (reach === 0) return c.json({ ok: false, error: 'no_active_customers' }, 409);

    let content: BroadcastContent;
    let detail: Record<string, unknown>;
    if ('postLink' in parsed.data) {
      const post = parseChannelPostLink(parsed.data.postLink);
      if (post === null) {
        return c.json(
          {
            ok: false,
            error: 'invalid_post_link',
            detail:
              'این لینک، لینک یک پست کانال نیست. مثل «https://t.me/shikoonet/137» باشد — از دکمهٔ «کپی لینک» روی خود پست.',
          },
          422,
        );
      }
      const rehearsal = await rehearseForward(c.env, post.chat, post.messageId);
      if (!rehearsal.ok) {
        return c.json({ ok: false, error: rehearsal.error, detail: rehearsal.detail }, rehearsal.status);
      }
      content = { kind: 'forward', chat: post.chat, messageId: post.messageId };
      detail = { source_chat: post.chat, source_message_id: post.messageId };
    } else {
      content = { kind: 'text', body: parsed.data.body };
      detail = { length: parsed.data.body.length };
    }

    // `created_by` is a Telegram id on the bot's path and this operator has
    // none. 0 rather than a fake id: the audit row carries the email, which is
    // who actually did it.
    const queued = await queueBroadcast(c.env.DB, broadcastId, content, 0);
    await audit(
      c.env.DB,
      ident,
      'customers.broadcast_queued',
      'CUSTOMER',
      broadcastId,
      null,
      { recipients: queued, ...detail },
      null,
    );
    return c.json({ ok: true, queued, reach });
  });

  /**
   * What a price change would do. Readable by any operator, writes nothing.
   *
   * A POST rather than a GET because it carries four fields and one of them is
   * nullable; the alternative is a query string where `providerId=` and an
   * absent `providerId` have to mean the same thing.
   */
  app.post('/api/v1/admin/bulk/price/preview', async (c) => {
    // The preview takes the same body so the panel can hold ONE object across
    // both calls — the key it will commit under is chosen when the operator
    // asks what would happen, not when they confirm it, so an edit to the form
    // and a fresh preview are what mint a new one.
    const parsed = PriceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    return c.json({ ok: true, preview: await previewBulkPrice(c.env.DB, parsed.data) });
  });

  app.post('/api/v1/admin/bulk/price', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const parsed = PriceBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);

    // The audit row is written by `applyBulkPrice`, inside the transaction that
    // moves the prices, under the operation's own id — so the primary key is
    // what stops a second delivery, and a crash cannot leave prices moved with
    // no record of what they were. It used to be three statements out here with
    // nothing holding them together.
    //
    // What it carries is every plan that moved with both of its prices, not a
    // total and a count. A total cannot be undone; these can.
    const outcome = await applyBulkPrice(c.env.DB, parsed.data, {
      id: parsed.data.operationId,
      record: (tx, moved) =>
        audit(
          tx,
          ident,
          'catalog.bulk_repriced',
          'PRODUCT',
          String(parsed.data.providerId ?? 'all'),
          { plans: moved.map((m) => ({ id: m.planId, name: m.name, price_irr: m.fromIrr })) },
          {
            changed: moved.length,
            plans: moved.map((m) => ({ id: m.planId, price_irr: m.toIrr })),
            ...parsed.data,
          },
          null,
          parsed.data.operationId,
        ),
    });
    if (!outcome.ok) {
      // Refused, and nothing was written — including no audit row, so pressing
      // again after fixing the amount is allowed to work.
      const preview = await previewBulkPrice(c.env.DB, parsed.data);
      return c.json({ ok: false, error: outcome.reason, preview }, 409);
    }
    // `replayed` says the operator's second press did nothing, which is the
    // honest answer and not a failure — the change they asked for is applied.
    return c.json({ ok: true, changed: outcome.changed, replayed: outcome.replayed });
  });
}
