/**
 * The QR code, checked by reading it back — not by trusting the encoder.
 *
 * "It returns a PNG of the right size" proves the library ran. It does not
 * prove a phone can scan the picture, and that is the only property that
 * matters: a customer points a camera at it and their VPN app receives the
 * subscription link. So the bytes go through a *different* library's decoder,
 * the way a scanner would (rule 6 — measure against outside truth, never
 * against the code under test).
 */

import { describe, expect, it } from 'vitest';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { qrPng } from '../src/qr.js';
import { qrMenu } from '../src/menu.js';
import { MAX_COPY_TEXT_LENGTH } from '../src/telegram.js';
import { decode as decodeCallback } from '../src/callback.js';

/** The bytes as a scanner sees them: one RGBA quadruple per pixel. */
function decode(png: Buffer): string | null {
  const img = PNG.sync.read(png);
  return jsQR(new Uint8ClampedArray(img.data), img.width, img.height)?.data ?? null;
}

describe('qrPng', () => {
  it('encodes a subscription link a scanner can read back', async () => {
    // A real one from the test panel, token and all — the length is the point.
    const url =
      'https://pasa.fallumi.ir/sub/djMsOSwxNzg3MTM1MjE1.JPOI1ANZmAbZ2xDGHPEGZbXNYrWmfpWlqj5pTAt-JLg';
    expect(decode(await qrPng(url))).toBe(url);
  });

  it('survives a link long enough to need a dense code', async () => {
    // Longer than any panel produces today, so the version bump is exercised
    // before a panel changes its token format and finds it in production.
    const url = `https://panel.example.com/sub/${'a1B2c3D4'.repeat(24)}`;
    expect(decode(await qrPng(url))).toBe(url);
  });

  it('is a PNG', async () => {
    // Telegram decides what it received from the bytes, not from the filename.
    expect((await qrPng('x')).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('proves the decoder is doing work — a blank image reads as nothing', async () => {
    // Without this, a decoder that returned its input would pass every test above.
    const blank = new PNG({ width: 64, height: 64 });
    blank.data.fill(0xff);
    expect(decode(PNG.sync.write(blank))).toBeNull();
  });
});

/**
 * The keyboard under the picture.
 *
 * The QR is sent as a NEW message rather than an edit — on purpose, so the
 * service screen it came from stays put — which means that screen is now
 * somewhere above it in the chat. Until this row existed the only way back was
 * scrolling.
 */
describe('the keyboard under a QR', () => {
  const link = 'https://panel.example.com/sub/abc123';

  it('offers the link and a way back to the service', () => {
    const rows = qrMenu(link, 77);
    expect(rows).toHaveLength(2);
    expect(rows[0]![0]!.copy_text).toEqual({ text: link });
    expect(decodeCallback(rows[1]![0]!.callback_data)).toEqual({ action: 'sub', id: 77 });
  });

  it('keeps the way back when the link is too long to copy', () => {
    // `copyLinkMenu` gives up above Telegram's 256-character cap for
    // `copy_text`. The exit must not go with it — a customer whose panel emits
    // a very long link is exactly the one who cannot scroll back past a QR.
    const rows = qrMenu('https://x/'.padEnd(MAX_COPY_TEXT_LENGTH + 1, 'y'), 78);
    expect(rows).toHaveLength(1);
    expect(decodeCallback(rows[0]![0]!.callback_data)).toEqual({ action: 'sub', id: 78 });
  });
});
