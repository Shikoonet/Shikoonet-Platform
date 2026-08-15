/**
 * سفارشات · سرویس‌ها · تراکنش‌ها — three lists that only read.
 *
 * They share a file because they share a shape: search by customer, filter by
 * one column, page in SQL, show the customer beside every row. None of them has
 * an action, and that is the design rather than an omission — an order's status
 * belongs to the purchase flow, a subscription's to provisioning, and a wallet
 * entry is append-only in Postgres. The one correction an admin needs lives on
 * the customer's own page, where it inserts an entry instead of assigning a
 * total.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  api,
  ApiError,
  type EntryRow,
  type OrderRow,
  type SubscriptionRow,
  type CustomerRef,
} from '../api.js';
import { count, dateTime, toman } from '../format.js';

const PAGE_SIZE = 25;

const ORDER_STATUS_FA: Record<string, string> = {
  DRAFT: 'پیش‌نویس',
  AWAITING_PAYMENT: 'در انتظار پرداخت',
  PAID: 'پرداخت شده',
  PROVISIONING: 'در حال تحویل',
  COMPLETED: 'تکمیل شده',
  FAILED: 'ناموفق',
  CANCELLED: 'لغو شده',
  EXPIRED: 'منقضی',
};

const ORDER_KIND_FA: Record<string, string> = {
  NEW_PURCHASE: 'خرید جدید',
  RENEWAL: 'تمدید',
  ADD_VOLUME: 'حجم اضافه',
  ADD_TIME: 'زمان اضافه',
  WALLET_TOPUP: 'شارژ کیف پول',
  TRANSFER: 'انتقال',
};

const SUB_STATUS_FA: Record<string, string> = {
  ACTIVE: 'فعال',
  PENDING_PAYMENT: 'در انتظار پرداخت',
  ON_HOLD: 'در انتظار اتصال',
  DISABLED: 'غیرفعال',
  REMOVED: 'حذف شده',
  FAILED: 'ناموفق',
};

const ENTRY_KIND_FA: Record<string, string> = {
  OPENING: 'موجودی اولیه',
  TOPUP: 'شارژ کیف پول',
  PURCHASE: 'خرید',
  REFUND: 'بازگشت وجه',
  ADMIN_ADJUST: 'اصلاح توسط ادمین',
  GIFT_CODE: 'کد هدیه',
  REFERRAL_BONUS: 'پورسانت زیرمجموعه',
  RENEWAL_CASHBACK: 'هدیهٔ تمدید',
  WHEEL_PRIZE: 'جایزهٔ گردونه',
  TRANSFER_IN: 'انتقال ورودی',
  TRANSFER_OUT: 'انتقال خروجی',
};

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'admin_access_not_configured') return 'درِ دسترسی ادمین تنظیم نشده است.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

function who(c: CustomerRef): string {
  return c.username ? `@${c.username}` : String(c.telegramId);
}

/** Green for a good end state, red for a bad one, plain for in-flight. */
function tone(status: string): string {
  if (['COMPLETED', 'ACTIVE', 'PAID'].includes(status)) return 'badge badge-active';
  if (['FAILED', 'CANCELLED', 'EXPIRED', 'REMOVED', 'DISABLED'].includes(status)) {
    return 'badge badge-block';
  }
  return 'badge badge-info';
}

/**
 * The frame all three share: a search box, one filter, a table, a pager.
 *
 * Generic over the row so each page keeps its own columns; everything else —
 * loading, error, paging, the empty state — is written once.
 */
