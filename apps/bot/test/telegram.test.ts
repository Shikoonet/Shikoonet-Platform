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

describe('sendMessage', () => {
  it('posts the chat id and text', async () => {
    const { api, calls } = apiWith(() => ok(true));
    await api.sendMessage(42, 'سلام');
    expect(calls[0]?.url).toContain('/sendMessage');
    expect(calls[0]?.body).toEqual({ chat_id: 42, text: 'سلام' });
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
