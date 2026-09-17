/**
 * «دفتر بانک» — the books per account and per Jalali month.
 *
 * Sam, 2026-09-17: «باید سر ماه به ادمین کل حساب پس بدهم». One screen, three
 * things on it:
 *
 *   1. The statement: one row per account, opening balance from the bank,
 *      every movement between sorted into its box, closing balance from the
 *      bank, and the gap when the two do not meet. A CSV of exactly that.
 *   2. The movements of one account, each with what the books say about it,
 *      and the button that takes a movement off the books with a reason —
 *      the loan instalment, the relative's deposit, the transfer from our
 *      other account.
 *   3. The fresh start: the night the books opened, every account's balance
 *      written once as its opening. Before it, nothing counts.
 *
 * Nothing here computes a balance. Every balance is the bank's; the screen
 * explains, it never replaces.
 */

import { useEffect, useMemo, useState } from 'react';
import { JALALI_MONTHS, toJalali } from '@shikoo/contracts';
import {
  api,
  OFF_BOOKS_CATEGORY_FA,
  type AccountStatement,
  type BankMovement,
  type BooksOpening,
  type OffBooksCategory,
  type OffBooksItem,
  type PanelRole,
  type StatementTotals,
} from '../api.js';
import { api as hubApi, type AccountListItem } from '../hub/api.js';
import { count, dateTime, toman } from '../format.js';

