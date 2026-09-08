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

import { useState } from 'react';
import {
  api,
  ApiError,
  type EntryRow,
  type OrderRow,
  type SubscriptionRow,
  type LedgerQuery,
} from '../api.js';
import {
  ORDER_STATUS_FA,
  SUB_STATUS_FA,
  actorFa,
  count,
  dateTime,
  entryNoteFa,
  gigabytes,
  planDisplayName,
  statusTone,
  toman,
} from '../format.js';
import { CustomerLink } from '../CustomerLink.js';
import { ListPage, type FetchParams } from '../ListPage.js';
import { useWriteProps } from '../role.js';

const ORDER_KIND_FA: Record<string, string> = {
  NEW_PURCHASE: 'خرید جدید',
  RENEWAL: 'تمدید',
  ADD_VOLUME: 'حجم اضافه',
  ADD_TIME: 'زمان اضافه',
  WALLET_TOPUP: 'شارژ کیف پول',
  TRANSFER: 'انتقال',
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
  return planDisplayName(o.planName) ?? '—';
}

/** Green for a good end state, red for a bad one, plain for in-flight. */
/**
 * The screen's controls, as the three routes want them.
 *
 * One place, because the same object has to reach two callers that must not
 * disagree: the fetch that fills the table, and the href that downloads it.
 * The filter's NAME differs per ledger — `status` on two, `kind` on the third —
 * so it is a parameter rather than three copies of this function.
 */
function toQuery(
  p: Partial<FetchParams>,
  filterName: 'status' | 'kind',
): LedgerQuery & { page: number; pageSize: number } {
  return {
    page: p.page ?? 1,
    pageSize: p.pageSize ?? 25,
    ...(p.q ? { q: p.q } : {}),
    ...(p.filter ? { [filterName]: p.filter } : {}),
    ...(p.sort ? { sort: p.sort } : {}),
    ...(p.dir ? { dir: p.dir } : {}),
    ...(p.from ? { from: p.from } : {}),
    ...(p.to ? { to: p.to } : {}),
  };
}

export function OrdersPage() {
  return (
    <ListPage<OrderRow>
      page="orders"
      unit="سفارش"
      filterLabel="وضعیت"
      searchPlaceholder="آیدی عددی، @نام‌کاربری یا شمارهٔ سفارش"
      filterOptions={Object.entries(ORDER_STATUS_FA)}
      dateRange
      rowKey={(o) => o.id}
      csvUrl={(p) => api.ordersCsvUrl(toQuery(p, 'status'))}
      fetchPage={(p) => api.orders(toQuery(p, 'status'))}
      columns={[
        {
          key: 'publicId',
          label: 'شناسه',
          className: 'ltr',
          /* Whole, not `slice(0, 8)`. Every legacy invoice id is exactly eight
             characters — all 5,131 of them — so the truncation was invisible
             until our own bot started issuing ten (`randomBytes(5).hex`), and
             then it cut two off every new order. The customer is shown the
             full id by the bot, so an admin reading two characters less was
             comparing a different string to the one being quoted at them. */
          cell: (o) => o.publicId,
        },
        { key: 'customer', label: 'کاربر', cell: (o) => <CustomerLink customer={o.customer} /> },
        { key: 'kind', label: 'نوع', cell: (o) => ORDER_KIND_FA[o.kind] ?? o.kind },
        // Not «کانفیگ»: an add-on row carries a quantity here, not one.
        { key: 'what', label: 'چه چیزی', cell: (o) => whatWasBought(o) },
        { key: 'total', label: 'مبلغ', sort: 'total_irr', cell: (o) => toman(o.totalIrr) },
        {
          key: 'discount',
          label: 'تخفیف',
          cell: (o) => (o.discountIrr > 0 ? toman(o.discountIrr) : '—'),
        },
        {
          key: 'status',
          label: 'وضعیت',
          sort: 'status',
          cell: (o, reload) => (
            <>
              <span className={statusTone(o.status)}>{ORDER_STATUS_FA[o.status] ?? o.status}</span>
              {/* The reason the last attempt failed, as the panel already showed
                  it: a category and a panel name, never a stack trace and never a
                  credential. The order number in the first column is the same
                  reference the customer was given. */}
              {o.failureReason && <div className="page-head__sub">{o.failureReason}</div>}
              <RetryPreparation order={o} reload={reload} />
            </>
          ),
        },
        { key: 'created', label: 'زمان', sort: 'created_at', cell: (o) => dateTime(o.createdAt) },
      ]}
    />
  );
}

