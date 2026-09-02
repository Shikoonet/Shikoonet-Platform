/**
 * The migration. Ordered steps, each idempotent, all inside one transaction.
 *
 * Idempotency comes from the schema, not from bookkeeping here: every migrated
 * table carries the legacy natural key under a UNIQUE constraint, so every
 * insert can use `ON CONFLICT DO NOTHING` against that key. A run that dies
 * halfway is simply run again.
 *
 * Rows whose parent no longer exists are skipped and counted, never invented.
 * Production has 87 wheel spins, 19 referrals, 2 reseller requests and 1 order
 * belonging to deleted users.
 */

import type { Connection } from 'mysql2/promise';
import type pg from 'pg';
import { correctCardDigits } from './corrections.js';
import { d1Table, insertBatch, mysqlRows, report, type Column, type Config } from './db.js';
import * as t from './transform.js';
import { beginUndo, captureUndo, claimImportLock } from './undo.js';

/**
 * One legacy row, in the types mysql2 actually hands back.
 *
 * This said `Record<string, string | null>` until 2026-08-23, and the lie had
 * already cost us once: `tinyint(1)` arrives as a **number**, so
 * `r.roll_Status !== '0'` compared a number against a string, was true for
 * every row, and would have migrated all 963 customers who never accepted the
 * shop's rules as having accepted them. The compiler could not object, because
 * this line told it both sides were strings.
 *
 * What the dump actually holds, from `information_schema` rather than from
 * memory: 235 `varchar`, 35 `text`, 30 `int`, 5 `bigint`, 4 `json`, 3 `enum`,
 * 2 `tinyint`, 1 `datetime`. With `connectMysql`'s settings — `dateStrings`,
 * `bigNumberStrings` — everything comes back a string except `int` and
 * `tinyint`, which are numbers, and `json`, which is an object. Measured
 * against the simulation MySQL, not assumed.
 *
 * `json` is left out of this union deliberately. Of the four such columns
 * (`botsaz.hide_panel`, `setting.text_edit`, `logs_api.data`, `logs_api.header`)
 * the migration reads none, so admitting `object` here would widen 274 columns'
 * worth of call sites to buy nothing. `t.json` handles an already-parsed value
 * anyway, for the day one of them is read.
 *
 * Widening this made tsc name all 48 places a legacy cell reaches a transform.
 * They now go through `t.legacyText`, which is where «what does a number mean
 * here» is answered once — and `t.phone` and `t.cardDigits` refuse a number
 * outright, because a leading zero and a 16th digit do not survive the trip and
 * neither loss is visible afterwards.
 */
type Row = Record<string, string | number | null>;

interface Ctx {
  cfg: Config;
  my: Connection;
  pg: pg.Client;
  /** telegram_id -> users.id, filled by the users step. */
  userId: Map<string, string>;
  skipped: Map<string, number>;
}

const ts = {
  tehran: { expr: t.sqlExpr.tehranString },
  epochS: { expr: t.sqlExpr.epochSeconds },
  epochMs: { expr: t.sqlExpr.epochMillis },
} as const;

function cols(spec: (string | [string, NonNullable<Column['expr']>])[]): Column[] {
  return spec.map((s) => (typeof s === 'string' ? { name: s } : { name: s[0], expr: s[1] }));
}

function skip(ctx: Ctx, what: string, n = 1): void {
  ctx.skipped.set(what, (ctx.skipped.get(what) ?? 0) + n);
}

/** A legacy percentage field; anything outside 0-100 is treated as unset. */
function percentOrZero(value: unknown): number {
  const n = Number((t.legacyText(value, 'user.pricediscount') ?? '0').trim());
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 0;
}

/** Resolves a legacy telegram id to a users.id, or null when the user is gone. */
function user(ctx: Ctx, legacyId: unknown): string | null {
  // Every caller passes a legacy telegram id out of a different table, so the
  // field name is the generic one: what a failure here means is «this column
  // stopped being text», and the value in the error says which.
  const id = t.legacyText(legacyId, 'legacy telegram id');
  if (!id) return null;
  return ctx.userId.get(id.trim()) ?? null;
}

// ===========================================================================
// steps
// ===========================================================================

async function migrateUsers(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM `user`');
  const claimed = [
    'id',
    'username',
    'number',
    'verify',
    'lang',
    'User_Status',
    'description_blocking',
    'agent',
    'codeInvitation',
    'Balance',
    'register',
    'limit_usertest',
    'score',
    'roll_Status',
    'pricediscount',
  ];
  // Transient conversation state and a plaintext session token: deliberately
  // not carried into the customer record.
  const dropped = [
    'step',
    'Processing_value',
    'Processing_value_one',
    'Processing_value_tow',
    'Processing_value_four',
    'pagenumber',
    'token',
  ];

  const values = rows.map((r) => [
    t.telegramId(r.id).toString(),
    t.username(r.username),
    t.phone(r.number),
    t.phone(r.number) !== null && r.verify === '1',
    r.lang === 'en' ? 'en' : 'fa',
    t.userStatus(r.User_Status),
    r.description_blocking || null,
    t.isReseller(r.agent),
    r.codeInvitation || null,
    Number(r.limit_usertest ?? 0),
    Number(r.score ?? 0),
    percentOrZero(r.pricediscount),
    // `roll_Status` is "has accepted the shop's rules" and used to be written
    // into `notify_enabled`, the only column gating both expiry warnings
    // (`warn.ts:80,94`). 963 customers hold `0`, so 963 customers would have
    // arrived unable to be told their service was ending — and nobody reports
    // a message that never arrives. `notify_enabled` is left to its own default
    // of true: the legacy schema carries no per-customer notification
    // preference, `index.php` warns everybody.
    //
    // This was `r.roll_Status !== '0'` until 2026-08-17, and it was wrong in the
    // other direction: the column is `tinyint(1)`, mysql2 returns a number, and
    // `0 !== '0'` is true — so all 963 refusals migrated as acceptances and
    // walked past the rules gate. `legacyBool` decides from the value rather
    // than from what `type Row` claims it is.
    t.legacyBool(r.roll_Status, 'user.roll_Status'),
    t.epochSeconds(r.register, 'user.register'),
    JSON.stringify(t.legacyAttrs(r, claimed, dropped)),
  ]);

  const written = await insertBatch(
    ctx.pg,
    'users',
    cols([
      'telegram_id',
      'username',
      'phone',
      'phone_verified',
      'lang',
      'status',
      'blocked_reason',
      'is_reseller',
      'referral_code',
      'test_quota_used',
      'score',
      'discount_percent',
      'rules_accepted',
      ['registered_at', ts.epochS.expr],
      ['legacy_attrs', (p) => `${p}::jsonb`],
    ]),
    values,
    { conflict: '(telegram_id)' },
  );

  const { rows: idMap } = await ctx.pg.query<{ id: string | number; telegram_id: string | number }>(
    'SELECT id, telegram_id FROM users',
  );
  // `String(...)` on both, and it is not defensive noise.
  //
  // `telegram_id` and `id` are bigint, and node-postgres decides whether an
  // int8 arrives as a string or a number through `pg.types.setTypeParser` --
  // which is PROCESS-GLOBAL. `db.ts` here asks for strings; `packages/db` asks
  // for numbers, and says in its own comment that the setting is global. In the
  // CLI only the first runs, so this worked. Inside the dashboard both are
  // loaded and the other one wins, so the map was keyed by numbers while
  // `user()` looked up strings: every lookup missed, and the import wrote 11,241
  // users and then skipped all 5,131 subscriptions, 236 orders, 179 referrals
  // and 93 redemptions as «user deleted» -- with every step reporting ok.
  //
  // Coercing here fixes it wherever the migration is called from, instead of
  // depending on which module was imported first.
  for (const m of idMap) ctx.userId.set(String(m.telegram_id), String(m.id));
  return written;
}

/** reagent_report holds referrer telegram ids; all 179 resolve to a user row. */
async function migrateReferrals(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM reagent_report');
  let n = 0;
  for (const r of rows) {
    const child = user(ctx, r.user_id);
    const referrer = user(ctx, r.reagent);
    if (!child) {
      skip(ctx, 'referrals: referred user deleted');
      continue;
    }
    if (!referrer) {
      skip(ctx, 'referrals: referrer deleted');
      continue;
    }
    const res = await ctx.pg.query(
      `UPDATE users SET referred_by = $1, referral_bonus_claimed = $2
        WHERE id = $3 AND referred_by IS DISTINCT FROM $1`,
      // Same shape as `roll_Status`, and latent rather than live: every
      // `reagent_report` row on the 2026-08-11 dump is 0, so `=== '1'` produced
      // the right answer by luck. The dump is retaken at cutover, and one
      // customer claiming a bonus before then would have arrived as unclaimed —
      // and been paid a second time.
      [referrer, t.legacyBool(r.get_gift, 'reagent_report.get_gift'), child],
    );
    n += res.rowCount ?? 0;
  }
  return n;
}

/**
 * Opens every wallet, then records the legacy balance as a single OPENING entry.
 *
 * The wallets row is created for everyone so that "no wallet" never has to mean
 * "zero"; the entry is written only when there is a balance, because a
 * zero-amount ledger line is meaningless and the schema rejects it.
 */