const CATEGORIES = Object.keys(OFF_BOOKS_CATEGORY_FA) as OffBooksCategory[];

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const idx = (y * 12 + (m - 1)) + delta;
  return monthKey(Math.floor(idx / 12), (idx % 12) + 1);
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return `${JALALI_MONTHS[m - 1]} ${y}`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function BooksPage({ role }: { role: PanelRole | null }) {
  const canWrite = role === 'ADMIN';
  const [month, setMonth] = useState(() => {
    const j = toJalali(Date.now());
    return monthKey(j.year, j.month);
  });
  const [accountId, setAccountId] = useState('');
  const [tab, setTab] = useState<'statement' | 'off-books'>('statement');
  const [accounts, setAccounts] = useState<AccountListItem[]>([]);
  const [statements, setStatements] = useState<AccountStatement[]>([]);
  const [totals, setTotals] = useState<StatementTotals | null>(null);
  const [opening, setOpening] = useState<BooksOpening | null>(null);
  const [movements, setMovements] = useState<BankMovement[]>([]);
  const [offBooks, setOffBooks] = useState<OffBooksItem[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [tagging, setTagging] = useState<BankMovement | null>(null);
  const [opening_, setOpening_] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    hubApi
      .accounts()
      .then((r) => setAccounts(r.items))
      .catch((e) => setErr(message(e)));
  }, []);

  useEffect(() => {
    let live = true;
    setErr(null);
    api
      .booksStatement(month, accountId || undefined)
      .then((r) => {
        if (!live) return;
        setStatements(r.accounts);
        setTotals(r.totals);
        setOpening(r.opening);
      })
      .catch((e) => live && setErr(message(e)));
    if (accountId) {
      api
        .booksMovements(month, accountId)
        .then((r) => live && setMovements(r.items))
        .catch((e) => live && setErr(message(e)));
    } else {
      setMovements([]);
    }
    api
      .booksOffBooks(month, accountId || undefined)
      .then((r) => live && setOffBooks(r.items))
      .catch((e) => live && setErr(message(e)));
    return () => {
      live = false;
    };
  }, [month, accountId, reload]);

  const refresh = () => setReload((n) => n + 1);

  const accountName = useMemo(
    () => accounts.find((a) => a.id === accountId)?.display_name ?? '',
    [accounts, accountId],
  );

  async function startFresh(force: boolean) {
    setOpening_(true);
    setErr(null);
    try {
      const r = await api.openBooks(force);
      const missing = r.accounts.filter((a) => a.balanceIrr === null);
      setDone(
        `دفتر باز شد — کیف پول اول: ${toman(r.walletIrr)} از ${count(r.accounts.length - missing.length)} حساب` +
          (missing.length ? `؛ ${count(missing.length)} حساب هنوز موجودی نفرستاده: ${missing.map((m) => m.displayName).join('، ')}` : '.'),
      );
      refresh();
    } catch (e) {
      setErr(message(e));
    } finally {
      setOpening_(false);
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">دفتر بانک</h2>
          <div className="page-head__sub">صورت‌حساب هر حساب به ماه، آنچه مال فروشگاه نیست، و شروع تازه.</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button type="button" className="btn" aria-label="ماه قبل" onClick={() => setMonth(shiftMonth(month, -1))}>
            ‹
          </button>
          <strong data-testid="books-month">{monthLabel(month)}</strong>
          <button type="button" className="btn" aria-label="ماه بعد" onClick={() => setMonth(shiftMonth(month, 1))}>
            ›
          </button>
        </div>
        <select
          aria-label="حساب"
          className="form-control"
          style={{ maxWidth: 260 }}
          value={accountId}
          onChange={(e) => setAccountId(e.target.value)}
        >
          <option value="">همهٔ حساب‌ها</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.display_name}
              {a.card_last_four ? ` · ****${a.card_last_four}` : ''}
              {a.active === 1 ? '' : ' (خاموش)'}
            </option>
          ))}
        </select>
        <a className="btn" href={api.booksStatementCsvUrl(month)} download>
          خروجی صورت‌حساب
        </a>
        </div>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {done && (
        <div className="alert alert-ok" onClick={() => setDone(null)}>
          {done}
        </div>
      )}

      <FreshStart
        opening={opening}
        walletNowIrr={totals?.closingIrr ?? null}
        canWrite={canWrite}
        busy={opening_}
        onStart={startFresh}
      />

      <div className="tabs" style={{ display: 'flex', gap: 8, marginBlock: 12 }}>
        <button type="button" className={`btn ${tab === 'statement' ? 'btn-primary' : ''}`} onClick={() => setTab('statement')}>
          صورت‌حساب
        </button>
        <button type="button" className={`btn ${tab === 'off-books' ? 'btn-primary' : ''}`} onClick={() => setTab('off-books')}>
          خارج از دفتر {offBooks.length ? `(${count(offBooks.length)})` : ''}
        </button>
      </div>

      {tab === 'statement' && (
        <>
          <Statement rows={statements} totals={totals} />
          {accountId && (
            <Movements
              accountName={accountName}
              items={movements}
              canWrite={canWrite}
              onTag={(m) => setTagging(m)}
              onUntag={async (m) => {
                try {
                  await api.backOnBooks(m.id);
                  setDone('به دفتر برگشت.');
                  refresh();
                } catch (e) {
                  setErr(message(e));
                }
              }}
            />
          )}
        </>
      )}

      {tab === 'off-books' && (
        <OffBooksList items={offBooks} csvUrl={api.booksOffBooksCsvUrl(month, accountId || undefined)} />
      )}

      {tagging && (
        <TagForm
          movement={tagging}
          onClose={() => setTagging(null)}
          onDone={(msg) => {
            setTagging(null);
            setDone(msg);
            refresh();
          }}
          onError={setErr}
        />
      )}
    </div>
  );
}

