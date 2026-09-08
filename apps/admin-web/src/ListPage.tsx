/**
 * The one table the panel's ledgers are made of.
 *
 * Lifted out of `LedgerPages.tsx`, where it was already shared by three
 * screens, and given the four things the 2026-09-07 walk found missing from
 * all of them: an order, a date range, an export, and a shape a phone can
 * read.
 *
 * ## Why `columns` replaced `head` + `row`
 *
 * The old split — a `<thead>` blob and a function returning a `<tr>` — cannot
 * say which heading a given cell belongs to, and that pairing is exactly what
 * the mobile layout needs: at 390px the table becomes one card per row, each
 * line reading «مبلغ  ۲۰۰٬۰۰۰ تومان», drawn from `data-label`. Nine columns
 * cannot be a table on a phone, and a horizontally scrolling table is a table
 * whose right-hand columns nobody ever sees.
 *
 * ## Why the server sorts
 *
 * Sorting the twenty-five rows already loaded would order a PAGE of 8,960
 * orders and present it as the ledger's order — the same lie `narrowed` was
 * written to stop, and worse, because it looks right. Every control here sends
 * a request; nothing rearranges what is on screen.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ApiError } from './api.js';
import { DateField } from './DateField.js';
import { SortableHeader } from './hub/SortableHeader.js';
import { useTableSortState } from './hub/useTableSortState.js';
import { count } from './format.js';
import { pageLabel, type PageId } from './nav.js';
import { useRole } from './role.js';
import { jalaliToIsoDate, type JalaliDate } from '@shikoo/contracts';

const PAGE_SIZE = 25;

export interface Column<T> {
  /** Unique within the table; also the React key for the cell. */
  key: string;
  /** The heading, and the label a phone prints in front of the value. */
  label: string;
  /** The server-side column name. Omit for a column that cannot be ordered. */
  sort?: string;
  className?: string;
  cell: (row: T, reload: () => void) => ReactNode;
}

export interface FetchParams {
  q?: string;
  /** One customer, exactly — set from `?customerId=` in the address. */
  customerId?: number;
  filter?: string;
  sort?: string;
  dir?: 'asc' | 'desc';
  from?: string;
  to?: string;
  page: number;
  pageSize: number;
}

/** The empty date, meaning «no bound» — not today, which would hide the past. */
const NO_DATE: JalaliDate = { year: 0, month: 1, day: 1 };
const isSet = (d: JalaliDate) => d.year > 0;

