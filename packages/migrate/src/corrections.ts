/**
 * Deliberate corrections applied to legacy data during migration.
 *
 * A migration that silently repairs data is indistinguishable from one that
 * silently corrupts it. Every correction lives here, with the evidence that
 * justified it and where the underlying bug is reported, so the list can be
 * reviewed as a whole and any entry can be challenged.
 *
 * Rules:
 *  - Never correct an amount. Money is carried over exactly, always.
 *  - A correction must be provable from the data, not merely plausible.
 *  - Anything not listed here that fails validation stops the migration.
 */

export interface Correction {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  readonly reference: string;
}

/**
 * Card numbers recorded wrongly in the payment hub.
 *
 * `5054161716277062` fails the Luhn check digit, so no such bank card can
 * exist. The bot's `5054161706277062` passes, belongs to the same owner
 * (هنرمندنسب) at the same bank, and received five real payments of which four
 * settled. All 25 bot cards and 25 of 26 hub cards pass Luhn; this was the only
 * failure in either system.
 */
export const CARD_DIGIT_CORRECTIONS: readonly Correction[] = [
  {
    from: '5054161716277062',
    to: '5054161706277062',
    reason: 'fails Luhn; the bot copy passes and took four settled payments',
    reference: 'BUGS-FOR-ADMIN.md item 4',
  },
];

const CARD_MAP = new Map(CARD_DIGIT_CORRECTIONS.map((c) => [c.from, c]));

export function correctCardDigits(digits: string): string {
  return CARD_MAP.get(digits)?.to ?? digits;
}

export function cardCorrectionFor(digits: string): Correction | undefined {
  return CARD_MAP.get(digits);
}
