/**
 * The two gates, judged against the shop that is running them right now.
 *
 * `apps/bot/src/gate.ts` is built entirely out of claims about the admin's own
 * database: that a rules gate exists and is switched on, that its switch spells
 * "on" as `rolleon`, that there is a channel to be a member of, and that the
 * channel row carries both a name for the button and a link for it to open. Not
 * one of those is a fact about our code, and a test written from our own
 * constants would agree with itself for ever.
 *
 * The token is carried across the cutover unchanged, so the customer gets no
 * announcement. Every one of these that we get wrong is, to them, the shop
 * silently changing its mind — which is why they are cutover blockers rather
 * than features.
 *
 * The dump is real customer data: gitignored, stays on this machine, and nothing
 * below prints a value from it that is not a switch word or a public @handle.
 *
 * CI has no MySQL and can never have this dump, so there this skips with a
 * warning. Anywhere else an unreachable database FAILS, because "sim is down"
 * and "the importer is broken" must not look the same.
 */

import { readFileSync } from 'node:fs';
import { createConnection } from 'mysql2/promise';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/db.js';

interface Channel {
  remark: string | null;
  link: string | null;
  linkjoin: string | null;
}

interface Loaded {
  rollStatus: string | null;
  notAccepted: number;
  channels: Channel[];
  unreachable: string | null;
}

async function load(): Promise<Loaded> {
  const cfg = loadConfig();
  const empty = { rollStatus: null, notAccepted: 0, channels: [] };
  try {
    const conn = await createConnection({
      ...cfg.mysql,
      charset: 'utf8mb4',
      dateStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    try {
      // COLLATE utf8mb4_bin, per the rule that cost a migration a day: MySQL's
      // default collation is case-insensitive, so `RollEon` and `rolleon` would
      // compare equal here and the bot — which compares in JavaScript — would
      // not turn the gate on at all.
      const [rollRows] = await conn.query(
        `SELECT roll_Status COLLATE utf8mb4_bin AS v FROM setting`,
      );
      const [pendingRows] = await conn.query(
        `SELECT COUNT(*) AS n FROM user WHERE roll_Status = 0`,
      );
      const [channelRows] = await conn.query(`SELECT remark, link, linkjoin FROM channels`);
      return {
        rollStatus: (rollRows as { v: string | null }[])[0]?.v ?? null,
        notAccepted: Number((pendingRows as { n: number }[])[0]?.n ?? 0),
        channels: channelRows as Channel[],
        unreachable: null,
      };
    } finally {
      await conn.end();
    }
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    if (process.env['CI'] !== 'true') throw error;
    console.warn(`[gates.mysql] skipped: simulation MySQL unreachable — ${why}`);
    return { ...empty, unreachable: why };
  }
}

const { rollStatus, notAccepted, channels, unreachable } = await load();

describe.skipIf(unreachable !== null)('the rules gate', () => {
  it('spells "on" exactly as `settings.ts` compares against', () => {
    // `requiresRules` is `text('roll_Status') === 'rolleon'` — an equality, not
    // an "is not the off word". A spelling that drifted here leaves the gate
    // silently off and 963 customers walk past a screen the live bot shows them.
    expect(rollStatus).toBe('rolleon');
  });

  it('is switched on, which is the only reason the bot needs one', () => {
    // Not a tautology with the assertion above. That one pins the spelling; this
    // one records the state we are building to match. A shop that turns the gate
    // off makes this go red and somebody reads why the code is still there.
    expect(rollStatus).not.toBe('rolloff');
  });

  it('still has customers behind it, so the gate is not decorative', () => {
    // These are the people who see the rules screen on their very first message
    // after the cutover. If this ever reaches zero the gate costs nothing to
    // keep and nothing to drop, and the decision becomes free rather than owed.
    expect(notAccepted).toBeGreaterThan(0);
  });

  it('is read out of a column named after what it means', () => {
    // `roll_Status` was being imported into `users.notify_enabled`, the column
    // gating both expiry warnings. `customer-columns.mysql.test.ts` owns that
    // proof; repeated here only as the link, because this is the file that
    // explains what the value IS.
    const source = readFileSync(new URL('../src/migrate.ts', import.meta.url), 'utf8');
    expect(source).toContain("'rules_accepted'");
  });
});

describe.skipIf(unreachable !== null)('the channel gate', () => {
  it('has a channel to be a member of', () => {
    // Zero rows means the gate is inert by design — `gate.ts` returns "through"
    // without an API call. That is correct behaviour and the wrong state to ship
    // into, because the live bot is gating on this row today.
    expect(channels.length).toBeGreaterThan(0);
  });

  it('gives every channel both a name for the button and a link for it to open', () => {
    // `index.php:430` skips a channel missing either, so the live bot would
    // check membership of a chat the customer is given no way to join — a locked
    // door with no handle. Ours builds the button from `title` and `join_link`
    // and the importer defaults both from `link`, so the screen is never empty;
    // this asserts the data does not need that fallback.
    for (const channel of channels) {
      expect(channel.link, 'chat_ref').toBeTruthy();
      expect(channel.remark, `remark for ${channel.link}`).toBeTruthy();
      expect(channel.linkjoin, `linkjoin for ${channel.link}`).toBeTruthy();
    }
  });

  it('identifies each chat in a form Telegram accepts as a chat_id', () => {
    // `getChatMember` takes `@username` or a numeric `-100…` id and nothing
    // else. A `t.me/…` URL in this column reaches Telegram as a chat that does
    // not exist, we fail open on the error, and the gate is silently inert.
    //
    // SHAPE IS NOT EXISTENCE, and this assertion only buys the first half. A
    // syntactically perfect `@handle` for a channel that was renamed, or one
    // the bot was never made an admin of, passes here and then errors on every
    // call — and because the gate fails open, the shop looks exactly like a
    // shop where everybody is already a member.
    //
    // Nothing reachable from this file can close that gap: a test here has no
    // token and must not have one. The check that does is one `getChatMember`
    // with the production token, which is an operator's job before the cutover.
    // It is written down in the report rather than pretended at here.
    for (const channel of channels) {
      expect(channel.link, `chat_ref ${channel.link}`).toMatch(/^(@[A-Za-z0-9_]{4,}|-100\d+)$/);
    }
  });

  it('gives the button a link a customer can actually open', () => {
    for (const channel of channels) {
      expect(channel.linkjoin, `join link for ${channel.link}`).toMatch(/^https?:\/\//i);
    }
  });
});
