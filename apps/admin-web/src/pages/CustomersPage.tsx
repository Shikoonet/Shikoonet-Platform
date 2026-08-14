/**
 * کاربران — find one, read the ledger behind their balance, correct it, block.
 *
 * Three things here are deliberately not what the PHP panel does:
 *
 *   **The list is paged by the server.** `panel/users.php` sends all 11,241
 *   rows into one page and sorts them in the browser. Twenty-five at a time,
 *   searched in SQL.
 *
 *   **A correction carries a reason and an idempotency key.** The key is minted
 *   once when the drawer opens, so a double-tapped «اعمال» collapses onto one
 *   ledger row in the database rather than being prevented by a disabled
 *   button. The reason lands in `audit_logs`, which survives; over there the
 *   only trace is a Telegram message to a report channel.
 *
 *   **A balance going negative is shown before it happens.** An admin
 *   correcting a credit the customer already spent must be able to; a typed
 *   extra zero should be visible first.
 *
 * Amounts are typed and shown in Toman. The API speaks integer Rial, and the
 * conversion happens in `format.ts` and in the one line below that builds the
 * request — nowhere else.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type CustomerDetail, type CustomerListItem, type WalletEntryRow } from '../api.js';
import { count, dateTime, irrToToman, toman } from '../format.js';

const PAGE_SIZE = 25;

const KIND_FA: Record<string, string> = {
  OPENING: 'موجودی اولیه',
  TOPUP: 'شارژ کیف پول',
  PURCHASE: 'خرید',
  REFUND: 'بازگشت وجه',
  ADMIN_ADJUST: 'اصلاح توسط ادمین',
  GIFT_CODE: 'کد هدیه',
  REFERRAL_BONUS: 'پورسانت زیرمجموعه',
  WHEEL_PRIZE: 'جایزهٔ گردونه',
  TRANSFER_IN: 'انتقال ورودی',
  TRANSFER_OUT: 'انتقال خروجی',
};

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'admin_access_not_configured') return 'درِ دسترسی ادمین تنظیم نشده است.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

export function CustomersPage() {
  const [rows, setRows] = useState<CustomerListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);

  async function load(toPage = page) {
    setLoading(true);
    setErr(null);
    try {
      const d = await api.customers({
        page: toPage,
        pageSize: PAGE_SIZE,
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(status ? { status } : {}),
      });
      setRows(d.items);
      setTotal(d.total);
    } catch (e) {
      setErr(message(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(page);
    // Not on `q`: the box searches when it is submitted, not on every
    // keystroke against 11k rows.
  }, [page, status]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">کاربران</div>
          <div className="page-head__sub">{count(total)} کاربر</div>
        </div>
      </div>

      <div className="card">
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            void load(1);
          }}
        >
          <div className="grow">
            <label className="form-label" htmlFor="cust-q">
              جست‌وجو
            </label>
            <input
              id="cust-q"
              className="form-control ltr"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="آیدی عددی یا @نام‌کاربری"
            />
          </div>
          <div>
            <label className="form-label" htmlFor="cust-status">
              وضعیت
            </label>
            <select
              id="cust-status"
              className="form-control"
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
            >
              <option value="">همه</option>
              <option value="ACTIVE">فعال</option>
              <option value="BLOCKED">مسدود</option>
            </select>
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            جست‌وجو
          </button>
        </form>

        {err && <div className="alert alert-error">{err}</div>}

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>آیدی عددی</th>
                <th>نام کاربری</th>
                <th>شماره</th>
                <th>موجودی</th>
                <th>وضعیت</th>
                <th>عضویت</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td className="empty" colSpan={7}>
                    کاربری با این جست‌وجو پیدا نشد.
                  </td>
                </tr>
              )}
              {rows.map((u) => (
                <tr key={u.id}>
                  <td className="ltr">{u.telegramId}</td>
                  <td className="ltr">{u.username ? `@${u.username}` : '—'}</td>
                  <td className="ltr">{u.phone ?? '—'}</td>
                  <td className={u.balanceIrr < 0 ? 'negative' : undefined}>{toman(u.balanceIrr)}</td>
                  <td>
                    <span className={u.status === 'BLOCKED' ? 'badge badge-block' : 'badge badge-active'}>
                      {u.status === 'BLOCKED' ? 'مسدود' : 'فعال'}
                    </span>
                    {u.isReseller && <span className="badge badge-info">نماینده</span>}
                  </td>
                  <td>{dateTime(u.registeredAt)}</td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => setOpenId(u.id)}>
                      مدیریت
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="pager">
          <button
            type="button"
            className="btn btn-sm"
            disabled={page <= 1 || loading}
            onClick={() => setPage(page - 1)}
          >
            قبلی
          </button>
          <span>
            صفحهٔ {count(page)} از {count(lastPage)}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            disabled={page >= lastPage || loading}
            onClick={() => setPage(page + 1)}
          >
            بعدی
          </button>
        </div>
      </div>

      {openId !== null && (
        <CustomerDrawer id={openId} onClose={() => setOpenId(null)} onChanged={() => void load()} />
      )}
    </>
  );
}

function CustomerDrawer({
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
  // Minted once per open drawer, so two clicks on «اعمال» send the same key
  // and the database collapses them onto one row.
  const [adjustKey, setAdjustKey] = useState(() => crypto.randomUUID());
  const [blockReason, setBlockReason] = useState('');

  async function load() {
    setErr(null);
    try {
      const d = await api.customer(id);
      setCustomer(d.customer);
      setEntries(d.entries);
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load();
  }, [id]);

  const typed = Number(amountToman);
  const amountIrr =
    amountToman.trim() !== '' && Number.isFinite(typed) ? Math.round(typed) * 10 : 0;
  const projected = (customer?.balanceIrr ?? 0) + amountIrr;
  const goesNegative = amountIrr !== 0 && projected < 0;

  async function adjust() {
    if (amountIrr === 0 || note.trim() === '') return;
    if (
      goesNegative &&
      !window.confirm(`موجودی به ${toman(projected)} می‌رسد. با این حال اعمال شود؟`)
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.adjustWallet(id, { amountIrr, note: note.trim(), idempotencyKey: adjustKey });
      setAmountToman('');
      setNote('');
      setAdjustKey(crypto.randomUUID());
      await load();
      onChanged();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(next: 'ACTIVE' | 'BLOCKED') {
    setBusy(true);
    setErr(null);
    try {
      await api.setStatus(id, {
        status: next,
        reason: next === 'BLOCKED' ? blockReason.trim() || null : null,
      });
      setBlockReason('');
      await load();
      onChanged();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <span className="card__title">
          {customer?.username ? `@${customer.username}` : 'کاربر'}{' '}
          <span className="muted ltr">{customer?.telegramId ?? id}</span>
        </span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {!customer && !err && <p className="muted">در حال بارگذاری…</p>}

      {customer && (
        <>
          <div className="stats-grid">
            <Fact label="موجودی کیف پول" value={toman(customer.balanceIrr)} negative={customer.balanceIrr < 0} />
            <Fact label="شماره موبایل" value={customer.phone ?? 'ثبت نشده'} ltr />
            <Fact
              label="سفارش‌ها"
              value={`${count(customer.orderCount)} · ${toman(customer.paidTotalIrr)}`}
            />
            <Fact label="تخفیف دائمی" value={`${customer.discountPercent}٪`} />
            <Fact label="عضویت" value={dateTime(customer.registeredAt)} />
            <Fact label="آخرین بازدید" value={dateTime(customer.lastSeenAt)} />
          </div>

          <h4>اصلاح کیف پول</h4>
          <p className="muted" style={{ marginBlockStart: 0 }}>
            عدد مثبت واریز است و منفی برداشت. هر دو با ایمیل شما و همین دلیل در دفتر ثبت می‌شوند و
            بعداً قابل ویرایش نیستند.
          </p>
          <div className="filters">
            <div>
              <label className="form-label" htmlFor="adj-amount">
                مبلغ (تومان)
              </label>
              <input
                id="adj-amount"
                className="form-control ltr"
                type="number"
                value={amountToman}
                onChange={(e) => setAmountToman(e.target.value)}
                placeholder="50000 یا -50000"
              />
            </div>
            <div className="grow">
              <label className="form-label" htmlFor="adj-note">
                دلیل
              </label>
              <input
                id="adj-note"
                className="form-control"
                type="text"
                maxLength={500}
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="چرا این اصلاح انجام می‌شود"
              />
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || amountIrr === 0 || note.trim() === ''}
              onClick={() => void adjust()}
            >
              اعمال
            </button>
          </div>
          {amountIrr !== 0 && (
            <div className={goesNegative ? 'alert alert-error' : 'alert alert-info'}>
              <span className="ltr">
                {irrToToman(customer.balanceIrr).toLocaleString('fa-IR')} →{' '}
                {irrToToman(projected).toLocaleString('fa-IR')}
              </span>{' '}
              تومان{goesNegative && ' — موجودی منفی می‌شود'}
            </div>
          )}

          <h4>حساب کاربری</h4>
          {customer.status === 'BLOCKED' ? (
            <div className="filters">
              <span className="muted">
                مسدود{customer.blockedReason ? `: ${customer.blockedReason}` : ''}
              </span>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void setStatus('ACTIVE')}
              >
                رفع مسدودی
              </button>
            </div>
          ) : (
            <div className="filters">
              <div className="grow">
                <label className="form-label" htmlFor="block-reason">
                  دلیل (اختیاری)
                </label>
                <input
                  id="block-reason"
                  className="form-control"
                  type="text"
                  maxLength={500}
                  value={blockReason}
                  onChange={(e) => setBlockReason(e.target.value)}
                />
              </div>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => void setStatus('BLOCKED')}
              >
                مسدود کردن
              </button>
            </div>
          )}

          <h4>دفتر کیف پول</h4>
          <div className="table-wrap">
            <table className="app-table">
              <thead>
                <tr>
                  <th>زمان</th>
                  <th>نوع</th>
                  <th>مبلغ</th>
                  <th>توسط</th>
                  <th>یادداشت</th>
                </tr>
              </thead>
              <tbody>
                {entries.length === 0 && (
                  <tr>
                    <td className="empty" colSpan={5}>
                      هنوز حرکتی ثبت نشده است.
                    </td>
                  </tr>
                )}
                {entries.map((e, i) => (
                  <tr key={`${e.createdAt}-${i}`}>
                    <td>{dateTime(e.createdAt)}</td>
                    <td>{KIND_FA[e.kind] ?? e.kind}</td>
                    <td className={e.amountIrr < 0 ? 'negative' : undefined}>
                      {e.amountIrr > 0 ? '+' : ''}
                      {toman(e.amountIrr)}
                    </td>
                    <td className="ltr">{e.actor ?? '—'}</td>
                    <td>{e.note ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Fact({
  label,
  value,
  ltr,
  negative,
}: {
  label: string;
  value: string;
  ltr?: boolean;
  negative?: boolean;
}) {
  return (
    <div className="stat-card tone-blue">
      <div>
        <div
          className={negative ? 'stat-card__value negative' : 'stat-card__value'}
          style={{ fontSize: 17 }}
        >
          <span className={ltr ? 'ltr' : undefined}>{value}</span>
        </div>
        <div className="stat-card__label">{label}</div>
      </div>
    </div>
  );
}
