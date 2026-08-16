/**
 * Single source of truth for query keys + invalidation groups.
 *
 * Each exported `KEY` is the cache key passed to `useQuery`. The
 * `invalidate*` helpers name the exact views that should refetch
 * after each mutation so we don't have grep-friendly strings drifting
 * through the views.
 */

export const KEYS = {
  TODAY: 'today',
  SUGGESTED: 'matches.suggested',
  UNMATCHED: 'matches.unmatched',
  REVIEWED_MATCHES: 'matches.reviewed',
  REVIEWED_TRANSACTIONS: 'matches.reviewed.transactions',
  ACCOUNTS: 'accounts',
  ACCOUNTS_PENDING: 'accounts.pending',
  ACCOUNT_TOTALS: (range: string) => `accounts.totals:${range}`,
  DEVICES: 'devices',
  SEEN_IDS: 'notifications.seenIds',
  NOTIFICATION_COUNTS: 'notifications.counts',
  /** Stable key for payment hub tab badges (Review sub-tabs, Income, etc.). */
  PAYMENT_TAB_COUNTS: 'payments.tabCounts',
  PAYMENTS: (query: string) => `payments:${query}`,
  PAYMENT_CARDS: (accountId: string) => `payment_cards:${accountId}`,
} as const;

export const QK = {
  today: KEYS.TODAY,
  suggested: KEYS.SUGGESTED,
  unmatched: KEYS.UNMATCHED,
  reviewedMatches: KEYS.REVIEWED_MATCHES,
  reviewedTransactions: KEYS.REVIEWED_TRANSACTIONS,
  accounts: KEYS.ACCOUNTS,
  accountsPending: KEYS.ACCOUNTS_PENDING,
  accountTotals: (range: string) => KEYS.ACCOUNT_TOTALS(range),
  devices: KEYS.DEVICES,
  seenIds: KEYS.SEEN_IDS,
  notificationCounts: KEYS.NOTIFICATION_COUNTS,
  paymentTabCounts: KEYS.PAYMENT_TAB_COUNTS,
  payments: (query: string) => KEYS.PAYMENTS(query),
  paymentCards: (accountId: string) => KEYS.PAYMENT_CARDS(accountId),
};

export type QueryKey =
  | (typeof KEYS)[keyof Omit<typeof KEYS, 'ACCOUNT_TOTALS' | 'PAYMENTS' | 'PAYMENT_CARDS'>]
  | string;

/**
 * Mutation → affected query keys. Plain strings so the views can call:
 *   cache.invalidate(...forMutation('assignAccount'))
 */