function ListPage<T extends { id: number }>({
  title,
  unit,
  filterLabel,
  filterOptions,
  head,
  row,
  fetchPage,
  summary,
  searchPlaceholder = 'آیدی عددی یا @نام‌کاربری',
}: {
  title: string;
  unit: string;
  filterLabel: string;
  filterOptions: Array<[string, string]>;
  head: ReactNode;
  row: (item: T) => ReactNode;
  fetchPage: (p: {
    q?: string;
    filter?: string;
    page: number;
    pageSize: number;
  }) => Promise<{ total: number; items: T[] }>;
  summary?: (extra: unknown) => ReactNode;
  searchPlaceholder?: string;
}) {
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [extra, setExtra] = useState<unknown>(null);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(toPage = page) {
    setLoading(true);
    setErr(null);
    try {
      const d = await fetchPage({
        page: toPage,
        pageSize: PAGE_SIZE,
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(filter ? { filter } : {}),
      });
      setRows(d.items);
      setTotal(d.total);
      setExtra(d);
    } catch (e) {
      setErr(message(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(page);
  }, [page, filter]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">{title}</div>
          <div className="page-head__sub">
            {count(total)} {unit}
          </div>
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
            <label className="form-label" htmlFor="ledger-q">
              جست‌وجوی کاربر
            </label>
            <input
              id="ledger-q"
              className="form-control ltr"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={searchPlaceholder}
            />
          </div>
          <div>
            <label className="form-label" htmlFor="ledger-filter">
              {filterLabel}
            </label>
            <select
              id="ledger-filter"
              className="form-control"
              value={filter}
              onChange={(e) => {
                setFilter(e.target.value);
                setPage(1);
              }}
            >
              <option value="">همه</option>
              {filterOptions.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            جست‌وجو
          </button>
        </form>

        {err && <div className="alert alert-error">{err}</div>}
        {summary && extra ? summary(extra) : null}

        <div className="table-wrap">
          <table className="app-table">
            <thead>{head}</thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td className="empty" colSpan={9}>
                    چیزی با این جست‌وجو پیدا نشد.
                  </td>
                </tr>
              )}
              {rows.map((r) => row(r))}
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
    </>
  );
}

export function OrdersPage() {
  return (
    <ListPage<OrderRow>
      title="سفارشات"
      unit="سفارش"
      filterLabel="وضعیت"
      filterOptions={Object.entries(ORDER_STATUS_FA)}
      fetchPage={(p) =>
        api.orders({
          page: p.page,
          pageSize: p.pageSize,
          ...(p.q ? { q: p.q } : {}),
          ...(p.filter ? { status: p.filter } : {}),
        })
      }
      head={
        <tr>
          <th>شناسه</th>
          <th>کاربر</th>
          <th>نوع</th>
          <th>پلن</th>
          <th>مبلغ</th>
          <th>تخفیف</th>
          <th>وضعیت</th>
          <th>زمان</th>
        </tr>
      }
      row={(o) => (
        <tr key={o.id}>
          <td className="ltr">{o.publicId.slice(0, 8)}</td>
          <td className="ltr">{who(o.customer)}</td>
          <td>{ORDER_KIND_FA[o.kind] ?? o.kind}</td>
          {/* NULL after the plan is retired — the order still happened. */}
          <td>{o.planName ?? '—'}</td>
          <td>{toman(o.totalIrr)}</td>
          <td>{o.discountIrr > 0 ? toman(o.discountIrr) : '—'}</td>
          <td>
            <span className={tone(o.status)}>{ORDER_STATUS_FA[o.status] ?? o.status}</span>
            {o.failureReason && <div className="page-head__sub">{o.failureReason}</div>}
          </td>
          <td>{dateTime(o.createdAt)}</td>
        </tr>
      )}
    />
  );
}

export function ServicesPage() {
  return (
    <ListPage<SubscriptionRow>
      title="سرویس‌ها"
      unit="سرویس"
      filterLabel="وضعیت"
      filterOptions={Object.entries(SUB_STATUS_FA)}
      fetchPage={(p) =>
        api.subscriptions({
          page: p.page,
          pageSize: p.pageSize,
          ...(p.q ? { q: p.q } : {}),
          ...(p.filter ? { status: p.filter } : {}),
        })
      }
      head={
        <tr>
          <th>کاربر</th>
          <th>پلن</th>
          <th>پنل</th>
          <th>نام روی پنل</th>
          <th>حجم</th>
          <th>خرید</th>
          <th>انقضا</th>
          <th>وضعیت</th>
        </tr>
      }
      row={(s) => (
        <tr key={s.id}>
          <td className="ltr">{who(s.customer)}</td>
          {/* The names as they were at sale — renaming a plan today must not
              rewrite what this customer bought. */}
          <td>{s.planName}</td>
          <td>{s.providerName ?? '—'}</td>
          <td className="ltr">{s.remoteUsername ?? '—'}</td>
          <td>{s.volumeGb === null ? 'نامحدود' : `${count(s.volumeGb)} گیگ`}</td>
          <td>{dateTime(s.purchasedAt)}</td>
          <td>{s.expiresAt === null ? 'بدون انقضا' : dateTime(s.expiresAt)}</td>
          <td>
            <span className={tone(s.status)}>{SUB_STATUS_FA[s.status] ?? s.status}</span>
          </td>
        </tr>
      )}
    />
  );
}

export function TransactionsPage() {
  return (
    <ListPage<EntryRow>
      title="تراکنش‌ها"
      unit="تراکنش"
      filterLabel="نوع"
      filterOptions={Object.entries(ENTRY_KIND_FA)}
      fetchPage={(p) =>
        api.walletEntries({
          page: p.page,
          pageSize: p.pageSize,
          ...(p.q ? { q: p.q } : {}),
          ...(p.filter ? { kind: p.filter } : {}),
        })
      }
      summary={(extra) => {
        const d = extra as { creditIrr: number; debitIrr: number };
        return (
          <div className="stats-grid">
            <div className="stat-card tone-blue">
              <div className="stat-card__label">مجموع واریز</div>
              <div>{toman(d.creditIrr)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card__label">مجموع برداشت</div>
              <div>{toman(d.debitIrr)}</div>
            </div>
            <div className="stat-card">
              <div className="stat-card__label">خالص</div>
              <div>{toman(d.creditIrr + d.debitIrr)}</div>
            </div>
          </div>
        );
      }}
      head={
        <tr>
          <th>کاربر</th>
          <th>مبلغ</th>
          <th>نوع</th>
          <th>عامل</th>
          <th>توضیح</th>
          <th>زمان</th>
        </tr>
      }
      row={(e) => (
        <tr key={e.id}>
          <td className="ltr">{who(e.customer)}</td>
          <td className={e.amountIrr < 0 ? 'negative' : undefined}>{toman(e.amountIrr)}</td>
          <td>{ENTRY_KIND_FA[e.kind] ?? e.kind}</td>
          <td className="ltr">{e.actor ?? '—'}</td>
          <td>{e.note ?? '—'}</td>
          <td>{dateTime(e.createdAt)}</td>
        </tr>
      )}
    />
  );
}
