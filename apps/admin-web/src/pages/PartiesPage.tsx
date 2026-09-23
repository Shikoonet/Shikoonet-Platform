/**
 * «اشخاص» — Sam, 2026-09-22: «بخشی بزار که بشه اشخاص رو معرفی کرد و در سیستم
 * حسابداری ازشون استفاده کرد» — «حسام، خودم، پویان».
 *
 * A person is anybody the books pay or are paid by: a partner, the server
 * company, a designer, an agent. One row each, with as many roles as he has,
 * because a partner who is also paid for work is still one person with one
 * account.
 *
 * The three figures on each row are lifetime and never netted, because they
 * are different money: a profit draw, an expense paid to him, and income that
 * came from him. «من چقدر گرفتم؟» is the first column. His share of the profit,
 * and what he is owed against it, is on «سود و زیان», which has a window.
 *
 * «ردیف‌ها» opens «هزینه‌ها» filtered to him — his statement — so the figures
 * here can always be traced to the rows they came from.
 *
 * There is no delete. A row paid to someone must always be able to say who;
 * «بایگانی» takes him out of the forms and keeps his history.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, PARTY_ROLE_FA, type Party, type PartyRole } from '../api.js';
import { count, dateOnly, toman } from '../format.js';
import { pathForPage } from '../route.js';

const ROLES = Object.keys(PARTY_ROLE_FA) as PartyRole[];

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'duplicate_name') return 'شخصی با همین نام هست.';
    if (e.code === 'shares_over_100') return `جمع سهم شرکا از ۱۰۰٪ بیشتر می‌شود (${e.detail ?? ''}٪).`;
    if (e.code === 'partner_has_draws')
      return 'این شخص برداشت سود ثبت‌شده دارد؛ نقش «شریک» را نمی‌شود از او گرفت. بایگانی‌اش کن.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

/** A share typed as «۳۳٫۳۴» or «33.34»; empty is none. */
function parseShare(v: string): number | null | 'bad' {
  const t = v.trim().replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))).replace('٫', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n <= 100 ? n : 'bad';
}

