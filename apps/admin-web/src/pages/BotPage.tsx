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
    </div>
  );
}
