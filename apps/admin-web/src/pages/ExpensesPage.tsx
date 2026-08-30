/**
 * هزینه‌ها — the shop's own books, and the screen Sam could not find.
 *
 * It existed. It was «هزینه‌ها و تعدیل‌ها», tenth of eleven items in «منوی
 * اصلی», and it answered almost none of the questions it was opened for:
 * «هزینه‌ها چیه؟ ... می‌خوام ببینم هزینه‌ها چی بوده، کی بوده، فیلتر کنم».
 *
 * ## What it got wrong, measured rather than guessed
 *
 * On the 219 imported production rows, «مجموع هزینه‌ها» read 792 million Toman
 * — of which 35.8 million was fake receipts the shop never spent — and
 * «مجموع بستانکاری‌ها» was labelled as returns while being, entirely, reseller
 * income. The screen had a sign and no idea what a row meant, so those were
 * the only two columns it could draw.
 *
 * A row now says what it is (`kind`) and what it was for (`category_id`), and
 * the figures at the top are the three kinds plus their net.
 *
 * ## Two totals, deliberately
 *
 * «در این فیلتر» follows the filter, so narrowing to «تبلیغات» makes the
 * headline the advertising total — the whole point of filtering. «کل دفتر»
 * never moves. The previous version returned only the second, on the grounds
 * that a figure changing under a filter reads as money having gone somewhere.
 * That hazard is real, and it is answered by naming both rather than by
 * refusing one.
 *
 * ## Nothing is deleted
 *
 * A row is voided: it stays, greys out, and leaves every total. That is what
 * makes the edit history worth keeping, and it also fixes a bug — `verify.ts`
 * counts rows in this table against the legacy log, so one deletion made the
 * importer's own check red for ever with nothing on any screen saying why.
 */

import { useEffect, useMemo, useState } from 'react';
import { jalaliToIsoDate, toJalali, type JalaliDate } from '@shikoo/contracts';
import { DateField } from '../DateField.js';
import {
  api,
  ApiError,
  LEDGER_KIND_FA,
  type ExpenseCategory,
  type LedgerFilter,
  type LedgerHistoryEntry,
  type LedgerKind,
  type RevenueAdjustmentRow,
  type RevenueTotals,
} from '../api.js';
import { count, dateOnly, dateTime, toman } from '../format.js';

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'admin_access_not_configured') return 'درِ دسترسی ادمین تنظیم نشده است.';
    if (e.code === 'already_voided') return 'این ردیف قبلاً باطل شده است.';
    if (e.code === 'duplicate_name') return 'دسته‌ای با همین نام هست.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

const PAGE_SIZE = 50;
const ZERO: RevenueTotals = {
  expensesIrr: 0,
  revenueFixIrr: 0,
  manualIncomeIrr: 0,
  netIrr: 0,
};

const KINDS: LedgerKind[] = ['EXPENSE', 'REVENUE_FIX', 'MANUAL_INCOME'];

/**
 * Which fields the history can show, and what to call them.
 *
 * The route sends only the keys that changed, with the same key set on both
 * sides, so this map is the entire rendering logic: a new editable field costs
 * one line here and nothing else.
 */
const FIELD_FA: Record<string, string> = {
  amount_irr: 'مبلغ',
  note: 'شرح',
  kind: 'نوع',
  category_id: 'دسته',
  spent_on: 'تاریخ هزینه',
};

/**
 * Who wrote a row, in words.
 *
 * Every imported row carries the legacy admin's Telegram id in `created_by`,
 * so this column read «۷۱۳۷۴۹۴۵۱۳» 219 times over. A bare number is not an
 * answer to «کی بوده»; the id stays in the tooltip for anyone who needs it.
 */
function actorLabel(who: string | null): { text: string; title: string | undefined } {
  if (!who) return { text: '—', title: undefined };
  if (/^\d+$/.test(who)) return { text: 'ربات قدیمی', title: who };
  return { text: who, title: who };
}

