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

import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type CustomerDetail,
  type CustomerListItem,
  type CustomerPayments,
  type WalletEntryRow,
  type CustomerHistoryRow,
  type OrderRow,
  type SubscriptionRow,
} from '../api.js';
import { CopyButton } from '../CopyButton.js';
import { CustomerLink } from '../CustomerLink.js';
import { pathForPage } from '../route.js';
import {
  ORDER_STATUS_FA,
  SUB_STATUS_FA,
  actorFa,
  count,
  dateTime,
  entryNoteFa,
  irrToToman,
  planDisplayName,
  statusTone,
  toman,
} from '../format.js';

/**
 * The audit action, in the panel's own language.
 *
 * Falls through to the raw key rather than to «نامشخص»: a new action added by a
 * later change should show up as something searchable, not as a word that hides
 * it. Every action on the customer reaches this, not just the two blocks —
 * narrowing the endpoint to blocks would have answered today's question and
 * hidden the wallet adjustment three rows above it.
 */
function actionLabel(action: string): string {
  const NAMES: Record<string, string> = {
    'customer.blocked': 'مسدود شد',
    'customer.unblocked': 'رفع مسدودی',
    'customer.wallet_adjusted': 'موجودی تغییر کرد',
    'customer.discount_changed': 'تخفیف تغییر کرد',
    'customer.reseller_changed': 'نمایندگی تغییر کرد',
  };
  return NAMES[action] ?? action;
}

const PAGE_SIZE = 25;

const KIND_FA: Record<string, string> = {
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
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'admin_access_not_configured') return 'درِ دسترسی ادمین تنظیم نشده است.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * The customer in the address bar.
 *
 * A card that lives only in `useState` cannot be linked to, cannot be opened
 * in a second tab, and swallows the Back button — which on a screen whose job
 * is «show me this person» is the whole feature. `?id=` rather than
 * `/customers/:id` because `route.ts` maps one path segment to one section and
 * teaching it a second segment would be a router; this is the same shape
 * «پرداخت‌ها» already uses for its sub-tab.
 */
/** Rows of each list on the customer's card. Enough to answer «چی خریده».*/
const DRAWER_PAGE = 10;

