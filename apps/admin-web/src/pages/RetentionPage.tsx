/**
 * «یادآوری تمدید» — the operator's own rules for keeping a customer.
 *
 * A rule is a panel, a window of days around expiry, «only one service», a
 * discount code and a text. The bot sends it once per service per expiry;
 * the numbers under each rule are what happened next — sent, used the code,
 * stayed, left — read from the outbox and the ledger rather than kept here.
 *
 * ## One list, one save
 *
 * The rules are a single settings row and the server replaces it whole, so
 * this screen edits a draft of the list and has one «ذخیره». Saving on every
 * keystroke would write the list a hundred times while a text is typed, and
 * a rule half-typed is a rule the bot would run half-typed.
 *
 * ## The overview first, and a saved rule folded
 *
 * Sam, 2026-09-20: «یه قسمت استاتیستیکس … لایو ویو … وقتی ذخیره می‌زنم باید
 * کوچیک بشه … ۵-۶ تا قانون دارم، خیلی تمیز باشه». Four totals on top,
 * re-read every half minute; then the rules, each a `<details>` folded to ONE
 * aligned row — who it is for, how many are in its window now, and a small
 * bar of what happened to the people it reached. The full figures sit inside
 * the opened rule, above its form, so nothing is printed three times. A rule
 * just added is open, because it has nothing to summarise.
 *
 * ## The code is chosen, not typed
 *
 * The offer is a real code from «کدهای تخفیف», picked from a list, so the
 * rule cannot name one that does not exist — and the server refuses one the
 * customer could not use for a renewal.
 */

import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type RetentionCodeOption,
  type RetentionRule,
  type RetentionRuleRow,
} from '../api.js';
import { count } from '../format.js';
import { useAdminWriteProps } from '../role.js';
import type { PageId } from '../nav.js';

/** The same words as `RETENTION_DEFAULT_TEXT` in contracts — Sam's, 2026-09-20. */
const DEFAULT_TEXT =
  'سرویس «{service}» شما {days} روز دیگر تمام می‌شود.\n\nبا کد زیر می‌توانید از {discount} تخفیف برای تمدید سرویستان استفاده کنید:\n{code}\n\nبرای تمدید روی دکمهٔ «{renewButton}» بزنید.';
const DEFAULT_TEXT_AFTER =
  'سرویس «{service}» شما {days} روز پیش تمام شد.\n\nهنوز می‌توانید با کد زیر از {discount} تخفیف برای تمدید استفاده کنید:\n{code}\n\nبرای تمدید روی دکمهٔ «{renewButton}» بزنید.';

const PLACEHOLDER_HINT = 'جای‌نگهدارها: {days} روز مانده/گذشته · {service} نام سرویس · {username} نام کاربری · {code} کد تخفیف (با یک لمس کپی می‌شود) · {discount} مقدار تخفیف کد، مثلاً «۳۰٪» · {renewButton} نام دکمه — خودِ دکمهٔ سبز «تمدید سرویس» همیشه زیر پیام می‌آید';

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'invalid_rules') {
      return 'یکی از قانون‌ها ناقص است — نام، یوزرنیم پنل، متن، دست‌کم یکی از دو عدد روز، و برای قانونِ روشنی که در متنش {code} یا {discount} دارد، یک کد تخفیف.';
    }
    if (e.code === 'unknown_panel') return 'پنلی که انتخاب شده دیگر وجود ندارد.';
    if (e.code === 'unusable_code') {
      return 'کد انتخاب‌شده برای تمدید قابل استفاده نیست — غیرفعال است یا «فقط خرید اول» دارد.';
    }
    if (e.code === 'no_bot_username') {
      return 'نام کاربری ربات تنظیم نشده — در «ربات تلگرام» بگذارید تا دکمهٔ تمدید لینک داشته باشد.';
    }
    if (e.code === 'no_report_group') {
      return 'گروه گزارش‌ها تنظیم نشده — در «تنظیمات»، Channel_Report را بگذارید.';
    }
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

