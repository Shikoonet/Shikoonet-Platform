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
import { Stat } from '../Stat.js';
import { count, dateTime, toman, tomanCompact } from '../format.js';

const CATEGORIES = Object.keys(OFF_BOOKS_CATEGORY_FA) as OffBooksCategory[];

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function shiftMonth(key: string, delta: number): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  const idx = y * 12 + (m - 1) + delta;
  return monthKey(Math.floor(idx / 12), (idx % 12) + 1);
}

function monthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number) as [number, number];
  return `${JALALI_MONTHS[m - 1]} ${y}`;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A signed Toman figure in the tone of its direction; a dash for nothing. */
function Signed({ irr, sign, muted }: { irr: number; sign: '+' | '−'; muted?: boolean }) {
  if (!irr) return <span className="muted">—</span>;
  const tone = muted ? undefined : sign === '+' ? 'var(--success)' : 'var(--danger)';
  return (
    <span className="tabular-nums" style={{ color: tone, whiteSpace: 'nowrap' }}>
      {sign}
      {toman(irr)}
    </span>
  );
}

export function BooksPage({ role }: { role: PanelRole | null }) {
  const canWrite = role === 'ADMIN';
  const thisMonth = useMemo(() => {
    const j = toJalali(Date.now());
    return monthKey(j.year, j.month);
  }, []);
  const [month, setMonth] = useState(thisMonth);
  const [accountId, setAccountId] = useState('');
  const [tab, setTab] = useState<'statement' | 'off-books'>('statement');
  const [accounts, setAccounts] = useState<AccountListItem[]>([]);
  const [statements, setStatements] = useState<AccountStatement[]>([]);
  const [totals, setTotals] = useState<StatementTotals | null>(null);
  const [opening, setOpening] = useState<BooksOpening | null>(null);
  const [movements, setMovements] = useState<BankMovement[]>([]);
  const [offBooks, setOffBooks] = useState<OffBooksItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [tagging, setTagging] = useState<BankMovement | null>(null);
  const [starting, setStarting] = useState(false);
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
    setLoading(true);
    const jobs: Promise<unknown>[] = [
      api.booksStatement(month, accountId || undefined).then((r) => {
        if (!live) return;
        setStatements(r.accounts);
        setTotals(r.totals);
        setOpening(r.opening);
      }),
      api.booksOffBooks(month, accountId || undefined).then((r) => live && setOffBooks(r.items)),
    ];
    if (accountId) {
      jobs.push(api.booksMovements(month, accountId).then((r) => live && setMovements(r.items)));
    } else {
      setMovements([]);
    }
    Promise.all(jobs)
      .catch((e) => live && setErr(message(e)))
      .finally(() => live && setLoading(false));
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
    setStarting(true);
    setErr(null);
    try {
      const r = await api.openBooks(force);
      const missing = r.accounts.filter((a) => a.balanceIrr === null);
      setDone(
        `دفتر باز شد — کیف پول اول: ${toman(r.walletIrr)} از ${count(r.accounts.length - missing.length)} حساب` +
          (missing.length
            ? `؛ ${count(missing.length)} حساب هنوز موجودی نفرستاده: ${missing.map((m) => m.displayName).join('، ')}`
            : '.'),
      );
      refresh();
    } catch (e) {
      setErr(message(e));
    } finally {
      setStarting(false);
    }
  }

  const unexplained = totals?.unexplainedWithdrawalsCount ?? 0;
  const gapAccounts = totals?.accountsWithGap ?? 0;

  return (
    <div>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">دفتر بانک</h2>
          <div className="page-head__sub">
            صورت‌حساب هر حساب به ماه، آنچه مال فروشگاه نیست، و شروع تازه. همهٔ موجودی‌ها حرفِ بانک است.
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <button
              type="button"
              className="btn btn-sm"
              aria-label="ماه قبل"
              onClick={() => setMonth(shiftMonth(month, -1))}
            >
              ‹
            </button>
            <strong data-testid="books-month" style={{ minWidth: 110, textAlign: 'center' }}>
              {monthLabel(month)}
            </strong>
            <button
              type="button"
              className="btn btn-sm"
              aria-label="ماه بعد"
              disabled={month >= thisMonth}
              onClick={() => setMonth(shiftMonth(month, 1))}
            >
              ›
            </button>
            {month !== thisMonth && (
              <button type="button" className="btn btn-link" onClick={() => setMonth(thisMonth)}>
                این ماه
              </button>
            )}
          </div>
          <select
            aria-label="حساب"
            className="form-control"
            style={{ maxWidth: 240 }}
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
        <div className="alert alert-ok" role="status" onClick={() => setDone(null)}>
          {done}
        </div>
      )}

      {opening === null && !loading && (
        <FreshStartCard
          walletNowIrr={totals?.closingIrr ?? null}
          canWrite={canWrite}
          busy={starting}
          onStart={startFresh}
        />
      )}

      {totals && (
        <div className="stats-grid" data-testid="books-tiles">
          <Stat
            tone="tone-blue"
            icon="wallet"
            value={tomanCompact(totals.closingIrr)}
            label="کیف پول — آخر ماه، به گفتهٔ بانک"
            foot={`${toman(totals.closingIrr)} · اول ماه ${toman(totals.openingIrr)}`}
          />
          <Stat
            tone="tone-green"
            icon="money"
            value={tomanCompact(totals.customerIncomeIrr)}
            label="واریز مشتری‌ها"
            foot={`${toman(totals.customerIncomeIrr)} · ${count(totals.customerIncomeCount)} تراکنش`}
          />
          <Stat
            tone="tone-purple"
            icon="receipt"
            value={tomanCompact(totals.ledgerExpenseIrr + totals.ledgerFeeIrr)}
            label="هزینه‌های فروشگاه"
            foot={
              totals.ledgerFeeIrr
                ? `${toman(totals.ledgerExpenseIrr + totals.ledgerFeeIrr)} · کارمزد بانک ${toman(totals.ledgerFeeIrr)}`
                : toman(totals.ledgerExpenseIrr)
            }
          />
          <Stat
            tone={unexplained ? 'tone-orange' : 'tone-cyan'}
            icon="list"
            value={unexplained ? tomanCompact(totals.unexplainedWithdrawalsIrr) : '۰'}
            label="برداشت بی‌توضیح"
            foot={
              unexplained
                ? `${count(unexplained)} برداشت — نه هزینه‌ای برایش ثبت شده، نه خارج از دفتر`
                : 'هر برداشت یا هزینه است یا خارج از دفتر'
            }
          />
          <Stat
            tone={gapAccounts ? 'tone-danger' : totals.accountsUnknown ? 'tone-cyan' : 'tone-green'}
            icon="refresh"
            value={gapAccounts ? tomanCompact(totals.gapIrr) : totals.accountsUnknown ? '؟' : 'می‌خواند'}
            label="اختلاف با بانک"
            foot={
              gapAccounts
                ? `${count(gapAccounts)} حساب — پیامکی جا افتاده`
                : totals.accountsUnknown
                  ? `${count(totals.accountsUnknown)} حساب هنوز موجودی نفرستاده`
                  : 'موجودی بانک با جمع حرکت‌ها یکی است'
            }
          />
        </div>
      )}

      {opening && (
        <OpenedLine opening={opening} canWrite={canWrite} busy={starting} onReopen={() => startFresh(true)} />
      )}

      <div role="tablist" style={{ display: 'flex', gap: 8, marginBlock: 14 }}>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'statement'}
          className={`btn ${tab === 'statement' ? 'btn-primary' : ''}`}
          onClick={() => setTab('statement')}
        >
          صورت‌حساب
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'off-books'}
          className={`btn ${tab === 'off-books' ? 'btn-primary' : ''}`}
          onClick={() => setTab('off-books')}
        >
          خارج از دفتر{offBooks.length ? ` (${count(offBooks.length)})` : ''}
        </button>
      </div>

      {tab === 'statement' && (
        <>
          <Statement rows={statements} totals={totals} loading={loading} />
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
          {!accountId && statements.length > 0 && (
            <p className="muted" style={{ marginBlockStart: 8 }}>
              برای دیدن تک‌تک حرکت‌ها و برچسب‌زدن، یک حساب را از بالا انتخاب کن.
            </p>
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

function FreshStartCard({
  walletNowIrr,
  canWrite,
  busy,
  onStart,
}: {
  walletNowIrr: number | null;
  canWrite: boolean;
  busy: boolean;
  onStart: (force: boolean) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="card" style={{ marginBlockStart: 12, borderColor: 'var(--accent)' }} data-testid="fresh-start">
      <div className="card__head">
        <div className="card__title">شروع تازهٔ دفتر</div>
      </div>
      <p className="muted" style={{ marginBlockStart: 0 }}>
        دفتر هنوز باز نشده. با یک دکمه موجودیِ همین لحظهٔ هر حساب — از آخرین پیامک بانک — به‌عنوان
        موجودی اول نوشته می‌شود و جمعشان کیف پول فروشگاه در روز اول است. صورت‌حساب از همین‌جا شروع
        می‌کند؛ هرچه پیش از آن بوده، حساب نمی‌شود.
      </p>
      {walletNowIrr !== null && (
        <p style={{ fontSize: 22, fontWeight: 800, margin: '8px 0 12px' }}>
          {toman(walletNowIrr)}
          <span className="muted" style={{ fontSize: 13, fontWeight: 400, marginInlineStart: 8 }}>
            جمع موجودی حساب‌های روشن، همین لحظه
          </span>
        </p>
      )}
      {canWrite &&
        (confirming ? (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span>مطمئنی؟ این عدد به‌عنوان روز اول ثبت می‌شود.</span>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                onStart(false);
              }}
            >
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
      {!canWrite && <p className="muted">باز کردن دفتر کار ادمین است.</p>}
    </div>
  );
}

function OpenedLine({
  opening,
  canWrite,
  busy,
  onReopen,
}: {
  opening: BooksOpening;
  canWrite: boolean;
  busy: boolean;
  onReopen: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <p className="muted" style={{ marginBlock: 4 }} data-testid="opened-line">
      دفتر از <strong>{dateTime(opening.openedAt)}</strong> باز است — کیف پول روز اول{' '}
      <strong>{toman(opening.walletIrr)}</strong> از {count(opening.accounts)} حساب.
      {canWrite &&
        (confirming ? (
          <>
            {' '}
            همهٔ موجودی‌های اول از نو نوشته می‌شود و سابقهٔ پیش از آن از صورت‌حساب می‌رود.{' '}
            <button
              type="button"
              className="btn btn-sm btn-danger"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                onReopen();
              }}
            >
              بله، از نو باز کن
            </button>{' '}
            <button type="button" className="btn btn-sm" onClick={() => setConfirming(false)}>
              انصراف
            </button>
          </>
        ) : (
          <>
            {' '}
            <button type="button" className="btn btn-link" onClick={() => setConfirming(true)}>
              از نو باز کردن
            </button>
          </>
        ))}
    </p>
  );
}

function offBooksSum(lines: AccountStatement['offBooksCredits']): number {
  return lines.reduce((a, l) => a + l.amountIrr, 0);
}

function offBooksTitle(lines: AccountStatement['offBooksCredits']): string {
  return lines
    .map((l) => `${OFF_BOOKS_CATEGORY_FA[l.category]}: ${toman(l.amountIrr)} (${count(l.count)})`)
    .join('\n');
}

function Statement({
  rows,
  totals,
  loading,
}: {
  rows: AccountStatement[];
  totals: StatementTotals | null;
  loading: boolean;
}) {
  return (
    <div className="card">
      <div className="card__head">
        <div className="card__title">صورت‌حساب</div>
        <div className="muted">
          اول و آخر ماه حرفِ بانک است؛ بین آن دو، هر حرکت در جای خودش. ستون آخر می‌گوید بانک با جمع ما
          می‌خواند یا نه.
        </div>
      </div>
      <div className="table-wrap">
        <table className="app-table" data-testid="statement">
          <thead>
            <tr>
              <th>حساب</th>
              <th>اول ماه</th>
              <th>واریز مشتری‌ها</th>
              <th title="جابه‌جایی، شخصی، اشتباهی، سود بانک — با موس روی عدد، تفکیکش را ببین">
                خارج از دفتر ↓
              </th>
              <th>هزینه‌های فروشگاه</th>
              <th>برداشت بی‌توضیح</th>
              <th title="قسط وام، برگشت واریز اشتباهی، کارمزد بانک">خارج از دفتر ↑</th>
              <th>آخر ماه</th>
              <th>اختلاف با بانک</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={9} className="empty muted">
                  {loading ? 'در حال بارگذاری…' : 'در این ماه حرکتی نیست.'}
                </td>
              </tr>
            )}
            {rows.map((s) => (
              <tr
                key={s.accountId}
                data-testid={`statement-${s.accountId}`}
                style={s.active ? undefined : { opacity: 0.7 }}
              >
                <td className="cell-name">
                  <strong>{s.displayName}</strong>
                  <div className="muted" style={{ fontSize: 11 }}>
                    {s.bankName}
                    {s.accountHint ? ` · ${s.accountHint}` : ''}
                    {s.active ? '' : ' · خاموش'}
                  </div>
                </td>
                {s.beforeStart ? (
                  <td colSpan={8} className="muted">
                    پیش از شروع دفتر — حساب نمی‌شود.
                  </td>
                ) : (
                  <>
                    <td className="tabular-nums">
                      {s.opening ? (
                        <span title={s.opening.source === 'opening' ? 'شروع تازهٔ دفتر' : dateTime(s.opening.asOf)}>
                          {toman(s.opening.balanceIrr)}
                          {s.opening.source === 'opening' && (
                            <span className="badge" style={{ marginInlineStart: 6 }}>
                              شروع
                            </span>
                          )}
                        </span>
                      ) : (
                        <span className="muted" title="بانک هنوز موجودی این حساب را نگفته">
                          ؟
                        </span>
                      )}
                    </td>
                    <td>
                      <Signed irr={s.customerIncome.amountIrr} sign="+" />
                      {s.customerIncome.count > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          {count(s.customerIncome.count)} تراکنش
                        </div>
                      )}
                    </td>
                    <td title={offBooksTitle(s.offBooksCredits)}>
                      <Signed irr={offBooksSum(s.offBooksCredits)} sign="+" muted />
                    </td>
                    <td>
                      <Signed irr={s.explainedWithdrawals.amountIrr} sign="−" />
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
                        <span
                          className="badge badge-warning"
                          title="برداشتی که نه هزینه‌ای برایش ثبت شده نه خارج از دفتر است — حساب را انتخاب کن و برچسب بزن"
                        >
                          −{toman(s.unexplainedWithdrawals.amountIrr)} · {count(s.unexplainedWithdrawals.count)}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td title={offBooksTitle(s.offBooksDebits)}>
                      <Signed irr={offBooksSum(s.offBooksDebits)} sign="−" muted />
                    </td>
                    <td className="tabular-nums">
                      {s.closing ? (
                        <strong title={dateTime(s.closing.asOf)}>{toman(s.closing.balanceIrr)}</strong>
                      ) : (
                        <span className="muted">؟</span>
                      )}
                    </td>
                    <td>
                      {s.gapIrr === null ? (
                        <span className="muted" title="بدون موجودی اول یا آخر، چیزی برای مقایسه نیست">
                          ؟
                        </span>
                      ) : s.gapIrr === 0 ? (
                        <span className="badge badge-active">می‌خواند</span>
                      ) : (
                        <span
                          className="badge badge-block"
                          title="موجودی بانک با جمع حرکت‌ها نمی‌خواند — پیامکی جا افتاده"
                        >
                          {toman(s.gapIrr)}
                        </span>
                      )}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
          {totals && rows.length > 0 && (
            <tfoot>
              <tr data-testid="statement-totals" style={{ fontWeight: 700 }}>
                <td>جمع {count(totals.accounts)} حساب</td>
                <td className="tabular-nums">{toman(totals.openingIrr)}</td>
                <td>
                  <Signed irr={totals.customerIncomeIrr} sign="+" />
                </td>
                <td>
                  <Signed irr={totals.offBooksCreditsIrr} sign="+" muted />
                </td>
                <td>
                  <Signed irr={totals.explainedWithdrawalsIrr} sign="−" />
                </td>
                <td>
                  <Signed irr={totals.unexplainedWithdrawalsIrr} sign="−" />
                </td>
                <td>
                  <Signed irr={totals.offBooksDebitsIrr} sign="−" muted />
                </td>
                <td className="tabular-nums">{toman(totals.closingIrr)}</td>
                <td>
                  {totals.accountsWithGap
                    ? `${count(totals.accountsWithGap)} حساب`
                    : totals.accountsUnknown
                      ? `${count(totals.accountsUnknown)} حساب بی‌موجودی`
                      : 'می‌خواند'}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

function MovementState({ m }: { m: BankMovement }) {
  if (m.offBooks) {
    return (
      <span className="badge" title={m.offBooks.note ?? undefined}>
        خارج از دفتر — {m.offBooks.categoryFa}
        {m.offBooks.note ? ` · ${m.offBooks.note}` : ''}
      </span>
    );
  }
  if (m.expense) {
    return (
      <span className="badge badge-info" title={m.expense.note ?? undefined}>
        هزینهٔ #{m.expense.id}
        {m.expense.note ? ` · ${m.expense.note}` : ''}
      </span>
    );
  }
  if (m.direction === 'CREDIT') {
    return m.matched ? (
      <span className="badge badge-active">فروش</span>
    ) : (
      <span className="badge">واریز وصل‌نشده</span>
    );
  }
  return <span className="badge badge-warning">برداشت بی‌توضیح</span>;
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
  const open = items.filter((m) => m.direction === 'DEBIT' && !m.expense && !m.offBooks).length;
  return (
    <div className="card" style={{ marginBlockStart: 12 }}>
      <div className="card__head">
        <div className="card__title">حرکت‌های {accountName}</div>
        <div className="muted">
          هر پیامک بانک، و آنچه دفتر درباره‌اش می‌گوید.
          {open > 0 &&
            ` ${count(open)} برداشت هنوز توضیح ندارد: یا در «هزینه‌ها» ثبت و به همین پیامک وصل کن، یا این‌جا خارج از دفتر بزن.`}
        </div>
      </div>
      <div className="table-wrap">
        <table className="app-table" data-testid="movements">
          <thead>
            <tr>
              <th>زمان</th>
              <th>مبلغ</th>
              <th>موجودی بعد</th>
              <th>در دفتر</th>
              <th className="cell-actions"></th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="empty muted">
                  در این ماه حرکتی نیست.
                </td>
              </tr>
            )}
            {items.map((m) => (
              <tr key={m.id} data-testid={`movement-${m.id}`}>
                <td className="tabular-nums">{dateTime(m.bankTimestamp)}</td>
                <td>
                  <Signed irr={m.amountIrr} sign={m.direction === 'CREDIT' ? '+' : '−'} />
                </td>
                <td className="tabular-nums">
                  {m.balanceIrr === null ? <span className="muted">—</span> : toman(m.balanceIrr)}
                </td>
                <td>
                  <MovementState m={m} />
                </td>
                <td className="cell-actions" style={{ whiteSpace: 'nowrap' }}>
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
            ))}
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
  const debit = movement.direction === 'DEBIT';
  const [category, setCategory] = useState<OffBooksCategory>(debit ? 'PERSONAL' : 'TRANSFER');
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
    <div className="card" style={{ marginBlockStart: 12, borderColor: 'var(--accent)' }} data-testid="tag-form">
      <div className="card__head">
        <div className="card__title">
          خارج از دفتر — {debit ? 'برداشت' : 'واریز'} {toman(movement.amountIrr)} ·{' '}
          {dateTime(movement.bankTimestamp)}
        </div>
      </div>
      <div className="filters">
        <div>
          <label className="form-label" htmlFor="tag-category">
            دلیل
          </label>
          <select
            id="tag-category"
            className="form-control"
            value={category}
            onChange={(e) => setCategory(e.target.value as OffBooksCategory)}
          >
            {CATEGORIES.filter((c) => c !== 'OTHER').map((c) => (
              <option key={c} value={c}>
                {OFF_BOOKS_CATEGORY_FA[c]}
              </option>
            ))}
          </select>
        </div>
        <div className="grow">
          <label className="form-label" htmlFor="tag-note">
            یادداشت — در گزارش ماه کنارش می‌آید
          </label>
          <input
            id="tag-note"
            className="form-control"
            value={note}
            placeholder={debit ? 'مثلاً قسط وام پارسیان' : 'مثلاً واریز اشتباهی مادر'}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
      <p className="muted" style={{ marginBlockStart: 8 }}>
        از هیچ جمعی حساب نمی‌شود — نه واریز، نه برداشت، نه هزینه. موجودی دست نمی‌خورد؛ بانک خودش
        حسابش کرده.
        {debit &&
          ' کارمزدی که بانک در پیامک جدا فرستاده را «کارمزد بانک» بزن؛ اگر با خودِ برداشت یکی بود، در ردیف هزینه بنویسش، نه این‌جا.'}
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
  const [category, setCategory] = useState<OffBooksCategory | ''>('');
  const shown = category ? items.filter((i) => i.category === category) : items;
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
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <select
            aria-label="دلیل"
            className="form-control"
            style={{ maxWidth: 220 }}
            value={category}
            onChange={(e) => setCategory(e.target.value as OffBooksCategory | '')}
          >
            <option value="">همهٔ دلیل‌ها</option>
            {CATEGORIES.filter((c) => totals[c]).map((c) => (
              <option key={c} value={c}>
                {OFF_BOOKS_CATEGORY_FA[c]} ({count(totals[c]!.n)})
              </option>
            ))}
          </select>
          <a className="btn" href={csvUrl} download>
            خروجی
          </a>
        </div>
      </div>
      {Object.keys(totals).length > 0 && (
        <p className="muted" style={{ marginBlockStart: 0 }}>
          {CATEGORIES.filter((c) => totals[c]).map((c) => (
            <span key={c} style={{ marginInlineEnd: 18, whiteSpace: 'nowrap' }}>
              {OFF_BOOKS_CATEGORY_FA[c]}:{' '}
              {totals[c]!.credit ? <Signed irr={totals[c]!.credit} sign="+" muted /> : null}
              {totals[c]!.credit && totals[c]!.debit ? ' / ' : ''}
              {totals[c]!.debit ? <Signed irr={totals[c]!.debit} sign="−" muted /> : null} ({count(totals[c]!.n)})
            </span>
          ))}
        </p>
      )}
      <div className="table-wrap">
        <table className="app-table" data-testid="off-books">
          <thead>
            <tr>
              <th>تاریخ</th>
              <th>حساب</th>
              <th>مبلغ</th>
              <th>دلیل</th>
              <th>یادداشت</th>
              <th>ثبت‌کننده</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr>
                <td colSpan={6} className="empty muted">
                  در این ماه چیزی خارج از دفتر نیست.
                </td>
              </tr>
            )}
            {shown.map((it) => (
              <tr key={it.id}>
                <td className="tabular-nums">{dateTime(it.bankTimestamp)}</td>
                <td>{it.accountName ?? <span className="muted">—</span>}</td>
                <td>
                  <Signed irr={it.amountIrr} sign={it.direction === 'CREDIT' ? '+' : '−'} />
                </td>
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