export function PartiesPage() {
  const [items, setItems] = useState<Party[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [editing, setEditing] = useState<Party | 'new' | null>(null);

  async function load() {
    try {
      setItems((await api.parties()).items);
    } catch (e) {
      setErr(message(e));
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const partners = (items ?? []).filter((p) => p.active && p.roles.includes('PARTNER'));
  const shared = partners.reduce((a, p) => a + (p.sharePercent ?? 0), 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">اشخاص</h2>
          <div className="page-head__sub">
            شرکا، تأمین‌کننده‌ها، همکارها و نماینده‌ها — هرکس که دفتر به او پول داده یا از او گرفته. مبلغ‌ها از
            شروع دفتر است.
          </div>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => setEditing('new')}>
          شخص تازه
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-info">{done}</div>}

      {editing && (
        <PartyForm
          row={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => {
            setEditing(null);
            setErr(null);
            setDone(msg);
            await load();
          }}
          onError={setErr}
        />
      )}

      {partners.length > 0 && (
        <p className="muted">
          سهم شرکا: {partners.map((p) => `${p.name} ${p.sharePercent === null ? '—' : `${count(p.sharePercent)}٪`}`).join(' · ')}
          {shared < 100 && partners.some((p) => p.sharePercent !== null)
            ? ` — ${count(Math.round((100 - shared) * 100) / 100)}٪ تقسیم نشده`
            : ''}
          . سهم هرکس از سود و مانده‌اش در «سود و زیان» است.
        </p>
      )}

      <div className="card">
        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>نام</th>
                <th>نقش</th>
                <th>
                  برداشت سود
                  <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>
                    سهمی که به‌عنوان شریک برداشته
                  </div>
                </th>
                <th>
                  پرداخت به او
                  <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>
                    هزینه: دستمزد، خرید، تسویه
                  </div>
                </th>
                <th>
                  دریافت از او
                  <div className="muted" style={{ fontSize: 11, fontWeight: 400 }}>
                    درآمد دستی
                  </div>
                </th>
                <th>آخرین ردیف</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items === null && (
                <tr>
                  <td className="empty" colSpan={7}>
                    در حال بارگذاری…
                  </td>
                </tr>
              )}
              {items?.length === 0 && (
                <tr>
                  <td className="empty" colSpan={7}>
                    هنوز کسی تعریف نشده. مثلاً خودت و شرکایت را با نقش «شریک» اضافه کن.
                  </td>
                </tr>
              )}
              {items?.map((p) => (
                <tr key={p.id} style={p.active ? undefined : { opacity: 0.55 }}>
                  <td>
                    <strong>{p.name}</strong>
                    {!p.active && <span className="muted"> (بایگانی)</span>}
                    {p.note && (
                      <div className="muted" style={{ fontSize: 11 }}>
                        {p.note}
                      </div>
                    )}
                  </td>
                  <td>
                    {p.roles.map((r) => PARTY_ROLE_FA[r]).join('، ') || '—'}
                    {p.sharePercent !== null && (
                      <div className="muted" style={{ fontSize: 11 }}>
                        سهم سود {count(p.sharePercent)}٪
                      </div>
                    )}
                  </td>
                  <td>{p.drawnIrr ? toman(p.drawnIrr) : '—'}</td>
                  <td>{p.paidIrr ? toman(p.paidIrr) : '—'}</td>
                  <td>{p.receivedIrr ? toman(p.receivedIrr) : '—'}</td>
                  <td>
                    {p.lastOn ? dateOnly(`${p.lastOn}T12:00:00Z`) : '—'}
                    <div className="muted" style={{ fontSize: 11 }}>
                      {count(p.rowCount)} ردیف
                    </div>
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      {/* A link, not a filter here: the statement is the ledger
                          itself, with its totals, export and edit buttons. */}
                      <a className="btn" href={`${pathForPage('expenses')}?party=${p.id}`}>
                        ردیف‌ها
                      </a>
                      <button type="button" className="btn" onClick={() => setEditing(p)}>
                        ویرایش
                      </button>
                      <button
                        type="button"
                        className="btn"
                        onClick={() =>
                          api
                            .editParty(p.id, { active: !p.active })
                            .then(async () => {
                              setDone(p.active ? 'بایگانی شد — ردیف‌هایش سر جایشان‌اند.' : 'دوباره فعال شد.');
                              await load();
                            })
                            .catch((e) => setErr(message(e)))
                        }
                      >
                        {p.active ? 'بایگانی' : 'فعال کن'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ marginBottom: 0 }}>
          هر سه ستون از روی ردیف‌های «هزینه‌ها» جمع می‌شوند و هیچ‌کدام ذخیره نمی‌شوند. برای اینکه برداشت کسی
          این‌جا دیده شود، ردیفش در «هزینه‌ها» باید نوع «برداشت شریک» و نام او را داشته باشد.
        </p>
      </div>
    </>
  );
}

function PartyForm({
  row,
  onClose,
  onSaved,
  onError,
}: {
  row: Party | null;
  onClose: () => void;
  onSaved: (msg: string) => void | Promise<void>;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState(row?.name ?? '');
  const [roles, setRoles] = useState<PartyRole[]>(row?.roles ?? []);
  const [share, setShare] = useState(row?.sharePercent == null ? '' : String(row.sharePercent));
  const [note, setNote] = useState(row?.note ?? '');
  const [busy, setBusy] = useState(false);
  const partner = roles.includes('PARTNER');

  async function submit() {
    if (!name.trim()) {
      onError('نام لازم است.');
      return;
    }
    const sharePercent = partner ? parseShare(share) : null;
    if (sharePercent === 'bad') {
      onError('سهم باید عددی بین ۰ و ۱۰۰ باشد.');
      return;
    }
    setBusy(true);
    try {
      const body = { name: name.trim(), roles, sharePercent, note: note.trim() };
      if (row) {
        await api.editParty(row.id, body);
        await onSaved('ذخیره شد.');
      } else {
        await api.addParty(body);
        await onSaved(`«${name.trim()}» اضافه شد — حالا در فرم «هزینه‌ها» قابل انتخاب است.`);
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
        <div className="card__title">{row ? `ویرایش ${row.name}` : 'شخص تازه'}</div>
      </div>
      <div className="filters">
        <div>
          <label className="form-label" htmlFor="party-name">
            نام
          </label>
          <input
            id="party-name"
            className="form-control"
            value={name}
            placeholder="مثلاً حسام، یا «هتزنر»"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <span className="form-label">نقش</span>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            {ROLES.map((r) => (
              <label key={r}>
                <input
                  type="checkbox"
                  checked={roles.includes(r)}
                  onChange={(e) => setRoles(e.target.checked ? [...roles, r] : roles.filter((x) => x !== r))}
                />{' '}
                {PARTY_ROLE_FA[r]}
              </label>
            ))}
          </div>
        </div>
        {partner && (
          <div>
            <label className="form-label" htmlFor="party-share">
              سهم از سود (٪، اختیاری)
            </label>
            <input
              id="party-share"
              className="form-control"
              inputMode="decimal"
              value={share}
              placeholder="مثلاً ۳۳٫۳۴"
              onChange={(e) => setShare(e.target.value)}
            />
          </div>
        )}
      </div>
      <div style={{ marginBlockStart: 12 }}>
        <label className="form-label" htmlFor="party-note">
          یادداشت (اختیاری)
        </label>
        <input id="party-note" className="form-control" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: 8, marginBlockStart: 12 }}>
        <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void submit()}>
          {row ? 'ذخیره' : 'اضافه کن'}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          انصراف
        </button>
      </div>
    </div>
  );
}
