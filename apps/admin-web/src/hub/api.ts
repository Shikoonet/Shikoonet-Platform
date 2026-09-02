/**
 * Thin fetch wrapper around the dashboard Worker API.
 * Includes credentials (Cf-Access-Jwt-Assertion comes from the page).
 */

export interface MatchRow {
  id: string;
  transaction_candidate_id: string;
  payment_claim_id: string;
  status: 'SUGGESTED' | 'NEEDS_REVIEW' | 'CONFIRMED' | 'REJECTED' | 'AUTO_VERIFIED';
  score: number;
  matching_reasons?: string[];
  mismatch_reasons?: string[];
  reviewed_by?: string | null;
  reviewed_at?: number | null;
}

export interface TransactionRow {
  id: string;
  raw_sms_event_id: string;
  direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
  amount_irr: number | null;
  balance_irr: number | null;
  status: string;
  bank_timestamp: number | null;
  sms_timestamp: number | null;
  received_at: number | null;
  financial_account_id: string | null;
  account_hint?: string | null;
  is_new?: boolean;
  seen_at?: number | null;
}

export interface TodayItem {
  id: string;
  direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
  amount_irr: number | null;
  balance_irr: number | null;
  status: string;
  bank_timestamp: number | null;
  sms_timestamp: number | null;
  received_at: number | null;
  effective_ts?: number;
  parser_id: string | null;
  financial_account_id: string | null;
  account_display: string | null;
  account_hint: string | null;
  account_bank: string | null;
  device_display_name: string | null;
  device_code: string | null;
  has_match?: boolean;
  is_new?: boolean;
  seen_at?: number | null;
}

export interface ClaimRow {
  id: string;
  financial_account_id: string | null;
  expected_amount_irr: number;
  expected_at: number;
  status: string;
}

export interface TodayPayload {
  ok: boolean;
  count: number;
  items: TodayItem[];
}

export interface DeviceListItem {
  id: string;
  device_code: string;
  display_name: string;
  description: string | null;
  active: number;
  last_seen_at: number | null;
  last_success_at: number | null;
  last_auth_failure_at: number | null;
  created_at: number;
  updated_at: number;
  credential: {
    id: string;
    token_prefix: string;
    last_used_at: number | null;
  } | null;
  last_credential_created_at: number | null;
}

export interface AccountStatus {
  status: 'PENDING' | 'ACTIVE' | 'MUTED' | 'DECLINED';
  before: 'PENDING' | 'ACTIVE' | 'MUTED' | 'DECLINED';
}

export interface AccountListItem {
  id: string;
  bank_name: string;
  display_name: string;
  owner_label: string | null;
  account_type: string;
  account_hint: string | null;
  card_last_four: string | null;
  account_last_four: string | null;
  iban: string | null;
  device_id: string | null;
  active: number;
  status: 'PENDING' | 'ACTIVE' | 'MUTED' | 'DECLINED';
  parser_configuration: string;
  created_at: number;
  updated_at: number;
  device_display_name: string | null;
  additional_identifiers: Array<{ id: string; kind: string; value: string; label: string | null }>;
  /** Mirzabot destination cards mapped to this account (masked). */
  payment_cards?: Array<{
    id: string;
    card_digits: string;
    masked: string;
    display: string;
    label: string | null;
  }>;
}

export interface AccountTotalsItem {
  account_id: string;
  display_name: string;
  bank_name: string;
  account_hint: string | null;
  approved_credit_total_irr: number;
  approved_credit_count: number;
  pending_credit_total_irr: number;
  pending_credit_count: number;
  latest_incoming: {
    id: string;
    ts: number;
    amount_irr: number | null;
    direction: string;
    status: string;
  } | null;
}

export interface AccountTotalsPayload {
  ok: boolean;
  range: 'today' | 'last_7_days' | 'last_30_days' | 'all_time';
  items: AccountTotalsItem[];
}

