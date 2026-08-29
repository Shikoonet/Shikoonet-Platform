/**
 * «ایمپورت میرزابات» — running the legacy migration from the panel.
 *
 * The screen is deliberately a staircase rather than a form: بررسی (reads
 * nothing but the dump), اجرای آزمایشی (does the whole import against the real
 * tables and rolls back), then اعمال — which the server refuses until a dry run
 * of the same file has succeeded. The order is not advice, it is enforced, and
 * the buttons say so rather than the help text.
 *
 * There is no file input. Dumps are placed on the server over SCP and this
 * lists them: the file carries plaintext panel passwords and live gateway keys,
 * and it has no business crossing a browser.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type ImportDomain,
  type ImportDumpFile,
  type ImportMode,
  type ImportRun,
} from '../api.js';
import { count, dateTime } from '../format.js';
import { useAdminWriteProps } from '../role.js';

/**
 * The domains offered, in the order they run.
 *
 * `core` is absent on purpose: it owns `users`, every other domain has a
 * foreign key into it, and the server adds it back regardless. Offering a
 * checkbox that cannot be unticked would be decoration.
 */
const DOMAIN_FA: { id: ImportDomain; label: string; hint: string }[] = [
  { id: 'catalog', label: 'محصولات و پنل‌ها', hint: 'product و marzban_panel' },
  { id: 'sales', label: 'سرویس‌ها، پرداخت‌ها و سفارش‌ها', hint: 'invoice، Payment_report، service_other' },
  { id: 'discounts', label: 'کد تخفیف و گیفت‌کد', hint: 'Discount، DiscountSell، Giftcodeconsumed' },
  { id: 'config', label: 'تنظیمات، ادمین‌ها و محتوا', hint: 'setting، admin، help، درخواست نمایندگی' },
  { id: 'history', label: 'تیکت‌ها و گردونهٔ شانس', hint: 'تصمیم قبلی: وارد نمی‌شوند' },
  { id: 'hub', label: 'دادهٔ هاب و کارت‌های بانکی', hint: 'به اکسپورت D1 کنار دامپ نیاز دارد' },
];

/** What Sam chose. `history` and `hub` are off, and each says why above. */
const DEFAULT_DOMAINS: ImportDomain[] = ['catalog', 'sales', 'discounts', 'config'];

const MODE_FA: Record<ImportMode, string> = {
  PREFLIGHT: 'بررسی',
  DRY_RUN: 'اجرای آزمایشی',
  APPLY: 'اعمال نهایی',
};

const STATUS_FA: Record<ImportRun['status'], string> = {
  RUNNING: 'در حال اجرا',
  SUCCEEDED: 'موفق',
  FAILED: 'ناموفق',
};

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'import_dir_unset' || e.code === 'import_not_configured') {
      return e.detail ?? 'ایمپورت روی این سرور تنظیم نشده است.';
    }
    if (e.code === 'import_dir_unreadable') return 'پوشهٔ ایمپورت روی سرور خوانده نشد.';
    if (e.code === 'import_already_running') return 'یک ایمپورت در حال اجراست؛ تا پایانش صبر کن.';
    if (e.code === 'dry_run_required') {
      return 'اول یک اجرای آزمایشی موفق روی همین فایل لازم است.';
    }
    if (e.code === 'invalid_file') return 'این فایل قابل ایمپورت نیست.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

function megabytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  return `${count(Math.round(bytes / 1024 / 1024))} مگابایت`;
}

/** The captured CLI report, coloured by level rather than by parsing text. */
function Report({ run }: { run: ImportRun }) {
  const lines = run.report ?? [];
  if (lines.length === 0) return null;
  return (
    <pre
      className="ltr"
      style={{
        maxHeight: 380,
        overflow: 'auto',
        background: '#0f172a',
        color: '#e2e8f0',
        padding: 12,
        borderRadius: 8,
        fontSize: 12,
        lineHeight: 1.6,
        direction: 'ltr',
        textAlign: 'left',
      }}
    >
      {lines.map((l, i) => (
        <div
          key={i}
          style={{
            color:
              l.level === 'fail'
                ? '#fca5a5'
                : l.level === 'warn'
                  ? '#fcd34d'
                  : l.level === 'ok'
                    ? '#86efac'
                    : l.level === 'title'
                      ? '#93c5fd'
                      : '#e2e8f0',
            fontWeight: l.level === 'title' ? 700 : 400,
            marginTop: l.level === 'title' ? 8 : 0,
          }}
        >
          {l.text}
        </div>
      ))}
    </pre>
  );
}

