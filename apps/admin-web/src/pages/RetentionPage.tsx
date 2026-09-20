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
      return 'یکی از قانون‌ها ناقص است — نام، پنل، متن، و دست‌کم یکی از دو عدد روز لازم است.';
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
  const [codes, setCodes] = useState<RetentionCodeOption[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** «الان چند نفر»، per rule key, as the operator types. */
  const [audience, setAudience] = useState<Record<string, number | 'loading' | null>>({});

  async function load() {
    setErr(null);
    try {
      const res = await api.retention();
      setRows(res.items);
      setDraft(res.items.map(({ lastActed: _l, funnel: _f, ...rule }) => rule));
      setPanels(res.panels);
      setCodes(res.codes);
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(rows.map(({ lastActed: _l, funnel: _f, ...r }) => r));

  async function save() {
    if (!draft) return;
    setBusy(true);
    setErr(null);
    try {
      await api.updateRetentionRules(draft);
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  // Only the fields the count depends on, as one string, so retyping the
  // text does not re-ask.
  const audienceInputs = JSON.stringify(
    (draft ?? []).map((r) => [r.key, r.providerId, r.daysBefore, r.daysAfter, r.onlyService]),
  );

  // Asked again whenever a rule's panel, window or «only one service»
  // changes, a beat after the last keystroke so «1» → «12» → «120» is one
  // request rather than three.
  useEffect(() => {
    const rows = JSON.parse(audienceInputs) as [string, number, number, number, boolean][];
    const timer = setTimeout(() => {
      for (const [key, providerId, daysBefore, daysAfter, onlyService] of rows) {
        if (providerId <= 0 || (daysBefore === 0 && daysAfter === 0)) {
          setAudience((a) => ({ ...a, [key]: null }));
          continue;
        }
        setAudience((a) => ({ ...a, [key]: 'loading' }));
        api
          .retentionAudience({ providerId, daysBefore, daysAfter, onlyService })
          .then((res) => setAudience((a) => ({ ...a, [key]: res.count })))
          .catch(() => setAudience((a) => ({ ...a, [key]: null })));
      }
    }, 400);
    return () => clearTimeout(timer);
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
    setDraft((d) => [
      ...(d ?? []),
      {
        key: newKey(),
        name: '',
        enabled: false,
        providerId: panels[0]?.id ?? 0,
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

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2 className="page-head__title">یادآوری تمدید</h2>
          <div className="page-head__sub">
            پیام خودتان به مشتری‌های یک پنل، چند روز مانده به انقضا یا بعد از آن — با یک کد تخفیف که
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

      <section className="cron-list">
        {(draft ?? []).length === 0 && (
          <div className="card page-head__sub">هنوز قانونی ندارید. با «افزودن قانون» شروع کنید.</div>
        )}
        {(draft ?? []).map((rule, i) => {
          const saved = rows.find((r) => r.key === rule.key);
          return (
            <article className="card cron-card" key={rule.key} data-testid={`retention-rule-${rule.key}`}>
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
                <label htmlFor={`ret-panel-${rule.key}`}>پنل</label>
                <select
                  id={`ret-panel-${rule.key}`}
                  className="form-control"
                  value={rule.providerId}
                  disabled={disabled}
                  onChange={(e) => patch(i, { providerId: Number(e.target.value) })}
                >
                  {panels.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.baseUrl ? ` — ${p.baseUrl}` : ''}
                    </option>
                  ))}
                </select>
              </div>

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
                <span>
                  {saved ? (
                    <>
                      {actedLabel(saved)} · به {count(saved.funnel.sent)} نفر رسید · کد زدند {count(saved.funnel.usedCode)} · نزدند{' '}
                      {count(saved.funnel.sent - saved.funnel.usedCode)} · بیرون از فهرست {count(saved.funnel.usedOutside)} · ماندند{' '}
                      {count(saved.funnel.stayed)} · رفتند {count(saved.funnel.left)} · هنوز {count(saved.funnel.pending)}
                    </>
                  ) : (
                    'هنوز ذخیره نشده'
                  )}
                </span>
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
            </article>
          );
        })}
      </section>
    </div>
  );
}
