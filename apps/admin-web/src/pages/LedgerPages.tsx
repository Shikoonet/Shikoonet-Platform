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
 *
 * Reading only is not the same as saying nothing wrong, and walking all three
 * on 2026-08-22 found three places where the screen said something the data
 * did not: an identifier printed in a column and refused by the search box, an
 * add-on order rendering «—» where its whole content should be, and totals
 * scoped to a filter under labels that claimed the shop. Each is noted where
 * it was fixed.
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
import { count, dateTime, gigabytes, toman } from '../format.js';

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

/**
 * What was bought, for an order whose product is not a plan.
 *
 * `ADD_VOLUME` and `ADD_TIME` are placed with `plan_id = NULL` — the customer
 * is not buying a plan, they are typing a number between one and a thousand
 * (`ADDON_MAX`) and buying that much of something they already have. So the
 * quantity is not a detail of the order, it IS the order, and until 2026-08-22
 * this column rendered «—» for it: «حجم اضافه · — · ۵۰٬۰۰۰ تومان» told an
 * admin nothing about what the customer received. The legacy dump has 37 of
 * these purchases, so it is a live flow and not a hypothetical one.
 */
function whatWasBought(o: OrderRow): string {
  if (o.kind === 'ADD_VOLUME') return `${count(o.quantity)} گیگ`;
  if (o.kind === 'ADD_TIME') return `${count(o.quantity)} روز`;
  // NULL after the plan is retired — the order still happened.
  return o.planName ?? '—';
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
  /**
   * Rendered above the table from the whole response, with the scope that
   * produced it. The scope is passed because a total is only readable next to
   * what it covers: these routes sum over everything the filter matches, which
   * is right, and a card that says «مجموع» beside a narrowed figure is not.
   */
  summary?: (extra: unknown, scope: { narrowed: boolean }) => ReactNode;
  searchPlaceholder?: string;
}) {
  const [rows, setRows] = useState<T[]>([]);
  const [total, setTotal] = useState(0);
  const [extra, setExtra] = useState<unknown>(null);
  /**
   * Whether the figures now on screen came from a narrowed request.
   *
   * Set from what was actually sent rather than from `q`, which changes with
   * every keystroke: a box being typed into has not narrowed anything yet, and
   * saying so while whole-ledger totals are still displayed would be the same
   * lie in the other direction.
   */
  const [narrowed, setNarrowed] = useState(false);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function load(toPage = page) {
    setLoading(true);
    setErr(null);
    const sentQ = q.trim();
    try {
      const d = await fetchPage({
        page: toPage,
        pageSize: PAGE_SIZE,
        ...(sentQ ? { q: sentQ } : {}),
        ...(filter ? { filter } : {}),
      });
      setRows(d.items);
      setTotal(d.total);
      setExtra(d);
      setNarrowed(sentQ !== '' || filter !== '');
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
        {summary && extra ? summary(extra, { narrowed }) : null}

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
      searchPlaceholder="آیدی عددی، @نام‌کاربری یا شمارهٔ سفارش"
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
          {/* Not «پلن»: an add-on row carries a quantity here, not a plan. */}
          <th>چه چیزی</th>
          <th>مبلغ</th>
          <th>تخفیف</th>
          <th>وضعیت</th>
          <th>زمان</th>
        </tr>
      }
      row={(o) => (
        <tr key={o.id}>
          {/* Whole, not `slice(0, 8)`. Every legacy invoice id is exactly eight
              characters — all 5,131 of them — so the truncation was invisible
              until our own bot started issuing ten (`randomBytes(5).hex`), and
              then it cut two off every new order. The customer is shown the
              full id by the bot, so an admin reading two characters less was
              comparing a different string to the one being quoted at them. */}
          <td className="ltr">{o.publicId}</td>
          <td className="ltr">{who(o.customer)}</td>
          <td>{ORDER_KIND_FA[o.kind] ?? o.kind}</td>
          <td>{whatWasBought(o)}</td>
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

export function SubscriptionsPage() {
  return (
    <ListPage<SubscriptionRow>
      title="سرویس‌ها"
      unit="سرویس"
      filterLabel="وضعیت"
      searchPlaceholder="آیدی عددی، @نام‌کاربری یا نام روی پنل"
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
          <th>مصرف</th>
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
          {/* The one column on this screen that comes from outside: the
              bot's sweep reads it off the panel every ten minutes and
              writes it here. It carries when, because a figure from a
              panel that has been unreachable since yesterday looks exactly
              like a customer who stopped using their service. */}
          <td title={s.lastSyncedAt === null ? undefined : `از پنل، ${dateTime(s.lastSyncedAt)}`}>
            {s.lastSyncedAt === null ? (
              <span className="muted">هنوز خوانده نشده</span>
            ) : (
              gigabytes(s.usedBytes)
            )}
          </td>
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
      summary={(extra, { narrowed }) => {
        const d = extra as { creditIrr: number; debitIrr: number };
        // The route sums over everything the filter matches rather than over
        // the page, and says so — a page total would read as the shop's figure
        // and be wrong by a factor of the page count. That leaves the labels
        // to carry the other half of the truth, and until 2026-08-22 they did
        // not: filtering to «خرید» produced a card reading «مجموع واریز ۰
        // تومان» while the shop had taken five million in, and «خالص» went
        // deep red for a shop that was up on the month. The number was right
        // and the word above it was a claim about the whole ledger.
        const of = (whole: string, part: string) => (narrowed ? part : whole);
        const net = d.creditIrr + d.debitIrr;
        return (
          <>
            <div className="stats-grid">
              <div className="stat-card tone-blue">
                <div className="stat-card__label">{of('مجموع واریز', 'واریزِ این جست‌وجو')}</div>
                <div>{toman(d.creditIrr)}</div>
              </div>
              <div className="stat-card">
                <div className="stat-card__label">{of('مجموع برداشت', 'برداشتِ این جست‌وجو')}</div>
                {/* The magnitude, because the word above already says which
                    direction it goes — «برداشت ‎−۵۲۵٬۰۰۰» is a double
                    negative, and هزینه‌ها writes the same figure the same way. */}
                <div>{toman(Math.abs(d.debitIrr))}</div>
              </div>
              <div className="stat-card">
                <div className="stat-card__label">{of('خالص', 'خالصِ این جست‌وجو')}</div>
                {/* Sign kept here, and only here: this is the one figure whose
                    direction is not already in its label. */}
                <div className={net < 0 ? 'negative' : undefined}>
                  {net < 0 ? '−' : ''}
                  {toman(Math.abs(net))}
                </div>
              </div>
            </div>
            {narrowed && (
              <p className="muted">
                این سه عدد فقط روی ردیف‌هایی حساب شده‌اند که این جست‌وجو برگردانده، نه روی کل دفتر.
              </p>
            )}
          </>
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
