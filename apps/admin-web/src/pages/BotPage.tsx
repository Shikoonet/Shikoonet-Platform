/**
 * «ربات» — which bot this shop is, and how to make it a different one.
 *
 * Every other operational fact about the shop grew a screen. This one did not:
 * the token lived in the process environment, so connecting a bot meant editing
 * Coolify and redeploying, and the panel could not even say which bot was
 * answering customers.
 *
 * Two questions, in this order, because they are asked in this order:
 *
 *   1. **Which bot is answering right now?** `connected` is what an operator
 *      chose here; `liveUsername` is what the running process reported to
 *      Telegram at its last boot. Both are drawn, and when they disagree the
 *      screen says so — that gap is exactly the window between saving a new
 *      token and the container coming back on it, and an operator who cannot
 *      see it will save twice.
 *   2. **How do I connect one?** One field, and the sentence about what
 *      happens next comes from the server rather than from here, so the screen
 *      and the API cannot end up promising different things.
 *
 * The token is never drawn. It is not fetched, there is no field on
 * `BotConnection` that could carry it, and the input is cleared the moment the
 * save succeeds — a token left sitting in a form is a token in a screenshot.
 */

import { useEffect, useState } from 'react';
import { api, ApiError, type BotConnection } from '../api.js';
import { useAdminWriteProps } from '../role.js';

export function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'وصل‌کردن ربات فقط با نقش «مدیر» ممکن است.';
    if (e.code === 'secret_key_missing')
      // THREE faults share this one code — the variable is unset, it is not
      // hex, or it is not 64 characters — and only `detail` says which.
      // Collapsing them into «تنظیم نشده» sends an operator to set a variable
      // that is already set, and the screen keeps saying the same thing while
      // they do it. `detail` names the variable and the exact fault, so it is
      // carried through rather than thrown away. It is English because
      // `SecretKeyMissing` writes it for whoever edits the service, and a
      // translation here would be a second place to keep in step.
      return `توکن جایی برای ذخیره‌شدن ندارد — ${e.detail ?? 'PANEL_SECRET_KEY روی این سرور تنظیم نشده است'}`;
    // The reports-group refusals. Each names the NEXT ACTION rather than the
    // fault, because every one of them is fixed in Telegram and not here — an
    // operator reading «گروه پیدا نشد» goes looking in the panel.
    if (e.code === 'no_bot') return 'اول باید رباتی وصل باشد — از همین صفحه، بالاتر.';
    if (e.code === 'chat_unreachable')
      return 'ربات این گروه را نمی‌بیند. اول ربات را به گروه اضافه کن و ادمینش کن، بعد دوباره بزن.';
    if (e.code === 'not_a_forum')
      return 'این گروه حالت تاپیک ندارد. در تنظیمات گروه تلگرام «Topics» را روشن کن، بعد دوباره بزن.';
    if (e.code === 'topic_failed')
      return `${e.detail ?? 'ساخت تاپیک انجام نشد'} — ربات باید در گروه ادمین باشد و اجازهٔ «Manage Topics» داشته باشد.`;
    if (e.code === 'bot_token_unreadable')
      return `توکن ذخیره‌شده باز نمی‌شود — ${e.detail ?? 'PANEL_SECRET_KEY عوض شده است'}`;
    // `bad_shape`, `rejected_by_telegram` and `telegram_unreachable` each send
    // their own Persian sentence; `detail` is what zod produced for anything
    // that never reached them.
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

/** Persian digits, the way the rest of the panel writes a number. */
const fa = (n: number | string) => String(n).replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]!);

const SOURCE_FA: Record<BotConnection['source'], string> = {
  dashboard: 'از همین داشبورد',
  environment: 'از متغیر محیطی سرویس',
  none: 'هیچ رباتی وصل نیست',
};

