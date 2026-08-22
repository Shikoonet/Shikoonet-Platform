import { describe, expect, it } from 'vitest';
import { WAITING_TIMEOUT_MS } from '@shikoo/contracts';
import {
  evaluateClaimForAutoVerification,
  type MirzabotClaimCandidate,
  type MirzabotTxCandidate,
} from '../src/mirzabotMatch.js';

const BASE_MS = 1_786_091_200_000;
const RECEIPT_MS = BASE_MS + 5_000;

function claim(over: Partial<MirzabotClaimCandidate> = {}): MirzabotClaimCandidate {
  return {
    id: 'c1',
    sourceSystem: 'MIRZABOT',
    status: 'PENDING',
    externalOrderId: 'mirzabot:test:ord-1',
    expectedAmountIrr: 1_000_000,
    targetFinancialAccountId: 'acc-a',
    paidClickedAt: BASE_MS,
    receiptSubmittedAt: RECEIPT_MS,
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
    bankTimestamp: RECEIPT_MS + 20_000,
    consumed: false,
    processingDisposition: 'ACTIONABLE',
    ...over,
  };
}

function decide(
  c: MirzabotClaimCandidate,
  txs: MirzabotTxCandidate[],
  peers: MirzabotClaimCandidate[] = [],
  now = RECEIPT_MS + WAITING_TIMEOUT_MS + 1,
) {
  return evaluateClaimForAutoVerification(c, txs, peers, { now });
}

describe('10-minute waiting / Suspected Fake projection', () => {
  it('1 NEW RECEIPT — no transaction → WAITING', () => {
    const d = decide(claim(), [], [], RECEIPT_MS + 1_000);
    expect(d.decision).toBe('WAIT');
    expect(d.reason).toBe('AWAITING_BANK_SMS');
  });

  it('2 at 9m59s with no transaction → WAITING', () => {
    const d = decide(claim(), [], [], RECEIPT_MS + 9 * 60_000 + 59_000);
    expect(d.decision).toBe('WAIT');
  });

  it('3 exactly 10m with no bank evidence → NO_TRANSACTION_AFTER_10M', () => {
    const d = decide(claim(), [], [], RECEIPT_MS + WAITING_TIMEOUT_MS);
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('NO_TRANSACTION_AFTER_10M');
  });

  it('4 at 10m01s with no bank evidence → NO_TRANSACTION_AFTER_10M', () => {
    const d = decide(claim(), [], [], RECEIPT_MS + WAITING_TIMEOUT_MS + 1_000);
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('NO_TRANSACTION_AFTER_10M');
  });

  it('5 unique transaction within auto window → AUTO_VERIFIED (never Suspected Fake)', () => {
    const d = decide(claim(), [tx()], [], RECEIPT_MS + 30_000);
    expect(d.decision).toBe('AUTO_VERIFY');
  });

  it('6 transaction arrives while waiting → AUTO_VERIFIED when unique in window', () => {
    const d = decide(
      claim(),
      [tx({ bankTimestamp: RECEIPT_MS + 15_000 })],
      [],
      RECEIPT_MS + 20_000,
    );
    expect(d.decision).toBe('AUTO_VERIFY');
  });

  it('7 ambiguous transactions after 10m → NEEDS_REVIEW not Suspected Fake', () => {
    const d = decide(
      claim(),
      [
        tx({ id: 't1', bankTimestamp: RECEIPT_MS + 10_000 }),
        tx({ id: 't2', bankTimestamp: RECEIPT_MS + 20_000 }),
      ],
      [],
      RECEIPT_MS + WAITING_TIMEOUT_MS + 60_000,
    );
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('AMBIGUOUS_TRANSACTIONS');
  });

  it('8 outside 5m transaction after 10m → OUTSIDE_AUTO_MATCH_WINDOW not Suspected Fake', () => {
    const d = decide(
      claim(),
      [tx({ bankTimestamp: RECEIPT_MS + 6 * 60_000 })],
      [],
      RECEIPT_MS + WAITING_TIMEOUT_MS + 60_000,
    );
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('OUTSIDE_AUTO_MATCH_WINDOW');
  });

  it('9 amount mismatch evidence → NEEDS_REVIEW not automatic Fake', () => {
    const d = decide(
      claim(),
      [tx({ amountIrr: 1_100_000, bankTimestamp: RECEIPT_MS + 10_000 })],
      [],
      RECEIPT_MS + WAITING_TIMEOUT_MS + 60_000,
    );
    expect(d.decision).toBe('SUGGEST');
    expect(d.reason).toBe('AMOUNT_MISMATCH');
  });

  it('11 late SMS after Suspected Fake classification → moves to Needs Review state', () => {
    const c = claim();
    const after10m = decide(c, [], [], RECEIPT_MS + WAITING_TIMEOUT_MS + 1_000);
    expect(after10m.reason).toBe('NO_TRANSACTION_AFTER_10M');
    const afterLateSms = decide(
      c,
      [tx({ bankTimestamp: RECEIPT_MS + 6 * 60_000 })],
      [],
      RECEIPT_MS + WAITING_TIMEOUT_MS + 120_000,
    );
    expect(afterLateSms.reason).toBe('OUTSIDE_AUTO_MATCH_WINDOW');
  });

  it('never assigns FAKE_RECEIPT automatically', () => {
    const scenarios = [
      decide(claim(), [], [], RECEIPT_MS + WAITING_TIMEOUT_MS + 1_000),
      decide(
        claim(),
        [tx({ bankTimestamp: RECEIPT_MS + 120_000 })],
        [],
        RECEIPT_MS + WAITING_TIMEOUT_MS + 1_000,
      ),
      decide(
        claim({ cardMappingCount: 0, targetFinancialAccountId: null }),
        [],
        [],
        RECEIPT_MS + WAITING_TIMEOUT_MS + 1_000,
      ),
    ];
    for (const d of scenarios) {
      expect(d.reason).not.toBe('FAKE_RECEIPT');
      expect(['SUGGEST', 'WAIT', 'AUTO_VERIFY']).toContain(d.decision);
    }
  });

  it('timer reevaluation is idempotent once Suspected Fake is recorded', () => {
    const c = claim();
    const after10m = decide(c, [], [], RECEIPT_MS + WAITING_TIMEOUT_MS + 1_000);
    expect(after10m.reason).toBe('NO_TRANSACTION_AFTER_10M');
    const again = decide(c, [], [], RECEIPT_MS + WAITING_TIMEOUT_MS + 120_000);
    expect(again.reason).toBe('NO_TRANSACTION_AFTER_10M');
    expect(again.decision).toBe('SUGGEST');
  });
});
