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
} from '../api.js';
import { CopyButton } from '../CopyButton.js';
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

export function CustomersPage() {
  const [rows, setRows] = useState<CustomerListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [reseller, setReseller] = useState('');
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
                  <td className="ltr">{u.telegramId}</td>
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
                    {u.isReseller && (
                      // The LEVEL, not just «نماینده» — the two are priced
                      // differently and a row that does not say which is a row
                      // that cannot explain the price on the next screen.
                      <span className="badge badge-info">{u.tier?.name ?? 'نماینده'}</span>
                    )}
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
  const [payments, setPayments] = useState<CustomerPayments | null>(null);
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
  }

  useEffect(() => {
    // Cleared with the customer, not left standing. «@sara_m مسدود شد» still
    // on screen while the drawer now shows @reza_kh is a sentence about the
    // wrong person, which is worse than no sentence at all.
    setDone(null);
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
