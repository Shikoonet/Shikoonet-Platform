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

import { MAX_SINGLE_PAYMENT_IRR } from '@shikoo/contracts';
import {
  MAX_MESSAGE_LENGTH,
  activeCustomerCount,
  applyBulkPrice,
  creditEveryone,
  previewBulkPrice,
  queueBroadcast,
} from '@shikoo/domain';
import { audit, type Ident } from './adminAudit.js';

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

const BroadcastBody = z
  .object({
    body: z.string().trim().min(1).max(MAX_MESSAGE_LENGTH),
    broadcastId: UUID,
  })
  .strict();

export function registerBulkRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
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
      const after = (typeof row.after_json === 'string'
        ? (JSON.parse(row.after_json) as Record<string, unknown>)
        : ((row.after_json ?? {}) as Record<string, unknown>));
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

  app.post('/api/v1/admin/bulk/broadcast', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const parsed = BroadcastBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const { body, broadcastId } = parsed.data;

    const reach = await activeCustomerCount(c.env.DB);
    if (reach === 0) return c.json({ ok: false, error: 'no_active_customers' }, 409);

    // `created_by` is a Telegram id on the bot's path and this operator has
    // none. 0 rather than a fake id: the audit row carries the email, which is
    // who actually did it.
    const queued = await queueBroadcast(c.env.DB, broadcastId, body, 0);
    await audit(
      c.env.DB,
      ident,
      'customers.broadcast_queued',
      'CUSTOMER',
      broadcastId,
      null,
      { recipients: queued, length: body.length },
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