export function SubscriptionsPage() {
  return (
    <ListPage<SubscriptionRow>
      page="subscriptions"
      unit="سرویس"
      filterLabel="وضعیت"
      searchPlaceholder="آیدی عددی، @نام‌کاربری یا نام روی پنل"
      filterOptions={Object.entries(SUB_STATUS_FA)}
      dateRange
      rowKey={(s) => s.id}
      csvUrl={(p) => api.subscriptionsCsvUrl(toQuery(p, 'status'))}
      fetchPage={(p) => api.subscriptions(toQuery(p, 'status'))}
      columns={[
        { key: 'customer', label: 'کاربر', cell: (s) => <CustomerLink customer={s.customer} /> },
        {
          key: 'plan',
          label: 'کانفیگ',
          /* The name as it was at sale — renaming a config today must not
             rewrite what this customer bought. Not `planDisplayName` here,
             deliberately: this table has no «مبلغ» column, so the price inside
             the name is not a duplicate — it is the only thing distinguishing
             one tier from another on the row. */
          cell: (s) => s.planName,
        },
        { key: 'provider', label: 'پنل', cell: (s) => s.providerName ?? '—' },
        {
          key: 'remote',
          label: 'نام روی پنل',
          className: 'ltr',
          cell: (s) => s.remoteUsername ?? '—',
        },
        {
          key: 'volume',
          label: 'حجم',
          cell: (s) => (s.volumeGb === null ? 'نامحدود' : `${count(s.volumeGb)} گیگ`),
        },
        {
          key: 'used',
          label: 'مصرف',
          /* The one column here that comes from outside: the bot's sweep reads
             it off the panel every ten minutes. It carries WHEN, because a
             figure from a panel unreachable since yesterday looks exactly like
             a customer who stopped using their service. */
          cell: (s) =>
            s.lastSyncedAt === null ? (
              <span className="muted">هنوز خوانده نشده</span>
            ) : (
              <span title={`از پنل، ${dateTime(s.lastSyncedAt)}`}>{gigabytes(s.usedBytes)}</span>
            ),
        },
        {
          key: 'purchased',
          label: 'خرید',
          sort: 'purchased_at',
          cell: (s) => dateTime(s.purchasedAt),
        },
        {
          key: 'expires',
          label: 'انقضا',
          sort: 'expires_at',
          cell: (s) => (s.expiresAt === null ? 'بدون انقضا' : dateTime(s.expiresAt)),
        },
        {
          key: 'status',
          label: 'وضعیت',
          sort: 'status',
          cell: (s) => (
            <span className={statusTone(s.status)}>{SUB_STATUS_FA[s.status] ?? s.status}</span>
          ),
        },
      ]}
    />
  );
}

export function TransactionsPage() {
  return (
    <ListPage<EntryRow>
      page="transactions"
      unit="تراکنش"
      filterLabel="نوع"
      filterOptions={Object.entries(ENTRY_KIND_FA)}
      dateRange
      rowKey={(e) => e.id}
      csvUrl={(p) => api.walletEntriesCsvUrl(toQuery(p, 'kind'))}
      fetchPage={(p) => api.walletEntries(toQuery(p, 'kind'))}
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
      columns={[
        { key: 'customer', label: 'کاربر', cell: (e) => <CustomerLink customer={e.customer} /> },
        {
          key: 'amount',
          label: 'مبلغ',
          sort: 'amount_irr',
                cell: (e) => (
            <span className={e.amountIrr < 0 ? 'negative' : undefined}>{toman(e.amountIrr)}</span>
          ),
        },
        { key: 'kind', label: 'نوع', cell: (e) => ENTRY_KIND_FA[e.kind] ?? e.kind },
        { key: 'actor', label: 'عامل', className: 'ltr', cell: (e) => actorFa(e.actor) ?? '—' },
        { key: 'note', label: 'توضیح', cell: (e) => entryNoteFa(e.kind, e.note) ?? '—' },
        { key: 'created', label: 'زمان', sort: 'created_at', cell: (e) => dateTime(e.createdAt) },
      ]}
    />
  );
}

/**
 * «تلاش مجدد برای آماده‌سازی» — the operator's way out of a failed delivery.
 *
 * Shown only for FAILED_RETRYABLE, which is a failed preparation whose money is
 * still held. It never re-approves the payment: the button calls a route that
 * moves the order back into the provisioning queue and nothing else, so the
 * claim, the payment and the ledger are untouched by it.
 *
 * FAILED_TERMINAL gets a sentence instead of a button. The money went back to
 * the customer, so delivering now would be giving the service away, and a
 * disabled control with no explanation reads as a bug.
 *
 * Hidden entirely once the order is delivered — there is nothing to retry — and
 * disabled for READ_ONLY by `useWriteProps`, which also says why.
 */
function RetryPreparation({ order, reload }: { order: OrderRow; reload: () => void }) {
  const write = useWriteProps();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (order.deliveryState === 'FAILED_TERMINAL') {
    return <div className="page-head__sub">مبلغ برگشت خورده — آماده‌سازی دوباره ممکن نیست.</div>;
  }
  if (order.deliveryState !== 'FAILED_RETRYABLE') return null;

  async function run() {
    if (
      !window.confirm(
        `آماده‌سازی سفارش ${order.publicId} دوباره تلاش شود؟\n` +
          'پرداخت دوباره تایید نمی‌شود و مبلغی دوباره دریافت نمی‌گردد.',
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.retryProvisioning(order.publicId);
      reload();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button type="button" className="btn btn-sm" disabled={busy} onClick={run} {...write}>
        {busy ? '…' : 'تلاش مجدد برای آماده‌سازی'}
      </button>
      {err && <div className="page-head__sub">{err}</div>}
    </>
  );
}
