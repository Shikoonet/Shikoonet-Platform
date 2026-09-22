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
 * ## A bill in euro, and a bill that comes back
 *
 * «هزینه یک ماهه سرور آلمان» is billed in euro and billed again in thirty days,
 * so it needed both. A row can name the currency it arrived in and the rate on
 * the day, and the Toman figure is derived from those two on the server — the
 * form never sends an amount for a foreign bill, so what is on the screen and
 * what is in the books cannot be two roundings of one invoice.
 *
 * A recurring cost is a template with a due date and no cron behind it. The
 * banner at the top says what is owed and «ثبت» posts one instalment; if nobody
 * presses it the number on the banner grows, which is a visible failure rather
 * than a silent book.
 *
 * ## Nothing is deleted
 *
 * A row is voided: it stays, greys out, and leaves every total. That is what
 * makes the edit history worth keeping, and it also fixes a bug — `verify.ts`
 * counts rows in this table against the legacy log, so one deletion made the
 * importer's own check red for ever with nothing on any screen saying why.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  jalaliPeriodLabel,
  jalaliToIsoDate,
  nextJalaliDue,
  toJalali,
  type JalaliDate,
} from '@shikoo/contracts';
import { DateField } from '../DateField.js';
import {
  api,
  ApiError,
  CURRENCY_FA,
  FOREIGN_CURRENCIES,
  LEDGER_KIND_FA,
  PARTY_ROLE_FA,
  SCOPE_LEVEL_FA,
  type Currency,
  type ExpenseCategory,
  type ExpenseRecurrence,
  type ExpenseScopes,
  type LedgerRefs,
  type LedgerScope,
  type Party,
  type ScopeLevel,
  type LedgerFilter,
  type LedgerHistoryEntry,
  type LedgerKind,
  type LedgerMoney,
  type RevenueAdjustmentRow,
  type RevenueTotals,
  type WithdrawalOption,
} from '../api.js';
import { api as hubApi, type AccountListItem } from '../hub/api.js';
import { count, dateOnly, dateTime, toman } from '../format.js';

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'admin_access_not_configured') return 'درِ دسترسی ادمین تنظیم نشده است.';
    if (e.code === 'already_voided') return 'این ردیف قبلاً باطل شده است.';
    if (e.code === 'duplicate_name') return 'دسته‌ای با همین نام هست.';
    if (e.code === 'draw_needs_a_partner') return 'برداشت سود باید به نام یکی از شرکا ثبت شود.';
    if (e.code === 'party_not_found') return 'این شخص پیدا نشد.';
    if (e.code === 'scope_not_found') return 'این دسته، سرویس یا پنل دیگر وجود ندارد.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

const PAGE_SIZE = 50;
const ZERO: RevenueTotals = {
  expensesIrr: 0,
  feesIrr: 0,
  revenueFixIrr: 0,
  manualIncomeIrr: 0,
  partnerDrawsIrr: 0,
  netIrr: 0,
  expensesCount: 0,
  revenueFixCount: 0,
  manualIncomeCount: 0,
  partnerDrawsCount: 0,
  netCount: 0,
};

/**
 * What each column is added up from, in the words an admin would use.
 *
 * The card showed four figures under four bare nouns and Sam asked the obvious
 * question: «معلوم نیست از کجا میاد اطلاعاتش». «اصلاح درآمد» is the one that
 * needs it most — nobody guesses that it means fake receipts and duplicate
 * charges, and it is the column whose misreading cost 35.8 million Toman of
 * imaginary spending on the screen this page replaced.
 */
const COLUMN_FA: {
  key: 'expenses' | 'revenueFix' | 'manualIncome' | 'partnerDraws' | 'net';
  title: string;
  what: string;
}[] = [
  { key: 'expenses', title: 'هزینه', what: 'پولی که فروشگاه خرج کرده، با کارمزد بانک' },
  { key: 'revenueFix', title: 'اصلاح درآمد', what: 'فیش فیک، عدم واریزی، تکراری' },
  { key: 'manualIncome', title: 'درآمد دستی', what: 'فروشی که دستی ثبت شده' },
  // Its own column since 0092: a partner's share is money out and not a cost,
  // and 680 million Toman of it sat under «هزینه» until it had one.
  { key: 'partnerDraws', title: 'برداشت شرکا', what: 'سهم سود شرکا — هزینه نیست' },
  { key: 'net', title: 'خالص', what: 'جمع ستون‌های قبل' },
];

const KINDS: LedgerKind[] = ['EXPENSE', 'PARTNER_DRAW', 'REVENUE_FIX', 'MANUAL_INCOME'];

/** Money leaving the shop — the kinds an account and a withdrawal SMS belong to. */
const OUTFLOW: LedgerKind[] = ['EXPENSE', 'PARTNER_DRAW'];

/** «مالِ کدام»: one line, for a row or a template. */
function scopeLabel(scope: LedgerScope): string {
  return scope.level === 'SHOP' ? SCOPE_LEVEL_FA.SHOP : `${SCOPE_LEVEL_FA[scope.level]}: ${scope.name ?? '—'}`;
}

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
  currency: 'ارز',
  original_amount: 'مبلغ ارزی',
  fx_rate_irr: 'نرخ ارز',
  party_id: 'شخص (شناسه)',
  product_category_id: 'دستهٔ سرویس (شناسه)',
  product_id: 'سرویس (شناسه)',
  provider_id: 'پنل (شناسه)',
};

/**
 * Digits only, so a pasted «۱٬۲۰۰٬۰۰۰» or «1,200,000» is still a number.
 *
 * ONLY FOR FIELDS THAT CANNOT CARRY A FRACTION. Stripping a decimal point does
 * not round, it shifts: «199999.5» becomes 1999995, which is ten times the
 * amount. That was a live bug on the edit form until 2026-09-01 — see
 * `tomanField` below.
 */
const digits = (v: string) => Number(v.replace(/[^\d]/g, ''));

/** The same, but a decimal point survives — a foreign invoice says 35.5. */
const decimal = (v: string) => Number(v.replace(/[^\d.]/g, ''));

/**
 * A Toman amount typed into a box, which may legitimately have a fraction.
 *
 * A legacy row is stored in Rial and need not be a multiple of ten — the
 * import carries whatever the old panel wrote, and `expenses.spec.ts` seeds
 * −1,999,995 for exactly this reason. Divided for display that is «199999.5»,
 * and a parser that deletes the point reads it as 1,999,995 Toman: **ten times
 * the amount, on a form the operator never touched.**
 *
 * Separators are stripped, the point is kept, and the caller decides what to do
 * with a fraction. Nothing here rounds — rounding on load would quietly rewrite
 * a row by up to nine Rial every time somebody opened it to fix a typo in the
 * description.
 */
