import { describe, expect, it, vi } from 'vitest';
import { createTelegramApi } from '../src/telegram.js';

const TOKEN = '123456:AA-secret-token-value';

function apiWith(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; body: unknown }[] = [];
  const api = createTelegramApi({
    token: TOKEN,
    baseUrl: 'http://fake.invalid',
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return responder(url, init);
    },
  });
  return { api, calls };
}

function ok(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), {
    headers: { 'content-type': 'application/json' },
  });
}

/** Fails the test if the call did NOT reject — a silent pass is worse than none. */
async function errorFrom(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error('expected the call to reject, it resolved');
}

describe('getUpdates', () => {
  it('reads a normal message update', async () => {
    const { api, calls } = apiWith(() =>
      ok([
        {
          update_id: 11,
          message: {
            message_id: 3,
            from: { id: 42, username: 'sam', language_code: 'fa' },
            chat: { id: 42 },
            text: '/start',
          },
        },
      ]),
    );

    const updates = await api.getUpdates(10, 25);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.update_id).toBe(11);
    expect(updates[0]?.message?.text).toBe('/start');
    expect(calls[0]?.body).toMatchObject({ offset: 10, timeout: 25 });
  });

  it('keeps an update whose message is malformed instead of wedging the poller', async () => {
    // If this threw, Telegram would redeliver the same broken update forever and
    // every update queued behind it would never be seen.
    const { api } = apiWith(() =>
      ok([{ update_id: 12, message: { message_id: 'not-a-number', chat: {} } }]),
    );

    const updates = await api.getUpdates(0, 1);

    expect(updates).toHaveLength(1);
    expect(updates[0]?.update_id).toBe(12);
    expect(updates[0]?.message).toBeUndefined();
  });

  it('drops an element with no usable update_id, and says so', async () => {
    // The witness is the structured line, not `console.error`. Dropping an
    // update is the one thing here that loses a customer's action, so it has
    // to leave something a person can find later — which since 2026-08-22
    // means a row in `app_events`, not a string in a container that gets
    // replaced on the next deploy.
    const lines: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      lines.push(String(chunk));
      return true;
    });
    const { api } = apiWith(() => ok([{ nonsense: true }, { update_id: 13 }]));

    const updates = await api.getUpdates(0, 1);
    out.mockRestore();

    expect(updates.map((u) => u.update_id)).toEqual([13]);
    const said = lines.map((l) => JSON.parse(l) as { evt: string; level: string });
    expect(said.filter((l) => l.evt === 'telegram.update_without_id')).toHaveLength(1);
    expect(said[0]?.level).toBe('error');
  });

  it('ignores update kinds it does not handle', async () => {
    const { api } = apiWith(() => ok([{ update_id: 14, callback_query: { id: 'x' } }]));
    const updates = await api.getUpdates(0, 1);
    expect(updates[0]?.message).toBeUndefined();
  });

  it('rejects a result that is not a list', async () => {
    const { api } = apiWith(() => ok({ not: 'a list' }));
    await expect(api.getUpdates(0, 1)).rejects.toThrow('did not return a list');
  });
});