async function migrateWallets(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT id, Balance FROM `user`');

  await insertBatch(
    ctx.pg,
    'wallets',
    cols(['user_id']),
    rows.flatMap((r) => {
      const u = user(ctx, r.id);
      return u ? [[u]] : [];
    }),
    { conflict: '(user_id)' },
  );

  const entries = rows.flatMap((r) => {
    const u = user(ctx, r.id);
    const amount = t.tomanToIrr(r.Balance);
    if (!u || amount === 0n) return [];
    return [
      [
        u,
        amount.toString(),
        'OPENING',
        'SYSTEM',
        'legacy balance carried over unchanged',
        `legacy-opening:${String(r.id).trim()}`,
      ],
    ];
  });

  return insertBatch(
    ctx.pg,
    'wallet_entries',
    cols(['user_id', 'amount_irr', 'kind', 'actor', 'note', 'idempotency_key']),
    entries,
    { conflict: '(idempotency_key)' },
  );
}

/**
 * Whether a settings key carries a credential and must not be imported.
 *
 * `PaySetting` is not a table of switches. It holds `apinowpayment`,
 * `apiiranpay`, `apiternado`, `merchant_zarinpal`, `merchant_id_aqayepardakht`,
 * `marchent_floypay`, `marchent_tronseller` and `walletaddress` — live payment
 * gateway keys and merchant identifiers, in plaintext. Copying them into
 * `settings` put them one `SELECT` away from any screen, which is the same
 * mistake `PROVIDER_SECRETS` exists to prevent one table over.
 *
 * They are dropped rather than carried, for the same reason `password_panel`
 * is: nothing in this platform speaks to a payment gateway yet — the shop takes
 * card-to-card only — so there is no reader to break. When a gateway is
 * implemented its credential belongs in the runtime secret store, named by a
 * reference, exactly like `provisioning_providers.secret_ref`.
 *
 * `marchent` is not a typo. It is how three of the legacy columns are spelled,
 * and matching only the correct spelling would let all three through.
 */
export function isSettingSecret(scope: string, key: string): boolean {
  if (scope !== 'pay' && scope !== 'panel') return false;
  return /(api|token|secret|password|passwd|merchant|marchent|walletaddress|privkey|hmac)/i.test(
    key,
  );
}

async function migrateSettings(ctx: Ctx): Promise<number> {
  const out: unknown[][] = [];
  let dropped = 0;
  const push = (scope: string, key: string, value: unknown) => {
    if (isSettingSecret(scope, key)) {
      // Counted and reported, never silently swallowed: an admin who sees
      // "gateway not configured" later must be able to find out why.
      dropped++;
      return;
    }
    out.push([scope, key, JSON.stringify(value ?? null)]);
  };

  // `setting` is a single row whose 51 columns are the settings.
  const [botRow] = await mysqlRows<Row>(ctx.my, 'SELECT * FROM `setting` LIMIT 1');
  if (botRow) for (const [k, v] of Object.entries(botRow)) push('bot', k, v);

  for (const r of await mysqlRows<Row>(ctx.my, 'SELECT * FROM shopSetting')) {
    push('shop', String(r.Namevalue), r.value);
  }
  for (const r of await mysqlRows<Row>(ctx.my, 'SELECT * FROM PaySetting')) {
    push('pay', String(r.NamePay), r.ValuePay);
  }
  // Two more single-purpose tables that are configuration, not entities.
  const [aff] = await mysqlRows<Row>(ctx.my, 'SELECT * FROM affiliates LIMIT 1');
  if (aff) for (const [k, v] of Object.entries(aff)) push('shop', `affiliate_${k}`, v);
  for (const r of await mysqlRows<Row>(ctx.my, 'SELECT * FROM topicid')) {
    push('bot', `topic_${String(r.report)}`, r.idreport);
  }

  if (dropped > 0) {
    console.log(
      `  settings: ${dropped} gateway credential${dropped === 1 ? '' : 's'} not imported — ` +
        `they belong in the secret store, see isSettingSecret`,
    );
  }

  return insertBatch(
    ctx.pg,
    'settings',
    cols(['scope', 'key', ['value', (p) => `${p}::jsonb`]]),
    out,
    { conflict: '(scope, key)' },
  );
}

async function migrateAdmins(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM `admin`');
  // `admin.password` is a plaintext web-panel password and is not carried over.
  return insertBatch(
    ctx.pg,
    'admins',
    cols(['telegram_id', 'username', 'role']),
    rows.map((r) => [
      t.telegramId(r.id_admin).toString(),
      t.username(r.username),
      r.rule === 'all' ? 'OWNER' : 'ADMIN',
    ]),
    { conflict: '(telegram_id)' },
  );
}

const PROVIDER_CLAIMED = [
  'id',
  'code_panel',
  'name_panel',
  'type',
  'version_panel', // becomes part of `kind`; see providerKind below
  'status',
  'url_panel',
  'username_panel',
  'password_panel',
  'limit_panel',
];

/**
 * Columns that must never reach `provisioning_providers.config`.
 *
 * `datelogin` holds a cached admin session for the panel — a live JWT in every
 * production row — and `secret_code` is the Hiddify API key column. The schema
 * comment on that row promises it is safe to dump and log; it was not, and
 * dropping these is half of making that true. (The other half is in the comment
 * itself: `config.proxies` still carries a hysteria shared secret, which cannot
 * be dropped because provisioning sends it.)
 */
const PROVIDER_SECRETS = ['password_panel', 'datelogin', 'secret_code'];

/**
 * Which panel software this row actually is.
 *
 * Mirzabot has no `pasarguard` type. `legacy/mirzabot-php/admin.php:749-750`
 * takes the admin's PasarGuard choice, stores it as `type='marzban'`, and puts
 * the truth in a second column:
 *
 *     $version_panel = $userdata['type'] == "pasarguard" ? "1" : "0";
 *     $userdata['type'] = $userdata['type'] == "pasarguard" ? "marzban" : ...;
 *
 * All five production panels are `version_panel='1'`, so all five are
 * PasarGuard — which is also why `Marzban.php:229` sends them `group_ids` and
 * `proxy_settings` instead of `inbounds` and `proxies`. Carrying the alias
 * forward would have meant a genuine classic-Marzban panel one day landing on
 * the same `kind` and being handed field names it drops in silence.
 */
export function providerKind(r: Row): string {
  if (r.version_panel === '1') return 'pasarguard';
  return (t.legacyText(r.type, 'marzban_panel.type') ?? 'marzban').toLowerCase();
}

/**
 * One `marzban_panel` row, as it lands in `provisioning_providers`.
 *
 * Exported so the test can drive the real mapping instead of a second copy of
 * it. A hand-written expectation of "what the importer produces" is a fixture
 * that agrees with itself; this one is fed rows straight out of the production
 * dump in the simulation MySQL.
 */
export function providerRow(r: Row): unknown[] {
  const limitPanel = t.legacyText(r.limit_panel, 'marzban_panel.limit_panel');
  return [
    Number(r.id),
    r.code_panel ?? `panel-${r.id}`,
    r.name_panel ?? `panel-${r.id}`,
    providerKind(r),
    r.status === 'active' ? 'ACTIVE' : 'DISABLED',
    r.url_panel,
    // 'unlimited' is the legacy sentinel; NULL means unlimited here.
    limitPanel !== null && /^\d+$/.test(limitPanel) ? Number(limitPanel) : null,
    // Panel credentials stay out of the row; secret_ref is wired up at deploy.
    JSON.stringify(t.parseJsonStrings(t.legacyAttrs(r, PROVIDER_CLAIMED, PROVIDER_SECRETS))),
  ];
}

/** The column order `providerRow` fills. */
export const PROVIDER_COLUMNS = [
  'legacy_id',
  'code',
  'name',
  'kind',
  'status',
  'base_url',
  'capacity',
  'config',
] as const;

async function migrateProviders(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM marzban_panel');
  const inserted = await insertBatch(
    ctx.pg,
    'provisioning_providers',
    cols([
      'legacy_id',
      'code',
      'name',
      'kind',
      'status',
      'base_url',
      'capacity',
      ['config', (p) => `${p}::jsonb`],
    ]),
    rows.map(providerRow),
    { conflict: '(legacy_id)' },
  );
  await moveHiddenUsers(ctx);
  return inserted;
}

/**
 * `marzban_panel.hide_user` out of `config` and into `provider_hidden_users`.
 *
 * Migration 0045 does this once for a database that is already imported. This
 * does it for every import AFTER that one, and it is not the same thing: a
 * reseller runs `packages/migrate` against their own Mirzabot database, and
 * `legacyAttrs` carries `hide_user` into `config` again every single time. A
 * key sitting there that nothing reads is a deny list that silently stopped
 * working, on somebody else's shop, where nobody would think to look.
 *
 * Runs inside the migration's own transaction, after `users` — the whole point
 * is resolving a Telegram id to a row, and the users step is two above this one
 * in `STEPS`.
 *
 * AS MATERIALIZED is load-bearing: without it the planner may evaluate
 * `tg::bigint` on rows the regex has not filtered, and one non-numeric entry
 * would abort the import.
 */
