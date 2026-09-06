/**
 * «کرون‌جاب‌ها» — what the bot does on its own, and what stops it.
 *
 * There is no schedule on this screen and that is not an omission. Every sweep
 * runs inside the poll loop, one cycle every ~25 seconds; what decides whether
 * a customer is due is a threshold, not a cadence. Drawing «every 10 minutes»
 * boxes would describe a scheduler that does not exist.
 *
 * ## The two red cards
 *
 * Two jobs delete a paying customer's account from a panel and cannot be
 * undone. They are drawn apart from the rest, with the report-only switch above
 * them, because the difference between «stop warning people» and «start
 * deleting services» is the one an operator must not have to infer from a
 * uniform list of toggles.
 *
 * ## The texts are links, not fields
 *
 * Each job names the messages it sends and this screen links to them in
 * «متن‌های ربات». They are not editable here: two doors onto one sentence
 * become two versions of it, and the other door already exists.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type CronJobRow } from '../api.js';
import { count } from '../format.js';
import { useAdminWriteProps } from '../role.js';
import type { PageId } from '../nav.js';

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'out_of_range') return 'عدد بیرون از بازهٔ مجاز است.';
    if (e.code === 'setting_not_installed') {
      return 'این تنظیم روی این دیتابیس نصب نشده — مهاجرت ۰۰۵۷ اجرا نشده است.';
    }
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

/** «۳ ساعت پیش», or «هنوز کاری نکرده» when the events say nothing. */
function actedLabel(row: CronJobRow): string {
  if (!row.lastActed) return 'در ۳۰ روز گذشته کاری نکرده';
  const ms = Date.now() - new Date(row.lastActed.at).getTime();
  const mins = Math.floor(ms / 60_000);
  const when =
    mins < 1
      ? 'همین حالا'
      : mins < 60
        ? `${count(mins)} دقیقه پیش`
        : mins < 1440
          ? `${count(Math.floor(mins / 60))} ساعت پیش`
          : `${count(Math.floor(mins / 1440))} روز پیش`;
  return `آخرین بار ${when} — ${count(row.lastActed.count)} مورد`;
}