export function ExpensesPage() {
  const [rows, setRows] = useState<RevenueAdjustmentRow[]>([]);
  const [totals, setTotals] = useState<RevenueTotals>(ZERO);
  const [lifetime, setLifetime] = useState<RevenueTotals>(ZERO);
  const [byCategory, setByCategory] = useState<
    { categoryId: number | null; name: string | null; count: number; irr: number }[]
  >([]);
  const [categories, setCategories] = useState<ExpenseCategory[]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  // Held as one object so the export link and the list can never be looking at
  // different things — the export's whole reason to exist is that it carries
  // the rows on screen.
  const [kind, setKind] = useState<LedgerKind | ''>('');
  const [categoryId, setCategoryId] = useState<number | ''>('');
  const [uncategorised, setUncategorised] = useState(false);
  const [q, setQ] = useState('');
  const [voided, setVoided] = useState<'hide' | 'show' | 'only'>('hide');
  const [dated, setDated] = useState(false);
  const [jFrom, setJFrom] = useState<JalaliDate>(() => toJalali(Date.now() - 30 * 86_400_000));
  const [jTo, setJTo] = useState<JalaliDate>(() => toJalali(Date.now()));

  const [editing, setEditing] = useState<RevenueAdjustmentRow | 'new' | null>(null);
  const [voidingRow, setVoidingRow] = useState<RevenueAdjustmentRow | null>(null);
  const [historyOf, setHistoryOf] = useState<number | null>(null);

  const from = jalaliToIsoDate(jFrom);
  const to = jalaliToIsoDate(jTo);
  const filter: LedgerFilter = useMemo(
    () => ({
      kind,
      categoryId,
      uncategorised,
      q,
      voided,
      ...(dated ? { from, to } : {}),
    }),
    [kind, categoryId, uncategorised, q, voided, dated, from, to],
  );

  async function load() {
    setErr(null);
    try {
      const res = await api.revenueAdjustments({ ...filter, page, pageSize: PAGE_SIZE });
      setRows(res.items);
      setTotals(res.totals);
      setLifetime(res.lifetime);
      setByCategory(res.byCategory);
      setTotal(res.total);
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load();
  }, [page, filter]);

  useEffect(() => {
    api
      .expenseCategories()
      .then((r) => setCategories(r.items))
      // A REVIEWER can read the ledger but not manage it; an empty list means
      // the form offers no category, not that the screen is broken.
      .catch(() => setCategories([]));
  }, []);

  // Any filter change starts at page one: staying on page 4 of a narrower
  // result set shows an empty table under a total that is not zero.
  useEffect(() => setPage(1), [filter]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const activeCategories = categories.filter((c) => c.active);

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">هزینه‌ها</div>
          <div className="page-head__sub">{count(total)} ردیف در این فیلتر</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* A navigation, not a fetch: the server already produced the bytes,
              and pulling the whole filtered ledger through JavaScript to build
              a blob would only be a second way to get the same file wrong. */}
          <a className="btn" href={api.revenueAdjustmentsCsvUrl(filter)} download="expenses.csv">
            خروجی CSV
          </a>
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            ثبت ردیف تازه
          </button>
        </div>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-info">{done}</div>}

      <Totals inFilter={totals} lifetime={lifetime} />

      {byCategory.length > 0 && (
        <Breakdown
          rows={byCategory}
          totalIrr={totals.expensesIrr}
          onPick={(id) => {
            setKind('EXPENSE');
            setUncategorised(id === null);
            setCategoryId(id ?? '');
          }}
        />
      )}

      <div className="card" style={{ marginBlockStart: 16 }}>
        <div className="filters">
          <div>
            <label className="form-label" htmlFor="adj-kind">
              نوع
            </label>
            <select
              id="adj-kind"
              className="form-control"
              value={kind}
              onChange={(e) => setKind(e.target.value as LedgerKind | '')}
            >
              <option value="">همه</option>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {LEDGER_KIND_FA[k]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="form-label" htmlFor="adj-cat">
              دسته
            </label>
            <select
              id="adj-cat"
              className="form-control"
              value={uncategorised ? 'none' : String(categoryId)}
              onChange={(e) => {
                setUncategorised(e.target.value === 'none');
                setCategoryId(
                  e.target.value === 'none' || e.target.value === '' ? '' : Number(e.target.value),
                );
              }}
            >
              <option value="">همه</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.active ? '' : ' (غیرفعال)'}
                </option>
              ))}
              {/* The backlog the classifier could not label. Its own entry
                  rather than folded into «سایر», because «I have not looked at
                  this yet» and «I looked, and it is other» are different. */}
              <option value="none">— دسته‌بندی‌نشده —</option>
            </select>
          </div>

          <div>
            <label className="form-label" htmlFor="adj-q">
              جست‌وجو در شرح
            </label>
            <input
              id="adj-q"
              className="form-control"
              value={q}
              placeholder="مثلاً نیتروژن"
              onChange={(e) => setQ(e.target.value)}
            />
          </div>

          <div>
            <label className="form-label" htmlFor="adj-voided">
              باطل‌شده‌ها
            </label>
            <select
              id="adj-voided"
              className="form-control"
              value={voided}
              onChange={(e) => setVoided(e.target.value as 'hide' | 'show' | 'only')}
            >
              <option value="hide">پنهان</option>
              <option value="show">نمایش بده</option>
              <option value="only">فقط باطل‌شده‌ها</option>
            </select>
          </div>

          <div>
            <span className="form-label">بازهٔ تاریخ هزینه</span>
            <label>
              <input type="checkbox" checked={dated} onChange={(e) => setDated(e.target.checked)} />{' '}
              محدود کن
            </label>
          </div>
        </div>

        {dated && (
          <div className="statsbar__dates" style={{ marginBlockEnd: 12 }}>
            <DateField label="از" value={jFrom} onChange={setJFrom} />
            <DateField label="تا" value={jTo} onChange={setJTo} />
          </div>
        )}

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>تاریخ هزینه</th>
                <th>نوع</th>
                <th>دسته</th>
                <th>شرح</th>
                <th>مبلغ</th>
                <th>ثبت‌کننده</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td className="empty" colSpan={7}>
                    ردیفی با این فیلتر نیست.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <Row
                  key={r.id}
                  row={r}
                  expanded={historyOf === r.id}
                  onToggleHistory={() => setHistoryOf(historyOf === r.id ? null : r.id)}
                  onEdit={() => setEditing(r)}
                  onVoid={() => setVoidingRow(r)}
                />
              ))}
            </tbody>
          </table>
        </div>

        {pages > 1 && (
          <div className="pager">
            <button
              type="button"
              className="btn"
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
              className="btn"
              disabled={page >= pages}
              onClick={() => setPage(page + 1)}
            >
              بعدی
            </button>
          </div>
        )}
      </div>

      {editing && (
        <EntryForm
          row={editing === 'new' ? null : editing}
          categories={activeCategories}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => {
            setEditing(null);
            setDone(msg);
            await load();
          }}
          onError={setErr}
        />
      )}

      {voidingRow && (
        <VoidForm
          row={voidingRow}
          onClose={() => setVoidingRow(null)}
          onDone={async (msg) => {
            setVoidingRow(null);
            setDone(msg);
            await load();
          }}
          onError={setErr}
        />
      )}
    </>
  );
}