export interface UnmatchedItem {
  id: string;
  direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
  amount_irr: number | null;
  balance_irr: number | null;
  status: string;
  bank_timestamp: number | null;
  sms_timestamp: number | null;
  received_at: number | null;
  effective_ts: number;
  parser_id: string | null;
  financial_account_id: string | null;
  account_display: string | null;
  account_hint: string | null;
  account_bank: string | null;
  device_display_name: string | null;
  device_code: string | null;
  device_id: string | null;
  reason_no_match: string[];
  eligible_claim_count: number;
  warnings: string[];
  detected_identifiers: Array<{
    type: 'ACCOUNT_NUMBER' | 'CARD_LAST_FOUR' | 'IBAN' | 'ACCOUNT_HINT';
    normalized_value: string;
    masked_value: string;
    parser_id: string;
    confidence: number;
  }>;
  review: {
    decision: 'ACCEPTED' | 'REJECTED';
    reviewed_by: string;
    reviewer_role: 'ADMIN' | 'REVIEWER';
    reason: string | null;
    comment: string | null;
    reviewed_at: number;
  } | null;
  is_new?: boolean;
  seen_at?: number | null;
}

export interface ReviewedTransactionItem {
  id: string;
  direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
  amount_irr: number | null;
  balance_irr: number | null;
  status: string;
  bank_timestamp: number | null;
  sms_timestamp: number | null;
  received_at: number | null;
  effective_ts: number;
  parser_id: string | null;
  financial_account_id: string | null;
  account_display: string | null;
  account_hint: string | null;
  account_bank: string | null;
  device_display_name: string | null;
  device_code: string | null;
  device_id: string | null;
  is_new?: boolean;
  seen_at?: number | null;
  review: {
    decision: 'ACCEPTED' | 'REJECTED';
    reviewed_by: string;
    reviewer_role: 'ADMIN' | 'REVIEWER';
    reason: string | null;
    comment: string | null;
    reviewed_at: number;
  };
}

export interface MatchListPayload {
  ok: boolean;
  items: Array<{
    match: MatchRow;
    transaction: TransactionRow;
    claim: ClaimRow;
    account_display: string | null;
    account_bank?: string | null;
    device_id?: string | null;
    device_display_name?: string | null;
    device_code?: string | null;
  }>;
}

export interface UnmatchedPayload {
  ok: boolean;
  items: UnmatchedItem[];
}

export interface CommentRow {
  id: string;
  body: string;
  author_email: string;
  created_at: number;
}

export interface AnalyzeResult {
  ok: boolean;
  normalized: string;
  parser_id: string | null;
  parser_version: string | null;
  classification: string;
  direction: 'CREDIT' | 'DEBIT' | 'UNKNOWN';
  amount_irr: number | null;
  balance_irr: number | null;
  bank_timestamp: number | null;
  account_hint: string | null;
  card_last_four: string | null;
  transaction_reference: string | null;
  warnings: string[];
  identifiers: Array<{ hint: string; would_assign: number }>;
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    credentials: 'include',
  });
  if (!r.ok) {
    const text = await r.text();
    // Attach the parsed JSON body + status so callers can render structured
    // server errors (e.g. identifier_conflict with existingAccountId) without
    // string-matching on the raw message.
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      // body wasn't JSON — leave parsed=null
    }
    const err = new Error(
      `${r.status}${parsed && typeof parsed === 'object' && 'error' in parsed ? `: ${String((parsed as { error: unknown }).error)}` : `: ${text || r.statusText}`}`,
    ) as Error & { status: number; body: unknown };
    err.status = r.status;
    err.body = parsed;
    throw err;
  }
  return (await r.json()) as T;
}

