/** Mirzabot integration wire types (TEST). */

export const MIRZABOT_SOURCE = 'MIRZABOT' as const;
export const MIRZABOT_CLAIMS_PATH = '/api/v1/integrations/mirzabot/claims';

/** API auth replay window (NOT the payment auto-match window). */
export const INTEGRATION_REPLAY_WINDOW_MS = 5 * 60 * 1000;

/** Strict auto-match payment window (±5 minutes from paid_clicked_at). */
export const AUTO_MATCH_MAX_TIME_DELTA_MS = 5 * 60 * 1000;

/** Receipt waiting period before a no-evidence claim becomes Suspected Fake. */
export const WAITING_TIMEOUT_MS = 10 * 60 * 1000;

export type SuspectReason =
  | 'NO_TRANSACTION'
  | 'NO_TRANSACTION_AFTER_10M'
  | 'UNMAPPED_CARD'
  | 'AMBIGUOUS_CARD_MAPPING'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'AMOUNT_MISMATCH'
  | 'OUTSIDE_AUTO_MATCH_WINDOW'
  | 'AMBIGUOUS_CLAIMS'
  | 'AMBIGUOUS_TRANSACTIONS'
  | 'TRANSACTION_ALREADY_CONSUMED'
  | 'DUPLICATE_ORDER'
  | 'DUPLICATE_EVENT'
  | 'RECEIPT_REUSED'
  | 'PARSER_FAILURE_NEARBY'
  | 'INTEGRATION_ERROR';

export interface MirzabotClaimPayload {
  eventId: string;
  source: typeof MIRZABOT_SOURCE;
  orderId: string;
  telegramUserId: string;
  telegramUsername?: string;
  amountToman: number;
  expectedAmountIrr: number;
  cardNumber: string;
  paidClickedAt: number;
  receiptSubmittedAt: number;
  receipt?: {
    telegramFileUniqueId?: string;
  };
}

export interface MirzabotVerifiedWebhook {
  eventId: string;
  type: 'payment.verified';
  externalOrderId: string;
  mirzabotOrderId: string;
  claimId: string;
  matchId: string;
  transactionId: string;
  expectedAmountIrr: number;
  matchedAmountIrr: number;
  verificationMode: 'AUTO_VERIFIED' | 'ADMIN_APPROVED';
  verifiedAt: number;
}
