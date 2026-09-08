/**
 * «نمایندگان» — the franchises, what they bought, and what the meter says.
 *
 * ## What this screen deliberately does not have
 *
 * A list of anybody's customers. A reseller runs their own installation and
 * their customers never reach this database — Sam's own line was that we need
 * to know how much they used, not who used it. So there is no drill-down into
 * their shop, and `latestTotalUsers` is a COUNT shown as context, never a door.
 *
 * ## The one number that could be quietly wrong
 *
 * «مصرف کل» is `max(lifetime_used_bytes)` over the append-only ledger, not the
 * newest reading and not a sum. Two readings of the same hour must not double
 * an invoice, and a panel whose counter was reset must not make a bill shrink.
 * The API decides that; this file only has to keep them apart on screen, which
 * is why «این دوره» is drawn beside it rather than instead of it.
 *
 * And «هنوز خوانده نشده» is drawn for `null` rather than «۰ گیگ». On a screen
 * about money those are the same glyph and opposite facts.
 */

import { useEffect, useRef, useState } from 'react';
import { api, ApiError, type ResellerReading, type ResellerRow } from '../api.js';
import { count, dateOnly, dateTime, gigabytes } from '../format.js';
import { useAdminWriteProps } from '../role.js';

const STATUS_LABEL: Record<string, string> = {
  ACTIVE: 'فعال',
  SUSPENDED: 'معلق',
  CLOSED: 'بسته',
};

/**
 * What the meter says about capacity, as one sentence.
 *
 * Written here rather than as three columns because the operator's question is
 * "is this one about to run out", and three numbers they have to divide in
 * their head is how that gets missed.
 */
function capacityLine(row: ResellerRow): string {
  if (row.dataLimitBytes === null) return 'نامحدود';
  const used = row.billableBytes;
  // A cap of ZERO is a real state and not the same as no cap — the whole
  // reason the adapter refuses to collapse `null` into `0`. It is what the
  // panel reports for an admin who may use nothing at all, and dividing by it
  // would put «NaN٪» or «Infinity٪» on a screen about money. Said in words
  // instead.
  if (row.dataLimitBytes === 0) {
    return used === null || used === 0 ? 'سقف صفر' : `${gigabytes(used)} با سقف صفر`;
  }
  if (used === null) return `${gigabytes(row.dataLimitBytes)} خریده`;
  const pct = Math.round((used / row.dataLimitBytes) * 100);
  return `${gigabytes(used)} از ${gigabytes(row.dataLimitBytes)} (${count(pct)}٪)`;
}

