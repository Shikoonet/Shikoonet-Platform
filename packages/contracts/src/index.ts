/**
 * Wire types shared between the ingest worker, dashboard worker, and packages.
 *
 * `IncomingSmsBody` is the exact JSON shape the unmodified SMS Relay app
 * sends — see docs/current-app-contract.md. The Android app cannot send
 * custom headers or signed requests, so the bearer token lives in the body.
 */

export * from './env.js';
export * from './device-auth.js';
export * from './money.js';
export * from './adminPermissions.js';
export * from './customEmoji.js';
export * from './premiumEmoji.js';
export * from './mirzabot.js';
export * from './botTexts.js';
export * from './reportTopics.js';
export * from './botKeyboard.js';
export * from './planLabel.js';
export * from './catalogLayout.js';
export * from './jalali.js';
export * from './cardActivity.js';
export * from './historyRange.js';
export * from './sellable.js';
export * from './configName.js';
export * from './receipt.js';
export * from './channelPost.js';
export * from './cronJobs.js';

export const INGEST_PATH = '/api/v1/sms';
export const MAX_BODY_BYTES = 8 * 1024; // 8 KB hard cap

export type Classification =
  | 'BANK_CREDIT'
  | 'BANK_DEBIT'
  | 'BANK_TRANSACTION'
  | 'BALANCE'
  | 'OTP'
  | 'PROMOTIONAL'
  | 'UNKNOWN'
  | 'IGNORED';

export type Direction = 'CREDIT' | 'DEBIT' | 'UNKNOWN';

export type TransactionStatus =
  | 'PARSED'
  | 'NEEDS_REVIEW'
  | 'MATCH_SUGGESTED'
  | 'MATCHED'
  | 'APPROVED'
  | 'REJECTED'
  | 'IGNORED'
  | 'ERROR';

export type ClaimStatus =
  | 'PENDING'
  | 'MATCH_SUGGESTED'
  | 'VERIFIED'
  /**
   * Delivered, and still owed an explanation.
   *
   * The customer has their account and the shop has not seen the money. Reached
   * only by a manual approval or by Continuity mode — never by the matcher — and
   * it is deliberately NOT a flag on `VERIFIED`: every revenue query in the app
   * filters `status = 'VERIFIED'`, and a flag would have shipped revenue the
   * bank never confirmed. It leaves for `VERIFIED` when a bank credit is matched
   * to it afterwards, which is reconciliation, not a second sale.
   */
  | 'FULFILLED_UNRECONCILED'
  | 'REJECTED'
  | 'FAKE_RECEIPT'
  | 'EXPIRED';

export type MatchStatus = 'SUGGESTED' | 'CONFIRMED' | 'REJECTED' | 'AUTO_VERIFIED';

export type RejectionReason =
  | 'FAKE_RECEIPT'
  | 'NO_BANK_TRANSACTION'
  | 'DUPLICATE'
  | 'WRONG_AMOUNT'
  | 'WRONG_ACCOUNT'
  | 'EXPIRED'
  | 'REFUNDED'
  | 'TEST_PAYMENT'
  | 'OTHER';

export type AccessRole = 'ADMIN' | 'REVIEWER' | 'READ_ONLY';

/** Body posted by SMS Relay (Android) or Apple Shortcuts (iPhone). */
export interface IncomingSmsBody {
  apiKey: string;
  deviceId: string;
  deviceName: string;
  message: string;
  sender: string;
  /** Normalized epoch milliseconds as string; server time when client omitted it. */
  timestamp: string;
  /** Android MD5 hex; empty string when omitted (iPhone). */
  checksum: string;
}

export interface IngestOk {
  ok: true;
  eventId: string;
  duplicate: boolean;
  status: 'received' | 'already_received';
}

export interface IngestErr {
  ok: false;
  error: string;
  code: 'BAD_REQUEST' | 'UNAUTHORIZED' | 'RATE_LIMITED' | 'PAYLOAD_TOO_LARGE' | 'INTERNAL';
}

export type IngestResponse = IngestOk | IngestErr;

export interface ParseResult {
  matched: boolean;
  classification: Classification;
  direction: Direction;
  amountIrr: number | null;
  balanceIrr: number | null;
  accountHint: string | null;
  transactionReference: string | null;
  confidence: number; // 0..1
  parserId: string | null;
  parserVersion: string | null;
  evidence: Record<string, unknown>;
  warnings: string[];
}

export interface NormalizedSms {
  raw: string;
  text: string;
  sender: string;
  timestamp: number; // epoch ms
  deviceId: string;
}

export interface AuditAction {
  actorEmail: string | null; // null for system actions (ingestion)
  actorRole: AccessRole | 'SYSTEM';
  action: string;
  entityType: string;
  entityId: string;
  before: unknown;
  after: unknown;
  reason?: string;
  requestId?: string;
}
