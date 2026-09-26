/**
 * «کمپین‌ها» (#471) — which link brought a customer, and what they bought.
 *
 * A campaign is a slug in a deep link, `t.me/<bot>?start=c_<slug>`: put it on
 * an ad, a post, a story, and every customer who arrives through it is counted
 * — whether the start made them a customer, whether they bought within 30
 * days, and for how much.
 *
 * The tool this replaces showed one campaign two ways at once — the list
 * all-time, the panel the last 24 hours — and nobody could tell which to
 * believe. Here there is one range, above everything, and the list, the cards
 * and the chart all answer it.
 */

import { useEffect, useState } from 'react';
import { jalaliToIsoDate, toJalali, type JalaliDate } from '@shikoo/contracts';
import {
  api,
  ApiError,
  type CampaignDetail,
  type CampaignFunnel,
  type CampaignList,
  type StatsRange,
} from '../api.js';
import { BarChart } from '../BarChart.js';
import { CopyButton } from '../CopyButton.js';
import { Stat } from '../Stat.js';
import { count, dateOnly, toman, tomanCompact } from '../format.js';
import { useAdminWriteProps } from '../role.js';
import { RangeBar } from './StatsPage.js';

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'این کار فقط با نقش «مدیر» ممکن است.';
    if (e.code === 'slug_taken') return 'این شناسه قبلاً برای کمپین دیگری استفاده شده.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

const linkOf = (bot: string, slug: string) => `https://t.me/${bot}?start=c_${slug}`;

/** «۱۲» with «۵ جدید» under it — the two numbers every column is made of. */
function Split({ all, fresh, money = false }: { all: number; fresh: number; money?: boolean }) {
  return (
    <>
      {all === 0 ? '—' : money ? toman(all) : count(all)}
      {all > 0 && (
        <div className="muted" style={{ fontSize: 11 }}>
          {money ? `${toman(fresh)} از کاربر جدید` : `${count(fresh)} جدید`}
        </div>
      )}
    </>
  );
}