async function moveHiddenUsers(ctx: Ctx): Promise<void> {
  await ctx.pg.query(
    `WITH hidden AS MATERIALIZED (
       SELECT pr.id AS provider_id, t.tg AS tg
         FROM provisioning_providers pr
         CROSS JOIN LATERAL jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(pr.config -> 'hide_user') = 'array'
                     THEN pr.config -> 'hide_user'
                     ELSE '[]'::jsonb
                END) AS t(tg)
        WHERE t.tg ~ '^[0-9]{1,18}$'
     )
     INSERT INTO provider_hidden_users (provider_id, user_id, hidden_by)
     SELECT h.provider_id, u.id, 'import'
       FROM hidden h
       JOIN users u ON u.telegram_id = h.tg::bigint
     ON CONFLICT DO NOTHING`,
  );
  /*
   * What could not be resolved, counted before the key that held it is gone.
   *
   * An entry naming somebody who has never started the bot has no `users` row
   * to point at, so it cannot become a row here — and the UPDATE below then
   * deletes the only record that it ever existed. Silently, which is the one
   * thing this whole path was written to prevent: a reseller's deny list that
   * stopped working on somebody else's shop, where nobody would look.
   *
   * So it goes in the import report, beside every other row the import chose
   * not to write. The alternative CodeRabbit proposed — parking the remainder
   * under a second config key — is a value nothing reads, which is the exact
   * shape of the legacy settings this PR exists to stop repeating.
   */
  const { rows } = await ctx.pg.query<{ n: number }>(
    `WITH hidden AS MATERIALIZED (
       SELECT t.tg AS tg
         FROM provisioning_providers pr
         CROSS JOIN LATERAL jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(pr.config -> 'hide_user') = 'array'
                     THEN pr.config -> 'hide_user'
                     ELSE '[]'::jsonb
                END) AS t(tg)
        WHERE t.tg ~ '^[0-9]{1,18}$'
     )
     SELECT COUNT(*)::int AS n
       FROM hidden h
      WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.telegram_id = h.tg::bigint)`,
  );
  const unmatched = rows[0]?.n ?? 0;
  if (unmatched > 0) {
    skip(ctx, 'hidden panels: customer has never started the bot', unmatched);
  }

  await ctx.pg.query(
    `UPDATE provisioning_providers
        SET config = config - 'hide_user'
      WHERE config ? 'hide_user'`,
  );
}

async function migrateProducts(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM product');
  const { rows: providers } = await ctx.pg.query<{ id: string; name: string }>(
    'SELECT id, name FROM provisioning_providers WHERE legacy_id IS NOT NULL',
  );
  // `product.Location` holds the panel's NAME ('🥇سرویس VIP - مولتی لوکیشن 🎯'),
  // not its code ('7e7a'). Keying this map on `code` — as it was — compared two
  // disjoint sets, so every lookup missed and every product migrated with no
  // panel at all: 21 of 21 on the real dump. Nothing caught it, because the
  // verification counts rows and the count was right.
  //
  // It is also the link provisioning is built on. A product that does not know
  // its panel cannot be delivered.
  const byName = new Map(providers.map((p) => [p.name.trim(), p.id]));

  /** Location is what the customer picks first, so a wrong one is not skippable. */
  function providerFor(location: unknown): string | null {
    const name = (t.legacyText(location, 'product.Location') ?? '').trim();
    // Six legacy rows carry no Location. They appear under no panel in the bot's
    // own menu either, so they are genuinely unlinked rather than mismapped.
    if (name === '') return null;
    const id = byName.get(name);
    if (id === undefined) {
      throw new Error(
        `product.Location ${JSON.stringify(name)} matches no marzban_panel.name_panel. ` +
          'Fix the row or add the panel — do not let it migrate without a provider.',
      );
    }
    return id;
  }

  const claimed = [
    'id',
    'code_product',
    'name_product',
    'price_product',
    'Location',
    'Service_time',
    'Volume_constraint',
    'agent',
    'one_buy_status',
    'note',
  ];

  // `products.category_id` became NOT NULL in 0032, and this importer was never
  // taught about it: every run since has died here on the first product. 0032
  // backfilled the rows that existed at the time and created «سرویس‌ها» to hold
  // them, but a one-time INSERT in a migration says nothing about rows that
  // arrive afterwards -- and a freshly seeded database does not even have that
  // category any more.
  //
  // The legacy `category` table is empty (0 rows on the production dump), so
  // there is no real mapping to preserve. Landing every imported product in the
  // same category 0032 chose keeps its guarantee true rather than reintroducing
  // the uncategorised-product state it went out of its way to make
  // unrepresentable. The admin can split them up afterwards in the panel.
  await ctx.pg.query(
    `INSERT INTO product_categories (name, sort_order) VALUES ('سرویس‌ها', 0)
     ON CONFLICT (name) DO NOTHING`,
  );
  const { rows: defaultCategory } = await ctx.pg.query<{ id: string }>(
    `SELECT id FROM product_categories WHERE name = 'سرویس‌ها'`,
  );
  const categoryId = defaultCategory[0]?.id;
  if (categoryId === undefined) throw new Error('default product category could not be created');

  const written = await insertBatch(
    ctx.pg,
    'products',
    cols([
      'legacy_id',
      'code',
      'name',
      'kind',
      'category_id',
      'provider_id',
      'status',
      'description',
      'once_per_user',
      'resellers_only',
      ['attrs', (p) => `${p}::jsonb`],
    ]),
    rows.map((r) => [
      Number(r.id),
      r.code_product ?? `product-${r.id}`,
      r.name_product ?? `product-${r.id}`,
      'vpn',
      categoryId,
      providerFor(r.Location),
      'ACTIVE',
      r.note || null,
      r.one_buy_status === '1',
      t.isReseller(r.agent),
      JSON.stringify(t.legacyAttrs(r, claimed)),
    ]),
    { conflict: '(legacy_id)' },
  );

  // Each legacy product row is one purchasable plan: price, duration, volume.
  const { rows: products } = await ctx.pg.query<{ id: string; legacy_id: number }>(
    'SELECT id, legacy_id FROM products WHERE legacy_id IS NOT NULL',
  );
  // String() on both sides: node-postgres returns int4 as a number while MySQL
  // returns it as a string, so a raw key would never match and every plan would
  // be silently skipped.
  const byLegacy = new Map(products.map((p) => [String(p.legacy_id), p.id]));

  await insertBatch(
    ctx.pg,
    'product_plans',
    cols(['legacy_id', 'product_id', 'name', 'price_irr', 'duration_days', 'volume_gb']),
    rows.flatMap((r) => {
      const pid = byLegacy.get(String(r.id));
      if (!pid) return [];
      const days = Number(r.Service_time ?? 0);
      const gb = Number(r.Volume_constraint ?? 0);
      return [
        [
          Number(r.id),
          pid,
          r.name_product ?? `plan-${r.id}`,
          t.tomanToIrr(r.price_product).toString(),
          Number.isFinite(days) && days > 0 ? days : null,
          Number.isFinite(gb) && gb > 0 ? gb : null,
        ],
      ];
    }),
    { conflict: '(legacy_id)' },
  );
  return written;
}

/**
 * Two legacy tables, one code namespace.
 *
 * `Discount` holds gift codes that credit the wallet — index.php:5841 does
 * `Balance + price`, so `price` is Toman. `DiscountSell` holds checkout
 * discounts where `price` is a PERCENTAGE — index.php:1795 does
 * `(price / 100) * price_product`. The same column name means two different
 * things in the two tables, which is why this is read from the code rather
 * than inferred from the values.
 *
 * Neither table has a unique index on its code, and production has both
 * duplicates within `DiscountSell` (33 rows, 12 distinct codes) and one code
 * present in both tables. A customer types one code and must get one answer,
 * so the new schema makes the code unique and this step picks a winner:
 * most-used first, then gift over sell, then oldest row. Every loser is
 * counted and reported rather than dropped quietly.
 */
/**
 * `DiscountSell.time` — unix seconds, or the string '0' for "never expires".
 *
 * Exported because the test measures the real function: 31 of the 33 production
 * codes are already past their date, and a mapping that quietly returned NULL
 * would turn all 31 back on the day the bot starts reading this table.
 */
export function expiryFromLegacy(time: unknown): string | null {
  const seconds = Number(t.legacyText(time, 'DiscountSell.time') ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000).toISOString();
}

/**
 * `DiscountSell.type` — which purchase a code is for.
 *
 * `index.php:4218` matches `type IN ('all','buy')` when buying and `:1740`
 * matches `type IN ('all','extend')` when renewing. Null for anything else,
 * and the caller drops the row: a fourth value matches neither SELECT, so that
 * code applies to nothing in the live bot and must not start applying to
 * everything in this one. The dump has only the three.
 */
export function appliesTo(type: unknown): 'ALL' | 'BUY' | 'RENEW' | null {
  const raw = t.legacyText(type, 'DiscountSell.type');
  if (raw === 'all') return 'ALL';
  if (raw === 'buy') return 'BUY';
  if (raw === 'extend') return 'RENEW';
  return null;
}

