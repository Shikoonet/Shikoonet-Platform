/**
 * «انتشار در کانال» (#473) — writing a post for the shop's channels.
 *
 * The order on the screen is the order of the job: write it, see it in the
 * reports group exactly as it will look, then send it now or at a time. The
 * send buttons stay off until the preview in the group matches what is on the
 * screen — the bot sends a copy of that preview, so a post changed after its
 * preview has to be previewed again.
 *
 * Below, every post: its state, and what can still be done with it. A post the
 * bot could not confirm stays «در حال ارسال» until somebody looks at the
 * channel and says — the one thing the tool this replaces got wrong.
 */

import { useEffect, useState } from 'react';
import { jalaliToIsoDate, toJalali, type JalaliDate } from '@shikoo/contracts';
import {
  api,
  ApiError,
  type CampaignFunnel,
  type ChannelPost,
  type ChannelPostOp,
  type PostButton,
  type PostStatus,
} from '../api.js';
import { DateField } from '../DateField.js';
import { count, dateTime } from '../format.js';
import { useAdminWriteProps } from '../role.js';

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'این کار فقط با نقش «مدیر» ممکن است.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

const STATUS_FA: Record<PostStatus, string> = {
  DRAFT: 'پیش‌نویس',
  SCHEDULED: 'در صف ارسال',
  SENDING: 'در حال ارسال',
  SENT: 'در کانال',
  FAILED: 'ناموفق',
};

const STYLE_FA: Record<NonNullable<PostButton['style']>, string> = {
  primary: 'آبی',
  success: 'سبز',
  danger: 'قرمز',
};

/** The words of a post without its HTML, for a table cell. */
const excerpt = (text: string) => {
  const plain = text.replace(/<[^>]*>/g, '').trim();
  return plain.length > 90 ? `${plain.slice(0, 90)}…` : plain || '—';
};

type List = Awaited<ReturnType<typeof api.channelPosts>>;