export const FOR_MUTATION: Record<string, string[]> = {
  assignAccount: [KEYS.UNMATCHED, KEYS.TODAY, KEYS.ACCOUNTS, KEYS.SUGGESTED, KEYS.DEVICES],
  createAccountAndAssign: [
    KEYS.ACCOUNTS,
    KEYS.UNMATCHED,
    KEYS.TODAY,
    KEYS.SUGGESTED,
    KEYS.ACCOUNT_TOTALS('today'),
    KEYS.ACCOUNT_TOTALS('last_7_days'),
    KEYS.ACCOUNT_TOTALS('last_30_days'),
    KEYS.ACCOUNT_TOTALS('all_time'),
  ],
  backfill: [
    KEYS.ACCOUNTS,
    KEYS.UNMATCHED,
    KEYS.TODAY,
    KEYS.SUGGESTED,
    KEYS.ACCOUNT_TOTALS('today'),
    KEYS.ACCOUNT_TOTALS('last_7_days'),
    KEYS.ACCOUNT_TOTALS('last_30_days'),
    KEYS.ACCOUNT_TOTALS('all_time'),
  ],
  rerunAssignment: [
    KEYS.ACCOUNTS,
    KEYS.UNMATCHED,
    KEYS.TODAY,
    KEYS.SUGGESTED,
    KEYS.ACCOUNT_TOTALS('today'),
    KEYS.ACCOUNT_TOTALS('last_7_days'),
    KEYS.ACCOUNT_TOTALS('last_30_days'),
    KEYS.ACCOUNT_TOTALS('all_time'),
    KEYS.SEEN_IDS,
  ],
  accept: [
    KEYS.UNMATCHED,
    KEYS.REVIEWED_TRANSACTIONS,
    KEYS.TODAY,
    KEYS.ACCOUNT_TOTALS('today'),
    KEYS.ACCOUNT_TOTALS('last_7_days'),
    KEYS.ACCOUNT_TOTALS('last_30_days'),
    KEYS.ACCOUNT_TOTALS('all_time'),
  ],
  reject: [
    KEYS.UNMATCHED,
    KEYS.REVIEWED_TRANSACTIONS,
    KEYS.TODAY,
    KEYS.ACCOUNT_TOTALS('today'),
    KEYS.ACCOUNT_TOTALS('last_7_days'),
    KEYS.ACCOUNT_TOTALS('last_30_days'),
    KEYS.ACCOUNT_TOTALS('all_time'),
  ],
  approveMatch: [
    KEYS.SUGGESTED,
    KEYS.REVIEWED_MATCHES,
    KEYS.TODAY,
    KEYS.ACCOUNT_TOTALS('today'),
    KEYS.ACCOUNT_TOTALS('last_7_days'),
    KEYS.ACCOUNT_TOTALS('last_30_days'),
    KEYS.ACCOUNT_TOTALS('all_time'),
  ],
  rejectMatch: [
    KEYS.SUGGESTED,
    KEYS.REVIEWED_MATCHES,
    KEYS.UNMATCHED, // tx becomes active again
  ],
  newSms: [
    KEYS.TODAY,
    KEYS.UNMATCHED,
    KEYS.SUGGESTED,
    KEYS.DEVICES,
    KEYS.ACCOUNT_TOTALS('today'),
    KEYS.ACCOUNT_TOTALS('last_7_days'),
    KEYS.ACCOUNT_TOTALS('last_30_days'),
    KEYS.ACCOUNT_TOTALS('all_time'),
  ],
  deactivateAccount: [KEYS.ACCOUNTS, KEYS.ACCOUNT_TOTALS('all_time')],
  // Any account status transition (accept / mute / unmute / decline /
  // restore) affects every view that lists or aggregates transactions:
  // the Accounts list, the review queue, totals across every range,
  // Today, All Matches, notifications, and the per-row seen state.
  accountStatusTransition: [
    KEYS.ACCOUNTS,
    KEYS.ACCOUNTS_PENDING,
    KEYS.ACCOUNT_TOTALS('today'),
    KEYS.ACCOUNT_TOTALS('last_7_days'),
    KEYS.ACCOUNT_TOTALS('last_30_days'),
    KEYS.ACCOUNT_TOTALS('all_time'),
    KEYS.TODAY,
    KEYS.SUGGESTED,
    KEYS.UNMATCHED,
    KEYS.REVIEWED_MATCHES,
    KEYS.REVIEWED_TRANSACTIONS,
    KEYS.NOTIFICATION_COUNTS,
    KEYS.SEEN_IDS,
  ],
  // Marking a single row seen bumps the per-row seen-ids cache AND the
  // notification bell counts (server returns the new `unread` total in
  // the same response, so we drop both atomically).
  markSeen: [KEYS.SEEN_IDS, KEYS.NOTIFICATION_COUNTS],
  // Mark-all-read advances the cursor; bell counts must drop immediately.
  markAllRead: [KEYS.NOTIFICATION_COUNTS, KEYS.SEEN_IDS],
  deviceCreated: [KEYS.DEVICES],
  deviceUpdated: [KEYS.DEVICES],
  deviceDeactivated: [KEYS.DEVICES],
  deviceReactivated: [KEYS.DEVICES],
  deviceCredentialCreated: [KEYS.DEVICES],
  deviceCredentialRotated: [KEYS.DEVICES],
  deviceCredentialRevoked: [KEYS.DEVICES],
  deviceDeleted: [KEYS.DEVICES],
};

export type MutationName = keyof typeof FOR_MUTATION;

export function forMutation(name: MutationName): string[] {
  return FOR_MUTATION[name] ?? [];
}
