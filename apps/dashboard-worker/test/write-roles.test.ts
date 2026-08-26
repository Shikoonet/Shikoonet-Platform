/**
 * Who may WRITE, asked of the router rather than of a list.
 *
 * Two files said the same reassuring sentence — `access.ts:22` and the header of
 * `read-roles.test.ts` — "every write route on this surface is behind
 * `role !== 'ADMIN'`". Nothing checked it. There are 57 of those conditions and
 * 27 `role === 'READ_ONLY'` ones spread over sixteen files, and the failure mode
 * is not any of them being wrong: it is route 115 being added without one, in a
 * file whose other routes all have it, reviewed by somebody who has read that
 * sentence.
 *
 * This project has been bitten by exactly that shape before — a comment
 * explaining why something is safe, believed for months, and wrong. So the rule
 * is enumerated from `app.routes`, which is the router's own account of itself.
 * A new write route is covered the moment it is registered, and a new write
 * route with no guard fails here rather than in production.
 *
 * Consolidating the 84 conditions into one middleware was the other option and
 * is not obviously better: the rule is genuinely per-route (a REVIEWER approves
 * a match and may not touch the catalogue), so a middleware would need the same
 * 84 facts in a table, and the refactor would rewrite every route in the app to
 * change no behaviour. The check is the cheap half; the guards can stay where
 * the reader of a route can see them.
 */

import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { applySchema, env as baseEnv } from './helpers/env.js';
import { app } from '../src/index.js';

const READER = 'write-roles-reader@example.com';
const REVIEWER = 'write-roles-reviewer@example.com';

function envAs(email: string) {
  return { ...baseEnv, TEST_ACCESS_USER: email };
}

/**
 * Write routes a signed-in READ_ONLY operator is allowed to reach, each with the
 * reason it is not a hole. Adding a line here is the deliberate act; forgetting
 * a guard is not.
 */
const READ_ONLY_MAY = new Map<string, string>([
  // The door itself. It cannot be behind a role, and `logout` ending a session
  // is something every role must be able to do.
  ['POST /api/v1/auth/login', 'the sign-in itself'],
  ['POST /api/v1/auth/logout', 'ending your own session'],
  ['POST /api/v1/auth/password', 'changing your own password'],

  // Per-viewer read markers. These write a row about what THIS operator has
  // looked at; none of them changes anything about the shop, and a read-only
  // operator whose unread badge never clears would simply stop using it.
  ['POST /api/v1/notifications/mark-all-read', 'marks what this viewer has seen'],
  ['POST /api/v1/notifications/mark-read', 'marks what this viewer has seen'],
  [
    'POST /api/v1/notifications/transactions/:transactionId/seen',
    'marks what this viewer has seen',
  ],
  ['POST /api/v1/payments/events/:eventKey/seen', 'marks what this viewer has seen'],
  ['POST /api/v1/payments/tabs/read-all', 'marks what this viewer has seen'],

  // Reads wearing POST, because they take a body. Each one computes and returns;
  // none writes. They are the reason the sentence in `access.ts` was too strong
  // — "every write route is guarded" is true, and these are not writes.
  ['POST /api/v1/accounts/analyze', 'runs the parser over a pasted SMS, persists nothing'],
  ['POST /api/v1/accounts/:accountId/backfill-preview', 'counts what an assignment would move'],
  ['POST /api/v1/banks/test-card', 'tries a card number against the prefix table'],
  ['POST /api/v1/banks/test-sms', 'tries a body against the parser registry'],
  // A decision, recorded in docs/STATUS.md: preview for any operator, apply for
  // ADMIN only. The apply route two lines away in the same file is ADMIN-gated.
  ['POST /api/v1/admin/bulk/price/preview', 'previewing a price change is not making one'],
]);

/**
 * Admin-surface writes a REVIEWER may reach. One, for the reason above.
 */
const REVIEWER_MAY = new Set(['POST /api/v1/admin/bulk/price/preview']);

