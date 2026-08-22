/**
 * آموزش، برنامه‌ها و کانال‌ها — the three lists the bot reads and nobody could
 * edit.
 *
 * `help_articles` and `client_apps` came over with the migration and the bot has
 * read both since «آموزش» was built, but every change still had to be made in
 * the legacy admin panel. That was fine while the PHP was up and stops being
 * fine the moment it is switched off.
 *
 * Two things on this screen are deliberately not what the legacy panel does:
 *
 * Hiding and deleting are separate. Neither table has anything pointing at it,
 * so a delete would always succeed and there is no constraint to lean on the way
 * the catalogue has. `active` is what the bot filters on, so hiding is the
 * reversible step and the server refuses to delete a row a customer can still
 * open.
 *
 * There is no image field. `media_id` is a Telegram `file_id` from the OLD
 * bot's uploads and a file id belongs to the bot that uploaded it — pasting one
 * here produces a send that fails at Telegram with nothing on the screen to say
 * why. The list shows whether an image came over; re-uploading is a job for the
 * bot, not this form.
 */

import { useEffect, useState } from 'react';
import {
  api,
  ApiError,
  type ChannelRow,
  type ClientAppRow,
  type HelpArticleRow,
} from '../api.js';
import { count } from '../format.js';
import { useAdminWriteProps } from '../role.js';

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'admin_access_not_configured') return 'درِ دسترسی ادمین تنظیم نشده است.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

type Tab = 'articles' | 'apps' | 'channels';

/**
 * The third list is a gate rather than content, and it is here because it is the
 * same job: a row the bot reads on every update that no screen could write.
 *
 * What makes it different is that getting it wrong is silent. `gate.ts` fails
 * open on purpose — a Telegram that will not answer must not stop the shop
 * selling — so a `chat_ref` with a typo in it, or a bot that was never made an
 * administrator of the channel, produces a gate that never fires and is
 * indistinguishable from a shop where everybody is already a member. The server
 * refuses a shape `getChatMember` cannot take, and the note under the table says
 * the rest, because no amount of validation can check the admin bit.
 */