async function migrateDiscounts(ctx: Ctx): Promise<number> {
  const gifts = await mysqlRows<Row>(ctx.my, 'SELECT * FROM Discount');
  const sells = await mysqlRows<Row>(ctx.my, 'SELECT * FROM DiscountSell');

  // Both are imported ahead of this step, so a scoped code can be resolved to
  // the row it is scoped to rather than losing its scope.
  const { rows: productRows } = await ctx.pg.query<{ id: string; code: string }>(
    'SELECT id, code FROM products',
  );
  const productByCode = new Map(productRows.map((p) => [p.code, p.id]));
  const { rows: providerRows } = await ctx.pg.query<{ id: string; code: string }>(
    'SELECT id, code FROM provisioning_providers',
  );
  const providerByCode = new Map(providerRows.map((p) => [p.code, p.id]));

  interface Candidate {
    code: string;
    uses: number;
    giftFirst: number;
    legacyId: number;
    values: unknown[];
  }
  const candidates: Candidate[] = [];

  for (const r of gifts) {
    if (!r.code) {
      skip(ctx, 'discount codes: row has no code');
      continue;
    }
    const limit = Number(r.limituse ?? 0);
    candidates.push({
      code: t.legacyText(r.code, 'Discount.code') ?? '',
      uses: Number(r.limitused ?? 0),
      giftFirst: 0,
      legacyId: Number(r.id),
      // A NULL price credits nothing: PHP adds NULL, which is 0. Reproduced,
      // not repaired — the row stays visible instead of vanishing.
      values: [
        'Discount',
        Number(r.id),
        r.code,
        'GIFT_BALANCE',
        t.tomanToIrr(r.price).toString(),
        null,
        Number.isFinite(limit) && limit > 0 ? limit : null,
        false,
        false,
        // A gift code credits a wallet. It is not scoped to a product or a
        // panel, does not expire, and `Discount` has no column for any of it.
        null,
        null,
        null,
        'ALL',
      ],
    });
  }

  for (const r of sells) {
    if (!r.codeDiscount) {
      skip(ctx, 'discount codes: row has no code');
      continue;
    }
    const limit = Number(r.limitDiscount ?? 0);
    const percent = Number(r.price ?? 0);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
      skip(ctx, 'discount codes: percentage outside 0-100');
      continue;
    }
    // A code tied to a product or a panel that no longer exists can never
    // apply to anything. Importing it without its scope would not preserve it —
    // it would widen it to every product on every panel.
    let productId: string | null = null;
    if (r.code_product && r.code_product !== 'all') {
      productId =
        productByCode.get(t.legacyText(r.code_product, 'DiscountSell.code_product') ?? '') ?? null;
      if (productId === null) {
        skip(ctx, 'discount codes: scoped to a product that is gone');
        continue;
      }
    }
    let providerId: string | null = null;
    if (r.code_panel && r.code_panel !== '/all') {
      providerId =
        providerByCode.get(t.legacyText(r.code_panel, 'DiscountSell.code_panel') ?? '') ?? null;
      if (providerId === null) {
        skip(ctx, 'discount codes: scoped to a panel that is gone');
        continue;
      }
    }
    const scope = appliesTo(r.type);
    if (scope === null) {
      skip(ctx, 'discount codes: type matches neither buying nor renewing');
      continue;
    }
    candidates.push({
      code: t.legacyText(r.codeDiscount, 'DiscountSell.codeDiscount') ?? '',
      uses: Number(r.usedDiscount ?? 0),
      giftFirst: 1,
      legacyId: Number(r.id),
      values: [
        'DiscountSell',
        Number(r.id),
        r.codeDiscount,
        'PERCENT_OFF',
        null,
        percent,
        Number.isFinite(limit) && limit > 0 ? limit : null,
        r.usefirst === '1',
        r.agent === 'n',
        productId,
        providerId,
        expiryFromLegacy(r.time),
        scope,
      ],
    });
  }

  const winners = new Map<string, Candidate>();
  for (const c of candidates) {
    const held = winners.get(c.code);
    if (!held) {
      winners.set(c.code, c);
      continue;
    }
    const better =
      c.uses !== held.uses
        ? c.uses > held.uses
        : c.giftFirst !== held.giftFirst
          ? c.giftFirst < held.giftFirst
          : c.legacyId < held.legacyId;
    if (better) winners.set(c.code, c);
    skip(ctx, `discount codes: duplicate of "${c.code}" collapsed`);
  }

  let n = await insertBatch(
    ctx.pg,
    'discount_codes',
    cols([
      'legacy_table',
      'legacy_id',
      'code',
      'kind',
      'amount_irr',
      'percent',
      'max_uses',
      'first_purchase_only',
      'resellers_only',
      'product_id',
      'provider_id',
      'expires_at',
      'applies_to',
    ]),
    [...winners.values()].map((c) => c.values),
    { conflict: '(legacy_table, legacy_id)' },
  );

  const { rows: codes } = await ctx.pg.query<{ id: string; code: string }>(
    'SELECT id, code FROM discount_codes',
  );
  const byCode = new Map(codes.map((c) => [c.code, c.id]));

  const consumed = await mysqlRows<Row>(ctx.my, 'SELECT * FROM Giftcodeconsumed');
  n += await insertBatch(
    ctx.pg,
    'discount_redemptions',
    cols(['legacy_id', 'code_id', 'user_id']),
    consumed.flatMap((r) => {
      const codeId = byCode.get(t.legacyText(r.code, 'Giftcodeconsumed.code') ?? '');
      const u = user(ctx, r.id_user);
      if (!codeId) {
        skip(ctx, 'redemptions: code deleted');
        return [];
      }
      if (!u) {
        skip(ctx, 'redemptions: user deleted');
        return [];
      }
      return [[Number(r.id), codeId, u]];
    }),
    { conflict: '(legacy_id)' },
  );
  return n;
}

/** The legacy invoice window: unpaid after a day and the bot stops waiting. */
const INVOICE_TTL_S = 24 * 60 * 60;

/**
 * A legacy `invoice` is a purchase, so it becomes an order as well as a service.
 *
 * Until 2026-08-30 it became only a `subscriptions` row. That is not a smaller
 * version of the truth, it is a different one: in this schema an **order** is
 * the record that a sale happened and a **subscription** is the thing handed
 * over. The bot writes both for every purchase, and `subscriptions.order_id`
 * exists to tie them together.
 *
 * Every screen that answers «how much did we sell» reads `orders`: the panel's
 * home screen, «آمار فروشگاه», the bot's own «آمار», and the nightly report. So
 * an import that wrote 7,889 subscriptions and no orders left all four of them
 * reporting that the shop had made **five** sales — the five that predate the
 * import — while 869 million Toman of real ones sat in a table none of them
 * reads. On Sam's dump the symptom reached the screen as a «درآمد کل» of
 * **−۶۱۶ میلیون تومان**: the 697 million of negative `revenue_adjustments`
 * counted in full against sales that counted not at all (issue #45).
 *
 * ## An unpaid invoice arrives EXPIRED, and that is not a rounding of it
 *
 * `AWAITING_PAYMENT` is the literal translation of `unpaid`, and writing it
 * would message 1,886 real customers. `expireUnpaidOrders`
 * (`apps/bot/src/expire.ts`) takes every AWAITING_PAYMENT order past its
 * `expires_at`, marks it EXPIRED, and — in the same transaction, deliberately —
 * tells the customer on Telegram. Every unpaid row in the dump is already past
 * its day, so the first worker tick after an import would send 1,886 «فاکتور
 * شما منقضی شد» notices about carts abandoned in a bot we do not run.
 *
 * The state is therefore written directly, with `expires_at` recording when the
 * legacy window actually closed. Nothing is lost: an invoice a customer is
 * still completing is being completed on the old bot, which is the system of
 * record for it until the cutover.
 *
 * The mapping is flat on purpose — quantity one, no discount. The legacy stores
 * the price the customer paid and does not keep the list price it came from, so
 * a `discount_irr` here would be a number we invented.
 */
async function migrateInvoiceOrders(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM invoice');
  return insertBatch(
    ctx.pg,
    'orders',
    cols([
      'legacy_ref',
      'public_id',
      'user_id',
      'kind',
      'quantity',
      'unit_price_irr',
      'discount_irr',
      'total_irr',
      'status',
      ['created_at', ts.epochS.expr],
      ['expires_at', ts.epochS.expr],
      ['completed_at', ts.epochS.expr],
    ]),
    rows.flatMap((r) => {
      const u = user(ctx, r.id_user);
      if (!u) {
        skip(ctx, 'orders: user deleted');
        return [];
      }
      const sold = t.epochSeconds(r.time_sell, 'invoice.time_sell');
      if (!sold) {
        // `orders.created_at` is NOT NULL and there is nothing honest to put in
        // it. Counted rather than back-filled with the import's own clock,
        // which would date a two-year-old sale to this morning.
        skip(ctx, 'orders: invoice has no sale time');
        return [];
      }
      const status = t.invoiceOrderStatus(r.Status);
      const amount = t.tomanToIrr(r.price_product).toString();
      return [
        [
          `invoice:${r.id_invoice}`,
          `inv-${r.id_invoice}`,
          u,
          'NEW_PURCHASE',
          1,
          amount,
          0,
          amount,
          status,
          sold,
          status === 'EXPIRED' ? String(Number(sold) + INVOICE_TTL_S) : null,
          status === 'COMPLETED' ? sold : null,
        ],
      ];
    }),
    { conflict: '(legacy_ref)' },
  );
}

