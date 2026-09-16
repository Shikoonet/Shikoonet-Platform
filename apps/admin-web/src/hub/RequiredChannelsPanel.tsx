/**
 * عضویت اجباری در کانال — the channels a customer must join before the bot
 * will talk to them, and what the admin has to do for that to actually work.
 *
 * Sam, 2026-09-16: «بخشی رو به تنظیمات اضافه کن که ادمین بتونه اسم کانال‌ها رو
 * بنویسه و از اونجا راهنمایی بشه». The list and the add form used to live only
 * under «آموزش، برنامه‌ها و کانال‌ها», a page an operator looking for a
 * SETTING never opens. One component, drawn on «تنظیمات» and kept on that
 * page too, so there is one list rather than two.
 *
 * The guide is not decoration. `gate.ts` fails OPEN: a channel the bot is not
 * an admin of makes Telegram refuse the membership question, the bot treats
 * «unanswered» as «let them through», and the row here still reads «فعال».
 * Nothing on the panel can detect that, so the steps are the only defence.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type ChannelRow } from '../api.js';
import { count } from '../format.js';
import { useAdminWriteProps } from '../role.js';

function message(e: unknown): string {
  if (e instanceof ApiError) return e.detail ?? e.message;
  return e instanceof Error ? e.message : String(e);
}

export function RequiredChannelsPanel() {
  const w = useAdminWriteProps();
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const [ch, bot] = await Promise.all([
        api.requiredChannels(),
        // Names the running bot in step 2. Optional: the list must draw even
        // when the bot has not been connected yet.
        api.botConnection().catch(() => null),
      ]);
      setChannels(ch.items);
      setBotUsername(bot?.liveUsername ?? bot?.connected?.username ?? null);
    } catch (e) {
      setErr(message(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggle(ch: ChannelRow): Promise<void> {
    setErr(null);
    setDone(null);
    try {
      await api.setRequiredChannelActive(ch.id, !ch.active);
      setDone(ch.active ? 'کانال خاموش شد.' : 'کانال روشن شد.');
      await load();
    } catch (e) {
      setErr(message(e));
    }
  }

  async function remove(ch: ChannelRow): Promise<void> {
    if (!window.confirm(`«${ch.title}» برای همیشه حذف شود؟`)) return;
    setErr(null);
    setDone(null);
    try {
      await api.deleteRequiredChannel(ch.id);
      setDone('حذف شد.');
      await load();
    } catch (e) {
      setErr(message(e));
    }
  }

  const active = channels.filter((c) => c.active).length;
  const bot = botUsername ? `@${botUsername}` : 'ربات';

  return (
    <div className="card">
      <div className="card__head">
        <span className="card__title">عضویت اجباری در کانال</span>
        <span className="muted">
          {active === 0 ? 'خاموش — کانالی ثبت نشده' : `${count(active)} کانال فعال`}
        </span>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => setAdding(true)}
          {...w}
        >
          کانال تازه
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-success">{done}</div>}

      <ol className="muted" style={{ paddingInlineStart: 20, marginBlock: 8 }}>
        <li>کانال را بسازید یا همان کانال موجود را در نظر بگیرید (عمومی یا خصوصی، فرقی ندارد).</li>
        <li>
          <b>{bot}</b> را در آن کانال <b>ادمین</b> کنید. بدون این، تلگرام به ربات نمی‌گوید چه
          کسی عضو است و ربات همه را رد می‌کند — یعنی گیت برای همه باز می‌ماند و این صفحه هم
          چیزی نشان نمی‌دهد.
        </li>
        <li>
          با «کانال تازه» شناسهٔ کانال (<span className="ltr">@username</span> یا برای کانال خصوصی
          عدد <span className="ltr">-100…</span>) و لینک عضویت را بنویسید.
        </li>
        <li>
          با یک حساب تلگرام که عضو کانال نیست ربات را استارت کنید: باید پیام «ابتدا عضو شوید» را
          با دکمهٔ کانال ببینید. تا این را ندیده‌اید، گیت را روشن ندانید.
        </li>
      </ol>
      <p className="muted">
        ربات عضویت را روی هر پیام می‌پرسد، نه فقط روی /start، و هر یک ساعت دوباره می‌پرسد — پس
        کسی که بعداً کانال را ترک کند هم دوباره پشت در می‌ماند.
      </p>

      <div className="table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              <th>نام کانال</th>
              <th>شناسه</th>
              <th>لینک عضویت</th>
              <th>وضعیت</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {channels.length === 0 && !loading && (
              <tr>
                <td className="empty" colSpan={5}>
                  هیچ کانال اجباری‌ای ثبت نشده — گیت عضویت خاموش است.
                </td>
              </tr>
            )}
            {channels.map((ch) => (
              <tr key={ch.id}>
                <td>{ch.title}</td>
                <td className="ltr">{ch.chatRef}</td>
                <td className="ltr">{ch.joinLink}</td>
                <td>
                  <span className={ch.active ? 'badge badge-active' : 'badge badge-block'}>
                    {ch.active ? 'فعال' : 'خاموش'}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => void toggle(ch)}
                    {...w}
                  >
                    {ch.active ? 'خاموش کن' : 'روشن کن'}
                  </button>{' '}
                  {/* Deleting an active channel would drop the gate for every
                      customer between one press and the admin noticing. Two
                      presses, and the first one is reversible. The server
                      refuses the same thing. */}
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={ch.active}
                    title={ch.active ? 'اول خاموشش کنید' : ''}
                    onClick={() => void remove(ch)}
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

      {adding && (
        <ChannelEditor
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            setDone('کانال اضافه شد — حالا با یک حساب غیرعضو امتحانش کنید.');
            void load();
          }}
        />
      )}
    </div>
  );
}

