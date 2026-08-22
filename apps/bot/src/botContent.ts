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
import { DEFAULT_LAYOUTS, isMenuId, type ButtonPlacement, type MenuId } from './keyboard.js';
import { Texts } from '@shikoo/contracts';
import { createLogger } from '@shikoo/domain';

const log = createLogger('bot');

type Db = D1Database | D1DatabaseSession;

export type Layouts = Record<MenuId, readonly ButtonPlacement[]>;

export interface BotContent {
  texts: Texts;
  layouts: Layouts;
}

/** The content as the code ships it, for tests and for a failed read. */
export const DEFAULT_CONTENT: BotContent = {
  texts: new Texts(),
  layouts: DEFAULT_LAYOUTS,
};

export const CONTENT_CACHE_MS = 30_000;

let cached: { at: number; content: BotContent } | null = null;
/** Logged once per outage rather than once per update. */
let warned = false;
/** Whether either half of the current load fell back. */
let failed = false;

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

/**
 * Every customised keyboard, in one query.
 *
 * Grouped in memory rather than asked for per screen: there are twenty menus
 * and a shop customises one or two, so twenty round trips would be nineteen
 * questions with the same answer.
 *
 * A menu absent from the result keeps the code's layout, and that is per menu,
 * not all-or-nothing across the table — a shop that renamed one invoice button
 * still gets a later release's improvements to every other screen.
 */
async function readLayouts(db: Db): Promise<Layouts> {
  const rows = await db
    .prepare(
      `SELECT menu, action, label, row_index, col_index, visible
         FROM bot_keyboard_buttons
        ORDER BY menu, row_index, col_index`,
    )
    .all<{
      menu: string;
      action: string;
      label: string;
      row_index: number;
      col_index: number;
      visible: boolean;
    }>();

  const saved = new Map<MenuId, ButtonPlacement[]>();
  for (const b of rows.results ?? []) {
    // A row naming a menu this build does not have is skipped rather than
    // guessed at. It can only come from a hand-written row or a screen removed
    // by a later release, and neither is a keyboard to draw.
    if (!isMenuId(b.menu)) continue;
    const into = saved.get(b.menu) ?? [];
    into.push({
      action: b.action,
      label: b.label,
      rowIndex: Number(b.row_index),
      colIndex: Number(b.col_index),
      visible: b.visible,
    });
    saved.set(b.menu, into);
  }

  const layouts = { ...DEFAULT_LAYOUTS };
  for (const [menu, buttons] of saved) layouts[menu] = buttons;
  return layouts;
}

/**
 * One half of the content, or the code's defaults for that half.
 *
 * Separately rather than around both, and the reason is a real failure: the two
 * reads shared one `try`, so a migration that had not been applied yet made the
 * keyboard query throw and took the wording down with it. The shop's texts were
 * in the table, valid, and silently ignored — the worst shape of failure, since
 * nothing on any screen says which half was lost.
 */
async function half<T>(what: string, read: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await read();
  } catch (err) {
    if (!warned) log.warn('content.read_failed', { what, using: 'the shipped defaults' }, err);
    failed = true;
    return fallback;
  }
}

/**
 * @param customEmoji whether the shop has Telegram custom emoji switched on.
 *
 * Passed in rather than read here, because `loadShopSettings` already reads it
 * and two readers of one switch is one too many — they would disagree for the
 * length of a cache window, and the disagreement would show as angle brackets
 * in front of a customer.
 */
export async function loadBotContent(
  db: Db,
  now = Date.now(),
  customEmoji = false,
): Promise<BotContent> {
  if (cached && now - cached.at < CONTENT_CACHE_MS) return cached.content;
  failed = false;
  const [overrides, layouts] = await Promise.all([
    half('the bot texts', () => readTexts(db), {} as Record<string, string>),
    half('the bot keyboards', () => readLayouts(db), DEFAULT_LAYOUTS as Layouts),
  ]);
  // `Texts` drops any override that fails its own check, so a row written by
  // hand cannot reach a customer even though the API would have refused it. It
  // also strips custom emoji markup when the shop has the feature off, which is
  // what makes switching it off — or having it switched off automatically —
  // leave the shop's own wording in place.
  const content: BotContent = { texts: new Texts(overrides, customEmoji), layouts };
  // A failed read is not cached. Caching it would hold the defaults for the
  // next thirty seconds after the database came back, for no gain.
  if (failed) {
    warned = true;
    return content;
  }
  cached = { at: now, content };
  warned = false;
  return content;
}
