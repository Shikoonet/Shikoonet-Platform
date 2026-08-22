/**
 * رویدادها — what the three services noticed, on a screen instead of in a
 * container.
 *
 * `app_events` has been filling since 2026-08-22 and until now the only reader
 * was `psql` over SSH. That is the gap this closes: an admin who sees a
 * customer's order fail can open this, find the line, press «کپی» and paste it
 * into a chat. The person debugging then has the event exactly as the process
 * wrote it — level, service, event name, correlation id, fields and the stack
 * — instead of a screenshot and a description.
 *
 * ## Why the copy is JSON and nothing else
 *
 * No Persian header, no «رویداد شمارهٔ …» line, no decoration. The clipboard
 * gets a valid JSON value, so it survives being pasted into a chat, a file or a
 * parser, and nothing in it was reworded on the way out. A copy button whose
 * output has to be un-formatted before it can be read is a copy button that
 * costs the person receiving it more than a screenshot did.
 *
 * ## Read-only on purpose
 *
 * There is no delete and no acknowledge. Rows leave by the thirty-day prune and
 * by nothing else — a button that clears an event clears the record of what a
 * customer lost, and the admin pressing it is usually the person who would most
 * like it gone.
 */

import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type AppEventRow } from '../api.js';
import { copyText } from '../clipboard.js';
import { count, dateTimeSeconds } from '../format.js';

const PAGE_SIZE = 25;

const WINDOWS: Array<[string, string]> = [
  ['24h', '۲۴ ساعت گذشته'],
  ['7d', '۷ روز گذشته'],
  ['30d', '۳۰ روز گذشته'],
  ['all', 'همه'],
];

const LEVELS: Array<[string, string]> = [
  ['error', 'خطا'],
  ['warn', 'هشدار'],
  ['info', 'اطلاع'],
];

const LEVEL_FA: Record<string, string> = { error: 'خطا', warn: 'هشدار', info: 'اطلاع' };

function levelTone(level: string): string {
  if (level === 'error') return 'badge badge-block';
  if (level === 'warn') return 'badge badge-info';
  return 'badge';
}

function message(e: unknown): string {
  if (e instanceof ApiError) return e.detail ?? e.code;
  return e instanceof Error ? e.message : String(e);
}

/**
 * The clipboard payload for one event.
 *
 * `err` is stored as a JSON string, so it is parsed back into an object here
 * rather than pasted as an escaped one-liner — `"stack":"Error: x\\n    at …"`
 * is unreadable in a chat window and is the part the reader needs most. If it
 * is not JSON, it travels as the string it is; guessing would be worse than
 * showing what is there.
 */
export function eventPayload(e: AppEventRow): Record<string, unknown> {
  let err: unknown = e.err;
  if (typeof e.err === 'string') {
    try {
      err = JSON.parse(e.err) as unknown;
    } catch {
      /* not JSON — send the text */
    }
  }
  return {
    id: e.id,
    at: e.at,
    level: e.level,
    svc: e.svc,
    evt: e.evt,
    ...(e.trace ? { trace: e.trace } : {}),
    ...(e.ref ? { ref: e.ref } : {}),
    fields: e.fields,
    ...(err ? { err } : {}),
  };
}

export function eventText(rows: AppEventRow[]): string {
  const payload = rows.map(eventPayload);
  return JSON.stringify(payload.length === 1 ? payload[0] : payload, null, 2);
}

/** A button that says whether the copy actually happened. */
function CopyButton({
  rows,
  label,
  title,
  small = true,
}: {
  rows: AppEventRow[];
  label: string;
  title: string;
  small?: boolean;
}) {
  const [state, setState] = useState<'idle' | 'done' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => (timer.current ? clearTimeout(timer.current) : undefined), []);

  return (
    <button
      type="button"
      className={small ? 'btn btn-sm' : 'btn'}
      title={title}
      onClick={() => {
        void copyText(eventText(rows)).then((ok) => {
          // Reported, not assumed. On a panel opened over plain http the
          // clipboard API is missing entirely, and a button that always says
          // «کپی شد» would have an admin pasting whatever was there before.
          setState(ok ? 'done' : 'failed');
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => setState('idle'), 2000);
        });
      }}
    >
      {state === 'done' ? 'کپی شد ✓' : state === 'failed' ? 'کپی نشد' : label}
    </button>
  );
}

