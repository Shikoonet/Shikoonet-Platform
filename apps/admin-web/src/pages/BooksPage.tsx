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

import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import { JALALI_MONTHS, jalaliToIsoDate, toJalali } from '@shikoo/contracts';
import {
  api,
  OFF_BOOKS_CATEGORY_FA,
  type AccountStatement,
  type BalancePoint,
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
  const [tagging, setTagging] = useState<TagTarget | null>(null);
  const [walletNow, setWalletNow] = useState<{ walletIrr: number; accounts: number; missing: number } | null>(null);
  const [starting, setStarting] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    hubApi
      .accounts()
      .then((r) => setAccounts(r.items))
      .catch((e) => setErr(message(e)));
  }, []);

  // The wallet this instant is not a property of the month on screen.
  useEffect(() => {
    api
      .booksOpening()
      .then((r) => setWalletNow(r.now))
      .catch(() => setWalletNow(null));
  }, [reload]);

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
            style={{ maxWidth: 200 }}
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
          <a className="btn btn-sm" href={api.booksStatementCsvUrl(month, accountId || undefined)} download>
            خروجی CSV
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
          walletNowIrr={walletNow?.walletIrr ?? null}
          missing={walletNow?.missing ?? 0}
          canWrite={canWrite}
          busy={starting}
          onStart={startFresh}
        />
      )}

      {totals && (
        <div className="stats-grid stats-grid--five" data-testid="books-tiles">
          <Stat
            tone="tone-blue"
            icon="wallet"
            value={tomanCompact(totals.closingIrr)}
            label="کیف پول — آخر ماه، به گفتهٔ بانک"
            foot={`${toman(totals.closingIrr)} · اول ماه ${toman(totals.openingIrr)}${totals.accountsUnknown ? ' + ؟' : ''}`}
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
            label="هزینه‌های فروشگاه از حساب‌ها"
            foot={
              (totals.ledgerFeeIrr ? `کارمزد بانک ${toman(totals.ledgerFeeIrr)}` : toman(totals.ledgerExpenseIrr)) +
              (totals.expensesNoAccountCount
                ? ` · ${count(totals.expensesNoAccountCount)} هزینهٔ بی‌حساب (${toman(totals.expensesNoAccountIrr)}) این‌جا نیست`
                : '')
            }
          />
          <Stat
            tone={unexplained ? 'tone-orange' : 'tone-cyan'}
            icon="list"
            value={unexplained ? tomanCompact(totals.unexplainedWithdrawalsIrr) : '۰'}
            label="برداشت بی‌توضیح"
            foot={
              unexplained
                ? `${count(unexplained)} پیامک برداشت که نه هزینه است نه خارج از دفتر`
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
                ? `${count(gapAccounts)} حساب نمی‌خواند — بازش کن و ردیف خاکستری را توضیح بده`
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
              accountId={accountId}
              accountName={accountName}
              items={movements}
              opening={statements.find((s) => s.accountId === accountId)?.opening ?? null}
              canWrite={canWrite}
              tagging={tagging}
              onTag={(t) => setTagging(t)}
              onUntag={async (m) => {
                try {
                  if (m.kind === 'manual') await api.voidManualMovement(m.id);
                  else await api.backOnBooks(m.id);
                  setDone(m.kind === 'manual' ? 'ردیف دستی حذف شد.' : 'به دفتر برگشت.');
                  refresh();
                } catch (e) {
                  setErr(message(e));
                }
              }}
              tagForm={
                tagging && (
                  <TagForm
                    target={tagging}
                    onClose={() => setTagging(null)}
                    onDone={(msg) => {
                      setTagging(null);
                      setDone(msg);
                      refresh();
                    }}
                    onError={setErr}
                  />
                )
              }
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
        <OffBooksList
          items={offBooks}
          csvUrl={api.booksOffBooksCsvUrl(month, accountId || undefined)}
          canWrite={canWrite}
          onRelabel={async (it, category) => {
            try {
              if (it.kind === 'manual') throw new Error('ردیف دستی را حذف کن و دوباره بنویس.');
              await api.relabelOffBooks(it.id, category);
              setDone('دلیل عوض شد.');
              refresh();
            } catch (e) {
              setErr(message(e));
            }
          }}
        />
      )}
    </div>
  );
}

