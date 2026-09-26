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

import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type ClientAppRow,
  type HelpArticleRow,
  type SupportAnswerRow,
} from '../api.js';
import { RequiredChannelsPanel } from '../hub/RequiredChannelsPanel.js';
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

type Tab = 'articles' | 'apps' | 'channels' | 'answers';

/**
 * The third tab is a gate rather than content. It is drawn by
 * `RequiredChannelsPanel`, the same component «تنظیمات» shows — one list, two
 * doors, since 2026-09-16 when Sam asked for it under settings with a guide.
 */

export function ContentPage() {
  const w = useAdminWriteProps();
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
          <h2 className="page-head__title">آموزش، برنامه‌ها و کانال‌ها</h2>
          <div className="page-head__sub">
            {count(articles.length)} مطلب · {count(apps.length)} برنامه
          </div>
        </div>
        {(tab === 'articles' || tab === 'apps') && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => setEditing({ kind: tab, id: null })}
            {...w}
          >
            {tab === 'articles' ? 'مطلب تازه' : 'برنامهٔ تازه'}
          </button>
        )}
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
          <button
            type="button"
            className={tab === 'answers' ? 'btn btn-primary btn-sm' : 'btn btn-sm'}
            onClick={() => setTab('answers')}
          >
            پرسش و پاسخ پشتیبانی
          </button>
        </div>

        {tab === 'channels' && <RequiredChannelsPanel />}
        {tab === 'answers' && <SupportAnswers />}

        <div className="table-wrap" hidden={tab === 'channels' || tab === 'answers'}>
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

        {tab !== 'answers' && (
          <p className="muted">
            «پنهان» یعنی مشتری دیگر آن را نمی‌بیند و هر وقت خواستید برمی‌گردد. حذف فقط روی چیزی که
            از قبل پنهان شده انجام می‌شود — سرور هم همین را می‌گوید، نه فقط این دکمه.
          </p>
        )}
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

/**
 * «پرسش و پاسخ پشتیبانی» — what the support bot may tell a customer (0105).
 *
 * The support door hands every visible row to the bot on every message, so a
 * save here is live on the next question. The bot answers only from this list
 * and passes anything else to a person, so an answer is written the way it
 * should reach the customer. Hiding and deleting work as they do for «آموزش».
 */
function SupportAnswers() {
  const w = useAdminWriteProps();
  const [items, setItems] = useState<SupportAnswerRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<number | 'new' | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      setItems((await api.supportAnswers()).items);
    } catch (e) {
      setErr(message(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function remove(a: SupportAnswerRow): Promise<void> {
    if (!window.confirm(`«${a.question}» برای همیشه حذف شود؟`)) return;
    setErr(null);
    setDone(null);
    try {
      await api.deleteSupportAnswer(a.id);
      setDone('حذف شد.');
      await load();
    } catch (e) {
      setErr(message(e));
    }
  }

  const current = typeof editing === 'number' ? (items.find((i) => i.id === editing) ?? null) : null;
  const visible = items.filter((i) => i.active).length;
  const nextSort = items.reduce((m, i) => Math.max(m, i.sortOrder), 0) + 10;

  return (
    <>
      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-info">{done}</div>}

      <div className="filters">
        <span className="grow muted">
          {count(visible)} فعال · {count(items.length - visible)} پنهان
        </span>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={() => {
            setDone(null);
            setEditing('new');
          }}
          {...w}
        >
          پرسش و پاسخ تازه
        </button>
      </div>

      <div className="table-wrap">
        <table className="app-table">
          <thead>
            <tr>
              <th>پرسش</th>
              <th>جواب</th>
              <th>ترتیب</th>
              <th>نسخه</th>
              <th>وضعیت</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && !loading && (
              <tr>
                <td className="empty" colSpan={6}>
                  هیچ پرسش و پاسخی ثبت نشده است؛ ربات همهٔ سؤال‌ها را به اپراتور می‌سپارد.
                </td>
              </tr>
            )}
            {items.map((a) => (
              <tr key={a.id}>
                <td>{a.question}</td>
                <td>{a.answer.length > 90 ? `${a.answer.slice(0, 90)}…` : a.answer}</td>
                <td>{count(a.sortOrder)}</td>
                <td>{count(a.version)}</td>
                <td>
                  <span className={a.active ? 'badge badge-active' : 'badge badge-block'}>
                    {a.active ? 'فعال' : 'پنهان'}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setDone(null);
                      setEditing(a.id);
                    }}
                  >
                    ویرایش
                  </button>{' '}
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={a.active}
                    title={a.active ? 'اول پنهانش کنید' : ''}
                    onClick={() => void remove(a)}
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

      <p className="muted">
        ربات پشتیبانی فقط از جواب‌های «فعال» همین فهرست جواب می‌دهد و هر سؤال دیگری را به اپراتور
        می‌سپارد. هر ذخیره از پیام بعدی مشتری اثر دارد. هر ویرایش شمارهٔ نسخه را یکی بالا می‌برد و
        متن قبلی در گزارش تغییرات می‌ماند.
      </p>

      {(editing === 'new' || current) && (
        <AnswerEditor
          key={editing ?? 'none'}
          answer={current}
          sortOrder={nextSort}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setDone('ذخیره شد؛ ربات از پیام بعدی همین را می‌گوید.');
            void load();
          }}
        />
      )}
    </>
  );
}

