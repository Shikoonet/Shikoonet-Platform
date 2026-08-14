/**
 * Customers — look one up, see their wallet, correct it, block them.
 *
 * The first screen in this dashboard that is not about reconciling a payment.
 * It exists because the only place an admin could do any of this was the PHP
 * bot's own panel, and after the switchover that panel goes away.
 *
 * Three things here are deliberate, and each is a thing the panel it replaces
 * does the other way:
 *
 *   **The list is paged by the server.** `panel/users.php` sends all 11,241
 *   rows into one page and sorts them in the browser. Twenty-five at a time,
 *   searched in SQL.
 *
 *   **An adjustment carries a reason and an idempotency key.** The key is
 *   minted once when the form opens, so the double-tap that a slow request
 *   invites collapses onto one ledger row in the database rather than being
 *   prevented by a disabled button. The reason lands in `audit_logs`.
 *
 *   **A balance going negative is shown, not hidden.** An admin correcting a
 *   credit the customer already spent has to be able to do it; a typo that
 *   would do it by accident should be visible before it is confirmed.
 *
 * Amounts are entered and shown in Toman, the unit the admin and the customer
 * both use, and converted at this edge only — the API speaks IRR, like the
 * rest of the platform.
 */

import { useEffect, useState } from 'react';
import { formatTomanFromIrr, irrToToman, formatTime } from './format.js';

interface CustomerListItem {
  id: number;
  telegramId: number;
  username: string | null;
  phone: string | null;
  status: string;
  isReseller: boolean;
  discountPercent: number;
  balanceIrr: number;
  registeredAt: string;
  lastSeenAt: string | null;
}

interface WalletEntryRow {
  amountIrr: number;
  kind: string;
  actor: string | null;
  note: string | null;
  createdAt: string;
}

interface CustomerDetail {
  id: number;
  telegramId: number;
  username: string | null;
  phone: string | null;
  phoneVerified: boolean;
  status: string;
  blockedReason: string | null;
  isReseller: boolean;
  discountPercent: number;
  referralCode: string | null;
  balanceIrr: number;
  registeredAt: string;
  lastSeenAt: string | null;
  orderCount: number;
  paidTotalIrr: number;
}

const PAGE_SIZE = 25;

const KIND_LABEL: Record<string, string> = {
  OPENING: 'Opening',
  TOPUP: 'Top-up',
  PURCHASE: 'Purchase',
  REFUND: 'Refund',
  ADMIN_ADJUST: 'Admin adjustment',
  GIFT_CODE: 'Gift code',
  REFERRAL_BONUS: 'Referral bonus',
  WHEEL_PRIZE: 'Wheel prize',
  TRANSFER_IN: 'Transfer in',
  TRANSFER_OUT: 'Transfer out',
};

async function readJson<T>(r: Response): Promise<T & { error?: string; detail?: string }> {
  return (await r.json().catch(() => ({}))) as T & { error?: string; detail?: string };
}

function localDate(iso: string | null): string {
  if (!iso) return '—';
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? iso : formatTime(ms);
}