export function ChannelPostPage() {
  const [data, setData] = useState<List | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignFunnel[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [openId, setOpenId] = useState<number | 'new' | null>(null);
  const [reload, setReload] = useState(0);
  const write = useAdminWriteProps();

  useEffect(() => {
    let alive = true;
    api
      .channelPosts()
      .then((d) => alive && setData(d))
      .catch((e: unknown) => alive && setErr(message(e)));
    // For the buy button's campaign list. Its failure only empties that list.
    api
      .campaigns('all')
      .then((d) => alive && setCampaigns(d.items))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [reload]);

  // While something is on its way, the list follows it: «الان» becomes «در
  // کانال» within seconds, and nobody should have to press refresh to see it.
  const moving = data?.items.some(
    (p) => p.status === 'SCHEDULED' || (p.status === 'SENDING' && !p.stuck),
  );
  useEffect(() => {
    if (!moving) return;
    const t = setInterval(() => setReload((n) => n + 1), 5000);
    return () => clearInterval(t);
  }, [moving]);

  const refresh = () => setReload((n) => n + 1);

  async function act(run: () => Promise<unknown>, ok: string) {
    try {
      await run();
      setErr(null);
      setDone(ok);
      refresh();
    } catch (e) {
      setDone(null);
      setErr(message(e));
    }
  }

  const open = openId === 'new' ? null : (data?.items.find((p) => p.id === openId) ?? null);

  return (
    <>
      <div className="page-head">
        <div>
          <h2 className="page-head__title">انتشار در کانال</h2>
          <div className="page-head__sub">
            بنویس، در گروه گزارش ببین، بعد همین حالا یا سر ساعت به کانال بفرست.
          </div>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setOpenId('new')}
          {...write}
        >
          پست تازه
        </button>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-info">{done}</div>}

      {data && openId !== null && (openId === 'new' || open) && (
        <Composer
          key={openId}
          post={open}
          chats={data.chats}
          campaigns={campaigns}
          onClose={() => setOpenId(null)}
          onCreated={(id) => {
            setOpenId(id);
            refresh();
          }}
          onChanged={(msg) => {
            setErr(null);
            setDone(msg);
            refresh();
          }}
          onError={(msg) => {
            setDone(null);
            setErr(msg);
          }}
        />
      )}

      <div className="card">
        <div className="table-wrap">
          <table className="app-table">
            <thead>
              <tr>
                <th>پست</th>
                <th>کانال</th>
                <th>وضعیت</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data === null && !err && (
                <tr>
                  <td className="empty" colSpan={4}>
                    در حال بارگذاری…
                  </td>
                </tr>
              )}
              {data?.items.length === 0 && (
                <tr>
                  <td className="empty" colSpan={4}>
                    هنوز پستی نیست. «پست تازه» را بزن.
                  </td>
                </tr>
              )}
              {data?.items.map((p) => (
                <tr key={p.id}>
                  <td>
                    {excerpt(p.text)}
                    <div className="muted" style={{ fontSize: 11 }}>
                      {p.mediaKind === 'PHOTO'
                        ? 'با عکس · '
                        : p.mediaKind === 'VIDEO'
                          ? 'با ویدیو · '
                          : ''}
                      {count(p.buttons.flat().length)} دکمه
                      {p.campaignSlug ? ` · کمپین ${p.campaignSlug}` : ''}
                    </div>
                  </td>
                  <td>{p.chatTitle}</td>
                  <td>
                    <strong>{STATUS_FA[p.status]}</strong>
                    <div className="muted" style={{ fontSize: 11 }}>
                      {p.status === 'SCHEDULED' && p.sendAt !== null && dateTime(p.sendAt)}
                      {p.status === 'SENT' && p.sentAt !== null && dateTime(p.sentAt)}
                      {p.status === 'SENT' && !p.inChannel && ' — بدون شناسه، ویرایش‌پذیر نیست'}
                      {p.status === 'FAILED' && p.error}
                      {p.status === 'SENDING' &&
                        (p.stuck
                          ? 'جوابی از تلگرام نیامد — کانال را نگاه کن و بگو رسید یا نه.'
                          : 'همین الان…')}
                    </div>
                  </td>
                  <td>
                    <div
                      style={{
                        display: 'flex',
                        gap: 6,
                        justifyContent: 'flex-end',
                        flexWrap: 'wrap',
                      }}
                    >
                      {(p.status === 'DRAFT' ||
                        p.status === 'FAILED' ||
                        (p.status === 'SENT' && p.inChannel)) && (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setOpenId(p.id)}
                          {...write}
                        >
                          {p.status === 'SENT' ? 'ویرایش در کانال' : 'باز کن'}
                        </button>
                      )}
                      {p.status === 'SCHEDULED' && (
                        <button
                          type="button"
                          className="btn"
                          onClick={() =>
                            void act(
                              () => api.channelPostOp(p.id, { op: 'cancel' }),
                              'از صف بیرون آمد.',
                            )
                          }
                          {...write}
                        >
                          لغو
                        </button>
                      )}
                      {p.stuck && (
                        <>
                          <button
                            type="button"
                            className="btn"
                            onClick={() =>
                              void act(
                                () => api.channelPostOp(p.id, { op: 'resolve', inChannel: true }),
                                'ثبت شد که در کانال هست.',
                              )
                            }
                            {...write}
                          >
                            در کانال هست
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={() =>
                              void act(
                                () => api.channelPostOp(p.id, { op: 'resolve', inChannel: false }),
                                'ثبت شد که نرسید — می‌شود دوباره فرستاد.',
                              )
                            }
                            {...write}
                          >
                            نرسید
                          </button>
                        </>
                      )}
                      {p.status === 'SENT' && p.inChannel && (
                        <>
                          <button
                            type="button"
                            className="btn"
                            onClick={() =>
                              void act(
                                () => api.channelPostOp(p.id, { op: 'pin', pinned: true }),
                                'سنجاق شد.',
                              )
                            }
                            {...write}
                          >
                            سنجاق
                          </button>
                          <button
                            type="button"
                            className="btn"
                            onClick={() =>
                              void act(
                                () => api.channelPostOp(p.id, { op: 'pin', pinned: false }),
                                'سنجاق برداشته شد.',
                              )
                            }
                            {...write}
                          >
                            برداشتن سنجاق
                          </button>
                        </>
                      )}
                      {(p.status === 'SENT' || p.status === 'FAILED') && (
                        <button
                          type="button"
                          className="btn"
                          onClick={() =>
                            void act(async () => {
                              const r = await api.addChannelPost({ copyOf: p.id });
                              setOpenId(r.id);
                            }, 'پیش‌نویس تازه‌ای از روی این پست ساخته شد.')
                          }
                          {...write}
                        >
                          ارسال دوباره
                        </button>
                      )}
                      {p.status !== 'SENDING' && p.status !== 'SCHEDULED' && (
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            const where = p.status === 'SENT' && p.inChannel ? ' از کانال هم' : '';
                            if (!window.confirm(`این پست${where} حذف شود؟`)) return;
                            void act(() => api.deleteChannelPost(p.id), 'حذف شد.');
                          }}
                          {...write}
                        >
                          {p.status === 'SENT' && p.inChannel ? 'حذف از کانال' : 'حذف'}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function Composer({
  post,
  chats,
  campaigns,
  onClose,
  onCreated,
  onChanged,
  onError,
}: {
  /** The saved post, kept current by the page; null while a new one is unsaved. */
  post: ChannelPost | null;
  chats: Array<{ ref: string; title: string }>;
  campaigns: CampaignFunnel[];
  onClose: () => void;
  onCreated: (id: number) => void;
  onChanged: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const known = post ? String(post.chatId) : (chats[0]?.ref ?? '');
  const [chat, setChat] = useState(known || 'other');
  const [otherChat, setOtherChat] = useState('');
  const [text, setText] = useState(post?.text ?? '');
  const [rows, setRows] = useState<PostButton[][]>(post?.buttons ?? []);
  const [dirty, setDirty] = useState(post === null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [jDay, setJDay] = useState<JalaliDate>(() => toJalali(Date.now()));
  const [time, setTime] = useState('20:00');
  const write = useAdminWriteProps();

  const inChannel = post?.status === 'SENT';
  const chatRef = chat === 'other' ? otherChat.trim() : chat;
  const changed = (next: () => void) => {
    next();
    setDirty(true);
  };

  async function run(step: () => Promise<unknown>, ok: string) {
    setBusy(true);
    try {
      await step();
      onChanged(ok);
    } catch (e) {
      onError(message(e));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(
      async () => {
        if (post === null) {
          const r = await api.addChannelPost({ chat: chatRef, text, buttons: rows });
          setDirty(false);
          onCreated(r.id);
          return;
        }
        const op: ChannelPostOp = {
          op: 'edit',
          text,
          buttons: rows,
          ...(!inChannel && chatRef !== String(post.chatId) ? { chat: chatRef } : {}),
        };
        await api.channelPostOp(post.id, op);
        setDirty(false);
      },
      inChannel ? 'پست در کانال ویرایش شد.' : 'ذخیره شد — حالا پیش‌نمایش بگیر.',
    );

  const schedule = (sendAt: string | null) =>
    run(
      () => api.channelPostOp(post!.id, { op: 'schedule', sendAt }),
      sendAt === null ? 'در صف ارسال است — تا چند ثانیه در کانال.' : 'زمان‌بندی شد.',
    );

  const canSend =
    post !== null &&
    !dirty &&
    post.previewed &&
    (post.status === 'DRAFT' || post.status === 'FAILED');
  const campaignOptions = [
    ...campaigns.filter((c) => c.status === 'ACTIVE').map((c) => ({ slug: c.slug, name: c.name })),
    ...(post?.campaignSlug && !campaigns.some((c) => c.slug === post.campaignSlug)
      ? [{ slug: post.campaignSlug, name: 'کمپین همین پست' }]
      : []),
  ];

  return (
    <div className="card" style={{ marginBlockEnd: 16 }}>
      <div className="card__head">
        <div className="card__title">
          {post === null
            ? 'پست تازه'
            : inChannel
              ? `ویرایش پست در ${post.chatTitle}`
              : `پست #${post.id}`}
        </div>
        {post && (
          <span className="muted">
            {STATUS_FA[post.status]}
            {post.previewed && !dirty && !inChannel ? ' · پیش‌نمایش در گروه گزارش هست' : ''}
          </span>
        )}
      </div>

      <div className="filters">
        <div>
          <label className="form-label" htmlFor="post-chat">
            کانال
          </label>
          <select
            id="post-chat"
            className="form-control"
            value={chat}
            disabled={inChannel}
            onChange={(e) => changed(() => setChat(e.target.value))}
          >
            {chats.map((c) => (
              <option key={c.ref} value={c.ref}>
                {c.title}
              </option>
            ))}
            <option value="other">کانال دیگر…</option>
          </select>
        </div>
        {chat === 'other' && !inChannel && (
          <div>
            <label className="form-label" htmlFor="post-chat-other">
              @username یا شناسهٔ -100…
            </label>
            <input
              id="post-chat-other"
              className="form-control"
              dir="ltr"
              value={otherChat}
              placeholder="@shikoonet"
              onChange={(e) => changed(() => setOtherChat(e.target.value))}
            />
          </div>
        )}
      </div>

      <div style={{ marginBlockStart: 12 }}>
        <label className="form-label" htmlFor="post-text">
          متن (HTML: &lt;b&gt;، &lt;i&gt;، &lt;a href&gt;، &lt;tg-spoiler&gt;)
        </label>
        <textarea
          id="post-text"
          className="form-control"
          rows={8}
          value={text}
          onChange={(e) => changed(() => setText(e.target.value))}
        />
        <div className="muted" style={{ fontSize: 11 }}>
          {count(text.length)} کاراکتر — با عکس یا ویدیو حداکثر ۱۰۲۴، بدون آن ۴۰۹۶.
        </div>
      </div>

      {post !== null && !inChannel && (
        <div
          style={{
            marginBlockStart: 12,
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <span className="form-label" style={{ margin: 0 }}>
            {post.mediaKind === 'PHOTO'
              ? 'عکس دارد'
              : post.mediaKind === 'VIDEO'
                ? 'ویدیو دارد'
                : 'بدون عکس و ویدیو'}
          </span>
          <label className="btn" title={write.title}>
            {post.mediaKind === 'NONE' ? 'افزودن عکس یا ویدیو' : 'عوض کردن'}
            <input
              type="file"
              accept="image/*,video/*"
              hidden
              disabled={busy || write.disabled === true}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                void run(async () => {
                  setProgress(0);
                  try {
                    await api.uploadChannelPostMedia(post.id, file, setProgress);
                  } finally {
                    setProgress(null);
                  }
                }, 'فایل گذاشته شد — دوباره پیش‌نمایش بگیر.');
              }}
            />
          </label>
          {post.mediaKind !== 'NONE' && (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api.channelPostOp(post.id, { op: 'edit', removeMedia: true }),
                  'فایل برداشته شد.',
                )
              }
              {...write}
            >
              برداشتن فایل
            </button>
          )}
          {progress !== null && <span className="muted">{Math.round(progress * 100)}٪</span>}
        </div>
      )}

      <ButtonRows
        rows={rows}
        campaigns={campaignOptions}
        onChange={(next) => changed(() => setRows(next))}
      />

      {post !== null && !post.campaignSlug && (
        <p className="muted" style={{ marginBlockEnd: 0 }}>
          می‌خواهی ببینی این پست چند استارت و فروش آورد؟{' '}
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const r = await api.channelPostOp(post.id, { op: 'track' });
                if (r.campaign) {
                  setRows([
                    ...rows,
                    [{ text: '🛒 خرید سرویس', campaign: r.campaign, style: 'success' }],
                  ]);
                  setDirty(true);
                }
              }, 'کمپین این پست ساخته شد و دکمهٔ خرید اضافه شد — ذخیره کن.')
            }
            {...write}
          >
            ردیابی این پست
          </button>
        </p>
      )}

      <div
        style={{
          display: 'flex',
          gap: 8,
          marginBlockStart: 12,
          flexWrap: 'wrap',
          alignItems: 'end',
        }}
      >
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || !dirty || chatRef === ''}
          onClick={() => void save()}
          {...write}
        >
          {inChannel ? 'ذخیره در کانال' : 'ذخیره'}
        </button>
        {!inChannel && (
          <button
            type="button"
            className="btn"
            disabled={busy || dirty || post === null}
            title={dirty ? 'اول ذخیره کن' : undefined}
            onClick={() =>
              void run(
                () => api.previewChannelPost(post!.id),
                'پیش‌نمایش در گروه گزارش فرستاده شد — نگاهش کن.',
              )
            }
            {...write}
          >
            پیش‌نمایش در گروه گزارش
          </button>
        )}
        {!inChannel && (
          <>
            <button
              type="button"
              className="btn"
              disabled={busy || !canSend}
              title={canSend ? undefined : 'اول ذخیره و پیش‌نمایش'}
              onClick={() => void schedule(null)}
              {...write}
            >
              ارسال الان
            </button>
            {/* ponytail: DateField offers this year and the three before it, so a
                schedule cannot cross into the next Jalali year — fine within the
                90-day cap except in Esfand. Widen DateField if that bites. */}
            <DateField label="روز" value={jDay} onChange={setJDay} />
            <div>
              <label className="form-label" htmlFor="post-time">
                ساعت (تهران)
              </label>
              <input
                id="post-time"
                type="time"
                className="form-control"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </div>
            <button
              type="button"
              className="btn"
              disabled={busy || !canSend}
              // Tehran has kept +03:30 all year since 2022.
              onClick={() => void schedule(`${jalaliToIsoDate(jDay)}T${time}:00+03:30`)}
              {...write}
            >
              زمان‌بندی
            </button>
          </>
        )}
        <button type="button" className="btn" onClick={onClose}>
          بستن
        </button>
      </div>
    </div>
  );
}

/** Rows of buttons, as they will sit under the post. */
function ButtonRows({
  rows,
  campaigns,
  onChange,
}: {
  rows: PostButton[][];
  campaigns: Array<{ slug: string; name: string }>;
  onChange: (rows: PostButton[][]) => void;
}) {
  const setButton = (r: number, i: number, next: PostButton | null) =>
    onChange(
      rows
        .map((row, ri) =>
          ri !== r
            ? row
            : next === null
              ? row.filter((_, bi) => bi !== i)
              : row.map((b, bi) => (bi === i ? next : b)),
        )
        .filter((row) => row.length > 0),
    );
  const blank: PostButton = { text: '', url: 'https://' };

  return (
    <div style={{ marginBlockStart: 12 }}>
      <span className="form-label">دکمه‌ها</span>
      {rows.map((row, r) => (
        <div
          key={r}
          style={{
            border: '1px solid var(--border, #333)',
            borderRadius: 8,
            padding: 8,
            marginBlockEnd: 8,
          }}
        >
          <div className="muted" style={{ fontSize: 11, marginBlockEnd: 4 }}>
            ردیف {r + 1}
          </div>
          {row.map((b, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBlockEnd: 6 }}>
              <input
                aria-label="متن دکمه"
                className="form-control"
                style={{ flex: '1 1 150px', width: 'auto' }}
                value={b.text}
                placeholder="متن دکمه"
                onChange={(e) => setButton(r, i, { ...b, text: e.target.value })}
              />
              <select
                aria-label="نوع دکمه"
                className="form-control"
                style={{ flex: '0 0 130px', width: 'auto' }}
                value={b.campaign !== undefined ? 'campaign' : 'link'}
                onChange={(e) => {
                  const { url: _u, campaign: _c, ...rest } = b;
                  setButton(
                    r,
                    i,
                    e.target.value === 'campaign'
                      ? { ...rest, campaign: campaigns[0]?.slug ?? '' }
                      : { ...rest, url: 'https://' },
                  );
                }}
              >
                <option value="link">لینک</option>
                <option value="campaign">ربات با کمپین</option>
              </select>
              {b.campaign !== undefined ? (
                <select
                  aria-label="کمپین"
                  className="form-control"
                  style={{ flex: '2 1 200px', width: 'auto' }}
                  value={b.campaign}
                  onChange={(e) => setButton(r, i, { ...b, campaign: e.target.value })}
                >
                  {campaigns.length === 0 && <option value="">کمپینی نیست</option>}
                  {campaigns.map((c) => (
                    <option key={c.slug} value={c.slug}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  aria-label="لینک دکمه"
                  className="form-control"
                  style={{ flex: '2 1 200px', width: 'auto' }}
                  dir="ltr"
                  value={b.url ?? ''}
                  onChange={(e) => setButton(r, i, { ...b, url: e.target.value })}
                />
              )}
              <select
                aria-label="رنگ دکمه"
                className="form-control"
                style={{ flex: '0 0 120px', width: 'auto' }}
                value={b.style ?? ''}
                onChange={(e) => {
                  const { style: _s, ...rest } = b;
                  const v = e.target.value as PostButton['style'] | '';
                  setButton(r, i, v ? { ...rest, style: v } : rest);
                }}
              >
                <option value="">رنگ پیش‌فرض</option>
                {(Object.keys(STYLE_FA) as Array<keyof typeof STYLE_FA>).map((s) => (
                  <option key={s} value={s}>
                    {STYLE_FA[s]}
                  </option>
                ))}
              </select>
              <button type="button" className="btn" onClick={() => setButton(r, i, null)}>
                حذف
              </button>
            </div>
          ))}
          {row.length < 8 && (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => onChange(rows.map((x, ri) => (ri === r ? [...x, blank] : x)))}
            >
              + دکمه در این ردیف
            </button>
          )}
        </div>
      ))}
      <button type="button" className="btn btn-sm" onClick={() => onChange([...rows, [blank]])}>
        + ردیف تازه
      </button>
    </div>
  );
}
