import { describe, expect, it } from 'vitest';
import { AUTO_MATCH_MAX_TIME_DELTA_MS, WAITING_TIMEOUT_MS } from '@shikoo/contracts';
import {
  evaluateClaimForAutoVerification,
  evaluateMirzabotGroup,
  type MirzabotClaimCandidate,
  type MirzabotDecision,
  type MirzabotTxCandidate,
} from '../src/mirzabotMatch.js';
import { normalizeCardDigits, tomanToIrr } from '../src/cardNormalize.js';

const BASE_MS = 1_786_091_200_000;
/** Past the 10-minute waiting period so no-transaction cases settle. */
const LATER = BASE_MS + 11 * 60_000;

function claim(over: Partial<MirzabotClaimCandidate> = {}): MirzabotClaimCandidate {
  return {
    id: 'c1',
    sourceSystem: 'MIRZABOT',
    status: 'PENDING',
    externalOrderId: 'mirzabot:test:ord-1',
    expectedAmountIrr: 1_000_000,
    targetFinancialAccountId: 'acc-a',
    paidClickedAt: BASE_MS,
    receiptSubmittedAt: BASE_MS,
    accountStatus: 'ACTIVE',
    cardMappingCount: 1,
    ...over,
  };
}

function tx(over: Partial<MirzabotTxCandidate> = {}): MirzabotTxCandidate {
  return {
    id: 't1',
    direction: 'CREDIT',
    amountIrr: 1_000_000,
    financialAccountId: 'acc-a',
    bankTimestamp: BASE_MS + 20_000,
    consumed: false,
    processingDisposition: 'ACTIONABLE',
    ...over,
  };
}

function decide(
  c: MirzabotClaimCandidate,
  txs: MirzabotTxCandidate[],
  peers: MirzabotClaimCandidate[] = [],
  now = LATER,
): MirzabotDecision {
  return evaluateClaimForAutoVerification(c, txs, peers, { now });
}

