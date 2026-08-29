#!/usr/bin/env node
/**
 * Sync Hub-eligible cards (ACTIVE financial_account) into Mirzabot JSON cache.
 * DEV/TEST only — writes hub-eligible-cards.json for card assignment.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outPath =
  process.argv[2] ||
  join(root, '../mirzabot/integration/card-assignment/data/hub-eligible-cards.json');

function d1Json(sql) {
  const cmd = `cd "${join(root, 'apps/ingest-worker')}" && pnpm exec wrangler d1 execute DB --remote --json --command ${JSON.stringify(sql)}`;
  const raw = execSync(cmd, { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  const parsed = JSON.parse(raw);
  const row = parsed?.[0]?.results;
  return Array.isArray(row) ? row : [];
}

const accounts = d1Json(
  "SELECT id, status FROM financial_accounts WHERE active = 1 AND status = 'ACTIVE'",
);
const activeIds = new Set(accounts.map((a) => a.id));

const hubCards = d1Json(
  'SELECT card_digits, financial_account_id FROM payment_cards ORDER BY card_digits',
);

const cards = hubCards
  .filter((c) => activeIds.has(c.financial_account_id))
  .map((c) => ({
    card_digits: c.card_digits,
    financial_account_id: c.financial_account_id,
    account_status: 'ACTIVE',
  }));

const payload = {
  synced_at: Date.now(),
  integration_id: 'mirzabot-test',
  cards,
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(payload, null, 2) + '\n');
console.log(`Wrote ${cards.length} eligible cards → ${outPath}`);
