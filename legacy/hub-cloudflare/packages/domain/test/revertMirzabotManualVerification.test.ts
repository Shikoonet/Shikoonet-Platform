import { describe, expect, it } from 'vitest';
import {
  isManualVerificationRevertEligible,
  extractRevertSnapshot,
  encodeRevertSnapshotForMatch,
  encodeRevertSnapshotForMetadata,
} from '../src/revertMirzabotManualVerification.js';

describe('revertMirzabotManualVerification helpers', () => {
  it('detects revert eligibility from match snapshot', () => {
    const snapshot = encodeRevertSnapshotForMatch({
      claimStatus: 'PENDING',
      suspectReason: 'AMBIGUOUS_CLAIMS',
      suspectMetadataJson: '{}',
    });
    expect(
      isManualVerificationRevertEligible({
        claimStatus: 'VERIFIED',
        matchStatus: 'CONFIRMED',
        mismatchReasonsJson: snapshot,
        metadataJson: '{}',
      }),
    ).toBe(true);
    expect(
      isManualVerificationRevertEligible({
        claimStatus: 'VERIFIED',
        matchStatus: 'AUTO_VERIFIED',
        mismatchReasonsJson: snapshot,
        metadataJson: '{}',
      }),
    ).toBe(false);
    expect(
      isManualVerificationRevertEligible({
        claimStatus: 'PENDING',
        matchStatus: 'CONFIRMED',
        mismatchReasonsJson: snapshot,
        metadataJson: '{}',
      }),
    ).toBe(false);
  });

  it('reads snapshot from metadata for verify-without-transaction', () => {
    const metadata = encodeRevertSnapshotForMetadata('{"telegramUserId":"1"}', {
      claimStatus: 'MATCH_SUGGESTED',
      suspectReason: 'NO_TRANSACTION',
      suspectMetadataJson: '{"candidateTransactionIds":[]}',
    });
    const snapshot = extractRevertSnapshot(null, metadata);
    expect(snapshot?.claimStatus).toBe('MATCH_SUGGESTED');
    expect(snapshot?.suspectReason).toBe('NO_TRANSACTION');
    expect(
      isManualVerificationRevertEligible({
        claimStatus: 'VERIFIED',
        matchStatus: null,
        metadataJson: metadata,
      }),
    ).toBe(true);
  });
});
