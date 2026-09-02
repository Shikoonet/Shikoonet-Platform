/**
 * «ایمپورت میرزابات» — running the legacy migration from the panel.
 *
 * The screen is deliberately a staircase rather than a form: بررسی (reads
 * nothing but the dump), اجرای آزمایشی (does the whole import against the real
 * tables and rolls back), then اعمال — which the server refuses until a dry run
 * of the same file has succeeded. The order is not advice, it is enforced, and
 * the buttons say so rather than the help text.
 *
 * Dumps may be uploaded here or placed on the server over SCP; both end up in
 * the same directory and the list below shows whatever is there. Upload was
 * refused until 2026-09-01 and the reasons are recorded in `importRoutes.ts`
 * rather than deleted — the file does carry plaintext panel passwords and live
 * gateway keys, and that is still true, it is just no longer the deciding
 * argument.
 *
 * ## Nobody watches a progress bar for four minutes
 *
 * An APPLY is minutes of work, and this screen used to show one word for all of
 * it. Three things now say what is happening, and they are deliberately aimed
 * at three different places the admin might be looking:
 *
 *   * the report streams, so the page itself is alive
 *   * `document.title` carries the state, for a tab that is in the background
 *   * a `Notification` fires on the transition to a settled state, for an admin
 *     who has gone to make tea — which, for a four-minute cutover, is what
 *     actually happens
 *
 * The last one asks permission at the moment the button is pressed rather than
 * on page load. A permission prompt nobody expected is how a browser learns to
 * refuse them forever.
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
    if (e.code === 'upload_in_progress') return 'همین فایل الان در حال آپلود است؛ تا پایانش صبر کن.';
    if (e.code === 'dry_run_required') {
      return 'اول یک اجرای آزمایشی موفق روی همین فایل لازم است.';
    }
    // The route's own words when it has them: «پسوند .sql یا .sql.gz» tells the
    // admin what to do next, and 'این فایل قابل ایمپورت نیست' does not.
    if (e.code === 'invalid_file') return e.detail ?? 'این فایل قابل ایمپورت نیست.';
    if (e.code === 'nothing_to_undo' || e.code === 'already_undone') {
      return e.detail ?? e.code;
    }
    // The detail is the database's own refusal — a foreign key naming the
    // table that still depends on an imported row. Passed through rather
    // than replaced: «برگرداندن نشد» tells nobody which row to look at.
    if (e.code === 'undo_failed') {
      return `برگرداندن انجام نشد: ${e.detail ?? 'دیتابیس قبول نکرد.'}`;
    }
    // nginx answers 413 itself, with HTML and no `error` field, so this is the
    // one message that has to name a server setting: nothing in the deploy
    // raises `client_max_body_size` and the default is 1 مگابایت.
    if (e.code === 'body_too_large') {
      return 'سرور فایل به این بزرگی را قبول نکرد. روی nginx جلویی client_max_body_size باید بالا برود.';
    }
    if (e.code === 'network') return 'ارتباط قطع شد؛ چیزی روی سرور نوشته نشد.';
    if (e.code === 'aborted') return 'آپلود لغو شد.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

/**
 * A desktop notification, if the browser and the admin both allow one.
 *
 * Every failure here is silent and that is the point: this is the third of
 * three ways the same fact is already being shown. An import must never fail
 * because a notification could not be drawn.
 */
function notify(title: string, body: string) {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    new Notification(title, { body, lang: 'fa', dir: 'rtl' });
  } catch {
    /* Safari throws on the constructor rather than returning a denial. */
  }
}

/** Asked when a run starts, never on page load. */
function askToNotify() {
  try {
    if (typeof Notification === 'undefined' || Notification.permission !== 'default') return;
    void Notification.requestPermission();
  } catch {
    /* Older Safari wants the callback form; not worth a branch for a nicety. */
  }
}

function megabytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return '—';
  return `${count(Math.round(bytes / 1024 / 1024))} مگابایت`;
}

/** The file's own name out of a server path, on either platform's separator. */
function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Where the run has got to, while it is still going.
 *
 * **Deliberately not a percentage.** The steps are eighteen tables of wildly
 * different sizes and the report does not say how many are coming, so any bar
 * here would be a number invented to look reassuring — and it would sit two
 * inches from an «اعمال نهایی» that is writing to the real database. It says
 * which step is running and how many lines have arrived, both of which are
 * true, and the report underneath is the detail.
 */