function FreshStartCard({
  walletNowIrr,
  missing,
  canWrite,
  busy,
  onStart,
}: {
  walletNowIrr: number | null;
  missing: number;
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
            جمع موجودی حساب‌های روشن، همین لحظه{missing ? ` — ${count(missing)} حساب هنوز موجودی نفرستاده` : ''}
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
        <table className="app-table app-table--tight" data-testid="statement" style={{ minWidth: 880 }}>
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
                      <Signed irr={s.ledger.expenseIrr + s.ledger.feeIrr} sign="−" />
                      {s.ledger.expenseCount > 0 && (
                        <div className="muted" style={{ fontSize: 11 }}>
                          {count(s.ledger.expenseCount)} هزینه
                          {s.ledger.feeIrr > 0 ? ` · کارمزد ${toman(s.ledger.feeIrr)}` : ''}
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
                          {toman(s.unexplainedWithdrawals.amountIrr)} ({count(s.unexplainedWithdrawals.count)})
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
                          title="موجودی بانک با جمع حرکت‌ها نمی‌خواند — پولی رفته یا آمده که نه پیامک دارد نه توضیح؛ حساب را باز کن و ردیف خاکستری را توضیح بده"
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
                <td className="tabular-nums" title={totals.accountsUnknown ? 'بدون حساب‌هایی که موجودی نفرستاده‌اند' : undefined}>
                  {toman(totals.openingIrr)}
                  {totals.accountsUnknown ? <span className="muted"> + ؟</span> : null}
                </td>
                <td>
                  <Signed irr={totals.customerIncomeIrr} sign="+" />
                </td>
                <td>
                  <Signed irr={totals.offBooksCreditsIrr} sign="+" muted />
                </td>
                <td>
                  <Signed irr={totals.ledgerExpenseIrr + totals.ledgerFeeIrr} sign="−" />
                </td>
                <td>
                  <Signed irr={totals.unexplainedWithdrawalsIrr} sign="−" />
                </td>
                <td>
                  <Signed irr={totals.offBooksDebitsIrr} sign="−" muted />
                </td>
                <td className="tabular-nums">
                  {toman(totals.closingIrr)}
                  {totals.accountsUnknown ? <span className="muted"> + ؟</span> : null}
                </td>
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
        {m.kind === 'manual' ? 'دستی — ' : 'خارج از دفتر — '}
        {m.offBooks.categoryFa}
        {m.offBooks.note ? ` · ${m.offBooks.note}` : ''}
      </span>
    );
  }
  if (m.expense) {
    return (
      <span className="badge badge-info" title={m.expense.note ?? undefined}>
        هزینهٔ #{m.expense.id}
        {m.kind === 'expense' ? ' · بدون پیامک' : ''}
        {m.feeIrr ? ` · کارمزد ${toman(m.feeIrr)}` : ''}
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

/** A movement the bank's balances imply but no row carries: found between two SMS. */
export interface Hole {
  accountId: string;
  direction: 'CREDIT' | 'DEBIT';
  amountIrr: number;
  /** Just before the SMS whose balance revealed it. */
  at: number;
  /** The SMS after the hole, so the row can sit beside it. */
  beforeId: string;
}

export type TagTarget = { kind: 'sms'; movement: BankMovement } | { kind: 'hole'; hole: Hole };

/**
 * Walk the list oldest-first and hold each balance-bearing SMS against the
 * one before it. The bank's «موجودی بعد» is the outside truth here: when
 * prev.balance ± everything between does not reach this.balance, money moved
 * that nobody texted. Hand-written rows count toward «everything between»,
 * which is how writing one down closes the hole it explains.
 */
export function findHoles(accountId: string, items: BankMovement[], opening: BalancePoint | null = null): Hole[] {
  // The opening balance is a bank balance too, so the gap between it and the
  // first SMS after it is a hole like any other. Without this seed the month's
  // «اختلاف با بانک» could be non-zero with no grey row to explain it — seen on
  // production 2026-09-18, when a late Melli text left the opening 150,000
  // toman short and the first movement after it "did not reach" the bank.
  const asc = [...items]
    .filter((m) => opening === null || m.bankTimestamp > opening.asOf)
    .sort((a, b) => a.bankTimestamp - b.bankTimestamp);
  const holes: Hole[] = [];
  let expected: number | null = opening?.balanceIrr ?? null;
  for (const m of asc) {
    // A withdrawal is the text plus the fee the bank folded into it (#641,
    // 2026-09-20: 1,090,000 texted, 1,101,000 taken, 11,000 on the expense).
    const signed = m.direction === 'CREDIT' ? m.amountIrr : -(m.amountIrr + (m.feeIrr ?? 0));
    if (m.kind !== 'sms' || m.balanceIrr === null) {
      if (expected !== null) expected += signed;
      continue;
    }
    if (expected !== null) {
      const diff = m.balanceIrr - (expected + signed);
      if (diff !== 0) {
        holes.push({
          accountId,
          direction: diff > 0 ? 'CREDIT' : 'DEBIT',
          amountIrr: Math.abs(diff),
          at: m.bankTimestamp - 1000,
          beforeId: m.id,
        });
      }
    }
    expected = m.balanceIrr;
  }
  return holes;
}

function Movements({
  accountId,
  accountName,
  items,
  opening,
  canWrite,
  tagging,
  tagForm,
  onTag,
  onUntag,
}: {
  accountId: string;
  accountName: string;
  items: BankMovement[];
  opening: BalancePoint | null;
  canWrite: boolean;
  tagging: TagTarget | null;
  tagForm: ReactNode;
  onTag: (t: TagTarget) => void;
  onUntag: (m: BankMovement) => void;
}) {
  const open = items.filter((m) => m.direction === 'DEBIT' && !m.expense && !m.offBooks).length;
  const holes = useMemo(() => findHoles(accountId, items, opening), [accountId, items, opening]);
  const holeBefore = new Map(holes.map((h) => [h.beforeId, h]));
  const formRow = (
    <tr data-testid="tag-form-row">
      <td colSpan={5} style={{ padding: 0 }}>
        {tagForm}
      </td>
    </tr>
  );
  return (
    <div className="card" style={{ marginBlockStart: 12 }}>
      <div className="card__head">
        <div className="card__title">حرکت‌های {accountName}</div>
        <div className="muted">
          هر پیامک بانک، و آنچه دفتر درباره‌اش می‌گوید.
          {open > 0 &&
            ` ${count(open)} برداشت هنوز توضیح ندارد: یا در «هزینه‌ها» ثبت و به همین پیامک وصل کن، یا این‌جا خارج از دفتر بزن.`}
          {holes.length > 0 &&
            ` ${count(holes.length)} جا موجودی بانک با پیامک‌ها نمی‌خواند — ردیف خاکستری را توضیح بده.`}
        </div>
      </div>
      <div className="table-wrap">
        <table className="app-table app-table--tight" data-testid="movements" style={{ minWidth: 640 }}>
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
            {items.map((m) => {
              const hole = holeBefore.get(m.id);
              const taggingThis = tagging?.kind === 'sms' && tagging.movement.id === m.id;
              const taggingHole = tagging?.kind === 'hole' && tagging.hole.beforeId === m.id;
              return (
                <Fragment key={m.id}>
                  <tr data-testid={`movement-${m.id}`} style={m.kind !== 'sms' ? { opacity: 0.85 } : undefined}>
                    <td className="tabular-nums">{dateTime(m.bankTimestamp)}</td>
                    <td>
                      <Signed irr={m.amountIrr} sign={m.direction === 'CREDIT' ? '+' : '−'} />
                    </td>
                    <td className="tabular-nums">
                      {m.balanceIrr === null ? (
                        <span
                          className="muted"
                          title={
                            m.kind === 'manual'
                              ? `نوشتهٔ ${m.by ?? ''}`
                              : m.kind === 'expense'
                                ? 'از «هزینه‌ها»، پیامکی وصل نیست'
                                : 'بانک موجودی نگفته'
                          }
                        >
                          —
                        </span>
                      ) : (
                        toman(m.balanceIrr)
                      )}
                    </td>
                    <td>
                      <MovementState m={m} />
                    </td>
                    <td className="cell-actions" style={{ whiteSpace: 'nowrap' }}>
                      {canWrite && m.kind === 'sms' && !m.matched && !m.expense && !m.offBooks && (
                        <button type="button" className="btn btn-sm" onClick={() => onTag({ kind: 'sms', movement: m })}>
                          خارج از دفتر
                        </button>
                      )}
                      {canWrite && m.kind === 'sms' && m.offBooks && (
                        <button type="button" className="btn btn-sm" onClick={() => onUntag(m)}>
                          برگردان به دفتر
                        </button>
                      )}
                      {canWrite && m.kind === 'manual' && (
                        <button type="button" className="btn btn-sm" onClick={() => onUntag(m)}>
                          حذف
                        </button>
                      )}
                    </td>
                  </tr>
                  {taggingThis && formRow}
                  {hole && (
                    <tr
                      data-testid={`hole-${m.id}`}
                      style={{ background: 'color-mix(in srgb, var(--warning, #f59e0b) 8%, transparent)' }}
                    >
                      <td className="tabular-nums muted">پیش از {dateTime(m.bankTimestamp)}</td>
                      <td>
                        <Signed irr={hole.amountIrr} sign={hole.direction === 'CREDIT' ? '+' : '−'} muted />
                      </td>
                      <td className="muted">—</td>
                      <td>
                        <span
                          className="badge badge-warning"
                          title="موجودیِ این پیامک با پیامک قبلی و هرچه بینشان ثبت شده نمی‌خواند"
                        >
                          بانک {hole.direction === 'CREDIT' ? 'واریزی' : 'برداشتی'} دیده که پیامکش نرسیده
                        </span>
                      </td>
                      <td className="cell-actions" style={{ whiteSpace: 'nowrap' }}>
                        {canWrite && hole.direction === 'DEBIT' && (
                          <a
                            className="btn btn-sm"
                            href={`/admin/expenses?account=${encodeURIComponent(accountId)}&amount=${Math.round(hole.amountIrr / 10)}&date=${jalaliToIsoDate(toJalali(hole.at))}`}
                            title="هزینهٔ فروشگاه بود — در «هزینه‌ها» با همین حساب و مبلغ ثبت می‌شود"
                          >
                            هزینهٔ فروشگاه
                          </a>
                        )}
                        {canWrite && (
                          <button
                            type="button"
                            className="btn btn-sm"
                            style={{ marginInlineStart: 6 }}
                            onClick={() => onTag({ kind: 'hole', hole })}
                          >
                            خارج از دفتر
                          </button>
                        )}
                      </td>
                    </tr>
                  )}
                  {taggingHole && formRow}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TagForm({
  target,
  onClose,
  onDone,
  onError,
}: {
  target: TagTarget;
  onClose: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const direction = target.kind === 'sms' ? target.movement.direction : target.hole.direction;
  const amountIrr = target.kind === 'sms' ? target.movement.amountIrr : target.hole.amountIrr;
  const at = target.kind === 'sms' ? target.movement.bankTimestamp : target.hole.at;
  const debit = direction === 'DEBIT';
  const [category, setCategory] = useState<OffBooksCategory>(debit ? 'PERSONAL' : 'TRANSFER');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      if (target.kind === 'sms') {
        await api.offBooks(target.movement.id, category, note.trim() || undefined);
        onDone('از دفتر بیرون رفت.');
      } else {
        await api.addManualMovement({
          accountId: target.hole.accountId,
          direction,
          amountToman: Math.round(amountIrr / 10),
          movedAt: at,
          category,
          ...(note.trim() ? { note: note.trim() } : {}),
        });
        onDone('نوشته شد — بانک و دفتر حالا می‌خوانند.');
      }
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="card"
      style={{ margin: 8, borderColor: 'var(--accent)' }}
      data-testid="tag-form"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
      }}
    >
      <div className="card__head">
        <div className="card__title">
          {target.kind === 'hole' ? 'پیامک نرسیده — ' : 'خارج از دفتر — '}
          {debit ? 'برداشت' : 'واریز'} {toman(amountIrr)} · {dateTime(at)}
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
            autoFocus
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
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void submit();
            }}
          />
        </div>
      </div>
      <p className="muted" style={{ marginBlockStart: 8 }}>
        از هیچ جمعی حساب نمی‌شود — نه واریز، نه برداشت، نه هزینه. موجودی دست نمی‌خورد؛ بانک خودش
        حسابش کرده.
        {target.kind === 'hole' &&
          ' این حرکت را بانک نشان داده ولی پیامکش نیامده؛ با همین دکمه در دفتر نوشته می‌شود و ستون «اختلاف با بانک» بسته می‌شود.'}
        {debit &&
          target.kind === 'sms' &&
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

function OffBooksList({
  items,
  csvUrl,
  canWrite,
  onRelabel,
}: {
  items: OffBooksItem[];
  csvUrl: string;
  canWrite: boolean;
  onRelabel: (it: OffBooksItem, category: OffBooksCategory) => void;
}) {
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
          {totals.OTHER && <span> — «سایر» یعنی هنوز نگفته‌ای چه پولی است؛ از همین ستون عوضش کن.</span>}
        </p>
      )}
      <div className="table-wrap">
        <table className="app-table" data-testid="off-books" style={{ minWidth: 720 }}>
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
                <td className="tabular-nums" style={{ whiteSpace: 'nowrap' }}>
                  {dateTime(it.bankTimestamp)}
                </td>
                <td style={{ whiteSpace: 'nowrap' }}>{it.accountName ?? <span className="muted">—</span>}</td>
                <td>
                  <Signed irr={it.amountIrr} sign={it.direction === 'CREDIT' ? '+' : '−'} />
                  {it.kind === 'manual' && (
                    <span className="badge" style={{ marginInlineStart: 6 }} title="بانک پیامکش را نفرستاده؛ ادمین نوشته">
                      دستی
                    </span>
                  )}
                </td>
                <td>
                  {canWrite && it.kind !== 'manual' ? (
                    <select
                      aria-label={`دلیل ${toman(it.amountIrr)}`}
                      className="form-control"
                      style={{ minWidth: 200 }}
                      value={it.category}
                      onChange={(e) => onRelabel(it, e.target.value as OffBooksCategory)}
                    >
                      {CATEGORIES.map((c) => (
                        <option key={c} value={c} disabled={c === 'OTHER' && it.category !== 'OTHER'}>
                          {OFF_BOOKS_CATEGORY_FA[c]}
                        </option>
                      ))}
                    </select>
                  ) : (
                    it.categoryFa
                  )}
                </td>
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
