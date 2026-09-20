/**
 * کدهای تخفیف — the codes, what is left of them, and who spent them.
 *
 * The state badge comes from the server. It is derived there from the same
 * three conditions the bot applies when a customer types the code, so this
 * screen renders a decision rather than making a second one that could disagree
 * with the answer the customer gets.
 *
 * «حذف» appears only on a code nobody has used. `discount_redemptions.code_id`
 * cascades, so deleting a used code erases the record of everyone who spent it
 * — including the rows that stop a customer using it twice — and the server
 * refuses that with a 409. For those, «باطل کردن» sets the expiry to now, which
 * is what the bot already treats as spent.
 *
 * Bulk delete (#383) is the same rule, many times: only unused codes get a
 * checkbox, one confirm covers the batch, and a code the server still refuses
 * is reported, not fatal — the rest of the batch goes through.
 *
 * Amounts are typed and shown in Toman; the API speaks integer Rial.
 */

import { useEffect, useState } from 'react';
import { CustomerLink } from '../CustomerLink.js';
import { BulkSelectionToolbar } from '../hub/historyRangeNav.js';
import { api, ApiError, type DiscountItem, type RedemptionRow, type ServiceRow } from '../api.js';
import { count, dateTime, endOfTehranDay, toman } from '../format.js';
import { useAdminWriteProps } from '../role.js';

const PAGE_SIZE = 25;

// Two families, and the label says which BEFORE it says how much: a «۲۰٪»
// that comes off the price and a «۲۰٪» that goes onto the volume looked the
// same in the list until Sam asked which was which (2026-09-12).
const KIND_FA: Record<string, string> = {
  GIFT_BALANCE: 'پول · شارژ کیف پول',
  PERCENT_OFF: 'پول · درصد از قیمت',
  AMOUNT_OFF: 'پول · مبلغ ثابت از قیمت',
  BONUS_GB: 'حجم · گیگ اضافه',
  BONUS_PERCENT: 'حجم · درصد اضافه',
};

/** One sentence under the kind picker: what the customer actually gets. */
const KIND_HINT: Record<string, string> = {
  PERCENT_OFF: 'قیمت پلن به همین درصد کم می‌شود؛ حجم همان است.',
  AMOUNT_OFF: 'این مبلغ از قیمت پلن کم می‌شود؛ حجم همان است.',
  GIFT_BALANCE: 'مشتری چیزی نمی‌خرد — این مبلغ به کیف پولش اضافه می‌شود.',
  BONUS_GB: 'قیمت عوض نمی‌شود؛ این‌قدر گیگ روی حجم پلن اضافه می‌شود (۱۰ گیگ + ۳۰ = ۴۰ گیگ).',
  BONUS_PERCENT: 'قیمت عوض نمی‌شود؛ حجم پلن به همین درصد بیشتر می‌شود (۱۰ گیگ + ۲۰٪ = ۱۲ گیگ).',
};

const STATE_FA: Record<string, string> = {
  USABLE: 'قابل استفاده',
  EXPIRED: 'منقضی',
  USED_UP: 'تمام شده',
  // Not «منقضی». An expired code is finished; a paused one is waiting for
  // somebody to turn it back on, and the two need different words or nobody
  // will think to look for the switch.
  DISABLED: 'غیرفعال',
};

const STATE_BADGE: Record<string, string> = {
  USABLE: 'badge badge-active',
  EXPIRED: 'badge badge-block',
  USED_UP: 'badge badge-info',
  DISABLED: 'badge badge-warning',
};

const APPLIES_FA: Record<string, string> = { ALL: 'همه', BUY: 'خرید', RENEW: 'تمدید' };

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'code_exists') {
      return `کدی با همین حروف از قبل هست${e.detail ? `: ${e.detail}` : ''} — ربات کدها را بدون حساسیت به بزرگی حروف می‌خواند.`;
    }
    if (e.code === 'unknown_product') return 'سرویس انتخاب‌شده وجود ندارد.';
    if (e.code === 'unknown_panel') return 'پنل انتخاب‌شده وجود ندارد.';
    if (e.code === 'admin_access_not_configured') return 'درِ دسترسی ادمین تنظیم نشده است.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

