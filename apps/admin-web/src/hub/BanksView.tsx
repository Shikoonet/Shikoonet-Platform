/**
 * Banks — the two things about a bank this system has to get right, and a place
 * to try a change before trusting it.
 *
 * Card prefixes say which bank issued a card number. SMS patterns say which
 * bank sent a message when the built-in parsers no longer recognise it. Both
 * used to require a deploy to change; the head admin asked on 2026-08-13 for
 * both to be editable here, with somewhere to test by hand.
 *
 * The test boxes call the same endpoints ingest uses, so what they show is what
 * a real message would produce. Nothing pasted into the SMS box comes back in
 * the response — an operator will paste a one-time password in there sooner or
 * later, and it stops at the server.
 */

import { Fragment, useEffect, useState } from 'react';
import { count, dateTime } from '../format.js';
import { useWriteProps } from '../role.js';
import { directionLabel } from './format.js';

interface PrefixRow {
  prefix: string;
  bank_name: string;
  updated_at: number;
  updated_by: string | null;
}

interface PatternRow {
  id: string;
  bank_name: string;
  enabled: boolean;
  priority: number;
  detect_re: string;
  amount_re: string;
  amount_unit: 'IRR' | 'TOMAN';
  direction: 'CREDIT' | 'DEBIT';
  balance_re: string | null;
  account_re: string | null;
  notes: string | null;
  updated_by: string | null;
}

interface CardTestResult {
  normalized: string | null;
  display?: string;
  luhnOk?: boolean;
  matchedPrefix?: string | null;
  bankName?: string | null;
  message?: string;
}

interface SmsTestResult {
  matched: boolean;
  classification: string;
  direction: string;
  amountIrr: number | null;
  balanceIrr: number | null;
  accountHint: string | null;
  parserId: string | null;
  bankName: string | null;
  fromPattern: string | null;
  confidence: number;
  warnings: string[];
}

const EMPTY_PATTERN: PatternRow = {
  id: '',
  bank_name: '',
  enabled: false,
  priority: 100,
  detect_re: '',
  amount_re: '',
  amount_unit: 'IRR',
  direction: 'CREDIT',
  balance_re: null,
  account_re: null,
  notes: null,
  updated_by: null,
};

async function readJson<T>(r: Response): Promise<T & { error?: string; problems?: string[] }> {
  return (await r.json().catch(() => ({}))) as T & { error?: string; problems?: string[] };
}

export function BanksView() {
  return (
    <div className="banks-view">
      <UnparsedSmsPanel />
      <CardPrefixesPanel />
      <SmsPatternsPanel />
    </div>
  );
}

interface SenderCoverage {
  sender: string;
  total: number;
  filtered: number;
  named: number;
  generic: number;
  unread: number;
  lastAt: number;
  parsers: { parserId: string; n: number }[];
}

interface UnparsedShape {
  sender: string;
  shape: string;
  count: number;
  lastAt: number;
  parserId: string | null;
  classification: string;
  reason: 'unread' | 'generic';
  sampleEventId: string;
  sampleBody: string;
}

/**
 * Which texts the parsers read, and which they did not — by sender, and then
 * by the shape of each text nobody read. Every text the phone relays is
 * already kept; this is the first place it can be seen. The CSV is what gets
 * handed to whoever writes the next parser.
 */
