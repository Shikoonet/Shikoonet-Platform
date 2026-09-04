/**
 * The link an operator has in their clipboard, turned into what Telegram's API
 * takes.
 *
 * `https://t.me/shikoonet/137` is the whole input to this feature: it is what
 * the «کپی لینک پست» button in Telegram produces, and Sam sent exactly that
 * shape when he asked for it. `forwardMessage` does not take a URL — it takes
 * `from_chat_id` and `message_id` — so something has to sit between them, and
 * this is that something.
 *
 * It lives in `@shikoo/contracts` rather than in either app because BOTH ends
 * need it: the page parses to show the operator what it understood before they
 * commit, and the route parses again because a browser is not a trust boundary.
 * Two parsers that agree today is how a link starts meaning two different posts.
 *
 * The refusals matter more than the acceptances here. A link this function
 * accepted wrongly does not fail loudly — it forwards SOME OTHER message to
 * every customer the shop has.
 */

import { describe, expect, it } from 'vitest';
import { parseChannelPostLink } from '../src/index.js';

describe('a channel post link', () => {
  it('reads the link Telegram’s own «copy link» produces', () => {
    expect(parseChannelPostLink('https://t.me/shikoonet/137')).toEqual({
      chat: '@shikoonet',
      messageId: 137,
    });
  });

  it('does not mind the scheme, the host alias, or a trailing slash', () => {
    for (const link of [
      't.me/shikoonet/137',
      'http://t.me/shikoonet/137',
      'https://telegram.me/shikoonet/137',
      'https://t.me/shikoonet/137/',
      '  https://t.me/shikoonet/137  ',
    ]) {
      expect(parseChannelPostLink(link), link).toEqual({ chat: '@shikoonet', messageId: 137 });
    }
  });

  /**
   * Telegram appends these itself. `?single` comes from copying one photo out
   * of an album, and `?comment=` from copying a link inside the discussion
   * group — both name the same post, and both are what an operator will paste.
   */
  it('ignores what Telegram appends to its own links', () => {
    expect(parseChannelPostLink('https://t.me/shikoonet/137?single')).toEqual({
      chat: '@shikoonet',
      messageId: 137,
    });
    expect(parseChannelPostLink('https://t.me/shikoonet/137?comment=9')).toEqual({
      chat: '@shikoonet',
      messageId: 137,
    });
  });

  /**
   * A private channel has no username, so its link carries the internal id and
   * the `-100` prefix is what turns it back into a `chat_id`. Sam's shop channel
   * is public today; the channel he announces from tomorrow may not be.
   */
  it('turns a private channel link back into a -100 chat id', () => {
    expect(parseChannelPostLink('https://t.me/c/1234567890/137')).toEqual({
      chat: '-1001234567890',
      messageId: 137,
    });
  });

  /** A post inside a forum topic: the LAST number is the message. */
  it('takes the message id from a topic link, not the topic id', () => {
    expect(parseChannelPostLink('https://t.me/shikoonet/12/137')).toEqual({
      chat: '@shikoonet',
      messageId: 137,
    });
  });

  /** `t.me/s/<channel>` is the web preview of the same post. */
  it('reads the web-preview form', () => {
    expect(parseChannelPostLink('https://t.me/s/shikoonet/137')).toEqual({
      chat: '@shikoonet',
      messageId: 137,
    });
  });

  it('refuses everything that is not one', () => {
    for (const link of [
      '',
      '   ',
      'https://t.me/shikoonet', // the channel, not a post in it
      'https://t.me/shikoonet/0', // message ids start at 1
      'https://t.me/shikoonet/-3',
      'https://t.me/shikoonet/abc',
      'https://t.me/joinchat/AAAAAE', // an invite, not a post
      'https://t.me/+AbCdEf', // the same thing, newer spelling
      'https://t.me/c/1234567890', // a private channel with no message named
      'https://example.com/shikoonet/137', // not Telegram at all
      'https://t.me.evil.example/shikoonet/137', // and not Telegram either
      '@shikoonet 137',
      'https://t.me/ab/137', // a username too short to be one
      'https://t.me/shikoonet/99999999999999', // past anything Telegram issues
    ]) {
      expect(parseChannelPostLink(link), link).toBeNull();
    }
  });
});
