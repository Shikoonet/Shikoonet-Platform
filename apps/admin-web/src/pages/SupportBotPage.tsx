/**
 * «محدودیت‌های ربات پشتیبانی» — who the support bot has stopped answering, and why.
 *
 * The bot answers each customer at most N times a Tehran day (the cap below), goes quiet for a week
 * in a chat that tried to break it, and steps back while a person handles a chat. This page lists
 * every chat the bot has seen with its reason, gives one back or all of them back, sets the cap,
 * and counts limited people and attack attempts day by day. The data is the bot's own, read live
 * from n8n by the server on every load (`/api/v1/admin/support-bot`).
 *
 * Asked by Sam, 2026-09-26: see who was limited, a button to give access back, messages sent and
 * answered, sort, filter, pages, «آزادسازی همه», per-day counts, attackers and their ids, and a
 * click through to the customer's own page.
 */

import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type SupportBotAttacker,
  type SupportBotChatRow,
  type SupportBotSort,
  type SupportBotStats,
  type SupportBotStatus,
} from '../api.js';
import { CustomerLink } from '../CustomerLink.js';
import { useAdminWriteProps } from '../role.js';
import { Stat } from '../Stat.js';
import { count, dateOnly, dateTime } from '../format.js';

const PAGE_SIZE = 25;

const STATUS: Record<SupportBotStatus, { label: string; badge: string }> = {
  attack: { label: 'حمله؛ ۷ روز بسته', badge: 'badge badge-block' },
  limit: { label: 'سقف روزانه', badge: 'badge badge-warning' },
  human: { label: 'با همکار', badge: 'badge badge-info' },
  ok: { label: 'فعال', badge: 'badge badge-active' },
};

function message(e: unknown): string {
  if (e instanceof ApiError) return e.detail ?? `خطا: ${e.code}`;
  return e instanceof Error ? e.message : String(e);
}

/** The shop customer's card when the chat is one; otherwise the chat in Telegram. */
function Who({ row }: { row: { chatId: number; userId: number | null; name: string; username: string } }) {
  return (
    <>
      {row.userId != null ? (
        <CustomerLink customer={{ id: row.userId, telegramId: row.chatId, username: row.username || null }} />
      ) : (
        <a className="ltr" href={`tg://user?id=${row.chatId}`} title="در فروشگاه نیست؛ باز کردن در تلگرام">
          {row.username ? `@${row.username}` : row.chatId}
        </a>
      )}
      {row.name && <div className="muted">{row.name}</div>}
    </>
  );
}