function actedLabel(row: RetentionRuleRow): string {
  if (!row.lastActed) return 'در ۳۰ روز گذشته چیزی نفرستاده';
  const mins = Math.floor((Date.now() - new Date(row.lastActed.at).getTime()) / 60_000);
  const when =
    mins < 1
      ? 'همین حالا'
      : mins < 60
        ? `${count(mins)} دقیقه پیش`
        : mins < 1440
          ? `${count(Math.floor(mins / 60))} ساعت پیش`
          : `${count(Math.floor(mins / 1440))} روز پیش`;
  return `آخرین بار ${when} — ${count(row.lastActed.count)} پیام`;
}

/** How often the overview re-reads itself while the screen is open. */
const LIVE_EVERY_MS = 30_000;

function newKey(): string {
  return `r_${Math.random().toString(36).slice(2, 10)}`;
}

function codeLabel(c: RetentionCodeOption): string {
  const why = c.status !== 'ACTIVE' ? 'غیرفعال' : c.expired ? 'منقضی' : c.firstPurchaseOnly ? 'فقط خرید اول' : null;
  return why ? `${c.code} (${why})` : c.code;
}

export function RetentionPage({ onGo }: { onGo?: (page: PageId) => void }) {
  const w = useAdminWriteProps();
  const [rows, setRows] = useState<RetentionRuleRow[]>([]);
  const [draft, setDraft] = useState<RetentionRule[] | null>(null);
  const [panels, setPanels] = useState<{ id: number; name: string; baseUrl: string | null }[]>([]);
  const [admins, setAdmins] = useState<{ admin: string; accounts: number }[]>([]);
  const [codes, setCodes] = useState<RetentionCodeOption[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** «الان چند نفر»، per rule key, as the operator types. */
  const [audience, setAudience] = useState<Record<string, number | 'loading' | null>>({});
  /** Which rules are unfolded for editing. A saved rule starts folded. */
  const [open, setOpen] = useState<Set<string>>(new Set());

  const asRule = ({ lastActed: _l, funnel: _f, audience: _a, ...rule }: RetentionRuleRow): RetentionRule => rule;

  /**
   * `withDraft` false re-reads the numbers only, so the live overview never
   * overwrites what the operator is typing; true is the initial read and
   * the one after a save, when the draft IS the saved list.
   */
  async function load(withDraft = true) {
    setErr(null);
    try {
      const res = await api.retention();
      setRows(res.items);
      if (withDraft) setDraft(res.items.map(asRule));
      setPanels(res.panels);
      setAdmins(res.admins);
      setCodes(res.codes);
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(false), LIVE_EVERY_MS);
    return () => clearInterval(timer);
  }, []);

  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(rows.map(asRule));

  async function save() {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    try {
      await api.updateRetentionRules(draft);
      await load();
      // Saved, so every rule folds to its line — the point of the summary.
      setOpen(new Set());
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  // Only the fields the count depends on, as one string, so retyping the
  // text does not re-ask.
  const audienceInputs = JSON.stringify(
    (draft ?? []).map((r) => [r.key, r.providerId, r.panelAdmin, r.daysBefore, r.daysAfter, r.onlyService]),
  );

  // Asked again whenever a rule's panel, window or «only one service»
  // changes, a beat after the last keystroke so «1» → «12» → «120» is one
  // request rather than three.
  useEffect(() => {
    const rows = JSON.parse(audienceInputs) as [string, number | null, string | null, number, number, boolean][];
    // A slow answer to an OLD question must not land on top of the new one:
    // once the inputs change again this effect is cleaned up, `live` goes
    // false, and whatever the earlier request returns is dropped.
    let live = true;
    const timer = setTimeout(() => {
      for (const [key, providerId, panelAdmin, daysBefore, daysAfter, onlyService] of rows) {
        if ((providerId === null && panelAdmin === null) || (daysBefore === 0 && daysAfter === 0)) {
          setAudience((a) => ({ ...a, [key]: null }));
          continue;
        }
        setAudience((a) => ({ ...a, [key]: 'loading' }));
        api
          .retentionAudience({ providerId, panelAdmin, daysBefore, daysAfter, onlyService })
          .then((res) => live && setAudience((a) => ({ ...a, [key]: res.count })))
          .catch(() => live && setAudience((a) => ({ ...a, [key]: null })));
      }
    }, 400);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [audienceInputs]);

  async function test(rule: RetentionRule) {
    setBusy(true);
    setErr(null);
    setNote(null);
    try {
      await api.testRetentionRule(rule);
      setNote(`پیام تست قانون «${rule.name || 'بی‌نام'}» به «📝 گزارش اطلاع رسانی ها» فرستاده شد.`);
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  function patch(i: number, change: Partial<RetentionRule>) {
    setDraft((d) => (d ? d.map((r, j) => (j === i ? { ...r, ...change } : r)) : d));
  }

  function add() {
    const key = newKey();
    setOpen((o) => new Set(o).add(key));
    setDraft((d) => [
      ...(d ?? []),
      {
        key,
        name: '',
        enabled: false,
        providerId: null,
        panelAdmin: admins[0]?.admin ?? null,
        daysBefore: 1,
        daysAfter: 0,
        onlyService: true,
        codeId: null,
        text: DEFAULT_TEXT,
        textAfter: DEFAULT_TEXT_AFTER,
      },
    ]);
  }

  const disabled = busy || w.disabled === true;

  const totals = rows.reduce(
    (t, r) => ({
      on: t.on + (r.enabled ? 1 : 0),
      audience: t.audience + (r.enabled ? r.audience : 0),
      queued: t.queued + r.funnel.messages.queued,
      sent: t.sent + r.funnel.messages.sent,
      dead: t.dead + r.funnel.messages.dead,
      today: t.today + r.funnel.messages.today,
    }),
    { on: 0, audience: 0, queued: 0, sent: 0, dead: 0, today: 0 },
  );

  /** «firstbuy · ۹۰ روز مانده و ۷ روز گذشته · کد OFF30» — who a rule is for, in one breath. */
  function whoAndWhen(rule: RetentionRule): string {
    const who = rule.panelAdmin ?? panels.find((p) => p.id === rule.providerId)?.name ?? '—';
    const when = [
      rule.daysBefore > 0 ? `${count(rule.daysBefore)} روز مانده` : null,
      rule.daysAfter > 0 ? `${count(rule.daysAfter)} روز گذشته` : null,
    ]
      .filter(Boolean)
      .join(' و ');
    const code = codes.find((c) => c.id === rule.codeId)?.code;
    return [who, when || 'بازه‌ای ندارد', code ? `کد ${code}` : 'بدون کد'].join(' · ');
  }

  /**
   * The folded row. Name and audience come from the DRAFT when it differs,
   * so a rule being renamed reads as renamed; everything else is what the
   * server last said.
   */
  function summaryRow(rule: RetentionRule, saved: RetentionRuleRow | undefined) {
    const live = audience[rule.key];
    const inWindow = typeof live === 'number' ? live : saved?.audience ?? 0;
    const f = saved?.funnel;
    const reached = f?.sent ?? 0;
    const pct = (n: number) => (reached === 0 ? 0 : Math.round((n / reached) * 100));
    return (
      <>
        <span className="retention-row__name">{rule.name || 'قانون بی‌نام'}</span>
        <span className={rule.enabled ? 'badge badge-active' : 'badge'}>{rule.enabled ? 'روشن' : 'خاموش'}</span>
        <span className="retention-row__who">{whoAndWhen(rule)}</span>
        <span className="retention-row__now">
          <strong>{count(inWindow)}</strong> در بازه
        </span>
        {f && reached > 0 ? (
          <span className="retention-row__outcome" title={`ماندند ${count(f.stayed)} · رفتند ${count(f.left)} · هنوز ${count(f.pending)}`}>
            <span className="retention-bar" aria-hidden="true">
              <i className="retention-bar__stayed" style={{ inlineSize: `${pct(f.stayed)}%` }} />
              <i className="retention-bar__left" style={{ inlineSize: `${pct(f.left)}%` }} />
            </span>
            کد زدند {count(f.usedCode)} از {count(reached)}
          </span>
        ) : (
          <span className="retention-row__outcome page-head__sub">{saved ? 'هنوز به کسی نرسیده' : 'هنوز ذخیره نشده'}</span>
        )}
        {f && f.messages.dead > 0 && (
          <span className="badge badge-block" title="بلاک کرده یا اکانتش حذف شده">
            {count(f.messages.dead)} نرسیده
          </span>
        )}
      </>
    );
  }

  /** Every figure of a saved rule, inside the opened card, above its form. */
  function figures(saved: RetentionRuleRow) {
    const f = saved.funnel;
    const cells: [string, string][] = [
      ['در صف', count(f.messages.queued)],
      ['امروز', count(f.messages.today)],
      ['پیام رسیده', count(f.messages.sent)],
      ['نرسیده', count(f.messages.dead)],
      ['نفر', count(f.sent)],
      ['کد زدند', count(f.usedCode)],
      ['نزدند', count(f.sent - f.usedCode)],
      ['بیرون از فهرست', count(f.usedOutside)],
      ['ماندند', count(f.stayed)],
      ['رفتند', count(f.left)],
      ['هنوز', count(f.pending)],
    ];
    return (
      <dl className="retention-figures" data-testid={`retention-figures-${saved.key}`}>
        {cells.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
        <div className="retention-figures__acted">
          <dt>آخرین ارسال</dt>
          <dd>{actedLabel(saved)}</dd>
        </div>
      </dl>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-head__title">یادآوری تمدید</h2>
          <div className="page-head__sub">
            پیام خودتان به مشتری‌هایی که یک ادمین مشخصِ پنل ساخته، چند روز مانده به انقضا یا بعد از آن — با یک کد تخفیف که
            روی «کدهای تخفیف» ساخته‌اید. هر سرویس تا وقتی داخل بازه است روزی یک پیام می‌گیرد؛ از بازه
            که بیرون رفت یا تمدید کرد، تمام. گزارش هر ارسال در «📝 گزارش اطلاع رسانی ها» و جمع‌بندی
            هر قانون در گزارش شبانه می‌آید.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn" onClick={add} disabled={disabled} title={w.title}>
            + افزودن قانون
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => void save()}
            disabled={disabled || !dirty}
            title={w.title}
          >
            ذخیره
          </button>
        </div>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {note && <div className="alert alert-info">{note}</div>}

      {rows.length > 0 && (
        <section className="card" data-testid="retention-stats">
          <div className="card__head">
            <span className="card__title">آمار — زنده، هر ۳۰ ثانیه</span>
            <span className="page-head__sub">
              {count(rows.length)} قانون · {count(totals.on)} روشن
            </span>
          </div>
          <div className="stats-grid retention-tiles">
            <div className="stat-card tone-blue">
              <div>
                <div className="stat-card__value">{count(totals.audience)}</div>
                <div className="stat-card__label">نفر الان در بازهٔ قانون‌های روشن</div>
              </div>
            </div>
            <div className="stat-card tone-orange">
              <div>
                <div className="stat-card__value">{count(totals.queued)}</div>
                <div className="stat-card__label">پیام در صف ارسال</div>
              </div>
            </div>
            <div className="stat-card tone-green">
              <div>
                <div className="stat-card__value">{count(totals.today)}</div>
                <div className="stat-card__label">پیام امروز · {count(totals.sent)} از اول</div>
              </div>
            </div>
            <div className="stat-card tone-danger">
              <div>
                <div className="stat-card__value">{count(totals.dead)}</div>
                <div className="stat-card__label">پیام نرسیده — بلاک یا حذف‌شده</div>
              </div>
            </div>
          </div>
        </section>
      )}

      <section className="cron-list">
        {(draft ?? []).length === 0 && (
          <div className="card page-head__sub">هنوز قانونی ندارید. با «افزودن قانون» شروع کنید.</div>
        )}
        {(draft ?? []).map((rule, i) => {
          const saved = rows.find((r) => r.key === rule.key);
          const isOpen = !saved || open.has(rule.key);
          return (
            <details
              className="card cron-card"
              key={rule.key}
              data-testid={`retention-rule-${rule.key}`}
              open={isOpen}
              onToggle={(e) => {
                const now = (e.currentTarget as HTMLDetailsElement).open;
                setOpen((o) => {
                  const next = new Set(o);
                  if (now) next.add(rule.key);
                  else next.delete(rule.key);
                  return next;
                });
              }}
            >
              <summary className="retention-row" data-testid={`retention-summary-${rule.key}`}>
                {summaryRow(rule, saved)}
              </summary>
              {saved && figures(saved)}
              <div className="cron-card-head">
                <input
                  className="form-control"
                  placeholder="نام قانون — مثلاً «خرید اولی‌ها، یک روز مانده»"
                  maxLength={60}
                  value={rule.name}
                  disabled={disabled}
                  onChange={(e) => patch(i, { name: e.target.value })}
                />
                <label className="cron-switch" title={w.title}>
                  <input
                    type="checkbox"
                    aria-label={`${rule.name || 'قانون'} — روشن/خاموش`}
                    checked={rule.enabled}
                    disabled={disabled}
                    onChange={(e) => patch(i, { enabled: e.target.checked })}
                  />
                  <span>{rule.enabled ? 'روشن' : 'خاموش'}</span>
                </label>
              </div>

              <div className="cron-number">
                <label htmlFor={`ret-admin-${rule.key}`}>یوزرنیم پنل (ادمینی که اکانت را ساخته)</label>
                <select
                  id={`ret-admin-${rule.key}`}
                  className="form-control"
                  value={rule.panelAdmin ?? ''}
                  disabled={disabled}
                  // Picking an admin retires the provider row: the two are
                  // different lines through the same customers and a rule
                  // should draw one.
                  onChange={(e) =>
                    patch(i, { panelAdmin: e.target.value === '' ? null : e.target.value, providerId: null })
                  }
                >
                  <option value="">— انتخاب کنید —</option>
                  {admins.map((a) => (
                    <option key={a.admin} value={a.admin}>
                      {a.admin} — {count(a.accounts)} اکانت فعال
                    </option>
                  ))}
                </select>
                {admins.length === 0 && (
                  <span className="page-head__sub">
                    هنوز هیچ ادمینی از پنل خوانده نشده — بعد از اولین همگام‌سازی ربات با پنل پر می‌شود.
                  </span>
                )}
              </div>
              {rule.providerId !== null && rule.panelAdmin === null && (
                <p className="cron-note page-head__sub">
                  این قانون هنوز روی پنل «{panels.find((p) => p.id === rule.providerId)?.name ?? rule.providerId}»
                  است، از قبل از این‌که مخاطب با یوزرنیم پنل انتخاب شود. همچنان کار می‌کند؛ با انتخاب یک
                  یوزرنیم از بالا به شکل تازه درمی‌آید.
                </p>
              )}

              <div className="cron-number">
                <label htmlFor={`ret-before-${rule.key}`}>چند روز مانده به انقضا</label>
                <input
                  id={`ret-before-${rule.key}`}
                  type="number"
                  min={0}
                  max={365}
                  value={rule.daysBefore}
                  disabled={disabled}
                  onChange={(e) => patch(i, { daysBefore: Number(e.target.value) })}
                />
                <span className="page-head__sub">روز</span>
                <label htmlFor={`ret-after-${rule.key}`}>و چند روز بعد از انقضا</label>
                <input
                  id={`ret-after-${rule.key}`}
                  type="number"
                  min={0}
                  max={90}
                  value={rule.daysAfter}
                  disabled={disabled}
                  onChange={(e) => patch(i, { daysAfter: Number(e.target.value) })}
                />
                <span className="page-head__sub">روز (۰ = هیچ‌کدام)</span>
              </div>
              <p className="cron-note page-head__sub" data-testid={`retention-audience-${rule.key}`}>
                {audience[rule.key] === 'loading'
                  ? 'در حال شمردن…'
                  : audience[rule.key] === null || audience[rule.key] === undefined
                    ? 'دست‌کم یکی از دو عدد باید بزرگ‌تر از صفر باشد.'
                    : `الان ${count(audience[rule.key] as number)} نفر در این بازه‌اند — هر کدام روزی یک پیام، تا وقتی از بازه بیرون بروند یا تمدید کنند.`}
              </p>

              <div className="cron-number">
                <label className="cron-switch">
                  <input
                    type="checkbox"
                    checked={rule.onlyService}
                    disabled={disabled}
                    onChange={(e) => patch(i, { onlyService: e.target.checked })}
                  />
                  <span>فقط مشتری‌هایی که همین یک سرویس را دارند (اکانت تست حساب نیست)</span>
                </label>
              </div>

              <div className="cron-number">
                <label htmlFor={`ret-code-${rule.key}`}>کد تخفیف</label>
                <select
                  id={`ret-code-${rule.key}`}
                  className="form-control"
                  value={rule.codeId ?? ''}
                  disabled={disabled}
                  onChange={(e) => patch(i, { codeId: e.target.value === '' ? null : Number(e.target.value) })}
                >
                  <option value="">— بدون کد —</option>
                  {codes.map((c) => (
                    <option key={c.id} value={c.id} disabled={c.status !== 'ACTIVE' || c.firstPurchaseOnly}>
                      {codeLabel(c)}
                    </option>
                  ))}
                </select>
                {onGo && (
                  <button type="button" className="link" onClick={() => onGo('discounts')}>
                    ساختن کد در «کدهای تخفیف»
                  </button>
                )}
              </div>

              <div className="cron-number">
                <label htmlFor={`ret-text-${rule.key}`}>متن پیش از انقضا</label>
                <textarea
                  id={`ret-text-${rule.key}`}
                  className="form-control"
                  rows={5}
                  maxLength={1000}
                  placeholder="سرویس «{service}» شما {days} روز دیگر تمام می‌شود. با کد {code} تمدید کنید — دکمهٔ «{renewButton}»."
                  value={rule.text}
                  disabled={disabled}
                  onChange={(e) => patch(i, { text: e.target.value })}
                  style={{ inlineSize: '100%' }}
                />
              </div>
              {rule.daysAfter > 0 && (
                <div className="cron-number">
                  <label htmlFor={`ret-text-after-${rule.key}`}>متن بعد از انقضا</label>
                  <textarea
                    id={`ret-text-after-${rule.key}`}
                    className="form-control"
                    rows={5}
                    maxLength={1000}
                    placeholder="متن بعد از انقضا — خالی یعنی همان متن بالا. «{days} روز دیگر تمام می‌شود» برای کسی که سرویسش تمام شده درست نیست."
                    value={rule.textAfter}
                    disabled={disabled}
                    onChange={(e) => patch(i, { textAfter: e.target.value })}
                    style={{ inlineSize: '100%' }}
                  />
                </div>
              )}
              <p className="cron-note page-head__sub">{PLACEHOLDER_HINT}</p>

              <footer className="cron-card-foot page-head__sub">
                <span>{saved ? '' : 'هنوز ذخیره نشده — با «ذخیره» بالای صفحه فعال می‌شود.'}</span>
                <span style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={disabled || rule.text.trim() === ''}
                    title="همین متن، برای یک سرویس واقعی این پنل، به گروه گزارش‌ها — نه به مشتری"
                    onClick={() => void test(rule)}
                  >
                    🧪 تست
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    disabled={disabled}
                    onClick={() => setDraft((d) => (d ? d.filter((_, j) => j !== i) : d))}
                  >
                    حذف
                  </button>
                </span>
              </footer>
            </details>
          );
        })}
      </section>
    </div>
  );
}
