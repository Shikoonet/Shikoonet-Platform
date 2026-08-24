import { useEffect, useState } from 'react';
import type { Cache } from './query.js';
import { useMediaQuery } from './useMediaQuery.js';
import { forMutation, QK } from './queries.js';
import { count } from '../format.js';
import { useWriteProps } from '../role.js';
import { formatTomanFromIrr, formatTime } from './format.js';
import { IdentifierText } from './IdentifierText.js';
import { SortableHeader } from './SortableHeader.js';
import { useTableSortState } from './useTableSortState.js';
import { sortBy, type ColumnType } from './sort.js';
import { api } from './api.js';
import type { AccountListItem } from './api.js';
import { DeleteAccountModal } from './DeleteAccountModal.js';
import { ReferencesModal } from './ReferencesModal.js';
import { MoveReferencesModal } from './MoveReferencesModal.js';

interface AccountsViewProps {
  cache: Cache;
}

const ACCOUNTS_COLUMNS = [
  { key: 'display_name', label: 'نام', type: 'text' as ColumnType },
  { key: 'bank_name', label: 'بانک', type: 'text' as ColumnType },
  { key: 'account_hint', label: 'حساب / کارت', type: 'identifier' as ColumnType },
  { key: 'status', label: 'وضعیت', type: 'text' as ColumnType },
];

const MOBILE_SORT_OPTIONS = [
  { value: 'name-asc', label: 'نام: صعودی', column: 'display_name', direction: 'asc' as const },
  { value: 'name-desc', label: 'نام: نزولی', column: 'display_name', direction: 'desc' as const },
  { value: 'recent', label: 'تازه‌ترین', column: 'created_at', direction: 'desc' as const },
];

function formatPaymentCardCell(a: AccountListItem): string {
  const mapped = a.payment_cards ?? [];
  if (mapped.length > 0) {
    return mapped.map((c) => (c.label ? `${c.display} (${c.label})` : c.display)).join(', ');
  }
  if (a.card_last_four) return `*${a.card_last_four}`;
  return '—';
}