export function CronPage({ onGo }: { onGo?: (page: PageId) => void }) {
  const w = useAdminWriteProps();
  const [rows, setRows] = useState<CronJobRow[]>([]);
  const [dryRun, setDryRun] = useState<{ key: string; on: boolean | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /**
   * What is currently typed in each number box, before the server has agreed.
   *
   * The boxes were uncontrolled (`defaultValue`) and that was wrong in exactly
   * one place — the place a live walk found. Type 900 into a field whose
   * maximum is 365, the server refuses, the error appears, and the box goes on
   * showing 900 while the shop still holds 45. An operator then reads a number
   * off this screen that the bot does not have, which is the whole failure this
   * screen exists to prevent.
   *
   * Cleared on every load, so whatever the server says is what is shown —
   * after a refusal as well as after a save.
   */
  const [draft, setDraft] = useState<Record<string, string>>({});

  async function load() {
    setErr(null);
    try {
      const res = await api.cron();
      setRows(res.items);
      setDryRun(res.dryRun);
      setDraft({});
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load();
    // Once. Nothing on this screen changes without somebody on it pressing
    // something, and a poll would be a request every few seconds for a page an
    // operator opens twice a month.
  }, []);

  async function save(key: string, value: boolean | number) {
    setBusy(key);
    setErr(null);
    try {
      await api.updateCron({ key, value });
      // Reloaded rather than patched in place: the server is the one that
      // decided what was stored, and a screen that shows what it SENT after a
      // refusal is the screen that lies about a deletion switch.
      await load();
    } catch (e) {
      setErr(message(e));
      // And the box goes back to what the shop actually holds.
      //
      // Without this the refused number stays on screen: `load()` is inside the
      // try, so a rejection never reaches it, and the operator is left reading
      // «۹۰۰» off a field whose stored value is still 45. Only this key is
      // dropped — anything else half-typed elsewhere on the page is theirs.
      setDraft((d) => {
        const next = { ...d };
        delete next[key];
        return next;
      });
    } finally {
      setBusy(null);
    }
  }

  const ordinary = rows.filter((r) => !r.destructive);
  const destructive = rows.filter((r) => r.destructive);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <div className="page-head__title">کرون‌جاب‌ها</div>
          <div className="page-head__sub">
          کارهایی که ربات خودش انجام می‌دهد. زمان‌بندی جدا ندارند — هر دور از حلقهٔ ربات (حدود هر ۲۵
            ثانیه) اجرا می‌شوند و این عددها تعیین می‌کنند چه کسی موعدش رسیده.
          </div>
        </div>
      </div>

      {err && <div className="alert alert-error">{err}</div>}

      <section className="cron-list">
        {ordinary.map((row) => (
          <JobCard
            key={row.key}
            row={row}
            busy={busy}
            onSave={save}
            onGo={onGo}
            w={w}
            draft={draft}
            setDraft={setDraft}
          />
        ))}
      </section>

      {destructive.length > 0 && (
        <section className="cron-danger">
          <div className="page-head__title">کارهایی که سرویس مشتری را پاک می‌کنند</div>
          <div className="page-head__sub">
            این دو تنها چیزهایی در کل سیستم‌اند که اکانت مشتری را از پنل حذف می‌کنند و{' '}
            <strong>حذف برگشت‌پذیر نیست</strong>. ربات PHP هر دو را روشن دارد؛ ما پیش‌فرض خاموش
            گذاشتیم تا خودتان تصمیم بگیرید.
          </div>

          {dryRun && (
            <label className="cron-dryrun">
              <input
                type="checkbox"
                checked={dryRun.on ?? true}
                disabled={busy !== null || w.disabled === true}
                onChange={(e) => void save(dryRun.key, e.target.checked)}
              />
              <span>
                <strong>فقط گزارش بده، حذف نکن</strong>
                <br />
                <span className="page-head__sub">
                  روشن که باشد، این دو کار دقیقاً همان چیزی را که حذف می‌کردند در «رویدادها»
                  می‌نویسند و هیچ‌چیز را پاک نمی‌کنند. یک هفته گزارش را بخوانید، بعد خاموشش کنید.
                </span>
              </span>
            </label>
          )}

          {destructive.map((row) => (
            <JobCard
              key={row.key}
              row={row}
              busy={busy}
              onSave={save}
              onGo={onGo}
              w={w}
              draft={draft}
              setDraft={setDraft}
              danger
              dryRunOn={dryRun?.on ?? true}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function JobCard({
  row,
  busy,
  onSave,
  onGo,
  w,
  draft,
  setDraft,
  danger = false,
  dryRunOn = false,
}: {
  row: CronJobRow;
  busy: string | null;
  onSave: (key: string, value: boolean | number) => Promise<void>;
  onGo?: ((page: PageId) => void) | undefined;
  w: { disabled?: true; title?: string };
  draft: Record<string, string>;
  setDraft: (f: (d: Record<string, string>) => Record<string, string>) => void;
  danger?: boolean;
  dryRunOn?: boolean;
}) {
  return (
    <article className={danger ? 'card cron-card cron-card-danger' : 'card cron-card'}>
      <div className="cron-card-head">
        <div>
          <div className="page-head__title">{row.name}</div>
          <div className="page-head__sub">{row.what}</div>
        </div>
        {row.toggle ? (
          <label className="cron-switch" title={w.title}>
            <input
              type="checkbox"
              aria-label={`${row.name} — روشن/خاموش`}
              checked={row.toggle.on ?? false}
              disabled={busy !== null || w.disabled === true}
              onChange={(e) => void onSave(row.toggle!.key, e.target.checked)}
            />
            <span>{row.toggle.on ? 'روشن' : 'خاموش'}</span>
          </label>
        ) : (
          // Said rather than shown as a disabled switch, because a greyed-out
          // toggle reads as «you may not change this» when the truth is «there
          // is nothing to change».
          <span className="cron-always page-head__sub">همیشه روشن</span>
        )}
      </div>

      {danger && row.toggle?.on && dryRunOn && (
        <p className="cron-note">
          روشن است ولی چون «فقط گزارش بده» فعال است، چیزی حذف نمی‌شود — فقط در «رویدادها» می‌نویسد.
        </p>
      )}
      {danger && row.toggle?.on && !dryRunOn && (
        <p className="cron-note cron-note-danger">
          ⚠️ این کار همین حالا سرویس مشتری را از پنل حذف می‌کند.
        </p>
      )}

      {row.numbers.map((n) => (
        <div className="cron-number" key={n.key}>
          <label htmlFor={`cron-${n.key}`}>{n.label}</label>
          <input
            id={`cron-${n.key}`}
            type="number"
            min={n.min}
            max={n.max}
            value={draft[n.key] ?? (n.value === null ? '' : String(n.value))}
            disabled={busy !== null || w.disabled === true}
            title={w.title}
            onChange={(e) => {
              const typed = e.target.value;
              setDraft((d) => ({ ...d, [n.key]: typed }));
            }}
            // Saved on blur rather than on every keystroke: a field that saves
            // as you type sends «3», «30», «300» — and «300» may be out of
            // range and refused, leaving the admin looking at an error for a
            // value they were in the middle of not typing.
            onBlur={(e) => {
              const v = Number(e.target.value);
              if (Number.isSafeInteger(v) && v !== n.value) void onSave(n.key, v);
            }}
          />
          <span className="page-head__sub">{n.unit}</span>
        </div>
      ))}

      <footer className="cron-card-foot page-head__sub">
        <span>{actedLabel(row)}</span>
        {row.texts.length > 0 && onGo && (
          <button type="button" className="link" onClick={() => onGo('texts')}>
            متنش را در «متن‌های ربات» ببین
          </button>
        )}
      </footer>
    </article>
  );
}