/**
 * A few rows of each table as they landed.
 *
 * The dry run collects these inside the transaction that is about to be rolled
 * back, which is the only moment they exist — and the only way to see a Tehran
 * timestamp or a mapped status with your own eyes before committing to it.
 */
function Samples({ run }: { run: ImportRun }) {
  const samples = run.samples ?? {};
  const tables = Object.keys(samples);
  if (tables.length === 0) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h3>نمونهٔ ردیف‌ها</h3>
      <p className="muted">چند ردیف از هر جدول، همان‌طور که نوشته شدند.</p>
      {tables.map((t) => {
        const rows = samples[t] ?? [];
        if (rows.length === 0) return null;
        const cols = Object.keys(rows[0]!);
        return (
          <div key={t} style={{ marginBottom: 20 }}>
            <strong className="ltr">{t}</strong>
            <div style={{ overflowX: 'auto' }}>
              <table className="table" style={{ fontSize: 12 }}>
                <thead>
                  <tr>
                    {cols.map((c) => (
                      <th key={c} className="ltr">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      {cols.map((c) => (
                        <td key={c} className="ltr" style={{ maxWidth: 220, overflow: 'hidden' }}>
                          {r[c] === null || r[c] === undefined ? '—' : String(r[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ImportPage() {
  const w = useAdminWriteProps();
  const [files, setFiles] = useState<ImportDumpFile[]>([]);
  const [dir, setDir] = useState<string | null>(null);
  const [file, setFile] = useState('');
  const [domains, setDomains] = useState<ImportDomain[]>(DEFAULT_DOMAINS);
  const [runs, setRuns] = useState<ImportRun[]>([]);
  const [active, setActive] = useState<ImportRun | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadFiles = useCallback(async () => {
    try {
      const r = await api.importFiles();
      setFiles(r.items);
      setDir(r.dir);
      setFile((f) => f || (r.items[0]?.name ?? ''));
    } catch (e) {
      setErr(message(e));
    }
  }, []);

  const loadRuns = useCallback(async () => {
    try {
      setRuns((await api.importRuns()).items);
    } catch (e) {
      setErr(message(e));
    }
  }, []);

  useEffect(() => {
    void loadFiles();
    void loadRuns();
  }, [loadFiles, loadRuns]);

  /**
   * Polls the active run until it settles.
   *
   * A one-second poll rather than the panel's usual thirty: this is the one
   * screen where somebody is watching the thing they just started, and a
   * half-minute of silence after pressing «اعمال نهایی» reads as a hang.
   */
  useEffect(() => {
    if (active === null || active.status !== 'RUNNING') return;
    timer.current = setTimeout(() => {
      void (async () => {
        try {
          const r = await api.importRun(active.id);
          setActive(r.run);
          if (r.run.status !== 'RUNNING') void loadRuns();
        } catch (e) {
          setErr(message(e));
        }
      })();
    }, 1000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [active, loadRuns]);

  async function start(mode: ImportMode) {
    setErr(null);
    setConfirming(false);
    setBusy(true);
    try {
      const { id } = await api.startImport(mode, { file, domains });
      const r = await api.importRun(id);
      setActive(r.run);
      void loadRuns();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  function toggle(d: ImportDomain) {
    setDomains((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]));
  }

  const running = active?.status === 'RUNNING';
  /** «اعمال» only becomes real once a dry run of this exact file has passed. */
  const proven = runs.some(
    (r) =>
      r.mode === 'DRY_RUN' &&
      r.status === 'SUCCEEDED' &&
      dir !== null &&
      r.dump_path.endsWith(file),
  );

  return (
    <div>
      <div className="page-head">
        <h2>ایمپورت میرزابات</h2>
        <p className="muted">
          دادهٔ ربات قدیمی را از یک بکاپ MySQL به این پنل می‌آورد. فایل روی سرور گذاشته می‌شود؛
          از مرورگر چیزی آپلود نمی‌شود، چون دامپ رمز پنل‌ها و کلید درگاه‌ها را رمزنشده دارد.
        </p>
      </div>

      {err && <div className="alert-error">{err}</div>}

      <div className="card">
        <h3>۱. فایل</h3>
        {dir && (
          <p className="muted">
            پوشه: <span className="ltr">{dir}</span>
          </p>
        )}
        {files.length === 0 ? (
          <p className="muted">هیچ دامپی در این پوشه نیست. فایل را با SCP آن‌جا بگذار.</p>
        ) : (
          <select
            className="form-control ltr"
            value={file}
            onChange={(e) => setFile(e.target.value)}
            disabled={running}
          >
            {files.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name} — {megabytes(f.bytes)} — {dateTime(f.modifiedAt)}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="card">
        <h3>۲. چه چیزی وارد شود</h3>
        <p className="muted">
          کاربران، کیف پول و معرف‌ها همیشه وارد می‌شوند — بقیهٔ جدول‌ها به آن‌ها کلید خارجی
          دارند و بدون‌شان معنا ندارند.
        </p>
        {DOMAIN_FA.map((d) => (
          <label key={d.id} className="form-label" style={{ display: 'block', marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={domains.includes(d.id)}
              onChange={() => toggle(d.id)}
              disabled={running}
            />{' '}
            {d.label} <span className="muted">— {d.hint}</span>
          </label>
        ))}
      </div>

      <div className="card">
        <h3>۳. اجرا</h3>
        <p className="muted">
          «اجرای آزمایشی» همان ایمپورت واقعی روی جدول‌های واقعی است و در پایان برمی‌گردانَد —
          پس هر قید و ایندکس یکتا واقعاً آزموده می‌شود. «اعمال نهایی» تا وقتی یک اجرای آزمایشیِ
          موفق روی همین فایل نباشد، از سمت سرور رد می‌شود.
        </p>
        <div className="filters">
          <button
            className="btn"
            onClick={() => void start('PREFLIGHT')}
            disabled={busy || running || !file}
            {...w}
          >
            بررسی
          </button>
          <button
            className="btn"
            onClick={() => void start('DRY_RUN')}
            disabled={busy || running || !file}
            {...w}
          >
            اجرای آزمایشی
          </button>
          {confirming ? (
            <>
              <button
                className="btn btn-danger"
                onClick={() => void start('APPLY')}
                disabled={busy || running}
                {...w}
              >
                بله، بنویس
              </button>
              <button className="btn" onClick={() => setConfirming(false)}>
                انصراف
              </button>
            </>
          ) : (
            <button
              className="btn btn-danger"
              onClick={() => setConfirming(true)}
              disabled={busy || running || !file || !proven}
              title={proven ? undefined : 'اول یک اجرای آزمایشی موفق روی همین فایل لازم است'}
              {...w}
            >
              اعمال نهایی
            </button>
          )}
        </div>
        {confirming && (
          <div className="alert-info" style={{ marginTop: 12 }}>
            این کار روی دیتابیس می‌نویسد. ردیف‌های تکراری رد می‌شوند و چیزی بازنویسی نمی‌شود،
            ولی اجرای موفق برگشت‌پذیر نیست.
          </div>
        )}
      </div>

      {active && (
        <div className="card">
          <h3>
            {MODE_FA[active.mode]} — {STATUS_FA[active.status]}
            {running && ' …'}
          </h3>
          {active.error && <div className="alert-error">{active.error}</div>}
          <Report run={active} />
        </div>
      )}

      {active && <Samples run={active} />}

      <div className="card">
        <h3>اجراهای اخیر</h3>
        {runs.length === 0 ? (
          <p className="muted">هنوز چیزی اجرا نشده است.</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th>زمان</th>
                  <th>نوع</th>
                  <th>وضعیت</th>
                  <th>فایل</th>
                  <th>توسط</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{dateTime(r.started_at)}</td>
                    <td>{MODE_FA[r.mode]}</td>
                    <td>{STATUS_FA[r.status]}</td>
                    <td className="ltr">{r.dump_path.split(/[\\/]/).pop()}</td>
                    <td className="ltr">{r.started_by}</td>
                    <td>
                      <button
                        className="btn"
                        onClick={() => {
                          void (async () => {
                            try {
                              setActive((await api.importRun(r.id)).run);
                            } catch (e) {
                              setErr(message(e));
                            }
                          })();
                        }}
                      >
                        گزارش
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