async function migrateSubscriptions(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM invoice');
  const { rows: providers } = await ctx.pg.query<{ id: string; name: string }>(
    'SELECT id, name FROM provisioning_providers',
  );
  const byName = new Map(providers.map((p) => [p.name, p.id]));

  const claimed = [
    'id_invoice',
    'id_user',
    'username',
    'Service_location',
    'time_sell',
    'name_product',
    'price_product',
    'Volume',
    'Service_time',
    'uuid',
    'note',
    'notifctions',
    'refral',
    'Status',
  ];

  const written = await insertBatch(
    ctx.pg,
    'subscriptions',
    cols([
      'public_id',
      'user_id',
      'provider_id',
      'provider_name_at_sale',
      'plan_name_at_sale',
      'price_irr',
      ['remote_ref', (p) => `${p}::jsonb`],
      'remote_username',
      'volume_gb',
      'duration_days',
      'status',
      'legacy_status',
      ['notify', (p) => `${p}::jsonb`],
      'referral_code',
      'note',
      ['purchased_at', ts.epochS.expr],
      ['legacy_attrs', (p) => `${p}::jsonb`],
    ]),
    rows.flatMap((r) => {
      const u = user(ctx, r.id_user);
      if (!u) {
        skip(ctx, 'subscriptions: user deleted');
        return [];
      }
      const gb = Number(r.Volume ?? 0);
      const days = Number(r.Service_time ?? 0);
      return [
        [
          r.id_invoice,
          u,
          byName.get(t.legacyText(r.Service_location, 'invoice.Service_location') ?? '') ?? null,
          r.Service_location,
          r.name_product ?? '(unknown product)',
          t.tomanToIrr(r.price_product).toString(),
          JSON.stringify(t.json(r.uuid)),
          r.username || null,
          Number.isFinite(gb) && gb > 0 ? gb : null,
          Number.isFinite(days) && days > 0 ? days : null,
          t.subscriptionStatus(r.Status),
          r.Status,
          JSON.stringify(t.json(r.notifctions)),
          r.refral && r.refral !== '0' ? r.refral : null,
          r.note || null,
          t.epochSeconds(r.time_sell, 'invoice.time_sell'),
          JSON.stringify(t.legacyAttrs(r, claimed)),
        ],
      ];
    }),
    { conflict: '(public_id)' },
  );

  // The two halves of one purchase, joined the way the bot leaves them.
  //
  // Done as a statement rather than by threading an id map through the insert,
  // because the join is provable from the schema alone: `subscriptions.public_id`
  // IS the legacy invoice id, and `orders.legacy_ref` is built from the same
  // column one step earlier. `IS NULL` keeps a re-run from touching a link the
  // bot itself made.
  await ctx.pg.query(
    `UPDATE subscriptions s SET order_id = o.id
       FROM orders o
      WHERE o.legacy_ref = 'invoice:' || s.public_id
        AND s.order_id IS NULL`,
  );

  return written;
}

async function migratePayments(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM Payment_report');
  return insertBatch(
    ctx.pg,
    'payments',
    cols([
      'legacy_id',
      'public_id',
      'user_id',
      'legacy_telegram_id',
      'amount_irr',
      'method',
      'legacy_method',
      'status',
      'reject_reason',
      'assigned_card_number',
      'assigned_card_name',
      'operation_type',
      'legacy_step_token',
      'telegram_message_id',
      ['created_at', ts.tehran.expr],
      ['updated_at', ts.tehran.expr],
    ]),
    rows.map((r) => {
      const step = t.stepToken(r.id_invoice);
      const card = t.cardDigits(r.assigned_card_number);
      return [
        Number(r.id),
        // 22 rows carry no order id; the legacy row id keeps them addressable.
        r.id_order || `legacy-payment-${r.id}`,
        user(ctx, r.id_user),
        t.telegramId(r.id_user).toString(),
        t.tomanToIrr(r.price).toString(),
        t.paymentMethod(r.Payment_Method),
        r.Payment_Method,
        t.paymentStatus(r.payment_Status),
        r.dec_not_confirmed || null,
        card ? correctCardDigits(card) : null,
        r.assigned_card_name || null,
        step.operationType,
        step.raw,
        r.message_id ? Number(r.message_id) : null,
        t.tehranString(r.time, 'Payment_report.time'),
        t.tehranString(r.at_updated, 'Payment_report.at_updated'),
      ];
    }),
    { conflict: '(legacy_id)' },
  );
}

/** service_other rows are renewals and add-ons: orders without a subscription link. */
async function migrateServiceOrders(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM service_other');
  return insertBatch(
    ctx.pg,
    'orders',
    cols([
      'legacy_ref',
      'public_id',
      'user_id',
      'kind',
      'quantity',
      'unit_price_irr',
      'discount_irr',
      'total_irr',
      'status',
      ['created_at', ts.tehran.expr],
    ]),
    rows.flatMap((r) => {
      const u = user(ctx, r.id_user);
      if (!u) {
        skip(ctx, 'orders: user deleted');
        return [];
      }
      const amount = t.tomanToIrr(r.price).toString();
      return [
        [
          `service_other:${r.id}`,
          `so-${r.id}`,
          u,
          t.orderKind(r.type),
          1,
          amount,
          0,
          amount,
          r.status === 'paid'
            ? 'COMPLETED'
            : r.status === 'unpaid'
              ? 'AWAITING_PAYMENT'
              : 'COMPLETED', // blank status rows all carry a provisioning output
          t.tehranString(r.time, 'service_other.time'),
        ],
      ];
    }),
    { conflict: '(legacy_ref)' },
  );
}

async function migrateCardLeases(ctx: Ctx): Promise<number> {
  const rows = await mysqlRows<Row>(ctx.my, 'SELECT * FROM card_assignment_leases');
  return insertBatch(
    ctx.pg,
    'card_leases',
    cols([
      'legacy_id',
      'telegram_user_id',
      'order_public_id',
      'card_number',
      'card_name',
      'status',
      ['assigned_at', ts.epochS.expr],
      ['expires_at', ts.epochS.expr],
      ['completed_at', ts.epochS.expr],
      ['released_at', ts.epochS.expr],
      ['created_at', ts.epochS.expr],
      ['updated_at', ts.epochS.expr],
    ]),
    rows.map((r) => {
      const card = t.cardDigits(r.card_number);
      return [
        Number(r.id),
        t.telegramId(r.telegram_user_id).toString(),
        r.order_id,
        card ? correctCardDigits(card) : r.card_number,
        r.card_name ?? '',
        t.leaseStatus(r.status),
        t.epochSeconds(r.assigned_at, 'lease.assigned_at'),
        t.epochSeconds(r.expires_at, 'lease.expires_at'),
        r.completed_at ? t.epochSeconds(r.completed_at, 'lease.completed_at') : null,
        r.released_at ? t.epochSeconds(r.released_at, 'lease.released_at') : null,
        t.epochSeconds(r.created_at, 'lease.created_at'),
        t.epochSeconds(r.updated_at, 'lease.updated_at'),
      ];
    }),
    { conflict: '(legacy_id)' },
  );
}

// `migrateOps` used to be one step covering support, content, promos and
// shop bookkeeping. They are split because they belong to different import
// domains: an operator who imports the shop's configuration is not thereby
// asking for three years of ticket history.
async function migrateSupport(ctx: Ctx): Promise<number> {
  let n = 0;

  n += await insertBatch(
    ctx.pg,
    'support_departments',
    cols(['legacy_id', 'name', 'telegram_id']),
    (await mysqlRows<Row>(ctx.my, 'SELECT * FROM departman')).map((r) => {
      const idSupport = t.legacyText(r.idsupport, 'departman.idsupport');
      return [
        Number(r.id),
        r.name_departman ?? `dept-${r.id}`,
        idSupport !== null && /^\d+$/.test(idSupport) ? idSupport : null,
      ];
    }),
    { conflict: '(legacy_id)' },
  );

  const { rows: depts } = await ctx.pg.query<{ id: string; legacy_id: string }>(
    'SELECT id, legacy_id FROM support_departments WHERE legacy_id IS NOT NULL',
  );
  const deptByName = new Map(
    (await mysqlRows<Row>(ctx.my, 'SELECT * FROM departman')).map((r) => [
      r.name_departman ?? '',
      depts.find((d) => d.legacy_id === String(r.id))?.id ?? null,
    ]),
  );

  const tickets = await mysqlRows<Row>(ctx.my, 'SELECT * FROM support_message');
  n += await insertBatch(
    ctx.pg,
    'support_tickets',
    cols([
      'legacy_id',
      'tracking_code',
      'user_id',
      'department_id',
      'status',
      ['created_at', ts.tehran.expr],
    ]),
    tickets.flatMap((r) => {
      const u = user(ctx, r.iduser);
      if (!u) {
        skip(ctx, 'support tickets: user deleted');
        return [];
      }
      const status =
        r.status === 'Answered'
          ? 'ANSWERED'
          : r.status === 'Pending'
            ? 'PENDING'
            : r.status === 'Customerresponse'
              ? 'CUSTOMER_REPLIED'
              : r.status === 'close'
                ? 'CLOSED'
                : 'OPEN';
      return [
        [
          Number(r.id),
          r.Tracking ?? `ticket-${r.id}`,
          u,
          deptByName.get(r.name_departman ?? '') ?? null,
          status,
          t.tehranString(r.time, 'support_message.time'),
        ],
      ];
    }),
    { conflict: '(legacy_id)' },
  );

  // The legacy row holds the question and the answer in two columns; the thread
  // becomes real messages so a third reply has somewhere to go.
  const { rows: ticketIds } = await ctx.pg.query<{ id: string; legacy_id: string }>(
    'SELECT id, legacy_id FROM support_tickets WHERE legacy_id IS NOT NULL',
  );
  const ticketByLegacy = new Map(ticketIds.map((x) => [x.legacy_id, x.id]));
  // A split row has no legacy key of its own to conflict on, so idempotency
  // here is per ticket: a ticket that already has messages is left alone.
  for (const r of tickets) {
    const tid = ticketByLegacy.get(String(r.id));
    if (!tid) continue;
    const { rows: has } = await ctx.pg.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM support_messages WHERE ticket_id = $1',
      [tid],
    );
    if (Number(has[0]?.n ?? 0) > 0) continue;
    for (const [author, body] of [
      ['USER', r.text],
      ['ADMIN', r.result],
    ] as const) {
      if (!body) continue;
      await ctx.pg.query(
        'INSERT INTO support_messages (ticket_id, author_type, body) VALUES ($1,$2,$3)',
        [tid, author, body],
      );
      n++;
    }
  }

  return n;
}