/** The value a code carries, in the unit that code uses. */
function value(d: DiscountItem): string {
  if (d.kind === 'PERCENT_OFF') return `${count(d.percent ?? 0)}٪`;
  // What a volume code GIVES, with a plus: it is not taken off anything.
  if (d.kind === 'BONUS_PERCENT') return `+${count(d.percent ?? 0)}٪ حجم`;
  if (d.kind === 'BONUS_GB') return `+${count(d.bonusGb ?? 0)} گیگ`;
  return toman(d.amountIrr);
}

export function DiscountsPage() {
  const w = useAdminWriteProps();
  const [rows, setRows] = useState<DiscountItem[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  async function load(toPage = page) {
    setLoading(true);
    setErr(null);
    try {
      const d = await api.discounts({
        page: toPage,
        pageSize: PAGE_SIZE,
        ...(q.trim() ? { q: q.trim() } : {}),
        ...(state ? { state } : {}),
      });
      setRows(d.items);
      setTotal(d.total);
      setSelected(new Set());
    } catch (e) {
      setErr(message(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(page);
  }, [page, state]);

  async function expire(d: DiscountItem) {
    if (
      !window.confirm(`کد «${d.code}» باطل شود؟ کسانی که استفاده کرده‌اند دست‌نخورده می‌مانند.`)
    ) {
      return;
    }
    try {
      await api.expireDiscount(d.id);
      await load();
    } catch (e) {
      setErr(message(e));
    }
  }

  async function remove(d: DiscountItem) {
    // Only offered for a code nobody spent — the server refuses the rest, since
    // the cascade would take the redemptions with it — so the confirm is about
    // the code itself, not about anyone's history.
    if (!window.confirm(`کد «${d.code}» حذف شود؟ هیچ‌کس استفاده‌اش نکرده و برنمی‌گردد.`)) return;
    try {
      await api.deleteDiscount(d.id);
      await load();
    } catch (e) {
      setErr(message(e));
    }
  }

  async function removeSelected() {
    const picked = rows.filter((r) => selected.has(String(r.id)));
    if (picked.length === 0) return;
    if (
      !window.confirm(
        `${count(picked.length)} کد حذف شود؟ هیچ‌کدام استفاده نشده‌اند و برنمی‌گردند.`,
      )
    ) {
      return;
    }
    // One at a time, so every delete gets its own audit row in order and a
    // refusal (409 for a code that gained a redemption since the list loaded)
    // skips that code instead of ending the batch.
    setLoading(true); // load() at the end lifts it; a second click meanwhile is a no-op
    const failed: string[] = [];
    for (const d of picked) {
      try {
        await api.deleteDiscount(d.id);
      } catch (e) {
        failed.push(`${d.code} (${message(e)})`);
      }
    }
    await load();
    if (failed.length > 0) {
      setErr(
        `${count(picked.length - failed.length)} کد حذف شد؛ ${count(failed.length)} کد حذف نشد: ${failed.join('، ')}`,
      );
    }
  }

  async function toggle(d: DiscountItem) {
    // No confirm. Pausing is the reversible one — it is the button somebody
    // reaches for BECAUSE they are unsure — and a dialog in front of it would
    // make it feel like «باطل کن», which is the one that cannot be taken back.
    try {
      await api.setDiscountStatus(d.id, d.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE');
      await load();
    } catch (e) {
      setErr(message(e));
    }
  }

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const open = rows.find((r) => r.id === openId) ?? null;
  // Only what the server would accept — see the file header.
  const deletableIds = rows.filter((r) => r.used === 0).map((r) => String(r.id));

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">کدهای تخفیف</h2>
          <div className="page-head__sub">{count(total)} کد</div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setCreating((v) => !v)}
          {...w}
        >
          {creating ? 'بستن فرم' : 'کد جدید'}
        </button>
      </div>

      {creating && (
        <CreateForm
          onDone={() => {
            setCreating(false);
            setPage(1);
            void load(1);
          }}
        />
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
            <label className="form-label" htmlFor="disc-q">
              جست‌وجو
            </label>
            <input
              id="disc-q"
              className="form-control ltr"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="بخشی از کد"
            />
          </div>
          <div>
            <label className="form-label" htmlFor="disc-state">
              وضعیت
            </label>
            <select
              id="disc-state"
              className="form-control"
              value={state}
              onChange={(e) => {
                setState(e.target.value);
                setPage(1);
              }}
            >
              <option value="">همه</option>
              <option value="USABLE">قابل استفاده</option>
              <option value="EXPIRED">منقضی</option>
              <option value="USED_UP">تمام شده</option>
            </select>
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            جست‌وجو
          </button>
        </form>

        {err && <div className="alert alert-error">{err}</div>}
        {state && (
          <p className="muted">
            وضعیت محاسبه‌شده است، نه ستون — این فیلتر روی همین صفحه اعمال می‌شود و شمارِ بالا کل
            کدهای مطابق جست‌وجوست.
          </p>
        )}

        {deletableIds.length > 0 && (
          <BulkSelectionToolbar
            itemIds={deletableIds}
            selectedIds={selected}
            onChangeSelected={setSelected}
            actions={
              selected.size > 0 ? (
                <button
                  type="button"
                  className="btn btn-sm btn-danger"
                  disabled={loading}
                  onClick={() => void removeSelected()}
                  {...w}
                >
                  حذف انتخاب‌شده‌ها ({count(selected.size)})
                </button>
              ) : (
                <span className="muted">فقط کدهایی که کسی استفاده نکرده انتخاب می‌شوند.</span>
              )
            }
          />
        )}

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th />
                <th>کد</th>
                <th>نوع</th>
                <th>مقدار</th>
                <th>مصرف</th>
                <th>کاربرد</th>
                <th>محدودیت</th>
                <th>انقضا</th>
                <th>وضعیت</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td className="empty" colSpan={10}>
                    کدی با این جست‌وجو پیدا نشد.
                  </td>
                </tr>
              )}
              {rows.map((d) => (
                <tr key={d.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`انتخاب ${d.code}`}
                      checked={selected.has(String(d.id))}
                      disabled={d.used > 0}
                      title={d.used > 0 ? 'استفاده شده — به‌جای حذف، باطل کن.' : undefined}
                      onChange={(e) => {
                        const next = new Set(selected);
                        if (e.target.checked) next.add(String(d.id));
                        else next.delete(String(d.id));
                        setSelected(next);
                      }}
                    />
                  </td>
                  <td className="ltr">{d.code}</td>
                  <td>{KIND_FA[d.kind] ?? d.kind}</td>
                  <td>{value(d)}</td>
                  <td>
                    {/* NULL maxUses is unlimited, not zero remaining. */}
                    {count(d.used)}
                    {d.maxUses === null ? ' از نامحدود' : ` از ${count(d.maxUses)}`}
                  </td>
                  <td>{APPLIES_FA[d.appliesTo] ?? d.appliesTo}</td>
                  <td>
                    {d.firstPurchaseOnly && <span className="badge badge-info">خرید اول</span>}
                    {d.resellersOnly && <span className="badge badge-info">نماینده</span>}
                    {d.usesPerUser > 1 && (
                      <span className="badge badge-info">
                        {count(d.usesPerUser)} بار برای هر نفر
                      </span>
                    )}
                    {d.targetUser && (
                      <span className="badge badge-info">
                        <CustomerLink
                          customer={{
                            id: d.targetUser.id,
                            telegramId: d.targetUser.telegramId ?? d.targetUser.id,
                            username: d.targetUser.username,
                          }}
                        />
                      </span>
                    )}
                    {d.products.map((p) => (
                      <span key={p.id} className="badge">
                        {p.name}
                      </span>
                    ))}
                    {d.provider && <span className="badge">{d.provider.name}</span>}
                    {!d.firstPurchaseOnly &&
                      !d.resellersOnly &&
                      d.usesPerUser === 1 &&
                      !d.targetUser &&
                      d.products.length === 0 &&
                      !d.provider &&
                      '—'}
                  </td>
                  <td>{d.expiresAt === null ? 'بدون انقضا' : dateTime(d.expiresAt)}</td>
                  <td>
                    <span className={STATE_BADGE[d.state] ?? 'badge'}>
                      {STATE_FA[d.state] ?? d.state}
                    </span>
                  </td>
                  <td>
                    <button type="button" className="btn btn-sm" onClick={() => setOpenId(d.id)}>
                      مصرف‌کننده‌ها
                    </button>{' '}
                    {d.state !== 'EXPIRED' && (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => void toggle(d)}
                          {...w}
                        >
                          {d.status === 'ACTIVE' ? 'خاموش کن' : 'روشن کن'}
                        </button>{' '}
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => void expire(d)}
                          {...w}
                        >
                          باطل کن
                        </button>
                      </>
                    )}
                    {d.used === 0 && (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => void remove(d)}
                          {...w}
                        >
                          حذف
                        </button>
                      </>
                    )}
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

      {open && <Redemptions code={open} onClose={() => setOpenId(null)} />}
    </>
  );
}

function CreateForm({ onDone }: { onDone: () => void }) {
  const w = useAdminWriteProps();
  const [code, setCode] = useState('');
  const [kind, setKind] = useState('PERCENT_OFF');
  const [amountToman, setAmountToman] = useState('');
  const [percent, setPercent] = useState('');
  const [bonusGb, setBonusGb] = useState('');
  const [maxUses, setMaxUses] = useState('');
  /**
   * How many times ONE customer may use it. Blank means the old behaviour.
   *
   * Left blank rather than pre-filled with «1», so a form nobody touches sends
   * nothing and the server's default decides. The alternative is a field that
   * looks like a choice somebody made when it is only the box's initial value.
   */
  const [usesPerUser, setUsesPerUser] = useState('');
  /** A telegram id, when the code is for one customer only. */
  const [targetTelegramId, setTargetTelegramId] = useState('');
  /**
   * When the code stops working, as a plain date.
   *
   * There was no field here until 2026-08-22, and the route has accepted
   * `expiresAt` the whole time — so every code made from this panel lived for
   * ever while all 33 in the production dump carry an expiry. An admin could
   * not reproduce what they already do.
   *
   * A date and not a datetime: nobody has ever wanted a code to stop at 14:37.
   * It is sent as the end of that day in Tehran, so a code «until 1 Shahrivar»
   * works all of 1 Shahrivar — the alternative reads as a day short.
   */
  const [expiresOn, setExpiresOn] = useState('');
  const [appliesTo, setAppliesTo] = useState('ALL');
  /**
   * Which services the code is for; none ticked is every service.
   *
   * Sam, 2026-09-20: «تمام سرویس‌ها رو بیاره، من تیک بزنم بگم این سرویس رو
   * می‌خوام … رو اینا فقط اعمال بشه، رو بقیه نه». The bot refuses the code on
   * any service not in the set (`discount_code_products`, 0086).
   */
  const [productIds, setProductIds] = useState<Set<number>>(new Set());
  // The same list «سرویس‌ها» shows, every page of it. Not loaded yet and
  // failed are kept apart from «no services»: a form that quietly showed no
  // checklist would let an admin make an all-services code by accident
  // (CodeRabbit on #395), so «ساخت» waits for the list.
  const [services, setServices] = useState<ServiceRow[] | 'loading' | 'failed'>('loading');
  const [servicesTry, setServicesTry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setServices('loading');
    (async () => {
      const all: ServiceRow[] = [];
      // 100 is the route's ceiling on pageSize.
      for (let page = 1; ; page++) {
        const d = await api.catalog({ page, pageSize: 100 });
        all.push(...d.items);
        if (d.items.length === 0 || all.length >= d.total) break;
      }
      return all;
    })().then(
      (all) => {
        if (!cancelled) setServices(all);
      },
      () => {
        if (!cancelled) setServices('failed');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [servicesTry]);
  const [firstPurchaseOnly, setFirst] = useState(false);
  const [resellersOnly, setResellers] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isGift = kind === 'GIFT_BALANCE';
  // Two kinds carry a percent — of the price, or of the plan's volume.
  const isPercent = kind === 'PERCENT_OFF' || kind === 'BONUS_PERCENT';
  const isBonusGb = kind === 'BONUS_GB';
  const servicesReady = isGift || Array.isArray(services);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      const typedAmount = Number(amountToman);
      await api.createDiscount({
        code: code.trim(),
        kind,
        // Toman in the form, Rial on the wire — the one conversion, in one line.
        ...(isPercent
          ? { percent: Number(percent) }
          : isBonusGb
            ? { bonusGb: Number(bonusGb) }
            : { amountIrr: Math.round(typedAmount) * 10 }),
        ...(maxUses.trim() ? { maxUses: Number(maxUses) } : {}),
        ...(usesPerUser.trim() ? { usesPerUser: Number(usesPerUser) } : {}),
        ...(targetTelegramId.trim() ? { targetTelegramId: Number(targetTelegramId) } : {}),
        ...(expiresOn ? { expiresAt: endOfTehranDay(expiresOn) } : {}),
        // A gift credits a wallet and is never applied to a purchase, so the
        // server refuses these on one; the form does not offer them either.
        ...(isGift
          ? {}
          : {
              appliesTo,
              firstPurchaseOnly,
              resellersOnly,
              productIds: [...productIds],
            }),
      });
      onDone();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <div className="card__head">
        <span className="card__title">کد جدید</span>
      </div>
      {err && <div className="alert alert-error">{err}</div>}

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="new-code">
            کد
          </label>
          <input
            id="new-code"
            className="form-control ltr"
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="OFF15"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="new-kind">
            نوع
          </label>
          <select
            id="new-kind"
            className="form-control"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <optgroup label="از قیمت کم می‌کند">
              <option value="PERCENT_OFF">درصد از قیمت</option>
              <option value="AMOUNT_OFF">مبلغ ثابت از قیمت</option>
              <option value="GIFT_BALANCE">شارژ کیف پول</option>
            </optgroup>
            <optgroup label="به حجم اضافه می‌کند — قیمت همان می‌ماند">
              <option value="BONUS_GB">گیگ اضافه</option>
              <option value="BONUS_PERCENT">درصد اضافه به حجم</option>
            </optgroup>
          </select>
          <p className="muted small" data-testid="kind-hint" style={{ margin: '.35rem 0 0' }}>{KIND_HINT[kind]}</p>
        </div>
        {isPercent ? (
          <div>
            <label className="form-label" htmlFor="new-percent">
              {kind === 'BONUS_PERCENT' ? 'درصدِ حجم پلن' : 'درصد'}
            </label>
            <input
              id="new-percent"
              className="form-control ltr"
              type="number"
              value={percent}
              onChange={(e) => setPercent(e.target.value)}
            />
          </div>
        ) : isBonusGb ? (
          <div>
            <label className="form-label" htmlFor="new-bonus-gb">
              حجم اضافه (گیگ)
            </label>
            <input
              id="new-bonus-gb"
              className="form-control ltr"
              type="number"
              step="0.001"
              value={bonusGb}
              onChange={(e) => setBonusGb(e.target.value)}
            />
          </div>
        ) : (
          <div>
            <label className="form-label" htmlFor="new-amount">
              مبلغ (تومان)
            </label>
            <input
              id="new-amount"
              className="form-control ltr"
              type="number"
              value={amountToman}
              onChange={(e) => setAmountToman(e.target.value)}
            />
          </div>
        )}
        <div>
          <label className="form-label" htmlFor="new-max">
            سقف مصرف
          </label>
          <input
            id="new-max"
            className="form-control ltr"
            type="number"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value)}
            placeholder="نامحدود"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="new-per-user">
            سقف هر نفر
          </label>
          <input
            id="new-per-user"
            className="form-control ltr"
            type="number"
            min={1}
            max={100}
            value={usesPerUser}
            onChange={(e) => setUsesPerUser(e.target.value)}
            placeholder="۱ بار"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="new-target">
            فقط برای این مشتری
          </label>
          <input
            id="new-target"
            className="form-control ltr"
            type="number"
            value={targetTelegramId}
            onChange={(e) => setTargetTelegramId(e.target.value)}
            placeholder="آیدی عددی تلگرام — خالی یعنی همه"
          />
        </div>
        <div>
          <label className="form-label" htmlFor="new-expires">
            انقضا
          </label>
          <input
            id="new-expires"
            className="form-control ltr"
            type="date"
            value={expiresOn}
            onChange={(e) => setExpiresOn(e.target.value)}
          />
        </div>
        {!isGift && (
          <div>
            <label className="form-label" htmlFor="new-applies">
              کاربرد
            </label>
            <select
              id="new-applies"
              className="form-control"
              value={appliesTo}
              onChange={(e) => setAppliesTo(e.target.value)}
            >
              <option value="ALL">خرید و تمدید</option>
              <option value="BUY">فقط خرید</option>
              <option value="RENEW">فقط تمدید</option>
            </select>
          </div>
        )}
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !servicesReady}
          onClick={() => void submit()}
          {...w}
        >
          ساخت
        </button>
      </div>

      {!isGift && (
        <div className="filters">
          <label className="form-label">
            <input
              type="checkbox"
              checked={firstPurchaseOnly}
              onChange={(e) => setFirst(e.target.checked)}
            />{' '}
            فقط خرید اول
          </label>
          <label className="form-label">
            <input
              type="checkbox"
              checked={resellersOnly}
              onChange={(e) => setResellers(e.target.checked)}
            />{' '}
            فقط نماینده‌ها
          </label>
        </div>
      )}

      {!isGift && (
        <fieldset className="filters" data-testid="service-scope">
          <legend className="form-label">
            فقط برای این سرویس‌ها — هیچ تیکی یعنی همهٔ سرویس‌ها
          </legend>
          {services === 'loading' && <span className="muted">در حال خواندن سرویس‌ها…</span>}
          {services === 'failed' && (
            <span className="alert alert-error">
              فهرست سرویس‌ها خوانده نشد؛ تا خوانده نشود کدی ساخته نمی‌شود.{' '}
              <button type="button" className="btn btn-sm" onClick={() => setServicesTry((n) => n + 1)}>
                دوباره
              </button>
            </span>
          )}
          {Array.isArray(services) && services.length === 0 && (
            <span className="muted">هنوز سرویسی ساخته نشده.</span>
          )}
          {Array.isArray(services) && services.map((s) => (
            <label key={s.id} className="form-label">
              <input
                type="checkbox"
                checked={productIds.has(s.id)}
                onChange={(e) =>
                  setProductIds((prev) => {
                    const next = new Set(prev);
                    if (e.target.checked) next.add(s.id);
                    else next.delete(s.id);
                    return next;
                  })
                }
              />{' '}
              {s.name}
            </label>
          ))}
        </fieldset>
      )}

      <p className="muted">
        {isGift
          ? 'کد هدیه کیف پول را شارژ می‌کند و روی خرید اعمال نمی‌شود، پس محدود کردنش به سرویس یا پنل معنا ندارد.'
          : 'کد بدون حساسیت به بزرگی حروف خوانده می‌شود؛ دو کد که فقط در حروف فرق دارند پذیرفته نمی‌شوند.'}
      </p>
    </div>
  );
}