function Progress({ run }: { run: ImportRun }) {
  const lines = run.report ?? [];
  const last = [...lines].reverse().find((l) => l.text.trim() !== '');
  return (
    <div className="alert-info" style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      {/* No `value`: an indeterminate progress element is the browser's own way
          of saying «working, length unknown», which is exactly the claim. */}
      <progress style={{ width: 120 }} />
      <span>
        {last ? (
          <span className="ltr" style={{ direction: 'ltr', display: 'inline-block' }}>
            {last.text}
          </span>
        ) : (
          'در حال شروع…'
        )}
        <span className="muted"> — {count(lines.length)} خط</span>
      </span>
    </div>
  );
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
  /** 0…1 while a file is going up, `null` when none is. */
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  /** The run whose «بازگرداندن» is asking for confirmation. */
  const [undoing, setUndoing] = useState<string | null>(null);
  /** The one-line «that worked» the page shows outside the report. */
  const [note, setNote] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const picker = useRef<HTMLInputElement>(null);
  /**
   * The status this page has already announced, per run.
   *
   * Keyed by id, not a bare flag: opening an old run's report from the table
   * sets `active` to something that settled hours ago, and announcing THAT as
   * «همین الان تمام شد» would be a lie the admin has no way to check.
   */
  const announced = useRef<Record<string, ImportRun['status']>>({});

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

  /**
   * Says a run ended, once, wherever the admin is looking.
   *
   * The transition is what is announced, not the state: a run is only new to
   * this page if `announced` has not already seen this id settle. Re-rendering,
   * a re-poll, or reopening the same report later must not fire again.
   */
  useEffect(() => {
    if (active === null) return;
    const seen = announced.current[active.id];
    announced.current[active.id] = active.status;
    // Only RUNNING → settled. An old run opened from the table arrives already
    // settled with nothing seen before it, and says nothing.
    if (seen !== 'RUNNING' || active.status === 'RUNNING') return;
    const what = `${MODE_FA[active.mode]} — ${STATUS_FA[active.status]}`;
    setNote(
      active.status === 'SUCCEEDED'
        ? `${what}. گزارش پایین است.`
        : `${what}: ${active.error ?? 'گزارش را ببین.'}`,
    );
    notify(
      active.status === 'SUCCEEDED' ? 'ایمپورت تمام شد' : 'ایمپورت شکست خورد',
      `${what} — ${basename(active.dump_path)}`,
    );
  }, [active]);

  /**
   * The state in the tab title, for a window that is not on screen.
   *
   * Restored on unmount rather than set back to a literal: the panel's title is
   * not this page's to invent.
   */
  useEffect(() => {
    if (active === null || active.status !== 'RUNNING') return;
    const was = document.title;
    document.title = `⏳ ${MODE_FA[active.mode]} — ایمپورت`;
    return () => {
      document.title = was;
    };
  }, [active]);

  async function upload(f: File) {
    setErr(null);
    setNote(null);
    setUploadPct(0);
    try {
      const { name } = await api.uploadDump(f, setUploadPct);
      await loadFiles();
      setFile(name);
      setNote(`«${name}» روی سرور نشست. حالا «بررسی» را بزن.`);
    } catch (e) {
      setErr(message(e));
    } finally {
      setUploadPct(null);
      // So picking the same file again fires `onChange`. Re-uploading after a
      // failure is the most likely next action and it would silently do nothing.
      if (picker.current) picker.current.value = '';
    }
  }

  async function undo(id: string) {
    setErr(null);
    setNote(null);
    setUndoing(null);
    setBusy(true);
    try {
      const r = await api.undoImport(id);
      const worst = [...r.removed].sort((a, b) => b.rows - a.rows).slice(0, 3);
      setNote(
        `${count(r.total)} ردیف برگردانده شد` +
          (worst.length > 0
            ? ` — ${worst.map((t) => `${count(t.rows)} ${t.table}`).join('، ')}`
            : ''),
      );
      await loadRuns();
      if (active?.id === id) setActive((await api.importRun(id)).run);
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function start(mode: ImportMode) {
    setErr(null);
    setNote(null);
    setConfirming(false);
    setBusy(true);
    askToNotify();
    try {
      const { id } = await api.startImport(mode, { file, domains });
      const r = await api.importRun(id);
      announced.current[id] = 'RUNNING';
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
  /**
   * Nothing may be started while a file is on its way up.
   *
   * Not a safety guarantee — the server has those, and the one that matters is
   * that a run re-checks the digest of what it actually loaded. This is about
   * not offering a person a button whose result depends on which of two
   * requests lands first.
   */
  const uploading = uploadPct !== null;
  /**
   * «اعمال» only becomes real once a dry run has proven THIS import.
   *
   * The same rule the worker enforces, minus the half a browser cannot check.
   * It used to ask only «has any dry run of this file succeeded», which let a
   * dry run of `catalog` unlock an apply of `sales` — transforms that had never
   * been exercised, committing for real. Every selected domain must appear in
   * the domains that were actually proven.
   *
   * **This is a hint, not the gate.** The worker also compares the dump's
   * SHA-256, so a file replaced under the same name is refused there with a 409
   * that says so. The list does not carry that hash and a check written here
   * would be a second opinion the server never asked for — the browser cannot
   * know what is on disk now.
   */
  const proven = runs.some(
    (r) =>
      r.mode === 'DRY_RUN' &&
      r.status === 'SUCCEEDED' &&
      dir !== null &&
      r.dump_path.endsWith(file) &&
      domains.every((d) => r.domains.includes(d)),
  );

  return (
    <div>
      <div className="page-head">
        <h2>ایمپورت میرزابات</h2>
        <p className="muted">
          دادهٔ ربات قدیمی را از یک بکاپ MySQL به این پنل می‌آورد. فایل را همین‌جا آپلود کن یا با
          SCP روی سرور بگذار — هر دو به یک پوشه می‌روند.
        </p>
      </div>

      {err && <div className="alert-error">{err}</div>}
      {note && <div className="alert-info">{note}</div>}

      <div className="card">
        <h3>۱. فایل</h3>
        {dir && (
          <p className="muted">
            پوشه: <span className="ltr">{dir}</span>
          </p>
        )}

        <p className="muted">
          دامپ رمز پنل‌ها و کلید درگاه‌ها را رمزنشده دارد. روی سرور با دسترسی ۰۶۰۰ نوشته می‌شود و
          هیچ‌وقت دوباره خوانده و نمایش داده نمی‌شود.
        </p>
        <input
          ref={picker}
          type="file"
          accept=".sql,.sql.gz"
          className="form-control"
          disabled={running || uploading || busy}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
          {...w}
        />
        {uploadPct !== null && (
          <div style={{ marginTop: 10 }}>
            {/* `progress` rather than a div with a width. It is the element for
                this, it announces itself to a screen reader, and it needs no CSS. */}
            <progress value={uploadPct} max={1} style={{ width: '100%' }} />
            <p className="muted" style={{ marginTop: 4 }}>
              در حال آپلود — {count(Math.round(uploadPct * 100))}٪
            </p>
          </div>
        )}

        {files.length === 0 ? (
          <p className="muted">هنوز دامپی این‌جا نیست.</p>
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
            disabled={busy || running || uploading || !file}
            {...w}
          >
            بررسی
          </button>
          <button
            className="btn"
            onClick={() => void start('DRY_RUN')}
            disabled={busy || running || uploading || !file}
            {...w}
          >
            اجرای آزمایشی
          </button>
          {confirming ? (
            <>
              <button
                className="btn btn-danger"
                onClick={() => void start('APPLY')}
                // `proven` again, not just on the button that opened this.
                // The picker stays live while the confirmation is showing, so a
                // file chosen after «اعمال نهایی» was pressed could leave a
                // «بله، بنویس» armed for an import no dry run has proved. The
                // server refuses it either way; an enabled button that cannot
                // work is still a lie.
                disabled={busy || running || uploading || !proven}
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
              disabled={busy || running || uploading || !file || !proven}
              title={
                proven
                  ? undefined
                  : 'اول یک اجرای آزمایشی موفق روی همین فایل و همین بخش‌ها لازم است'
              }
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
          {running && <Progress run={active} />}
          <Report run={active} />
        </div>
      )}

      {active && <Samples run={active} />}

      <div className="card">
        <h3>اجراهای اخیر</h3>
        <p className="muted">
          «بازگرداندن» فقط ردیف‌هایی را که <em>همان اجرا</em> نوشته پاک می‌کند — نه یک
          بازگردانی کامل. هر خرید، پرداخت یا تغییری که بعد از ایمپورت انجام شده سرِ جایش
          می‌ماند. اگر چیزی که بعداً ساخته شده به یک ردیف واردشده وابسته باشد، کل کار
          برمی‌گردد و می‌گوید کدام جدول جلویش را گرفت.
        </p>
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
                  <th>برگرداندن</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{dateTime(r.started_at)}</td>
                    <td>{MODE_FA[r.mode]}</td>
                    <td>{STATUS_FA[r.status]}</td>
                    <td className="ltr">{basename(r.dump_path)}</td>
                    <td className="ltr">{r.started_by}</td>
                    <td>
                      {/* Only an APPLY that kept rows can be taken back, and only
                          once. Everything else says what it is rather than
                          offering a button that would be refused. */}
                      {r.undone_at ? (
                        <span className="muted">برگردانده شد</span>
                      ) : !r.undo_schema ? (
                        <span className="muted">—</span>
                      ) : undoing === r.id ? (
                        <>
                          <button
                            className="btn btn-danger"
                            onClick={() => void undo(r.id)}
                            disabled={busy || running}
                            {...w}
                          >
                            بله، برگردان
                          </button>{' '}
                          <button className="btn" onClick={() => setUndoing(null)}>
                            انصراف
                          </button>
                        </>
                      ) : (
                        <button
                          className="btn"
                          onClick={() => setUndoing(r.id)}
                          disabled={busy || running}
                          {...w}
                        >
                          بازگرداندن
                        </button>
                      )}
                    </td>
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