/**
 * The four figures, twice.
 *
 * «در این فیلتر» is the arithmetic of the rows below it, so an admin can check
 * the screen against itself. «کل دفتر» is the shop's position and does not move
 * when you look at it through a filter. The two are labelled apart because one
 * figure that sometimes means one and sometimes the other is the
 * misunderstanding this page exists to end.
 */
function Totals({ inFilter, lifetime }: { inFilter: RevenueTotals; lifetime: RevenueTotals }) {
  const line = (label: string, t: RevenueTotals) => (
    <tr>
      <td>{label}</td>
      <td>{toman(t.expensesIrr)}</td>
      <td>{toman(t.revenueFixIrr)}</td>
      <td>{toman(t.manualIncomeIrr)}</td>
      <td>
        <span className={t.netIrr < 0 ? 'badge badge-block' : 'badge badge-active'}>
          {toman(t.netIrr)}
        </span>
      </td>
    </tr>
  );

  return (
    <div className="card">
      <div className="table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              <th />
              <th>هزینه</th>
              <th>اصلاح درآمد</th>
              <th>درآمد دستی</th>
              <th>خالص</th>
            </tr>
          </thead>
          <tbody>
            {line('در این فیلتر', inFilter)}
            {line('کل دفتر', lifetime)}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>
        هیچ‌کدام ذخیره نمی‌شوند: هر بار از روی همین ردیف‌ها جمع می‌شوند، دقیقاً مثل
        موجودی کیف پول. ردیف‌های باطل‌شده در هیچ‌کدام نیستند.
      </p>
    </div>
  );
}

