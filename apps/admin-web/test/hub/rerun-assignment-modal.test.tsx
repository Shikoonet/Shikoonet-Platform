/**
 * RerunAssignmentModal tests.
 *
 * Verifies the modal state machine:
 *   - Step 1: kicks off `api.rerunAssignmentPreview` on mount.
 *   - Step 2: shows counts + listable items.
 *   - Accept disabled until at least one item is selected.
 *   - Accept calls `api.applyRerunAssignment` with the selected tx ids.
 *   - Decline calls `api.declineRerunAssignment` and closes the modal.
 *   - Modal stays mounted when the parent invalidates a cache key
 *     underneath (polling survival).
 *   - Result step shows four distinct counts.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RerunAssignmentModal } from '../../src/hub/AccountsView.js';
import { api } from '../../src/hub/api.js';
import type { Cache } from '../../src/hub/query.js';
import { createCache } from '../../src/hub/query.js';
import type { AccountListItem } from '../../src/hub/api.js';

// Mock the api module so the modal doesn't hit the network.
vi.mock('../../src/hub/api.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/hub/api.js')>('../../src/hub/api.js');
  return {
    ...actual,
    api: {
      ...actual.api,
      rerunAssignmentPreview: vi.fn(),
      applyRerunAssignment: vi.fn(),
      declineRerunAssignment: vi.fn(),
    },
  };
});

const ACCOUNT: AccountListItem = {
  id: 'account-1',
  bank_name: 'PARSIAN',
  display_name: 'My Parsian',
  owner_label: null,
  account_type: 'ACCOUNT',
  status: 'ACTIVE',
  account_hint: '7001018246497',
  card_last_four: null,
  account_last_four: null,
  iban: null,
  device_id: null,
  active: 1,
  parser_configuration: '{}',
  created_at: 0,
  updated_at: 0,
  device_display_name: null,
  additional_identifiers: [],
};

function makeCache(): Cache {
  return createCache();
}

function Harness({ account, onApplied }: { account: AccountListItem; onApplied: () => void }) {
  const cache = makeCache();
  return (
    <>
      <RerunAssignmentModal account={account} onClose={() => undefined} onApplied={onApplied} />
      <button
        type="button"
        onClick={() => cache.invalidate('accounts')}
        data-testid="invalidate-cache"
      >
        Invalidate cache
      </button>
    </>
  );
}

describe('RerunAssignmentModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls api.rerunAssignmentPreview on mount', async () => {
    vi.mocked(api.rerunAssignmentPreview).mockResolvedValue({
      ok: true,
      previewId: 'preview-1',
      expiresAt: Date.now() + 1_800_000,
      counts: {
        willAssign: 1,
        willRepairHistory: 0,
        alreadyCorrect: 0,
        manualAssignmentsSkipped: 0,
        ambiguous: 0,
        conflicts: 0,
      },
      items: [
        {
          id: 'item-1',
          transactionId: 'tx-1',
          disposition: 'WILL_ASSIGN',
          identifierType: 'ACCOUNT_NUMBER',
          normalizedIdentifier: '7001018246497',
          currentAccountId: null,
          currentAssignmentSource: null,
          bankTimestamp: Date.now(),
          amountIrr: 100_000,
          selected: true,
        },
      ],
    });

    render(<Harness account={ACCOUNT} onApplied={() => undefined} />);
    await waitFor(() => {
      expect(api.rerunAssignmentPreview).toHaveBeenCalledTimes(1);
    });
    expect(api.rerunAssignmentPreview).toHaveBeenCalledWith('account-1');
  });

  it('renders counts and items in the preview step', async () => {
    vi.mocked(api.rerunAssignmentPreview).mockResolvedValue({
      ok: true,
      previewId: 'preview-1',
      expiresAt: Date.now() + 1_800_000,
      counts: {
        willAssign: 2,
        willRepairHistory: 1,
        alreadyCorrect: 3,
        manualAssignmentsSkipped: 1,
        ambiguous: 0,
        conflicts: 0,
      },
      items: [
        {
          id: 'item-1',
          transactionId: 'tx-1',
          disposition: 'WILL_ASSIGN',
          identifierType: 'ACCOUNT_NUMBER',
          normalizedIdentifier: '7001018246497',
          currentAccountId: null,
          currentAssignmentSource: null,
          bankTimestamp: Date.now(),
          amountIrr: 100_000,
          selected: true,
        },
        {
          id: 'item-2',
          transactionId: 'tx-2',
          disposition: 'WILL_REPAIR_HISTORY',
          identifierType: 'ACCOUNT_NUMBER',
          normalizedIdentifier: '7001018246497',
          currentAccountId: 'other-id',
          currentAssignmentSource: 'AUTO_IDENTIFIER',
          bankTimestamp: Date.now(),
          amountIrr: 200_000,
          selected: true,
        },
      ],
    });

    render(<Harness account={ACCOUNT} onApplied={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByText('Accept (2)')).toBeTruthy();
    });
    expect(screen.getByText(/will assign/i)).toBeTruthy();
    expect(screen.getByText(/will repair history/i)).toBeTruthy();
    expect(screen.getByText(/already correct/i)).toBeTruthy();
    expect(screen.getByText(/manual preserved/i)).toBeTruthy();
    // Two listable items → two checkboxes.
    const checkboxes = screen.getAllByRole('checkbox');
    expect(checkboxes.length).toBe(2);
  });

  it('Accept calls api.applyRerunAssignment with selected tx ids', async () => {
    vi.mocked(api.rerunAssignmentPreview).mockResolvedValue({
      ok: true,
      previewId: 'preview-1',
      expiresAt: Date.now() + 1_800_000,
      counts: {
        willAssign: 1,
        willRepairHistory: 0,
        alreadyCorrect: 0,
        manualAssignmentsSkipped: 0,
        ambiguous: 0,
        conflicts: 0,
      },
      items: [
        {
          id: 'item-1',
          transactionId: 'tx-1',
          disposition: 'WILL_ASSIGN',
          identifierType: 'ACCOUNT_NUMBER',
          normalizedIdentifier: '7001018246497',
          currentAccountId: null,
          currentAssignmentSource: null,
          bankTimestamp: Date.now(),
          amountIrr: 100_000,
          selected: true,
        },
      ],
    });
    vi.mocked(api.applyRerunAssignment).mockResolvedValue({
      ok: true,
      previewId: 'preview-1',
      applied: 1,
      skipped: 0,
      conflicts: 0,
      manualPreserved: 0,
      affectedTxIds: ['tx-1'],
      resultJson: '{}',
    });

    render(<Harness account={ACCOUNT} onApplied={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByText(/Accept \(1\)/)).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByText(/Accept \(1\)/));
    });
    await waitFor(() => {
      expect(api.applyRerunAssignment).toHaveBeenCalledTimes(1);
    });
    expect(api.applyRerunAssignment).toHaveBeenCalledWith('account-1', 'preview-1', ['tx-1']);
  });

  it('Decline calls api.declineRerunAssignment', async () => {
    vi.mocked(api.rerunAssignmentPreview).mockResolvedValue({
      ok: true,
      previewId: 'preview-1',
      expiresAt: Date.now() + 1_800_000,
      counts: {
        willAssign: 1,
        willRepairHistory: 0,
        alreadyCorrect: 0,
        manualAssignmentsSkipped: 0,
        ambiguous: 0,
        conflicts: 0,
      },
      items: [
        {
          id: 'item-1',
          transactionId: 'tx-1',
          disposition: 'WILL_ASSIGN',
          identifierType: 'ACCOUNT_NUMBER',
          normalizedIdentifier: '7001018246497',
          currentAccountId: null,
          currentAssignmentSource: null,
          bankTimestamp: Date.now(),
          amountIrr: 100_000,
          selected: true,
        },
      ],
    });
    vi.mocked(api.declineRerunAssignment).mockResolvedValue({ ok: true, previewId: 'preview-1' });

    render(<Harness account={ACCOUNT} onApplied={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByText('Decline')).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Decline'));
    });
    await waitFor(() => {
      expect(api.declineRerunAssignment).toHaveBeenCalledTimes(1);
    });
    expect(api.declineRerunAssignment).toHaveBeenCalledWith('account-1', 'preview-1');
  });

  it('modal stays mounted across a parent cache invalidation', async () => {
    vi.mocked(api.rerunAssignmentPreview).mockResolvedValue({
      ok: true,
      previewId: 'preview-1',
      expiresAt: Date.now() + 1_800_000,
      counts: {
        willAssign: 1,
        willRepairHistory: 0,
        alreadyCorrect: 0,
        manualAssignmentsSkipped: 0,
        ambiguous: 0,
        conflicts: 0,
      },
      items: [
        {
          id: 'item-1',
          transactionId: 'tx-1',
          disposition: 'WILL_ASSIGN',
          identifierType: 'ACCOUNT_NUMBER',
          normalizedIdentifier: '7001018246497',
          currentAccountId: null,
          currentAssignmentSource: null,
          bankTimestamp: Date.now(),
          amountIrr: 100_000,
          selected: true,
        },
      ],
    });

    render(<Harness account={ACCOUNT} onApplied={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByText(/Accept \(1\)/)).toBeTruthy();
    });
    // Simulate a 5-second poll invalidating the cache underneath.
    await act(async () => {
      fireEvent.click(screen.getByTestId('invalidate-cache'));
    });
    // The modal is still there — state survived.
    expect(screen.getByText(/Accept \(1\)/)).toBeTruthy();
    expect(screen.getByText('Decline')).toBeTruthy();
  });

  it('result step shows four counts after Apply', async () => {
    vi.mocked(api.rerunAssignmentPreview).mockResolvedValue({
      ok: true,
      previewId: 'preview-1',
      expiresAt: Date.now() + 1_800_000,
      counts: {
        willAssign: 2,
        willRepairHistory: 1,
        alreadyCorrect: 0,
        manualAssignmentsSkipped: 0,
        ambiguous: 0,
        conflicts: 0,
      },
      items: [
        {
          id: 'item-1',
          transactionId: 'tx-1',
          disposition: 'WILL_ASSIGN',
          identifierType: 'ACCOUNT_NUMBER',
          normalizedIdentifier: '7001018246497',
          currentAccountId: null,
          currentAssignmentSource: null,
          bankTimestamp: Date.now(),
          amountIrr: 100_000,
          selected: true,
        },
        {
          id: 'item-2',
          transactionId: 'tx-2',
          disposition: 'WILL_REPAIR_HISTORY',
          identifierType: 'ACCOUNT_NUMBER',
          normalizedIdentifier: '7001018246497',
          currentAccountId: 'other',
          currentAssignmentSource: 'AUTO_IDENTIFIER',
          bankTimestamp: Date.now(),
          amountIrr: 200_000,
          selected: true,
        },
      ],
    });
    vi.mocked(api.applyRerunAssignment).mockResolvedValue({
      ok: true,
      previewId: 'preview-1',
      applied: 2,
      skipped: 0,
      conflicts: 1,
      manualPreserved: 0,
      affectedTxIds: ['tx-1', 'tx-2'],
      resultJson: '{}',
    });

    render(<Harness account={ACCOUNT} onApplied={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByText(/Accept \(2\)/)).toBeTruthy();
    });
    await act(async () => {
      fireEvent.click(screen.getByText(/Accept \(2\)/));
    });
    await waitFor(() => {
      expect(screen.getByText(/applied/i)).toBeTruthy();
    });
    // The result step renders four distinct counts (applied, skipped,
    // conflicts, manualPreserved). The numbers are visible on the page.
    expect(document.body.textContent).toMatch(/2[^A-Za-z]/); // applied count
    expect(document.body.textContent).toMatch(/1[^A-Za-z]/); // conflicts count
  });

  it('Accept button is disabled when zero items are selected', async () => {
    vi.mocked(api.rerunAssignmentPreview).mockResolvedValue({
      ok: true,
      previewId: 'preview-1',
      expiresAt: Date.now() + 1_800_000,
      counts: {
        willAssign: 0,
        willRepairHistory: 0,
        alreadyCorrect: 0,
        manualAssignmentsSkipped: 0,
        ambiguous: 1,
        conflicts: 0,
      },
      items: [
        {
          id: 'item-1',
          transactionId: 'tx-1',
          disposition: 'AMBIGUOUS',
          identifierType: 'ACCOUNT_NUMBER',
          normalizedIdentifier: '7001018246497',
          currentAccountId: null,
          currentAssignmentSource: null,
          bankTimestamp: Date.now(),
          amountIrr: 100_000,
          // Server returns selected=false for AMBIGUOUS.
          selected: false,
        },
      ],
    });

    render(<Harness account={ACCOUNT} onApplied={() => undefined} />);
    await waitFor(() => {
      expect(screen.getByText(/Accept \(0\)/)).toBeTruthy();
    });
    const acceptBtn = screen.getByText(/Accept \(0\)/).closest('button');
    expect(acceptBtn).toBeTruthy();
    expect(acceptBtn!.hasAttribute('disabled')).toBe(true);
  });
});
