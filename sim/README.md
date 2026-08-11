# sim — local simulation environment

Everything runs locally. No production server, no production bot, no customer
data leaves this machine.

```bash
pnpm sim:up      # start Postgres + MySQL
pnpm sim:down    # stop and delete the volumes
```

| service  | host port | credentials                  |
| -------- | --------- | ---------------------------- |
| Postgres | 5433      | `shikoo` / `shikoo_local`    |
| MySQL    | 3307      | `root` / `shikoo_local`      |

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

## What is not here yet

The fake Telegram API and the fake provisioning panel. They arrive with the bot
— there is nothing to fake until there is a bot pointing at them. Playwright MCP
verification of the dashboard likewise starts when the dashboard does.