/** «تفکیک» — what the spending went on. Clicking a line filters to it. */
function Breakdown({
  rows,
  totalIrr,
  onPick,
}: {
  rows: { categoryId: number | null; name: string | null; count: number; irr: number }[];
  totalIrr: number;
  onPick: (id: number | null) => void;
}) {
  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <div>
          <div className="card__title">تفکیک هزینه‌ها</div>
          <div className="page-head__sub">
            فقط هزینه‌ها، در همین فیلتر — جمعشان همان «هزینه» بالاست
          </div>
        </div>
      </div>
      <div className="table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              <th>دسته</th>
              <th>تعداد</th>
              <th>مبلغ</th>
              <th>سهم</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((b) => (
              <tr
                key={b.categoryId ?? 'none'}
                style={{ cursor: 'pointer' }}
                onClick={() => onPick(b.categoryId)}
              >
                <td>{b.name ?? '— دسته‌بندی‌نشده —'}</td>
                <td>{count(b.count)}</td>
                <td>{toman(b.irr)}</td>
                <td>
                  {totalIrr === 0
                    ? '—'
                    : `${((b.irr / totalIrr) * 100).toLocaleString('fa-IR', {
                        maximumFractionDigits: 1,
                      })}٪`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Row({
  row,
  expanded,
  onToggleHistory,
  onEdit,
  onVoid,
}: {
  row: RevenueAdjustmentRow;
  expanded: boolean;
  onToggleHistory: () => void;
  onEdit: () => void;
  onVoid: () => void;
}) {
  const gone = row.voidedAt !== null;
  const actor = actorLabel(row.createdBy);
  const struck = gone ? { textDecoration: 'line-through' as const } : undefined;
  // Noon UTC, so a date-only string cannot land on the previous day in Tehran
  // the way midnight would. Every other date on this panel is Jalali and this
  // one rendered «2026-08-28» until it went through the same formatter.
  const spent = dateOnly(`${row.spentOn}T12:00:00Z`);

  return (
    <>
      <tr style={gone ? { opacity: 0.55 } : undefined}>
        <td style={struck}>{spent}</td>
        <td>{LEDGER_KIND_FA[row.kind]}</td>
        <td>{row.kind === 'EXPENSE' ? (row.categoryName ?? '—') : '—'}</td>
        <td style={struck}>
          {row.note}
          {gone && (
            <div className="muted" style={{ fontSize: 11 }}>
              باطل — {row.voidReason}
            </div>
          )}
          {row.editCount > 0 && (
            <div className="muted" style={{ fontSize: 11 }}>
              {count(row.editCount)} بار ویرایش شده
              {row.lastEditedBy ? ` · ${actorLabel(row.lastEditedBy).text}` : ''}
            </div>
          )}
        </td>
        <td>
          <span className={row.amountIrr < 0 ? 'badge badge-block' : 'badge badge-active'}>
            {toman(row.amountIrr)}
          </span>
        </td>
        <td title={actor.title}>{actor.text}</td>
        <td>
          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button type="button" className="btn" onClick={onToggleHistory}>
              تاریخچه
            </button>
            {!gone && (
              <>
                <button type="button" className="btn" onClick={onEdit}>
                  ویرایش
                </button>
                <button type="button" className="btn" onClick={onVoid}>
                  ابطال
                </button>
              </>
            )}
          </div>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7}>
            <History id={row.id} />
          </td>
        </tr>
      )}
    </>
  );
}

/**
 * What was done to one row, out of the append-only audit log.
 *
 * Rendered by zipping the `before`/`after` keys — the route sends only what
 * changed, with matching key sets on both sides, so this needs no per-field
 * code and a new editable column costs one entry in `FIELD_FA`.
 */
function History({ id }: { id: number }) {
  const [items, setItems] = useState<LedgerHistoryEntry[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api
      .revenueAdjustmentHistory(id)
      .then((r) => setItems(r.items))
      .catch((e) => setErr(message(e)));
  }, [id]);

  if (err) return <div className="alert alert-error">{err}</div>;
  if (!items) return <p className="muted">در حال بارگذاری…</p>;

  const value = (field: string, v: unknown) =>
    field === 'amount_irr' ? toman(Number(v)) : v === null || v === undefined ? '—' : String(v);

  const what = (h: LedgerHistoryEntry) => {
    if (h.action === 'revenue_adjustment.added') return 'ثبت شد';
    if (h.action === 'revenue_adjustment.voided') return `باطل شد — ${h.reason ?? ''}`;
    const changes = Object.keys(h.after ?? {}).map(
      (k) => `${FIELD_FA[k] ?? k}: ${value(k, h.before?.[k])} ← ${value(k, h.after?.[k])}`,
    );
    return `${changes.join(' · ')}${h.reason ? ` (${h.reason})` : ''}`;
  };

  return (
    <ul className="muted" style={{ margin: 0, paddingInlineStart: 18, lineHeight: 2 }}>
      {items.map((h, i) => (
        <li key={i}>
          <strong>{dateTime(h.at)}</strong> · {actorLabel(h.actor).text} · {what(h)}
        </li>
      ))}
    </ul>
  );
}