function UnparsedSmsPanel() {
  const [days, setDays] = useState(14);
  const [coverage, setCoverage] = useState<SenderCoverage[]>([]);
  const [shapes, setShapes] = useState<UnparsedShape[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, SmsTestResult | undefined>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      const [c, u] = await Promise.all([
        fetch(`/api/v1/admin/sms/coverage?days=${days}`),
        fetch(`/api/v1/admin/sms/unparsed?days=${days}`),
      ]);
      if (!c.ok || !u.ok) {
        if (alive) setErr(`بارگذاری ناموفق بود (${c.ok ? u.status : c.status})`);
        return;
      }
      const cj = await readJson<{ items: SenderCoverage[] }>(c);
      const uj = await readJson<{ items: UnparsedShape[] }>(u);
      if (alive) {
        setCoverage(cj.items ?? []);
        setShapes(uj.items ?? []);
        setErr(null);
      }
    })().catch((e: unknown) => alive && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [days]);

  async function tryParse(key: string, body: string) {
    const r = await fetch('/api/v1/banks/test-sms', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: body }),
    });
    const j = await readJson<SmsTestResult>(r);
    if (!r.ok) {
      setErr(j.error ?? `${r.status}`);
      return;
    }
    setTests((t) => ({ ...t, [key]: j }));
  }

  const unread = shapes.filter((s) => s.reason === 'unread').reduce((a, s) => a + s.count, 0);
  const generic = shapes.filter((s) => s.reason === 'generic').reduce((a, s) => a + s.count, 0);
  const light = (c: SenderCoverage) => (c.unread ? 'badge-block' : c.generic ? 'badge-warning' : 'badge-active');

  return (
    <section className="banks-panel" data-testid="unparsed-sms">
      <h3>پیامک‌های بی‌پارسر</h3>
      <p className="muted">
        هر پیامکی که به گوشی می‌رسد نگه داشته می‌شود. این‌جا می‌بینی کدام فرستنده را یک تحلیل‌گر
        نام‌دار خوانده، کدام را یک تحلیل‌گر عمومی <em>حدس</em> زده (خطرناک: می‌تواند مانده را غلط
        بخواند)، و کدام هیچ ردیفی نساخته — معمولاً شکل برداشتی که بانک تازه فرستاده. پایین، هر شکل
        ناخوانده یک بار با شمارنده و یک نمونه. خروجی CSV را بده تا تحلیل‌گرش نوشته شود.
      </p>
      {err && <div className="error">{err}</div>}
      <div className="row toolbar" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'center' }}>
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} aria-label="بازه" style={{ maxWidth: 140 }}>
          <option value={7}>۷ روز اخیر</option>
          <option value={14}>۱۴ روز اخیر</option>
          <option value={30}>۳۰ روز اخیر</option>
          <option value={90}>۹۰ روز اخیر</option>
        </select>
        <span className="muted" style={{ flex: 1, minWidth: 200 }} data-testid="unparsed-summary">
          {unread ? `${count(unread)} پیامک بی‌ردیف` : 'هیچ پیامکی بی‌ردیف نیست'}
          {generic ? ` · ${count(generic)} با تحلیل‌گر عمومی` : ''}
        </span>
        <a className="btn btn-sm" href={`/api/v1/admin/sms/unparsed.csv?days=${days}`}>
          خروجی CSV
        </a>
      </div>

      <div className="table-wrap">
        <table className="banks-table" data-testid="sms-coverage">
          <thead>
            <tr>
              <th scope="col">فرستنده</th>
              <th scope="col">همه</th>
              <th scope="col">نام‌دار</th>
              <th scope="col">عمومی</th>
              <th scope="col">بی‌ردیف</th>
              <th scope="col">تحلیل‌گرها</th>
              <th scope="col">آخرین</th>
            </tr>
          </thead>
          <tbody>
            {coverage.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  در این بازه پیامکی نرسیده.
                </td>
              </tr>
            )}
            {coverage.map((c) => (
              <tr key={c.sender}>
                <td dir="ltr" style={{ textAlign: 'end' }}>
                  <span className={`badge ${light(c)}`} style={{ marginInlineEnd: 6 }}>
                    {c.unread ? 'ناخوانده' : c.generic ? 'حدسی' : 'خوانده'}
                  </span>
                  {c.sender}
                </td>
                <td className="tabular-nums">{count(c.total)}</td>
                <td className="tabular-nums">{count(c.named)}</td>
                <td className="tabular-nums">{c.generic ? count(c.generic) : '—'}</td>
                <td className="tabular-nums">{c.unread ? count(c.unread) : '—'}</td>
                <td className="muted" dir="ltr" style={{ textAlign: 'end' }}>
                  {c.parsers.map((p) => `${p.parserId} ×${p.n}`).join(' · ')}
                </td>
                <td className="tabular-nums" style={{ whiteSpace: 'nowrap' }}>{dateTime(c.lastAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {shapes.length > 0 && (
        <div className="table-wrap" style={{ marginBlockStart: 12 }}>
          <table className="banks-table" data-testid="sms-shapes">
            <thead>
              <tr>
                <th scope="col">چرا</th>
                <th scope="col">فرستنده</th>
                <th scope="col">تعداد</th>
                <th scope="col">شکل (ارقام → ۹)</th>
                <th scope="col">آخرین</th>
                <th scope="col" />
              </tr>
            </thead>
            <tbody>
              {shapes.map((s) => {
                const key = `${s.sender}\u0000${s.shape}`;
                const t = tests[key];
                return (
                  <Fragment key={key}>
                    <tr>
                      <td>
                        <span className={`badge ${s.reason === 'unread' ? 'badge-block' : 'badge-warning'}`}>
                          {s.reason === 'unread' ? 'ردیف نساخت' : 'حدسی'}
                        </span>
                        <div className="muted" dir="ltr" style={{ textAlign: 'end', fontSize: 11 }}>
                          {s.parserId ?? '—'} · {s.classification}
                        </div>
                      </td>
                      <td dir="ltr" style={{ textAlign: 'end' }}>{s.sender}</td>
                      <td className="tabular-nums">{count(s.count)}</td>
                      <td style={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'pre-wrap' }}>{s.shape}</td>
                      <td className="tabular-nums" style={{ whiteSpace: 'nowrap' }}>{dateTime(s.lastAt)}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        <button type="button" className="btn-sm" onClick={() => setOpen(open === key ? null : key)}>
                          {open === key ? 'بستن' : 'نمونه'}
                        </button>{' '}
                        <button type="button" className="btn-sm" onClick={() => void tryParse(key, s.sampleBody)}>
                          آزمایش
                        </button>
                      </td>
                    </tr>
                    {(open === key || t) && (
                      <tr>
                        <td colSpan={6}>
                          {open === key && (
                            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontSize: 12 }}>{s.sampleBody}</pre>
                          )}
                          {t && (
                            <div className="muted" style={{ marginBlockStart: 6 }}>
                              با تحلیل‌گرهای فعلی: {t.parserId ?? '—'} · {t.classification} ·{' '}
                              {t.direction === 'CREDIT' ? 'واریز' : t.direction === 'DEBIT' ? 'برداشت' : 'بی‌جهت'} · مبلغ {count(t.amountIrr)} ·
                              مانده {count(t.balanceIrr)} · حساب {t.accountHint ?? '—'}
                              {t.warnings.length ? ` · ${t.warnings.join('، ')}` : ''}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function CardPrefixesPanel() {
  const w = useWriteProps();
  const [rows, setRows] = useState<PrefixRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [prefix, setPrefix] = useState('');
  const [bankName, setBankName] = useState('');
  const [cardInput, setCardInput] = useState('');
  const [test, setTest] = useState<CardTestResult | null>(null);

  async function load() {
    const r = await fetch('/api/v1/banks/prefixes');
    if (!r.ok) {
      setErr(`بارگذاری پیش‌شماره‌ها ناموفق بود (${r.status})`);
      return;
    }
    setRows((await readJson<{ items: PrefixRow[] }>(r)).items ?? []);
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`/api/v1/banks/prefixes/${prefix}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prefix, bankName }),
      });
      const j = await readJson(r);
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setPrefix('');
      setBankName('');
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(p: string) {
    const bank = rows.find((r) => r.prefix === p)?.bank_name ?? '';
    // The longest matching prefix wins, so removing one does not leave the
    // range unmapped — it hands those cards to whatever shorter prefix still
    // matches, or to none. Either way a card that resolved to one bank
    // yesterday resolves differently today, and the press said nothing.
    if (
      !window.confirm(
        `پیش‌شمارهٔ ${p}${bank ? ` (${bank})` : ''} حذف شود؟ ` +
          `کارت‌هایی که با آن شروع می‌شوند از این به بعد به بانک دیگری نسبت داده می‌شوند یا به هیچ بانکی.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/v1/banks/prefixes/${p}`, { method: 'DELETE' });
    if (!r.ok) setErr(`حذف ناموفق بود (${r.status})`);
    await load();
    setBusy(false);
  }

  async function runTest() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/v1/banks/test-card', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ cardNumber: cardInput }),
      });
      const j = await readJson<CardTestResult>(r);
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setTest(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="banks-panel">
      <h3>پیش‌شمارهٔ کارت‌ها</h3>
      <p className="muted">
        شش رقم اول یک کارت می‌گوید کدام بانک آن را صادر کرده. طولانی‌ترین پیش‌شمارهٔ منطبق برنده
        است، پس اگر بانکی بعدها یک بازه را تقسیم کند فقط یک ردیف این‌جا لازم است، نه تغییر کد.
      </p>
      {err && <div className="error">{err}</div>}

      <div className="banks-test">
        <h4>یک شمارهٔ کارت را امتحان کن</h4>
        <div className="row toolbar">
          <input
            placeholder="5054-1617-0627-7062"
            value={cardInput}
            onChange={(e) => setCardInput(e.target.value)}
            aria-label="شمارهٔ کارت برای آزمایش"
          />
          <button
            type="button"
            className="primary"
            disabled={busy || !cardInput.trim()}
            onClick={() => void runTest()}
          >
            آزمایش
          </button>
        </div>
        {test &&
          (test.normalized === null ? (
            <p className="muted">{test.message}</p>
          ) : (
            <dl className="banks-test__result">
              <dt>شماره</dt>
              <dd>{test.display}</dd>
              <dt>رقم کنترلی</dt>
              <dd>
                {test.luhnOk ? (
                  'درست'
                ) : (
                  <span className="badge badge-block">نادرست — این نمی‌تواند کارت واقعی باشد</span>
                )}
              </dd>
              <dt>پیش‌شماره</dt>
              <dd>{test.matchedPrefix ?? 'هیچ ردیفی منطبق نیست'}</dd>
              <dt>بانک</dt>
              <dd>{test.bankName ?? 'برای این جدول ناشناخته است'}</dd>
            </dl>
          ))}
      </div>

      <div className="table-wrap">
        <table className="banks-table">
          <thead>
            <tr>
              <th scope="col">پیش‌شماره</th>
              <th scope="col">بانک</th>
              <th scope="col">آخرین تغییر توسط</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.prefix}>
                <td>{r.prefix}</td>
                <td>{r.bank_name}</td>
                <td className="muted">{r.updated_by ?? '—'}</td>
                <td>
                  <button
                    type="button"
                    className="btn-sm danger"
                    disabled={busy}
                    onClick={() => void remove(r.prefix)}
                    {...w}
                  >
                    حذف
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="row toolbar">
        <input
          placeholder="پیش‌شماره (۴ تا ۸ رقم)"
          value={prefix}
          onChange={(e) => setPrefix(e.target.value.replace(/\D/g, '').slice(0, 8))}
          aria-label="پیش‌شماره"
        />
        <input
          placeholder="نام بانک"
          value={bankName}
          onChange={(e) => setBankName(e.target.value)}
          aria-label="نام بانک"
        />
        <button
          type="button"
          className="primary"
          disabled={busy || prefix.length < 4 || !bankName.trim()}
          onClick={() => void save()}
          {...w}
        >
          افزودن یا به‌روزرسانی
        </button>
      </div>
    </section>
  );
}

function SmsPatternsPanel() {
  const w = useWriteProps();
  const [rows, setRows] = useState<PatternRow[]>([]);
  const [draft, setDraft] = useState<PatternRow>(EMPTY_PATTERN);
  const [err, setErr] = useState<string | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [smsInput, setSmsInput] = useState('');
  const [test, setTest] = useState<SmsTestResult | null>(null);

  async function load() {
    const r = await fetch('/api/v1/banks/sms-patterns');
    if (!r.ok) {
      setErr(`بارگذاری الگوها ناموفق بود (${r.status})`);
      return;
    }
    setRows((await readJson<{ items: PatternRow[] }>(r)).items ?? []);
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setBusy(true);
    setErr(null);
    setProblems([]);
    try {
      const r = await fetch(`/api/v1/banks/sms-patterns/${draft.id}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          id: draft.id,
          bankName: draft.bank_name,
          enabled: draft.enabled,
          priority: draft.priority,
          detectRe: draft.detect_re,
          amountRe: draft.amount_re,
          amountUnit: draft.amount_unit,
          direction: draft.direction,
          balanceRe: draft.balance_re || null,
          accountRe: draft.account_re || null,
          notes: draft.notes || null,
        }),
      });
      const j = await readJson(r);
      if (!r.ok) {
        setProblems(j.problems ?? []);
        throw new Error(j.error ?? `${r.status}`);
      }
      setDraft(EMPTY_PATTERN);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    // Additive, and the sentence has to say only that. `registry.ts` is
    // explicit that these fallbacks never run where a built-in already named
    // the bank, so deleting one does not stop a bank's SMS being parsed in
    // general — it stops the messages that ONLY this pattern could read, which
    // is exactly why somebody added it.
    if (
      !window.confirm(
        'این الگوی پیامک حذف شود؟ پیامک‌هایی که فقط با همین الگو خوانده می‌شدند از این به بعد تشخیص داده نمی‌شوند و واریزی‌شان تطبیق نمی‌خورد.',
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    const r = await fetch(`/api/v1/banks/sms-patterns/${id}`, { method: 'DELETE' });
    if (!r.ok) setErr(`حذف ناموفق بود (${r.status})`);
    await load();
    setBusy(false);
  }

  async function runTest() {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/v1/banks/test-sms', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: smsInput }),
      });
      const j = await readJson<SmsTestResult>(r);
      if (!r.ok) throw new Error(j.error ?? `${r.status}`);
      setTest(j);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="banks-panel">
      <h3>الگوهای پیامک بانک</h3>
      <p className="muted">
        این‌ها فقط جایی اجرا می‌شوند که تحلیل‌گرهای داخلی هیچ بانکی را نشناخته باشند. می‌توانند نام
        بانک اضافه کنند یا پیامی را بخوانند که هیچ‌چیز دیگری نفهمیده — اما هرگز نمی‌توانند مبلغی را
        که یک تحلیل‌گر داخلی خوانده عوض کنند، و هرگز رمز یک‌بارمصرف را نمی‌بینند. وقتی بانکی متن
        پیامکش را عوض کرد از این‌ها استفاده کن.
      </p>
      {err && <div className="error">{err}</div>}
      {problems.length > 0 && (
        <ul className="error">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}

      <div className="banks-test">
        <h4>یک پیام را امتحان کن</h4>
        <p className="muted">
          خط لولهٔ واقعی را اجرا می‌کند، شامل همهٔ الگوهای فعال پایین. متن نه ذخیره می‌شود، نه لاگ
          می‌شود، و نه برگردانده می‌شود.
        </p>
        <textarea
          rows={6}
          placeholder={
            'بانک نمونه\nواریز مبلغ 1,000,000 ریال\nحساب: 0201234567001\nمانده: 5,000,000'
          }
          value={smsInput}
          onChange={(e) => setSmsInput(e.target.value)}
          aria-label="متن پیامک برای آزمایش"
        />
        <div className="row toolbar">
          <button
            type="button"
            className="primary"
            disabled={busy || !smsInput.trim()}
            onClick={() => void runTest()}
          >
            آزمایش
          </button>
        </div>
        {test && (
          <dl className="banks-test__result">
            <dt>خوانده شد به‌عنوان</dt>
            <dd>
              {test.classification}
              {test.matched ? '' : ' (منطبق نشد)'}
            </dd>
            <dt>تحلیل‌گر</dt>
            <dd>
              {test.parserId ?? '—'}
              {test.fromPattern && <span className="badge">از الگوی {test.fromPattern}</span>}
            </dd>
            <dt>بانک</dt>
            <dd>{test.bankName ?? '—'}</dd>
            {/* Rial, not Toman: this box exists to show what the parser read out
                of the message, and the parser reads Rial. */}
            <dt>مبلغ (ریال)</dt>
            <dd>{count(test.amountIrr)}</dd>
            <dt>مانده (ریال)</dt>
            <dd>{count(test.balanceIrr)}</dd>
            <dt>جهت</dt>
            {/* The same word Today puts on the same field. The classification
                and parser id beside it stay in the parser's own vocabulary,
                because that is what an operator matches against a pattern. */}
            <dd>{directionLabel(test.direction as 'CREDIT' | 'DEBIT' | 'UNKNOWN')}</dd>
            <dt>نشانهٔ حساب</dt>
            <dd>{test.accountHint ?? '—'}</dd>
            <dt>هشدارها</dt>
            <dd>{test.warnings.length === 0 ? '—' : test.warnings.join('، ')}</dd>
          </dl>
        )}
      </div>

      <div className="table-wrap">
        <table className="banks-table">
          <thead>
            <tr>
              <th scope="col">شناسه</th>
              <th scope="col">بانک</th>
              <th scope="col">فعال</th>
              <th scope="col">ترتیب</th>
              <th scope="col">تشخیص</th>
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  هنوز الگویی نیست. همه‌چیز را تحلیل‌گرهای داخلی می‌خوانند.
                </td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.bank_name}</td>
                <td>{r.enabled ? 'بله' : <span className="muted">پیش‌نویس</span>}</td>
                <td>{count(r.priority)}</td>
                <td>
                  <code>{r.detect_re}</code>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn-sm"
                    disabled={busy}
                    onClick={() => setDraft(r)}
                  >
                    ویرایش
                  </button>
                  <button
                    type="button"
                    className="btn-sm danger"
                    disabled={busy}
                    onClick={() => void remove(r.id)}
                    {...w}
                  >
                    حذف
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h4>{rows.some((r) => r.id === draft.id) ? `ویرایش ${draft.id}` : 'الگوی تازه'}</h4>
      <div className="banks-form">
        <label>
          شناسه
          <input
            value={draft.id}
            onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            placeholder="ayandeh-v1"
          />
        </label>
        <label>
          بانک
          <input
            value={draft.bank_name}
            onChange={(e) => setDraft({ ...draft, bank_name: e.target.value })}
            placeholder="AYANDEH"
          />
        </label>
        <label>
          ترتیب
          <input
            type="number"
            value={draft.priority}
            onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}
          />
        </label>
        <label>
          واحد مبلغ
          <select
            value={draft.amount_unit}
            onChange={(e) =>
              setDraft({ ...draft, amount_unit: e.target.value as PatternRow['amount_unit'] })
            }
          >
            <option value="IRR">ریال</option>
            <option value="TOMAN">تومان (×۱۰)</option>
          </select>
        </label>
        <label>
          جهت
          <select
            value={draft.direction}
            onChange={(e) =>
              setDraft({ ...draft, direction: e.target.value as PatternRow['direction'] })
            }
          >
            <option value="CREDIT">واریز</option>
            <option value="DEBIT">برداشت</option>
          </select>
        </label>
        <label className="banks-form__wide">
          تشخیص (پیام را از آن خود می‌کند)
          <input
            value={draft.detect_re}
            onChange={(e) => setDraft({ ...draft, detect_re: e.target.value })}
            placeholder="بانک\s*آینده"
          />
        </label>
        <label className="banks-form__wide">
          مبلغ — گروه ۱ همان ارقام است
          <input
            value={draft.amount_re}
            onChange={(e) => setDraft({ ...draft, amount_re: e.target.value })}
            placeholder="^مبلغ\s*:\s*([\d,]+)"
          />
        </label>
        <label className="banks-form__wide">
          مانده (اختیاری)
          <input
            value={draft.balance_re ?? ''}
            onChange={(e) => setDraft({ ...draft, balance_re: e.target.value })}
          />
        </label>
        <label className="banks-form__wide">
          حساب (اختیاری)
          <input
            value={draft.account_re ?? ''}
            onChange={(e) => setDraft({ ...draft, account_re: e.target.value })}
          />
        </label>
        <label className="banks-form__wide">
          یادداشت
          <input
            value={draft.notes ?? ''}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
        </label>
        <label className="banks-form__check">
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
          />
          فعال — خاموش بگذار تا پیش‌نویس ذخیره شود
        </label>
      </div>
      <div className="row toolbar">
        <button
          type="button"
          className="primary"
          disabled={busy || !draft.id.trim() || !draft.bank_name.trim() || !draft.amount_re.trim()}
          onClick={() => void save()}
          {...w}
        >
          ذخیرهٔ الگو
        </button>
        <button type="button" className="btn-sm" onClick={() => setDraft(EMPTY_PATTERN)}>
          پاک‌کردن
        </button>
      </div>
    </section>
  );
}