async function migrateContent(ctx: Ctx): Promise<number> {
  let n = 0;

  n += await insertBatch(
    ctx.pg,
    'help_articles',
    cols(['legacy_id', 'title', 'category', 'body', 'media_id', 'media_type']),
    (await mysqlRows<Row>(ctx.my, 'SELECT * FROM help')).map((r) => [
      Number(r.id),
      r.name_os ?? `help-${r.id}`,
      r.category || null,
      r.Description_os ?? '',
      r.Media_os || null,
      r.type_Media_os || null,
    ]),
    { conflict: '(legacy_id)' },
  );

  n += await insertBatch(
    ctx.pg,
    'client_apps',
    cols(['legacy_id', 'name', 'link']),
    (await mysqlRows<Row>(ctx.my, 'SELECT * FROM app')).map((r) => [
      Number(r.id),
      r.name ?? `app-${r.id}`,
      r.link ?? '',
    ]),
    { conflict: '(legacy_id)' },
  );

  n += await insertBatch(
    ctx.pg,
    'required_channels',
    cols(['title', 'chat_ref', 'join_link']),
    (await mysqlRows<Row>(ctx.my, 'SELECT * FROM channels')).flatMap((r) =>
      r.link ? [[r.remark ?? r.link, r.link, r.linkjoin ?? r.link]] : [],
    ),
    { conflict: '(chat_ref)' },
  );

  return n;
}

async function migratePromos(ctx: Ctx): Promise<number> {
  let n = 0;

  n += await insertBatch(
    ctx.pg,
    'wheel_spins',
    cols(['legacy_id', 'user_id', 'prize_code', 'amount_irr', ['created_at', ts.tehran.expr]]),
    (await mysqlRows<Row>(ctx.my, 'SELECT * FROM wheel_list')).flatMap((r) => {
      const u = user(ctx, r.id_user);
      if (!u) {
        skip(ctx, 'wheel spins: user deleted');
        return [];
      }
      return [
        [
          Number(r.id),
          u,
          r.wheel_code ?? '',
          t.tomanToIrr(r.price).toString(),
          t.tehranString(r.time, 'wheel_list.time'),
        ],
      ];
    }),
    { conflict: '(legacy_id)' },
  );

  return n;
}

async function migrateShopOps(ctx: Ctx): Promise<number> {
  let n = 0;

  n += await insertBatch(
    ctx.pg,
    'reseller_requests',
    cols(['legacy_id', 'user_id', 'description', 'kind', 'status', ['created_at', ts.epochS.expr]]),
    (await mysqlRows<Row>(ctx.my, 'SELECT * FROM Requestagent')).flatMap((r) => {
      const u = user(ctx, r.id);
      if (!u) {
        skip(ctx, 'reseller requests: user deleted');
        return [];
      }
      const status =
        r.status === 'accept' ? 'APPROVED' : r.status === 'reject' ? 'REJECTED' : 'PENDING';
      return [
        [
          r.id,
          u,
          r.Description || null,
          r.type || null,
          status,
          t.epochSeconds(r.time, 'Requestagent.time'),
        ],
      ];
    }),
    { conflict: '(legacy_id)' },
  );

  /**
   * `kind` and `spent_on` are decided by Postgres, not here.
   *
   * `0040_expense_ledger.sql` made both NOT NULL and created
   * `expense_kind_of(note, amount)` to fill the first — the same function its
   * own backfill used on the 219 production rows. Calling it from SQL rather
   * than reimplementing the rule in TypeScript is the whole point: two copies
   * of «what is a fake receipt» would drift the first time a keyword was
   * added, and nothing would say which one the screen was using.
   *
   * `note` is bound twice, once as the column and once as the classifier's
   * argument, because `insertBatch` binds per column. `spent_on` is the Tehran
   * day of the legacy timestamp, which is the best-known spend date for a
   * historical row and exactly what the backfill wrote.
   */
  n += await insertBatch(
    ctx.pg,
    'revenue_adjustments',
    cols([
      'legacy_id',
      'amount_irr',
      'note',
      'created_by',
      ['created_at', ts.tehran.expr],
      // Each of these binds its own value and reads one sibling. The note and
      // the timestamp are bound a second time rather than referenced through
      // their siblings' placeholders, because a placeholder that appears in no
      // expression has no type Postgres can infer — «could not determine data
      // type of parameter $6», which is what the first version of this did.
      ['kind', (p, row) => `expense_kind_of(${p}, ${row[1]!}::bigint)`],
      ['spent_on', (p) => `(${ts.tehran.expr(p)})::date`],
      // The purpose, resolved from the name the function returns rather than
      // from an id, so the classifier has no dependency on a sequence and
      // works the same against a fresh database. NULL for a note it cannot
      // read, and NULL for anything that is not spending — the screen shows
      // those under «دسته‌بندی‌نشده» for a person to decide.
      [
        'category_id',
        (p, row) =>
          `(SELECT ec.id FROM expense_categories ec
              WHERE ec.name = expense_category_of(${p})
                AND expense_kind_of(${p}, ${row[1]!}::bigint) = 'EXPENSE')`,
      ],
    ]),
    (await mysqlRows<Row>(ctx.my, 'SELECT * FROM revenue_adjustment_log')).map((r) => {
      // `amount` is already signed, and `type` is a label rather than the sign.
      //
      // This used to read "`type` decides the sign; `amount` is stored
      // unsigned" and negate whenever `type === 'subtract'`. Both halves were
      // wrong, and they cancelled: no row is typed `subtract` — the word is
      // `deduct` — so the branch never fired and the already-correct signs went
      // through untouched. A comment that is itself false, guarding a branch
      // that never runs, producing the right answer.
      //
      // Measured on the 2026-08-11 dump: all 99 `deduct` rows are negative, all
      // 37 `add` rows are positive, and `SUM(amount)` equals
      // `setting.revenue_adjustment` to the Toman. That equality is the proof,
      // and `verify.ts` now asserts it — because the obvious "fix" here is to
      // correct the typo to `deduct`, which would flip 99 rows and move the
      // admin's books by twice 364,899,750 Toman with every count still green.
      return [
        Number(r.id),
        t.tomanToIrr(r.amount).toString(),
        r.note ?? '',
        r.created_by || null,
        t.tehranString(r.created_at, 'revenue_adjustment_log.created_at'),
        // The note and the timestamp again, for the three derived columns
        // above. Bound rather than referenced through their siblings, because
        // a placeholder no expression names has no type Postgres can infer.
        r.note ?? '',
        t.tehranString(r.created_at, 'revenue_adjustment_log.created_at'),
        r.note ?? '',
      ];
    }),
    { conflict: '(legacy_id)' },
  );

  return n;
}

// ---------------------------------------------------------------------------
// payment hub (D1 export)
// ---------------------------------------------------------------------------

/** Copies a D1 table straight across, taking only the columns Postgres has. */
async function copyD1(
  ctx: Ctx,
  table: string,
  columnNames: readonly string[],
  conflict: string,
): Promise<number> {
  const rows = d1Table<Record<string, unknown>>(ctx.cfg, table);
  if (rows.length === 0) return 0;
  return insertBatch(
    ctx.pg,
    table,
    cols([...columnNames]),
    rows.map((r) =>
      columnNames.map((c) => {
        const v = r[c] ?? null;
        if (!t.HUB_EPOCH_COLUMNS.has(c)) return v;
        const millis = t.hubEpochMillis(v, `${table}.${c}`);
        if (millis !== null && typeof v !== 'number') {
          skip(ctx, `${table}.${c}: datetime string normalised to epoch millis`);
        }
        return millis;
      }),
    ),
    { conflict },
  );
}

