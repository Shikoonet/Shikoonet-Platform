/**
 * The copy that has to work on the machine you are debugging from.
 *
 * `navigator.clipboard` exists only in a secure context. The panel is TLS at
 * the edge and plain http when it is opened directly on the box —
 * `http://164.132.198.184:8788` — and there the API is not a rejected promise,
 * it is `undefined`. That is the case this file is about, because it is the one
 * nobody would notice: the button would throw into a `catch`, say nothing, and
 * the admin would paste whatever was on the clipboard before.
 *
 * Every assertion is on what came out the other side, and the failure paths are
 * exercised rather than described.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { copyText } from '../src/clipboard.js';

const original = navigator.clipboard;

function setClipboard(value: unknown): void {
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true, writable: true });
}

afterEach(() => {
  setClipboard(original);
  vi.restoreAllMocks();
});

describe('copyText', () => {
  it('uses the modern API when it is there', async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard({ writeText });

    expect(await copyText('{"evt":"provision.failed"}')).toBe(true);
    expect(writeText).toHaveBeenCalledWith('{"evt":"provision.failed"}');
  });

  it('falls back when the API is missing, which is what plain http gives', async () => {
    setClipboard(undefined);
    const exec = vi.fn(() => true);
    // jsdom has no `execCommand` at all, so this is also the assertion that the
    // fallback reaches for the right thing.
    (document as unknown as { execCommand: () => boolean }).execCommand = exec;

    expect(await copyText('fallback text')).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    // The textarea is removed again. One left behind per press is a growing
    // pile of invisible inputs in a page that is open all day.
    expect(document.querySelectorAll('textarea')).toHaveLength(0);
  });

  it('falls back when the API is there and refuses', async () => {
    setClipboard({
      writeText: vi.fn(async () => {
        throw new Error('NotAllowedError');
      }),
    });
    const exec = vi.fn(() => true);
    (document as unknown as { execCommand: () => boolean }).execCommand = exec;

    expect(await copyText('after a refusal')).toBe(true);
    expect(exec).toHaveBeenCalledOnce();
  });

  it('says false when nothing worked, so the button can say so too', async () => {
    setClipboard(undefined);
    (document as unknown as { execCommand: () => boolean }).execCommand = () => false;

    expect(await copyText('nowhere to go')).toBe(false);
  });
});