interface SerializedError {
  name?: string;
  message?: string;
  stack?: string;
  cause?: unknown;
}

function ErrorBlock({ raw }: { raw: string }) {
  let parsed: SerializedError | null = null;
  try {
    parsed = JSON.parse(raw) as SerializedError;
  } catch {
    parsed = null;
  }
  if (parsed === null) return <pre className="ltr event-pre">{raw}</pre>;
  // A V8 stack already begins with «Name: message», so printing the headline
  // and then the stack under it showed the same sentence twice — which reads,
  // on the screen, like two different errors that happen to match.
  const headline = `${parsed.name ?? 'Error'}: ${parsed.message ?? ''}`;
  const body = parsed.stack?.startsWith(headline)
    ? parsed.stack
    : `${headline}${parsed.stack ? `\n${parsed.stack}` : ''}`;
  return (
    <pre className="ltr event-pre">
      {body.trimEnd()}
      {parsed.cause ? `\ncause: ${JSON.stringify(parsed.cause, null, 2)}` : ''}
    </pre>
  );
}

export function EventsPage() {
  const [rows, setRows] = useState<AppEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [errors, setErrors] = useState(0);
  const [warns, setWarns] = useState(0);
  const [services, setServices] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [level, setLevel] = useState('');
  const [svc, setSvc] = useState('');
  const [trace, setTrace] = useState('');
  const [window_, setWindow] = useState('7d');
  const [open, setOpen] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (toPage: number, sentQ: string, sentTrace: string) => {
      setLoading(true);
      setErr(null);
      try {
        const d = await api.events({
          page: toPage,
          pageSize: PAGE_SIZE,
          window: window_,
          ...(sentQ ? { q: sentQ } : {}),
          ...(level ? { level } : {}),
          ...(svc ? { svc } : {}),
          ...(sentTrace ? { trace: sentTrace } : {}),
        });
        setRows(d.items);
        setTotal(d.total);
        setErrors(d.errors);
        setWarns(d.warns);
      } catch (e) {
        setErr(message(e));
      } finally {
        setLoading(false);
      }
    },
    [level, svc, window_],
  );

  // `q` is deliberately not a dependency: it is sent when the form is
  // submitted, not on every keystroke. `load` already changes with the level,
  // the service and the window, so listing those again would only re-run this
  // twice for one change.
  useEffect(() => {
    void load(page, q.trim(), trace);
  }, [page, trace, load]);

  useEffect(() => {
    api
      .eventFacets(window_)
      .then((f) => setServices(f.services))
      .catch(() => setServices([]));
  }, [window_]);

  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">رویدادها</div>
          <div className="page-head__sub">
            {count(total)} رویداد · {count(errors)} خطا · {count(warns)} هشدار
          </div>
        </div>
      </div>

      <div className="card">
        <p className="muted">
          هرچه ربات، ingest و داشبورد در سطح <b>خطا</b> و <b>هشدار</b> دیده‌اند، به‌علاوهٔ چند
          رویداد پول. سطح <b>اطلاع</b> عمداً این‌جا نیست — فقط روی خروجی کانتینر می‌رود، وگرنه
          حلقهٔ ربات روزی هزاران ردیف می‌نویسد. ردیف‌ها بعد از <b>۳۰ روز</b> پاک می‌شوند و
          پاک‌کردن دستی‌شان از این صفحه ممکن نیست.
        </p>

        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            setPage(1);
            void load(1, q.trim(), trace);
          }}
        >
          <div className="grow">
            <label className="form-label" htmlFor="event-q">
              جست‌وجو
            </label>
            <input
              id="event-q"
              className="form-control ltr"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="شمارهٔ سفارش، نام رویداد، یا جمله‌ای از متن خطا"
            />
          </div>
          <div>
            <label className="form-label" htmlFor="event-window">
              بازه
            </label>
            <select
              id="event-window"
              className="form-control"
              value={window_}
              onChange={(e) => {
                setWindow(e.target.value);
                setPage(1);
              }}
            >
              {WINDOWS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="event-level">
              سطح
            </label>
            <select
              id="event-level"
              className="form-control"
              value={level}
              onChange={(e) => {
                setLevel(e.target.value);
                setPage(1);
              }}
            >
              <option value="">همه</option>
              {LEVELS.map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="event-svc">
              سرویس
            </label>
            <select
              id="event-svc"
              className="form-control"
              value={svc}
              onChange={(e) => {
                setSvc(e.target.value);
                setPage(1);
              }}
            >
              <option value="">همه</option>
              {services.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary" disabled={loading}>
            جست‌وجو
          </button>
        </form>

        {trace !== '' && (
          <div className="alert alert-info">
            فقط رویدادهای ردیابی <span className="ltr">{trace}</span> —{' '}
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setTrace('');
                setPage(1);
              }}
            >
              برداشتن این فیلتر
            </button>
          </div>
        )}

        {err && <div className="alert alert-error">{err}</div>}

        <div className="toolbar">
          <CopyButton
            rows={rows}
            label={`کپی ${count(rows.length)} ردیف این صفحه`}
            title="همهٔ ردیف‌های همین صفحه را به‌صورت JSON کپی می‌کند"
            small={false}
          />
        </div>

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>زمان</th>
                <th>سطح</th>
                <th>سرویس</th>
                <th>رویداد</th>
                <th>مورد</th>
                <th>ردیابی</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && !loading && (
                <tr>
                  <td className="empty" colSpan={7}>
                    در این بازه چیزی ثبت نشده — که خبر خوبی است.
                  </td>
                </tr>
              )}
              {/*
                One fragment per event, holding the row and — when it is open —
                its detail row directly underneath. Two separate `map`s is what
                this was, and it put every open detail at the bottom of the
                table instead of under the row it belongs to: readable enough
                with one row open and nonsense with two.
              */}
              {rows.map((e) => (
                <Fragment key={e.id}>
                <tr>
                  <td className="ltr">{dateTimeSeconds(e.at)}</td>
                  <td>
                    <span className={levelTone(e.level)}>{LEVEL_FA[e.level] ?? e.level}</span>
                  </td>
                  <td className="ltr">{e.svc}</td>
                  <td className="ltr">{e.evt}</td>
                  <td className="ltr">{e.ref ?? '—'}</td>
                  <td className="ltr">
                    {e.trace ? (
                      <button
                        type="button"
                        className="btn btn-sm"
                        title="همهٔ رویدادهای همین درخواست"
                        onClick={() => {
                          setTrace(e.trace!);
                          setPage(1);
                        }}
                      >
                        {e.trace}
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="row-actions">
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => setOpen(open === e.id ? null : e.id)}
                    >
                      {open === e.id ? 'بستن' : 'جزئیات'}
                    </button>
                    <CopyButton
                      rows={[e]}
                      label="کپی"
                      title="این رویداد را با همهٔ جزئیاتش به‌صورت JSON کپی می‌کند"
                    />
                  </td>
                </tr>
                {open === e.id && (
                  <tr>
                    <td colSpan={7}>
                      <div className="event-detail">
                        <div>
                          <div className="form-label">fields</div>
                          <pre className="ltr event-pre">{JSON.stringify(e.fields, null, 2)}</pre>
                        </div>
                        {e.err && (
                          <div>
                            <div className="form-label">err</div>
                            <ErrorBlock raw={e.err} />
                          </div>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
                </Fragment>
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