export function ResellersPage() {
  const w = useAdminWriteProps();
  const [rows, setRows] = useState<ResellerRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [readings, setReadings] = useState<ResellerReading[]>([]);
  // What is selected RIGHT NOW, readable from inside a promise that started
  // earlier. `open` in a closure is the value it had when the request began.
  const idRef = useRef<number | null>(null);
  idRef.current = open;

  async function load() {
    try {
      const res = await api.resellers();
      setRows(res.items);
      setErr(null);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'فهرست نمایندگان خوانده نشد');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function showReadings(id: number) {
    if (open === id) {
      setOpen(null);
      return;
    }
    // Opened optimistically so a slow answer cannot land under the wrong row.
    // Open A, then B: if A's request finishes last, writing its rows without
    // this check would show A's ledger beneath B's name — a reseller looking
    // at somebody else's usage, which on this screen is the one mistake worth
    // ruling out.
    setOpen(id);
    setReadings([]);
    try {
      const res = await api.resellerReadings(id);
      setReadings((prev) => (idRef.current === id ? res.items : prev));
    } catch (e) {
      if (idRef.current === id) {
        setErr(e instanceof ApiError ? e.message : 'خوانش‌ها خوانده نشد');
      }
    }
  }

  async function setStatus(id: number, status: 'ACTIVE' | 'SUSPENDED') {
    setBusy(id);
    try {
      await api.setResellerStatus(id, status);
      await load();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'وضعیت عوض نشد');
    } finally {
      setBusy(null);
    }
  }

  const active = rows.filter((r) => r.status === 'ACTIVE').length;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-head__title">نمایندگان</div>
          {/* Both numbers, always — the same rule «محصولات» learned: a total on
              its own says nothing about whether anything is running.

              Inside the wrapper `div`, and in `page-head__sub` rather than
              `muted`: `.page-head` is `justify-content: space-between`, so a
              count that is a direct child is not a subtitle under the title —
              it is a second column, and it was drawn hard against the far edge
              of the screen with the title alone on the other side. */}
          <div className="page-head__sub">
            {count(rows.length)} نماینده · {count(active)} فعال
          </div>
        </div>
      </div>

      <p className="muted" style={{ maxWidth: '60ch' }}>
        هر نماینده یک نصب کامل و جدا دارد — ربات، دیتابیس و پنل مدیریتی خودش — و فقط به
        پنل‌های VPN ما وصل است. مشتری‌های او هیچ‌وقت وارد دیتابیس ما نمی‌شوند؛ آنچه
        این‌جا می‌بینید کنتور خودِ پنل است، نه چیزی که او گزارش کرده.
      </p>

      {err !== null && (
        <div className="alert alert--error" role="alert">
          {err}
        </div>
      )}

      {rows.length === 0 && err === null && (
        <div className="empty">
          هنوز نماینده‌ای ثبت نشده. نماینده یک ردیف در همین صفحه است که به یک اکانت ادمین
          روی یکی از پنل‌های ما وصل می‌شود؛ مصرفش از همان‌جا خوانده می‌شود.
        </div>
      )}

      {rows.length > 0 && (
        <table className="table">
          <thead>
            <tr>
              <th>نماینده</th>
              <th>پنل</th>
              <th>ظرفیت و مصرف کل</th>
              <th>این دوره</th>
              <th>کاربرها</th>
              <th>سررسید</th>
              <th>آخرین خوانش</th>
              <th>وضعیت</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  <div>{r.name}</div>
                  <div className="muted small">{r.panelAdminUsername}</div>
                </td>
                <td>{r.providerName}</td>
                <td>
                  {capacityLine(r)}
                  {/* The panel reached the cap by itself and, with
                      `disconnect_users_when_limited`, has already stopped that
                      franchise's customers. Worth its own badge: it is the one
                      state where nothing of ours acted and everything stopped. */}
                  {r.latestPanelIsLimited === true && (
                    <div className="badge badge--danger">به سقف رسیده</div>
                  )}
                </td>
                <td>{r.latestUsedBytes === null ? '—' : gigabytes(r.latestUsedBytes)}</td>
                <td>{r.latestTotalUsers === null ? '—' : count(r.latestTotalUsers)}</td>
                <td>{r.expiresAt === null ? 'بدون سررسید' : dateOnly(r.expiresAt)}</td>
                <td>
                  {/* «هنوز خوانده نشده» rather than a zero. See the header. */}
                  {r.lastReadAt === null ? (
                    <span className="muted">هنوز خوانده نشده</span>
                  ) : (
                    dateTime(r.lastReadAt)
                  )}
                </td>
                <td>{STATUS_LABEL[r.status] ?? r.status}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => void showReadings(r.id)}
                  >
                    {open === r.id ? 'بستن خوانش‌ها' : 'خوانش‌ها'}
                  </button>
                  {r.status !== 'CLOSED' && (
                    <button
                      type="button"
                      className="btn btn--ghost"
                      disabled={busy === r.id || w.disabled}
                      title={w.title}
                      onClick={() =>
                        void setStatus(r.id, r.status === 'ACTIVE' ? 'SUSPENDED' : 'ACTIVE')
                      }
                    >
                      {r.status === 'ACTIVE' ? 'تعلیق' : 'فعال‌سازی'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {open !== null && (
        <div className="card">
          <h2>خوانش‌های کنتور</h2>
          <p className="muted">
            دفتر فقط‌افزودنی است — هیچ خوانشی ویرایش یا حذف نمی‌شود. صورت‌حساب از بیشینهٔ
            «مصرف کل» ساخته می‌شود، نه از جمع این ردیف‌ها؛ برای همین خواندن دوبارهٔ کنتور
            چیزی را دو برابر نمی‌کند.
          </p>
          {readings.length === 0 ? (
            <div className="empty">هنوز خوانشی ثبت نشده.</div>
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th>زمان</th>
                  <th>این دوره</th>
                  <th>مصرف کل</th>
                  <th>سقف در آن لحظه</th>
                  <th>کاربرها</th>
                  <th>وضعیت پنل</th>
                </tr>
              </thead>
              <tbody>
                {readings.map((s) => (
                  <tr key={s.takenAt}>
                    <td>{dateTime(s.takenAt)}</td>
                    <td>{gigabytes(s.usedBytes)}</td>
                    <td>{gigabytes(s.lifetimeUsedBytes)}</td>
                    {/* The cap AS IT WAS when this was read. A cap raised
                        mid-period would otherwise make every earlier row look
                        wrong. */}
                    <td>{s.dataLimitBytes === null ? 'نامحدود' : gigabytes(s.dataLimitBytes)}</td>
                    <td>{count(s.totalUsers)}</td>
                    <td>{s.panelIsLimited === true ? 'به سقف رسیده' : (s.panelStatus ?? '—')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