function Redemptions({ code, onClose }: { code: DiscountItem; onClose: () => void }) {
  const [rows, setRows] = useState<RedemptionRow[]>([]);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setRows((await api.redemptions(code.id)).items);
      } catch (e) {
        setErr(message(e));
      }
    })();
  }, [code.id]);

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <span className="card__title">
          مصرف‌کننده‌های <span className="ltr">{code.code}</span>
        </span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>
      {err && <div className="alert alert-error">{err}</div>}
      <div className="table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              <th>کاربر</th>
              <th>مبلغ</th>
              <th>خریده</th>
              <th>دارد</th>
              <th>فعال</th>
              <th>زمان</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td className="empty" colSpan={6}>
                  هنوز کسی این کد را استفاده نکرده است.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {/* No `users.id` on a redemption row, so `?q=` — an exact
                      match on an all-digit telegram id, one query away rather
                      than a dead end. Adding the column to the route would be
                      the larger change for the same landing page. */}
                  <CustomerLink customer={{ telegramId: r.telegramId, username: r.username }} />
                </td>
                <td>{toman(r.amountIrr)}</td>
                <td>{count(r.services.bought)}</td>
                <td>{count(r.services.has)}</td>
                <td>{count(r.services.active)}</td>
                <td>{dateTime(r.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