describe('PHASE 6 — decision test matrix', () => {
  it('TEST 1 unique happy path → AUTO_VERIFY', () => {
    const d = decide(claim(), [tx()]);
    expect(d.decision).toBe('AUTO_VERIFY');
    expect(d.reason).toBe('UNIQUE_EXACT_MATCH');
    expect(d.transactionId).toBe('t1');
    expect(d.diagnostics.timeDeltaMs).toBe(20_000);
  });

  it('TEST 2 delta 4m59s → AUTO_VERIFY', () => {
    const d = decide(claim(), [tx({ bankTimestamp: BASE_MS + 4 * 60_000 + 59_000 })]);
    expect(d.decision).toBe('AUTO_VERIFY');
  });

  it('TEST 3 delta exactly 5m → AUTO_VERIFY', () => {
    const d = decide(claim(), [tx({ bankTimestamp: BASE_MS + 5 * 60_000 })]);
    expect(d.decision).toBe('AUTO_VERIFY');
    expect(d.diagnostics.timeDeltaMs).toBe(5 * 60_000);
  });

  it('TEST 4 delta 5m01s → SUGGEST OUTSIDE_AUTO_MATCH_WINDOW', () => {
    const d = decide(claim(), [tx({ bankTimestamp: BASE_MS + 5 * 60_000 + 1_000 })]);
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('OUTSIDE_AUTO_MATCH_WINDOW');
    expect(d.diagnostics.timeDeltaMs).toBe(5 * 60_000 + 1_000);
  });

  it('TEST 5 wrong account → not auto', () => {
    const d = decide(claim(), [tx({ financialAccountId: 'acc-b' })]);
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('NO_TRANSACTION_AFTER_10M');
  });

  it('TEST 6 wrong amount → not auto', () => {
    const d = decide(claim(), [tx({ amountIrr: 1_100_000 })]);
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('AMOUNT_MISMATCH');
  });

  it('TEST 6b one rial off is still a mismatch (no tolerance)', () => {
    const d = decide(claim(), [tx({ amountIrr: 1_000_001 })]);
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('AMOUNT_MISMATCH');
  });

  it('TEST 7 two transactions for one claim → AMBIGUOUS_TRANSACTIONS', () => {
    const d = decide(claim(), [
      tx({ id: 't1', bankTimestamp: BASE_MS + 10_000 }),
      tx({ id: 't2', bankTimestamp: BASE_MS + 30_000 }),
    ]);
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('AMBIGUOUS_TRANSACTIONS');
    expect(d.diagnostics.eligibleTransactionCount).toBe(2);
  });

  it('TEST 8 two claims for one transaction → AMBIGUOUS_CLAIMS', () => {
    const c1 = claim({ id: 'c1' });
    const c2 = claim({ id: 'c2', externalOrderId: 'ord-2', paidClickedAt: BASE_MS + 1_000 });
    const d = decide(c1, [tx()], [c2]);
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('AMBIGUOUS_CLAIMS');
    expect(d.diagnostics.competingClaimIds).toEqual(['c2']);
  });

  it('TEST 9 two claims / two transactions all overlapping → no auto verify', () => {
    const c1 = claim({ id: 'c1', paidClickedAt: BASE_MS });
    const c2 = claim({ id: 'c2', externalOrderId: 'ord-2', paidClickedAt: BASE_MS + 10_000 });
    const t1 = tx({ id: 't1', bankTimestamp: BASE_MS + 20_000 });
    const t2 = tx({ id: 't2', bankTimestamp: BASE_MS + 30_000 });
    const all = evaluateMirzabotGroup([c1, c2], [t1, t2], { now: LATER });
    expect(all.every((d) => d.decision === 'SUGGEST')).toBe(true);
    expect(all.every((d) => d.reason === 'AMBIGUOUS_TRANSACTIONS')).toBe(true);
  });

  it('TEST 10 closest time must not win', () => {
    const c1 = claim({ id: 'c1', paidClickedAt: BASE_MS + 15_000 }); // delta 5s
    const c2 = claim({ id: 'c2', externalOrderId: 'ord-2', paidClickedAt: BASE_MS - 30_000 }); // delta 50s
    const all = evaluateMirzabotGroup([c1, c2], [tx()], { now: LATER });
    expect(all.every((d) => d.decision === 'SUGGEST')).toBe(true);
    expect(all.every((d) => d.reason === 'AMBIGUOUS_CLAIMS')).toBe(true);
  });

  it('TEST 10b decision does not depend on claim ordering', () => {
    const c1 = claim({ id: 'c1', paidClickedAt: BASE_MS + 15_000 });
    const c2 = claim({ id: 'c2', externalOrderId: 'ord-2', paidClickedAt: BASE_MS - 30_000 });
    const forward = evaluateMirzabotGroup([c1, c2], [tx()], { now: LATER });
    const reverse = evaluateMirzabotGroup([c2, c1], [tx()], { now: LATER });
    const norm = (ds: MirzabotDecision[]) =>
      [...ds]
        .sort((a, b) => a.claimId.localeCompare(b.claimId))
        .map((d) => [d.claimId, d.decision, d.reason]);
    expect(norm(forward)).toEqual(norm(reverse));
  });

  it('TEST 11 different accounts → both auto verify independently', () => {
    const c1 = claim({ id: 'c1', targetFinancialAccountId: 'acc-a' });
    const c2 = claim({ id: 'c2', externalOrderId: 'ord-2', targetFinancialAccountId: 'acc-b' });
    const t1 = tx({ id: 't1', financialAccountId: 'acc-a' });
    const t2 = tx({ id: 't2', financialAccountId: 'acc-b' });
    const all = evaluateMirzabotGroup([c1, c2], [t1, t2], { now: LATER });
    expect(all.filter((d) => d.decision === 'AUTO_VERIFY')).toHaveLength(2);
  });

  it('TEST 12 same account different amounts → both auto verify', () => {
    const c1 = claim({ id: 'c1', expectedAmountIrr: 1_000_000 });
    const c2 = claim({ id: 'c2', externalOrderId: 'ord-2', expectedAmountIrr: 2_000_000 });
    const t1 = tx({ id: 't1', amountIrr: 1_000_000 });
    const t2 = tx({ id: 't2', amountIrr: 2_000_000 });
    const all = evaluateMirzabotGroup([c1, c2], [t1, t2], { now: LATER });
    expect(all.filter((d) => d.decision === 'AUTO_VERIFY')).toHaveLength(2);
  });

  it('TEST 13 transaction already consumed → not auto', () => {
    const d = decide(claim(), [tx({ consumed: true })]);
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('TRANSACTION_ALREADY_CONSUMED');
  });

  it('TEST 14 order already verified → not auto', () => {
    const d = decide(claim({ orderAlreadyVerified: true }), [tx()]);
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('DUPLICATE_ORDER');
  });

  it('TEST 14b terminal claim status is never re-verified', () => {
    for (const status of ['VERIFIED', 'REJECTED', 'FAKE_RECEIPT', 'EXPIRED']) {
      const d = decide(claim({ status }), [tx()]);
      expect(d.decision).toBe('SUGGEST');
    }
  });

  it('TEST 16 muted account → ACCOUNT_NOT_ACTIVE', () => {
    for (const accountStatus of ['MUTED', 'PENDING', 'DECLINED'] as const) {
      const d = decide(claim({ accountStatus }), [tx()]);
      expect(d.decision).toBe('SUGGEST');
      expect(d.reason).toBe('ACCOUNT_NOT_ACTIVE');
    }
  });

  it('TEST 17 unmapped card → UNMAPPED_CARD', () => {
    const d = decide(claim({ cardMappingCount: 0, targetFinancialAccountId: null }), [tx()]);
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('UNMAPPED_CARD');
  });

  it('TEST 17b card mapped to several accounts → AMBIGUOUS_CARD_MAPPING', () => {
    const d = decide(claim({ cardMappingCount: 2 }), [tx()]);
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('AMBIGUOUS_CARD_MAPPING');
  });

  it('TEST 18 bank SMS 25s before click → eligible', () => {
    const d = decide(claim({ paidClickedAt: BASE_MS + 30_000 }), [
      tx({ bankTimestamp: BASE_MS + 5_000 }),
    ]);
    expect(d.decision).toBe('AUTO_VERIFY');
    expect(d.diagnostics.timeDeltaMs).toBe(25_000);
  });

  it('TEST 19 bank SMS 5m01s before click → SUGGEST', () => {
    const d = decide(claim({ paidClickedAt: BASE_MS + 5 * 60_000 + 1_000 }), [
      tx({ bankTimestamp: BASE_MS }),
    ]);
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('OUTSIDE_AUTO_MATCH_WINDOW');
  });

  it('TEST 20 competing claim at 5m01s is not a competitor → AUTO_VERIFY', () => {
    const t1 = tx({ id: 't1', bankTimestamp: BASE_MS + 30_000 });
    const c1 = claim({ id: 'c1', paidClickedAt: BASE_MS });
    const c2 = claim({
      id: 'c2',
      externalOrderId: 'ord-2',
      paidClickedAt: BASE_MS + 30_000 + 5 * 60_000 + 1_000,
    });
    const all = evaluateMirzabotGroup([c1, c2], [t1], { now: LATER });
    const d1 = all.find((d) => d.claimId === 'c1')!;
    const d2 = all.find((d) => d.claimId === 'c2')!;
    expect(d1.decision).toBe('AUTO_VERIFY');
    expect(d2.decision).toBe('SUGGEST');
    expect(d2.reason).toBe('OUTSIDE_AUTO_MATCH_WINDOW');
  });

  it('TEST 21 two orders from the same user are evaluated independently', () => {
    const c1 = claim({ id: 'c1', externalOrderId: 'ord-1', targetFinancialAccountId: 'acc-a' });
    const c2 = claim({ id: 'c2', externalOrderId: 'ord-2', targetFinancialAccountId: 'acc-b' });
    const all = evaluateMirzabotGroup(
      [c1, c2],
      [
        tx({ id: 't1', financialAccountId: 'acc-a' }),
        tx({ id: 't2', financialAccountId: 'acc-b' }),
      ],
      { now: LATER },
    );
    expect(all.filter((d) => d.decision === 'AUTO_VERIFY')).toHaveLength(2);
    expect(new Set(all.map((d) => d.transactionId)).size).toBe(2);
  });

  it('TEST 22 a second order cannot reuse a transaction already spent', () => {
    const c2 = claim({ id: 'c2', externalOrderId: 'ord-2' });
    const d = decide(c2, [tx({ consumed: true })]);
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('TRANSACTION_ALREADY_CONSUMED');
  });

  it('window constant is exactly 5 minutes', () => {
    expect(AUTO_MATCH_MAX_TIME_DELTA_MS).toBe(5 * 60_000);
  });
});