function ChannelEditor({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const w = useAdminWriteProps();
  const [title, setTitle] = useState('');
  const [chatRef, setChatRef] = useState('');
  const [joinLink, setJoinLink] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ref = chatRef.trim();
  const refOk = /^(@[A-Za-z0-9_]{4,32}|-100\d{5,17})$/.test(ref);
  const linkOk = /^https?:\/\//i.test(joinLink.trim());

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.addRequiredChannel({
        title: title.trim(),
        chatRef: ref,
        joinLink: joinLink.trim(),
      });
      onSaved();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ marginBlockStart: 16 }}>
      <div className="card__head">
        <span className="card__title">کانال اجباری تازه</span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}

      <label className="form-label" htmlFor="ch-title">
        نامی که روی دکمه می‌آید
      </label>
      <input
        id="ch-title"
        className="form-control"
        type="text"
        maxLength={200}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />

      <label className="form-label" htmlFor="ch-ref">
        شناسهٔ کانال
      </label>
      <input
        id="ch-ref"
        className="form-control ltr"
        type="text"
        placeholder="@shikoonet"
        value={chatRef}
        onChange={(e) => setChatRef(e.target.value)}
      />
      <div className="page-head__sub">
        {ref === '' || refOk
          ? 'به شکل @username یا عدد -100… — همان چیزی که تلگرام می‌پذیرد'
          : 'لینک t.me اینجا کار نمی‌کند. فقط @username یا عدد -100…'}
      </div>

      <label className="form-label" htmlFor="ch-link">
        لینک عضویت
      </label>
      <input
        id="ch-link"
        className="form-control ltr"
        type="url"
        placeholder="https://t.me/shikoonet"
        maxLength={500}
        value={joinLink}
        onChange={(e) => setJoinLink(e.target.value)}
      />
      <div className="page-head__sub">این همان چیزی است که دکمهٔ کانال بازش می‌کند.</div>

      <div className="filters" style={{ marginBlockStart: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || title.trim() === '' || !refOk || !linkOk}
          onClick={() => void save()}
          {...w}
        >
          افزودن
        </button>
      </div>
    </div>
  );
}
