# sim — local simulation environment

Everything runs locally. No production server, no production bot, no customer
data leaves this machine.

```bash
pnpm sim:up      # start Postgres + MySQL
pnpm sim:down    # stop and delete the volumes
```

| service  | host port | credentials               |
| -------- | --------- | ------------------------- |
| Postgres | 5433      | `shikoo` / `shikoo_local` |
| MySQL    | 3307      | `root` / `shikoo_local`   |

Non-default ports so a Postgres or MySQL already installed on the machine keeps
working.

## The MySQL seed

On first boot MySQL loads `legacy/mirzabot-php/db/mirzabot-prod-20260811.sql`
— the real production dump, mounted read-only. That gives the migration work
real-shaped data offline: 31 tables, ~11k users, ~4.6k payment records.

**That dump is real customer data.** It stays on this machine. It is git-ignored
and it is never copied anywhere else.

To reload it from scratch: `pnpm sim:down && pnpm sim:up` (the volume is dropped,
so the init script runs again).

## Secrets

`.env.local` is git-ignored. The Telegram token there must be the **test** bot,
never the production one.

Write the file yourself and do not paste the token anywhere else — not into a
chat, not onto a command line, where it would survive in shell history:

```ini
# sim/.env.local
DATABASE_URL=postgres://shikoo:shikoo_local@127.0.0.1:5433/shikoo
TELEGRAM_BOT_TOKEN=<the test bot's token from BotFather>
```

Then:

```bash
pnpm --filter @shikoo/bot start:local
```

`start:local` reads that file through Node's own `--env-file`, so the token
never appears in a command. Only one process may long-poll a token at a time:
a second one makes Telegram return `409 Conflict` to both.

## Injecting a bank SMS by hand

The seeded devices carry real credentials, so the whole payment path can be
walked offline: bot → claim → bank SMS → auto-verify → delivery. The API key is
derived from the device code, so it is never stored and never logged:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('seed-apikey-phone-d-20260804').digest('hex'))"
```

Post it with `deviceId` set to that same device code (`phone-a` … `phone-f`) and
a body the parsers accept, e.g.
`مبلغ 3,000,000 ریال به کارت *6030 واریز شد. مانده 72,222,222 ریال`.

Two things the walk gets wrong if you improvise:

- **Auto-match is off unless you ask for it.** Start ingest with
  `MIRZABOT_INTEGRATION_ENABLED=true AUTO_MATCH_ENABLED=true`, otherwise the SMS
  is stored, no claim is decided, and it looks like a bug.
- **Pin `timestamp` to `paid_clicked_at + 20s`**, read from `payment_claims`.
  Wall-clock drifts out of the ±5m window while you are typing. And a *second*
  deposit of the same amount to the same card inside that window makes the pair
  ambiguous: the claim then sits at `AMBIGUOUS_TRANSACTIONS`, which is the
  matcher being right, not broken.

## What is not here yet

The fake Telegram API and the fake provisioning panel. They arrive with the bot
— there is nothing to fake until there is a bot pointing at them. Playwright MCP
verification of the dashboard likewise starts when the dashboard does.
