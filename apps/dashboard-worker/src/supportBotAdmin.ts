/**
 * The only way the dashboard reaches the support bot's own tables: the n8n «ShikooSup admin API»
 * webhook, called with `x-shikoo-admin-key`. It reads the bot's contacts and flagged tickets, gives
 * chats back to the bot, and sets the daily AI cap.
 *
 * Its answers cross a trust boundary, so each is parsed before use. n8n answers a request without
 * the key with a bare 200 and no body we recognise, which ends up here as `bad_answer`, never as
 * an empty list.
 */
import { z } from 'zod';
import type { BotRead } from './supportBotLimits.js';

export interface SupportBotAdminConfig {
  url?: string | undefined;
  secret?: string | undefined;
  fetchFn?: typeof fetch;
}

export class SupportBotAdminError extends Error {
  constructor(readonly code: 'not_configured' | 'unreachable' | 'bad_answer') {
    super(code);
  }
}

/**
 * A later batch failed after earlier ones were applied. `released` really are back with the bot,
 * so the caller audits them before it reports the failure.
 */
export class SupportBotPartialRelease extends SupportBotAdminError {
  constructor(
    code: SupportBotAdminError['code'],
    readonly released: number[],
  ) {
    super(code);
  }
}

const TIMEOUT_MS = 20_000;

const str = z.string().nullish().transform((v) => v ?? '');
const num = z.number().nullish().transform((v) => v ?? 0);
const when = z.string().nullish().transform((v) => v || null);

const ReadAnswer = z.object({
  ok: z.literal(true),
  cap: z.number().int().positive(),
  contacts: z.array(
    z.object({
      chat_id: z.number().int(),
      name: str,
      username: str,
      first_seen: when,
      last_seen: when,
      msg_count: num,
      bot_replies: num,
      ai_day: str,
      ai_count: num,
      human_until: when,
      open_ticket: num,
      ticket_count: num,
    }),
  ),
  tickets: z.array(
    z.object({
      id: z.number().int(),
      chat_id: z.number().int(),
      reason: z.string(),
      status: str,
      text: str,
      created_at: z.string(),
    }),
  ),
});
const ReleaseAnswer = z.object({ ok: z.literal(true), released: z.number().int(), chat_ids: z.array(z.number().int()) });
const CapAnswer = z.object({ ok: z.literal(true), cap: z.number().int().positive() });

async function call(cfg: SupportBotAdminConfig, body: Record<string, unknown>): Promise<unknown> {
  if (!cfg.url || !cfg.secret) throw new SupportBotAdminError('not_configured');
  let res: Response;
  try {
    res = await (cfg.fetchFn ?? fetch)(cfg.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shikoo-admin-key': cfg.secret },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new SupportBotAdminError('unreachable');
  }
  if (!res.ok) throw new SupportBotAdminError(res.status >= 500 ? 'unreachable' : 'bad_answer');
  try {
    return await res.json();
  } catch {
    throw new SupportBotAdminError('bad_answer');
  }
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const got = schema.safeParse(value);
  if (!got.success) throw new SupportBotAdminError('bad_answer');
  return got.data;
}

export async function readSupportBot(cfg: SupportBotAdminConfig): Promise<BotRead> {
  const { cap, contacts, tickets } = parse(ReadAnswer, await call(cfg, { action: 'read' }));
  return { cap, contacts, tickets };
}

/** The chats that were found and handed back. The webhook takes at most 1,000 ids a call. */
export async function releaseSupportBotChats(cfg: SupportBotAdminConfig, chatIds: number[]): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < chatIds.length; i += 500) {
    const part = chatIds.slice(i, i + 500);
    try {
      out.push(...parse(ReleaseAnswer, await call(cfg, { action: 'release', chat_ids: part })).chat_ids);
    } catch (e) {
      if (out.length > 0 && e instanceof SupportBotAdminError) throw new SupportBotPartialRelease(e.code, out);
      throw e;
    }
  }
  return out;
}

export async function setSupportBotDailyCap(cfg: SupportBotAdminConfig, cap: number): Promise<number> {
  return parse(CapAnswer, await call(cfg, { action: 'set_cap', cap })).cap;
}
