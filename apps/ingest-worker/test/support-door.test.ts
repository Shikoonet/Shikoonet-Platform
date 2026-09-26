/**
 * The support bot's door: what it refuses before it reads anything, and the
 * rules question. The trial and server questions have their own files.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RateLimit } from '@shikoo/domain';
import { app, type Env } from '../src/index.js';
import { env } from './helpers/env.js';

const TOKEN = 'support-test-token-that-is-long-enough-000';
const BASE = 'https://example.com/api/v1/integrations/support';

/** Written out so a test may pass an explicit `undefined` to unset one binding. */
type EnvPatch = { [K in keyof Env]?: Env[K] | undefined };

async function call(
  path: string,
  body: unknown,
  opts: { token?: string | null; env?: EnvPatch; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (opts.token !== null) headers['Authorization'] = `Bearer ${opts.token ?? TOKEN}`;
  return await app.fetch(
    new Request(`${BASE}${path}`, {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    {
      ...env,
      SUPPORT_INTEGRATION_ENABLED: 'true',
      SUPPORT_INTEGRATION_TOKEN: TOKEN,
      ...opts.env,
    } as Env,
  );
}

describe('the support door refuses before it reads anything', () => {
  it('does not exist while switched off', async () => {
    const res = await call('/rules', {}, { env: { SUPPORT_INTEGRATION_ENABLED: 'false' } });
    expect(res.status).toBe(404);
  });
  it('says it is not configured when on without a token', async () => {
    const res = await call('/rules', {}, { env: { SUPPORT_INTEGRATION_TOKEN: undefined } });
    expect(res.status).toBe(503);
  });
  it('refuses no header, a wrong token, and a token of another length', async () => {
    expect((await call('/rules', {}, { token: null })).status).toBe(401);
    expect((await call('/rules', {}, { token: TOKEN.replace(/0$/, '1') })).status).toBe(401);
    expect((await call('/rules', {}, { token: 'short' })).status).toBe(401);
  });
  it('refuses a body over two kilobytes', async () => {
    const res = await call('/rules', JSON.stringify({ pad: 'x'.repeat(3000) }));
    expect(res.status).toBe(413);
  });
  it('does not let a caller without the token spend the support bot’s bucket', async () => {
    // Security review, 2026-09-26: the bucket was charged before the token was
    // checked, so sixty requests a minute from anybody locked n8n out.
    let charged = 0;
    const counting: RateLimit = {
      limit: async () => {
        charged += 1;
        return { success: true };
      },
    };
    for (let i = 0; i < 3; i += 1) {
      expect((await call('/rules', {}, { token: 'guess', env: { SUPPORT_LIMIT: counting } })).status).toBe(401);
    }
    expect(charged).toBe(0);
    expect((await call('/rules', {}, { env: { SUPPORT_LIMIT: counting } })).status).toBe(200);
    expect(charged).toBe(1);
  });

  it('slows a token guesser by address, and only a guesser', async () => {
    const no: RateLimit = { limit: async () => ({ success: false }) };
    const guesser = {
      token: 'guess',
      headers: { 'X-Real-IP': '203.0.113.9' },
      env: { IP_LIMIT: no, TRUSTED_PROXY_IP_HEADER: 'X-Real-IP' },
    };
    expect((await call('/rules', {}, guesser)).status).toBe(429);
    expect((await call('/rules', {}, { ...guesser, token: TOKEN })).status).toBe(200);
  });

  it('answers 429 when its limiter says no', async () => {
    const no: RateLimit = { limit: async () => ({ success: false }) };
    expect((await call('/rules', {}, { env: { SUPPORT_LIMIT: no } })).status).toBe(429);
  });
});

describe('«قوانین»', () => {
  let saved: { gate: string | null; text: string | null };
  beforeAll(async () => {
    const gate = await env.DB.prepare(
      `SELECT value #>> '{}' AS v FROM settings WHERE scope = 'bot' AND key = 'roll_Status'`,
    ).first<{ v: string | null }>();
    const text = await env.DB.prepare(`SELECT value FROM bot_texts WHERE key = 'GATE_RULES'`).first<{
      value: string;
    }>();
    saved = { gate: gate?.v ?? null, text: text?.value ?? null };
  });
  async function setGate(value: string | null): Promise<void> {
    await env.DB.prepare(`DELETE FROM settings WHERE scope = 'bot' AND key = 'roll_Status'`).run();
    if (value !== null) {
      await env.DB.prepare(
        `INSERT INTO settings (scope, key, value) VALUES ('bot', 'roll_Status', to_jsonb(?1::text))`,
      )
        .bind(value)
        .run();
    }
  }
  async function setText(value: string | null): Promise<void> {
    await env.DB.prepare(`DELETE FROM bot_texts WHERE key = 'GATE_RULES'`).run();
    if (value !== null) {
      await env.DB.prepare(`INSERT INTO bot_texts (key, value) VALUES ('GATE_RULES', ?1)`)
        .bind(value)
        .run();
    }
  }
  afterEach(async () => {
    await setGate(null);
    await setText(null);
  });
  afterAll(async () => {
    await setGate(saved.gate);
    await setText(saved.text);
  });

  it('is off with no text when nothing was set', async () => {
    const json = await (await call('/rules', {})).json();
    expect(json).toEqual({ ok: true, enabled: false, text: null });
  });
  it('returns the text an admin wrote, and says whether the gate is on', async () => {
    await setGate('rolleon');
    await setText('📜 قوانین فروشگاه\n\nفروش فقط از ربات.');
    const json = await (await call('/rules', {})).json();
    expect(json).toEqual({ ok: true, enabled: true, text: '📜 قوانین فروشگاه\n\nفروش فقط از ربات.' });
  });
  it('treats the code’s placeholder as «no rules written»', async () => {
    await setGate('rolleon');
    const json = await (await call('/rules', {})).json();
    expect(json).toEqual({ ok: true, enabled: true, text: null });
  });
});

describe('who is asking', () => {
  const BAD_PERSON: [unknown][] = [
    [{ telegram_id: '123' }],
    [{ telegram_id: 1.5 }],
    [{ telegram_id: 0 }],
    [{ telegram_id: 5, extra: true }],
    ['not json'],
  ];
  it.each(BAD_PERSON)('/servers refuses %j before any lookup', async (body) => {
    const res = await call('/servers', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_body' });
  });
  it.each(BAD_PERSON)('/trial/options refuses %j before any lookup', async (body) => {
    const res = await call('/trial/options', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_body' });
  });
  it.each([
    [{ telegram_id: 5 }],
    [{ telegram_id: 5, panel_id: '7' }],
    [{ telegram_id: 5, panel_id: 7.5 }],
    [{ telegram_id: '5', panel_id: 7 }],
    [{ telegram_id: 5, panel_id: 7, extra: true }],
    ['not json'],
  ])('/trial refuses %j before any lookup', async (body) => {
    const res = await call('/trial', body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: 'invalid_body' });
  });
});

describe('«پرسش و پاسخ»', () => {
  // What the panel's «پرسش و پاسخ پشتیبانی» holds is what the bot is handed:
  // only visible rows, in the panel's order, numbered into one block.
  const PREFIX = 'zz-kb-';
  const add = (question: string, sortOrder: number, active = true) =>
    env.DB.prepare(
      `INSERT INTO support_answers (question, answer, sort_order, active) VALUES (?1, ?2, ?3, ?4)`,
    )
      .bind(`${PREFIX}${question}`, `جواب ${question}`, sortOrder, active)
      .run();
  const purge = () =>
    env.DB.prepare(`DELETE FROM support_answers WHERE question LIKE ?1`).bind(`${PREFIX}%`).run();
  afterEach(purge);
  afterAll(purge);

  it('hands over the visible answers in the panel’s order, and never a hidden one', async () => {
    await add('second', 9991);
    await add('hidden', 9990, false);
    await add('first', 9990);

    const res = await call('/kb', {});
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; count: number; text: string };
    const visible = await env.DB.prepare(`SELECT count(*)::int AS n FROM support_answers WHERE active`).first<{
      n: number;
    }>();

    expect(body.count).toBe(visible!.n);
    expect(body.text.endsWith(
      `${body.count - 1}) ${PREFIX}first\nجواب first\n\n${body.count}) ${PREFIX}second\nجواب second`,
    )).toBe(true);
    expect(body.text).not.toContain(`${PREFIX}hidden`);
  });

  it('is behind the same token as every other question', async () => {
    expect((await call('/kb', {}, { token: null })).status).toBe(401);
  });
});

describe('«پرسش و پاسخ»: the index and the answers the bot picks from it', () => {
  // The bot reads every question with a few customer phrasings, picks the
  // numbers that fit, and asks for only those answers. A row marked «به همکار
  // بسپار» comes back as an instruction to pass the customer on, not as text.
  const PREFIX = 'zz-kbi-';
  const add = async (
    label: string,
    opts: { active?: boolean; handOff?: boolean; variants?: string } = {},
  ): Promise<number> => {
    const row = await env.DB.prepare(
      `INSERT INTO support_answers (question, answer, variants, hand_off, sort_order, active)
       VALUES (?1, ?2, ?3, ?4, 9990, ?5) RETURNING id`,
    )
      .bind(`${PREFIX}${label}`, `جواب ${label}`, opts.variants ?? '', opts.handOff ?? false, opts.active ?? true)
      .first<{ id: number }>();
    return Number(row!.id);
  };
  const purge = () =>
    env.DB.prepare(`DELETE FROM support_answers WHERE question LIKE ?1`).bind(`${PREFIX}%`).run();
  afterEach(purge);
  afterAll(purge);

  it('lists visible questions with their number and at most three phrasings', async () => {
    const shown = await add('shown', { variants: 'یک\nدو\n\nسه\nچهار' });
    await add('hidden', { active: false });

    const body = (await (await call('/kb/index', {})).json()) as { ok: boolean; text: string };
    expect(body.text).toContain(`#${shown} ${PREFIX}shown (یا: یک | دو | سه)`);
    expect(body.text).not.toContain('چهار');
    expect(body.text).not.toContain(`${PREFIX}hidden`);
  });

  it('returns the answers asked for, in that order, a hand-off as an instruction, never a hidden one', async () => {
    const a = await add('a');
    const b = await add('b', { handOff: true });
    const hidden = await add('h', { active: false });

    const res = await call('/kb/answers', { ids: [b, hidden, a] });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { count: number; text: string };
    expect(body.count).toBe(2);
    expect(body.text).toBe(
      `#${b} ${PREFIX}b\n[به همکار بسپار] این مورد را فقط همکار انجام می‌دهد؛ فقط ESCALATE بنویس.\n\n#${a} ${PREFIX}a\nجواب a`,
    );
    expect(body.text).not.toContain('جواب b');
  });

  it('refuses a body that is not a short list of numbers', async () => {
    expect((await call('/kb/answers', { ids: ['1'] })).status).toBe(400);
    expect((await call('/kb/answers', { ids: [1, 2, 3, 4, 5, 6, 7, 8, 9] })).status).toBe(400);
    expect((await call('/kb/answers', { ids: [1], extra: true })).status).toBe(400);
    expect(await (await call('/kb/answers', { ids: [] })).json()).toEqual({ ok: true, count: 0, text: '' });
  });
});
