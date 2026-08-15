/**
 * متن‌های ربات and چیدمان کیبورد — the bot's own words and buttons.
 *
 * The validation is not duplicated here. The defaults and the rules live in
 * `@shikoo/contracts` — pure, no dependencies — and both this route and the bot
 * import them, so the panel and the bot cannot disagree about whether an edit is
 * acceptable. A second copy of "the support text needs {handle}" would be the
 * drift that lets a broken override through.
 *
 * ## What a save actually writes
 *
 * A text equal to its default is stored as nothing. Saving the default back is
 * how an admin resets, and a row holding a copy of the default would freeze
 * this shop's wording at the version it shipped with — a later release that
 * improves the sentence would never reach them.
 *
 * The keyboard is written whole, in one transaction: the table is either the
 * complete layout or empty. There is no merge, so there is no state where half
 * a saved layout is live.
 */

import type { Hono } from 'hono';
import { z } from 'zod';
import type { D1Database } from '@shikoo/database';
import {
  checkLayout,
  checkOverride,
  DEFAULT_LAYOUT,
  isTextKey,
  MAX_LABEL_LENGTH,
  MAX_TEXT_LENGTH,
  MENU_ACTIONS,
  SCREEN_IDS,
  SCREENS,
  TEXT_KEYS,
  TEXTS,
  type ButtonPlacement,
  type TextKey,
} from '@shikoo/contracts';
import { audit, type Ident } from './adminAudit.js';

const TextBody = z
  .object({
    key: z.string().min(1).max(120),
    value: z.string().max(MAX_TEXT_LENGTH),
  })
  .strict();

const LayoutBody = z
  .object({
    buttons: z
      .array(
        z
          .object({
            action: z.string().min(1).max(32),
            label: z.string().max(MAX_LABEL_LENGTH),
            rowIndex: z.number().int().min(0).max(19),
            colIndex: z.number().int().min(0).max(7),
            visible: z.boolean(),
          })
          .strict(),
      )
      .max(40),
  })
  .strict();

/** The problem, in the admin's language. */
function textProblem(problem: NonNullable<ReturnType<typeof checkOverride>>): string {
  switch (problem.kind) {
    case 'UNKNOWN_KEY':
      return 'چنین متنی در ربات وجود ندارد.';
    case 'EMPTY':
      return 'متن نمی‌تواند خالی باشد.';
    case 'TOO_LONG':
      return `تلگرام پیام بلندتر از ${problem.limit} کاراکتر را رد می‌کند.`;
    case 'MISSING_PLACEHOLDER':
      return `این متن باید ${problem.names.map((n) => `{${n}}`).join('، ')} را داشته باشد، وگرنه مقدارش به مشتری نمی‌رسد.`;
    case 'UNKNOWN_PLACEHOLDER':
      return `${problem.names.map((n) => `{${n}}`).join('، ')} برای این متن معنا ندارد و عیناً به مشتری نشان داده می‌شود.`;
  }
}

function layoutProblem(problem: NonNullable<ReturnType<typeof checkLayout>>): string {
  switch (problem.kind) {
    case 'EMPTY':
      return 'کیبورد نمی‌تواند بدون دکمه باشد.';
    case 'NOTHING_VISIBLE':
      return 'دست‌کم یک دکمه باید برای مشتری قابل دیدن باشد، وگرنه منو راه خروج ندارد.';
    case 'UNKNOWN_ACTION':
      return `این دکمه‌ها در ربات وجود ندارند: ${problem.actions.join('، ')}`;
    case 'DUPLICATE_ACTION':
      return `این دکمه‌ها تکراری‌اند: ${problem.actions.join('، ')}`;
    case 'DUPLICATE_CELL':
      return 'دو دکمه در یک جای کیبورد قرار گرفته‌اند.';
    case 'LABEL_EMPTY':
      return `عنوان این دکمه‌ها خالی است: ${problem.actions.join('، ')}`;
    case 'LABEL_TOO_LONG':
      return `عنوان این دکمه‌ها بلندتر از ${problem.limit} کاراکتر است: ${problem.actions.join('، ')}`;
  }
}