describe('WAIT vs Suspected Fake', () => {
  it('holds while within the 10-minute waiting period', () => {
    const d = decide(claim(), [], [], BASE_MS + 10_000);
    expect(d.decision).toBe('WAIT');
    expect(d.reason).toBe('AWAITING_BANK_SMS');
  });

  it('waits until just before the 10-minute edge', () => {
    const d = decide(claim(), [], [], BASE_MS + WAITING_TIMEOUT_MS - 1);
    expect(d.decision).toBe('WAIT');
  });

  it('settles on NO_TRANSACTION_AFTER_10M at the 10-minute edge', () => {
    const d = decide(claim(), [], [], BASE_MS + WAITING_TIMEOUT_MS);
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('NO_TRANSACTION_AFTER_10M');
  });

  it('never waits when the blocking reason cannot change with time', () => {
    const d = decide(
      claim({ cardMappingCount: 0, targetFinancialAccountId: null }),
      [],
      [],
      BASE_MS,
    );
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('UNMAPPED_CARD');
  });
});

describe('PHASE 7 — invariants', () => {
  const autoScenarios: {
    name: string;
    claims: MirzabotClaimCandidate[];
    txs: MirzabotTxCandidate[];
  }[] = [
    { name: 'single pair', claims: [claim()], txs: [tx()] },
    {
      name: 'two isolated pairs',
      claims: [
        claim({ id: 'c1' }),
        claim({ id: 'c2', externalOrderId: 'o2', targetFinancialAccountId: 'acc-b' }),
      ],
      txs: [tx({ id: 't1' }), tx({ id: 't2', financialAccountId: 'acc-b' })],
    },
  ];

  it('INVARIANT A: a transaction is auto-verified for at most one claim', () => {
    for (const s of autoScenarios) {
      const auto = evaluateMirzabotGroup(s.claims, s.txs, { now: LATER }).filter(
        (d) => d.decision === 'AUTO_VERIFY',
      );
      const txIds = auto.map((d) => d.transactionId);
      expect(new Set(txIds).size).toBe(txIds.length);
    }
  });

  it('INVARIANT B: an order is auto-verified at most once', () => {
    const auto = evaluateMirzabotGroup([claim(), claim()], [tx()], { now: LATER }).filter(
      (d) => d.decision === 'AUTO_VERIFY',
    );
    expect(auto.length).toBeLessThanOrEqual(1);
  });

  it('INVARIANT C: AUTO_VERIFY implies exactly one eligible tx and one claim', () => {
    for (const s of autoScenarios) {
      for (const d of evaluateMirzabotGroup(s.claims, s.txs, { now: LATER })) {
        if (d.decision !== 'AUTO_VERIFY') continue;
        expect(d.diagnostics.eligibleTransactionCount).toBe(1);
        expect(d.diagnostics.competingClaimCount).toBe(1);
      }
    }
  });

  it('INVARIANT D: AUTO_VERIFY implies timeDelta <= 5 minutes', () => {
    for (let delta = 0; delta <= 10 * 60_000; delta += 30_000) {
      const d = decide(claim(), [tx({ bankTimestamp: BASE_MS + delta })]);
      if (d.decision === 'AUTO_VERIFY') {
        expect(d.diagnostics.timeDeltaMs!).toBeLessThanOrEqual(AUTO_MATCH_MAX_TIME_DELTA_MS);
      } else {
        expect(delta).toBeGreaterThan(AUTO_MATCH_MAX_TIME_DELTA_MS);
      }
    }
  });

  it('INVARIANT E: AUTO_VERIFY implies exact amount, account and CREDIT direction', () => {
    const variants: Partial<MirzabotTxCandidate>[] = [
      { amountIrr: 999_999 },
      { amountIrr: 1_000_001 },
      { financialAccountId: 'acc-b' },
      { financialAccountId: null },
      { direction: 'DEBIT' },
      { direction: 'UNKNOWN' },
      { processingDisposition: 'NON_ACTIONABLE' },
      { bankTimestamp: null },
      { amountIrr: null },
    ];
    for (const v of variants) {
      expect(decide(claim(), [tx(v)]).decision).not.toBe('AUTO_VERIFY');
    }
  });

  it('INVARIANT F: adding a competing claim downgrades AUTO_VERIFY to SUGGEST', () => {
    const base = decide(claim(), [tx()]);
    expect(base.decision).toBe('AUTO_VERIFY');
    const withPeer = decide(
      claim(),
      [tx()],
      [claim({ id: 'c2', externalOrderId: 'ord-2', paidClickedAt: BASE_MS + 5_000 })],
    );
    expect(withPeer.decision).toBe('SUGGEST');
    expect(withPeer.reason).toBe('AMBIGUOUS_CLAIMS');
  });

  it('INVARIANT F: adding a competing transaction downgrades AUTO_VERIFY to SUGGEST', () => {
    const withExtraTx = decide(claim(), [
      tx({ id: 't1' }),
      tx({ id: 't2', bankTimestamp: BASE_MS + 40_000 }),
    ]);
    expect(withExtraTx.decision).toBe('SUGGEST');
    expect(withExtraTx.reason).toBe('AMBIGUOUS_TRANSACTIONS');
  });

  it('INVARIANT F holds across every single-addition permutation', () => {
    // Both peers sit inside ±5m of the transaction at BASE_MS + 20s, so each
    // one genuinely contends for it.
    const extraClaims = [
      claim({ id: 'x1', externalOrderId: 'ox1', paidClickedAt: BASE_MS - 40_000 }),
      claim({ id: 'x2', externalOrderId: 'ox2', paidClickedAt: BASE_MS + 80_000 }),
    ];
    const extraTxs = [
      tx({ id: 'y1', bankTimestamp: BASE_MS - 60_000 }),
      tx({ id: 'y2', bankTimestamp: BASE_MS + 60_000 }),
    ];
    for (const extra of extraClaims) {
      expect(decide(claim(), [tx()], [extra]).decision).toBe('SUGGEST');
    }
    for (const extra of extraTxs) {
      expect(decide(claim(), [tx(), extra]).decision).toBe('SUGGEST');
    }
  });

  it('never auto-rejects and never marks a receipt fake', () => {
    const scenarios: MirzabotDecision[] = [
      decide(claim(), []),
      decide(claim(), [tx({ amountIrr: 5 })]),
      decide(claim(), [tx({ bankTimestamp: BASE_MS + 999_000 })]),
      decide(claim({ accountStatus: 'MUTED' }), [tx()]),
      decide(claim({ cardMappingCount: 0, targetFinancialAccountId: null }), [tx()]),
    ];
    for (const d of scenarios) {
      expect(['SUGGEST', 'WAIT']).toContain(d.decision);
      expect(d.reason).not.toBe('FAKE_RECEIPT');
    }
  });
});

describe('cardNormalize', () => {
  it('normalizes card formats', () => {
    expect(normalizeCardDigits('6037997512345678')).toBe('6037997512345678');
    expect(normalizeCardDigits('6037-9975-1234-5678')).toBe('6037997512345678');
    expect(normalizeCardDigits('6037 9975 1234 5678')).toBe('6037997512345678');
  });

  it('toman to IRR', () => {
    expect(tomanToIrr(195_000)).toBe(1_950_000);
  });
});