/** `:id` filled with something syntactically plausible — authorization has to
 *  answer before anything looks the id up, which is half of what is asserted. */
const fill = (p: string) => p.replace(/:[A-Za-z]+/g, '1');

function writeRoutes(): string[] {
  const rs = (app as unknown as { routes: { method: string; path: string }[] }).routes;
  return [
    ...new Set(
      rs
        .filter((r) => !['GET', 'HEAD', 'ALL'].includes(r.method))
        .map((r) => `${r.method} ${r.path}`),
    ),
  ].sort();
}

async function statusFor(entry: string, email: string): Promise<number> {
  const [method, path] = entry.split(' ') as [string, string];
  const res = await app.fetch(
    new Request(`https://example.com${fill(path)}`, {
      method,
      headers: { 'content-type': 'application/json', origin: 'https://example.com' },
      body: '{}',
    }),
    envAs(email),
  );
  return res.status;
}

beforeAll(applySchema);

beforeEach(async () => {
  const now = Date.now();
  for (const [email, role] of [
    [READER, 'READ_ONLY'],
    [REVIEWER, 'REVIEWER'],
  ] as const) {
    await baseEnv.DB.prepare(
      `INSERT INTO access_users (id, email, role, active, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)
       ON CONFLICT (email) DO UPDATE SET role = excluded.role, active = 1`,
    )
      .bind(crypto.randomUUID(), email, role, now)
      .run();
  }
});

afterAll(async () => {
  await baseEnv.DB.prepare(`DELETE FROM access_users WHERE email IN (?1, ?2)`)
    .bind(READER, REVIEWER)
    .run();
});