export function registerBotContentRoutes(
  app: Hono<{ Bindings: { DB: D1Database }; Variables: { identity: Ident } }>,
) {
  // --- متن‌های ربات ---------------------------------------------------------

  app.get('/api/v1/admin/bot-texts', async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT key, value, updated_at, updated_by FROM bot_texts`,
    ).all<{ key: string; value: string; updated_at: string; updated_by: string | null }>();
    const overrides = new Map((rows.results ?? []).map((r) => [r.key, r]));

    return c.json({
      ok: true,
      // The screen list travels with the texts rather than being repeated in the
      // panel: a screen added here must appear there without a second edit, and
      // a panel with its own copy is a panel that can disagree with the bot.
      screens: SCREEN_IDS.map((id) => ({ id, label: SCREENS[id] })),
      // The registry is the list, not the table: a text nobody has edited still
      // has to be visible and editable, and it has no row.
      items: TEXT_KEYS.map((key) => {
        const entry = TEXTS[key];
        const row = overrides.get(key);
        return {
          key,
          screen: entry.screen,
          hint: entry.hint,
          placeholders: entry.placeholders,
          default: entry.default,
          value: row?.value ?? entry.default,
          customised: row !== undefined,
          updatedAt: row?.updated_at ?? null,
          updatedBy: row?.updated_by ?? null,
        };
      }),
      maxLength: MAX_TEXT_LENGTH,
    });
  });

  app.post('/api/v1/admin/bot-texts', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const parsed = TextBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const { key, value } = parsed.data;

    if (!isTextKey(key)) return c.json({ ok: false, error: 'unknown_key' }, 404);

    const problem = checkOverride(key, value);
    if (problem) {
      return c.json({ ok: false, error: 'invalid_text', detail: textProblem(problem) }, 400);
    }

    const before = await c.env.DB.prepare(`SELECT value FROM bot_texts WHERE key = ?1`)
      .bind(key)
      .first<{ value: string }>();

    // Equal to the default means "not customised" — stored as the absence of a
    // row, so a later release's better wording still reaches this shop.
    const isDefault = value === TEXTS[key as TextKey].default;
    if (isDefault) {
      await c.env.DB.prepare(`DELETE FROM bot_texts WHERE key = ?1`).bind(key).run();
    } else {
      await c.env.DB.prepare(
        `INSERT INTO bot_texts (key, value, updated_by) VALUES (?1, ?2, ?3)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value,
                                         updated_at = now(),
                                         updated_by = excluded.updated_by`,
      )
        .bind(key, value, ident.email)
        .run();
    }

    await audit(
      c.env.DB,
      ident,
      isDefault ? 'bot_text.reset' : 'bot_text.updated',
      'BOT_TEXT',
      key,
      { value: before?.value ?? null },
      { value: isDefault ? null : value },
      null,
    );

    return c.json({ ok: true, customised: !isDefault });
  });

  // --- چیدمان کیبورد -------------------------------------------------------

  app.get('/api/v1/admin/bot-keyboard', async (c) => {
    const rows = await c.env.DB.prepare(
      `SELECT action, label, row_index, col_index, visible FROM bot_keyboard_buttons
        ORDER BY row_index, col_index`,
    ).all<{
      action: string;
      label: string;
      row_index: number;
      col_index: number;
      visible: boolean;
    }>();
    const saved = rows.results ?? [];

    return c.json({
      ok: true,
      customised: saved.length > 0,
      buttons:
        saved.length > 0
          ? saved.map((b) => ({
              action: b.action,
              label: b.label,
              rowIndex: Number(b.row_index),
              colIndex: Number(b.col_index),
              visible: b.visible,
            }))
          : DEFAULT_LAYOUT,
      // The palette: everything the bot can dispatch, so the admin can add back
      // a button they removed.
      actions: MENU_ACTIONS,
      maxLabelLength: MAX_LABEL_LENGTH,
    });
  });

  app.post('/api/v1/admin/bot-keyboard', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    const parsed = LayoutBody.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ ok: false, error: 'invalid_body' }, 400);
    const buttons = parsed.data.buttons as ButtonPlacement[];

    const problem = checkLayout(buttons);
    if (problem) {
      return c.json({ ok: false, error: 'invalid_layout', detail: layoutProblem(problem) }, 400);
    }

    // Whole-layout replacement in one transaction: there is no moment at which
    // the bot could read half of it.
    const statements = [
      c.env.DB.prepare(`DELETE FROM bot_keyboard_buttons`),
      ...buttons.map((b) =>
        c.env.DB
          .prepare(
            `INSERT INTO bot_keyboard_buttons
               (action, label, row_index, col_index, visible, updated_by)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          )
          .bind(b.action, b.label, b.rowIndex, b.colIndex, b.visible, ident.email),
      ),
    ];
    await c.env.DB.batch(statements);

    await audit(c.env.DB, ident, 'bot_keyboard.updated', 'BOT_KEYBOARD', 'main', null, {
      buttons: buttons.map((b) => ({
        action: b.action,
        label: b.label,
        row: b.rowIndex,
        col: b.colIndex,
        visible: b.visible,
      })),
    }, null);

    return c.json({ ok: true });
  });

  app.post('/api/v1/admin/bot-keyboard/reset', async (c) => {
    const ident = c.get('identity');
    if (ident.role !== 'ADMIN') return c.json({ ok: false, error: 'forbidden' }, 403);

    // Emptying the table is the reset: the bot reads "no rows" as "use the
    // layout the code ships".
    await c.env.DB.prepare(`DELETE FROM bot_keyboard_buttons`).run();
    await audit(c.env.DB, ident, 'bot_keyboard.reset', 'BOT_KEYBOARD', 'main', null, null, null);
    return c.json({ ok: true });
  });
}
