/**
 * The panel's home: six numbers and the two most recent lists.
 *
 * The same shape the admin already reads on the PHP panel, so the move costs
 * them nothing. What is different is underneath: every figure comes from one
 * `/admin/overview` request whose SQL is in `adminOverviewRoutes.ts`, and each
 * card's label says what it counts. "درآمد کل" is completed orders, not paid
 * ones; "کیف پول مشتریان" is what the shop owes, not what it has.
 */

import { useEffect, useState } from 'react';
import { api, ApiError } from '../api.js';
import { Icon } from '../icons.js';
import { count, dateTime, toman, tomanCompact } from '../format.js';
import type { PageId } from '../nav.js';

type Overview = Awaited<ReturnType<typeof api.overview>>;

const ORDER_STATUS: Record<string, { label: string; cls: string }> = {
  DRAFT: { label: 'پیش‌نویس', cls: 'badge' },
  AWAITING_PAYMENT: { label: 'در انتظار پرداخت', cls: 'badge badge-warning' },
  PAID: { label: 'پرداخت‌شده', cls: 'badge badge-info' },
  PROVISIONING: { label: 'در حال تحویل', cls: 'badge badge-info' },
  COMPLETED: { label: 'تکمیل‌شده', cls: 'badge badge-active' },
  FAILED: { label: 'ناموفق', cls: 'badge badge-block' },
  CANCELLED: { label: 'لغو شده', cls: 'badge' },
  EXPIRED: { label: 'منقضی', cls: 'badge' },
};

export function DashboardPage({ onGo }: { onGo: (id: PageId) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .overview()
      .then((d) => alive && setData(d))
      .catch((e: unknown) => {
        if (!alive) return;
        setErr(
          e instanceof ApiError && e.code === 'admin_access_not_configured'
            ? 'این نصب هنوز درِ دسترسی ادمین را ندارد — ADMIN_ACCESS_AUD تنظیم نشده است.'
            : e instanceof Error
              ? e.message
              : String(e),
        );
      });
    return () => {
      alive = false;
    };
  }, []);

  if (err) return <div className="alert alert-error">{err}</div>;
  if (!data) return <p className="muted">در حال بارگذاری…</p>;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">داشبورد</div>
          <div className="page-head__sub">وضعیت فروشگاه در یک نگاه</div>
        </div>
      </div>

      <div className="stats-grid">
        <Stat
          tone="tone-blue"
          icon="users"
          value={count(data.customers)}
          label="کل کاربران"
          foot={`${count(data.customersToday)} نفر امروز`}
        />
        <Stat
          tone="tone-green"
          icon="money"
          value={tomanCompact(data.revenueIrr + data.revenueAdjustmentIrr)}
          label="درآمد کل"
          // The adjustment is named rather than absorbed, exactly as
          // `panel/index.php:72-75` names it. A figure that silently differs
          // from the sum of the orders is one an admin stops trusting the first
          // time they add it up themselves.
          foot={
            data.revenueAdjustmentIrr === 0
              ? 'فقط سفارش‌های تکمیل‌شده'
              : `سفارش‌های تکمیل‌شده ${data.revenueAdjustmentIrr < 0 ? '−' : '+'} ${tomanCompact(Math.abs(data.revenueAdjustmentIrr))} تعدیل دستی`
          }
        />
        <Stat
          tone="tone-orange"
          icon="package"
          value={count(data.activeSubscriptions)}
          label="سرویس فعال"
        />
        <Stat
          tone="tone-cyan"
          icon="receipt"
          value={count(data.ordersToday)}
          label="سفارش امروز"
          foot="به وقت تهران"
        />
        <Stat
          tone="tone-purple"
          icon="wallet"
          value={tomanCompact(data.walletHeldIrr)}
          label="کیف پول مشتریان"
          /* Credit balances only, and the debt named separately rather than
             netted in. `users.reseller_max_debt` is a ceiling a reseller is
             allowed to trade under, so a negative wallet is a designed state —
             and subtracting it from what the shop owes reported neither
             figure. On the sim's own fixture the plain sum showed ۱۵۳ هزار
             against a real liability of ۱٬۲۵۰ هزار, because one reseller was
             ۱٬۰۹۷ هزار under. */
          foot={
            data.walletDebtors === 0
              ? 'بدهی فروشگاه، نه موجودی آن'
              : `بدهی فروشگاه · ${tomanCompact(data.walletOwedToShopIrr)} طلب از ${count(data.walletDebtors)} نفر`
          }
        />
      </div>

      <div className="grid-2">
        <div className="card">
          <div className="card__head">
            <span className="card__title">آخرین سفارشات</span>
          </div>
          <div className="table-wrap">
            <table className="app-table">
              <thead>
                <tr>
                  <th>کاربر</th>
                  <th>محصول</th>
                  <th>مبلغ</th>
                  <th>وضعیت</th>
                  <th>تاریخ</th>
                </tr>
              </thead>
              <tbody>
                {data.recentOrders.length === 0 && (
                  <tr>
                    <td className="empty" colSpan={5}>
                      هنوز سفارشی ثبت نشده است.
                    </td>
                  </tr>
                )}
                {data.recentOrders.map((o) => {
                  const st = ORDER_STATUS[o.status] ?? { label: o.status, cls: 'badge' };
                  return (
                    <tr key={o.publicId}>
                      <td className="ltr">{o.telegramId ?? '—'}</td>
                      <td>{o.planName ?? '—'}</td>
                      <td>{toman(o.totalIrr)}</td>
                      <td>
                        <span className={st.cls}>{st.label}</span>
                      </td>
                      <td>{dateTime(o.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        <div className="card">
          <div className="card__head">
            <span className="card__title">آخرین کاربران</span>
            <button type="button" className="btn btn-sm" onClick={() => onGo('customers')}>
              همه
            </button>
          </div>
          <div className="table-wrap">
            <table className="app-table">
              <thead>
                <tr>
                  <th>آیدی</th>
                  <th>نام کاربری</th>
                  <th>موجودی</th>
                  <th>وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {data.recentCustomers.length === 0 && (
                  <tr>
                    <td className="empty" colSpan={4}>
                      هنوز کاربری ثبت نشده است.
                    </td>
                  </tr>
                )}
                {data.recentCustomers.map((u) => (
                  <tr key={u.id}>
                    <td className="ltr">{u.telegramId}</td>
                    <td className="ltr">{u.username ? `@${u.username}` : '—'}</td>
                    <td className={u.balanceIrr < 0 ? 'negative' : undefined}>
                      {toman(u.balanceIrr)}
                    </td>
                    <td>
                      <span
                        className={
                          u.status === 'BLOCKED' ? 'badge badge-block' : 'badge badge-active'
                        }
                      >
                        {u.status === 'BLOCKED' ? 'مسدود' : 'فعال'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </>
  );
}

function Stat({
  tone,
  icon,
  value,
  label,
  foot,
}: {
  tone: string;
  icon: string;
  value: string;
  label: string;
  foot?: string;
}) {
  return (
    <div className={`stat-card ${tone}`}>
      <div>
        <div className="stat-card__value">{value}</div>
        <div className="stat-card__label">{label}</div>
        {foot && (
          <div className="stat-card__label" style={{ fontSize: 11, opacity: 0.75 }}>
            {foot}
          </div>
        )}
      </div>
      <span className="stat-card__icon">
        <Icon name={icon} size={24} />
      </span>
    </div>
  );
}