export function AccountsView({ cache }: AccountsViewProps) {
  const w = useWriteProps();
  const { data: accountsPayload } = cache.useQuery<{
    ok: boolean;
    items: AccountListItem[];
  }>(QK.accounts, {
    fetcher: async (signal) => {
      const r = await fetch('/api/v1/accounts', { signal });
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) throw new Error('session_expired');
        throw new Error(`${r.status}`);
      }
      return r.json();
    },
  });

  // Review queue: PENDING + DECLINED accounts. The Accounts list itself
  // also shows PENDING / DECLINED rows, but a dedicated block at the top
  // makes the "needs your attention" set visually obvious.
  const { data: pendingPayload } = cache.useQuery<{
    ok: boolean;
    items: AccountListItem[];
  }>(QK.accountsPending, {
    fetcher: async (signal) => {
      const r = await fetch('/api/v1/accounts/pending', { signal });
      if (!r.ok) {
        if (r.status === 401 || r.status === 403) throw new Error('session_expired');
        throw new Error(`${r.status}`);
      }
      return r.json();
    },
  });

  const isMobile = useMediaQuery('(max-width: 639px)');
  const [editing, setEditing] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [referencesFor, setReferencesFor] = useState<string | null>(null);
  const [moveFor, setMoveFor] = useState<string | null>(null);
  const [rerunAssignmentFor, setRerunAssignmentFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const items = accountsPayload?.items ?? [];
  const pendingItems = pendingPayload?.items ?? [];

  // Per-table URL-persisted sort state.
  const [accountsSort, setAccountsSort] = useTableSortState('accounts', {
    column: 'display_name',
    direction: 'asc',
  });
  // Apply the sort each render. Stable: equal keys preserve original order.
  const sortedAccounts = sortBy(
    items,
    accountsSort.column
      ? {
          column: accountsSort.column,
          type: ACCOUNTS_COLUMNS.find((c) => c.key === accountsSort.column)?.type ?? 'text',
          accessor: accountCellAccessor(accountsSort.column),
        }
      : null,
    accountsSort.direction,
  );

  // For mobile, derive a coarse dropdown sort.
  const mobileSortKey = `${accountsSort.column ?? 'display_name'}:${accountsSort.direction}`;
  function onMobileSort(value: string) {
    const opt = MOBILE_SORT_OPTIONS.find((o) => o.value === value);
    if (opt) setAccountsSort({ column: opt.column, direction: opt.direction });
  }

  async function deactivate(id: string) {
    const acc = items.find((x) => x.id === id);
    const name = acc?.display_name ?? id;
    // The strongest press on this screen had the vaguest question. `active` is
    // a soft-delete flag and `status` is the day-to-day lifecycle
    // (`packages/domain/src/accountStatus.ts` says so) — so «بی‌صدا» and «رد»
    // are reversible operational states with a route back, and this one takes
    // the row out of the panel entirely. The other five transitions in this
    // file each name what they cost; walking it on 2026-08-22 this one asked
    // «این حساب غیرفعال شود؟» about no account in particular and then said
    // nothing at all.
    if (
      !window.confirm(
        `«${name}» غیرفعال شود؟ از فهرست حساب‌ها بیرون می‌رود. ` +
          `اگر فقط می‌خواهید موقتاً از «امروز» و تطبیق بیرون بماند، «بی‌صدا» همان کار را می‌کند و برگشتش یک کلیک است.`,
      )
    ) {
      return;
    }
    setBusy(id);
    setError(null);
    try {
      await api.deactivateAccount(id);
      setSuccess(`«${name}» غیرفعال شد.`);
      cache.invalidate(QK.accounts, QK.accountTotals('all_time'));
      setTimeout(() => setSuccess(null), 4000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  /**
   * Run one of the lifecycle transitions (accept / mute / unmute /
   * decline / restore). The server enforces the (from, to) legality
   * with a 409; we surface the typed error so the user sees a clear
   * "this transition is not allowed" message instead of a generic.
   */
  async function runStatusTransition(
    id: string,
    action: 'accept' | 'mute' | 'unmute' | 'decline' | 'restore',
  ) {
    const labels: Record<typeof action, string> = {
      accept: 'این حساب پذیرفته و وارد بررسی فعال شود؟',
      mute: 'این حساب بی‌صدا شود؟ تراکنش‌ها همچنان می‌رسند اما از «امروز»، جمع‌ها و تطبیق بیرون می‌مانند.',
      unmute: 'صدای این حساب برگردد؟ دوباره وارد «امروز»، جمع‌ها و تطبیق می‌شود.',
      decline: 'این حساب رد شود؟ تراکنش‌ها همچنان می‌رسند اما از نماهای عملیاتی بیرون می‌مانند.',
      restore: 'این حساب به صف بررسی برگردد؟',
    };
    if (!window.confirm(labels[action])) return;
    setBusy(id);
    setError(null);
    try {
      const fn =
        action === 'accept'
          ? api.acceptAccount
          : action === 'mute'
            ? api.muteAccount
            : action === 'unmute'
              ? api.unmuteAccount
              : action === 'decline'
                ? api.declineAccount
                : api.restoreAccount;
      const r = await fn(id);
      const acc = items.find((x) => x.id === id);
      // `statusLabel`, not the raw enum: the pill on the row beside this banner
      // already says «فعال», and printing `ACTIVE` here would be a second name
      // for the same state.
      setSuccess(`«${acc?.display_name ?? id}» → ${statusLabel(r.status)}.`);
      cache.invalidate(...forMutation('accountStatusTransition'));
      setTimeout(() => setSuccess(null), 4000);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  function onDeletedAccount(deletedId: string) {
    setDeletingId(null);
    setError(null);
    const acc = items.find((x) => x.id === deletedId);
    setSuccess(`حساب «${acc?.display_name ?? deletedId}» برای همیشه حذف شد.`);
    cache.invalidate(
      QK.accounts,
      QK.accountTotals('today'),
      QK.accountTotals('last_7_days'),
      QK.accountTotals('last_30_days'),
      QK.accountTotals('all_time'),
      QK.unmatched,
      QK.today,
    );
    // Auto-clear success notice after 4s.
    setTimeout(() => setSuccess(null), 4000);
  }

  return (
    <div className="accounts">
      <div className="row toolbar">
        <h2>حساب‌ها ({count(items.length)})</h2>
        <div className="spacer" />
        <button type="button" className="primary" onClick={() => setCreating(true)} {...w}>
          + حساب تازه
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {success && <div className="info">{success}</div>}

      {pendingItems.length > 0 && (
        <div className="review-queue" role="region" aria-label="صف بررسی حساب‌ها">
          <h3>صف بررسی ({count(pendingItems.length)})</h3>
          <p className="muted">
            حساب‌هایی که تازه خودکار کشف شده‌اند این‌جا می‌نشینند. «پذیرش» آن‌ها را وارد «امروز»،
            تطبیق و جمع‌ها می‌کند و «رد» بیرون نگهشان می‌دارد. یک حساب ردشده را می‌شود «بازگرداند»
            تا دوباره به صف بیاید.
          </p>
          <ul className="card-list">
            {pendingItems.map((a) => (
              <li key={a.id} className={`hub-card review-queue-card status-${a.status.toLowerCase()}`}>
                <div className="card-row card-row--top">
                  <strong>{a.display_name}</strong>
                  <span className={`status-pill status-pill--${a.status.toLowerCase()}`}>
                    {statusLabel(a.status)}
                  </span>
                </div>
                <div className="card-row">
                  <span className="label">بانک</span>
                  <span>{a.bank_name || '—'}</span>
                </div>
                {(a.account_hint ||
                  (a.payment_cards?.length ?? 0) > 0 ||
                  a.card_last_four ||
                  a.account_last_four ||
                  a.iban) && (
                  <div className="card-row">
                    <span className="label">شناسه‌ها</span>
                    <span className="ids">
                      <IdentifierText value={a.account_hint} />
                      {(a.payment_cards?.length ?? 0) > 0 ? (
                        <IdentifierText value={formatPaymentCardCell(a)} />
                      ) : a.card_last_four ? (
                        <IdentifierText value={`*${a.card_last_four}`} />
                      ) : null}
                      {a.account_last_four ? (
                        <IdentifierText value={`*${a.account_last_four}`} />
                      ) : null}
                      <IdentifierText value={a.iban} />
                    </span>
                  </div>
                )}
                <div className="card-row">
                  <span className="label">شناسایی‌شده</span>
                  <span>{formatTime(a.created_at)}</span>
                </div>
                <div className="card-actions">
                  {a.status === 'PENDING' && (
                    <>
                      <button
                        type="button"
                        disabled={busy === a.id}
                        onClick={() => runStatusTransition(a.id, 'accept')}
                        {...w}
                      >
                        پذیرش
                      </button>
                      <button
                        type="button"
                        className="danger"
                        disabled={busy === a.id}
                        onClick={() => runStatusTransition(a.id, 'decline')}
                        {...w}
                      >
                        رد
                      </button>
                    </>
                  )}
                  {a.status === 'DECLINED' && (
                    <button
                      type="button"
                      disabled={busy === a.id}
                      onClick={() => runStatusTransition(a.id, 'restore')}
                    >
                      بازگرداندن
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(a.id);
                    }}
                  >
                    ویرایش
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {creating && (
        <AccountEditor
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            cache.invalidate(QK.accounts, QK.unmatched, QK.today);
          }}
        />
      )}

      {items.length === 0 ? (
        <p className="empty">هیچ حسابی ثبت نشده.</p>
      ) : isMobile ? (
        <>
          <SortDropdown
            label="مرتب‌سازی حساب‌ها"
            value={mobileSortKey}
            options={MOBILE_SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={onMobileSort}
          />
          <ul className="card-list" aria-label="حساب‌ها">
            {sortedAccounts.map((a) => (
              <AccountCard
                key={a.id}
                a={a}
                busy={busy === a.id}
                onEdit={() => setEditing(a.id)}
                onDeactivate={() => deactivate(a.id)}
                onDelete={() => setDeletingId(a.id)}
                onRerunAssignment={() => setRerunAssignmentFor(a.id)}
                onAccept={() => runStatusTransition(a.id, 'accept')}
                onDecline={() => runStatusTransition(a.id, 'decline')}
                onMute={() => runStatusTransition(a.id, 'mute')}
                onUnmute={() => runStatusTransition(a.id, 'unmute')}
                onRestore={() => runStatusTransition(a.id, 'restore')}
              />
            ))}
          </ul>
        </>
      ) : (
        <div className="data-table-wrapper">
          <table className="data-table">
            <thead>
              <tr>
                {ACCOUNTS_COLUMNS.map((c) => (
                  <SortableHeader
                    key={c.key}
                    column={c.key}
                    label={c.label}
                    state={accountsSort}
                    onChange={setAccountsSort}
                  />
                ))}
                <th>عملیات</th>
              </tr>
            </thead>
            <tbody>
              {sortedAccounts.map((a) => {
                const idDisplay = accountCellAccessor('account_hint')(a);
                return (
                  <tr key={a.id} className={a.active ? '' : 'dim'}>
                    <td>{a.display_name}</td>
                    <td>{a.bank_name}</td>
                    <td>
                      <IdentifierText value={String(idDisplay || '')} />
                    </td>
                    <td>
                      <span className={`status-pill status-pill--${a.status.toLowerCase()}`}>
                        {statusLabel(a.status)}
                      </span>
                    </td>
                    <td className="actions-cell">
                      <button type="button" onClick={() => setEditing(a.id)}>
                        ویرایش
                      </button>{' '}
                      <button
                        type="button"
                        disabled={a.status !== 'ACTIVE'}
                        onClick={() => setRerunAssignmentFor(a.id)}
                        {...w}
                      >
                        اجرای دوبارهٔ تخصیص
                      </button>
                      {a.status === 'PENDING' && (
                        <>
                          <button
                            type="button"
                            disabled={busy === a.id}
                            onClick={() => runStatusTransition(a.id, 'accept')}
                            {...w}
                          >
                            پذیرش
                          </button>
                          <button
                            type="button"
                            className="danger"
                            disabled={busy === a.id}
                            onClick={() => runStatusTransition(a.id, 'decline')}
                            {...w}
                          >
                            رد
                          </button>
                        </>
                      )}
                      {a.status === 'ACTIVE' && (
                        <button
                          type="button"
                          disabled={busy === a.id}
                          onClick={() => runStatusTransition(a.id, 'mute')}
                        >
                          بی‌صدا
                        </button>
                      )}
                      {a.status === 'MUTED' && (
                        <button
                          type="button"
                          disabled={busy === a.id}
                          onClick={() => runStatusTransition(a.id, 'unmute')}
                        >
                          باصدا
                        </button>
                      )}
                      {a.status === 'DECLINED' && (
                        <button
                          type="button"
                          disabled={busy === a.id}
                          onClick={() => runStatusTransition(a.id, 'restore')}
                        >
                          بازگرداندن
                        </button>
                      )}
                      {a.active ? (
                        <button
                          type="button"
                          className="danger"
                          disabled={busy === a.id}
                          onClick={() => deactivate(a.id)}
                          {...w}
                        >
                          غیرفعال‌کردن
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="danger"
                          disabled={busy === a.id}
                          onClick={() => setDeletingId(a.id)}
                          {...w}
                        >
                          حذف همیشگی
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <AccountEditor
          account={items.find((x) => x.id === editing)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            cache.invalidate(QK.accounts, QK.unmatched);
          }}
          onCardsChanged={() => cache.invalidate(QK.accounts)}
        />
      )}
      {deletingId && (
        <DeleteAccountModal
          account={
            items.find((x) => x.id === deletingId) ?? {
              ...emptyAccountStub(deletingId),
              display_name: deletingId,
            }
          }
          onClose={() => setDeletingId(null)}
          onDeleted={(deletedId) => onDeletedAccount(deletedId)}
          onMoveReferences={() => {
            setDeletingId(null);
            setMoveFor(deletingId);
          }}
        />
      )}
      {referencesFor && (
        <ReferencesModal
          account={
            items.find((x) => x.id === referencesFor) ?? {
              ...emptyAccountStub(referencesFor),
              display_name: referencesFor,
            }
          }
          onClose={() => setReferencesFor(null)}
          onMove={(id) => {
            setReferencesFor(null);
            setMoveFor(id);
          }}
        />
      )}
      {moveFor && (
        <MoveReferencesModal
          source={
            items.find((x) => x.id === moveFor) ?? {
              ...emptyAccountStub(moveFor),
              display_name: moveFor,
            }
          }
          accounts={items}
          onClose={() => setMoveFor(null)}
          onMoved={(deleted) => {
            setMoveFor(null);
            cache.invalidate(QK.accounts, QK.unmatched, QK.today, QK.suggested, QK.reviewedMatches);
            setSuccess(deleted ? 'حساب مبدأ ادغام و حذف شد.' : 'ارجاع‌ها منتقل شدند.');
          }}
        />
      )}
      {rerunAssignmentFor && (
        <RerunAssignmentModal
          account={
            items.find((x) => x.id === rerunAssignmentFor) ?? {
              ...emptyAccountStub(rerunAssignmentFor),
              display_name: rerunAssignmentFor,
            }
          }
          onClose={() => setRerunAssignmentFor(null)}
          onApplied={() => {
            setRerunAssignmentFor(null);
            cache.invalidate(...forMutation('rerunAssignment'));
          }}
        />
      )}
      {success && (
        <div className="success-banner" role="status">
          {success}
          <button type="button" onClick={() => setSuccess(null)} aria-label="بستن">
            ×
          </button>
        </div>
      )}
    </div>
  );
}

interface EditorProps {
  account?: AccountListItem | undefined;
  onClose: () => void;
  onSaved: () => void;
  onCardsChanged?: () => void;
}

function emptyAccountStub(id: string): AccountListItem {
  return {
    id,
    bank_name: '',
    display_name: '',
    owner_label: null,
    account_type: 'OTHER',
    account_hint: null,
    card_last_four: null,
    account_last_four: null,
    iban: null,
    device_id: null,
    active: 0,
    status: 'PENDING',
    parser_configuration: '{}',
    created_at: 0,
    updated_at: 0,
    device_display_name: null,
    additional_identifiers: [],
  };
}

function statusLabel(status: 'PENDING' | 'ACTIVE' | 'MUTED' | 'DECLINED'): string {
  switch (status) {
    case 'PENDING':
      return 'در انتظار بررسی';
    case 'ACTIVE':
      return 'فعال';
    case 'MUTED':
      return 'بی‌صدا';
    case 'DECLINED':
      return 'ردشده';
  }
}

function accountCellAccessor(column: string): (a: AccountListItem) => unknown {
  return (a) => {
    switch (column) {
      case 'account_hint': {
        const parts = [
          a.account_hint,
          formatPaymentCardCell(a) !== '—' ? formatPaymentCardCell(a) : null,
          a.iban,
        ].filter(Boolean);
        return parts.join(' · ');
      }
      case 'device_display_name':
        return a.device_display_name ?? '';
      case 'status':
        return a.status;
      case 'created_at':
        return a.created_at;
      default:
        return (a as unknown as Record<string, unknown>)[column] ?? null;
    }
  };
}

function AccountCard({
  a,
  busy,
  onEdit,
  onDeactivate,
  onDelete,
  onRerunAssignment,
  onAccept,
  onDecline,
  onMute,
  onUnmute,
  onRestore,
}: {
  a: AccountListItem;
  busy: boolean;
  onEdit: () => void;
  onDeactivate: () => void;
  onDelete: () => void;
  onRerunAssignment: () => void;
  onAccept: () => void;
  onDecline: () => void;
  onMute: () => void;
  onUnmute: () => void;
  onRestore: () => void;
}) {
  const w = useWriteProps();
  return (
    <li className={`hub-card account-card${a.active ? '' : ' dim'}`}>
      <div className="card-row card-row--top">
        <strong>{a.display_name}</strong>
        <span className={`status-pill status-pill--${a.status.toLowerCase()}`}>
          {statusLabel(a.status)}
        </span>
      </div>
      <div className="card-row">
        <span className="label">بانک</span>
        <span>{a.bank_name}</span>
      </div>
      {(a.account_hint ||
        (a.payment_cards?.length ?? 0) > 0 ||
        a.card_last_four ||
        a.account_last_four ||
        a.iban) && (
        <div className="card-row">
          <span className="label">شناسه‌ها</span>
          <span className="ids">
            <IdentifierText value={a.account_hint} />
            {(a.payment_cards?.length ?? 0) > 0 ? (
              <IdentifierText value={formatPaymentCardCell(a)} />
            ) : a.card_last_four ? (
              <IdentifierText value={`*${a.card_last_four}`} />
            ) : null}
            {a.account_last_four ? <IdentifierText value={`*${a.account_last_four}`} /> : null}
            <IdentifierText value={a.iban} />
          </span>
        </div>
      )}

      <div className="card-actions">
        <button type="button" onClick={onEdit}>
          ویرایش
        </button>
        <button type="button" disabled={a.status !== 'ACTIVE'} onClick={onRerunAssignment} {...w}>
          اجرای دوبارهٔ تخصیص
        </button>
        {a.status === 'PENDING' && (
          <>
            <button type="button" disabled={busy} onClick={onAccept} {...w}>
              پذیرش
            </button>
            <button type="button" className="danger" disabled={busy} onClick={onDecline} {...w}>
              رد
            </button>
          </>
        )}
        {a.status === 'ACTIVE' && (
          <button type="button" disabled={busy} onClick={onMute} {...w}>
            بی‌صدا
          </button>
        )}
        {a.status === 'MUTED' && (
          <button type="button" disabled={busy} onClick={onUnmute}>
            باصدا
          </button>
        )}
        {a.status === 'DECLINED' && (
          <button type="button" disabled={busy} onClick={onRestore} {...w}>
            بازگرداندن
          </button>
        )}
        {a.active ? (
          <button type="button" className="danger" disabled={busy} onClick={onDeactivate} {...w}>
            غیرفعال‌کردن
          </button>
        ) : (
          <button type="button" className="danger" disabled={busy} onClick={onDelete} {...w}>
            حذف همیشگی
          </button>
        )}
      </div>
    </li>
  );
}

function SortDropdown({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  return (
    <div className="row toolbar sort-dropdown">
      <label htmlFor="sort">{label}:</label>
      <select id="sort" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

interface PaymentCardRow {
  id: string;
  card_digits: string;
  display: string;
  label: string | null;
  status: string;
  /** How many turns this card takes for every one turn a weight-1 card takes. */
  display_weight: number;
  bank_name: string | null;
  luhn_ok: boolean;
}

function PaymentCardsPanel({
  accountId,
  onChanged,
}: {
  accountId: string;
  onChanged?: () => void;
}) {
  const w = useWriteProps();
  const [cards, setCards] = useState<PaymentCardRow[]>([]);
  const [newCard, setNewCard] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [moveOffer, setMoveOffer] = useState<{ cardNumber: string; message: string } | null>(null);

  async function load() {
    const r = await fetch(`/api/v1/accounts/${accountId}/payment-cards`);
    if (!r.ok) {
      setErr(`بارگذاری کارت‌ها ناموفق بود (${r.status})`);
      return;
    }
    const j = (await r.json()) as { items: PaymentCardRow[] };
    setCards(j.items);
  }

  async function setWeight(id: string, displayWeight: number) {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/v1/payment-cards/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ displayWeight }),
      });
      if (!r.ok) throw new Error(`تغییر وزن ناموفق بود (${r.status})`);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    void load();
  }, [accountId]);

  async function addCard(moveIfMapped = false) {
    setBusy(true);
    setErr(null);
    setMoveOffer(null);
    try {
      const r = await fetch(`/api/v1/accounts/${accountId}/payment-cards`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cardNumber: newCard, label: label || undefined, moveIfMapped }),
      });
      const j = (await r.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
      };
      if (!r.ok) {
        if (j.error === 'card_already_mapped' && !moveIfMapped) {
          setMoveOffer({
            cardNumber: newCard,
            message: j.message ?? 'این کارت به حساب دیگری نگاشت شده است.',
          });
          return;
        }
        throw new Error(j.message ?? j.error ?? `${r.status}`);
      }
      setNewCard('');
      setLabel('');
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function removeCard(id: string) {
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/v1/payment-cards/${id}`, { method: 'DELETE' });
    if (!r.ok) setErr(`حذف ناموفق بود (${r.status})`);
    await load();
    onChanged?.();
    setBusy(false);
  }

  return (
    <div className="payment-cards-panel">
      <h4>کارت‌های پرداخت ربات</h4>
      <p className="muted">
        شماره‌کارت‌هایی که به مشتری نشان داده می‌شود را به این حساب مالی نگاشت کن. فقط خودِ کارت ۱۶
        رقمی را بنویس، نه نام حساب.
      </p>
      {err && <div className="error">{err}</div>}
      {moveOffer && (
        <div className="info">
          <p>{moveOffer.message}</p>
          <button type="button" disabled={busy} onClick={() => addCard(true)}>
            انتقال کارت به این حساب
          </button>
        </div>
      )}
      <ul className="payment-cards-list">
        {cards.length === 0 && <li className="muted">هنوز کارتی به این حساب نگاشت نشده.</li>}
        {cards.map((c) => (
          <li key={c.id}>
            <span className="payment-cards-list__id">
              <IdentifierText value={c.display} />
              {c.label ? ` (${c.label})` : ''}
              {c.bank_name && <span className="badge">{c.bank_name}</span>}
              {/* A card number that fails its own check digit cannot exist. One
                  such row is live in production and quietly broke claim-to-account
                  resolution for a whole bank until a human counted the digits. */}
              {!c.luhn_ok && <span className="badge badge-block">رقم کنترلی نادرست</span>}
              {c.status !== 'ACTIVE' && <span className="badge">{c.status}</span>}
            </span>
            <span className="payment-cards-list__actions">
              <label>
                نمایش{' '}
                <select
                  value={c.display_weight}
                  disabled={busy}
                  onChange={(e) => void setWeight(c.id, Number(e.target.value))}
                >
                  {Array.from({ length: 20 }, (_, i) => i + 1).map((w) => (
                    <option key={w} value={w}>
                      {w === 1 ? 'معمولی (۱×)' : `${count(w)}× بیشتر`}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="btn-sm danger"
                disabled={busy}
                onClick={() => removeCard(c.id)}
                {...w}
              >
                حذف
              </button>
            </span>
          </li>
        ))}
      </ul>
      <p className="muted">
        چرخش، کارتی را می‌دهد که بیش از همه عقب افتاده است. وزن ۳ یعنی این کارت سه برابر یک کارت
        معمولی بالا می‌آید — اما هیچ‌وقت تنها کارتِ نشان‌داده‌شده نمی‌شود. برای کارتی که تازه اضافه
        شده وزن را بالا ببر تا شمار تراکنش‌هایش در صفحهٔ «آمار مالی» به بقیه برسد، بعد به ۱ برگردان.
      </p>
      <div className="row toolbar">
        <input
          placeholder="5047-0616-7456-0137"
          value={newCard}
          onChange={(e) => setNewCard(e.target.value)}
        />
        <input
          placeholder="برچسب (اختیاری)"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
        <button
          type="button"
          className="primary"
          disabled={busy || !newCard.trim()}
          onClick={() => addCard(false)}
          {...w}
        >
          افزودن کارت
        </button>
      </div>
    </div>
  );
}

function AccountEditor({ account, onClose, onSaved, onCardsChanged }: EditorProps) {
  const w = useWriteProps();
  const [bankName, setBankName] = useState(account?.bank_name ?? '');
  const [displayName, setDisplayName] = useState(account?.display_name ?? '');
  const [accountType, setAccountType] = useState<'CARD' | 'ACCOUNT' | 'IBAN' | 'OTHER'>(
    (account?.account_type as 'CARD' | 'ACCOUNT' | 'IBAN' | 'OTHER') ?? 'ACCOUNT',
  );
  const [accountHint, setAccountHint] = useState(account?.account_hint ?? '');
  const [cardLastFour, setCardLastFour] = useState(account?.card_last_four ?? '');
  const [accountLastFour, setAccountLastFour] = useState(account?.account_last_four ?? '');
  const [iban, setIban] = useState(account?.iban ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const body = {
        bank_name: bankName,
        display_name: displayName,
        account_type: accountType,
        account_hint: accountHint || null,
        card_last_four: cardLastFour || null,
        account_last_four: accountLastFour || null,
        iban: iban || null,
      };
      if (account) await api.updateAccount(account.id, body);
      else await api.createAccount(body);
      onSaved();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal onClose={onClose} label={account ? 'ویرایش حساب' : 'حساب تازه'}>
      {err && <div className="error">{err}</div>}
      <div className="form">
        <label>
          <span>نام بانک</span>
          <input value={bankName} onChange={(e) => setBankName(e.target.value)} />
        </label>
        <label>
          <span>نام نمایشی</span>
          <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </label>
        <label>
          <span>نوع حساب</span>
          <select
            value={accountType}
            onChange={(e) =>
              setAccountType(e.target.value as 'CARD' | 'ACCOUNT' | 'IBAN' | 'OTHER')
            }
          >
            <option value="ACCOUNT">حساب</option>
            <option value="CARD">کارت</option>
            <option value="IBAN">شبا</option>
            <option value="OTHER">دیگر</option>
          </select>
        </label>
        <label>
          <span>شمارهٔ کامل حساب</span>
          <input value={accountHint} onChange={(e) => setAccountHint(e.target.value)} />
        </label>
        <label>
          <span>۴ رقم آخر کارت</span>
          <input
            value={cardLastFour}
            maxLength={4}
            onChange={(e) => setCardLastFour(e.target.value.replace(/\D/g, '').slice(0, 4))}
          />
        </label>
        <label>
          <span>۴ رقم آخر حساب</span>
          <input
            value={accountLastFour}
            maxLength={4}
            onChange={(e) => setAccountLastFour(e.target.value.replace(/\D/g, '').slice(0, 4))}
          />
        </label>
        <label>
          <span>شبا</span>
          <input value={iban} onChange={(e) => setIban(e.target.value)} />
        </label>
      </div>
      {account?.id && (
        <PaymentCardsPanel
          accountId={account.id}
          {...(onCardsChanged ? { onChanged: onCardsChanged } : {})}
        />
      )}
      <div className="row toolbar modal-actions">
        <button type="button" onClick={onClose}>
          انصراف
        </button>
        <div className="spacer" />
        <button
          type="button"
          className="primary"
          disabled={busy || !bankName || !displayName}
          onClick={save}
          {...w}
        >
          {account ? 'ذخیره' : 'ساخت'}
        </button>
      </div>
    </Modal>
  );
}

/** Local modal helper so AccountEditor doesn't repeat markup. */
interface ModalProps {
  label: string;
  onClose: () => void;
  children: React.ReactNode;
}
function Modal({ label, onClose, children }: ModalProps) {
  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-body">
        <div className="row toolbar">
          <h3>{label}</h3>
          <div className="spacer" />
          <button type="button" onClick={onClose} aria-label="بستن">
            ×
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// RerunAssignmentModal — staged preview / apply / decline.
//
// State machine: idle → analyzing → preview → applying → result → idle.
// All local state is owned by this component, so the parent AccountsView
// polling (5s cache invalidation under the modal) cannot close it or
// reset its state — same pattern as SampleAnalyzer above.
// ---------------------------------------------------------------------------

type RerunStep = 'analyzing' | 'preview' | 'applying' | 'result';

interface RerunPreviewItem {
  id: string;
  transactionId: string;
  disposition: 'WILL_ASSIGN' | 'WILL_REPAIR_HISTORY' | 'AMBIGUOUS';
  identifierType: string | null;
  normalizedIdentifier: string | null;
  currentAccountId: string | null;
  currentAssignmentSource: string | null;
  bankTimestamp: number | null;
  amountIrr: number | null;
  selected: boolean;
}

interface RerunCounts {
  willAssign: number;
  willRepairHistory: number;
  alreadyCorrect: number;
  manualAssignmentsSkipped: number;
  ambiguous: number;
  conflicts: number;
}

interface RerunApplyResult {
  applied: number;
  skipped: number;
  conflicts: number;
  manualPreserved: number;
  affectedTxIds: string[];
}

export function RerunAssignmentModal({
  account,
  onClose,
  onApplied,
}: {
  account: AccountListItem;
  onClose: () => void;
  onApplied: () => void;
}) {
  const [step, setStep] = useState<RerunStep>('analyzing');
  const [err, setErr] = useState<string | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [counts, setCounts] = useState<RerunCounts | null>(null);
  const [items, setItems] = useState<RerunPreviewItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<RerunApplyResult | null>(null);

  // Kick off preview on mount. Component is keyed by account.id in parent,
  // so re-opening for a different account remounts and re-fetches.
  useEffect(() => {
    let cancelled = false;
    setStep('analyzing');
    setErr(null);
    setResult(null);
    setItems([]);
    setSelectedIds(new Set());
    (async () => {
      try {
        const r = await api.rerunAssignmentPreview(account.id);
        if (cancelled) return;
        if (!r.ok) {
          setErr('پیش‌نمایش ناموفق بود');
          setStep('preview');
          return;
        }
        setPreviewId(r.previewId);
        setCounts(r.counts);
        // Server returns ALREADY_CORRECT items only in the counts banner,
        // never in the items list. We drop any ALREADY_CORRECT items
        // defensively in case a future server change adds them.
        const listable = r.items.filter(
          (i) =>
            i.disposition === 'WILL_ASSIGN' ||
            i.disposition === 'WILL_REPAIR_HISTORY' ||
            i.disposition === 'AMBIGUOUS',
        );
        setItems(listable as RerunPreviewItem[]);
        // Default selection: every selected item from server (already
        // excludes AMBIGUOUS by definition). AMBIGUOUS items arrive with
        // selected=false.
        setSelectedIds(new Set(r.items.filter((i) => i.selected).map((i) => i.id)));
        setStep('preview');
      } catch (e) {
        if (!cancelled) {
          setErr(String(e));
          setStep('preview');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [account.id]);

  async function onDecline() {
    if (!previewId) {
      onClose();
      return;
    }
    setErr(null);
    try {
      await api.declineRerunAssignment(account.id, previewId);
      onClose();
    } catch (e) {
      // 409 etc — surface but still close (the preview is no longer
      // useful; the user can re-open and re-run).
      setErr(String(e));
      onClose();
    }
  }

  async function onAccept() {
    if (!previewId) return;
    setStep('applying');
    setErr(null);
    try {
      // Translate item.id back to transaction_id for the server.
      const idsByTxId = new Map(items.map((i) => [i.id, i.transactionId]));
      const selectedTxIds = Array.from(selectedIds)
        .map((id) => idsByTxId.get(id))
        .filter((v): v is string => !!v);
      const r = await api.applyRerunAssignment(account.id, previewId, selectedTxIds);
      if (!r.ok) {
        setErr('اعمال ناموفق بود');
        setStep('preview');
        return;
      }
      setResult({
        applied: r.applied,
        skipped: r.skipped,
        conflicts: r.conflicts,
        manualPreserved: r.manualPreserved,
        affectedTxIds: r.affectedTxIds,
      });
      setStep('result');
    } catch (e) {
      setErr(String(e));
      setStep('preview');
    }
  }

  function toggleSelected(itemId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(itemId)) next.delete(itemId);
      else next.add(itemId);
      return next;
    });
  }

  return (
    <Modal
      onClose={step === 'applying' ? () => undefined : onClose}
      label={`اجرای دوبارهٔ تخصیص حساب — ${account.display_name}`}
    >
      {err && <div className="error">{err}</div>}
      {step === 'analyzing' && (
        <p className="muted">در حال بررسی تراکنش‌های گذشته در برابر شناسه‌های این حساب…</p>
      )}
      {step === 'preview' && counts && (
        <>
          <div className="row" style={{ gap: '1rem', flexWrap: 'wrap' }}>
            <div>
              <strong>{count(counts.willAssign)}</strong> تخصیص می‌یابد
            </div>
            <div>
              <strong>{count(counts.willRepairHistory)}</strong> تاریخچه اصلاح می‌شود
            </div>
            <div>
              <strong>{count(counts.alreadyCorrect)}</strong> از قبل درست است
            </div>
            <div>
              <strong>{count(counts.manualAssignmentsSkipped)}</strong> تخصیص دستی حفظ می‌شود
            </div>
            <div>
              <strong>{count(counts.ambiguous)}</strong> مبهم
            </div>
          </div>
          {items.length === 0 ? (
            <p className="muted">هیچ تراکنش نامزدی پیدا نشد.</p>
          ) : (
            <ul className="list-plain">
              {items.map((it) => {
                const isAmbiguous = it.disposition === 'AMBIGUOUS';
                const checked = selectedIds.has(it.id) || isAmbiguous;
                return (
                  <li key={it.id}>
                    <label
                      style={{
                        display: 'flex',
                        gap: '0.5rem',
                        alignItems: 'center',
                        opacity: isAmbiguous ? 0.6 : 1,
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={isAmbiguous || step !== 'preview'}
                        onChange={() => toggleSelected(it.id)}
                      />
                      <span>
                        {it.disposition === 'WILL_REPAIR_HISTORY' ? 'اصلاح تاریخچه' : 'تخصیص'} ·{' '}
                        {it.identifierType ?? '—'}={it.normalizedIdentifier ?? '—'} ·{' '}
                        {it.amountIrr != null ? formatTomanFromIrr(it.amountIrr) : '—'}
                        {it.bankTimestamp != null ? ` · ${formatTime(it.bankTimestamp)}` : ''}
                        {isAmbiguous && (
                          <span className="muted"> · این شناسه به چند حساب می‌خورد</span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <div className="row toolbar modal-actions">
            <button type="button" onClick={onDecline} disabled={step !== 'preview'}>
              رد
            </button>
            <div className="spacer" />
            <button
              type="button"
              className="primary"
              disabled={step !== 'preview' || selectedIds.size === 0}
              onClick={onAccept}
            >
              پذیرش ({count(selectedIds.size)})
            </button>
          </div>
        </>
      )}
      {step === 'applying' && <p className="muted">در حال اعمال…</p>}
      {step === 'result' && result && (
        <>
          <div className="row" style={{ gap: '1rem', flexWrap: 'wrap' }}>
            <div>
              <strong>{count(result.applied)}</strong> اعمال شد
            </div>
            <div>
              <strong>{count(result.skipped)}</strong> رد شد
            </div>
            <div>
              <strong>{count(result.conflicts)}</strong> تعارض
            </div>
            <div>
              <strong>{count(result.manualPreserved)}</strong> تخصیص دستی حفظ شد
            </div>
          </div>
          <div className="row toolbar modal-actions">
            <div className="spacer" />
            <button type="button" onClick={onApplied}>
              Close
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