/** The table's caps (0105): every visible answer rides in every prompt. */
const QUESTION_MAX = 300;
const ANSWER_MAX = 1500;

function AnswerEditor({
  answer,
  sortOrder: firstSort,
  onClose,
  onSaved,
}: {
  answer: SupportAnswerRow | null;
  sortOrder: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const w = useAdminWriteProps();
  const [question, setQuestion] = useState(answer?.question ?? '');
  const [text, setText] = useState(answer?.answer ?? '');
  const [sortOrder, setSortOrder] = useState(String(answer?.sortOrder ?? firstSort));
  const [active, setActive] = useState(answer?.active ?? true);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The form opens under a list that is usually longer than the screen. A block
  // body on purpose: Chrome's scrollIntoView now returns a Promise, and an effect
  // that returns one hands React a «cleanup» that throws when the form closes.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  }, []);

  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await api.saveSupportAnswer(answer?.id ?? null, {
        question: question.trim(),
        answer: text.trim(),
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
    <div className="card" style={{ marginBlockStart: 16 }} ref={box}>
      <div className="card__head">
        <span className="card__title">{answer ? answer.question : 'پرسش و پاسخ تازه'}</span>
        <button type="button" className="btn btn-sm" onClick={onClose}>
          بستن
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}

      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor="kb-question">
            پرسش — همان‌طور که مشتری می‌پرسد
          </label>
          <input
            id="kb-question"
            className="form-control"
            type="text"
            maxLength={QUESTION_MAX}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
          />
        </div>
        <div>
          <label className="form-label" htmlFor="kb-sort">
            ترتیب
          </label>
          <input
            id="kb-sort"
            className="form-control"
            type="number"
            min={0}
            max={9999}
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value)}
          />
        </div>
      </div>

      <label className="form-label" htmlFor="kb-answer">
        جواب — {count(text.length)} از {count(ANSWER_MAX)} نویسه
      </label>
      <textarea
        id="kb-answer"
        className="form-control"
        rows={6}
        maxLength={ANSWER_MAX}
        value={text}
        onChange={(e) => setText(e.target.value)}
      />

      <label className="form-label" style={{ display: 'block', marginBlockStart: 12 }}>
        <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />{' '}
        ربات از این جواب استفاده کند
      </label>

      <div className="filters" style={{ marginBlockStart: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || question.trim() === '' || text.trim() === ''}
          onClick={() => void save()}
          {...w}
        >
          ذخیره
        </button>
      </div>
    </div>
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
