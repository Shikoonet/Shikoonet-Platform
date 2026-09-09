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
import { CustomerLink } from '../CustomerLink.js';
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
  // `editing`, `draft`, `busy` and `save` went with the edit panel this form
  // replaced: every live setting is a control that is already on screen, and
  // each one saves itself.
  /**
   * Which half of the screen is on: the shop's own settings, or what the
   * import left behind.
   *
   * Two tabs rather than one filtered list, because they are not two views of
   * the same thing — one is a form the shop honours and the other is a record
   * of what a MySQL dump contained. Mixing them is how a change to
   * `Lottery_Status` came to save, show no error, and do nothing for ever.
   */
  const [tab, setTab] = useState<'live' | 'imported'>('live');

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

  /*
   * Split once, here, rather than filtered at each of the two render sites —
   * the counts on the tabs and the rows under them have to be the same set.
   *
   * A gateway credential counts as the shop's own even though it is not in the
   * registry: «آیا مرچنت زرین‌پال ثبت شده؟» is a question an operator asks, and
   * the answer belongs beside the other settings rather than filed under «what
   * the import left». It renders as «ثبت شده / ندارد» and nothing more — the
   * server never sends the value and refuses a write either way.
   */
  const live = rows.filter((r) => r.live || r.secret);
  const imported = rows.filter((r) => !r.live && !r.secret);

  /**
   * One field, saved on its own, with the value the control holds.
   *
   * No «ذخیره» for the whole form: forty controls behind one button means an
   * operator who changed one thing cannot tell what else went with it, and the
   * server writes one key per request anyway.
   */
  async function saveValue(r: SettingRow, value: string) {
    setErr(null);
    setDone(null);
    try {
      await api.updateSetting({ scope: r.scope, key: r.key, value });
      setDone(`«${r.label ?? r.key}» ذخیره شد.`);
      await load();
    } catch (e) {
      setErr(message(e));
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

        {/* Two tabs, not one filtered list. They are not two views of one
            thing: the first is a form the shop honours, the second a record of
            what a MySQL dump contained. Mixing them is how a change to
            `Lottery_Status` came to save, show no error, and do nothing. */}
        <div className="toolbar" role="tablist" aria-label="بخش‌های تنظیمات">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'live'}
            className={tab === 'live' ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
            onClick={() => setTab('live')}
          >
            تنظیمات فروشگاه ({count(live.length)})
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'imported'}
            className={tab === 'imported' ? 'btn btn-sm btn-primary' : 'btn btn-sm'}
            onClick={() => setTab('imported')}
          >
            وارداتی ({count(imported.length)})
          </button>
        </div>

        {tab === 'live' ? (
          <div className="settings-form">
            {live.length === 0 && <p className="muted">چیزی با این جست‌وجو پیدا نشد.</p>}
            {live.map((r) => (
              <SettingField key={`${r.scope}/${r.key}`} row={r} onSave={saveValue} write={w} />
            ))}
          </div>
        ) : (
          <>
            <p className="muted">
              این کلیدها از ربات قدیمی وارد شده‌اند و هیچ‌کدام خوانده نمی‌شوند. اینجا هستند تا معلوم
              باشد دامپ چه داشته؛ تغییرشان چیزی را عوض نمی‌کند و سرور هم نمی‌پذیرد.
            </p>
            <div className="table-wrap">
              <table className="app-table">
                <thead>
                  <tr>
                    <th>دسته</th>
                    <th>کلید</th>
                    <th>مقدار</th>
                  </tr>
                </thead>
                <tbody>
                  {imported.length === 0 && (
                    <tr>
                      <td className="empty" colSpan={3}>
                        چیزی وارد نشده است.
                      </td>
                    </tr>
                  )}
                  {imported.map((r) => (
                    <tr key={`${r.scope}/${r.key}`}>
                      <td>{SCOPE_FA[r.scope] ?? r.scope}</td>
                      <td className="ltr">{r.key}</td>
                      {/* Read-only: no control at all, not a disabled one. A
                          greyed-out field still reads as «you may change this,
                          later». */}
                      <td className="ltr">{r.secret ? '—' : String(r.value ?? '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </>
  );
}

/**
 * Twenty-five, the same as every other list.
 *
 * This screen drew all of them: 171 rows on staging on 2026-09-07, an eighteen
 * thousand pixel page, and every row carrying its own «تایید» and «رد».
 */
const REQUEST_PAGE_SIZE = 25;

export function RequestsPage() {
  const [rows, setRows] = useState<ResellerRequestRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [tiers, setTiers] = useState<ResellerTierRow[]>([]);
  const [status, setStatus] = useState('PENDING');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** The level each pending row would be approved onto. Keyed by request id. */
  const [pickedTier, setPickedTier] = useState<Record<number, 'n' | 'n2'>>({});
  /**
   * The rows ticked for a decision taken all at once.
   *
   * A Set of request ids rather than of customers: two rows can belong to one
   * person, and «this row» is what the screen offers. Cleared on every reload,
   * because a tick that survives a filter change points at a row that is no
   * longer on screen.
   */
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [tierDraft, setTierDraft] = useState<Record<string, string>>({});

  async function load(p = page) {
    setErr(null);
    try {
      const [requests, levels] = await Promise.all([
        api.resellerRequests({ ...(status ? { status } : {}), page: p, pageSize: REQUEST_PAGE_SIZE }),
        api.resellerTiers(),
      ]);
      setRows(requests.items);
      setTotal(requests.total);
      setPicked(new Set());
      setTiers(levels.items);
      setTierDraft(Object.fromEntries(levels.items.map((t) => [t.code, String(t.percent)])));
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load(page);
  }, [status, page]);

  // A decision removes the row from the PENDING filter, so the page it was on
  // can empty under the operator. Stepping back is the only sane answer — a
  // pager that offers page four of three is how a queue looks finished when it
  // is not.
  const lastPage = Math.max(1, Math.ceil(total / REQUEST_PAGE_SIZE));
  useEffect(() => {
    if (page > lastPage) setPage(lastPage);
  }, [page, lastPage]);

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

  /**
   * The same decision, for everything ticked.
   *
   * Confirms with the COUNT first, because this is the widest single act on
   * the screen: 171 requests were open on staging, and «تایید همه» without a
   * number in front of it is a button nobody can check before pressing.
   */
  async function decideSelection(next: 'APPROVED' | 'REJECTED') {
    const ids = rows.filter((r) => picked.has(r.id)).map((r) => r.id);
    if (ids.length === 0) return;
    const word = next === 'APPROVED' ? 'تایید' : 'رد';
    if (!window.confirm(`${count(ids.length)} درخواست ${word} شود؟`)) return;

    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const res = await api.decideResellerRequests(ids, next, next === 'APPROVED' ? 'n' : null);
      const ok = res.results.filter((r) => r.ok).length;
      const refused = res.results.length - ok;
      // Reported rather than swallowed: a row already decided on somebody
      // else's screen is not a failure of this press, and it is not a success
      // either.
      setDone(
        refused === 0
          ? `${count(ok)} درخواست ${word} شد.`
          : `${count(ok)} درخواست ${word} شد؛ ${count(refused)} تا قبلاً تصمیم‌گیری شده بود.`,
      );
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
          <div className="page-head__sub">{count(total)} درخواست نمایندگی</div>
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

        {picked.size > 0 && (
          /* Only while something is ticked. A bar that is always there, greyed
             out, is a bar an operator learns to read past — and the two
             buttons on it are the widest acts this screen can take. */
          <div className="toolbar" role="status">
            <span>{count(picked.size)} انتخاب‌شده</span>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={busy}
              onClick={() => void decideSelection('APPROVED')}
            >
              تایید انتخاب‌شده‌ها
            </button>
            <button
              type="button"
              className="btn btn-sm"
              disabled={busy}
              onClick={() => void decideSelection('REJECTED')}
            >
              رد انتخاب‌شده‌ها
            </button>
          </div>
        )}

        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox"
                    aria-label="انتخاب همه"
                    checked={rows.length > 0 && picked.size === rows.length}
                    onChange={(e) =>
                      setPicked(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())
                    }
                  />
                </th>
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
                  <td className="empty" colSpan={6}>
                    درخواستی در این وضعیت نیست.
                  </td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`انتخاب ${r.description ?? r.customer.telegramId}`}
                      checked={picked.has(r.id)}
                      onChange={(e) =>
                        setPicked((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(r.id);
                          else next.delete(r.id);
                          return next;
                        })
                      }
                    />
                  </td>
                  <td>
                    <CustomerLink customer={r.customer} />
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

        <div className="pager">
          <button
            type="button"
            className="btn btn-sm"
            disabled={page <= 1}
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
            disabled={page >= lastPage}
            onClick={() => setPage(page + 1)}
          >
            بعدی
          </button>
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

/**
 * One setting, as the control its VALUE actually is.
 *
 * The screen asked for everything as a free-text box, so «ربات روشن است» was a
 * field an operator typed `on` into — and typing `ON`, or `1`, or `روشن` saved
 * happily and switched nothing off. The kind comes from the registry in
 * `@shikoo/contracts`, which is also what the bot reads, so the control and
 * the reader cannot disagree about what a value looks like.
 *
 * Saved per field, on change for a switch and on blur for everything else. No
 * «ذخیره» for the whole form: forty controls behind one button means an
 * operator who changed one thing cannot tell what else went with it.
 */
function SettingField({
  row,
  onSave,
  write,
}: {
  row: SettingRow;
  onSave: (row: SettingRow, value: string) => Promise<void>;
  write: ReturnType<typeof useAdminWriteProps>;
}) {
  const id = `set-${row.scope}-${row.key}`;
  const raw = row.value === null || row.value === undefined ? '' : String(row.value);
  const [draft, setDraft] = useState(raw);

  // Re-seeded when the row is reloaded, so a save that the server normalised
  // shows what the server kept rather than what was typed.
  useEffect(() => setDraft(raw), [raw]);

  if (row.secret) {
    return (
      <div className="settings-field">
        <span className="settings-field__label">{row.label ?? row.key}</span>
        <span className="muted">{row.isSet ? 'ثبت شده' : 'ندارد'}</span>
        <p className="settings-field__hint">
          اعتبارنامهٔ درگاه است؛ مقدارش نه نشان داده می‌شود نه از اینجا عوض.
        </p>
      </div>
    );
  }

  if (row.kind === 'bool' && row.truth) {
    /*
     * The words come from the row, not from this file.
     *
     * The comment that used to sit here said which string a key uses «is
     * whatever the PHP wrote rather than a convention», and then wrote a single
     * `SETTING_ON = 'on'` for all seventeen switches. `'off'` is not
     * `botstatusoff`, so closing the shop from this screen left it open.
     *
     * A value matching neither is the ordinary case, not the corner one: these
     * rows were written by an old PHP panel and most have never been through
     * this form. `unknown` says which way each key's reader falls, so the
     * switch is drawn where the BOT thinks it is.
     */
    const { truth } = row;
    const on = raw === truth.on ? true : raw === truth.off ? false : truth.unknown === 'on';
    return (
      <div className="settings-field settings-field--switch">
        <input
          id={id}
          type="checkbox"
          checked={on}
          {...write}
          onChange={() => void onSave(row, on ? truth.off : truth.on)}
        />
        <label className="settings-field__label" htmlFor={id}>
          {row.label ?? row.key}
        </label>
        <p className="settings-field__hint">{row.hint}</p>
      </div>
    );
  }

  const numeric = row.kind === 'int' || row.kind === 'irr' || row.kind === 'chatId';
  return (
    <div className="settings-field">
      <label className="settings-field__label" htmlFor={id}>
        {row.label ?? row.key}
      </label>
      <input
        id={id}
        className="form-control ltr"
        type={numeric ? 'number' : 'text'}
        value={draft}
        {...write}
        onChange={(e) => setDraft(e.target.value)}
        // On blur, not on every keystroke: a request per character against a
        // shop's live settings is a shop being reconfigured forty times while
        // somebody types a number.
        onBlur={() => {
          if (draft !== raw) void onSave(row, draft);
        }}
      />
      <p className="settings-field__hint">{row.hint}</p>
      {/* The one setting whose value has a GRAMMAR, so it carries its own help
          beside the field. It used to live inside the edit panel this form
          replaced; without it an operator has to know `{duration}` exists
          before they can type it, which is the same as the feature not being
          there. */}
      {row.scope === PLAN_LABEL_SETTING.scope && row.key === PLAN_LABEL_SETTING.key && (
        <PlanLabelHelp draft={draft} onPick={setDraft} />
      )}
    </div>
  );
}