describe('every write route, asked directly', () => {
  it('refuses a READ_ONLY operator, or is on the list that says why not', async () => {
    const unguarded: string[] = [];
    for (const entry of writeRoutes()) {
      if (READ_ONLY_MAY.has(entry)) continue;
      const status = await statusFor(entry, READER);
      // 403 and nothing else. A 400 here would mean the body was parsed before
      // the role was consulted, which is a route with no guard answering the
      // way a guarded one does when you send it rubbish.
      if (status !== 403) unguarded.push(`${entry} → ${status}`);
    }
    expect(unguarded).toEqual([]);
  }, 60_000);

  it('keeps every admin-surface write for ADMIN, so a REVIEWER is a payments role', async () => {
    // The line the panel is built on: a REVIEWER decides on payments and does
    // not run the shop. Without this, `/api/v1/admin/products` and
    // `/api/v1/admin/access-users` would be open to whoever reviews claims.
    const leaked: string[] = [];
    for (const entry of writeRoutes()) {
      if (!entry.includes('/api/v1/admin/') || REVIEWER_MAY.has(entry)) continue;
      const status = await statusFor(entry, REVIEWER);
      if (status !== 403) leaked.push(`${entry} → ${status}`);
    }
    expect(leaked).toEqual([]);
  }, 60_000);

  it('lets a REVIEWER do the job a REVIEWER exists for', async () => {
    // The other direction, and the reason this file cannot simply demand 403
    // everywhere: a rule that refuses everyone passes the two tests above and
    // makes the panel useless.
    for (const entry of [
      'POST /api/v1/match/approve',
      'POST /api/v1/match/reject',
      'POST /api/v1/suspects/:claimId/approve',
      'POST /api/v1/suspects/:claimId/reject',
    ]) {
      const status = await statusFor(entry, REVIEWER);
      // Past the guard and into the body check — which is where an empty `{}`
      // belongs. Any 403 here means a payments operator cannot review payments.
      expect(`${entry} → ${status}`).toBe(`${entry} → 400`);
    }
  }, 30_000);

  it('has not grown a write route nobody has considered', async () => {
    // The count is the tripwire. A route added without a thought about roles
    // still has to pass the three tests above, but seeing this number move is
    // what makes somebody look.
    //
    // 114 → 117 on 2026-08-23, and the tripwire did its job: «مدیریت پنل‌ها»
    // gained `POST /panels`, `POST /panels/:id/credentials` and
    // `POST /panels/:id/test`, because a panel could not be added from the
    // dashboard at all before then. Two of the three write a CREDENTIAL, which
    // is the first time anything in this app has, so they were looked at hard:
    // all three are ADMIN-only, and the three tests above already proved they
    // refuse a READ_ONLY and a REVIEWER before this number was touched.
    //
    // 118 the same day: `POST /panels/:id/groups`. It decides which groups a
    // purchase puts the customer's account in — the `[42, 2]` the legacy shop
    // kept on its VIP panel row — so it is ADMIN-only for the same reason the
    // catalogue is.
    //
    // 121, still 2026-08-23: the three that write a group ON THE PANEL —
    // `POST /panels/:id/panel-groups`, `POST /panels/:id/panel-groups/:groupId`
    // and `DELETE /panels/:id/panel-groups/:groupId`. A group is the product
    // tier, so creating one is a catalogue decision, and deleting one reaches
    // past our database into somebody else's server and cannot be undone from
    // here. ADMIN-only, and the delete additionally refuses while any plan or
    // the panel itself still sends that group.
    //
    // `GET /panels/:id/inbounds` is not in this count and should not be: it
    // reads, and the three tests above only cover writes.
    //
    // 123, same day: `POST /panels/:id/hosts` and
    // `DELETE /panels/:id/hosts/:hostId`. A host is what puts an inbound into a
    // customer's subscription, so removing the last one on an inbound empties
    // every tier carrying it — silently, since the links keep working and stop
    // producing that config. ADMIN-only, and the delete refuses outright when a
    // group we sell would be stranded.
    // 122 on 2026-08-24, and this is the counter going DOWN, which it had never
    // done before: `POST /panels/:id/groups` was removed. It saved a
    // panel-level default group list that no purchase consulted — delivery
    // reads the tier through `groupIdsFor`, which never looks at that column —
    // so it was a write route that decided nothing, with a tick box in front of
    // it that an admin could save three times and change nothing at all.
    //
    // 124 on 2026-08-26, and one of the two is that same route coming back.
    // The sentence above is wrong and contradicts itself: `groupIdsFor` reads
    // the plan's attrs and then the PROVIDER CONFIG, and that column IS the
    // provider config. `provisioning.test.ts` has a green case named «the panel
    // default» that proves it against the body a fake panel received, and
    // moving `config.group_ids` by hand on the live box flipped
    // `panel:preflight` from failing to passing. What was really wrong was the
    // VALUE: every stored selection was `[]`, which is not nullish, so it beat
    // the panel underneath and sent `group_ids: []` — an account in no group,
    // with no inbounds, on a link that resolves and returns nothing. Ticking
    // nothing now deletes the key instead. ADMIN-only, for the same reason it
    // was the first time: it decides what a paying customer receives.
    //
    // The other is `DELETE /panels/:id`, which this screen has never had. It is
    // the most destructive route in this file and the only one whose guard had
    // to go INSIDE the statement: `subscriptions.provider_id` is
    // `ON DELETE SET NULL`, so a count-then-delete pair that lost the race
    // would not raise — it would silently strip the panel off every live
    // subscription and look like it worked.
    //
    // 125 on 2026-08-26: `POST /panels/:id/panel-groups/:groupId/move-members`.
    // It is the step that belongs in FRONT of the group delete two entries up.
    // Deleting a tier leaves its members' accounts alive and their subscription
    // links empty — a PasarGuard link is resolved when it is fetched, so nothing
    // breaks at the moment of deletion and every one of those customers quietly
    // stops receiving configs on their next refresh. ADMIN-only, and it is the
    // only write in this file that is not one request: it is one `PUT` per
    // member against somebody else's panel, so it reports how many actually
    // moved on the failure path too, and audits both outcomes.
    expect(writeRoutes().length).toBe(125);
  });
});