export function CampaignsPage() {
  const [range, setRange] = useState<StatsRange>('all');
  const [jDay, setJDay] = useState<JalaliDate>(() => toJalali(Date.now()));
  const [jFrom, setJFrom] = useState<JalaliDate>(() => toJalali(Date.now() - 30 * 86_400_000));
  const [jTo, setJTo] = useState<JalaliDate>(() => toJalali(Date.now()));
  const day = jalaliToIsoDate(range === 'between' ? jFrom : jDay);
  const to = range === 'between' ? jalaliToIsoDate(jTo) : undefined;

  const [data, setData] = useState<CampaignList | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<CampaignFunnel | 'new' | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const write = useAdminWriteProps();

  useEffect(() => {
    let alive = true;
    setBusy(true);
    api
      .campaigns(range, day, to)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setErr(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        // Not last range's rows under this range's buttons.
        setData(null);
        setErr(message(e));
      })
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [range, day, to, reload]);

  const bot = data?.botUsername ?? null;

  async function setStatus(c: CampaignFunnel, status: 'ACTIVE' | 'ARCHIVED') {
    try {
      await api.editCampaign(c.id, { status });
      setDone(
        status === 'ARCHIVED'
          ? `«${c.name}» بایگانی شد — لینکش هنوز شمرده می‌شود.`
          : 'دوباره فعال شد.',
      );
      setReload((n) => n + 1);
    } catch (e) {
      setErr(message(e));
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">کمپین‌ها</h2>
          <div className="page-head__sub">
            هر کمپین یک لینک ربات است: چند نفر با آن آمدند، چند نفر خریدند، و چقدر.
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setEditing('new')}
          {...write}
        >
          کمپین تازه
        </button>
      </div>

      <RangeBar
        range={range}
        onRange={setRange}
        jDay={jDay}
        onDay={setJDay}
        jFrom={jFrom}
        onFrom={setJFrom}
        jTo={jTo}
        onTo={setJTo}
      />

      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-info">{done}</div>}
      {data && bot === null && (
        <div className="alert alert-info">
          نام کاربری ربات هنوز ثبت نشده — ربات بار اول که روشن می‌شود آن را ثبت می‌کند. تا آن موقع
          لینک کمپین‌ها ساخته نمی‌شود.
        </div>
      )}

      {editing && (
        <CampaignForm
          // A new form per row: the fields are initial state, and without a key
          // switching «ویرایش» from A to B keeps A's values under B's title.
          key={editing === 'new' ? 'new' : editing.id}
          row={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(msg) => {
            setEditing(null);
            setErr(null);
            setDone(msg);
            setReload((n) => n + 1);
          }}
          onError={setErr}
        />
      )}

      <div className="card" style={{ opacity: busy ? 0.55 : 1, transition: 'opacity .15s' }}>
        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>کمپین</th>
                <th>استارت</th>
                <th>خریدار</th>
                <th>فروش</th>
                <th>لینک</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data === null && !err && (
                <tr>
                  <td className="empty" colSpan={6}>
                    در حال بارگذاری…
                  </td>
                </tr>
              )}
              {data?.items.length === 0 && (
                <tr>
                  <td className="empty" colSpan={6}>
                    هنوز کمپینی نیست. «کمپین تازه» یک لینک می‌سازد که می‌شود روی تبلیغ گذاشت.
                  </td>
                </tr>
              )}
              {data?.items.map((c) => (
                <tr key={c.id} style={c.status === 'ARCHIVED' ? { opacity: 0.55 } : undefined}>
                  <td>
                    <strong>{c.name}</strong>
                    {c.status === 'ARCHIVED' && <span className="muted"> (بایگانی)</span>}
                    <div className="muted" style={{ fontSize: 11 }} dir="ltr">
                      c_{c.slug}
                    </div>
                    {c.source && (
                      <div className="muted" style={{ fontSize: 11 }}>
                        {c.source}
                      </div>
                    )}
                  </td>
                  <td>
                    <Split all={c.starts} fresh={c.newUsers} />
                  </td>
                  <td>
                    <Split all={c.buyers} fresh={c.newBuyers} />
                  </td>
                  <td>
                    <Split all={c.revenueIrr} fresh={c.newRevenueIrr} money />
                  </td>
                  <td>
                    {bot && (
                      <CopyButton
                        label="کپی لینک"
                        title={linkOf(bot, c.slug)}
                        getText={() => linkOf(bot, c.slug)}
                      />
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setOpenId(openId === c.id ? null : c.id)}
                      >
                        {openId === c.id ? 'بستن' : 'جزئیات'}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setEditing(c)}
                        {...write}
                      >
                        ویرایش
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          void setStatus(c, c.status === 'ACTIVE' ? 'ARCHIVED' : 'ACTIVE')
                        }
                        {...write}
                      >
                        {c.status === 'ACTIVE' ? 'بایگانی' : 'فعال کن'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          فروش یعنی سفارش تکمیل‌شده (خرید، تمدید، حجم یا زمان اضافه) که ظرف ۳۰ روز بعد از آمدن همان
          مشتری ثبت شده؛ شارژ کیف پول و سرویس تست حساب نمی‌شوند، چون پولشان جای دیگری شمرده می‌شود.
          «جدید» کسی است که همان لینک او را مشتری کرد — کسانی که از قبل در ربات بودند، از جمله
          مشتری‌های ربات قدیمی، قدیمی شمرده می‌شوند. کسی که از دو کمپین آمده در هر دو شمرده می‌شود.
        </p>
      </div>

      {openId !== null && <Detail id={openId} range={range} day={day} to={to} reload={reload} />}
    </>
  );
}

function Detail({
  id,
  range,
  day,
  to,
  reload,
}: {
  id: number;
  range: StatsRange;
  day: string;
  to?: string | undefined;
  /** Bumped by the page after an edit, so the card is not a campaign's old name. */
  reload: number;
}) {
  const [data, setData] = useState<CampaignDetail | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    // Another campaign or another window: nothing of the last one on screen
    // while this one loads.
    setData(null);
    setErr(null);
    api
      .campaign(id, range, day, to)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setErr(null);
      })
      .catch((e: unknown) => alive && setErr(message(e)));
    return () => {
      alive = false;
    };
  }, [id, range, day, to, reload]);

  if (err) return <div className="alert alert-error">{err}</div>;
  if (!data) return <p className="muted">در حال بارگذاری…</p>;
  const c = data.campaign;

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <div>
          <div className="card__title">{c.name}</div>
          <div className="page-head__sub">
            ساخته‌شده {dateOnly(c.createdAt)}
            {c.note ? ` — ${c.note}` : ''}
          </div>
        </div>
      </div>
      <div className="stats-grid">
        <Stat
          tone="tone-blue"
          icon="users"
          value={count(c.starts)}
          label="استارت"
          foot={`${count(c.newUsers)} کاربر جدید`}
        />
        <Stat
          tone="tone-purple"
          icon="receipt"
          value={count(c.buyers)}
          label="خریدار"
          foot={`${count(c.newBuyers)} کاربر جدید`}
        />
        <Stat
          tone="tone-green"
          icon="money"
          value={tomanCompact(c.revenueIrr)}
          label="فروش"
          foot={`${tomanCompact(c.newRevenueIrr)} از کاربر جدید`}
        />
      </div>
      {data.chartCapped && (
        <p className="muted">نمودار ۱۲۰ روز آخرِ بازه را نشان می‌دهد؛ کارت‌های بالا کل بازه‌اند.</p>
      )}
      <BarChart
        title="استارت روزانه"
        series={data.byDay.map((d) => ({ label: dateOnly(d.day), value: d.starts }))}
        format={(v) => count(v)}
      />
      <BarChart
        title="فروش روزانه"
        series={data.byDay.map((d) => ({ label: dateOnly(d.day), value: d.revenueIrr }))}
        format={(v) => toman(v)}
      />
    </div>
  );
}