describe('the token never leaks', () => {
  it('is absent from an API rejection', async () => {
    const { api } = apiWith(
      () =>
        new Response(JSON.stringify({ ok: false, description: `bad token ${TOKEN}` }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    const error = await errorFrom(api.getUpdates(0, 1));
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('<token>');
  });

  it('is absent from a network failure', async () => {
    const { api } = apiWith(() => {
      throw new Error(`connect ECONNREFUSED http://fake.invalid/bot${TOKEN}/getUpdates`);
    });
    const error = await errorFrom(api.getUpdates(0, 1));
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('<token>');
  });

  it('is absent from a non-JSON response error', async () => {
    const { api } = apiWith(() => new Response('<html>502</html>', { status: 502 }));
    const error = await errorFrom(api.getUpdates(0, 1));
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('502');
  });
});

describe('sendMessage into a forum topic', () => {
  /**
   * The report topics, at the only place that decides what Telegram receives.
   *
   * `notify.ts` passes the column through and `report-topics.test.ts` proves
   * that; this is the half that matters on the day the feature ships, when
   * every shop has a reports group and no topics yet. Telegram answers 400 to
   * `message_thread_id: 0`, and the message carrying it would be a report about
   * an order somebody has already paid for.
   *
   * Legacy strips the field on the same condition — `botapi.php:10` — which is
   * why zero is the value both the importer and migration 0049 seed.
   */
  it('sends the field for a real topic', async () => {
    const { api, calls } = apiWith(() => ok({}));
    await api.sendMessage(-1_001_555_000, 'گزارش', undefined, 91);
    expect(calls[0]?.body).toMatchObject({ message_thread_id: 91 });
  });

  for (const [label, value] of [
    ['zero, the unconfigured sentinel', 0],
    ['negative, faoxima’s poison marker', -1],
    ['null', null],
    ['absent', undefined],
  ] as const) {
    it(`omits the field entirely for ${label}`, async () => {
      const { api, calls } = apiWith(() => ok({}));
      await api.sendMessage(-1_001_555_000, 'گزارش', undefined, value);
      expect(calls[0]?.body).not.toHaveProperty('message_thread_id');
    });
  }
});

describe('sendMessage', () => {
  it('posts the chat id and text', async () => {
    const { api, calls } = apiWith(() => ok(true));
    await api.sendMessage(42, 'سلام');
    expect(calls[0]?.url).toContain('/sendMessage');
    expect(calls[0]?.body).toEqual({ chat_id: 42, text: 'سلام' });
  });

  it('sends the navigation row as a persistent keyboard under the chat', async () => {
    const { api, calls } = apiWith(() => ok(true));
    await api.sendMessage(42, 'سلام', undefined, undefined, [
      [{ text: '🏠 بازگشت به منوی اصلی', style: 'primary' }],
    ]);

    expect(calls[0]?.body).toEqual({
      chat_id: 42,
      text: 'سلام',
      reply_markup: {
        keyboard: [[{ text: '🏠 بازگشت به منوی اصلی', style: 'primary' }]],
        resize_keyboard: true,
        is_persistent: true,
      },
    });
  });

  it('replaces the bottom keyboard without deleting its invisible carrier', async () => {
    const { api, calls } = apiWith(() => ok({ message_id: 771 }));

    await api.replaceReplyKeyboard?.(42, [[{ text: '↩️ برگشت', style: 'primary' }]]);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      url: expect.stringContaining('/sendMessage'),
      body: {
        chat_id: 42,
        text: '\u2063',
        disable_notification: true,
        reply_markup: {
          keyboard: [[{ text: '↩️ برگشت', style: 'primary' }]],
          resize_keyboard: true,
          is_persistent: true,
        },
      },
    });
  });

  it('throws when Telegram rejects it', async () => {
    const { api } = apiWith(
      () =>
        new Response(JSON.stringify({ ok: false, description: 'chat not found' }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(api.sendMessage(42, 'hi')).rejects.toThrow('chat not found');
  });
});

describe('a button label that starts with a number', () => {
  /**
   * Measured in the real client on 2026-08-23, then in the browser's own bidi
   * engine: Telegram lays inline-button labels out LEFT-TO-RIGHT — the button
   * resolves to `direction: ltr`, `unicode-bidi: normal`, no `dir` attribute.
   * So a label whose first character is a digit has no strong character to
   * anchor it, the digit resolves left-to-right, and it is drawn at the far end
   * of the button away from the word it belongs to:
   *
   *     sent      ۳۰ گیگ - یک‌ماهه — 150,000 تومان
   *     drawn     ۳۰ | تومان 150,000 — یک‌ماهه - گیگ
   *
   * Asserted on the PAYLOAD, not on what a menu function returned: the string
   * we compose is right either way, and the whole defect is what happens to it
   * afterwards.
   */
  const RLM = '‏';

  it('is anchored so the number stays with its word', async () => {
    const { api, calls } = apiWith(() => ok(true));
    await api.sendMessage(42, 'x', [[{ text: '۳۰ گیگ - یک‌ماهه — 150,000 تومان', callback_data: 'plan:1' }]]);
    const sent = (calls[0]?.body as { reply_markup: { inline_keyboard: { text: string }[][] } })
      .reply_markup.inline_keyboard[0]![0]!.text;
    expect(sent).toBe(`${RLM}۳۰ گیگ - یک‌ماهه — 150,000 تومان`);
  });

  it('anchors an ASCII-digit name too — the shop has both', async () => {
    // «10 گیگ 30 روزه» is a real product on the test panel. Persian and ASCII
    // digits are different code blocks that look alike, and only one of them
    // being handled is the kind of half-fix nobody sees.
    const { api, calls } = apiWith(() => ok(true));
    await api.sendMessage(42, 'x', [[{ text: '10 گیگ 30 روزه', callback_data: 'prd:1' }]]);
    const sent = (calls[0]?.body as { reply_markup: { inline_keyboard: { text: string }[][] } })
      .reply_markup.inline_keyboard[0]![0]!.text;
    expect(sent).toBe(`${RLM}10 گیگ 30 روزه`);
  });

  it('leaves alone every label that already draws correctly', async () => {
    // An emoji-led label renders right as it is — a neutral takes the
    // paragraph's own direction and stays put — and anchoring it moves the
    // emoji to the far end instead. Measured, not assumed. A Persian-led label
    // and a digits-only one have nothing to anchor either.
    const { api, calls } = apiWith(() => ok(true));
    const untouched = ['🟢 پلاتینیوم — ۳۰ گیگ', 'سرویس تست — 123,000 تومان', '150,000', 'Back'];
    await api.sendMessage(
      42,
      'x',
      [untouched.map((text, i) => ({ text, callback_data: `x:${i}` }))],
    );
    const row = (calls[0]?.body as { reply_markup: { inline_keyboard: { text: string }[][] } })
      .reply_markup.inline_keyboard[0]!;
    expect(row.map((b) => b.text)).toEqual(untouched);
  });
});

describe('editMessageText', () => {
  it('sends the keyboard along with the new text', async () => {
    const { api, calls } = apiWith(() => ok(true));
    await api.editMessageText(42, 7, 'منو', [[{ text: 'خرید', callback_data: 'buy' }]]);
    expect(calls[0]?.url).toContain('/editMessageText');
    expect(calls[0]?.body).toEqual({
      chat_id: 42,
      message_id: 7,
      text: 'منو',
      reply_markup: { inline_keyboard: [[{ text: 'خرید', callback_data: 'buy' }]] },
    });
  });

  it('treats "message is not modified" as done, not as a failure', async () => {
    // What pressing the same button twice looks like. Found on the first live
    // run of the menu: two presses, two stack traces, nothing actually wrong.
    const { api } = apiWith(
      () =>
        new Response(
          JSON.stringify({
            ok: false,
            description:
              'Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message',
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    await expect(api.editMessageText(42, 7, 'منو')).resolves.toBeUndefined();
  });

  it('still throws for a real rejection', async () => {
    const { api } = apiWith(
      () =>
        new Response(JSON.stringify({ ok: false, description: 'message to edit not found' }), {
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(api.editMessageText(42, 7, 'منو')).rejects.toThrow('message to edit not found');
  });
});
