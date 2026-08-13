/**
 * Which bank issued a card number.
 *
 * The first six digits of a payment card are its IIN and name the issuer. That
 * fact was unused here until 2026-08-13: `financial_accounts.bank_name` is free
 * text a human types into the dashboard, and the only other source of a bank
 * name is the header line of an SMS. So a card could be filed under the wrong
 * bank, or under a bank spelled two ways, and nothing would notice.
 *
 * The prefix table lives in Postgres rather than in this file because the head
 * admin asked to be able to correct it without a deploy — banks split and merge
 * IIN ranges, and a table you cannot edit is a table that goes stale.
 *
 * These functions are pure. Loading the rows is the caller's job.
 */

export interface BankPrefix {
  prefix: string;
  bankName: string;
}

/**
 * The bank a card number belongs to, or null when no prefix matches.
 *
 * Longest match wins. That is what makes the table extensible without a code
 * change: a bank that later carves a longer range out of a shorter one needs
 * only the longer row added, and it takes precedence automatically.
 *
 * Returning null is a real answer, not a failure — an unknown prefix means the
 * table has not been taught about that bank yet, and the caller should say so
 * rather than guess.
 */
export function identifyBank(digits: string, prefixes: readonly BankPrefix[]): string | null {
  if (!/^\d+$/.test(digits)) return null;
  let best: BankPrefix | null = null;
  for (const candidate of prefixes) {
    if (!digits.startsWith(candidate.prefix)) continue;
    if (best === null || candidate.prefix.length > best.prefix.length) best = candidate;
  }
  return best?.bankName ?? null;
}