function CampaignForm({
  row,
  onClose,
  onSaved,
  onError,
}: {
  row: CampaignFunnel | null;
  onClose: () => void;
  onSaved: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const [slug, setSlug] = useState(row?.slug ?? '');
  const [name, setName] = useState(row?.name ?? '');
  const [source, setSource] = useState(row?.source ?? '');
  const [note, setNote] = useState(row?.note ?? '');
  const [busy, setBusy] = useState(false);
  const write = useAdminWriteProps();

  async function submit() {
    setBusy(true);
    try {
      const body = { name: name.trim(), source: source.trim(), note: note.trim() };
      if (row) {
        await api.editCampaign(row.id, body);
        onSaved('ذخیره شد.');
      } else {
        await api.addCampaign({ slug: slug.trim(), ...body });
        onSaved(`«${body.name}» ساخته شد — لینکش را از ستون «لینک» کپی کن.`);
      }
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBlockEnd: 16 }}>
      <div className="card__head">
        <div className="card__title">{row ? `ویرایش ${row.name}` : 'کمپین تازه'}</div>
      </div>
      <div className="filters">
        <div>
          <label className="form-label" htmlFor="campaign-slug">
            شناسه در لینک
          </label>
          <input
            id="campaign-slug"
            className="form-control"
            dir="ltr"
            value={slug}
            placeholder="spring-insta"
            disabled={row !== null}
            title={row ? 'شناسه روی تبلیغ چاپ شده و عوض نمی‌شود' : undefined}
            onChange={(e) => setSlug(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="campaign-name">
            نام
          </label>
          <input
            id="campaign-name"
            className="form-control"
            value={name}
            placeholder="تبلیغ اینستاگرام بهار"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="campaign-source">
            کجا (اختیاری)
          </label>
          <input
            id="campaign-source"
            className="form-control"
            value={source}
            placeholder="اینستاگرام، کانال فلان…"
            onChange={(e) => setSource(e.target.value)}
          />
        </div>
      </div>
      <div style={{ marginBlockStart: 12 }}>
        <label className="form-label" htmlFor="campaign-note">
          یادداشت (اختیاری)
        </label>
        <input
          id="campaign-note"
          className="form-control"
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </div>
      {!row && (
        <p className="muted" style={{ marginBlockEnd: 0 }}>
          شناسه ۳ تا ۶۲ حرف: انگلیسی کوچک، عدد و خط تیره. بعد از ساخت عوض نمی‌شود، چون روی تبلیغ چاپ
          می‌شود.
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, marginBlockStart: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy}
          onClick={() => void submit()}
          {...write}
        >
          {row ? 'ذخیره' : 'بساز'}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          انصراف
        </button>
      </div>
    </div>
  );
}
