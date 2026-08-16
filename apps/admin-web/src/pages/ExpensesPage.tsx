/**
 * هزینه‌ها و تعدیل‌ها — what the shop spent, and the corrections to what it
 * earned.
 *
 * `revenue_adjustments` has been in the schema since migration 0005 and the
 * importer has been carrying it the whole time, and nothing has ever read a row
 * of it. Production has 136 entries over five weeks — 99 costs and 37 credits —
 * which would have arrived on cutover day and been invisible. This is the
 * screen behind them.
 *
 * ## One number, in one direction
 *
 * The form asks for a positive amount and which way it goes, and never for a
 * signed one. A minus sign typed into an amount field beside a «هزینه» option
 * is a credit nobody meant, and the shop's own reporting is what reads it.
 * `revenueRoutes.ts` applies the sign once, at the edge.
 *
 * ## Three totals, not one
 *
 * A net figure alone hides both halves: «۳۰۹ میلیون تومان کسری» could be a
 * quiet month or a big month with bigger costs, and the admin cannot tell which
 * from the number they are shown. Spent, credited and net, always over the
 * whole ledger and never over the page.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type RevenueAdjustmentRow, type RevenueTotals } from '../api.js';
import { count, dateTime, toman } from '../format.js';

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'admin_access_not_configured') return 'درِ دسترسی ادمین تنظیم نشده است.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

const PAGE_SIZE = 50;

const ZERO: RevenueTotals = { expensesIrr: 0, creditsIrr: 0, netIrr: 0 };

export function ExpensesPage() {
  const [rows, setRows] = useState<RevenueAdjustmentRow[]>([]);
  const [totals, setTotals] = useState<RevenueTotals>(ZERO);
  const [direction, setDirection] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function load() {
    setErr(null);
    try {
      const res = await api.revenueAdjustments({
        page,
        pageSize: PAGE_SIZE,
        ...(direction === '' ? {} : { direction }),
      });
      setRows(res.items);
      setTotals(res.totals);
      setTotal(res.total);
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load();
  }, [page, direction]);

  async function remove(row: RevenueAdjustmentRow) {
    // The amount is in the question on purpose. Every row on this screen looks
    // like every other one, and the note is the only thing that distinguishes
    // them — a bare «حذف شود؟» is a confirmation that confirms nothing.
    if (!window.confirm(`«${row.note}» به مبلغ ${toman(Math.abs(row.amountIrr))} حذف شود؟`)) return;
    setErr(null);
    setDone(null);
    try {
      await api.deleteRevenueAdjustment(row.id);
      setDone('حذف شد — و در تاریخچهٔ تغییرات ثبت ماند.');
      await load();
    } catch (e) {
      setErr(message(e));
    }
  }

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">هزینه‌ها و تعدیل‌ها</div>
          <div className="page-head__sub">{count(total)} ردیف</div>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setAdding(true)}>
          ثبت ردیف تازه
        </button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>مجموع هزینه‌ها</th>
                <th>مجموع بستانکاری‌ها</th>
                <th>خالص</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>{toman(Math.abs(totals.expensesIrr))}</td>
                <td>{toman(totals.creditsIrr)}</td>
                <td>
                  <span className={totals.netIrr < 0 ? 'badge badge-block' : 'badge badge-active'}>
                    {totals.netIrr < 0 ? '−' : '+'}
                    {toman(Math.abs(totals.netIrr))}
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="muted">
          این اعداد روی کل دفتر حساب می‌شوند، نه روی این صفحه — و هیچ‌جا ذخیره نمی‌شوند: هر بار از
          روی همین ردیف‌ها جمع می‌شوند، دقیقاً مثل موجودی کیف پول.
        </p>
      </div>

      <div className="card" style={{ marginBlockStart: 16 }}>
        {err && <div className="alert alert-error">{err}</div>}
        {done && <div className="alert alert-info">{done}</div>}

        <div className="filters">
          <div>
            <label className="form-label" htmlFor="adj-direction">
              نوع
            </label>
            <select
              id="adj-direction"
              className="form-control"
              value={direction}
              onChange={(e) => {
                setPage(1);
                setDirection(e.target.value);
              }}
            >
              <option value="">همه</option>
              <option value="expense">هزینه</option>
              <option value="credit">بستانکاری</option>
            </select>
          </div>
        </div>

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>تاریخ</th>
                <th>شرح</th>
                <th>مبلغ</th>
                <th>ثبت‌کننده</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td className="empty" colSpan={5}>
                    هنوز ردیفی ثبت نشده است.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{dateTime(r.createdAt)}</td>
                  <td>{r.note}</td>
                  <td>
                    <span className={r.amountIrr < 0 ? 'badge badge-block' : 'badge badge-active'}>
                      {r.amountIrr < 0 ? '−' : '+'}
                      {toman(Math.abs(r.amountIrr))}
                    </span>
                  </td>
                  <td className="ltr">{r.createdBy ?? '—'}</td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => void remove(r)}>
                      حذف
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {pages > 1 && (
          <div className="filters">
            <button
              type="button"
              className="btn btn-sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              قبلی
            </button>
            <span className="muted">
              صفحهٔ {count(page)} از {count(pages)}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
            >
              بعدی
            </button>
          </div>
        )}
      </div>

      {adding && (
        <AdjustmentForm
          onClose={() => setAdding(false)}
          onAdded={() => {
            setAdding(false);
            setDone('ردیف ثبت شد.');
            void load();
          }}
        />
      )}
    </>
  );
}

function AdjustmentForm({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'expense' | 'credit'>('expense');
  const [note, setNote] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Parsed once, here, so the preview below and the request are the same number.
  const amountToman = Number(amount);
  const valid = Number.isSafeInteger(amountToman) && amountToman > 0 && note.trim() !== '';

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.addRevenueAdjustment({ amountToman, direction, note: note.trim() });
      onAdded();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <span className="card__title">ثبت هزینه یا تعدیل</span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="adj-amount">
            مبلغ (تومان)
          </label>
          <input
            id="adj-amount"
            className="form-control ltr"
            type="number"
            min={1}
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
          {/* Always positive. Which way it goes is the field below, never a
              minus sign in here. */}
          <div className="page-head__sub">
            {valid
              ? `${direction === 'expense' ? 'کسر' : 'افزودن'} ${toman(amountToman * 10)}`
              : 'عدد مثبت، به تومان'}
          </div>
        </div>
        <div className="grow">
          <label className="form-label" htmlFor="adj-kind">
            نوع
          </label>
          <select
            id="adj-kind"
            className="form-control"
            value={direction}
            onChange={(e) => setDirection(e.target.value === 'credit' ? 'credit' : 'expense')}
          >
            <option value="expense">هزینه — از درآمد کم می‌شود</option>
            <option value="credit">بستانکاری — به درآمد اضافه می‌شود</option>
          </select>
        </div>
      </div>

      <label className="form-label" htmlFor="adj-note">
        شرح
      </label>
      <input
        id="adj-note"
        className="form-control"
        type="text"
        maxLength={500}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <div className="page-head__sub">
        الزامی است — یک ردیف بی‌شرح را بعداً هیچ‌کس نمی‌تواند بازسازی کند.
      </div>

      <div className="filters" style={{ marginBlockStart: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !valid}
          onClick={() => void save()}
        >
          ثبت
        </button>
      </div>
    </div>
  );
}
