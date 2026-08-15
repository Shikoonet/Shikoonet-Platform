/**
 * آموزش و برنامه‌ها — the two lists the bot draws and nobody could edit.
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
  type ClientAppRow,
  type HelpArticleRow,
} from '../api.js';
import { count } from '../format.js';

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'admin_access_not_configured') return 'درِ دسترسی ادمین تنظیم نشده است.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

type Tab = 'articles' | 'apps';

export function ContentPage() {
  const [tab, setTab] = useState<Tab>('articles');
  const [articles, setArticles] = useState<HelpArticleRow[]>([]);
  const [apps, setApps] = useState<ClientAppRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<{ kind: Tab; id: number | null } | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const [a, b] = await Promise.all([api.helpArticles(), api.clientApps()]);
      setArticles(a.items);
      setApps(b.items);
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
      else await api.deleteClientApp(id);
      setDone('حذف شد.');
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
          <div className="page-head__title">آموزش و برنامه‌ها</div>
          <div className="page-head__sub">
            {count(articles.length)} مطلب · {count(apps.length)} برنامه
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setEditing({ kind: tab, id: null })}
        >
          {tab === 'articles' ? 'مطلب تازه' : 'برنامهٔ تازه'}
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
        </div>

        <div className="table-wrap">
          {tab === 'articles' ? (
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
        >
          ذخیره
        </button>
      </div>
    </div>
  );
}
