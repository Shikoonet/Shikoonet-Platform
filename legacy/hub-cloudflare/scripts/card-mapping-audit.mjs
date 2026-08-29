/**
 * Read-only card-mapping audit: TEST Mirzabot active cards vs Hub payment_cards.
 *
 * Consumes the JSON dumps in /tmp produced by the wrangler d1 queries and the
 * bot's card_number table. Writes nothing and decides nothing — it only reports
 * what each mapping can be justified by, so unproven mappings stay UNMAPPED.
 */
import { readFileSync } from 'node:fs';

const j = (p) => JSON.parse(readFileSync(p, 'utf8'));

const accounts = j('/tmp/h_accounts.json');
const hubCards = j('/tmp/h_cards.json');
const detected = j('/tmp/h_detected.json');
const claimCards = j('/tmp/h_claimcards.json');

const botCards = readFileSync('/tmp/bot-cards-full.txt', 'utf8')
  .trim()
  .split('\n')
  .filter(Boolean)
  .map((l) => {
    const [card, label, status, lastAssigned] = l.split('|');
    return { card, label, status, lastAssigned };
  });

const acctById = new Map(accounts.map((a) => [a.id, a]));
const hubByCard = new Map(hubCards.map((c) => [c.card_digits, c]));
const botByCard = new Map(botCards.map((c) => [c.card, c]));

/** Account hints proven real by appearing in parsed bank SMS. */
const hintsSeenInSms = new Set(detected.map((d) => d.normalized_value));

/** Cards with a claim that actually reached VERIFIED. */
const cardsWithVerifiedClaim = new Set(
  claimCards.filter((c) => c.status === 'VERIFIED' && c.card_digits).map((c) => c.card_digits),
);

const bin = (card) => card.slice(0, 6);

/** BIN -> issuing bank, derived only from the Hub's own existing mappings. */
const binToBanks = new Map();
for (const c of hubCards) {
  if (!botByCard.has(c.card_digits)) continue; // only BINs corroborated by the bot
  const a = acctById.get(c.financial_account_id);
  if (!a) continue;
  const set = binToBanks.get(bin(c.card_digits)) ?? new Set();
  set.add(a.bank_name);
  binToBanks.set(bin(c.card_digits), set);
}

function editDistanceOne(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) diff += 1;
  return diff === 1;
}

const rows = [];

for (const b of botCards) {
  const hub = hubByCard.get(b.card);
  if (b.status !== 'active') {
    rows.push({
      card: b.card,
      botLabel: b.label,
      inHub: hub ? 'yes' : 'no',
      acctId: hub?.financial_account_id ?? null,
      acctLabel: null,
      evidence: 'disabled in the bot — cannot be dealt to a customer',
      status: 'DISABLED_IN_BOT',
    });
    continue;
  }
  if (!hub) {
    const banks = binToBanks.get(bin(b.card));
    rows.push({
      card: b.card,
      botLabel: b.label,
      inHub: 'no',
      acctId: null,
      acctLabel: null,
      evidence: banks
        ? `BIN ${bin(b.card)} maps to ${[...banks].join(' / ')} in Hub, but no account-level evidence`
        : `BIN ${bin(b.card)} has no other mapped card in Hub — no in-system evidence at all`,
      status: 'UNMAPPED',
    });
    continue;
  }
  const a = acctById.get(hub.financial_account_id);
  const ev = [];
  if (cardsWithVerifiedClaim.has(b.card)) ev.push('a claim on this card reached VERIFIED');
  if (a?.account_hint && hintsSeenInSms.has(a.account_hint)) {
    ev.push(`account hint ${a.account_hint} observed in parsed bank SMS`);
  }
  if (a?.card_last_four && b.card.endsWith(a.card_last_four)) {
    ev.push(`account.card_last_four=${a.card_last_four} matches`);
  }
  rows.push({
    card: b.card,
    botLabel: b.label,
    inHub: 'yes',
    acctId: hub.financial_account_id,
    acctLabel: a ? `${a.display_name} (${a.bank_name})` : '??',
    evidence: ev.length ? ev.join('; ') : 'payment_cards row only',
    status: 'VERIFIED_MAPPING',
  });
}

for (const c of hubCards) {
  if (botByCard.has(c.card_digits)) continue;
  const a = acctById.get(c.financial_account_id);
  const near = botCards.find((b) => editDistanceOne(b.card, c.card_digits));
  const nearAcct = near ? hubByCard.get(near.card) : null;
  rows.push({
    card: c.card_digits,
    botLabel: '(not offered by bot)',
    inHub: 'yes',
    acctId: c.financial_account_id,
    acctLabel: a ? `${a.display_name} (${a.bank_name})` : '??',
    evidence: near
      ? `differs by one digit from bot card ${near.card}${
          nearAcct && nearAcct.financial_account_id === c.financial_account_id
            ? ', which maps to the SAME account'
            : ''
        }`
      : 'no bot counterpart',
    status: near ? 'POSSIBLE_TYPO' : 'HUB_ONLY',
  });
}

const order = {
  UNMAPPED: 0,
  POSSIBLE_TYPO: 1,
  HUB_ONLY: 2,
  DISABLED_IN_BOT: 3,
  VERIFIED_MAPPING: 4,
};
rows.sort((x, y) => order[x.status] - order[y.status] || x.card.localeCompare(y.card));

for (const r of rows) {
  console.log(
    [r.status, r.card, r.botLabel, r.acctLabel ?? '-', r.acctId ?? '-', r.evidence].join(' | '),
  );
}

console.log();
const counts = {};
for (const r of rows) counts[r.status] = (counts[r.status] ?? 0) + 1;
console.log('totals:', JSON.stringify(counts));
console.log('active_bot_cards:', botCards.filter((b) => b.status === 'active').length);
console.log('active_bot_cards_without_hub_mapping:', rows.filter((r) => r.status === 'UNMAPPED').length);