const tomanField = (v: string) => Number(v.replace(/[^\d.]/g, ''));

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
  const [recurrences, setRecurrences] = useState<ExpenseRecurrence[]>([]);
  const [parties, setParties] = useState<Party[]>([]);
  const [scopes, setScopes] = useState<ExpenseScopes>({ categories: [], products: [], providers: [] });
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
  // «اشخاص» links here as ?party=<id> — that person's rows, his statement.
  const [partyId, setPartyId] = useState<number | ''>(() => {
    const raw = Number(new URLSearchParams(window.location.search).get('party'));
    return Number.isInteger(raw) && raw > 0 ? raw : '';
  });
  const [q, setQ] = useState('');
  const [voided, setVoided] = useState<'hide' | 'show' | 'only'>('hide');
  const [dated, setDated] = useState(false);
  const [jFrom, setJFrom] = useState<JalaliDate>(() => toJalali(Date.now() - 30 * 86_400_000));
  const [jTo, setJTo] = useState<JalaliDate>(() => toJalali(Date.now()));

  // «دفتر بانک» sends the operator here to explain a withdrawal the bank
  // showed and never texted: ?account=&amount=<toman>&date=YYYY-MM-DD opens
  // the form on that account, that day, that amount.
  const prefill = useMemo(() => {
    const q = new URLSearchParams(window.location.search);
    const account = q.get('account');
    if (!account) return null;
    return { account, amount: q.get('amount') ?? '', date: q.get('date') ?? '' };
  }, []);
  const [editing, setEditing] = useState<RevenueAdjustmentRow | 'new' | null>(prefill ? 'new' : null);
  const [posting, setPosting] = useState<ExpenseRecurrence | null>(null);
  const [managing, setManaging] = useState<'categories' | 'recurrences' | null>(null);
  const [voidingRow, setVoidingRow] = useState<RevenueAdjustmentRow | null>(null);
  const [historyOf, setHistoryOf] = useState<number | null>(null);

  const from = jalaliToIsoDate(jFrom);
  const to = jalaliToIsoDate(jTo);
  const filter: LedgerFilter = useMemo(
    () => ({
      kind,
      categoryId,
      uncategorised,
      partyId,
      q,
      voided,
      ...(dated ? { from, to } : {}),
    }),
    [kind, categoryId, uncategorised, partyId, q, voided, dated, from, to],
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

  // Both lists are the same fetch-once shape and fail the same way: a REVIEWER
  // can read the ledger but not manage it, and an empty list means the form
  // offers nothing rather than that the screen is broken.
  async function loadLists() {
    await Promise.all([
      api
        .expenseCategories()
        .then((r) => setCategories(r.items))
        .catch(() => setCategories([])),
      api
        .expenseRecurrences()
        .then((r) => setRecurrences(r.items))
        .catch(() => setRecurrences([])),
      api
        .parties()
        .then((r) => setParties(r.items))
        .catch(() => setParties([])),
      api
        .expenseScopes()
        .then((r) => setScopes({ categories: r.categories, products: r.products, providers: r.providers }))
        .catch(() => {}),
    ]);
  }

  useEffect(() => {
    void loadLists();
  }, []);

  // Any filter change starts at page one: staying on page 4 of a narrower
  // result set shows an empty table under a total that is not zero.
  useEffect(() => setPage(1), [filter]);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const activeCategories = categories.filter((c) => c.active);

  /**
   * Every form opens HERE, under the page head, and takes the focus with it.
   *
   * They used to render at the bottom of the component, which is where React
   * put them and not where anybody was looking: pressing «ثبت ردیف تازه» at the
   * top of the page opened a form below two summary cards, a breakdown, a filter
   * bar and fifty rows, with nothing on screen saying anything had happened.
   * Sam's words: «دکمه ثبت ردیف تازه میره آخر صفحه یک بخش رو باز میکنه که باید
   * کلی اسکرول کنی».
   *
   * One slot rather than three, because «ویرایش» is pressed from a row far down
   * the table and «ثبت» from the banner at the top — a form rendered next to
   * its own button would be in a different place each time.
   *
   * `scrollIntoView` AND focus, not just the move: the scroll is for the person
   * looking at it and the focus is for the person who is not. Both are optional
   * calls — happy-dom implements neither, and a test environment is not a reason
   * for the panel to throw.
   */
  const formRef = useRef<HTMLDivElement>(null);
  const formOpen = editing !== null || posting !== null || voidingRow !== null;
  useEffect(() => {
    if (!formOpen) return;
    const panel = formRef.current;
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    panel?.scrollIntoView?.({ behavior: still ? 'auto' : 'smooth', block: 'start' });
    panel?.focus?.({ preventScroll: true });
  }, [formOpen]);

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">هزینه‌ها</h2>
          <div className="page-head__sub">{count(total)} ردیف در این فیلتر</div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* A navigation, not a fetch: the server already produced the bytes,
              and pulling the whole filtered ledger through JavaScript to build
              a blob would only be a second way to get the same file wrong. */}
          <a className="btn" href={api.revenueAdjustmentsCsvUrl(filter)} download="expenses.csv">
            خروجی CSV
          </a>
          <button
            type="button"
            className="btn"
            onClick={() => setManaging(managing === 'recurrences' ? null : 'recurrences')}
          >
            هزینه‌های تکرارشونده
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setManaging(managing === 'categories' ? null : 'categories')}
          >
            دسته‌ها
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
            ثبت ردیف تازه
          </button>
        </div>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-info">{done}</div>}

      {/* The forms, at the top. See `formRef` above for why they are not
          rendered where they are used. `tabIndex` so the focus move lands
          somewhere; it is not otherwise reachable by tab, which is correct — it
          is a container, and the fields inside it are the stops. */}
      <div ref={formRef} tabIndex={-1} className="scroll-target" style={{ outline: 'none' }}>
        {editing && (
          <EntryForm
            row={editing === 'new' ? null : editing}
            prefill={editing === 'new' ? prefill : null}
            categories={activeCategories}
            parties={parties}
            scopes={scopes}
            onClose={() => setEditing(null)}
            onSaved={async (msg) => {
              setEditing(null);
              setDone(msg);
              await load();
            }}
            onError={setErr}
          />
        )}

        {posting && (
          <EntryForm
            row={null}
            recurrence={posting}
            categories={activeCategories}
            parties={parties}
            scopes={scopes}
            onClose={() => setPosting(null)}
            onSaved={async (msg) => {
              setPosting(null);
              setDone(msg);
              await Promise.all([load(), loadLists()]);
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
      </div>

      {/* Above the totals, because it is the only thing on this page that is
          asking for something rather than reporting it. */}
      <DueBanner items={recurrences.filter((r) => r.due)} onPost={setPosting} />

      {managing === 'recurrences' && (
        <Recurrences
          items={recurrences}
          categories={activeCategories}
          parties={parties}
          scopes={scopes}
          onPost={setPosting}
          onChanged={async (msg) => {
            setDone(msg);
            await loadLists();
          }}
          onError={setErr}
        />
      )}

      {managing === 'categories' && (
        <Categories
          items={categories}
          onChanged={async (msg) => {
            setDone(msg);
            await loadLists();
          }}
          onError={setErr}
        />
      )}

      <Totals
        inFilter={totals}
        lifetime={lifetime}
        // «باطل‌شده‌ها: پنهان» is the default, not a filter — counting it would
        // tell an admin they had narrowed something when they had not.
        filtered={Boolean(kind || categoryId || uncategorised || partyId || q || dated || voided !== 'hide')}
      />

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
            <label className="form-label" htmlFor="adj-party">
              شخص
            </label>
            <select
              id="adj-party"
              className="form-control"
              value={String(partyId)}
              onChange={(e) => setPartyId(e.target.value === '' ? '' : Number(e.target.value))}
            >
              <option value="">همه</option>
              {parties.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.active ? '' : ' (بایگانی)'}
                </option>
              ))}
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
function Totals({
  inFilter,
  lifetime,
  filtered,
}: {
  inFilter: RevenueTotals;
  lifetime: RevenueTotals;
  /** Whether anything is actually narrowing the view. See the note below. */
  filtered: boolean;
}) {
  const cell = (t: RevenueTotals, key: (typeof COLUMN_FA)[number]['key']) => {
    const irr = t[`${key}Irr`];
    const n = t[`${key}Count`];
    return (
      <td key={key}>
        {key === 'net' ? (
          <span className={irr < 0 ? 'badge badge-block' : 'badge badge-active'}>{toman(irr)}</span>
        ) : (
          toman(irr)
        )}
        {/* The denominator. A total with no row count cannot be checked against
            anything; with one, «۵۶ ردیف» is a filter away from being read. */}
        <div className="muted" style={{ fontSize: 11 }}>
          از {count(n)} ردیف
        </div>
        {/* The bank's share of «هزینه», on its own line: Sam, 2026-09-20 —
            «هر زمان خواستم بتوانم بفهمم چقدر هزینهٔ تراکنش داده‌ایم». */}
        {key === 'expenses' && t.feesIrr > 0 && (
          <div className="muted" style={{ fontSize: 11 }}>
            از این، کارمزد بانک {toman(t.feesIrr)}
          </div>
        )}
      </td>
    );
  };

  const line = (label: string, hint: string, t: RevenueTotals) => (
    <tr>
      <td>
        {label}
        <div className="muted" style={{ fontSize: 11 }}>
          {hint}
        </div>
      </td>
      {COLUMN_FA.map((c) => cell(t, c.key))}
    </tr>
  );

  return (
    <div className="card">
      <div className="table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              <th />
              {COLUMN_FA.map((c) => (
                <th key={c.key}>
                  {c.title}
                  {/* What the column counts, under its name. Four bare nouns is
                      what made this card unreadable. */}
                  <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>
                    {c.what}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {line(
              'در این فیلتر',
              filtered ? 'فقط ردیف‌های جدول پایین' : 'فیلتری فعال نیست',
              inFilter,
            )}
            {line('کل دفتر', 'همهٔ ردیف‌ها، بدون توجه به فیلتر', lifetime)}
          </tbody>
        </table>
      </div>
      <p className="muted" style={{ marginBottom: 0 }}>
        {/* Said explicitly, because two identical rows read as a bug rather than
            as an answer. On an unfiltered page they SHOULD be equal, and a card
            that does not say so is a card that looks like it is repeating
            itself. */}
        {filtered
          ? 'سطر اول همان ردیف‌هایی است که پایین می‌بینی؛ سطر دوم کل دفتر.'
          : 'فیلتری فعال نیست، پس دو سطر عمداً یکی‌اند. با فیلتر، سطر اول حرکت می‌کند و سطر دوم نه.'}{' '}
        هیچ‌کدام ذخیره نمی‌شوند: هر بار از روی همین ردیف‌ها جمع می‌شوند، دقیقاً مثل موجودی کیف
        پول. ردیف‌های باطل‌شده در هیچ‌کدام نیستند.
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
          {(row.partyName || (row.kind === 'EXPENSE' && row.scope.level !== 'SHOP')) && (
            <div className="muted" style={{ fontSize: 11 }}>
              {row.partyName ? `${row.kind === 'MANUAL_INCOME' ? 'از' : 'به'} ${row.partyName}` : ''}
              {row.partyName && row.kind === 'EXPENSE' && row.scope.level !== 'SHOP' ? ' · ' : ''}
              {row.kind === 'EXPENSE' && row.scope.level !== 'SHOP' ? `مالِ ${scopeLabel(row.scope)}` : ''}
            </div>
          )}
          {(row.accountName || row.transactionCandidateId) && (
            <div className="muted" style={{ fontSize: 11 }}>
              {row.accountName ? `از ${row.accountName}` : ''}
              {row.transactionCandidateId ? `${row.accountName ? ' · ' : ''}وصل به پیامک` : ''}
            </div>
          )}
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
          {/* What left the account. The invoice and the bank's cut are split
              on the line under it; the badge is the figure the statement shows. */}
          <span className={row.amountIrr < 0 ? 'badge badge-block' : 'badge badge-active'}>
            {toman(row.amountIrr - row.feeIrr)}
          </span>
          {row.feeIrr > 0 && (
            <div className="muted" style={{ fontSize: 11 }}>
              {toman(-row.amountIrr).replace(' تومان', '')} + کارمزد {toman(row.feeIrr)}
            </div>
          )}
          {/* What the invoice said, under what it came to. Testing `currency`
              alone is enough: the schema keeps all three together or none. */}
          {row.currency !== 'IRR' && (
            <div className="muted" style={{ fontSize: 11 }}>
              {count(row.originalAmount)} {CURRENCY_FA[row.currency]} × {toman(row.fxRateIrr)}
            </div>
          )}
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
 * What is owed, at the top of the page.
 *
 * This is the whole of «هزینهٔ تکرارشونده» that an admin has to look at on an
 * ordinary day: it says nothing when nothing is due, and when something is it
 * asks for one press. Nothing posts itself — a job writing a line into the
 * books that nobody typed, at an amount that may have changed, is a correction
 * screen waiting to be needed.
 *
 * A template nobody presses stays here and the list grows, which is a visible
 * failure. The alternative failure — a silent book that looks right — is the
 * one this page exists to prevent.
 */
function DueBanner({
  items,
  onPost,
}: {
  items: ExpenseRecurrence[];
  onPost: (r: ExpenseRecurrence) => void;
}) {
  if (items.length === 0) return null;

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <div className="card__title">سررسید هزینه‌های تکرارشونده</div>
        <div className="muted">{count(items.length)} مورد آمادهٔ ثبت</div>
      </div>
      <div className="table-wrap">
        <table className="app-table">
          <tbody>
            {items.map((r) => (
              <tr key={r.id}>
                <td>
                  <strong>{r.label}</strong>
                  {r.note && (
                    <div className="muted" style={{ fontSize: 11 }}>
                      {r.note}
                    </div>
                  )}
                </td>
                <td>{r.categoryName ?? '—'}</td>
                <td>{toman(-r.amountIrr)}</td>
                <td>سررسید {dateOnly(`${r.nextDueOn}T12:00:00Z`)}</td>
                <td style={{ textAlign: 'end' }}>
                  <button type="button" className="btn btn-primary" onClick={() => onPost(r)}>
                    ثبت
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The templates themselves — adding one, changing one, archiving one.
 *
 * Behind a toggle rather than on the page, because on almost every visit the
 * answer to «هزینه‌های تکرارشونده» is the banner above and nothing else.
 */
function Recurrences({
  items,
  categories,
  parties,
  scopes,
  onPost,
  onChanged,
  onError,
}: {
  items: ExpenseRecurrence[];
  categories: ExpenseCategory[];
  parties: Party[];
  scopes: ExpenseScopes;
  onPost: (r: ExpenseRecurrence) => void;
  onChanged: (msg: string) => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState<ExpenseRecurrence | 'new' | null>(null);

  async function setActive(r: ExpenseRecurrence, active: boolean) {
    try {
      await api.editExpenseRecurrence(r.id, { active });
      await onChanged(active ? 'دوباره فعال شد.' : 'بایگانی شد — ردیف‌های ثبت‌شده سر جایشان‌اند.');
    } catch (e) {
      onError(message(e));
    }
  }

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <div className="card__title">هزینه‌های تکرارشونده</div>
        <button type="button" className="btn" onClick={() => setEditing('new')}>
          الگوی تازه
        </button>
      </div>

      {editing && (
        <RecurrenceForm
          row={editing === 'new' ? null : editing}
          categories={categories}
          parties={parties}
          scopes={scopes}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => {
            setEditing(null);
            await onChanged(msg);
          }}
          onError={onError}
        />
      )}

      <div className="table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              <th>عنوان</th>
              <th>دسته</th>
              <th>مبلغ</th>
              <th>دوره</th>
              <th>سررسید بعدی</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td className="empty" colSpan={6}>
                  هنوز هزینهٔ تکرارشونده‌ای تعریف نشده. مثلاً «سرور آلمان»، ماهانه.
                </td>
              </tr>
            )}
            {items.map((r) => (
              <tr key={r.id} style={r.active ? undefined : { opacity: 0.55 }}>
                <td>
                  {r.label}
                  {!r.active && <span className="muted"> (بایگانی)</span>}
                  {(r.scope.level !== 'SHOP' || r.partyName) && (
                    <div className="muted" style={{ fontSize: 11 }}>
                      {r.scope.level !== 'SHOP' ? `مالِ ${scopeLabel(r.scope)}` : ''}
                      {r.scope.level !== 'SHOP' && r.partyName ? ' · ' : ''}
                      {r.partyName ? `به ${r.partyName}` : ''}
                    </div>
                  )}
                </td>
                <td>{r.categoryName ?? '—'}</td>
                <td>{toman(-r.amountIrr)}</td>
                <td>{r.period === 'MONTHLY' ? 'ماهانه' : 'سالانه'}</td>
                <td>
                  {dateOnly(`${r.nextDueOn}T12:00:00Z`)}
                  {r.due && <span className="badge badge-block"> سررسید شده</span>}
                </td>
                <td>
                  <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                    {r.active && (
                      <button type="button" className="btn" onClick={() => onPost(r)}>
                        ثبت
                      </button>
                    )}
                    <button type="button" className="btn" onClick={() => setEditing(r)}>
                      ویرایش
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => void setActive(r, !r.active)}
                    >
                      {r.active ? 'بایگانی' : 'فعال کن'}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * A template, added or changed.
 *
 * The amount is asked in Toman with no currency field, and that is deliberate:
 * what recurs about a German server is that it arrives every month, not that it
 * costs the same. The euro amount and that day's rate are asked when the
 * instalment is posted — the fact that changes monthly is asked for monthly,
 * and the template never holds a rate that is stale by definition.
 */
function RecurrenceForm({
  row,
  categories,
  parties,
  scopes,
  onClose,
  onSaved,
  onError,
}: {
  row: ExpenseRecurrence | null;
  categories: ExpenseCategory[];
  parties: Party[];
  scopes: ExpenseScopes;
  onClose: () => void;
  onSaved: (msg: string) => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [label, setLabel] = useState(row?.label ?? '');
  const [amount, setAmount] = useState(row ? String(row.amountIrr / 10) : '');
  const [period, setPeriod] = useState<'MONTHLY' | 'YEARLY'>(row?.period ?? 'MONTHLY');
  const [categoryId, setCategoryId] = useState<number | ''>(row?.categoryId ?? '');
  const [note, setNote] = useState(row?.note ?? '');
  const [jDate, setJDate] = useState<JalaliDate>(() =>
    toJalali(row ? Date.parse(`${row.nextDueOn}T12:00:00Z`) : Date.now()),
  );
  const [refs, setRefs] = useState<Refs>(() => refsFrom(row));
  const [busy, setBusy] = useState(false);

  async function submit() {
    const amountToman = digits(amount);
    if (refs.level !== 'SHOP' && refs.scopeId === '') {
      onError('بگو مالِ کدام است — یا «همهٔ فروشگاه» را بزن.');
      return;
    }
    if (!label.trim()) {
      onError('عنوان لازم است.');
      return;
    }
    if (!Number.isInteger(amountToman) || amountToman <= 0) {
      onError('مبلغ درست نیست.');
      return;
    }
    setBusy(true);
    try {
      const body = {
        label: label.trim(),
        amountToman,
        period,
        categoryId: categoryId === '' ? null : categoryId,
        nextDueOn: jalaliToIsoDate(jDate),
        note: note.trim(),
        ...refsBody(refs),
      };
      if (row) {
        await api.editExpenseRecurrence(row.id, body);
        await onSaved('الگو به‌روز شد.');
      } else {
        await api.addExpenseRecurrence(body);
        await onSaved('الگو ساخته شد — از سررسیدش در بالای همین صفحه یادآوری می‌شود.');
      }
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginBlockEnd: 16 }}>
      <div className="filters">
        <div>
          <label className="form-label" htmlFor="rec-label">
            عنوان
          </label>
          <input
            id="rec-label"
            className="form-control"
            value={label}
            placeholder="مثلاً سرور آلمان"
            onChange={(e) => setLabel(e.target.value)}
          />
        </div>

        <div>
          <label className="form-label" htmlFor="rec-amount">
            مبلغ معمول (تومان)
          </label>
          <input
            id="rec-amount"
            className="form-control"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>

        <div>
          <label className="form-label" htmlFor="rec-period">
            دوره
          </label>
          <select
            id="rec-period"
            className="form-control"
            value={period}
            onChange={(e) => setPeriod(e.target.value as 'MONTHLY' | 'YEARLY')}
          >
            <option value="MONTHLY">ماهانه</option>
            <option value="YEARLY">سالانه</option>
          </select>
        </div>

        <div>
          <label className="form-label" htmlFor="rec-category">
            دسته
          </label>
          <select
            id="rec-category"
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

        <DateField label="سررسید بعدی" value={jDate} onChange={setJDate} />
      </div>

      <RefsFields
        idPrefix="rec"
        kind="EXPENSE"
        refs={refs}
        onChange={setRefs}
        parties={parties}
        scopes={scopes}
      />

      <div style={{ marginBlockStart: 12 }}>
        <label className="form-label" htmlFor="rec-note">
          یادداشت (اختیاری)
        </label>
        <input
          id="rec-note"
          className="form-control"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, marginBlockStart: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void submit()}
        >
          {row ? 'ذخیره' : 'بساز'}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          انصراف
        </button>
      </div>
    </div>
  );
}

/**
 * The categories, managed from the screen that uses them.
 *
 * There is no delete, and the reason is on the row: `rowCount` says how many
 * expenses point at it. The foreign key is `RESTRICT`, so a category with
 * spending against it cannot go anyway, and one without is a row nobody is
 * paying to keep. «بایگانی» takes it out of the form and leaves every past
 * expense still able to say what it was for.
 */
function Categories({
  items,
  onChanged,
  onError,
}: {
  items: ExpenseCategory[];
  onChanged: (msg: string) => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [fresh, setFresh] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(work: () => Promise<unknown>, msg: string) {
    setBusy(true);
    try {
      await work();
      await onChanged(msg);
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <div className="card__title">دسته‌های هزینه</div>
        <div className="muted">تفکیک «چه چیزی خرج شد» از همین فهرست می‌آید</div>
      </div>

      <div className="table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              <th>نام</th>
              <th>ترتیب</th>
              <th>ردیف‌ها</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((c) => (
              <CategoryRow
                key={c.id}
                row={c}
                busy={busy}
                onSave={(body, msg) => void run(() => api.editExpenseCategory(c.id, body), msg)}
              />
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBlockStart: 12, alignItems: 'flex-end' }}>
        <div style={{ flex: 1 }}>
          <label className="form-label" htmlFor="cat-new">
            دستهٔ تازه
          </label>
          <input
            id="cat-new"
            className="form-control"
            value={fresh}
            placeholder="مثلاً بیمه و مالیات"
            onChange={(e) => setFresh(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || fresh.trim().length === 0}
          onClick={() =>
            void run(async () => {
              await api.addExpenseCategory({ name: fresh.trim() });
              setFresh('');
            }, 'دسته اضافه شد.')
          }
        >
          اضافه کن
        </button>
      </div>
    </div>
  );
}

/**
 * One category, with its own draft.
 *
 * Local state per row rather than one draft on the panel: two half-typed
 * renames at once is a real thing an admin does, and a single shared draft
 * would put one of them on the wrong row.
 */
function CategoryRow({
  row,
  busy,
  onSave,
}: {
  row: ExpenseCategory;
  busy: boolean;
  onSave: (body: { name?: string; active?: boolean; sortOrder?: number }, msg: string) => void;
}) {
  const [name, setName] = useState(row.name);
  const [sortOrder, setSortOrder] = useState(String(row.sortOrder));

  const changed = name.trim() !== row.name || digits(sortOrder) !== row.sortOrder;

  return (
    <tr style={row.active ? undefined : { opacity: 0.55 }}>
      <td>
        <input
          className="form-control"
          aria-label={`نام دستهٔ ${row.name}`}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </td>
      <td style={{ width: 90 }}>
        <input
          className="form-control"
          aria-label={`ترتیب دستهٔ ${row.name}`}
          inputMode="numeric"
          value={sortOrder}
          onChange={(e) => setSortOrder(e.target.value)}
        />
      </td>
      {/* What archiving would cost, before it is pressed. */}
      <td>{count(row.rowCount)}</td>
      <td>
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <button
            type="button"
            className="btn"
            disabled={busy || !changed || name.trim().length === 0}
            onClick={() => onSave({ name: name.trim(), sortOrder: digits(sortOrder) }, 'ذخیره شد.')}
          >
            ذخیره
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              onSave(
                { active: !row.active },
                row.active ? 'بایگانی شد — ردیف‌های قبلی سر جایشان‌اند.' : 'دوباره فعال شد.',
              )
            }
          >
            {row.active ? 'بایگانی' : 'فعال کن'}
          </button>
        </div>
      </td>
    </tr>
  );
}

/**
 * The one form: a new row, an edit, and one instalment of a recurring cost.
 *
 * «نوع» is three radios rather than a select because it is the field that
 * decides the sign, and a select showing one of three options hides the choice
 * that matters most on a screen about money.
 *
 * The third mode is here rather than in a form of its own so that the currency
 * fields exist ONCE. A euro amount, a rate, and the rounding between them are
 * the fiddliest thing on this page, and a second copy for recurring bills —
 * which are the ones most likely to be in euro — would be the copy that got it
 * wrong. What the mode changes is the endpoint and which fields the template
 * already answers.
 */
function EntryForm({
  row,
  recurrence = null,
  categories,
  parties,
  scopes,
  prefill = null,
  onClose,
  onSaved,
  onError,
}: {
  row: RevenueAdjustmentRow | null;
  /** Posting one instalment of this template, rather than typing a free row. */
  recurrence?: ExpenseRecurrence | null;
  /** Arriving from «دفتر بانک» with the hole already measured. */
  prefill?: { account: string; amount: string; date: string } | null;
  categories: ExpenseCategory[];
  parties: Party[];
  scopes: ExpenseScopes;
  onClose: () => void;
  onSaved: (msg: string) => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  // Who and what-for — the template's when posting an instalment of one.
  const [refs, setRefs] = useState<Refs>(() => refsFrom(row ?? recurrence));
  // A recurring cost is always spending, and its category is the template's.
  const [kind, setKind] = useState<LedgerKind>(recurrence ? 'EXPENSE' : (row?.kind ?? 'EXPENSE'));
  const [currency, setCurrency] = useState<Currency>(row?.currency ?? 'IRR');
  /**
   * The amount as it stands, exactly — fraction and all.
   *
   * Not rounded on load. A row imported from the old panel can hold a Rial
   * figure that is not a multiple of ten, and rounding here would rewrite it by
   * up to nine Rial the first time anybody opened the form to fix a
   * description. What stops the round-trip from moving money is `moneyTouched`
   * below, not a round.
   */
  const initialAmount = row
    ? String(Math.abs(row.amountIrr) / 10)
    : recurrence
      ? String(recurrence.amountIrr / 10)
      : (prefill?.amount ?? '');
  const initialForeign = row?.originalAmount == null ? '' : String(row.originalAmount);
  const initialRate = row?.fxRateIrr == null ? '' : String(row.fxRateIrr / 10);

  const [amount, setAmount] = useState(initialAmount);
  const [foreign, setForeign] = useState(initialForeign);
  const [rate, setRate] = useState(initialRate);
  const [direction, setDirection] = useState<'expense' | 'credit'>(
    row && row.amountIrr > 0 ? 'credit' : 'expense',
  );
  const [categoryId, setCategoryId] = useState<number | ''>(row?.categoryId ?? '');
  // The default the server would produce if this were sent empty, shown so it
  // can be edited rather than only accepted. `jalaliPeriodLabel` is the shared
  // one, so the two cannot word it differently.
  const [note, setNote] = useState(
    row?.note ?? (recurrence ? `${recurrence.label} — ${jalaliPeriodLabel(recurrence.nextDueOn)}` : ''),
  );
  const [reason, setReason] = useState('');
  /**
   * Where the money left from — Sam, 2026-09-17. The account is asked for
   * spending only; the fee is what the bank took on top; the withdrawal is
   * the SMS this row IS, offered from the account's debits around the date.
   * None of it is required: an old row, or a bill paid from somewhere the
   * phone does not watch, is still a row.
   */
  const [accountId, setAccountId] = useState<string>(row?.financialAccountId ?? prefill?.account ?? '');
  const [fee, setFee] = useState(row && row.feeIrr > 0 ? String(row.feeIrr / 10) : '');
  const [withdrawalId, setWithdrawalId] = useState<string>(row?.transactionCandidateId ?? '');
  const [accounts, setAccounts] = useState<AccountListItem[]>([]);
  const [withdrawals, setWithdrawals] = useState<WithdrawalOption[]>([]);
  // Noon UTC, so parsing a date-only string cannot land on the previous day in
  // Tehran the way midnight would.
  const [jDate, setJDate] = useState<JalaliDate>(() =>
    toJalali(
      row
        ? Date.parse(`${row.spentOn}T12:00:00Z`)
        : recurrence
          ? Date.parse(`${recurrence.nextDueOn}T12:00:00Z`)
          : prefill?.date
            ? Date.parse(`${prefill.date}T12:00:00Z`)
            : Date.now(),
    ),
  );
  const [busy, setBusy] = useState(false);

  const outflow = OUTFLOW.includes(kind);
  useEffect(() => {
    if (!outflow) return;
    let live = true;
    hubApi
      .accounts()
      .then((r) => {
        if (live) setAccounts(r.items.filter((a) => a.active === 1 && a.status === 'ACTIVE'));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [outflow]);

  const spentOnIso = jalaliToIsoDate(jDate);
  useEffect(() => {
    if (!outflow || !accountId) {
      setWithdrawals([]);
      return;
    }
    let live = true;
    api
      .withdrawalsNear(accountId, spentOnIso)
      .then((r) => {
        if (!live) return;
        setWithdrawals(r.items);
        // A date moved far enough that the chosen SMS left the window: the
        // select would show nothing while the submit still sent the old id.
        setWithdrawalId((id) => (id && r.items.some((w) => w.id === id) ? id : ''));
      })
      .catch(() => {
        if (!live) return;
        setWithdrawals([]);
        setWithdrawalId('');
      });
    return () => {
      live = false;
    };
  }, [outflow, accountId, spentOnIso]);

  const originalAmount = decimal(foreign);
  const fxRateToman = digits(rate);
  /**
   * Whether the operator restated the amount, rather than merely opened the form.
   *
   * This is what makes an odd Rial figure safe. An edit that changes only the
   * description sends NO money fields at all, and the route keeps the magnitude
   * it already had — so −1,999,995 stays −1,999,995 instead of being rounded
   * into −2,000,000 or, worse, multiplied by ten.
   *
   * Compared as strings on purpose: the question is «did somebody type in this
   * box», and a numeric comparison would call «۱٬۹۹۹٬۹۹۵» and «1999995» a
   * change when the operator did nothing.
   */
  const moneyTouched =
    currency !== (row?.currency ?? 'IRR') ||
    amount !== initialAmount ||
    foreign !== initialForeign ||
    rate !== initialRate;
  /**
   * The Toman figure, derived the same way the server derives it.
   *
   * A preview only — the request carries the invoice and the rate, never this,
   * so the figure the books get is produced once on the server. If this line
   * and `magnitudeIrr` ever disagreed the screen would be wrong and the ledger
   * would still be right, which is the correct way round.
   */
  const amountToman =
    currency === 'IRR' ? tomanField(amount) : Math.round(originalAmount * fxRateToman);
  const previewIrr =
    outflow || (kind === 'REVENUE_FIX' && direction === 'expense')
      ? -amountToman * 10
      : amountToman * 10;

  async function submit() {
    if (currency !== 'IRR' && !(originalAmount > 0 && fxRateToman > 0)) {
      onError('برای ارز خارجی هم مبلغ ارزی لازم است هم نرخ روز.');
      return;
    }
    // Checked only when it is going to be SENT. An untouched form carrying an
    // imported row's fraction is not an error — it is the reason nothing is
    // sent.
    if ((moneyTouched || !row) && (!Number.isInteger(amountToman) || amountToman <= 0)) {
      onError(
        Number.isInteger(amountToman)
          ? 'مبلغ درست نیست.'
          : 'مبلغ باید عدد درست باشد — این ردیف رقم اعشاری دارد و باید کامل بازنویسی شود.',
      );
      return;
    }
    if (!note.trim()) {
      onError('شرح لازم است.');
      return;
    }
    if (kind === 'PARTNER_DRAW' && refs.partyId === '') {
      onError('برداشت سود مال کدام شریک است؟');
      return;
    }
    if (kind === 'EXPENSE' && refs.level !== 'SHOP' && refs.scopeId === '') {
      onError('بگو مالِ کدام است — یا «همهٔ فروشگاه» را بزن.');
      return;
    }
    const feeToman = tomanField(fee);
    if (fee.trim() && (!Number.isInteger(feeToman) || feeToman < 0)) {
      onError('کارمزد درست نیست.');
      return;
    }
    setBusy(true);
    try {
      // One of the two shapes the server accepts, never both. For a foreign
      // bill no Toman figure is sent at all.
      const money: LedgerMoney =
        currency === 'IRR'
          ? { amountToman }
          : { currency, originalAmount, fxRateToman };
      const spentOn = jalaliToIsoDate(jDate);

      if (recurrence) {
        const res = await api.postExpenseRecurrence(recurrence.id, {
          ...money,
          spentOn,
          note: note.trim(),
          ...(accountId ? { financialAccountId: accountId } : {}),
          ...(feeToman > 0 ? { feeToman } : {}),
          ...(withdrawalId ? { transactionCandidateId: withdrawalId } : {}),
          ...refsBody(refs),
        });
        await onSaved(
          `ثبت شد — سررسید بعدی ${dateOnly(`${res.nextDueOn}T12:00:00Z`)}.`,
        );
        return;
      }

      const rest = {
        kind,
        direction,
        categoryId: kind === 'EXPENSE' ? (categoryId === '' ? null : categoryId) : null,
        spentOn,
        note: note.trim(),
        financialAccountId: outflow && accountId ? accountId : null,
        feeToman: outflow ? feeToman : 0,
        transactionCandidateId: outflow && withdrawalId ? withdrawalId : null,
        // A correction is not paid to anybody; the server would keep a stale
        // person on it otherwise, since an absent field means «unchanged».
        ...(kind === 'REVENUE_FIX' ? { partyId: null } : refsBody(refs)),
      };
      if (row) {
        const res = await api.editRevenueAdjustment(row.id, {
          ...rest,
          // The money goes ONLY if somebody restated it. `EditBody` reads any
          // money field as a whole restatement, so sending an untouched amount
          // is exactly how an imported row's odd Rial figure would be rewritten.
          ...(moneyTouched ? money : {}),
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        });
        await onSaved(res.changed ? 'ویرایش شد — و در تاریخچه ماند.' : 'چیزی عوض نشده بود.');
      } else {
        await api.addRevenueAdjustment({ ...rest, ...money });
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
        <div className="card__title">
          {recurrence ? `ثبت قسط — ${recurrence.label}` : row ? 'ویرایش ردیف' : 'ثبت ردیف تازه'}
        </div>
      </div>

      {recurrence && (
        <p className="muted">
          هزینهٔ {recurrence.period === 'MONTHLY' ? 'ماهانه' : 'سالانه'}
          {recurrence.categoryName ? ` · ${recurrence.categoryName}` : ''} · سررسید{' '}
          {dateOnly(`${recurrence.nextDueOn}T12:00:00Z`)}. بعد از ثبت، سررسید بعدی{' '}
          {dateOnly(`${nextJalaliDue(recurrence.nextDueOn, recurrence.period)}T12:00:00Z`)} می‌شود.
        </p>
      )}

      <div className="filters">
        {/* The template already answers «what kind» and «what for»; asking
            again would be a field with one possible answer. */}
        {!recurrence && (
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
        )}

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
          <label className="form-label" htmlFor="entry-currency">
            ارز
          </label>
          <select
            id="entry-currency"
            className="form-control"
            value={currency}
            onChange={(e) => setCurrency(e.target.value as Currency)}
          >
            <option value="IRR">{CURRENCY_FA.IRR}</option>
            {FOREIGN_CURRENCIES.map((cur) => (
              <option key={cur} value={cur}>
                {CURRENCY_FA[cur]}
              </option>
            ))}
          </select>
        </div>

        {currency === 'IRR' ? (
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
        ) : (
          <>
            <div>
              <label className="form-label" htmlFor="entry-foreign">
                مبلغ فاکتور ({CURRENCY_FA[currency]})
              </label>
              <input
                id="entry-foreign"
                className="form-control"
                inputMode="decimal"
                placeholder="مثلاً ۳۵٫۵"
                value={foreign}
                onChange={(e) => setForeign(e.target.value)}
              />
            </div>
            <div>
              <label className="form-label" htmlFor="entry-rate">
                نرخ روز (تومان برای هر {CURRENCY_FA[currency]})
              </label>
              <input
                id="entry-rate"
                className="form-control"
                inputMode="numeric"
                value={rate}
                onChange={(e) => setRate(e.target.value)}
              />
            </div>
          </>
        )}

        {kind === 'EXPENSE' && !recurrence && (
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

        {outflow && (
          <>
            <div>
              <label className="form-label" htmlFor="entry-account">
                از کدام حساب
              </label>
              <select
                id="entry-account"
                className="form-control"
                value={accountId}
                onChange={(e) => {
                  setAccountId(e.target.value);
                  setWithdrawalId('');
                }}
              >
                <option value="">— مشخص نشده —</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.display_name}
                    {a.card_last_four ? ` · ****${a.card_last_four}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="form-label" htmlFor="entry-fee">
                کارمزد بانک (تومان)
              </label>
              <input
                id="entry-fee"
                className="form-control"
                inputMode="numeric"
                placeholder="۰"
                value={fee}
                onChange={(e) => setFee(e.target.value)}
              />
            </div>
            {accountId && (
              <div>
                <label className="form-label" htmlFor="entry-withdrawal">
                  پیامک برداشت
                </label>
                <select
                  id="entry-withdrawal"
                  className="form-control"
                  value={withdrawalId}
                  onChange={(e) => setWithdrawalId(e.target.value)}
                >
                  <option value="">— وصل نشده —</option>
                  {withdrawals.map((w) => (
                    <option
                      key={w.id}
                      value={w.id}
                      disabled={w.linkedExpenseId !== null && w.linkedExpenseId !== row?.id}
                    >
                      {dateTime(w.bankTimestamp)} · {toman(w.amountIrr)}
                      {w.linkedExpenseId !== null && w.linkedExpenseId !== row?.id
                        ? ` — وصل به ردیف ${w.linkedExpenseId}`
                        : ''}
                    </option>
                  ))}
                </select>
                {withdrawals.length === 0 && (
                  <p className="muted" style={{ marginBlockStart: 4 }}>
                    پیامک برداشتی حول این تاریخ روی این حساب نرسیده.
                  </p>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {kind !== 'REVENUE_FIX' && (
        <RefsFields
          idPrefix="entry"
          kind={kind}
          refs={refs}
          onChange={setRefs}
          parties={parties}
          scopes={scopes}
        />
      )}

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
          is the only place an operator sees which way the row will move — and
          for a foreign bill it is also the only place the multiplication is
          visible before it is done. */}
      {amountToman > 0 && (
        <p className="muted" style={{ marginBlockStart: 12 }}>
          {currency !== 'IRR' && (
            <>
              {count(originalAmount)} {CURRENCY_FA[currency]} × {count(fxRateToman)} تومان —{' '}
            </>
          )}
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
          {recurrence ? 'ثبت قسط' : row ? 'ذخیره' : 'ثبت'}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          انصراف
        </button>
      </div>
    </div>
  );
}

/** The person and the «مالِ کدام» of a row or template, as the form holds them. */
interface Refs {
  partyId: number | '';
  level: ScopeLevel;
  scopeId: number | '';
}

function refsFrom(r: { partyId: number | null; scope: LedgerScope } | null | undefined): Refs {
  return {
    partyId: r?.partyId ?? '',
    level: r?.scope.level ?? 'SHOP',
    scopeId: r?.scope.id ?? '',
  };
}

/** What the server is sent. `SHOP` carries no id; an empty person is a null that clears one. */
function refsBody(r: Refs): LedgerRefs {
  return {
    partyId: r.partyId === '' ? null : r.partyId,
    scope: r.level === 'SHOP' || r.scopeId === '' ? { level: 'SHOP' } : { level: r.level, id: r.scopeId },
  };
}

/**
 * «به کی» and «مالِ کدام» — Sam, 2026-09-22.
 *
 * «وقتی هزینه تعریف می‌کنم باید بتونم وصلش کنم به سرویس‌هامون — مثلاً v2ray یا
 * openvpn یا وایرگارد». Those three are CATEGORIES on this shop; «الماس» is a
 * service inside one; the server is a panel. All three are offered, and the
 * page says what each one does to the profit screen, because «دسته» quietly
 * splitting a cost over four services is the thing an admin would not guess.
 *
 * A draw lists partners only; the server refuses anybody else.
 */
function RefsFields({
  idPrefix,
  kind,
  refs,
  onChange,
  parties,
  scopes,
}: {
  idPrefix: string;
  kind: LedgerKind;
  refs: Refs;
  onChange: (r: Refs) => void;
  parties: Party[];
  scopes: ExpenseScopes;
}) {
  const draw = kind === 'PARTNER_DRAW';
  const choices = parties.filter(
    (p) => (p.active || p.id === refs.partyId) && (!draw || p.roles.includes('PARTNER')),
  );
  // A category or a panel says how many services are under it. Production,
  // 2026-09-22: two panels are both named «سرویس الماس» and only one carries
  // the service, and five panels carry none — picked by name alone, a cost
  // would land on a panel it cannot be spread from.
  const under = (n: number) => (n === 0 ? ' (بدون سرویس)' : ` (${count(n)} سرویس)`);
  const options =
    refs.level === 'CATEGORY'
      ? scopes.categories.map((c) => ({
          id: c.id,
          name: `${c.name}${under(scopes.products.filter((p) => p.categoryId === c.id).length)}`,
        }))
      : refs.level === 'PRODUCT'
        ? scopes.products
            .filter((p) => p.active || p.id === refs.scopeId)
            .map((p) => ({
              id: p.id,
              name: `${p.name}${p.categoryId ? ` — ${scopes.categories.find((c) => c.id === p.categoryId)?.name ?? ''}` : ''}`,
            }))
        : refs.level === 'PROVIDER'
          ? scopes.providers.map((v) => ({
              id: v.id,
              name: `${v.name}${under(scopes.products.filter((p) => p.providerId === v.id).length)}`,
            }))
          : [];
  const spreadOver =
    refs.scopeId === ''
      ? []
      : refs.level === 'CATEGORY'
        ? scopes.products.filter((p) => p.categoryId === refs.scopeId)
        : refs.level === 'PROVIDER'
          ? scopes.products.filter((p) => p.providerId === refs.scopeId)
          : [];

  return (
    <div className="filters" style={{ marginBlockStart: 12 }}>
      <div>
        <label className="form-label" htmlFor={`${idPrefix}-party`}>
          {draw ? 'کدام شریک' : kind === 'MANUAL_INCOME' ? 'از طرف (اختیاری)' : 'به کی (اختیاری)'}
        </label>
        <select
          id={`${idPrefix}-party`}
          className="form-control"
          value={String(refs.partyId)}
          onChange={(e) => onChange({ ...refs, partyId: e.target.value === '' ? '' : Number(e.target.value) })}
        >
          <option value="">{draw ? '— انتخاب کن —' : '— کسی نیست —'}</option>
          {choices.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} · {p.roles.map((r) => PARTY_ROLE_FA[r]).join('، ') || 'بی‌نقش'}
            </option>
          ))}
        </select>
        {choices.length === 0 && (
          <p className="muted" style={{ marginBlockStart: 4 }}>
            {draw ? 'هنوز شریکی تعریف نشده — از «اشخاص» اضافه کن.' : 'شخصی تعریف نشده — از «اشخاص» اضافه کن.'}
          </p>
        )}
      </div>

      {kind === 'EXPENSE' && (
        <>
          <div>
            <label className="form-label" htmlFor={`${idPrefix}-scope-level`}>
              مالِ کدام
            </label>
            <select
              id={`${idPrefix}-scope-level`}
              className="form-control"
              value={refs.level}
              onChange={(e) => onChange({ ...refs, level: e.target.value as ScopeLevel, scopeId: '' })}
            >
              {(['SHOP', 'CATEGORY', 'PRODUCT', 'PROVIDER'] as const).map((l) => (
                <option key={l} value={l}>
                  {SCOPE_LEVEL_FA[l]}
                </option>
              ))}
            </select>
          </div>
          {refs.level !== 'SHOP' && (
            <div>
              <label className="form-label" htmlFor={`${idPrefix}-scope-id`}>
                {SCOPE_LEVEL_FA[refs.level]}
              </label>
              <select
                id={`${idPrefix}-scope-id`}
                className="form-control"
                value={String(refs.scopeId)}
                onChange={(e) => onChange({ ...refs, scopeId: e.target.value === '' ? '' : Number(e.target.value) })}
              >
                <option value="">— انتخاب کن —</option>
                {options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          <p className="muted" style={{ flexBasis: '100%', margin: 0, fontSize: 12 }}>
            {refs.level === 'SHOP'
              ? 'هزینهٔ کل فروشگاه (مثل حسابداری) — در «سود و زیان» جدا نشان داده می‌شود و روی سرویس‌ها پخش نمی‌شود.'
              : refs.level === 'PRODUCT'
                ? 'همهٔ این هزینه به حساب همین سرویس نوشته می‌شود.'
                : refs.scopeId !== '' && spreadOver.length === 0
                  ? 'زیر این هیچ سرویسی نیست، پس روی هیچ سرویسی پخش نمی‌شود — در «سود و زیان» جدا نشان داده می‌شود.'
                  : spreadOver.length > 0
                  ? `بین ${
                      spreadOver.length <= 4
                        ? spreadOver.map((p) => p.name).join('، ')
                        : `${spreadOver.slice(0, 3).map((p) => p.name).join('، ')} و ${count(spreadOver.length - 3)} سرویس دیگر`
                    } پخش می‌شود — به نسبت فروش هرکدام در همان بازه.`
                  : 'بین سرویس‌های زیر آن، به نسبت فروش هرکدام در همان بازه پخش می‌شود.'}
          </p>
        </>
      )}
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