export function SupportBotPage() {
  const w = useAdminWriteProps();
  const [configured, setConfigured] = useState(true);
  const [rows, setRows] = useState<SupportBotChatRow[]>([]);
  const [stats, setStats] = useState<SupportBotStats | null>(null);
  const [attackers, setAttackers] = useState<SupportBotAttacker[]>([]);
  const [cap, setCap] = useState<number | null>(null);
  const [capInput, setCapInput] = useState('');
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'all' | 'limited' | SupportBotStatus>('all');
  const [sort, setSort] = useState<SupportBotSort>('last_seen');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const [withAttackers, setWithAttackers] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  // Only the last load asked for may draw; an older answer would land on newer controls.
  const seq = useRef(0);

  async function load(toPage = page) {
    const mine = ++seq.current;
    setLoading(true);
    setErr(null);
    try {
      const d = await api.supportBot({
        page: toPage,
        pageSize: PAGE_SIZE,
        status,
        sort,
        dir,
        ...(q.trim() ? { q: q.trim() } : {}),
      });
      if (mine !== seq.current) return;
      if (!d.configured) {
        setConfigured(false);
        setCap(null);
        return;
      }
      setConfigured(true);
      setRows(d.items);
      setStats(d.stats);
      setAttackers(d.attackers);
      setCap(d.cap);
      setCapInput((v) => v || String(d.cap));
      setTotal(d.total);
      setPages(d.pages);
      if (d.page !== toPage) setPage(d.page);
    } catch (e) {
      if (mine === seq.current) setErr(message(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
  }

  useEffect(() => {
    void load(page);
    // Not on `q`: it is typed and submitted, not applied per key.
  }, [page, status, sort, dir]);

  async function act(run: () => Promise<string>) {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      setDone(await run());
      await load(page);
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  const release = (chatId: number) =>
    act(async () => {
      const r = await api.releaseSupportBotChats([chatId]);
      return r.released > 0 ? 'ربات دوباره در این چت جواب می‌دهد.' : 'این چت در جدول ربات پیدا نشد.';
    });

  const releaseAll = () => {
    const what = withAttackers
      ? 'همهٔ چت‌هایی که ربات محدود کرده، حمله‌کننده‌ها هم،'
      : 'همهٔ چت‌هایی که به سقف روزانه رسیده‌اند (حمله‌کننده‌ها نه)';
    if (!window.confirm(`${what} دوباره به ربات سپرده شوند؟`)) return;
    void act(async () => {
      const r = await api.releaseAllSupportBotChats(withAttackers);
      return r.released > 0 ? `${count(r.released)} چت آزاد شد.` : 'چت محدودی نبود.';
    });
  };

  const saveCap = () => {
    const n = Number(capInput);
    if (!Number.isInteger(n) || n < 1 || n > 500) {
      setErr('سقف روزانه باید عددی بین ۱ و ۵۰۰ باشد.');
      return;
    }
    void act(async () => {
      const r = await api.setSupportBotDailyCap(n);
      return `سقف روزانه ${count(r.cap)} جواب شد؛ از پیام بعدی هر مشتری اعمال می‌شود.`;
    });
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">محدودیت‌های ربات پشتیبانی</h2>
          <div className="page-head__sub">
            {cap != null ? `هر مشتری روزی ${count(cap)} جواب هوش مصنوعی · ${count(total)} چت در این فهرست` : '…'}
          </div>
        </div>
      </div>

      {!configured && (
        <div className="alert alert-info">
          ربات پشتیبانی هنوز به داشبورد وصل نشده است. نشانی و کلید «ShikooSup admin API» باید روی سرور
          (SUPPORT_BOT_ADMIN_URL و SUPPORT_BOT_ADMIN_SECRET) تنظیم شود.
        </div>
      )}
      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-info">{done}</div>}

      {configured && stats && (
        <div className="stats-grid">
          <Stat
            tone="tone-orange"
            icon="users"
            value={count(stats.limitedToday)}
            label="محدودشده به سقف امروز"
            foot={`الان ${count(stats.limitedNow)} نفر محدودند`}
          />
          <Stat
            tone="tone-danger"
            icon="ticket"
            value={count(stats.attacksTotal)}
            label="تلاش حمله"
            foot={`امروز ${count(stats.attacksToday)} · از ${count(stats.attackersTotal)} نفر · الان ${count(stats.attackBlockedNow)} بسته`}
          />
          <Stat tone="tone-blue" icon="send" value={count(stats.withPersonNow)} label="چت در دست همکار" />
          <Stat
            tone="tone-green"
            icon="list"
            value={count(stats.messages)}
            label="پیام به پشتیبانی"
            foot={`${count(stats.botReplies)} جواب از ربات · ${count(stats.contacts)} نفر`}
          />
        </div>
      )}

      {configured && (
        <div className="card">
          <div className="filters">
            <div>
              <label className="form-label" htmlFor="sb-cap">
                سقف روزانهٔ جواب برای هر مشتری
              </label>
              <input
                id="sb-cap"
                className="form-control ltr"
                type="number"
                min={1}
                max={500}
                value={capInput}
                onChange={(e) => setCapInput(e.target.value)}
                style={{ width: 96 }}
              />
            </div>
            <button type="button" className="btn" onClick={saveCap} disabled={busy || loading} {...w}>
              ذخیرهٔ سقف
            </button>
            <div className="grow" />
            <label className="muted">
              <input type="checkbox" checked={withAttackers} onChange={(e) => setWithAttackers(e.target.checked)} />{' '}
              حمله‌کننده‌ها هم آزاد شوند
            </label>
            <button type="button" className="btn btn-primary" onClick={releaseAll} disabled={busy || loading} {...w}>
              آزادسازی همه
            </button>
          </div>
        </div>
      )}

      {configured && (
        <div className="card">
          <form
            className="filters"
            onSubmit={(e) => {
              e.preventDefault();
              setPage(1);
              void load(1);
            }}
          >
            <div className="grow">
              <label className="form-label" htmlFor="sb-q">
                جست‌وجو
              </label>
              <input
                id="sb-q"
                className="form-control"
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="آیدی عددی، @نام‌کاربری یا اسم"
              />
            </div>
            <div>
              <label className="form-label" htmlFor="sb-status">
                وضعیت
              </label>
              <select
                id="sb-status"
                className="form-control"
                value={status}
                onChange={(e) => {
                  setStatus(e.target.value as typeof status);
                  setPage(1);
                }}
              >
                <option value="all">همه</option>
                <option value="limited">محدودشده‌ها (سقف یا حمله)</option>
                <option value="limit">سقف روزانه</option>
                <option value="attack">حمله</option>
                <option value="human">با همکار</option>
                <option value="ok">فعال</option>
              </select>
            </div>
            <div>
              <label className="form-label" htmlFor="sb-sort">
                ترتیب
              </label>
              <select
                id="sb-sort"
                className="form-control"
                value={sort}
                onChange={(e) => {
                  setSort(e.target.value as SupportBotSort);
                  setPage(1);
                }}
              >
                <option value="last_seen">آخرین پیام</option>
                <option value="first_seen">اولین پیام</option>
                <option value="msg_count">تعداد پیام</option>
                <option value="bot_replies">جواب‌های ربات</option>
                <option value="ai_count">مصرف امروز</option>
                <option value="human_until">پایان محدودیت</option>
                <option value="ticket_count">تعداد تیکت</option>
              </select>
            </div>
            <div>
              <label className="form-label" htmlFor="sb-dir">
                جهت
              </label>
              <select
                id="sb-dir"
                className="form-control"
                value={dir}
                onChange={(e) => {
                  setDir(e.target.value as 'asc' | 'desc');
                  setPage(1);
                }}
              >
                <option value="desc">بیشترین / تازه‌ترین اول</option>
                <option value="asc">کمترین / قدیمی‌ترین اول</option>
              </select>
            </div>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              جست‌وجو
            </button>
          </form>

          <div className="table-wrap">
            <table className="app-table">
              <thead>
                <tr>
                  <th>کاربر</th>
                  <th>آیدی عددی</th>
                  <th>وضعیت</th>
                  <th>محدود تا</th>
                  <th>پیام‌ها</th>
                  <th>جواب ربات</th>
                  <th>امروز</th>
                  <th>تیکت</th>
                  <th>آخرین پیام</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !loading && (
                  <tr>
                    <td className="empty" colSpan={10}>
                      چتی با این شرط‌ها پیدا نشد.
                    </td>
                  </tr>
                )}
                {rows.map((r) => (
                  <tr key={r.chatId}>
                    <td>
                      <Who row={r} />
                    </td>
                    <td className="ltr">{r.chatId}</td>
                    <td>
                      <span className={STATUS[r.status].badge}>{STATUS[r.status].label}</span>
                    </td>
                    <td>{r.heldUntil ? dateTime(r.heldUntil) : '—'}</td>
                    <td>{count(r.messages)}</td>
                    <td>{count(r.botReplies)}</td>
                    <td>
                      {count(r.aiToday)}
                      {cap != null && <span className="muted"> / {count(cap)}</span>}
                    </td>
                    <td>{count(r.tickets)}</td>
                    <td>{dateTime(r.lastSeen)}</td>
                    <td>
                      {r.status !== 'ok' && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => void release(r.chatId)}
                          disabled={busy}
                          {...w}
                        >
                          بازگرداندن دسترسی
                        </button>
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
              disabled={page <= 1 || loading}
              onClick={() => setPage(page - 1)}
            >
              قبلی
            </button>
            <span>
              صفحهٔ {count(page)} از {count(pages)}
            </span>
            <button
              type="button"
              className="btn btn-sm"
              disabled={page >= pages || loading}
              onClick={() => setPage(page + 1)}
            >
              بعدی
            </button>
          </div>
        </div>
      )}

      {configured && stats && (
        <div className="card">
          <h3 className="card__title">روز به روز (۱۴ روز اخیر)</h3>
          <div className="table-wrap">
            <table className="app-table">
              <thead>
                <tr>
                  <th>روز</th>
                  <th>افراد محدودشده به سقف</th>
                  <th>تلاش حمله</th>
                  <th>حمله‌کننده</th>
                </tr>
              </thead>
              <tbody>
                {[...stats.byDay].reverse().map((d) => (
                  <tr key={d.day}>
                    <td>{dateOnly(d.day)}</td>
                    <td>{count(d.limited)}</td>
                    <td>{count(d.attacks)}</td>
                    <td>{count(d.attackers)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {configured && stats && (
        <div className="card">
          <h3 className="card__title">کسانی که قصد حمله داشتند</h3>
          <div className="table-wrap">
            <table className="app-table">
              <thead>
                <tr>
                  <th>کاربر</th>
                  <th>آیدی عددی</th>
                  <th>دفعات</th>
                  <th>آخرین تلاش</th>
                  <th>آخرین پیام</th>
                  <th>وضعیت</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {attackers.length === 0 && (
                  <tr>
                    <td className="empty" colSpan={7}>
                      تا حالا تلاشی برای حمله ثبت نشده است.
                    </td>
                  </tr>
                )}
                {attackers.map((a) => (
                  <tr key={a.chatId}>
                    <td>
                      <Who row={a} />
                    </td>
                    <td className="ltr">{a.chatId}</td>
                    <td>{count(a.attempts)}</td>
                    <td>{dateTime(a.lastAt)}</td>
                    <td className="ltr" style={{ maxWidth: 320, overflowWrap: 'anywhere' }}>
                      {a.lastText}
                    </td>
                    <td>
                      <span className={a.blockedNow ? STATUS.attack.badge : STATUS.ok.badge}>
                        {a.blockedNow ? 'هنوز بسته' : 'آزاد'}
                      </span>
                    </td>
                    <td>
                      {a.blockedNow && (
                        <button
                          type="button"
                          className="btn btn-sm"
                          onClick={() => void release(a.chatId)}
                          disabled={busy}
                          {...w}
                        >
                          بازگرداندن دسترسی
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </>
  );
}
