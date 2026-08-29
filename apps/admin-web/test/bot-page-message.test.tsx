/**
 * The bot screen must say WHICH key fault it hit, not just that there was one.
 *
 * `secret_key_missing` is sent for three different mistakes — the variable is
 * unset, it is not hex, it is not 64 characters — and the screen used to answer
 * all three with «تنظیم نشده». On 2026-08-29 that sent an operator to set a
 * variable that was, in one of those three cases, already set. The server's
 * `detail` had the answer the whole time and the screen threw it away.
 *
 * The outside truth here is `SecretKeyMissing` in `packages/domain`: these are
 * its own sentences, copied from it, not sentences invented for a test.
 */

import { describe, expect, it } from 'vitest';
import { ApiError } from '../src/api.js';
import { message } from '../src/pages/BotPage.js';

/** Exactly what `panelSecretKey()` throws, for each of its three exits. */
const FAULTS = [
  'PANEL_SECRET_KEY is not set — generate one with `openssl rand -hex 32`',
  'PANEL_SECRET_KEY must be 64 hex characters (32 bytes); got 63',
  'PANEL_SECRET_KEY did not decode to 32 bytes',
];

describe('the key-fault message', () => {
  it('carries the server’s own sentence, so the three faults read differently', () => {
    const said = FAULTS.map((detail) => message(new ApiError(503, 'secret_key_missing', detail)));

    for (const [i, text] of said.entries()) expect(text).toContain(FAULTS[i]!);
    // The point of the fix: three inputs, three distinct sentences.
    expect(new Set(said).size).toBe(3);
  });

  it('still says something Persian and useful when the server sent no detail', () => {
    const text = message(new ApiError(503, 'secret_key_missing', null));
    expect(text).toContain('PANEL_SECRET_KEY');
    expect(text).toMatch(/[؀-ۿ]/);
    expect(text).not.toContain('null');
  });

  it('leaves the other codes alone', () => {
    expect(message(new ApiError(403, 'forbidden', null))).toContain('مدیر');
    // A code with its own Persian sentence from the server is passed through.
    expect(message(new ApiError(400, 'bad_shape', 'شکل توکن درست نیست.'))).toBe(
      'شکل توکن درست نیست.',
    );
  });
});