export const api = {
  today: () => req<TodayPayload>('/api/v1/today'),
  listMatchesSuggested: () => req<MatchListPayload>('/api/v1/matches/suggested'),
  listMatchesReviewed: () => req<MatchListPayload>('/api/v1/matches/reviewed'),
  listMatchesUnmatched: () => req<UnmatchedPayload>('/api/v1/matches/unmatched'),
  listMatches: () => req<MatchListPayload>('/api/v1/matches'),
  comments: (entityType: string, entityId: string) =>
    req<{ ok: boolean; items: CommentRow[] }>(`/api/v1/comments?type=${entityType}&id=${entityId}`),
  postComment: (entityType: string, entityId: string, body: string) =>
    req<{ ok: boolean }>('/api/v1/comment', {
      method: 'POST',
      body: JSON.stringify({ entityType, entityId, body }),
    }),
  approve: (transactionCandidateId: string, matchId: string, comment?: string) =>
    req<{ ok: boolean }>('/api/v1/match/approve', {
      method: 'POST',
      body: JSON.stringify({ transactionCandidateId, matchId, comment }),
    }),
  reject: (matchId: string, reason: string, comment?: string) =>
    req<{ ok: boolean }>('/api/v1/match/reject', {
      method: 'POST',
      body: JSON.stringify({ matchId, reason, comment }),
    }),
  devices: () => req<{ ok: boolean; items: DeviceListItem[] }>('/api/v1/devices'),
  createDevice: (body: { deviceCode: string; displayName: string; description?: string | null }) =>
    req<{
      ok: boolean;
      device: {
        id: string;
        deviceCode: string;
        displayName: string;
        description: string | null;
        active: boolean;
      };
      credential: {
        id: string;
        apiKey: string;
        tokenPrefix: string;
        status: 'ACTIVE';
        shownOnce: true;
      };
      configuration: {
        method: 'POST';
        url: string;
        contentType: 'application/json';
        jsonBody: {
          apiKey: string;
          deviceId: string;
          deviceName: string;
          message: string;
          sender: string;
          timestamp: string;
          checksum: string;
        };
      };
    }>('/api/v1/devices', { method: 'POST', body: JSON.stringify(body) }),
  generateDeviceCredential: (idOrCode: string) =>
    req<{
      ok: boolean;
      device: { id: string; deviceCode: string; displayName: string; active: boolean };
      credential: {
        id: string;
        apiKey: string;
        tokenPrefix: string;
        status: 'ACTIVE';
        shownOnce: true;
      };
      configuration: {
        method: 'POST';
        url: string;
        contentType: 'application/json';
        jsonBody: {
          apiKey: string;
          deviceId: string;
          deviceName: string;
          message: string;
          sender: string;
          timestamp: string;
          checksum: string;
        };
      };
    }>(`/api/v1/devices/${encodeURIComponent(idOrCode)}/credentials`, {
      method: 'POST',
    }),
  rotateDeviceCredential: (idOrCode: string) =>
    req<{
      ok: boolean;
      device: { id: string; deviceCode: string; displayName: string; active: boolean };
      credential: {
        id: string;
        apiKey: string;
        tokenPrefix: string;
        status: 'ACTIVE';
        shownOnce: true;
      };
      configuration: {
        method: 'POST';
        url: string;
        contentType: 'application/json';
        jsonBody: {
          apiKey: string;
          deviceId: string;
          deviceName: string;
          message: string;
          sender: string;
          timestamp: string;
          checksum: string;
        };
      };
    }>(`/api/v1/devices/${encodeURIComponent(idOrCode)}/credentials/rotate`, {
      method: 'POST',
    }),
  revokeDeviceCredential: (idOrCode: string) =>
    req<{ ok: boolean }>(`/api/v1/devices/${encodeURIComponent(idOrCode)}/credentials/revoke`, {
      method: 'POST',
    }),
  deactivateDevice: (idOrCode: string) =>
    req<{ ok: boolean; alreadyInactive?: boolean }>(
      `/api/v1/devices/${encodeURIComponent(idOrCode)}/deactivate`,
      { method: 'POST' },
    ),
  reactivateDevice: (idOrCode: string) =>
    req<{ ok: boolean; alreadyActive?: boolean }>(
      `/api/v1/devices/${encodeURIComponent(idOrCode)}/reactivate`,
      { method: 'POST' },
    ),
  deleteDevicePreview: (idOrCode: string) =>
    req<{
      ok: boolean;
      device: { id: string; deviceCode: string; displayName: string; active: boolean };
      references: {
        rawSmsEvents: number;
        financialAccounts: number;
        credentials: number;
        transactions: number;
      };
      canDelete: boolean;
      blockingReasons: string[];
    }>(`/api/v1/devices/${encodeURIComponent(idOrCode)}/delete-preview`, { method: 'GET' }),
  deleteDevice: (idOrCode: string) =>
    req<{
      ok: boolean;
      deleted: string;
      references: {
        rawSmsEvents: number;
        financialAccounts: number;
        credentials: number;
        transactions: number;
      };
      deletedCredentialCount: number;
    }>(`/api/v1/devices/${encodeURIComponent(idOrCode)}`, { method: 'DELETE' }),
  /**
   * What moving this device's history onto another one would carry, and what
   * would stop it. `duplicateSmsOnTarget` is the one that stops it: the ingest
   * de-duplicates per device (`UNIQUE (device_id, body_sha256)`), so a body the
   * target already holds cannot arrive there a second time.
   */
  moveDevicePreview: (idOrCode: string, targetIdOrCode: string) =>
    req<{
      ok: boolean;
      source: { id: string; deviceCode: string; displayName: string };
      target: { id: string; deviceCode: string; displayName: string };
      moves: { rawSmsEvents: number; financialAccounts: number; transactions: number };
      duplicateSmsOnTarget: number;
      canMove: boolean;
      canDeleteSourceAfterwards: boolean;
    }>(
      `/api/v1/devices/${encodeURIComponent(idOrCode)}/move-preview?target=${encodeURIComponent(
        targetIdOrCode,
      )}`,
      { method: 'GET' },
    ),
  moveDeviceReferences: (
    idOrCode: string,
    body: { targetDeviceId: string; deleteSource?: boolean },
  ) =>
    req<{
      ok: boolean;
      moved: { rawSmsEvents: number; financialAccounts: number; transactions: number };
      target: { id: string; deviceCode: string };
      deletedSource: boolean;
    }>(`/api/v1/devices/${encodeURIComponent(idOrCode)}/move-references`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  accounts: () => req<{ ok: boolean; items: AccountListItem[] }>('/api/v1/accounts'),
  accountTotals: (range: 'today' | 'last_7_days' | 'last_30_days' | 'all_time' = 'all_time') =>
    req<AccountTotalsPayload>(`/api/v1/accounts/totals?range=${range}`),
  createAccount: (body: {
    bank_name: string;
    display_name: string;
    owner_label?: string | null;
    account_type: 'CARD' | 'ACCOUNT' | 'IBAN' | 'OTHER';
    account_hint?: string | null;
    card_last_four?: string | null;
    account_last_four?: string | null;
    iban?: string | null;
    device_id?: string | null;
  }) =>
    req<{ ok: boolean; id: string }>('/api/v1/accounts', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateAccount: (
    id: string,
    body: Partial<{
      bank_name: string;
      display_name: string;
      owner_label: string | null;
      account_type: 'CARD' | 'ACCOUNT' | 'IBAN' | 'OTHER';
      account_hint: string | null;
      card_last_four: string | null;
      account_last_four: string | null;
      iban: string | null;
      device_id: string | null;
      active: boolean;
    }>,
  ) =>
    req<{ ok: boolean }>(`/api/v1/accounts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deactivateAccount: (id: string) =>
    req<{ ok: boolean }>(`/api/v1/accounts/${encodeURIComponent(id)}/deactivate`, {
      method: 'POST',
    }),
  deleteAccountPreview: (id: string) =>
    req<{
      ok: boolean;
      account: { id: string; displayName: string; bank: string; active: boolean };
      references: {
        transactions: number;
        paymentClaims: number;
        matches: number;
        identifiers: number;
      };
      canDelete: boolean;
      blockingReasons: string[];
    }>(`/api/v1/accounts/${encodeURIComponent(id)}/delete-preview`, {
      method: 'GET',
    }),
  deleteAccount: (id: string) =>
    req<{
      ok: boolean;
      deleted: string;
      references: { transactions: number; paymentClaims: number; identifiers: number };
    }>(`/api/v1/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  analyzeSample: (body: string) =>
    req<AnalyzeResult>('/api/v1/accounts/analyze', {
      method: 'POST',
      body: JSON.stringify({ body }),
    }),
  addIdentifier: (
    accountId: string,
    body: {
      kind: 'ACCOUNT_HINT' | 'CARD_LAST_FOUR' | 'ACCOUNT_LAST_FOUR' | 'IBAN' | 'OTHER';
      value: string;
      label?: string | null;
      assign_historical?: boolean;
    },
  ) =>
    req<{
      ok: boolean;
      kind: string;
      value: string;
      preview: number;
      updated: number;
    }>(`/api/v1/accounts/${encodeURIComponent(accountId)}/identifier`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  rerunMatching: () =>
    req<{ ok: boolean; suggested: number; processed: number }>('/api/v1/accounts/rerun-matching', {
      method: 'POST',
    }),
  // Account lifecycle (PENDING / ACTIVE / MUTED / DECLINED). All five
  // endpoints return the new status on success and 409 on illegal
  // transitions. The dashboard's invalidation keys are managed by the
  // FOR_MUTATION.accountStatusTransition entry.
  accountsPending: () => req<{ ok: boolean; items: AccountListItem[] }>('/api/v1/accounts/pending'),
  acceptAccount: (id: string) =>
    req<AccountStatus>(`/api/v1/accounts/${encodeURIComponent(id)}/accept`, { method: 'POST' }),
  muteAccount: (id: string) =>
    req<AccountStatus>(`/api/v1/accounts/${encodeURIComponent(id)}/mute`, { method: 'POST' }),
  unmuteAccount: (id: string) =>
    req<AccountStatus>(`/api/v1/accounts/${encodeURIComponent(id)}/unmute`, { method: 'POST' }),
  declineAccount: (id: string) =>
    req<AccountStatus>(`/api/v1/accounts/${encodeURIComponent(id)}/decline`, { method: 'POST' }),
  restoreAccount: (id: string) =>
    req<AccountStatus>(`/api/v1/accounts/${encodeURIComponent(id)}/restore`, { method: 'POST' }),
  /**
   * Build a staged preview of historical transactions that should be
   * assigned to the given account based on its configured identifiers.
   * No DB mutation beyond inserting the preview row + items.
   */
  rerunAssignmentPreview: (accountId: string) =>
    req<{
      ok: boolean;
      previewId: string;
      expiresAt: number;
      counts: {
        willAssign: number;
        willRepairHistory: number;
        alreadyCorrect: number;
        manualAssignmentsSkipped: number;
        ambiguous: number;
        conflicts: number;
      };
      items: Array<{
        id: string;
        transactionId: string;
        disposition: 'WILL_ASSIGN' | 'WILL_REPAIR_HISTORY' | 'ALREADY_CORRECT' | 'AMBIGUOUS';
        identifierType: 'ACCOUNT_NUMBER' | 'CARD_LAST_FOUR' | 'IBAN' | 'ACCOUNT_HINT' | null;
        normalizedIdentifier: string | null;
        currentAccountId: string | null;
        currentAssignmentSource: string | null;
        bankTimestamp: number | null;
        amountIrr: number | null;
        selected: boolean;
      }>;
    }>(`/api/v1/accounts/${encodeURIComponent(accountId)}/rerun-assignment-preview`, {
      method: 'POST',
    }),
  /**
   * Commit the staged preview. Each selected item is routed through
   * assignAccountForTx with source='HISTORICAL_BACKFILL'. MANUAL /
   * ACCOUNT_MERGE rows are NEVER overwritten. Per-item divergence is
   * reported as `conflicts`. Writes an audit row.
   */
  applyRerunAssignment: (accountId: string, previewId: string, selectedTxIds?: string[]) =>
    req<{
      ok: boolean;
      previewId: string;
      applied: number;
      skipped: number;
      conflicts: number;
      manualPreserved: number;
      affectedTxIds: string[];
      resultJson: string;
    }>(
      `/api/v1/accounts/${encodeURIComponent(accountId)}/rerun-assignment/${encodeURIComponent(previewId)}/apply`,
      { method: 'POST', body: JSON.stringify({ selectedTxIds: selectedTxIds ?? null }) },
    ),
  /**
   * Discard the staged preview. Zero DB mutation beyond flipping the
   * preview row to DECLINED. Never applied, never undone.
   */
  declineRerunAssignment: (accountId: string, previewId: string) =>
    req<{ ok: boolean; previewId: string }>(
      `/api/v1/accounts/${encodeURIComponent(accountId)}/rerun-assignment/${encodeURIComponent(previewId)}/decline`,
      { method: 'POST' },
    ),
  // Transaction-level account assignment + reviews.
  assignTransactionAccount: (
    transactionId: string,
    body: {
      accountId: string;
      identifier?: {
        type: 'ACCOUNT_NUMBER' | 'CARD_LAST_FOUR' | 'IBAN' | 'ACCOUNT_HINT';
        normalizedValue: string;
        maskedValue?: string;
      };
      saveIdentifierToAccount?: boolean;
      backfillHistorical?: boolean;
    },
  ) =>
    req<{
      ok: boolean;
      txId: string;
      accountId: string;
      identifierSaved: boolean;
      backfilled: number;
    }>(`/api/v1/transactions/${encodeURIComponent(transactionId)}/assign-account`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  acceptTransaction: (transactionId: string) =>
    req<{ ok: boolean; decision: 'ACCEPTED' }>(
      `/api/v1/transactions/${encodeURIComponent(transactionId)}/accept`,
      { method: 'POST' },
    ),
  rejectTransaction: (transactionId: string, body: { reason: string; comment?: string }) =>
    req<{ ok: boolean; decision: 'REJECTED' }>(
      `/api/v1/transactions/${encodeURIComponent(transactionId)}/reject`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  createAccountFromTransaction: (
    transactionId: string,
    body: {
      bank_name: string;
      display_name: string;
      owner_label?: string | null;
      account_type: 'CARD' | 'ACCOUNT' | 'IBAN' | 'OTHER';
      identifier?: {
        type: 'ACCOUNT_NUMBER' | 'CARD_LAST_FOUR' | 'IBAN' | 'ACCOUNT_HINT';
        normalizedValue: string;
        maskedValue?: string;
      };
      backfillHistorical?: boolean;
    },
  ) =>
    req<{ ok: boolean; accountId: string; backfilled: number }>(
      `/api/v1/transactions/${encodeURIComponent(transactionId)}/create-account`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  backfillAccountPreview: (
    accountId: string,
    body: {
      identifierType: 'ACCOUNT_NUMBER' | 'CARD_LAST_FOUR' | 'IBAN' | 'ACCOUNT_HINT';
      normalizedValue: string;
    },
  ) =>
    req<{
      ok: boolean;
      matchingUnassignedCount: number;
      transactionIds: string[];
    }>(`/api/v1/accounts/${encodeURIComponent(accountId)}/backfill-preview`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  backfillAccount: (
    accountId: string,
    body: {
      identifierType: 'ACCOUNT_NUMBER' | 'CARD_LAST_FOUR' | 'IBAN' | 'ACCOUNT_HINT';
      normalizedValue: string;
    },
  ) =>
    req<{ ok: boolean; changed: number }>(
      `/api/v1/accounts/${encodeURIComponent(accountId)}/backfill`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  listReviewedTransactions: () =>
    req<{ ok: boolean; items: ReviewedTransactionItem[] }>('/api/v1/matches/reviewed/transactions'),
  changeTransactionAccount: (
    transactionId: string,
    body: { accountId: string | null; reason?: string },
  ) =>
    req<{
      ok: boolean;
      txId: string;
      status: 'inserted' | 'noop' | 'preserved_manual';
      accountId: string | null;
      assignmentId: string;
    }>(`/api/v1/transactions/${encodeURIComponent(transactionId)}/change-account`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  transactionAssignmentHistory: (transactionId: string) =>
    req<{
      ok: boolean;
      items: Array<{
        id: string;
        accountId: string | null;
        source: string;
        identifierType: string | null;
        normalizedIdentifier: string | null;
        assignedBy: string;
        assignedAt: number;
        replacedAssignmentId: string | null;
        active: boolean;
      }>;
    }>(`/api/v1/transactions/${encodeURIComponent(transactionId)}/assignment-history`),
  changePaymentClaimAccount: (
    claimId: string,
    body: { accountId: string | null; reason?: string },
  ) =>
    req<{ ok: boolean; claimId: string; accountId: string | null }>(
      `/api/v1/payment-claims/${encodeURIComponent(claimId)}/change-account`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  accountReferences: (accountId: string) =>
    req<{
      ok: boolean;
      account: { id: string; displayName: string; bank: string; active: boolean };
      references: {
        totals: { transactions: number; paymentClaims: number; identifiers: number };
        transactions: Array<{
          id: string;
          direction: string;
          amount_irr: number | null;
          balance_irr: number | null;
          bank_timestamp: number | null;
          status: string;
        }>;
        paymentClaims: Array<{
          id: string;
          external_order_id: string;
          expected_amount_irr: number;
          submitted_at: number;
          status: string;
        }>;
      };
    }>(`/api/v1/accounts/${encodeURIComponent(accountId)}/references`),
  moveReferencesPreview: (sourceId: string, body: { targetAccountId: string }) =>
    req<{
      ok: boolean;
      sourceId: string;
      targetId: string;
      counts: { transactions: number; paymentClaims: number; identifiers: number };
      identifiers: Array<{ id: string; kind: string; value: string; label: string | null }>;
    }>(`/api/v1/accounts/${encodeURIComponent(sourceId)}/move-references-preview`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  moveReferences: (
    sourceId: string,
    body: {
      targetAccountId: string;
      options?: {
        reassignTransactions?: boolean;
        reassignClaims?: boolean;
        moveIdentifiers?: boolean;
        deleteSource?: boolean;
      };
      reason?: string;
    },
  ) =>
    req<{
      ok: boolean;
      sourceId: string;
      targetAccountId: string;
      deletedSource: boolean;
      options: Record<string, unknown>;
    }>(`/api/v1/accounts/${encodeURIComponent(sourceId)}/move-references`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  notificationCounts: () =>
    req<{
      ok: boolean;
      counts: {
        new: number;
        unassigned: number;
        unmatched: number;
        suggested: number;
        total: number;
        unread: number;
        paymentEvents?: {
          needsReview: number;
          suspectedFake: number;
          botAutoVerified: number;
          reseller: number;
          total: number;
        };
      };
      cursor: { at: number | null; id: string | null };
      updatedAt: number;
    }>('/api/v1/notifications/counts'),
  notificationsMarkAllRead: () =>
    req<{ ok: boolean; advanced: boolean }>('/api/v1/notifications/mark-all-read', {
      method: 'POST',
    }),
  markNotificationRead: (body: { lastSeenTransactionAt: number; lastSeenTransactionId: string }) =>
    req<{ ok: boolean; advanced: boolean }>('/api/v1/notifications/mark-read', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  notificationsRecent: (limit = 10) =>
    req<{
      ok: boolean;
      items: Array<{
        id: string;
        direction: string;
        amount_irr: number | null;
        status: string;
        bank_timestamp: number | null;
        accountId: string | null;
        accountDisplay: string | null;
        hasMatch: boolean;
        is_new?: boolean;
        seen_at?: number | null;
      }>;
    }>(`/api/v1/notifications/recent?limit=${limit}`),
  /**
   * Mark ONE transaction as seen by the current actor. Returns the new
   * unread count so the bell can decrement immediately. Does NOT change
   * transaction state.
   */
  markTransactionSeen: (transactionId: string) =>
    req<{ ok: boolean; is_new: boolean; seen_at: number; unread: number }>(
      `/api/v1/notifications/transactions/${encodeURIComponent(transactionId)}/seen`,
      { method: 'POST' },
    ),
  /**
   * Fetch every per-row seen-id map for the current actor. Used by the
   * client cache overlay so optimistic dismissals survive reloads.
   */
  notificationsSeenIds: () =>
    req<{ ok: boolean; seen_at_by_id: Record<string, number> }>('/api/v1/notifications/seen-ids'),
  markPaymentEventSeen: (eventKey: string) =>
    req<{ ok: boolean }>(`/api/v1/payments/events/${encodeURIComponent(eventKey)}/seen`, {
      method: 'POST',
    }),
  markPaymentTabReadAll: (
    tab: 'needs_review' | 'suspected_fake' | 'bot_auto_verified' | 'reseller' | 'income',
  ) =>
    req<{ ok: boolean; marked: number }>('/api/v1/payments/tabs/read-all', {
      method: 'POST',
      body: JSON.stringify({ tab }),
    }),
  declineIncome: (transactionId: string, reason?: string) =>
    req<{ ok: boolean }>(
      `/api/v1/transactions/${encodeURIComponent(transactionId)}/decline-income`,
      {
        method: 'POST',
        body: JSON.stringify({ reason }),
      },
    ),
  declineIncomeBulk: (transactionIds: string[], reason?: string) =>
    req<{ ok: boolean; declined: string[] }>('/api/v1/transactions/decline-income/bulk', {
      method: 'POST',
      body: JSON.stringify({ transactionIds, reason }),
    }),
  declineAllIncome: (reason?: string) =>
    req<{ ok: boolean; declined: number; transactionIds: string[] }>(
      '/api/v1/transactions/decline-income/all',
      { method: 'POST', body: JSON.stringify({ reason }) },
    ),
  restoreIncome: (transactionId: string) =>
    req<{ ok: boolean; returnedToIncome: boolean }>(
      `/api/v1/transactions/${encodeURIComponent(transactionId)}/restore-income`,
      { method: 'POST' },
    ),
  restoreIncomeBulk: (transactionIds: string[]) =>
    req<{ ok: boolean; restored: string[]; returnedToIncome: string[] }>(
      '/api/v1/transactions/restore-income/bulk',
      { method: 'POST', body: JSON.stringify({ transactionIds }) },
    ),
  restoreAllDeclinedIncome: () =>
    req<{ ok: boolean; restored: number; returnedToIncome: number }>(
      '/api/v1/transactions/restore-income/all',
      { method: 'POST' },
    ),
  /**
   * Deliver a claim the bank has not confirmed.
   *
   * `confirmed` is sent as a literal and not as a variable: the server requires
   * it, so a screen that forgot to ask the operator also fails to send it. The
   * dialog and the guard cannot drift apart.
   */
  fulfilWithoutPayment: (claimId: string, reason: string) =>
    req<{ ok: boolean; claimId: string; mode: 'MANUAL' | 'CONTINUITY'; already: boolean }>(
      `/api/v1/payment-claims/${encodeURIComponent(claimId)}/fulfil-without-payment`,
      { method: 'POST', body: JSON.stringify({ reason, confirmed: true }) },
    ),

  continuityMode: () =>
    req<{
      ok: boolean;
      mode: 'NORMAL' | 'CONTINUITY';
      expiresAt: number | null;
      activatedAt: number | null;
      activatedBy: string | null;
      reason: string | null;
      expired: boolean;
    }>('/api/v1/continuity-mode'),

  setContinuityMode: (body: { active: false } | { active: true; reason: string; durationMs: number }) =>
    req<{ ok: boolean; mode: 'NORMAL' | 'CONTINUITY'; expiresAt: number | null }>(
      '/api/v1/continuity-mode',
      {
        method: 'POST',
        body: JSON.stringify(body.active ? { ...body, confirmed: true } : body),
      },
    ),

  awaitingReconciliation: () =>
    req<{
      ok: boolean;
      items: {
        claimId: string;
        orderId: string;
        amountIrr: number;
        mode: string | null;
        fulfilledAt: number | null;
        fulfilledBy: string | null;
        reason: string | null;
        customerReference: string | null;
      }[];
    }>('/api/v1/payment-claims/awaiting-reconciliation'),

  reopenManualVerification: (claimId: string, reason: string) =>
    req<{
      ok: boolean;
      claimId: string;
      orderId: string;
      reviewQueue: string;
      suspectReason: string | null;
      transactionId: string | null;
    }>(`/api/v1/payment-claims/${encodeURIComponent(claimId)}/reopen-manual-verification`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  /** @deprecated Use reopenManualVerification */
  revertManualVerification: (claimId: string) =>
    req<{
      ok: boolean;
      claimId: string;
      restoredClaimStatus: string;
      restoredSuspectReason: string | null;
      transactionId: string | null;
    }>(`/api/v1/payment-claims/${encodeURIComponent(claimId)}/revert-manual-verification`, {
      method: 'POST',
    }),
};