function FreshStart({
  opening,
  walletNowIrr,
  canWrite,
  busy,
  onStart,
}: {
  opening: BooksOpening | null;
  walletNowIrr: number | null;
  canWrite: boolean;
  busy: boolean;
  onStart: (force: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  if (opening) {
    return (
      <div className="card" style={{ marginBlockStart: 12 }}>
        <div className="muted">
          دفتر از <strong>{dateTime(opening.openedAt)}</strong> باز است — کیف پول اول:{' '}
          <strong>{toman(opening.walletIrr)}</strong> از {count(opening.accounts)} حساب.
          {canWrite && (
            <>
              {' '}
              {confirming ? (
                <>
                  همهٔ موجودی‌های اول از نو نوشته می‌شود و سابقهٔ قبلی از صورت‌حساب می‌رود.{' '}
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => { setConfirming(false); onStart(true); }}>
                    بله، از نو باز کن
                  </button>{' '}
                  <button type="button" className="btn" onClick={() => setConfirming(false)}>
                    انصراف
                  </button>
                </>
              ) : (
                <button type="button" className="btn btn-link" onClick={() => setConfirming(true)}>
                  از نو باز کردن
                </button>
              )}
            </>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="card" style={{ marginBlockStart: 12 }}>
      <div className="card__head">
        <div className="card__title">شروع تازهٔ دفتر</div>
      </div>
      <p className="muted">
        دفتر هنوز باز نشده. با این دکمه موجودیِ همین لحظهٔ هر حساب (از آخرین پیامک بانک) به‌عنوان
        موجودی اول نوشته می‌شود و جمعشان کیف پول فروشگاه در روز اول است
        {walletNowIrr !== null ? <> — الان: <strong>{toman(walletNowIrr)}</strong></> : null}. صورت‌حساب
        از همین‌جا شروع می‌کند؛ هرچه پیش از آن بوده حساب نمی‌شود.
      </p>
      {canWrite &&
        (confirming ? (
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => { setConfirming(false); onStart(false); }}>
              بله، دفتر را باز کن
            </button>
            <button type="button" className="btn" onClick={() => setConfirming(false)}>
              انصراف
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => setConfirming(true)}>
            شروع تازه
          </button>
        ))}
    </div>
  );
}

function Money({ irr, sign }: { irr: number; sign?: '+' | '−' }) {
  if (!irr) return <span className="muted">—</span>;
  return (
    <span>
      {sign ?? ''}
      {toman(irr)}
    </span>
  );
}

function offBooksSum(lines: AccountStatement['offBooksCredits']): number {
  return lines.reduce((a, l) => a + l.amountIrr, 0);
}

function offBooksTitle(lines: AccountStatement['offBooksCredits']): string {
  return lines.map((l) => `${OFF_BOOKS_CATEGORY_FA[l.category]}: ${toman(l.amountIrr)} (${count(l.count)})`).join('\n');
}

function Statement({ rows, totals }: { rows: AccountStatement[]; totals: StatementTotals | null }) {
  return (
    <div className="card">
      <div className="card__head">
        <div className="card__title">صورت‌حساب</div>
        <div className="muted">هر ردیف یک حساب. اول و آخر ماه حرفِ بانک است؛ بین آن دو، هر حرکت در جای خودش.</div>
      </div>
      <div className="table-wrap">
        <table className="table" data-testid="statement">
          <thead>
            <tr>
              <th>حساب</th>
              <th>اول ماه</th>
              <th>واریز مشتری‌ها</th>
              <th>خارج از دفتر (واریز)</th>
              <th>هزینه‌های ثبت‌شده</th>
              <th>برداشت بی‌توضیح</th>
              <th>خارج از دفتر (برداشت)</th>
              <th>آخر ماه</th>
              <th>اختلاف با بانک</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="muted">
                  در این ماه حرکتی نیست.
                </td>
              </tr>
            )}
            {rows.map((s) => (
              <tr key={s.accountId} data-testid={`statement-${s.accountId}`}>
                <td>
                  <strong>{s.displayName}</strong>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {s.bankName}
                    {s.accountHint ? ` · ${s.accountHint}` : ''}
                    {s.active ? '' : ' · خاموش'}
                  </div>
                </td>
                <td>{s.opening ? <span title={s.opening.source === 'opening' ? 'شروع تازهٔ دفتر' : dateTime(s.opening.asOf)}>{toman(s.opening.balanceIrr)}</span> : <span className="muted">؟</span>}</td>
                <td>
                  <Money irr={s.customerIncome.amountIrr} sign="+" />
                  {s.customerIncome.count > 0 && <div className="muted" style={{ fontSize: 11 }}>{count(s.customerIncome.count)} تراکنش</div>}
                </td>
                <td title={offBooksTitle(s.offBooksCredits)}>
                  <Money irr={offBooksSum(s.offBooksCredits)} sign="+" />
                </td>
                <td>
                  <Money irr={s.explainedWithdrawals.amountIrr} sign="−" />
                  {s.ledger.expenseCount > 0 && (
                    <div className="muted" style={{ fontSize: 11 }}>
                      دفتر: {toman(s.ledger.expenseIrr)}
                      {s.ledger.feeIrr > 0 ? ` + کارمزد ${toman(s.ledger.feeIrr)}` : ''}
                      {s.ledger.unlinkedCount > 0 ? ` · ${count(s.ledger.unlinkedCount)} بدون پیامک` : ''}
                    </div>
                  )}
                </td>
                <td>
                  {s.unexplainedWithdrawals.count > 0 ? (
                    <span className="badge badge-block" title="برداشتی که نه هزینه‌ای برایش ثبت شده نه خارج از دفتر است">
                      −{toman(s.unexplainedWithdrawals.amountIrr)} · {count(s.unexplainedWithdrawals.count)}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td title={offBooksTitle(s.offBooksDebits)}>
                  <Money irr={offBooksSum(s.offBooksDebits)} sign="−" />
                </td>
                <td>{s.closing ? <span title={dateTime(s.closing.asOf)}>{toman(s.closing.balanceIrr)}</span> : <span className="muted">؟</span>}</td>
                <td>
                  {s.gapIrr === null ? (
                    <span className="muted">؟</span>
                  ) : s.gapIrr === 0 ? (
                    <span className="badge badge-active">می‌خواند</span>
                  ) : (
                    <span className="badge badge-block" title="موجودی بانک با جمع حرکت‌ها نمی‌خواند — پیامکی جا افتاده">
                      {toman(s.gapIrr)}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {totals && rows.length > 0 && (
            <tfoot>
              <tr data-testid="statement-totals">
                <th>جمع {count(totals.accounts)} حساب</th>
                <th>{toman(totals.openingIrr)}</th>
                <th>+{toman(totals.customerIncomeIrr)}</th>
                <th>+{toman(totals.offBooksCreditsIrr)}</th>
                <th>−{toman(totals.explainedWithdrawalsIrr)}</th>
                <th>{totals.unexplainedWithdrawalsCount ? `−${toman(totals.unexplainedWithdrawalsIrr)}` : '—'}</th>
                <th>−{toman(totals.offBooksDebitsIrr)}</th>
                <th>{toman(totals.closingIrr)}</th>
                <th>{totals.accountsWithGap ? `${count(totals.accountsWithGap)} حساب` : 'می‌خواند'}</th>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function Movements({
  accountName,
  items,
  canWrite,
  onTag,
  onUntag,
}: {
  accountName: string;
  items: BankMovement[];
  canWrite: boolean;
  onTag: (m: BankMovement) => void;
  onUntag: (m: BankMovement) => void;
}) {
  return (
    <div className="card" style={{ marginBlockStart: 12 }}>
      <div className="card__head">
        <div className="card__title">حرکت‌های {accountName}</div>
        <div className="muted">هر پیامک بانک، و آنچه دفتر درباره‌اش می‌گوید.</div>
      </div>
      <div className="table-wrap">
        <table className="table" data-testid="movements">
          <thead>
            <tr>
              <th>زمان</th>
              <th>جهت</th>
              <th>مبلغ</th>
              <th>موجودی بعد</th>
              <th>در دفتر</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  حرکتی نیست.
                </td>
              </tr>
            )}
            {items.map((m) => {
              const state = m.offBooks
                ? `خارج از دفتر — ${m.offBooks.categoryFa}${m.offBooks.note ? ` (${m.offBooks.note})` : ''}`
                : m.expense
                  ? `هزینهٔ #${m.expense.id}${m.expense.note ? ` — ${m.expense.note}` : ''}`
                  : m.direction === 'CREDIT'
                    ? m.matched
                      ? 'فروش'
                      : 'واریز وصل‌نشده'
                    : 'برداشت بی‌توضیح';
              return (
                <tr key={m.id} data-testid={`movement-${m.id}`}>
                  <td>{dateTime(m.bankTimestamp)}</td>
                  <td>{m.direction === 'CREDIT' ? 'واریز' : 'برداشت'}</td>
                  <td>{toman(m.amountIrr)}</td>
                  <td>{m.balanceIrr === null ? <span className="muted">—</span> : toman(m.balanceIrr)}</td>
                  <td>
                    <span className={m.offBooks ? 'muted' : m.direction === 'DEBIT' && !m.expense ? 'badge badge-block' : ''}>
                      {state}
                    </span>
                  </td>
                  <td>
                    {canWrite && !m.matched && !m.expense && !m.offBooks && (
                      <button type="button" className="btn btn-sm" onClick={() => onTag(m)}>
                        خارج از دفتر
                      </button>
                    )}
                    {canWrite && m.offBooks && (
                      <button type="button" className="btn btn-sm" onClick={() => onUntag(m)}>
                        برگردان به دفتر
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TagForm({
  movement,
  onClose,
  onDone,
  onError,
}: {
  movement: BankMovement;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [category, setCategory] = useState<OffBooksCategory>(movement.direction === 'DEBIT' ? 'PERSONAL' : 'TRANSFER');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      await api.offBooks(movement.id, category, note.trim() || undefined);
      onDone('از دفتر بیرون رفت.');
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card" style={{ marginBlockStart: 12 }} data-testid="tag-form">
      <div className="card__head">
        <div className="card__title">
          خارج از دفتر — {movement.direction === 'CREDIT' ? 'واریز' : 'برداشت'} {toman(movement.amountIrr)} ·{' '}
          {dateTime(movement.bankTimestamp)}
        </div>
      </div>
      <div className="filters">
        <div>
          <label className="form-label" htmlFor="tag-category">
            دلیل
          </label>
          <select id="tag-category" className="form-control" value={category} onChange={(e) => setCategory(e.target.value as OffBooksCategory)}>
            {CATEGORIES.filter((c) => c !== 'OTHER').map((c) => (
              <option key={c} value={c}>
                {OFF_BOOKS_CATEGORY_FA[c]}
              </option>
            ))}
          </select>
        </div>
        <div style={{ flex: 1 }}>
          <label className="form-label" htmlFor="tag-note">
            یادداشت (برای گزارش ماه)
          </label>
          <input id="tag-note" className="form-control" value={note} placeholder="مثلاً قسط وام پارسیان" onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
      <p className="muted" style={{ marginBlockStart: 8 }}>
        از هیچ جمعی حساب نمی‌شود — نه واریز، نه برداشت، نه هزینه. موجودی دست نمی‌خورد؛ بانک خودش حسابش کرده.
      </p>
      <div style={{ display: 'flex', gap: 8, marginBlockStart: 12 }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          ثبت
        </button>
        <button type="button" className="btn" onClick={onClose}>
          انصراف
        </button>
      </div>
    </div>
  );
}

function OffBooksList({ items, csvUrl }: { items: OffBooksItem[]; csvUrl: string }) {
  const totals = useMemo(() => {
    const t: Partial<Record<OffBooksCategory, { credit: number; debit: number; n: number }>> = {};
    for (const it of items) {
      const e = (t[it.category] ??= { credit: 0, debit: 0, n: 0 });
      e.n += 1;
      if (it.direction === 'CREDIT') e.credit += it.amountIrr;
      else e.debit += it.amountIrr;
    }
    return t;
  }, [items]);
  return (
    <div className="card">
      <div className="card__head">
        <div className="card__title">خارج از دفتر</div>
        <a className="btn" href={csvUrl} download>
          خروجی
        </a>
      </div>
      {Object.keys(totals).length > 0 && (
        <p className="muted">
          {CATEGORIES.filter((c) => totals[c]).map((c) => (
            <span key={c} style={{ marginInlineEnd: 16 }}>
              {OFF_BOOKS_CATEGORY_FA[c]}: {totals[c]!.credit ? `+${toman(totals[c]!.credit)} ` : ''}
              {totals[c]!.debit ? `−${toman(totals[c]!.debit)} ` : ''}({count(totals[c]!.n)})
            </span>
          ))}
        </p>
      )}
      <div className="table-wrap">
        <table className="table" data-testid="off-books">
          <thead>
            <tr>
              <th>تاریخ</th>
              <th>حساب</th>
              <th>جهت</th>
              <th>مبلغ</th>
              <th>دلیل</th>
              <th>یادداشت</th>
              <th>ثبت‌کننده</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  در این ماه چیزی خارج از دفتر نیست.
                </td>
              </tr>
            )}
            {items.map((it) => (
              <tr key={it.id}>
                <td>{dateTime(it.bankTimestamp)}</td>
                <td>{it.accountName ?? <span className="muted">—</span>}</td>
                <td>{it.direction === 'CREDIT' ? 'واریز' : 'برداشت'}</td>
                <td>{toman(it.amountIrr)}</td>
                <td>{it.categoryFa}</td>
                <td>{it.note ?? <span className="muted">—</span>}</td>
                <td>
                  {it.by}
                  <div className="muted" style={{ fontSize: 11 }}>
                    {dateTime(it.at)}
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