/**
 * The one form, for a new row and for an edit.
 *
 * «نوع» is three radios rather than a select because it is the field that
 * decides the sign, and a select showing one of three options hides the choice
 * that matters most on a screen about money.
 */
function EntryForm({
  row,
  categories,
  onClose,
  onSaved,
  onError,
}: {
  row: RevenueAdjustmentRow | null;
  categories: ExpenseCategory[];
  onClose: () => void;
  onSaved: (msg: string) => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [kind, setKind] = useState<LedgerKind>(row?.kind ?? 'EXPENSE');
  const [amount, setAmount] = useState(row ? String(Math.abs(row.amountIrr) / 10) : '');
  const [direction, setDirection] = useState<'expense' | 'credit'>(
    row && row.amountIrr > 0 ? 'credit' : 'expense',
  );
  const [categoryId, setCategoryId] = useState<number | ''>(row?.categoryId ?? '');
  const [note, setNote] = useState(row?.note ?? '');
  const [reason, setReason] = useState('');
  // Noon UTC, so parsing a date-only string cannot land on the previous day in
  // Tehran the way midnight would.
  const [jDate, setJDate] = useState<JalaliDate>(() =>
    toJalali(row ? Date.parse(`${row.spentOn}T12:00:00Z`) : Date.now()),
  );
  const [busy, setBusy] = useState(false);

  const amountToman = Number(amount.replace(/[^\d]/g, ''));
  const previewIrr =
    kind === 'EXPENSE' || (kind === 'REVENUE_FIX' && direction === 'expense')
      ? -amountToman * 10
      : amountToman * 10;

  async function submit() {
    if (!Number.isInteger(amountToman) || amountToman <= 0) {
      onError('مبلغ درست نیست.');
      return;
    }
    if (!note.trim()) {
      onError('شرح لازم است.');
      return;
    }
    setBusy(true);
    try {
      const body = {
        amountToman,
        kind,
        direction,
        categoryId: kind === 'EXPENSE' ? (categoryId === '' ? null : categoryId) : null,
        spentOn: jalaliToIsoDate(jDate),
        note: note.trim(),
      };
      if (row) {
        const res = await api.editRevenueAdjustment(row.id, {
          ...body,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        });
        await onSaved(res.changed ? 'ویرایش شد — و در تاریخچه ماند.' : 'چیزی عوض نشده بود.');
      } else {
        await api.addRevenueAdjustment(body);
        await onSaved('ثبت شد.');
      }
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <div className="card__title">{row ? 'ویرایش ردیف' : 'ثبت ردیف تازه'}</div>
      </div>

      <div className="filters">
        <div>
          <span className="form-label">نوع</span>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {KINDS.map((k) => (
              <label key={k}>
                <input
                  type="radio"
                  name="entry-kind"
                  checked={kind === k}
                  onChange={() => setKind(k)}
                />{' '}
                {LEDGER_KIND_FA[k]}
              </label>
            ))}
          </div>
        </div>

        {kind === 'REVENUE_FIX' && (
          <div>
            <label className="form-label" htmlFor="entry-direction">
              جهت
            </label>
            <select
              id="entry-direction"
              className="form-control"
              value={direction}
              onChange={(e) => setDirection(e.target.value as 'expense' | 'credit')}
            >
              <option value="expense">کم شود از درآمد</option>
              <option value="credit">اضافه شود به درآمد</option>
            </select>
          </div>
        )}

        <div>
          <label className="form-label" htmlFor="entry-amount">
            مبلغ (تومان)
          </label>
          <input
            id="entry-amount"
            className="form-control"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>

        {kind === 'EXPENSE' && (
          <div>
            <label className="form-label" htmlFor="entry-category">
              دسته
            </label>
            <select
              id="entry-category"
              className="form-control"
              value={String(categoryId)}
              onChange={(e) => setCategoryId(e.target.value === '' ? '' : Number(e.target.value))}
            >
              <option value="">— انتخاب نشده —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}

        <DateField label="تاریخ هزینه" value={jDate} onChange={setJDate} />
      </div>

      <div style={{ marginBlockStart: 12 }}>
        <label className="form-label" htmlFor="entry-note">
          شرح
        </label>
        <input
          id="entry-note"
          className="form-control"
          value={note}
          placeholder="مثلاً هزینهٔ یک‌ماههٔ سرور آلمان"
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      {row && (
        <div style={{ marginBlockStart: 12 }}>
          <label className="form-label" htmlFor="entry-reason">
            دلیل تغییر (اختیاری — در تاریخچه می‌ماند)
          </label>
          <input
            id="entry-reason"
            className="form-control"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
      )}

      {/* The sign, before it is committed. The client never sends one, so this
          is the only place an operator sees which way the row will move. */}
      {amountToman > 0 && (
        <p className="muted" style={{ marginBlockStart: 12 }}>
          در دفتر ثبت می‌شود: <strong>{toman(previewIrr)}</strong>
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginBlockStart: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          {row ? 'ذخیره' : 'ثبت'}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          انصراف
        </button>
      </div>
    </div>
  );
}

/**
 * Voiding, which replaced deleting.
 *
 * Not a `window.confirm`: a reason is required now and a confirm cannot ask for
 * one. The directional sentence stays — it was added in August after somebody
 * pressed the old button, and it is the only part of this that says what will
 * happen to the number on the screen behind it.
 */
function VoidForm({
  row,
  onClose,
  onDone,
  onError,
}: {
  row: RevenueAdjustmentRow;
  onClose: () => void;
  onDone: (msg: string) => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <div className="card__title">ابطال ردیف</div>
      </div>
      <p>
        <strong>{row.note}</strong> — {toman(row.amountIrr)} ({LEDGER_KIND_FA[row.kind]})
      </p>
      <p className="muted">
        ردیف در دفتر می‌ماند و از همهٔ جمع‌ها بیرون می‌رود؛ خالص{' '}
        {row.amountIrr < 0 ? 'بالا می‌رود' : 'پایین می‌آید'}. پاک نمی‌شود.
      </p>
      <label className="form-label" htmlFor="void-reason">
        دلیل ابطال
      </label>
      <input
        id="void-reason"
        className="form-control"
        value={reason}
        placeholder="مثلاً دو بار ثبت شده بود"
        onChange={(e) => setReason(e.target.value)}
      />
      <div style={{ display: 'flex', gap: 8, marginBlockStart: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || reason.trim().length < 3}
          onClick={() => {
            setBusy(true);
            api
              .voidRevenueAdjustment(row.id, reason.trim())
              .then(() => onDone('باطل شد — ردیف ماند و از جمع‌ها بیرون رفت.'))
              .catch((e) => onError(message(e)))
              .finally(() => setBusy(false));
          }}
        >
          بله، باطل کن
        </button>
        <button type="button" className="btn" onClick={onClose}>
          انصراف
        </button>
      </div>
    </div>
  );
}