/** Each entry is [table, columns, conflict target]; most key on `id`. */
const D1_TABLES: [table: string, columns: string[], conflict?: string][] = [
  ['access_users', ['id', 'email', 'display_name', 'role', 'active', 'created_at', 'updated_at']],
  [
    'devices',
    [
      'id',
      'device_code',
      'display_name',
      'description',
      'active',
      'last_seen_at',
      'last_success_at',
      'last_auth_failure_at',
      'created_at',
      'updated_at',
    ],
  ],
  [
    'device_credentials',
    [
      'id',
      'device_id',
      'token_hash',
      'token_prefix',
      'status',
      'created_at',
      'activated_at',
      'revoked_at',
      'last_used_at',
    ],
  ],
  [
    'financial_accounts',
    [
      'id',
      'bank_name',
      'display_name',
      'owner_label',
      'account_type',
      'account_hint',
      'card_last_four',
      'account_last_four',
      'iban',
      'device_id',
      'active',
      'status',
      'parser_configuration',
      'created_at',
      'updated_at',
    ],
  ],
  [
    'financial_account_identifiers',
    ['id', 'financial_account_id', 'kind', 'value', 'label', 'created_at'],
  ],
  [
    'raw_sms_events',
    [
      'id',
      'device_id',
      'sender',
      'encrypted_or_protected_body',
      'normalized_body',
      'body_sha256',
      'app_checksum',
      'sms_timestamp',
      'received_at',
      'classification',
      'parser_status',
      'parser_id',
      'parser_version',
      'duplicate_of',
      'processing_error',
      'created_at',
    ],
  ],
  [
    'transaction_candidates',
    [
      'id',
      'raw_sms_event_id',
      'financial_account_id',
      'direction',
      'amount_irr',
      'balance_irr',
      'transaction_reference',
      'bank_timestamp',
      'confidence',
      'parser_id',
      'parser_version',
      'parser_evidence_json',
      'status',
      'processing_disposition',
      'created_at',
      'updated_at',
    ],
  ],
  [
    'payment_claims',
    [
      'id',
      'external_order_id',
      'customer_reference',
      'expected_amount_irr',
      'target_financial_account_id',
      'card_digits',
      'submitted_at',
      'paid_clicked_at',
      'receipt_submitted_at',
      'receipt_url_or_r2_key',
      'source_system',
      'metadata_json',
      'suspect_reason',
      'suspect_metadata_json',
      'operation_type',
      'purchase_type',
      'status',
      'created_at',
      'updated_at',
    ],
  ],
  [
    'reconciliation_matches',
    [
      'id',
      'transaction_candidate_id',
      'payment_claim_id',
      'score',
      'matching_reasons_json',
      'mismatch_reasons_json',
      'status',
      'reviewed_by',
      'reviewed_at',
      'created_at',
      'updated_at',
    ],
  ],
  [
    'transaction_detected_identifiers',
    [
      'id',
      'transaction_candidate_id',
      'identifier_type',
      'normalized_value',
      'display_value_masked',
      'parser_id',
      'confidence',
      'created_at',
    ],
  ],
  [
    'transaction_reviews',
    [
      'id',
      'transaction_candidate_id',
      'decision',
      'reviewed_by',
      'reviewer_role',
      'reason',
      'comment',
      'reviewed_at',
      'created_at',
      'updated_at',
    ],
  ],
  [
    'transaction_account_assignments',
    [
      'id',
      'transaction_candidate_id',
      'financial_account_id',
      'assignment_source',
      'identifier_type',
      'normalized_identifier',
      'assigned_by',
      'assigned_at',
      'replaced_assignment_id',
      'active',
      'metadata_json',
    ],
  ],
  [
    'audit_logs',
    [
      'id',
      'actor_email',
      'actor_role',
      'action',
      'entity_type',
      'entity_id',
      'before_json',
      'after_json',
      'reason',
      'request_id',
      'created_at',
    ],
  ],
  [
    'comments',
    ['id', 'entity_type', 'entity_id', 'author_email', 'author_role', 'body', 'created_at'],
  ],
  [
    'integration_tokens',
    [
      'id',
      'token_hash',
      'token_prefix',
      'label',
      'status',
      'created_at',
      'revoked_at',
      'last_used_at',
    ],
  ],
  ['integration_events', ['event_id', 'source', 'external_order_id', 'processed_at'], '(event_id)'],
  [
    'webhook_deliveries',
    [
      'id',
      'event_type',
      'payload_json',
      'attempt_count',
      'last_response_status',
      'last_response_body',
      'last_attempt_at',
      'next_attempt_at',
      'status',
    ],
  ],
  ['resellers', ['id', 'name', 'status', 'created_at', 'updated_at']],
  [
    'reseller_transactions',
    [
      'id',
      'transaction_candidate_id',
      'reseller_id',
      'classified_by',
      'classified_at',
      'note',
      'created_at',
    ],
  ],
  [
    'income_declined_transactions',
    [
      'id',
      'transaction_candidate_id',
      'declined_by',
      'declined_at',
      'reason',
      'restored_by',
      'restored_at',
      'created_at',
    ],
  ],
  [
    'account_assignment_previews',
    [
      'id',
      'financial_account_id',
      'actor_email',
      'status',
      'account_snapshot_json',
      'counts_json',
      'created_at',
      'expires_at',
      'result_json',
      'applied_at',
      'declined_at',
      'audit_log_id',
    ],
  ],
  [
    'account_assignment_preview_items',
    [
      'id',
      'preview_id',
      'transaction_candidate_id',
      'disposition',
      'identifier_type',
      'normalized_identifier',
      'current_account_id',
      'current_assignment_source',
      'tx_snapshot_json',
      'selected',
      'applied_disposition',
      'applied_assignment_id',
    ],
  ],
];

async function migrateHub(ctx: Ctx): Promise<number> {
  let n = 0;
  for (const [table, columns, conflict] of D1_TABLES) {
    n += await copyD1(ctx, table, columns, conflict ?? '(id)');
  }
  n += await copyD1(
    ctx,
    'dashboard_notification_state',
    ['actor_email', 'last_seen_transaction_at', 'last_seen_transaction_id', 'updated_at'],
    '(actor_email)',
  );
  n += await copyD1(
    ctx,
    'dashboard_transaction_reads',
    ['actor_email', 'transaction_candidate_id', 'seen_at'],
    '(actor_email, transaction_candidate_id)',
  );
  n += await copyD1(
    ctx,
    'dashboard_payment_event_reads',
    ['actor_email', 'event_key', 'seen_at'],
    '(actor_email, event_key)',
  );
  return n;
}

/**
 * Merges the two card lists into one table.
 *
 * The hub rows arrive first because `financial_account_id` is NOT NULL and only
 * the hub knows it. A bot card with no hub counterpart cannot be written
 * without inventing a bank account, so it is skipped and reported instead.
 */
async function migrateCards(ctx: Ctx): Promise<number> {
  const hub = d1Table<{
    id: string;
    financial_account_id: string;
    card_digits: string;
    label: string | null;
    created_at: number;
  }>(ctx.cfg, 'payment_cards');

  const written = await insertBatch(
    ctx.pg,
    'payment_cards',
    cols(['id', 'financial_account_id', 'card_digits', 'label', 'created_at']),
    hub.map((c) => [
      c.id,
      c.financial_account_id,
      correctCardDigits(c.card_digits),
      c.label,
      c.created_at,
    ]),
    { conflict: '(id)' },
  );

  const bot = await mysqlRows<Row>(ctx.my, 'SELECT * FROM card_number');
  for (const r of bot) {
    const digits = t.cardDigits(r.cardnumber);
    if (!digits) continue;
    const res = await ctx.pg.query(
      `UPDATE payment_cards
          SET holder_name = COALESCE($2, holder_name),
              status = $3,
              last_assigned_at = COALESCE($4, last_assigned_at)
        WHERE card_digits = $1`,
      [
        correctCardDigits(digits),
        r.namecard || null,
        r.status === 'active' ? 'ACTIVE' : 'DISABLED',
        r.last_assigned_at ? Number(r.last_assigned_at) : null,
      ],
    );
    if ((res.rowCount ?? 0) === 0) skip(ctx, 'cards: bot card with no hub account');
  }
  return written;
}

// ===========================================================================

/**
 * Which part of the shop a step belongs to.
 *
 * `core` is not optional: every other domain has a foreign key into `users`,
 * and a wallet balance without its owner is not a smaller import, it is a
 * broken one.
 */
export type Domain = 'core' | 'catalog' | 'sales' | 'discounts' | 'config' | 'history' | 'hub';

export const DOMAINS: readonly Domain[] = [
  'core',
  'catalog',
  'sales',
  'discounts',
  'config',
  'history',
  'hub',
];

/**
 * What the dashboard offers by default.
 *
 * Not the library default. `migrate()` and `verify()` still run every domain
 * unless told otherwise, so the CLI, the rehearsal script and the existing
 * tests behave exactly as they did. Narrowing is something a caller asks for.
 */
export const PANEL_DEFAULT_DOMAINS: readonly Domain[] = [
  'core',
  'catalog',
  'sales',
  'discounts',
  'config',
];

const STEPS: [name: string, domain: Domain, run: (ctx: Ctx) => Promise<number>][] = [
  ['users', 'core', migrateUsers],
  ['referrals', 'core', migrateReferrals],
  ['wallets', 'core', migrateWallets],
  ['settings', 'config', migrateSettings],
  ['admins', 'config', migrateAdmins],
  ['providers', 'catalog', migrateProviders],
  ['products + plans', 'catalog', migrateProducts],
  ['discounts', 'discounts', migrateDiscounts],
  // Before subscriptions, because the subscriptions step links itself to these.
  ['orders (invoices)', 'sales', migrateInvoiceOrders],
  ['subscriptions', 'sales', migrateSubscriptions],
  ['payments', 'sales', migratePayments],
  ['orders (service_other)', 'sales', migrateServiceOrders],
  ['payment hub (D1)', 'hub', migrateHub],
  // Cards belong to the hub, not to shop configuration: the merge needs a
  // `financial_account_id`, and only the D1 export carries one. Tagged 'config'
  // it produced a foreign key violation the moment somebody imported the shop
  // without the hub export beside the dump.
  ['bank cards (merged)', 'hub', migrateCards],
  ['card leases', 'config', migrateCardLeases],
  ['support tickets', 'history', migrateSupport],
  ['help, apps, channels', 'config', migrateContent],
  ['wheel spins', 'history', migratePromos],
  ['reseller requests, revenue', 'config', migrateShopOps],
];