function idFromSearch(): number | null {
  const raw = new URLSearchParams(window.location.search).get('id');
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function qFromSearch(): string {
  return new URLSearchParams(window.location.search).get('q') ?? '';
}

export function CustomersPage() {
  const [rows, setRows] = useState<CustomerListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState(qFromSearch);
  const [status, setStatus] = useState('');
  const [reseller, setReseller] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<number | null>(idFromSearch);

  async function load(toPage = page) {
    setLoading(true);
    setErr(null);
    try {
      const d = await api.customers({
        page: toPage,
        pageSize: PAGE_SIZE,
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(status ? { status } : {}),
        ...(reseller ? { reseller: reseller as 'yes' | 'no' } : {}),
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
  }, [page, status, reseller]);

  /*
   * Back and Forward, and links arriving from another section.
   *
   * `CustomerLink` pushes `/customers?id=N` and dispatches `popstate`; the
   * browser's own Back does the same without the dispatch. Both land here, so
   * the card follows the address in every direction rather than only when a
   * button on this page was pressed.
   */
  useEffect(() => {
    const onPop = () => setOpenId(idFromSearch());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  /** Open the card and say so in the address bar, in that order. */
  function open(id: number) {
    setOpenId(id);
    const params = new URLSearchParams(window.location.search);
    params.set('id', String(id));
    // `pushState`, so Back closes the card. Closing it is what an operator
    // means by Back here — «کاربران» is still the screen they are on.
    window.history.pushState(null, '', `${pathForPage('customers')}?${params}`);
  }

  function close() {
    setOpenId(null);
    const params = new URLSearchParams(window.location.search);
    params.delete('id');
    const rest = params.toString();
    // `replaceState`: pressing «بستن» and then Back should not re-open it.
    window.history.replaceState(null, '', `${pathForPage('customers')}${rest ? `?${rest}` : ''}`);
  }

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">کاربران</h2>
          <div className="page-head__sub">{count(total)} کاربر</div>
        </div>
      </div>

      {/* Above the list, not under it.
          It used to render after the pager and rely on `scrollIntoView` to
          drag the operator down to it. That was written for the one way the
          card could be opened — pressing «مدیریت» on a row. A pasted
          `?id=` link now opens it on a cold load, and there the smooth scroll
          is a page that arrives showing a table and then moves on its own,
          past the thing that was actually asked for. Above the list it is
          simply where the eye already is. */}
      {openId !== null && (
        <CustomerDrawer id={openId} onClose={close} onChanged={() => void load()} />
      )}

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
          {/* «لیست نمایندگان» — a filter on the list that already searches and
              pages, rather than a screen of its own. */}
          <div>
            <label className="form-label" htmlFor="cust-reseller">
              نمایندگی
            </label>
            <select
              id="cust-reseller"
              className="form-control"
              value={reseller}
              onChange={(e) => {
                setReseller(e.target.value);
                setPage(1);
              }}
            >
              <option value="">همه</option>
              <option value="yes">فقط نماینده‌ها</option>
              <option value="no">بدون نمایندگی</option>
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
                  <td>
                    <CustomerLink customer={{ id: u.id, telegramId: u.telegramId }} />
                  </td>
                  <td className="ltr">{u.username ? `@${u.username}` : '—'}</td>
                  <td className="ltr">{u.phone ?? '—'}</td>
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
                    {/* On the row, because «فهرست بلاک‌شده‌ها» filtered to
                        مسدود was a page where every line said the same word
                        and finding out why any of them was blocked meant
                        opening them one at a time. */}
                    {u.status === 'BLOCKED' && u.blockedReason && (
                      <div className="page-head__sub" title={u.blockedReason}>
                        {u.blockedReason}
                      </div>
                    )}
                    {u.isReseller && (
                      // The LEVEL, not just «نماینده» — the two are priced
                      // differently and a row that does not say which is a row
                      // that cannot explain the price on the next screen.
                      <span className="badge badge-info">{u.tier?.name ?? 'نماینده'}</span>
                    )}
                  </td>
                  <td>{dateTime(u.registeredAt)}</td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => open(u.id)}>
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
  const [history, setHistory] = useState<CustomerHistoryRow[]>([]);
  const [payments, setPayments] = useState<CustomerPayments | null>(null);
  /**
   * What this customer bought, on this card.
   *
   * The two questions every support conversation starts with — «چی خریده»
   * and «سرویسش فعاله» — lived on two other sections, each needing the
   * telegram id pasted into a search box. Ten of each, newest first: enough
   * to answer the question, and «همهٔ N» goes to the full ledger for the
   * rest.
   */
  /*
   * `null` means «not read», and that is deliberately NOT the same as «empty».
   * It started as one state for both «still loading» and «the read failed»,
   * which put «خوانده نشد.» on screen for as long as the request was in
   * flight — a sentence saying the panel is broken, while it is working.
   */
  const [orders, setOrders] = useState<{ total: number; items: OrderRow[] } | null>(null);
  const [subs, setSubs] = useState<{ total: number; items: SubscriptionRow[] } | null>(null);
  const [listsLoading, setListsLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  /**
   * What the last action did, in a sentence.
   *
   * Three of the four writes in this card said nothing at all when they
   * succeeded — walking it on 2026-08-22, blocking a customer produced a 200,
   * a flipped badge and not one word. The wallet adjust is the exception and
   * the reason: it clears its own form, so the operator sees the result. The
   * others leave the screen looking exactly as it did a moment before, on the
   * one page where the thing being changed is a person.
   */
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [amountToman, setAmountToman] = useState('');
  const [note, setNote] = useState('');
  // Minted once per open drawer, so two clicks on «اعمال» send the same key
  // and the database collapses them onto one row.
  const [adjustKey, setAdjustKey] = useState(() => crypto.randomUUID());
  const [blockReason, setBlockReason] = useState('');
  const [discount, setDiscount] = useState('');
  const [tier, setTier] = useState<'' | 'n' | 'n2'>('');
  const [body, setBody] = useState('');
  const [messageId, setMessageId] = useState(() => crypto.randomUUID());

  async function load() {
    setErr(null);
    try {
      const d = await api.customer(id);
      setCustomer(d.customer);
      setEntries(d.entries);
      setPayments(d.payments);
      // The field starts at what the customer already has, so «ذخیره» without
      // typing is a no-op rather than a silent reset to zero.
      setDiscount(String(d.customer.discountPercent));
      // Their current level, so «ذخیره» without touching it is a no-op rather
      // than a silent demotion to level one.
      setTier(d.customer.tier?.code ?? (d.customer.isReseller ? 'n' : ''));
    } catch (e) {
      setErr(message(e));
    }

    /*
     * After everything else, and in a try of its own.
     *
     * The trail is ADMIN-only, so a REVIEWER opening this drawer gets a 403
     * here and must still get the drawer. It sat in the middle of the block
     * above for one commit and cost a test five seconds to find out why that is
     * wrong: `api.customerHistory` throwing SYNCHRONOUSLY — which is what an
     * older bundle or a stubbed api does — skipped `setPayments` and everything
     * under it, so an optional side-read took out the primary one. The `catch`
     * on the promise cannot catch a throw that happens before the promise
     * exists.
     */
    try {
      const h = await api.customerHistory(id);
      setHistory(h.items);
    } catch {
      setHistory([]);
    }

    /*
     * Each in its own try, for the reason the audit trail above has one: a
     * side-read that throws must not take the card down with it.
     *
     * And each guarded by the customer it was asked for. The drawer does not
     * remount when `id` changes — it is the same component with a new prop —
     * so pressing «مدیریت» on a second row while the first is still in flight
     * used to let the OLDER answer land last and paint one customer's orders
     * under another customer's name. Nothing would look wrong.
     */
    const asked = id;
    const stillCurrent = () => asked === currentId.current;

    try {
      const o = await api.orders({ customerId: id, page: 1, pageSize: DRAWER_PAGE });
      if (stillCurrent()) setOrders({ total: o.total, items: o.items });
    } catch {
      if (stillCurrent()) setOrders(null);
    }
    try {
      const sub = await api.subscriptions({ customerId: id, page: 1, pageSize: DRAWER_PAGE });
      if (stillCurrent()) setSubs({ total: sub.total, items: sub.items });
    } catch {
      if (stillCurrent()) setSubs(null);
    }
    if (stillCurrent()) setListsLoading(false);
  }

  /** The customer this card is currently about, readable from a stale closure. */
  const currentId = useRef(id);
  useEffect(() => {
    currentId.current = id;
    // Cleared with the customer, not left standing. «@sara_m مسدود شد» still
    // on screen while the drawer now shows @reza_kh is a sentence about the
    // wrong person, which is worse than no sentence at all.
    setDone(null);
    setOrders(null);
    setSubs(null);
    setListsLoading(true);
    void load();
  }, [id]);

  // Bring it into view, because it is a card in the page flow rather than an
  // overlay. Measured against a full customer list: «تخفیف دائمی» rendered at
  // y=1275 in a 950px viewport, so pressing «مدیریت» on a row near the top
  // scrolled nothing and looked like a dead button. The same mistake as the
  // bulk confirmation card, found the same way — by opening it in a browser
  // rather than reasoning about it.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // `block: 'nearest'` and nothing when it is already in view — the card
    // sits above the list now, so on a cold `?id=` load the browser is already
    // looking at it and scrolling would move the page away from it.
    root.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    setDone(null);
    try {
      const res = await api.adjustWallet(id, {
        amountIrr,
        note: note.trim(),
        idempotencyKey: adjustKey,
      });
      // `applied: false` means the key was already spent, which the route is
      // explicit is not an error. Reporting it as a success would tell an
      // operator money moved on a press where none did.
      setDone(
        res.applied
          ? `کیف پول اصلاح شد — موجودی حالا ${toman(res.balanceIrr)} است.`
          : 'این اصلاح قبلاً اعمال شده بود؛ چیزی دوباره جابه‌جا نشد.',
      );
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

  const discountPercent =
    /^[0-9]+$/.test(discount.trim()) && Number(discount) <= 100 ? Number(discount) : null;

  async function saveReseller() {
    if (customer === null) return;
    const wasTier = customer.tier?.code ?? (customer.isReseller ? 'n' : '');
    if (wasTier === tier) return;
    // Confirmed for the same reason the discount is: this changes what the
    // customer may SEE in the shop — `resellers_only` products and codes — as
    // well as what every future order costs them.
    const who = customer.username ? `@${customer.username}` : String(customer.telegramId);
    const ok = window.confirm(
      tier === ''
        ? `نمایندگی ${who} برداشته شود؟ قیمت‌های نمایندگی و محصولات مخصوص نماینده برایش بسته می‌شود.`
        : `${who} به «${tier === 'n2' ? 'نماینده سطح ۲' : 'نماینده'}» تغییر کند؟ ` +
            `تخفیف همان سطح از هر سفارش بعدی او کم می‌شود.`,
    );
    if (!ok) return;
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.setReseller(id, { isReseller: tier !== '', tier: tier === '' ? null : tier });
      setDone(tier === '' ? `نمایندگی ${who} برداشته شد.` : `سطح نمایندگی ${who} ذخیره شد.`);
      await load();
      onChanged();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function saveDiscount() {
    if (discountPercent === null || customer === null) return;
    const was = customer.discountPercent;
    if (was === discountPercent) return;
    // The old value beside the new one, because this number is not applied
    // once — `priceForUser` takes it off **every future order** this customer
    // places, and a 5 typed as 50 sells at half price until somebody notices.
    // The wallet adjust in this same card previews «from → to» for one
    // movement of money; a standing discount deserves it more, not less.
    if (
      !window.confirm(
        `تخفیف دائمی این کاربر از ${count(was)}٪ به ${count(discountPercent)}٪ برسد؟ ` +
          `از هر سفارش بعدی او کم می‌شود، نه فقط از سفارش بعدی.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const saved = await api.setDiscount(id, { percent: discountPercent });
      setDone(
        saved.tierName === null
          ? `تخفیف دائمی روی ${count(discountPercent)}٪ ذخیره شد.`
          : // Stored, and not what they pay. Saying «ذخیره شد» alone here would
            // be true and misleading in the same sentence.
            `ذخیره شد، ولی این کاربر در «${saved.tierName}» است و ${count(saved.effectivePercent)}٪ ` +
            `تخفیف همان سطح روی سفارش‌هایش اعمال می‌شود. این عدد وقتی به کار می‌آید که نمایندگی‌اش برداشته شود.`,
      );
      await load();
      onChanged();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function sendMessage() {
    if (body.trim() === '') return;
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.messageCustomer(id, { body: body.trim(), messageId });
      // No confirmation on the way in: the operator has just written the
      // message, and typing it is the deliberation. What was missing was the
      // other end — «queued, not sent» is the whole contract of this route and
      // the screen never said it had queued anything.
      setDone('پیام در صف رفت — ربات در چرخهٔ بعدی می‌فرستد.');
      setBody('');
      // A fresh id for the next message; the one just used stays spent, so a
      // stale tab cannot replay it.
      setMessageId(crypto.randomUUID());
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(next: 'ACTIVE' | 'BLOCKED') {
    const who = customer?.username ? `@${customer.username}` : `کاربر ${id}`;
    // Asked on the way in, not reported on the way out, and only for the
    // direction that costs something. Every other press on this panel that
    // takes something away asks first — retiring a config names the account,
    // deleting an expense names the amount and which way the ledger moves —
    // and cutting a paying customer off was the one that did not.
    //
    // The sentence says what the block actually does, including the part an
    // operator would otherwise get wrong: a customer blocked mid-purchase can
    // still send the receipt for a payment already waiting (`handle.ts` runs
    // `recordReceipt` before the gate), so blocking somebody who has just paid
    // does not strand their money.
    if (
      next === 'BLOCKED' &&
      !window.confirm(
        `${who} مسدود شود؟ دیگر نه منویی می‌بیند نه پیامی می‌گیرد. ` +
          `رسید پرداختی که همین حالا باز است هنوز می‌رسد، و رفع مسدودی همین‌جاست.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.setStatus(id, {
        status: next,
        reason: next === 'BLOCKED' ? blockReason.trim() || null : null,
      });
      setBlockReason('');
      setDone(
        next === 'BLOCKED'
          ? `${who} مسدود شد — و در تاریخچهٔ تغییرات ثبت ماند.`
          : `مسدودی ${who} برداشته شد.`,
      );
      await load();
      onChanged();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBlockStart: 16 }} ref={root}>
      <div className="card__head">
        <span className="card__title">
          {customer?.username ? `@${customer.username}` : 'کاربر'}{' '}
          <span className="muted ltr">{customer?.telegramId ?? id}</span>{' '}
          {/* The id is the one thing on this card that gets pasted somewhere
              else — into a support chat, a panel search, a note. Selecting it
              by hand out of a muted span next to a username is where a digit
              gets dropped, and a Telegram id with a digit missing is another
              real account. */}
          <CopyButton
            getText={() => String(customer?.telegramId ?? id)}
            label="کپی آیدی"
            title="آیدی تلگرام این کاربر را کپی می‌کند"
          />
        </span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-info">{done}</div>}
      {!customer && !err && <p className="muted">در حال بارگذاری…</p>}

      {customer && (
        <>
          <div className="stats-grid">
            <Fact
              label="موجودی کیف پول"
              value={toman(customer.balanceIrr)}
              negative={customer.balanceIrr < 0}
            />
            <Fact label="شماره موبایل" value={customer.phone ?? 'ثبت نشده'} ltr />
            <Fact
              label="سفارش‌ها"
              value={`${count(customer.orderCount)} · ${toman(customer.paidTotalIrr)}`}
            />
            {/* «این آی‌دی چند بار و به کدام کارت‌ها واریز داشته» — the question
                this drawer is opened with. Settled claims only, counted as
                «توازن کارت‌ها» counts them, so the two screens agree. */}
            <Fact
              label="واریز کارت‌به‌کارت"
              value={
                payments
                  ? `${count(payments.count)} · ${toman(payments.totalIrr)}`
                  : '—'
              }
            />
            {/* Through `count`, like every other number on this panel. A raw
                interpolation put «25٪» in Latin digits directly beside «۱ ·
                ۹۰۰٬۰۰۰ تومان» — two stats in one grid disagreeing about what a
                number looks like, which no test saw and opening the drawer
                did. */}
            {/* The EFFECTIVE number, because that is the one the shop charges.
                Showing the personal column here while the bot takes the level's
                is the «two screens, two answers» this panel keeps being rebuilt
                to avoid — so when a level is in force the fact says so. */}
            <Fact
              label="تخفیف مؤثر"
              value={
                customer.tier
                  ? `${count(customer.effectiveDiscountPercent)}٪ · ${customer.tier.name}`
                  : `${count(customer.effectiveDiscountPercent)}٪`
              }
            />
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
                {count(irrToToman(customer.balanceIrr))} → {count(irrToToman(projected))}
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

          <h4>تاریخچهٔ تغییرات</h4>
          {/*
            The screen that said «در تاریخچهٔ تغییرات ثبت ماند» after every
            block, and then had nowhere to show it. `audit_logs` had three
            readers in the worker and all three were about revenue.

            It matters most for the blocks nobody watched: the bot's flood guard
            calls the same helper, and until `setCustomerStatus` started writing
            the row itself those blocks left `blocked_reason` and nothing else —
            no actor, no time.
          */}
          {history.length === 0 ? (
            <p className="muted">چیزی ثبت نشده است.</p>
          ) : (
            <div className="table-wrap">
              <table className="app-table">
                <thead>
                  <tr>
                    <th>چه شد</th>
                    <th>چه کسی</th>
                    <th>چرا</th>
                    <th>کِی</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((h) => (
                    <tr key={h.id}>
                      <td>{actionLabel(h.action)}</td>
                      {/* «ربات» and not an empty cell: the flood guard is a real
                          actor, and a blank here reads as missing data. */}
                      <td className="ltr">{h.actor ?? (h.actorRole === 'SYSTEM' ? 'ربات' : '—')}</td>
                      <td>{h.reason ?? '—'}</td>
                      <td>{dateTime(new Date(h.createdAt).toISOString())}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h4>نمایندگی</h4>
          <p className="muted" style={{ marginBlockStart: 0 }}>
            سطح نمایندگی تعیین می‌کند چه تخفیفی روی هر سفارش این کاربر اعمال شود و قیمت حجم و زمان
            اضافه را از کدام ستون پنل بردارد. درصدِ هر سطح در «لیست درخواست‌ها» تنظیم می‌شود.
          </p>
          <div className="filters">
            <div>
              <label className="form-label" htmlFor="cust-tier">
                سطح
              </label>
              <select
                id="cust-tier"
                className="form-control"
                value={tier}
                onChange={(e) => setTier(e.target.value as '' | 'n' | 'n2')}
              >
                <option value="">نماینده نیست</option>
                <option value="n">نماینده</option>
                <option value="n2">نماینده سطح ۲</option>
              </select>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => void saveReseller()}
            >
              {/* Named, not «ذخیره». There are two save buttons in this card
                  now and they write different things — a screen reader hearing
                  «ذخیره» twice cannot tell which is which, and neither could
                  the browser walk. */}
              ذخیره نمایندگی
            </button>
          </div>

          {/* Both of these existed only in the bot's admin panel until
              `bot-subset.test.ts` said so out loud. The page showed the
              discount as a fact and offered no way to change it. */}
          <h4>تخفیف دائمی</h4>
          <p className="muted" style={{ marginBlockStart: 0 }}>
            از هر سفارش این کاربر کم می‌شود. صفر یعنی بدون تخفیف.
          </p>
          <div className="filters">
            <div>
              <label className="form-label" htmlFor="cust-discount">
                درصد
              </label>
              <input
                id="cust-discount"
                className="form-control ltr"
                type="number"
                min={0}
                max={100}
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || discountPercent === null}
              onClick={() => void saveDiscount()}
            >
              ذخیره تخفیف
            </button>
          </div>

          <h4>پیام به این کاربر</h4>
          <p className="muted" style={{ marginBlockStart: 0 }}>
            پیام در صف می‌رود و ربات آن را می‌فرستد — با سرخط فروشگاه، تا برای مشتری ناشناس نباشد.
            کاربر مسدود پیام نمی‌گیرد.
          </p>
          <div className="filters">
            <div className="grow">
              <label className="form-label" htmlFor="cust-message">
                متن
              </label>
              <textarea
                id="cust-message"
                className="form-control"
                rows={3}
                maxLength={4000}
                value={body}
                onChange={(e) => setBody(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || body.trim() === '' || customer.status === 'BLOCKED'}
              onClick={() => void sendMessage()}
            >
              فرستادن
            </button>
          </div>

          <h4>واریزها به تفکیک کارت</h4>
          <div className="table-wrap">
            <table className="app-table">
              <thead>
                <tr>
                  <th>کارت</th>
                  <th>تعداد</th>
                  <th>مبلغ</th>
                  <th>آخرین واریز</th>
                </tr>
              </thead>
              <tbody>
                {(payments?.byCard.length ?? 0) === 0 && (
                  <tr>
                    <td className="empty" colSpan={4}>
                      هیچ واریز تاییدشده‌ای از این مشتری ثبت نشده است.
                    </td>
                  </tr>
                )}
                {payments?.byCard.map((c) => (
                  <tr key={c.cardMasked ?? 'unknown'}>
                    <td className="ltr">{c.cardMasked ?? '—'}</td>
                    <td>{count(c.payments)}</td>
                    <td>{toman(c.amountIrr)}</td>
                    <td>{c.lastPaidAt ? dateTime(c.lastPaidAt) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4>
            سفارش‌ها{orders && orders.total > 0 ? ` (${count(orders.total)})` : ''}
            {orders && orders.total > DRAWER_PAGE && (
              <a
                className="page-head__sub"
                style={{ marginInlineStart: 10 }}
                /* `?customerId=`, not `?q=`. The search box is a FRAGMENT
                   match — it will also return an order whose public id
                   contains these digits, and another customer whose username
                   contains this one's. «همهٔ ۱۲ سفارش» must be twelve. */
                href={`${pathForPage('orders')}?customerId=${customer.id}`}
              >
                همهٔ {count(orders.total)} سفارش ←
              </a>
            )}
          </h4>
          <div className="table-wrap">
            <table className="app-table">
              <thead>
                <tr>
                  <th>زمان</th>
                  <th>چه چیزی</th>
                  <th>مبلغ</th>
                  <th>وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {(orders?.items.length ?? 0) === 0 && (
                  <tr>
                    <td className="empty" colSpan={4}>
                      {listsLoading
                        ? 'در حال بارگذاری…'
                        : orders === null
                          ? 'خوانده نشد.'
                          : 'هنوز سفارشی ثبت نکرده است.'}
                    </td>
                  </tr>
                )}
                {orders?.items.map((o) => (
                  <tr key={o.id}>
                    <td>{dateTime(o.createdAt)}</td>
                    <td>{planDisplayName(o.planName) ?? '—'}</td>
                    <td>{toman(o.totalIrr)}</td>
                    <td>
                      <span className={statusTone(o.status)}>
                        {ORDER_STATUS_FA[o.status] ?? o.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <h4>
            سرویس‌ها{subs && subs.total > 0 ? ` (${count(subs.total)})` : ''}
            {subs && subs.total > DRAWER_PAGE && (
              <a
                className="page-head__sub"
                style={{ marginInlineStart: 10 }}
                href={`${pathForPage('subscriptions')}?customerId=${customer.id}`}
              >
                همهٔ {count(subs.total)} سرویس ←
              </a>
            )}
          </h4>
          <div className="table-wrap">
            <table className="app-table">
              <thead>
                <tr>
                  <th>سرویس</th>
                  <th>پنل</th>
                  <th>انقضا</th>
                  <th>وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {(subs?.items.length ?? 0) === 0 && (
                  <tr>
                    <td className="empty" colSpan={4}>
                      {listsLoading
                        ? 'در حال بارگذاری…'
                        : subs === null
                          ? 'خوانده نشد.'
                          : 'سرویس فعالی ندارد.'}
                    </td>
                  </tr>
                )}
                {subs?.items.map((v) => (
                  <tr key={v.id}>
                    {/* The name it was SOLD under, unshortened: on this card
                        the price inside a legacy name is part of what the
                        customer agreed to, and there is no «مبلغ» column
                        beside it to contradict. */}
                    <td>{v.planName}</td>
                    <td>{v.providerName ?? '—'}</td>
                    <td>{v.expiresAt ? dateTime(v.expiresAt) : '—'}</td>
                    <td>
                      <span className={statusTone(v.status)}>
                        {SUB_STATUS_FA[v.status] ?? v.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

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
                    <td className="ltr">{actorFa(e.actor) ?? '—'}</td>
                    <td>{entryNoteFa(e.kind, e.note) ?? '—'}</td>
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