export function ListPage<T>({
  page: pageId,
  unit,
  filterLabel,
  filterOptions,
  columns,
  rowKey,
  fetchPage,
  summary,
  searchPlaceholder,
  dateRange,
  csvUrl,
}: {
  page: PageId;
  unit: string;
  filterLabel: string;
  filterOptions: Array<[string, string]>;
  columns: Column<T>[];
  rowKey: (row: T) => string | number;
  fetchPage: (p: FetchParams) => Promise<{ total: number; items: T[] }>;
  summary?: (extra: unknown, scope: { narrowed: boolean }) => ReactNode;
  searchPlaceholder?: string;
  /** Two Jalali date fields, bounding the ledger's own timestamp column. */
  dateRange?: boolean;
  /**
   * The address of this exact list as a file. Given the same parameters the
   * screen was filled from, so the file and the screen cannot disagree — it is
   * the same handler on the server, one branch apart.
   */
  csvUrl?: (p: Omit<FetchParams, 'page' | 'pageSize'>) => string;
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
  // Seeded from the address so «همهٔ N سفارش ←» on a customer's card lands on
  // this ledger already narrowed to them, rather than on the whole shop.
  const [q, setQ] = useState(() => new URLSearchParams(window.location.search).get('q') ?? '');
  /*
   * One customer, exactly, when the address names one.
   *
   * «همهٔ ۱۲ سفارش ←» on a customer's card links here with `?customerId=`, and
   * twelve has to mean twelve: `q` is a fragment match and would also return
   * an order whose public id contains those digits, or another customer whose
   * username contains this one's. Read once on mount — arriving here IS the
   * navigation — and the operator widens the view by typing in the box.
   */
  const customerId = useMemo(() => {
    const raw = new URLSearchParams(window.location.search).get('customerId');
    const n = raw === null ? NaN : Number(raw);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  }, []);
  const [filter, setFilter] = useState('');
  const [jFrom, setJFrom] = useState<JalaliDate>(NO_DATE);
  const [jTo, setJTo] = useState<JalaliDate>(NO_DATE);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  /*
   * The sort lives in the address, keyed by section.
   *
   * `?sort_orders=total_irr:asc` — the hub's own shape, reused rather than
   * reinvented, so Back walks sorts and a screen can be sent to a colleague as
   * a link. Keyed by page because two ledgers can be open in two tabs.
   */
  const [sort, setSort] = useTableSortState(pageId, { column: '', direction: 'desc' });

  const params = (): Omit<FetchParams, 'page' | 'pageSize'> => ({
    ...(q.trim() ? { q: q.trim() } : {}),
    ...(customerId ? { customerId } : {}),
    ...(filter ? { filter } : {}),
    ...(sort.column ? { sort: sort.column, dir: sort.direction } : {}),
    ...(isSet(jFrom) ? { from: jalaliToIsoDate(jFrom) } : {}),
    ...(isSet(jTo) ? { to: jalaliToIsoDate(jTo) } : {}),
  });

  async function load(toPage = page) {
    setLoading(true);
    setErr(null);
    const sent = params();
    try {
      const d = await fetchPage({ ...sent, page: toPage, pageSize: PAGE_SIZE });
      setRows(d.items);
      setTotal(d.total);
      setExtra(d);
      setNarrowed(Object.keys(sent).some((k) => k !== 'sort' && k !== 'dir'));
    } catch (e) {
      setErr(e instanceof ApiError ? (e.detail ?? e.code) : String(e));
    } finally {
      setLoading(false);
    }
  }

  // Not on `q` or the dates: those are submitted, not typed against 11k rows.
  // Sort and filter are single choices, so they act at once.
  useEffect(() => {
    void load(page);
  }, [page, filter, sort.column, sort.direction]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // The export is ADMIN-only on the server; drawing a button that answers 403
  // is worse than not drawing one.
  const mayExport = useRole() === 'ADMIN';

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">{pageLabel(pageId)}</h2>
          <div className="page-head__sub">
            {count(total)} {unit}
          </div>
        </div>
        {csvUrl && mayExport && (
          // A navigation, not a fetch: the server already produced the bytes.
          <a className="btn" href={csvUrl(params())} download={`${pageId}.csv`}>
            خروجی CSV
          </a>
        )}
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
          {dateRange && (
            <>
              <DateField label="از" value={isSet(jFrom) ? jFrom : NO_DATE} onChange={setJFrom} />
              <DateField label="تا" value={isSet(jTo) ? jTo : NO_DATE} onChange={setJTo} />
            </>
          )}
          <button type="submit" className="btn btn-primary" disabled={loading}>
            جست‌وجو
          </button>
        </form>

        {err && <div className="alert alert-error">{err}</div>}
        {summary && extra ? summary(extra, { narrowed }) : null}

        <div className="table-wrap">
          <table className="app-table app-table--cards">
            <thead>
              <tr>
                {columns.map((col) =>
                  col.sort ? (
                    <SortableHeader
                      key={col.key}
                      column={col.sort}
                      label={col.label}
                      state={sort}
                      onChange={(next) => {
                        setSort(next);
                        setPage(1);
                      }}
                      {...(col.className ? { className: col.className } : {})}
                    />
                  ) : (
                    <th key={col.key} className={col.className}>
                      {col.label}
                    </th>
                  ),
                )}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td className="empty" colSpan={columns.length}>
                    چیزی با این جست‌وجو پیدا نشد.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={rowKey(r)}>
                  {columns.map((col) => (
                    // `data-label` is what a phone prints in front of the value
                    // once the table becomes cards.
                    <td key={col.key} data-label={col.label} className={col.className}>
                      {col.cell(r, () => void load())}
                    </td>
                  ))}
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
