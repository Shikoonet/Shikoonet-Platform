import { describe, expect, it } from 'vitest';
import {
  isManualVerificationReopenEligible,
  extractRevertSnapshot,
  encodeRevertSnapshotForMatch,
} from '../src/revertMirzabotManualVerification.js';

describe('reopenMirzabotManualVerification helpers', () => {
  it('detects reopen eligibility from ADMIN_MANUAL snapshot', () => {
    const snapshot = encodeRevertSnapshotForMatch({
      claimStatus: 'PENDING',
      suspectReason: 'AMBIGUOUS_CLAIMS',
      suspectMetadataJson: '{}',
    });
    expect(
      isManualVerificationReopenEligible({
        claimStatus: 'VERIFIED',
        matchStatus: 'CONFIRMED',
        mismatchReasonsJson: snapshot,
        metadataJson: '{}',
      }),
    ).toBe(true);
    expect(
      isManualVerificationReopenEligible({
        claimStatus: 'VERIFIED',
        matchStatus: 'AUTO_VERIFIED',
        mismatchReasonsJson: snapshot,
        metadataJson: '{}',
      }),
    ).toBe(false);
  });

  it('reads snapshot from metadata for verify-without-transaction', () => {
    const metadata = JSON.stringify({
      telegramUserId: '1',
      _revertSnapshot: {
        claimStatus: 'MATCH_SUGGESTED',
        suspectReason: 'NO_TRANSACTION',
        suspectMetadataJson: '{}',
      },
    });
    expect(extractRevertSnapshot(null, metadata)?.claimStatus).toBe('MATCH_SUGGESTED');
    expect(
      isManualVerificationReopenEligible({
        claimStatus: 'VERIFIED',
        matchStatus: null,
        metadataJson: metadata,
      }),
    ).toBe(true);
  });
});