export function BotPage() {
  const w = useAdminWriteProps();
  const [data, setData] = useState<BotConnection | null>(null);
  const [token, setToken] = useState('');
  const [groupId, setGroupId] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    setErr(null);
    try {
      setData(await api.botConnection());
    } catch (e) {
      setErr(message(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const r = await api.setBotToken(token.trim());
      // Cleared before anything else can go wrong. The value has served its
      // purpose and there is no reason for it to stay in the DOM.
      setToken('');
      setDone(
        r.connected.username
          ? `ربات @${r.connected.username} وصل شد.`
          : `ربات ${fa(r.connected.botId)} وصل شد.`,
      );
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  /** A supergroup id: large and negative, which is what an operator pastes. */
  const groupValue = /^-[0-9]{6,19}$/.test(groupId.trim()) ? Number(groupId.trim()) : null;

  async function saveGroup() {
    if (groupValue === null) return;
    // Asked, because it is not undoable from here: the topics are created in
    // somebody's Telegram group and this screen has no button that removes
    // them. Re-running is safe and makes only what is missing — that is the
    // sentence worth showing, since «مطمئنید؟» alone teaches nothing.
    if (
      !window.confirm(
        `گزارش‌های فروشگاه به گروه ${fa(groupValue)} فرستاده شود؟ ` +
          `تاپیک‌های نداشته ساخته می‌شوند و تاپیک‌های موجود دست نمی‌خورند.`,
      )
    ) {
      return;
    }
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const r = await api.setReportGroup(groupValue);
      const made = Object.keys(r.created).length;
      setDone(
        made === 0
          ? 'گروه گزارش‌ها ذخیره شد — همهٔ تاپیک‌ها از قبل ساخته بودند.'
          : `گروه گزارش‌ها ذخیره شد و ${fa(made)} تاپیک ساخته شد.`,
      );
      setGroupId('');
      await load();
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  const live = data?.liveUsername ?? null;
  const chosen = data?.connected?.username ?? null;
  // Only a real disagreement, not the ordinary "nothing chosen here yet" case:
  // a shop still running on its environment variable has no `connected` row and
  // is not mid-handover.
  const restarting = chosen !== null && live !== null && chosen !== live;

  return (
    <div>
      <div className="page-head">
        <div>
          <div className="page-head__title">ربات تلگرام</div>
          <div className="page-head__sub">
            توکن را از @BotFather بگیر و همین‌جا بگذار. تلگرام قبل از ذخیره تایید می‌کند که توکن
            واقعاً مال یک ربات است — توکن غلط اصلاً ذخیره نمی‌شود.
          </div>
        </div>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-info">{done}</div>}

      <div className="card">
        <div className="card__head">
          <span className="card__title">کدام ربات جواب می‌دهد</span>
        </div>
        {data === null ? (
          <p className="muted">در حال خواندن…</p>
        ) : (
          <div className="table-wrap">
            <table className="app-table">
              <tbody>
                <tr>
                  <th>ربات انتخاب‌شده</th>
                  <td>
                    {data.connected ? (
                      <>
                        <bdi dir="ltr">
                          {data.connected.username ? `@${data.connected.username}` : '—'}
                        </bdi>
                        {data.connected.firstName ? ` · ${data.connected.firstName}` : ''}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
                <tr>
                  <th>رباتی که واقعاً بالا آمده</th>
                  <td>
                    {live ? <bdi dir="ltr">@{live}</bdi> : 'هنوز چیزی گزارش نکرده'}
                    {restarting && (
                      <span className="badge badge-warning" style={{ marginInlineStart: 8 }}>
                        در حال جابه‌جایی
                      </span>
                    )}
                  </td>
                </tr>
                <tr>
                  <th>منبع توکن</th>
                  <td>{SOURCE_FA[data.source]}</td>
                </tr>
                <tr>
                  <th>محیط</th>
                  <td>
                    <bdi dir="ltr">{data.envName}</bdi>
                  </td>
                </tr>
                {data.connected && (
                  <tr>
                    <th>آخرین تغییر</th>
                    <td>
                      {data.connected.setBy ?? '—'} · {data.connected.updatedAt.slice(0, 16)}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}
        {restarting && (
          <p className="muted">
            توکن تازه ذخیره شده و ربات قدیمی هنوز در حال بسته‌شدن است. {data?.appliesAfter}
          </p>
        )}
      </div>

      <div className="card" style={{ marginBlockStart: 16 }}>
        <div className="card__head">
          <span className="card__title">وصل‌کردن ربات</span>
        </div>
        <label className="form-label" htmlFor="bot-token">
          توکن BotFather
        </label>
        <input
          id="bot-token"
          className="form-control"
          // Not `text`. The value is a bearer credential and this screen is
          // opened in front of other people more often than anybody plans for.
          type="password"
          autoComplete="off"
          spellCheck={false}
          dir="ltr"
          placeholder="123456789:AA…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
        <p className="muted">
          {data?.appliesAfter ??
            'ربات کمی بعد از ذخیره خودش را می‌بندد و با ربات تازه بالا می‌آید.'}{' '}
          سفارش‌ها، کیف پول و مشتری‌ها دست نمی‌خورند — فقط رباتی که با آن‌ها حرف می‌زند عوض
          می‌شود. مشتری‌ها ربات تازه را باید خودشان <bdi dir="ltr">/start</bdi> کنند.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void save()}
          disabled={busy || token.trim().length < 20}
          {...w}
        >
          {busy ? 'در حال تایید با تلگرام…' : 'تایید و وصل کن'}
        </button>
      </div>

      {/*
        «گروه گزارش‌ها» is on THIS screen and not «تنظیمات» for the reason the
        token is: the settings screen lists rows into a browser and refuses any
        key that looks like a credential, and it cannot create a key that does
        not exist. This needs Telegram asked, topics created, and ten rows
        written — none of which a key/value grid can do.
      */}
      <div className="card" style={{ marginBlockStart: 16 }}>
        <div className="card__head">
          <span className="card__title">گروه گزارش‌ها</span>
          {data && (
            <span
              className={
                data.reportGroup.chatId === null ? 'badge badge-block' : 'badge badge-active'
              }
            >
              {data.reportGroup.chatId === null
                ? 'تنظیم نشده'
                : `${fa(data.reportGroup.configured)} از ${fa(data.reportGroup.topics.length)} تاپیک`}
            </span>
          )}
        </div>

        <p className="muted" style={{ marginBlockStart: 0 }}>
          گزارش‌های فروشگاه — خرید، مالی، اکانت تست، خدمات، خطا — در یک گروه تلگرام با تاپیک جدا
          برای هر کدام فرستاده می‌شوند. تا وقتی گروهی تنظیم نشده، <b>هیچ گزارشی فرستاده نمی‌شود</b>؛
          و تاپیکی که ساخته نشده باشد، گزارشش در تاپیک عمومی گروه می‌افتد نه اینکه گم شود.
        </p>

        {data && data.reportGroup.chatId !== null && (
          <div className="table-wrap">
            <table className="app-table">
              <thead>
                <tr>
                  <th>تاپیک</th>
                  <th>وضعیت</th>
                </tr>
              </thead>
              <tbody>
                {data.reportGroup.topics.map((t) => (
                  <tr key={t.kind}>
                    <td>{t.title}</td>
                    <td>
                      {t.threadId === null ? (
                        <span className="muted">ساخته نشده — در تاپیک عمومی</span>
                      ) : (
                        <bdi dir="ltr">#{fa(t.threadId)}</bdi>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <ol className="muted" style={{ marginBlockEnd: 8 }}>
          <li>
            یک گروه بساز و در تنظیماتش <bdi dir="ltr">Topics</bdi> را روشن کن.
          </li>
          <li>ربات را به گروه اضافه کن و ادمینش کن، با اجازهٔ ساخت تاپیک.</li>
          <li>
            آیدی عددی گروه را این‌جا بگذار — عددی منفی و بلند، مثل{' '}
            <bdi dir="ltr">-1001234567890</bdi>.
          </li>
        </ol>

        <label className="form-label" htmlFor="bot-report-group">
          آیدی عددی گروه
        </label>
        <input
          id="bot-report-group"
          className="form-control ltr"
          type="text"
          inputMode="numeric"
          spellCheck={false}
          dir="ltr"
          placeholder={
            data?.reportGroup.chatId === null || data === null
              ? '-1001234567890'
              : String(data.reportGroup.chatId)
          }
          value={groupId}
          onChange={(e) => setGroupId(e.target.value)}
        />
        <p className="muted">
          {data?.reportGroup.chatId === null
            ? 'دوباره زدن این دکمه امن است — فقط تاپیک‌های نداشته ساخته می‌شوند.'
            : 'گروه فعلی بالا نوشته شده. برای عوض‌کردنش آیدی تازه را بگذار؛ تاپیک‌های گروه قبلی پاک نمی‌شوند.'}
        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void saveGroup()}
          disabled={busy || groupValue === null}
          {...w}
        >
          {busy ? 'در حال ساخت تاپیک‌ها…' : 'تنظیم گروه و ساخت تاپیک‌ها'}
        </button>
      </div>
    </div>
  );
}
