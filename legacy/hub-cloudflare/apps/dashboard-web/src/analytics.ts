/**
 * Financial analytics types shared by Payments and Accounts views.
 */

import type { HistoryRange } from './paymentReview.js';

export type PercentChangeKind = 'all_time' | 'new' | 'no_baseline' | 'change';

export interface PercentChange {
  kind: PercentChangeKind;
  percent?: number;
}

export interface AnalyticsResponse {
  ok: boolean;
  range: HistoryRange;
  sales: {
    count: number;
    amountIrr: number;
    amountChange: PercentChange;
    countChange: PercentChange;
  };
  botAutoVerified: { count: number; amountIrr: number };
  manualVerified: { count: number; amountIrr: number };
  bankInflowIrr: number;
  reseller: { count: number; amountIrr: number };
  unassignedIncome: { count: number; amountIrr: number };
  balances: {
    totalKnownIrr: number;
    knownAccounts: number;
    totalActiveAccounts: number;
  };
  trend: Array<{
    bucketStart: number;
    label: string;
    salesCount: number;
    salesAmountIrr: number;
  }>;
}

export interface AccountAnalyticsItem {
  accountId: string;
  displayName: string;
  ownerLabel: string | null;
  bankName: string;
  accountHint: string | null;
  status: string;
  mappedCards: number;
  currentBalanceIrr: number | null;
  balanceAsOf: number | null;
  balanceFreshness: 'unavailable' | 'fresh' | 'stale';
  purchaseCount: number;
  salesCount: number;
  salesAmountIrr: number;
  bankInflowIrr: number;
  bankInflowCount: number;
  unassignedIncomeIrr: number;
  unassignedIncomeCount: number;
  resellerAmountIrr: number;
  resellerCount: number;
  purchaseBarPercent: number;
  transactionCount?: number;
  primaryDeviceId?: string | null;
  primaryDeviceDisplayName?: string | null;
  primaryDeviceCode?: string | null;
  recentDeviceObservationCount?: number;
  primaryDeviceObservationCount?: number;
  deviceLastSeenAt?: number | null;
  deviceAmbiguous?: boolean;
}

export interface AccountAnalyticsResponse {
  ok: boolean;
  range: HistoryRange;
  totals: {
    totalKnownBalanceIrr: number;
    knownAccounts: number;
    totalActiveAccounts: number;
  };
  distribution: {
    min: number;
    average: number;
    max: number;
    uneven: boolean;
  };
  items: AccountAnalyticsItem[];
}

export interface CardAnalyticsItem {
  cardDigits: string;
  cardMasked: string;
  accountId: string;
  displayName: string;
  ownerLabel: string | null;
  accountHint: string | null;
  accountStatus: string;
  purchaseCount: number;
  purchaseBarPercent: number;
  hubEligible: boolean;
  exclusionReason: string;
}

export interface CardAnalyticsResponse {
  ok: boolean;
  range: HistoryRange;
  entity: 'card_number';
  metric: 'hub_auto_verified_purchases';
  note: string;
  distribution: { min: number; max: number; gap: number };
  items: CardAnalyticsItem[];
}

export function formatPercentChange(pc: PercentChange): string {
  switch (pc.kind) {
    case 'all_time':
      return 'All-time';
    case 'new':
      return 'New';
    case 'no_baseline':
      return 'No previous-period baseline';
    case 'change': {
      const abs = Math.abs(pc.percent ?? 0);
      const arrow = (pc.percent ?? 0) >= 0 ? '↑' : '↓';
      return `${arrow} ${abs.toFixed(1)}%`;
    }
  }
}

export { formatCompactTomanFromIrr as formatCompactIrr } from './format.js';