export function CustomersView() {
  const [rows, setRows] = useState<CustomerListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'' | 'ACTIVE' | 'BLOCKED'>('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
    if (q.trim()) params.set('q', q.trim());
    if (status) params.set('status', status);
    try {
      const r = await fetch(`/api/v1/customers?${params.toString()}`);
      const j = await readJson<{ items: CustomerListItem[]; total: number }>(r);
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setRows(j.items ?? []);
      setTotal(j.total ?? 0);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // Deliberately not on `q`: the search box refetches when it is submitted,
    // not on every keystroke against 11k rows.
  }, [page, status]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="customers-view">
      <div className="card">
        <div className="card__head">
          <h2>Customers</h2>
          <span className="muted">{total.toLocaleString()} total</span>
        </div>

        <form
          className="customers-filters"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            void load();
          }}
        >
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Telegram id or @username"
            aria-label="Search customers"
          />
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as '' | 'ACTIVE' | 'BLOCKED');
              setPage(1);
            }}
            aria-label="Filter by status"
          >
            <option value="">Any status</option>
            <option value="ACTIVE">Active</option>
            <option value="BLOCKED">Blocked</option>
          </select>
          <button type="submit" disabled={loading}>
            Search
          </button>
        </form>

        {err && <p className="error">{err}</p>}

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>Telegram id</th>
                <th>Username</th>
                <th>Phone</th>
                <th>Balance</th>
                <th>Status</th>
                <th>Registered</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td colSpan={7} className="muted">
                    No customer matches that search.
                  </td>
                </tr>
              )}
              {rows.map((c) => (
                <tr key={c.id}>
                  <td className="ltr">{c.telegramId}</td>
                  <td className="ltr">{c.username ? `@${c.username}` : '—'}</td>
                  <td className="ltr">{c.phone ?? '—'}</td>
                  <td className={c.balanceIrr < 0 ? 'negative' : undefined}>
                    {formatTomanFromIrr(c.balanceIrr)}
                  </td>
                  <td>
                    <span className={c.status === 'BLOCKED' ? 'badge badge-block' : 'badge'}>
                      {c.status === 'BLOCKED' ? 'Blocked' : 'Active'}
                    </span>
                    {c.isReseller && <span className="badge badge-info">Reseller</span>}
                  </td>
                  <td>{localDate(c.registeredAt)}</td>
                  <td>
                    <button type="button" onClick={() => setOpenId(c.id)}>
                      Manage
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="pager">
          <button type="button" disabled={page <= 1 || loading} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span className="muted">
            Page {page} of {lastPage}
          </span>
          <button
            type="button"
            disabled={page >= lastPage || loading}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </div>
      </div>

      {openId !== null && (
        <CustomerPanel
          id={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => {
            void load();
          }}
        />
      )}
    </div>
  );
}

function CustomerPanel({
  id,
  onClose,
  onChanged,
}: {
  id: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [customer, setCustomer] = useState<CustomerDetail | null>(null);
  const [entries, setEntries] = useState<WalletEntryRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [amountToman, setAmountToman] = useState('');
  const [note, setNote] = useState('');
  // Minted once per open panel. Two clicks on Apply send the same key, so the
  // second is a no-op in the database rather than a second ledger row.
  const [adjustKey, setAdjustKey] = useState(() => crypto.randomUUID());
  const [blockReason, setBlockReason] = useState('');

  async function load() {
    setErr(null);
    const r = await fetch(`/api/v1/customers/${id}`);
    const j = await readJson<{ customer: CustomerDetail; entries: WalletEntryRow[] }>(r);
    if (!r.ok) {
      setErr(j.error ?? `${r.status}`);
      return;
    }
    setCustomer(j.customer);
    setEntries(j.entries ?? []);
  }

  useEffect(() => {
    void load();
  }, [id]);

  const parsedToman = Number(amountToman);
  const amountIrr =
    amountToman.trim() !== '' && Number.isFinite(parsedToman) ? Math.round(parsedToman) * 10 : 0;
  const projected = (customer?.balanceIrr ?? 0) + amountIrr;
  const wouldGoNegative = amountIrr !== 0 && projected < 0;

  async function adjust() {
    if (amountIrr === 0 || note.trim() === '') return;
    if (
      wouldGoNegative &&
      !window.confirm(
        `This leaves the balance at ${formatTomanFromIrr(projected)}. Apply it anyway?`,
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/v1/customers/${id}/wallet`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amountIrr, note: note.trim(), idempotencyKey: adjustKey }),
      });
      const j = await readJson<{ applied: boolean }>(r);
      if (!r.ok) throw new Error(j.detail ?? j.error ?? `${r.status}`);
      setAmountToman('');
      setNote('');
      // A fresh key, so the next adjustment is a new one rather than a replay
      // of the one just applied.
      setAdjustKey(crypto.randomUUID());
      await load();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(next: 'ACTIVE' | 'BLOCKED') {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/v1/customers/${id}/status`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          status: next,
          reason: next === 'BLOCKED' ? blockReason.trim() || null : null,
        }),
      });
      const j = await readJson(r);
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setBlockReason('');
      await load();
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="customer-panel card">
      <div className="card__head">
        <h3>
          {customer?.username ? `@${customer.username}` : 'Customer'}{' '}
          <span className="muted ltr">{customer?.telegramId ?? id}</span>
        </h3>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>

      {err && <p className="error">{err}</p>}
      {!customer && !err && <p className="muted">Loading…</p>}

      {customer && (
        <>
          <dl className="customer-facts">
            <div>
              <dt>Balance</dt>
              <dd className={customer.balanceIrr < 0 ? 'negative' : undefined}>
                {formatTomanFromIrr(customer.balanceIrr)}
              </dd>
            </div>
            <div>
              <dt>Phone</dt>
              <dd className="ltr">
                {customer.phone ?? '—'}
                {customer.phone && !customer.phoneVerified && ' (unverified)'}
              </dd>
            </div>
            <div>
              <dt>Orders</dt>
              <dd>
                {customer.orderCount} · {formatTomanFromIrr(customer.paidTotalIrr)} completed
              </dd>
            </div>
            <div>
              <dt>Standing discount</dt>
              <dd>{customer.discountPercent}%</dd>
            </div>
            <div>
              <dt>Registered</dt>
              <dd>{localDate(customer.registeredAt)}</dd>
            </div>
            <div>
              <dt>Last seen</dt>
              <dd>{localDate(customer.lastSeenAt)}</dd>
            </div>
          </dl>

          <section className="customer-adjust">
            <h4>Adjust the wallet</h4>
            <p className="muted">
              A positive amount credits, a negative one debits. Both are recorded in the ledger with
              your email and this reason; neither can be edited afterwards.
            </p>
            <div className="customer-adjust__row">
              <label>
                Amount (Toman)
                <input
                  type="number"
                  value={amountToman}
                  onChange={(e) => setAmountToman(e.target.value)}
                  placeholder="e.g. 50000 or -50000"
                />
              </label>
              <label>
                Reason
                <input
                  type="text"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="why this correction is being made"
                  maxLength={500}
                />
              </label>
              <button
                type="button"
                disabled={busy || amountIrr === 0 || note.trim() === ''}
                onClick={() => void adjust()}
              >
                Apply
              </button>
            </div>
            {amountIrr !== 0 && (
              <p className={wouldGoNegative ? 'error' : 'muted'}>
                {irrToToman(customer.balanceIrr).toLocaleString()} →{' '}
                {irrToToman(projected).toLocaleString()} Toman
                {wouldGoNegative && ' — this leaves the balance negative'}
              </p>
            )}
          </section>

          <section className="customer-status">
            <h4>Account</h4>
            {customer.status === 'BLOCKED' ? (
              <>
                <p className="muted">
                  Blocked{customer.blockedReason ? `: ${customer.blockedReason}` : ''}
                </p>
                <button type="button" disabled={busy} onClick={() => void setStatus('ACTIVE')}>
                  Unblock
                </button>
              </>
            ) : (
              <div className="customer-adjust__row">
                <label>
                  Reason (optional)
                  <input
                    type="text"
                    value={blockReason}
                    onChange={(e) => setBlockReason(e.target.value)}
                    maxLength={500}
                  />
                </label>
                <button type="button" disabled={busy} onClick={() => void setStatus('BLOCKED')}>
                  Block
                </button>
              </div>
            )}
          </section>

          <section className="customer-ledger">
            <h4>Wallet ledger</h4>
            <div className="table-wrap">
              <table className="app-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Kind</th>
                    <th>Amount</th>
                    <th>By</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.length === 0 && (
                    <tr>
                      <td colSpan={5} className="muted">
                        No movements yet.
                      </td>
                    </tr>
                  )}
                  {entries.map((e, i) => (
                    <tr key={`${e.createdAt}-${i}`}>
                      <td>{localDate(e.createdAt)}</td>
                      <td>{KIND_LABEL[e.kind] ?? e.kind}</td>
                      <td className={e.amountIrr < 0 ? 'negative' : undefined}>
                        {e.amountIrr > 0 ? '+' : ''}
                        {formatTomanFromIrr(e.amountIrr)}
                      </td>
                      <td className="ltr">{e.actor ?? '—'}</td>
                      <td>{e.note ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
