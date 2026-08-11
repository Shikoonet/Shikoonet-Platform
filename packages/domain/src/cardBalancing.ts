/**
 * Pure card-assignment balancing sort (mirrors Mirzabot cardAssignmentPickLeastUsed).
 */

export interface CardBalancingCandidate {
  cardNumber: string;
  successfulToday: number;
  successful7d: number;
  successfulLifetime: number;
  assignmentsToday: number;
  lastAssignedAt: number;
}

// `as const` keeps these narrowed to the numeric fields. Annotating them as
// `keyof CardBalancingCandidate` widens the union to include `cardNumber`,
// which makes the subtraction below a type error.
const SORT_KEYS = [
  'successfulToday',
  'successful7d',
  'successfulLifetime',
  'assignmentsToday',
  'lastAssignedAt',
] as const satisfies ReadonlyArray<keyof CardBalancingCandidate>;

export function pickLeastUsedCard(cards: CardBalancingCandidate[]): CardBalancingCandidate | null {
  if (cards.length === 0) return null;
  const sorted = [...cards].sort((a, b) => {
    for (const key of SORT_KEYS) {
      if (a[key] !== b[key]) return a[key] - b[key];
    }
    return a.cardNumber.localeCompare(b.cardNumber);
  });
  return sorted[0] ?? null;
}

export function cardBalancingDistribution(counts: number[]): {
  min: number;
  max: number;
  gap: number;
} {
  if (counts.length === 0) return { min: 0, max: 0, gap: 0 };
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  return { min, max, gap: max - min };
}
