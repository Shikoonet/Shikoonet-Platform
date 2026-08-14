/**
 * The bot's editable wording and keyboard, loaded from Postgres and cached.
 *
 * `texts.ts` and `keyboard.ts` are pure — they hold the defaults and the rules.
 * This is the only file that reads the two override tables, and it is
 * deliberately the only one that can fail.
 *
 * (Named `botContent` rather than `content` because `content.ts` is already the
 * help articles and the client apps.)
 *
 * ## A failed read is the default, not an error
 *
 * Every path here falls back to what the code ships. A database hiccup while an
 * admin edits wording must not stop a customer buying a service: the worst
 * acceptable outcome is last release's sentence, and the worst unacceptable one
 * is a bot that answers nothing. So the query is wrapped and a failure is
 * logged once — not once per update — and treated as "no overrides".
 *
 * ## Why it is cached
 *
 * The bot long-polls; every update would otherwise cost two extra queries for
 * content that changes a few times a year. Thirty seconds is short enough that
 * an admin who saves a text and opens the bot sees it on the next screen, and
 * long enough that a busy minute is not spent re-reading the same forty rows.
 */

import type { D1Database, D1DatabaseSession } from '@shikoo/database';
import { DEFAULT_LAYOUT, type ButtonPlacement } from './keyboard.js';
import { Texts } from '@shikoo/contracts';

type Db = D1Database | D1DatabaseSession;

export interface BotContent {
  texts: Texts;
  layout: readonly ButtonPlacement[];
}

/** The content as the code ships it, for tests and for a failed read. */
export const DEFAULT_CONTENT: BotContent = {
  texts: new Texts(),
  layout: DEFAULT_LAYOUT,
};

export const CONTENT_CACHE_MS = 30_000;

let cached: { at: number; content: BotContent } | null = null;
/** Logged once per outage rather than once per update. */
let warned = false;

/** Drops the cache. For tests, and after an admin edit that must be seen now. */
export function invalidateBotContent(): void {
  cached = null;
  warned = false;
}

async function readTexts(db: Db): Promise<Record<string, string>> {
  const rows = await db.prepare(`SELECT key, value FROM bot_texts`).all<{
    key: string;
    value: string;
  }>();
  return Object.fromEntries((rows.results ?? []).map((r) => [r.key, r.value]));
}

async function readLayout(db: Db): Promise<readonly ButtonPlacement[]> {
  const rows = await db
    .prepare(
      `SELECT action, label, row_index, col_index, visible
         FROM bot_keyboard_buttons
        ORDER BY row_index, col_index`,
    )
    .all<{
      action: string;
      label: string;
      row_index: number;
      col_index: number;
      visible: boolean;
    }>();
  const buttons = rows.results ?? [];
  // Empty means "not customised", not "a keyboard with no buttons" — the table
  // holds a whole layout or nothing at all.
  if (buttons.length === 0) return DEFAULT_LAYOUT;
  return buttons.map((b) => ({
    action: b.action,
    label: b.label,
    rowIndex: Number(b.row_index),
    colIndex: Number(b.col_index),
    visible: b.visible,
  }));
}

export async function loadBotContent(db: Db, now = Date.now()): Promise<BotContent> {
  if (cached && now - cached.at < CONTENT_CACHE_MS) return cached.content;
  try {
    const [overrides, layout] = await Promise.all([readTexts(db), readLayout(db)]);
    // `Texts` drops any override that fails its own check, so a row written by
    // hand cannot reach a customer even though the API would have refused it.
    const content: BotContent = { texts: new Texts(overrides), layout };
    cached = { at: now, content };
    warned = false;
    return content;
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn('[bot] could not load editable content, using defaults', err);
    }
    return DEFAULT_CONTENT;
  }
}
