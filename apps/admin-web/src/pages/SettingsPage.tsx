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
import {
  api,
  ApiError,
  type ResellerRequestRow,
  type ResellerTierRow,
  type SettingRow,
} from '../api.js';
import {
  checkPlanLabel,
  PLAN_LABEL_PRESETS,
  PLAN_LABEL_SETTING,
  PLAN_LABEL_TOKENS,
  renderPlanLabel,
} from '@shikoo/contracts';
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
      const d = await api.settings({
        ...(scope ? { scope } : {}),
        ...(q.trim() ? { q: q.trim() } : {}),
      });
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
            مقدار {count(hidden)} کلید نمایش داده نمی‌شود چون اعتبارنامهٔ درگاه پرداخت است. فقط «ثبت
            شده / ندارد» را می‌بینید و از این‌جا هم تغییر نمی‌کنند.
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
                        <>
                          <input
                            className="form-control ltr"
                            type="text"
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                          />
                          {r.key === PLAN_LABEL_SETTING.key && (
                            <PlanLabelHelp draft={draft} onPick={setDraft} />
                          )}
                        </>
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
  const [tiers, setTiers] = useState<ResellerTierRow[]>([]);
  const [status, setStatus] = useState('PENDING');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The level each pending row would be approved onto. Keyed by request id. */
  const [pickedTier, setPickedTier] = useState<Record<number, 'n' | 'n2'>>({});
  const [tierDraft, setTierDraft] = useState<Record<string, string>>({});

  async function load() {
    setErr(null);
    try {
      const [requests, levels] = await Promise.all([
        api.resellerRequests(status || undefined),
        api.resellerTiers(),
      ]);
      setRows(requests.items);
      setTiers(levels.items);
      setTierDraft(Object.fromEntries(levels.items.map((t) => [t.code, String(t.percent)])));
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load();
  }, [status]);

  async function saveTier(t: ResellerTierRow) {
    const raw = (tierDraft[t.code] ?? '').trim();
    if (!/^[0-9]+$/.test(raw) || Number(raw) > 100) return;
    const percent = Number(raw);
    if (percent === t.percent) return;
    // Every member at once. That is the point of a level, and it is also why
    // this asks: it is the widest price change the panel can make.
    if (
      !window.confirm(
        `تخفیف «${t.name}» از ${count(t.percent)}٪ به ${count(percent)}٪ برسد؟ ` +
          `قیمت ${count(t.members)} نماینده در همین لحظه عوض می‌شود.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      await api.saveResellerTier(t.code, { percent });
      setDone(`تخفیف «${t.name}» روی ${count(percent)}٪ ذخیره شد.`);
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function decide(r: ResellerRequestRow, next: 'APPROVED' | 'REJECTED') {
    const tier = pickedTier[r.id] ?? 'n';
    const level = tiers.find((t) => t.code === tier);
    if (
      next === 'APPROVED' &&
      !window.confirm(
        `${r.customer.username ? `@${r.customer.username}` : r.customer.telegramId} ` +
          `«${level?.name ?? 'نماینده'}» شود؟ ` +
          `قیمت‌های نمایندگی برایش باز می‌شود و ${count(level?.percent ?? 0)}٪ از هر سفارش کم می‌شود.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.decideResellerRequest(r.id, next, next === 'APPROVED' ? tier : null);
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

      {/* Above the requests, because it is the question the requests screen
          asks: approving somebody puts them on one of these, and the number
          here is what they will pay from that moment. */}
      <div className="card">
        <h4 style={{ marginBlockStart: 0 }}>سطح‌های نمایندگی</h4>
        <p className="muted" style={{ marginBlockStart: 0 }}>
          درصد هر سطح از <strong>هر سفارش</strong> اعضای آن سطح کم می‌شود، و تغییرش قیمت همهٔ آن‌ها
          را در همان لحظه عوض می‌کند. تخفیف شخصی یک کاربر تا وقتی نماینده است اعمال نمی‌شود.
        </p>
        {done && <div className="alert alert-info">{done}</div>}
        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>سطح</th>
                <th>درصد تخفیف</th>
                <th>تعداد</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tiers.map((t) => (
                <tr key={t.code}>
                  <td>{t.name}</td>
                  <td>
                    <input
                      className="form-control form-control-sm ltr"
                      type="number"
                      min={0}
                      max={100}
                      aria-label={`درصد تخفیف ${t.name}`}
                      value={tierDraft[t.code] ?? ''}
                      onChange={(e) =>
                        setTierDraft((prev) => ({ ...prev, [t.code]: e.target.value }))
                      }
                    />
                  </td>
                  {/* A reseller with no level set is counted here as «نماینده»,
                      the same way the bot prices them. */}
                  <td>{count(t.members)} نماینده</td>
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={busy}
                      onClick={() => void saveTier(t)}
                    >
                      ذخیره
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
                        {/* Chosen before «تایید», not after: approving is what
                            writes the level, and there is no second screen to
                            correct it on. */}
                        <select
                          className="form-control form-control-sm"
                          aria-label={`سطح نمایندگی برای درخواست ${r.id}`}
                          value={pickedTier[r.id] ?? 'n'}
                          disabled={busy}
                          onChange={(e) =>
                            setPickedTier((prev) => ({
                              ...prev,
                              [r.id]: e.target.value as 'n' | 'n2',
                            }))
                          }
                        >
                          {tiers.map((t) => (
                            <option key={t.code} value={t.code}>
                              {t.name} — {count(t.percent)}٪
                            </option>
                          ))}
                        </select>{' '}
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

/**
 * The one setting on this screen whose value has a grammar.
 *
 * This page is a generic key/value table and has nowhere to document one, so
 * the help arrives beside the field it belongs to and nowhere else. Without it
 * an operator has to know that `{duration}` exists before they can type it,
 * which is the same as the feature not being there.
 *
 * The preview uses sample values rather than a real plan on purpose: the point
 * is the SHAPE of the label, and a preview that quietly picked the first plan
 * in the shop would change meaning depending on which plan that happened to be.
 */
function PlanLabelHelp({
  draft,
  onPick,
}: {
  draft: string;
  onPick: (next: string) => void;
}) {
  const problem = draft.trim() === '' ? null : checkPlanLabel(draft);
  const sample = {
    name: '۱ ماهه · نامحدود',
    badge: '⭐ ویژه',
    duration: '1 ماهه',
    volume: '100 گیگ',
    users: 'چند کاربره',
    price: '350,000 تومان',
  };

  return (
    <div style={{ marginBlockStart: 6 }}>
      <div className="page-head__sub">
        خالی یعنی همان چیزی که همیشه بوده. فیلدها:
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBlockStart: 4 }}>
        {Object.entries(PLAN_LABEL_TOKENS).map(([token, hint]) => (
          <button
            key={token}
            type="button"
            className="btn btn-sm ltr"
            title={hint}
            onClick={() => onPick(`${draft}{${token}}`)}
          >
            {`{${token}}`}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBlockStart: 4 }}>
        {PLAN_LABEL_PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            className="btn btn-sm ltr"
            title="این قالب را بگذار"
            onClick={() => onPick(preset)}
          >
            {renderPlanLabel(preset, sample)}
          </button>
        ))}
      </div>
      {problem ? (
        <div className="alert alert-error" style={{ marginBlockStart: 6 }}>
          {problem.message}
        </div>
      ) : (
        draft.trim() !== '' && (
          <>
            <div className="page-head__sub" style={{ marginBlockStart: 6 }}>
              در ربات: <strong>{renderPlanLabel(draft, sample)}</strong>
            </div>
            {/*
             * Said, not refused — and deliberately not routed through
             * `checkPlanLabel`.
             *
             * Dropping `{badge}` is a choice a shop is allowed to make, so the
             * server would be wrong to reject it. But it is a LOSSY choice with
             * no other symptom anywhere: the نشان an operator types on every
             * «محصولات» row simply stops being drawn, on every plan button at
             * once, and neither screen says why. Three of the four presets
             * above omit the token, so this is one click away from happening by
             * accident.
             *
             * NOT gated on «does this shop have any badges». No endpoint
             * answers that for `product_plans`, and a count-gated hint would go
             * quiet exactly when it matters — a shop with no badges today adds
             * one tomorrow from a different screen and never comes back here.
             */}
            {!draft.includes('{badge}') && (
              <div className="page-head__sub" style={{ marginBlockStart: 6 }}>
                بدون <span className="ltr">{'{badge}'}</span> نشانِ پلن‌ها روی دکمه‌ها نشان داده
                نمی‌شود.
              </div>
            )}
          </>
        )
      )}
    </div>
  );
}