export interface MigrateOptions {
  /**
   * `false` rolls the whole thing back instead of committing.
   *
   * Every step already runs inside one transaction, so a dry run is the real
   * migration measured against the real constraints - every partial unique
   * index, every CHECK - and then discarded. A scratch schema would test a
   * copy of the rules rather than the rules.
   */
  commit?: boolean;
  /** Domains to run. Defaults to every domain; `core` is always included. */
  domains?: Iterable<Domain>;
  /**
   * Rows to read back from each step's table before the transaction ends, so a
   * reviewer can see what a mapping actually produced.
   */
  samples?: number;
  /**
   * Runs after the last step and BEFORE the commit or rollback, and its answer
   * becomes `verified`.
   *
   * This is what makes a dry run worth trusting. Without it a dry run could
   * only report that no step threw -- and a migration that silently resolves
   * every owner to null does not throw, it writes the parents and skips the
   * children, reporting `ok` on every line. Running `verify` inside the
   * transaction compares the two sides while the rows still exist, so the
   * money and the counts are checked on a run that is about to be discarded.
   */
  beforeSettle?: () => Promise<boolean>;
  /**
   * Record what this run wrote, into a schema of this name, so it can be
   * taken back later. See `undo.ts`.
   *
   * Captured inside the migration's own transaction and immediately before
   * it settles, which is the only moment `pg_current_xact_id()` names the
   * transaction that did the writing. A dry run discards it along with
   * everything else, which is right: nothing was kept, so there is nothing
   * to take back.
   */
  undoSchema?: string;
}

export interface StepResult {
  name: string;
  domain: Domain;
  written: number;
  ms: number;
}

export interface MigrateResult {
  committed: boolean;
  /** `beforeSettle`'s answer, or true when no check was supplied. */
  verified: boolean;
  domains: Domain[];
  steps: StepResult[];
  skipped: [what: string, n: number][];
  /** Table name -> a few rows as they landed. Empty unless `samples` was set. */
  samples: Record<string, Record<string, unknown>[]>;
  /**
   * Rows the undo recording holds. 0 when no `undoSchema` was asked for, and
   * also when one was asked for and the run turned out to write nothing — the
   * caller must not keep a schema name for a recording that can take nothing
   * back, or the panel offers a button the server is bound to refuse.
   */
  undoRows: number;
}

/** The table a step's samples come from, where a useful one exists. */
/**
 * The table a step's samples come from, and the columns that may be shown.
 *
 * THE COLUMN LIST IS AN ALLOWLIST, AND IT IS NOT DECORATION. These rows do not
 * stay in a terminal: `importRoutes.ts` writes `result.samples` into
 * `import_runs.samples` as JSON, where it is kept and rendered in the admin
 * panel. `SELECT *` therefore copied, into a durable table and onto a screen,
 * exactly the data `CLAUDE.md` puts first on the list that never leaves this
 * machine — «پرداخت، آی‌دی تلگرام و کارت مشتری واقعی»:
 *
 *   users          phone, username, telegram_id, legacy_attrs
 *   payment_cards  card_digits, holder_name
 *   card_leases    card_number, card_name, telegram_user_id
 *   payments       assigned_card_number, assigned_card_name, legacy_telegram_id
 *   subscriptions  remote_username, remote_ref — panel credentials
 *   settings       value — which is where the bot token lives
 *   providers      base_url, secret_ref, config — panel passwords
 *
 * Found by CodeRabbit on PR #42, which named `users`; reading the schemas found
 * six more tables with the same problem, and the card numbers were the worst of
 * them.
 *
 * A SAMPLE EXISTS TO SHOW SHAPE, NOT PEOPLE. What a reviewer checks after an
 * import is «did the rows land, with sane statuses and amounts» — every column
 * below answers that, and none of them names a customer. Adding a column here
 * is a decision about what may be stored and displayed, so make it deliberately.
 */
export const SAMPLE_TABLE: Record<string, { table: string; columns: string }> = {
  users: { table: 'users', columns: 'id, status, lang, is_reseller, discount_percent, registered_at' },
  wallets: { table: 'wallet_entries', columns: 'id, amount_irr, kind, created_at' },
  // `value` withheld: this is where the bot token and the panel secrets live.
  settings: { table: 'settings', columns: 'scope, key, updated_at' },
  providers: {
    table: 'provisioning_providers',
    columns: 'id, code, name, kind, status, capacity, sort_order',
  },
  'products + plans': {
    table: 'product_plans',
    columns: 'id, product_id, name, price_irr, duration_days, volume_gb, user_limit, status',
  },
  discounts: {
    table: 'discount_codes',
    columns: 'id, kind, amount_irr, percent, max_uses, first_purchase_only, resellers_only',
  },
  subscriptions: {
    table: 'subscriptions',
    columns:
      'id, plan_name_at_sale, price_irr, volume_gb, duration_days, status, purchased_at, expires_at',
  },
  payments: {
    table: 'payments',
    columns: 'id, amount_irr, method, status, operation_type, created_at',
  },
  'orders (service_other)': {
    table: 'orders',
    columns: 'id, kind, quantity, unit_price_irr, discount_irr, total_irr, status, created_at',
  },
  'bank cards (merged)': {
    table: 'payment_cards',
    columns: 'id, financial_account_id, label, status, created_at',
  },
  'card leases': {
    table: 'card_leases',
    columns: 'id, status, assigned_at, expires_at, completed_at, released_at',
  },
};

export async function migrate(
  cfg: Config,
  my: Connection,
  pgc: pg.Client,
  opts: MigrateOptions = {},
): Promise<MigrateResult> {
  const ctx: Ctx = { cfg, my, pg: pgc, userId: new Map(), skipped: new Map() };
  const commit = opts.commit !== false;
  // `core` is not negotiable: it owns `users`, and `ctx.userId` - the map every
  // later step resolves its owner through - is built by the users step.
  const wanted = new Set<Domain>([...(opts.domains ?? DOMAINS), 'core']);
  const domains = DOMAINS.filter((d) => wanted.has(d));
  const steps: StepResult[] = [];
  const samples: Record<string, Record<string, unknown>[]> = {};
  let verified = true;

  report.title(commit ? 'migrating' : 'migrating (dry run - will roll back)');
  report.step(`domains: ${domains.join(', ')}`);
  /** Rows `captureUndo` recorded; 0 means there is nothing to take back. */
  let undoRows = 0;
  await pgc.query('BEGIN');
  if (!(await claimImportLock(pgc))) {
    await pgc.query('ROLLBACK');
    throw new Error('another import or undo is already running');
  }
  // Before the first write, and in the same transaction: `captureUndo` at the
  // end needs to know which keys were already there, or it cannot tell a row
  // this run inserted from one it only updated. See `beginUndo`.
  if (opts.undoSchema !== undefined) await beginUndo(pgc, opts.undoSchema);
  try {
    for (const [name, domain, run] of STEPS) {
      if (!wanted.has(domain)) {
        report.step(`${name.padEnd(26)} skipped - domain '${domain}' not selected`);
        continue;
      }
      const started = Date.now();
      const written = await run(ctx);
      const ms = Date.now() - started;
      const note = written === 0 ? 'already present' : `${written} row(s) written`;
      report.ok(`${name.padEnd(26)} ${note}  ${String(ms).padStart(5)}ms`);
      steps.push({ name, domain, written, ms });

      const sample = SAMPLE_TABLE[name];
      if (opts.samples && sample !== undefined) {
        // The allowlist, never `*`. See `SAMPLE_TABLE` — these rows are stored
        // and rendered, so the projection is the only thing standing between an
        // import report and a customer's card number.
        const { rows } = await pgc.query(
          `SELECT ${sample.columns} FROM ${sample.table} LIMIT $1`,
          [opts.samples],
        );
        samples[sample.table] = rows as Record<string, unknown>[];
      }
    }
    if (opts.beforeSettle) verified = await opts.beforeSettle();

    // Last, and still inside the transaction. After `beforeSettle` because a
    // dry run's verify reads the rows this would otherwise have to work
    // around, and before the settle because that is the whole mechanism.
    if (opts.undoSchema !== undefined) {
      undoRows = await captureUndo(pgc, opts.undoSchema);
    }

    // The rollback is deliberate and reported, so a dry run can never be read
    // as a completed import.
    await pgc.query(commit ? 'COMMIT' : 'ROLLBACK');
    if (!commit) report.warn('dry run - rolled back, nothing was written');
  } catch (err) {
    await pgc.query('ROLLBACK');
    report.fail('rolled back - nothing was written');
    throw err;
  }

  const skipped = [...ctx.skipped].sort((a, b) => b[1] - a[1]);
  if (skipped.length > 0) {
    report.title('skipped (parent row no longer exists)');
    for (const [what, n] of skipped) report.warn(`${n} ${what}`);
  }

  return { committed: commit, verified, domains, steps, skipped, samples, undoRows };
}
