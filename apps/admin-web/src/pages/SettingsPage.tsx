/**
 * تنظیمات and لیست درخواست‌ها.
 *
 * The settings screen deliberately shows fewer values than the table holds.
 * `PaySetting` carried live gateway API keys and merchant ids into `settings`
 * in plaintext, so the server reports those keys as configured or not and never
 * sends the value; this page cannot render what it does not receive, and says
 * out loud how many it is withholding rather than leaving a silent gap.
 *
 * Only keys that already exist can be edited. The bot reads a fixed set, so a
 * key invented here would be a row nothing ever reads — a setting that appears
 * to work and does not.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type ResellerRequestRow, type SettingRow } from '../api.js';
import { count, dateTime } from '../format.js';
import { useAdminWriteProps } from '../role.js';

const SCOPE_FA: Record<string, string> = {
  bot: 'ربات',
  shop: 'فروشگاه',
  pay: 'پرداخت',
  panel: 'پنل',
};

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'secret_key') return 'این کلید یک اعتبارنامه است و از این‌جا تغییر نمی‌کند.';
    if (e.code === 'unknown_setting') return 'چنین تنظیمی وجود ندارد؛ کلید تازه ساخته نمی‌شود.';
    if (e.code === 'already_decided') return 'این درخواست قبلاً تعیین تکلیف شده است.';
    if (e.code === 'admin_access_not_configured') return 'درِ دسترسی ادمین تنظیم نشده است.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

export function SettingsPage() {
  const w = useAdminWriteProps();
  const [rows, setRows] = useState<SettingRow[]>([]);
  const [hidden, setHidden] = useState(0);
  const [scope, setScope] = useState('');
  const [q, setQ] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(null);
    try {
      const d = await api.settings({ ...(scope ? { scope } : {}), ...(q.trim() ? { q: q.trim() } : {}) });
      setRows(d.items);
      setHidden(d.hiddenCount);
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load();
  }, [scope]);

  async function save(r: SettingRow) {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.updateSetting({ scope: r.scope, key: r.key, value: draft });
      setDone(`«${r.key}» ذخیره شد.`);
      setEditing(null);
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">تنظیمات</div>
          <div className="page-head__sub">{count(rows.length)} کلید</div>
        </div>
      </div>

      <div className="card">
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <div className="grow">
            <label className="form-label" htmlFor="set-q">
              جست‌وجو
            </label>
            <input
              id="set-q"
              className="form-control ltr"
              type="search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="بخشی از نام کلید"
            />
          </div>
          <div>
            <label className="form-label" htmlFor="set-scope">
              دسته
            </label>
            <select
              id="set-scope"
              className="form-control"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="">همه</option>
              {Object.entries(SCOPE_FA).map(([v, label]) => (
                <option key={v} value={v}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary">
            جست‌وجو
          </button>
        </form>

        {err && <div className="alert alert-error">{err}</div>}
        {done && <div className="alert alert-info">{done}</div>}
        {hidden > 0 && (
          <div className="alert alert-info">
            مقدار {count(hidden)} کلید نمایش داده نمی‌شود چون اعتبارنامهٔ درگاه پرداخت است. فقط
            «ثبت شده / ندارد» را می‌بینید و از این‌جا هم تغییر نمی‌کنند.
          </div>
        )}

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>دسته</th>
                <th>کلید</th>
                <th>مقدار</th>
                <th>آخرین تغییر</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td className="empty" colSpan={5}>
                    تنظیمی با این جست‌وجو پیدا نشد.
                  </td>
                </tr>
              )}
              {rows.map((r) => {
                const id = `${r.scope}:${r.key}`;
                return (
                  <tr key={id}>
                    <td>{SCOPE_FA[r.scope] ?? r.scope}</td>
                    <td className="ltr">{r.key}</td>
                    <td>
                      {r.secret ? (
                        <span className={r.isSet ? 'badge badge-active' : 'badge badge-block'}>
                          {r.isSet ? 'ثبت شده' : 'ندارد'}
                        </span>
                      ) : editing === id ? (
                        <input
                          className="form-control ltr"
                          type="text"
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                        />
                      ) : (
                        <span className="ltr">{String(r.value ?? '—')}</span>
                      )}
                    </td>
                    <td>
                      {r.updatedBy ? (
                        <>
                          <div className="ltr">{r.updatedBy}</div>
                          <div className="page-head__sub">{dateTime(r.updatedAt)}</div>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>
                      {r.secret ? (
                        <span className="muted">قفل</span>
                      ) : editing === id ? (
                        <>
                          <button
                            type="button"
                            className="btn btn-sm btn-primary"
                            disabled={busy}
                            onClick={() => void save(r)}
                            {...w}
                          >
                            ذخیره
                          </button>{' '}
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setEditing(null)}
                          >
                            انصراف
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => {
                            setEditing(id);
                            setDraft(String(r.value ?? ''));
                          }}
                        >
                          ویرایش
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
    </>
  );
}

export function RequestsPage() {
  const [rows, setRows] = useState<ResellerRequestRow[]>([]);
  const [status, setStatus] = useState('PENDING');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(null);
    try {
      setRows((await api.resellerRequests(status || undefined)).items);
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load();
  }, [status]);

  async function decide(r: ResellerRequestRow, next: 'APPROVED' | 'REJECTED') {
    if (
      next === 'APPROVED' &&
      !window.confirm(
        `${r.customer.username ? `@${r.customer.username}` : r.customer.telegramId} نماینده شود؟ قیمت‌های نمایندگی برایش باز می‌شود.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.decideResellerRequest(r.id, next);
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">لیست درخواست‌ها</div>
          <div className="page-head__sub">{count(rows.length)} درخواست نمایندگی</div>
        </div>
      </div>

      <div className="card">
        <div className="filters">
          <div>
            <label className="form-label" htmlFor="req-status">
              وضعیت
            </label>
            <select
              id="req-status"
              className="form-control"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              <option value="PENDING">در انتظار</option>
              <option value="APPROVED">تایید شده</option>
              <option value="REJECTED">رد شده</option>
              <option value="">همه</option>
            </select>
          </div>
        </div>

        {err && <div className="alert alert-error">{err}</div>}

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>کاربر</th>
                <th>توضیح</th>
                <th>زمان</th>
                <th>وضعیت</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr>
                  <td className="empty" colSpan={5}>
                    درخواستی در این وضعیت نیست.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td className="ltr">
                    {r.customer.username ? `@${r.customer.username}` : r.customer.telegramId}
                    {r.customer.isReseller && <span className="badge badge-info">نماینده</span>}
                  </td>
                  <td>{r.description ?? '—'}</td>
                  <td>{dateTime(r.createdAt)}</td>
                  <td>
                    <span
                      className={
                        r.status === 'APPROVED'
                          ? 'badge badge-active'
                          : r.status === 'REJECTED'
                            ? 'badge badge-block'
                            : 'badge badge-info'
                      }
                    >
                      {r.status === 'APPROVED'
                        ? 'تایید شده'
                        : r.status === 'REJECTED'
                          ? 'رد شده'
                          : 'در انتظار'}
                    </span>
                  </td>
                  <td>
                    {/* Decided once: the buttons disappear afterwards, and the
                        server refuses a second decision from a stale screen. */}
                    {r.status === 'PENDING' && (
                      <>
                        <button
                          type="button"
                          className="btn btn-sm btn-primary"
                          disabled={busy}
                          onClick={() => void decide(r, 'APPROVED')}
                        >
                          تایید
                        </button>{' '}
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          disabled={busy}
                          onClick={() => void decide(r, 'REJECTED')}
                        >
                          رد
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}