export function ContentPage() {
  const w = useAdminWriteProps();
  const [tab, setTab] = useState<Tab>('articles');
  const [articles, setArticles] = useState<HelpArticleRow[]>([]);
  const [apps, setApps] = useState<ClientAppRow[]>([]);
  const [channels, setChannels] = useState<ChannelRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<{ kind: Tab; id: number | null } | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const [a, b, ch] = await Promise.all([
        api.helpArticles(),
        api.clientApps(),
        api.requiredChannels(),
      ]);
      setArticles(a.items);
      setApps(b.items);
      setChannels(ch.items);
    } catch (e) {
      setErr(message(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function remove(kind: Tab, id: number, label: string): Promise<void> {
    if (!window.confirm(`«${label}» برای همیشه حذف شود؟`)) return;
    setErr(null);
    setDone(null);
    try {
      if (kind === 'articles') await api.deleteHelpArticle(id);
      else if (kind === 'apps') await api.deleteClientApp(id);
      else await api.deleteRequiredChannel(id);
      setDone('حذف شد.');
      await load();
    } catch (e) {
      setErr(message(e));
    }
  }

  async function toggleChannel(ch: ChannelRow): Promise<void> {
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

  const editingArticle =
    editing?.kind === 'articles' ? (articles.find((a) => a.id === editing.id) ?? null) : null;
  const editingApp =
    editing?.kind === 'apps' ? (apps.find((a) => a.id === editing.id) ?? null) : null;

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">آموزش، برنامه‌ها و کانال‌ها</div>
          <div className="page-head__sub">
            {count(articles.length)} مطلب · {count(apps.length)} برنامه ·{' '}
            {count(channels.filter((c) => c.active).length)} کانال اجباری
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setEditing({ kind: tab, id: null })}
          {...w}
        >
          {tab === 'articles' ? 'مطلب تازه' : tab === 'apps' ? 'برنامهٔ تازه' : 'کانال تازه'}
        </button>
      </div>

      <div className="card">
        {err && <div className="alert alert-error">{err}</div>}
        {done && <div className="alert alert-info">{done}</div>}

        <div className="filters">
          <button
            type="button"
            className={tab === 'articles' ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
            onClick={() => setTab('articles')}
          >
            بخش آموزش
          </button>
          <button
            type="button"
            className={tab === 'apps' ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
            onClick={() => setTab('apps')}
          >
            برنامه‌ها
          </button>
          <button
            type="button"
            className={tab === 'channels' ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
            onClick={() => setTab('channels')}
          >
            کانال اجباری
          </button>
        </div>

        {tab === 'channels' && (
          /**
           * The one thing this screen cannot check for the admin, said out
           * loud instead.
           *
           * `gate.ts` asks Telegram `getChatMember` for each active channel,
           * and a channel the bot is not an admin of throws. That is handled
           * carefully — three-valued, logged, open for that one request and
           * never latched — but the only trace is a line in the server log. So
           * a channel added with the bot not promoted lets every customer
           * through the membership gate for ever and looks «فعال» here.
           *
           * The panel holds no bot token and `required_channels` has no column
           * for a failed check, so this screen genuinely cannot know. What it
           * can do is stop the mistake being made in silence.
           */
          <p className="muted">
            ربات باید در هر کانالی که این‌جا اضافه می‌کنید <b>ادمین</b> باشد. اگر نباشد، نمی‌تواند
            عضویت را بررسی کند و گیت برای همه باز می‌ماند — بدون اینکه چیزی در این صفحه عوض شود.
          </p>
        )}

        <div className="table-wrap">
          {tab === 'channels' ? (
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
                        onClick={() => void toggleChannel(ch)}
                        {...w}
                      >
                        {ch.active ? 'خاموش کن' : 'روشن کن'}
                      </button>{' '}
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={ch.active}
                        title={ch.active ? 'اول خاموشش کنید' : ''}
                        onClick={() => void remove('channels', ch.id, ch.title)}
                        {...w}
                      >
                        حذف
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : tab === 'articles' ? (
            <table className="app-table">
              <thead>
                <tr>
                  <th>عنوان</th>
                  <th>دسته</th>
                  <th>طول متن</th>
                  <th>تصویر</th>
                  <th>ترتیب</th>
                  <th>وضعیت</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {articles.length === 0 && !loading && (
                  <tr>
                    <td className="empty" colSpan={7}>
                      هیچ مطلبی ثبت نشده است.
                    </td>
                  </tr>
                )}
                {articles.map((a) => (
                  <tr key={a.id}>
                    <td>{a.title}</td>
                    <td>{a.category ?? '—'}</td>
                    <td>{count(a.body.length)} نویسه</td>
                    <td>{a.hasMedia ? 'از ربات قدیمی' : '—'}</td>
                    <td>{count(a.sortOrder)}</td>
                    <td>
                      <span className={a.active ? 'badge badge-active' : 'badge badge-block'}>
                        {a.active ? 'نمایش' : 'پنهان'}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setEditing({ kind: 'articles', id: a.id })}
                      >
                        ویرایش
                      </button>{' '}
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={a.active}
                        title={a.active ? 'اول پنهانش کنید' : ''}
                        onClick={() => void remove('articles', a.id, a.title)}
                        {...w}
                      >
                        حذف
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <table className="app-table">
              <thead>
                <tr>
                  <th>نام</th>
                  <th>پلتفرم</th>
                  <th>لینک</th>
                  <th>ترتیب</th>
                  <th>وضعیت</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {apps.length === 0 && !loading && (
                  <tr>
                    <td className="empty" colSpan={6}>
                      هیچ برنامه‌ای ثبت نشده است.
                    </td>
                  </tr>
                )}
                {apps.map((a) => (
                  <tr key={a.id}>
                    <td>{a.name}</td>
                    <td>{a.platform ?? '—'}</td>
                    <td className="ltr">{a.link}</td>
                    <td>{count(a.sortOrder)}</td>
                    <td>
                      <span className={a.active ? 'badge badge-active' : 'badge badge-block'}>
                        {a.active ? 'نمایش' : 'پنهان'}
                      </span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => setEditing({ kind: 'apps', id: a.id })}
                      >
                        ویرایش
                      </button>{' '}
                      <button
                        type="button"
                        className="btn btn-sm"
                        disabled={a.active}
                        title={a.active ? 'اول پنهانش کنید' : ''}
                        onClick={() => void remove('apps', a.id, a.name)}
                        {...w}
                      >
                        حذف
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {tab === 'channels' && (
          <p className="muted">
            برای اینکه گیت واقعاً کار کند، ربات باید <b>ادمین آن کانال</b> باشد — بدون آن تلگرام
            به پرسش عضویت خطا می‌دهد، ربات عمداً همه را رد می‌کند، و گیت بی‌صدا هرگز شلیک نمی‌شود.
            هیچ اعتبارسنجی‌ای این را نمی‌تواند بررسی کند؛ فقط یک بار امتحان کردن با یک حساب غیرعضو.
          </p>
        )}

        <p className="muted">
          «پنهان» یعنی مشتری دیگر آن را نمی‌بیند و هر وقت خواستید برمی‌گردد. حذف فقط روی چیزی که از
          قبل پنهان شده انجام می‌شود — سرور هم همین را می‌گوید، نه فقط این دکمه.
        </p>
      </div>

      {editing?.kind === 'articles' && (editing.id === null || editingArticle) && (
        <ArticleEditor
          article={editingArticle}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {editing?.kind === 'channels' && editing.id === null && (
        <ChannelEditor
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {editing?.kind === 'apps' && (editing.id === null || editingApp) && (
        <AppEditor
          app={editingApp}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </>
  );
}

/** 3500 is the server's cap, and the reason is Telegram's 4096 per message. */
const BODY_MAX = 3500;

function ArticleEditor({
  article,
  onClose,
  onSaved,
}: {
  article: HelpArticleRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const w = useAdminWriteProps();
  const [title, setTitle] = useState(article?.title ?? '');
  const [category, setCategory] = useState(article?.category ?? '');
  const [body, setBody] = useState(article?.body ?? '');
  const [sortOrder, setSortOrder] = useState(String(article?.sortOrder ?? 0));
  const [active, setActive] = useState(article?.active ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.saveHelpArticle(article?.id ?? null, {
        title: title.trim(),
        category: category.trim() === '' ? null : category.trim(),
        body,
        sortOrder: Number(sortOrder) || 0,
        active,
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
        <span className="card__title">{article ? article.title : 'مطلب تازه'}</span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="art-title">
            عنوان
          </label>
          <input
            id="art-title"
            className="form-control"
            type="text"
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="art-cat">
            دسته
          </label>
          <input
            id="art-cat"
            className="form-control"
            type="text"
            maxLength={80}
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="art-sort">
            ترتیب
          </label>
          <input
            id="art-sort"
            className="form-control"
            type="number"
            min={0}
            max={9999}
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
          />
        </div>
      </div>

      <label className="form-label" htmlFor="art-body">
        متن — {count(body.length)} از {count(BODY_MAX)} نویسه
      </label>
      <textarea
        id="art-body"
        className="form-control"
        rows={10}
        maxLength={BODY_MAX}
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />

      <label className="form-label" style={{ display: 'block', marginBlockStart: 12 }}>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{' '}
        مشتری این مطلب را ببیند
      </label>

      <div className="filters" style={{ marginBlockStart: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || title.trim() === ''}
          onClick={() => void save()}
          {...w}
        >
          ذخیره
        </button>
      </div>
    </div>
  );
}

function AppEditor({
  app,
  onClose,
  onSaved,
}: {
  app: ClientAppRow | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const w = useAdminWriteProps();
  const [name, setName] = useState(app?.name ?? '');
  const [platform, setPlatform] = useState(app?.platform ?? '');
  const [link, setLink] = useState(app?.link ?? '');
  const [sortOrder, setSortOrder] = useState(String(app?.sortOrder ?? 0));
  const [active, setActive] = useState(app?.active ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.saveClientApp(app?.id ?? null, {
        name: name.trim(),
        platform: platform.trim() === '' ? null : platform.trim(),
        link: link.trim(),
        sortOrder: Number(sortOrder) || 0,
        active,
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
        <span className="card__title">{app ? app.name : 'برنامهٔ تازه'}</span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="app-name">
            نام
          </label>
          <input
            id="app-name"
            className="form-control"
            type="text"
            maxLength={120}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="app-platform">
            پلتفرم
          </label>
          <input
            id="app-platform"
            className="form-control"
            type="text"
            maxLength={40}
            value={platform}
            onChange={(e) => setPlatform(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="app-sort">
            ترتیب
          </label>
          <input
            id="app-sort"
            className="form-control"
            type="number"
            min={0}
            max={9999}
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
          />
        </div>
      </div>

      <label className="form-label" htmlFor="app-link">
        لینک دانلود — فقط http یا https
      </label>
      <input
        id="app-link"
        className="form-control ltr"
        type="url"
        maxLength={500}
        value={link}
        onChange={(e) => setLink(e.target.value)}
      />

      <label className="form-label" style={{ display: 'block', marginBlockStart: 12 }}>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{' '}
        مشتری این برنامه را ببیند
      </label>

      <div className="filters" style={{ marginBlockStart: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || name.trim() === '' || link.trim() === ''}
          onClick={() => void save()}
          {...w}
        >
          ذخیره
        </button>
      </div>
    </div>
  );
}

/**
 * Adding a channel, and refusing the paste that looks right.
 *
 * `https://t.me/shikoonet` is what an admin has in their clipboard and it is not
 * a `chat_id`: given to `getChatMember` it names a chat that does not exist, the
 * gate fails open on the error, and nothing anywhere says the feature stopped
 * working. The server refuses it; this refuses it before the round trip and says
 * which field it belongs in.
 *
 * Editing is deliberately absent. A channel has three fields and two of them are
 * its identity — changing `chat_ref` is not an edit, it is a different channel,
 * and doing it in place would silently move every customer's gate.
 */
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
