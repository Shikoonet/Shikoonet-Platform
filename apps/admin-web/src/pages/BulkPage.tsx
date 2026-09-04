/**
 * ارسال گروهی — the two actions that reach every customer at once.
 *
 * These were the last two of the bot admin panel's twelve permissions with no
 * equivalent here. Nothing about them is new: `bulkRoutes.ts` calls the same
 * `creditEveryone` and `queueBroadcast` the bot calls, so the idempotency key,
 * the recipient snapshot and the append-only wallet entry are one
 * implementation. What is new is being able to do it from a keyboard.
 *
 * ## Why the id is generated here
 *
 * `batchId` is minted when this page mounts and sent with the request, rather
 * than by the server on arrival. A server-minted id would be new on every
 * attempt, so a double-submitted form or a request whose response was lost
 * would credit eleven thousand wallets a second time — the idempotency key
 * would never collide. Minted here, a retry is free. It is re-minted only after
 * a *successful* submit, so the next thing the operator sends is a new batch.
 *
 * ## Two steps, and the total in the middle
 *
 * Neither action has an undo, so neither is one click. The confirmation shows
 * the amount multiplied by the reach, which is the number that catches a typed
 * extra zero: «۵۰٬۰۰۰ تومان» looks like «۵٬۰۰۰ تومان» at a glance, and
 * «۵۶۰٬۰۰۰٬۰۰۰ تومان در مجموع» does not look like «۵۶٬۰۰۰٬۰۰۰».
 */

import { useEffect, useRef, useState } from 'react';
import {
  api,
  ApiError,
  type BroadcastAudience,
  type BulkPriceChange,
  type BulkPricePreview,
  type BulkSend,
  type PanelItem,
} from '../api.js';
import { count, dateTime, toman } from '../format.js';
import { parseChannelPostLink } from '@shikoo/contracts';

/**
 * What went out from here last, said next to the button that would do it again.
 *
 * The idempotency key stops one submission being applied twice. It cannot stop
 * a second decision, and it should not: a fresh batch is a legitimate new
 * charge. The mistake this screen actually invites is the one nothing guarded —
 * an operator who cannot see that everyone was credited twenty minutes ago, and
 * credits them again. The line below is the guard, and it is a sentence rather
 * than a control because the answer is usually "fine, go ahead".
 *
 * Read from `audit_logs`, which is append-only, so it cannot disagree with what
 * happened.
 */
function LastSend({ send, verb }: { send: BulkSend | null; verb: string }) {
  if (send === null) return null;
  return (
    <p className="muted">
      آخرین بار: {verb} {count(send.count)} مشتری
      {send.amountIrr === null ? '' : `، هر کدام ${toman(send.amountIrr)}`} — {dateTime(send.at)}،
      توسط {send.by}
      {/* Zero is not nothing-happened; it is a retry the key caught. Saying so
          stops it reading as a failure worth repeating. */}
      {send.count === 0 ? ' (ارسال تکراری بود و چیزی دوباره نرفت)' : ''}
    </p>
  );
}

/** Telegram refuses a longer message outright rather than truncating it. */
const MAX_MESSAGE_LENGTH = 4096;

/**
 * The audiences, in the words an operator picks them by.
 *
 * «سرویسش تمام شده» rather than «منقضی شده»: the server answers this from the
 * service's STATUS, not from an expiry date, because no imported service has
 * one (issue #92). Saying «منقضی» would promise a precision the data does not
 * have, and the day #92 lands the wording can get sharper.
 */
const AUDIENCES = [
  ['all', 'همهٔ مشتری‌های فعال'],
  ['never_bought', 'استارت زده و هیچ خریدی نکرده'],
  ['service_ended', 'سرویسش تمام شده و سرویس فعالی ندارد'],
  ['provider', 'سرویس فعال روی یک پنل مشخص دارد'],
] as const;

function message(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === 'forbidden') return 'برای این کار دسترسی ادمین لازم است.';
    if (e.code === 'no_active_customers') return 'هیچ مشتری فعالی نیست.';
    if (e.code === 'invalid_body') return 'ورودی پذیرفته نشد.';
    if (e.code === 'unsellable')
      return 'این کاهش، قیمت دست‌کم یک کانفیگ را به صفر یا زیر صفر می‌برد. هیچ قیمتی عوض نشد.';
    if (e.code === 'nothing_to_change')
      return 'این تغییر آن‌قدر کوچک است که هیچ قیمتی جابه‌جا نمی‌شود.';
    return e.detail ?? e.code;
  }
  return e instanceof Error ? e.message : String(e);
}

function newId(): string {
  return crypto.randomUUID();
}

export function BulkPage() {
  const [reach, setReach] = useState<number | null>(null);
  const [recent, setRecent] = useState<{
    credit: BulkSend | null;
    broadcast: BulkSend | null;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const [amount, setAmount] = useState('');
  const [batchId, setBatchId] = useState(newId);
  const [confirmingCredit, setConfirmingCredit] = useState(false);

  const [body, setBody] = useState('');
  /**
   * Which of the two things this announcement is.
   *
   * A tab rather than «paste a link OR type text and we work it out»: the two
   * produce completely different messages and the operator has already decided
   * which one they mean before they reach this screen.
   */
  const [messageKind, setMessageKind] = useState<'text' | 'post'>('text');
  const [postLink, setPostLink] = useState('');
  /**
   * Who hears it, and how many that is.
   *
   * `messageReach` is separate from the page's `reach` on purpose: the credit
   * card still charges every active customer, so one shared number would drift
   * the moment an audience is chosen here. `null` means «not counted yet», and
   * the button stays down until the server has answered — an operator must
   * never be able to send to an audience nobody has counted.
   */
  const [audienceKind, setAudienceKind] = useState<BroadcastAudience['kind']>('all');
  const [audiencePanel, setAudiencePanel] = useState('');
  const [messageReach, setMessageReach] = useState<number | null>(null);
  /** Which count request is the current one; see `loadMessageReach`. */
  const reachSeq = useRef(0);
  const [broadcastId, setBroadcastId] = useState(newId);
  const [confirmingMessage, setConfirmingMessage] = useState(false);

  const [panels, setPanels] = useState<PanelItem[] | null>(null);
  const [priceScope, setPriceScope] = useState('');
  const [priceMode, setPriceMode] = useState<'PERCENT' | 'FIXED'>('PERCENT');
  const [priceDir, setPriceDir] = useState<'UP' | 'DOWN'>('UP');
  const [priceAmount, setPriceAmount] = useState('');
  const [pricePreview, setPricePreview] = useState<BulkPricePreview | null>(null);
  /**
   * The key this change will commit under.
   *
   * Minted here rather than at the moment of pressing confirm, and deliberately
   * so: a lost response is exactly the case this exists for, and if the id were
   * chosen at press time the retry would carry a different one. It is replaced
   * when the form is edited — a new amount is a new operation — and after a
   * successful apply, so the next change is not answered with this one's
   * result.
   */
  const [priceOpId, setPriceOpId] = useState(newId);

  const [busy, setBusy] = useState(false);

  async function loadReach() {
    try {
      setReach((await api.bulkReach()).reach);
    } catch (e) {
      setErr(message(e));
    }
  }

  /**
   * The count for the audience currently chosen.
   *
   * Re-asked on every change rather than computed here, because the number an
   * operator approves has to come from the same predicate the send uses. A
   * count derived in the browser would agree until somebody edited one of them.
   */
  async function loadMessageReach(a: BroadcastAudience | null) {
    // Cleared BEFORE the request, not after it comes back. Between choosing a
    // new audience and the server answering, the old audience's number was
    // still in state — so the button stayed armed and the confirmation showed
    // one audience's name beside another's count. On a button with no undo.
    const mine = ++reachSeq.current;
    setMessageReach(null);
    if (a === null) return;
    try {
      const answer = (await api.bulkReach(a)).reach;
      // Two changes in quick succession can answer out of order, and the slower
      // first response would then overwrite the right count with a stale one.
      if (reachSeq.current === mine) setMessageReach(answer);
    } catch (e) {
      if (reachSeq.current !== mine) return;
      setMessageReach(null);
      setErr(message(e));
    }
  }

  /** Re-read after every send, so the line is never one send behind. */
  async function loadRecent() {
    try {
      const r = await api.bulkRecent();
      setRecent({ credit: r.credit, broadcast: r.broadcast });
    } catch {
      // Deliberately silent. This is a warning, not the work: an operator who
      // cannot see it should still be able to credit and broadcast, and an
      // error box over a failed advisory read would look like the send failed.
    }
  }

  useEffect(() => {
    void loadReach();
    void loadRecent();
    void (async () => {
      try {
        setPanels((await api.panels()).items);
      } catch (e) {
        setErr(message(e));
      }
    })();
  }, []);

  // Toman in, Rial out, through the one conversion this panel has. Digits only:
  // a separator or a minus sign typed here is a mistake, not a number.
  const toman10 = /^[0-9]+$/.test(amount.trim()) ? Number(amount.trim()) : null;
  const amountIrr = toman10 === null || toman10 <= 0 ? null : toman10 * 10;
  const trimmed = body.trim();
  /**
   * What the link was understood to mean, shown back before anything is sent.
   *
   * Parsed by the same function the server parses with — `@shikoo/contracts` —
   * so the screen cannot say one post and the route queue another. `null` is
   * «this is not a post link», and it is what keeps the button disabled.
   */
  const post = parseChannelPostLink(postLink);

  /**
   * The audience as the server takes it, or `null` while the panel picker is
   * still empty — «کاربران یک پنل» with no panel chosen is not an audience yet,
   * and counting it as «all» would be the wrong number under the right label.
   */
  const audience: BroadcastAudience | null =
    audienceKind !== 'provider'
      ? { kind: audienceKind }
      : audiencePanel === ''
        ? null
        : { kind: 'provider', providerId: Number(audiencePanel) };

  const contentReady = messageKind === 'text' ? trimmed !== '' : post !== null;
  const messageReady = contentReady && audience !== null && (messageReach ?? 0) > 0;
  const audienceLabel = AUDIENCES.find(([k]) => k === audienceKind)?.[1] ?? '';

  /*
   * Keyed on the audience's own two fields rather than on the object, which is
   * rebuilt on every render and would make this loop for ever.
   */
  useEffect(() => {
    void loadMessageReach(
      audienceKind !== 'provider'
        ? { kind: audienceKind }
        : audiencePanel === ''
          ? null
          : { kind: 'provider', providerId: Number(audiencePanel) },
    );
  }, [audienceKind, audiencePanel]);

  // Digits only, like the amount above. For FIXED the operator types Toman and
  // the panel converts once; for PERCENT the number is a percent and must not
  // be multiplied by anything.
  const priceDigits = /^[0-9]+$/.test(priceAmount.trim()) ? Number(priceAmount.trim()) : null;
  const priceChange: BulkPriceChange | null =
    priceDigits === null || priceDigits <= 0
      ? null
      : {
          providerId: priceScope === '' ? null : Number(priceScope),
          mode: priceMode,
          direction: priceDir,
          amount: priceMode === 'FIXED' ? priceDigits * 10 : priceDigits,
          operationId: priceOpId,
        };

  // Any edit invalidates a preview computed from the old form. A stale preview
  // beside a new amount is the worst thing this screen could show — and the key
  // goes with it, because a different amount is a different operation and must
  // not be answered with the previous one's result.
  useEffect(() => {
    setPricePreview(null);
    setPriceOpId(newId());
  }, [priceScope, priceMode, priceDir, priceAmount]);

  async function previewPrice() {
    if (priceChange === null) return;
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      setPricePreview((await api.bulkPricePreview(priceChange)).preview);
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitPrice() {
    if (priceChange === null) return;
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const r = await api.bulkPrice(priceChange);
      setDone(`قیمت ${count(r.changed)} کانفیگ به‌روز شد.`);
      setPriceAmount('');
      setPricePreview(null);
      // A fresh key for whatever comes next. Clearing the amount already does
      // this through the effect above; naming it here as well is what keeps it
      // true if that ever stops clearing.
      setPriceOpId(newId());
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
    }
  }

  async function submitCredit() {
    if (amountIrr === null) return;
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      const r = await api.bulkCredit({ amountIrr, batchId });
      setDone(`کیف پول ${count(r.credited)} مشتری شارژ شد.`);
      setAmount('');
      // A fresh batch for whatever they send next; the one just used stays
      // spent, so a stale tab cannot replay it.
      setBatchId(newId());
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
      setConfirmingCredit(false);
      // After, not before: the warning that matters is the one that names the
      // send the next operator is about to repeat.
      void loadRecent();
    }
  }

  async function submitBroadcast() {
    if (!messageReady) return;
    setBusy(true);
    setErr(null);
    setDone(null);
    try {
      // `audience` is non-null here: `messageReady` gates the button on it.
      const r = await api.broadcast(
        messageKind === 'text'
          ? { body: trimmed, broadcastId, audience: audience! }
          : { postLink, broadcastId, audience: audience! },
      );
      setDone(
        messageKind === 'text'
          ? `پیام برای ${count(r.queued)} مشتری در صف قرار گرفت. ربات آن را می‌فرستد.`
          : `پست برای ${count(r.queued)} مشتری در صف قرار گرفت — یک نسخه هم همین حالا در تاپیک «سایر گزارشات» فرستاده شد تا ببینیدش.`,
      );
      setBody('');
      setPostLink('');
      setBroadcastId(newId());
    } catch (e) {
      setErr(message(e));
    } finally {
      setBusy(false);
      setConfirmingMessage(false);
      void loadRecent();
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <div className="page-head__title">ارسال گروهی</div>
          <div className="page-head__sub">
            {reach === null ? '…' : `${count(reach)} مشتری فعال`}
          </div>
        </div>
      </div>

      {err && <div className="alert alert-error">{err}</div>}
      {done && <div className="alert alert-info">{done}</div>}

      <div className="card">
        <h3>شارژ گروهی کیف پول</h3>
        <p className="muted">
          به کیف پول هر مشتری فعال یک مبلغ اضافه می‌شود. برگشت‌پذیر نیست. اگر همین درخواست دو بار
          برسد، هر کیف پول فقط یک بار شارژ می‌شود.
        </p>
        <div className="filters">
          <div>
            <label className="form-label" htmlFor="bulk-amount">
              مبلغ برای هر نفر (تومان)
            </label>
            <input
              id="bulk-amount"
              className="form-control ltr"
              inputMode="numeric"
              value={amount}
              disabled={busy}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || amountIrr === null || !reach}
            onClick={() => setConfirmingCredit(true)}
          >
            ادامه
          </button>
        </div>
        <LastSend send={recent?.credit ?? null} verb="شارژ" />
      </div>

      {/* Directly under the card it confirms. Collected at the bottom of the
          page, both of these opened below the fold — the operator pressed
          «ادامه» and the screen appeared not to react. */}
      {confirmingCredit && amountIrr !== null && reach !== null && (
        <Confirm
          title="شارژ گروهی تایید شود؟"
          onCancel={() => setConfirmingCredit(false)}
          onConfirm={() => void submitCredit()}
          busy={busy}
        >
          <p>
            به کیف پول <strong>{count(reach)}</strong> مشتری، هر کدام{' '}
            <strong>{toman(amountIrr)}</strong> اضافه می‌شود.
          </p>
          {/* The number that actually catches a typed extra zero. */}
          <p>
            جمع کل: <strong>{toman(amountIrr * reach)}</strong>
          </p>
          <p className="muted">این کار برگشت‌پذیر نیست.</p>
        </Confirm>
      )}

      <div className="card" style={{ marginBlockStart: 16 }}>
        <h3>پیام همگانی</h3>
        <p className="muted">
          پیام برای هر مشتری فعال در صف می‌رود و ربات آن را می‌فرستد — نه از این صفحه. کسی که بعد از
          این لحظه /start بزند آن را نمی‌گیرد.
        </p>
        <div className="filters">
          <div>
            <label className="form-label" htmlFor="bulk-audience">
              برای چه کسانی
            </label>
            <select
              id="bulk-audience"
              className="form-control"
              value={audienceKind}
              disabled={busy}
              onChange={(e) => setAudienceKind(e.target.value as BroadcastAudience['kind'])}
            >
              {AUDIENCES.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </div>
          {audienceKind === 'provider' && (
            <div>
              <label className="form-label" htmlFor="bulk-audience-panel">
                پنل
              </label>
              {/* By id, from the catalogue. Matching the plan's NAME would empty
                  the audience the day somebody renames it, with nothing on any
                  screen to say so. */}
              <select
                id="bulk-audience-panel"
                className="form-control"
                value={audiencePanel}
                disabled={busy}
                onChange={(e) => setAudiencePanel(e.target.value)}
              >
                <option value="">— انتخاب کنید —</option>
                {(panels ?? []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
        {/* The number, before the press and not after. An audience an operator
            believed was a hundred people and is fifteen thousand has to be
            visible here. */}
        <p className="muted">
          {audience === null
            ? 'اول پنل را انتخاب کنید.'
            : messageReach === null
              ? 'در حال شمردن…'
              : messageReach === 0
                ? 'هیچ‌کس در این گروه نیست — چیزی فرستاده نمی‌شود.'
                : `${count(messageReach)} نفر این را می‌گیرند.`}
        </p>
        <div className="tabs">
          {(
            [
              ['text', 'متن پیام'],
              ['post', 'لینک پست کانال'],
            ] as const
          ).map(([k, label]) => (
            <button
              key={k}
              type="button"
              className={`tab${messageKind === k ? ' tab--on' : ''}`}
              disabled={busy}
              onClick={() => setMessageKind(k)}
            >
              {label}
            </button>
          ))}
        </div>
        {messageKind === 'text' ? (
          <div>
            <label className="form-label" htmlFor="bulk-body">
              متن پیام
            </label>
            <textarea
              id="bulk-body"
              className="form-control"
              rows={6}
              maxLength={MAX_MESSAGE_LENGTH}
              value={body}
              disabled={busy}
              onChange={(e) => setBody(e.target.value)}
            />
            <p className="muted">
              {count(trimmed.length)} از {count(MAX_MESSAGE_LENGTH)} نویسه
            </p>
          </div>
        ) : (
          <div>
            <label className="form-label" htmlFor="bulk-post">
              لینک پست
            </label>
            <input
              id="bulk-post"
              className="form-control"
              type="text"
              dir="ltr"
              placeholder="https://t.me/shikoonet/137"
              value={postLink}
              disabled={busy}
              onChange={(e) => setPostLink(e.target.value)}
            />
            {/* What the link was understood to mean, before it is sent to
                anybody. A link that points at a different post than the
                operator thinks is the one mistake nothing downstream catches. */}
            <p className="muted">
              {postLink.trim() === ''
                ? 'روی خود پست، «کپی لینک» را بزنید و این‌جا بچسبانید.'
                : post === null
                  ? 'این لینکِ یک پست نیست — باید مثل https://t.me/shikoonet/137 باشد.'
                  : `کانال ${post.chat} · پیام شمارهٔ ${count(post.messageId)}`}
            </p>
            <p className="muted">
              پست همان‌طور که هست فوروارد می‌شود — با عکس و قالب‌بندی، و با سربرگ «Forwarded
              from». ربات باید ادمین آن کانال باشد.
            </p>
          </div>
        )}
        <button
          type="button"
          className="btn btn-primary"
    disabled={busy || !messageReady}
          onClick={() => setConfirmingMessage(true)}
        >
          ادامه
        </button>
        <LastSend send={recent?.broadcast ?? null} verb="پیام به" />
      </div>

      <div className="card" style={{ marginBlockStart: 16 }}>
        <h3>تنظیم گروهی قیمت</h3>
        <p className="muted">
          قیمت همهٔ کانفیگ‌های فعالِ یک پنل را با هم جابه‌جا می‌کند. اول پیش‌نمایش بگیر — بعد از
          تایید، قیمت قبلی فقط در گزارش تغییرات می‌ماند.
        </p>
        <div className="filters">
          <div>
            <label className="form-label" htmlFor="bp-scope">
              پنل
            </label>
            <select
              id="bp-scope"
              className="form-control"
              value={priceScope}
              disabled={busy}
              onChange={(e) => setPriceScope(e.target.value)}
            >
              <option value="">همهٔ پنل‌ها</option>
              {(panels ?? []).map((x) => (
                <option key={x.id} value={String(x.id)}>
                  {x.name} ({count(x.planCount)} کانفیگ)
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="bp-dir">
              جهت
            </label>
            <select
              id="bp-dir"
              className="form-control"
              value={priceDir}
              disabled={busy}
              onChange={(e) => setPriceDir(e.target.value as 'UP' | 'DOWN')}
            >
              <option value="UP">افزایش</option>
              <option value="DOWN">کاهش</option>
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="bp-mode">
              نوع
            </label>
            <select
              id="bp-mode"
              className="form-control"
              value={priceMode}
              disabled={busy}
              onChange={(e) => setPriceMode(e.target.value as 'PERCENT' | 'FIXED')}
            >
              <option value="PERCENT">درصدی</option>
              <option value="FIXED">مبلغ ثابت</option>
            </select>
          </div>
          <div>
            <label className="form-label" htmlFor="bp-amount">
              {priceMode === 'PERCENT' ? 'درصد' : 'مبلغ (تومان)'}
            </label>
            <input
              id="bp-amount"
              className="form-control ltr"
              inputMode="numeric"
              value={priceAmount}
              disabled={busy}
              onChange={(e) => setPriceAmount(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || priceChange === null}
            onClick={() => void previewPrice()}
          >
            پیش‌نمایش
          </button>
        </div>
      </div>

      {pricePreview !== null && priceChange !== null && (
        <Confirm
          title="تغییر قیمت اعمال شود؟"
          onCancel={() => setPricePreview(null)}
          onConfirm={() => void submitPrice()}
          busy={busy}
          refused={pricePreview.unsellable > 0 || pricePreview.plans === 0}
        >
          {pricePreview.plans === 0 ? (
            <p>هیچ کانفیگ فعالی روی این پنل نیست.</p>
          ) : pricePreview.unsellable > 0 ? (
            <p>
              این کاهش، قیمت <strong>{count(pricePreview.unsellable)}</strong> کانفیگ را به صفر یا زیر
              صفر می‌برد. کانفیگی که قیمتش صفر است رایگان نمی‌شود — دکمه‌اش می‌ماند و هر بار رد می‌کند.
              هیچ قیمتی عوض نمی‌شود.
            </p>
          ) : (
            <>
              <p>
                <strong>{count(pricePreview.plans)}</strong> کانفیگ — جمع قیمت‌ها از{' '}
                <strong>{toman(pricePreview.currentTotalIrr)}</strong> به{' '}
                <strong>{toman(pricePreview.newTotalIrr)}</strong> می‌رود.
              </p>
              {pricePreview.unchanged > 0 && (
                <p className="muted">
                  {count(pricePreview.unchanged)} کانفیگ جابه‌جا نمی‌شود — تغییرش از یک تومان کمتر است.
                </p>
              )}
              {/* Real prices, not a delta. An operator checks the cheapest and
                  the dearest, which is what the ordering puts in reach. */}
              <ul>
                {pricePreview.examples.map((x) => (
                  <li key={x.name}>
                    {x.name}: {toman(x.fromIrr)} ← {toman(x.toIrr)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Confirm>
      )}

      {confirmingMessage && messageReach !== null && (
        <Confirm
          title={messageKind === 'text' ? 'پیام همگانی فرستاده شود؟' : 'این پست فوروارد شود؟'}
          onCancel={() => setConfirmingMessage(false)}
          onConfirm={() => void submitBroadcast()}
          busy={busy}
        >
          <p>
            {messageKind === 'text' ? 'این پیام' : 'این پست'} برای{' '}
            <strong>{count(messageReach)}</strong> مشتری در صف می‌رود —{' '}
            {audienceLabel}
            {audienceKind === 'provider'
              ? `: ${(panels ?? []).find((p) => String(p.id) === audiencePanel)?.name ?? ''}`
              : ''}
            .
          </p>
          {messageKind === 'text' ? (
            <pre className="code-scrollable">{trimmed}</pre>
          ) : (
            <>
              <pre className="code-scrollable" dir="ltr">
                {post === null ? '' : `${post.chat} / ${post.messageId}`}
              </pre>
              {/* Said before the press, not after: the rehearsal is the only
                  thing between «the bot is not in that channel» and eleven
                  thousand rows marked FAILED with nobody watching. */}
              <p className="muted">
                اول یک نسخه در تاپیک «سایر گزارشات» فرستاده می‌شود. اگر ربات به آن کانال
                دسترسی نداشته باشد، همین‌جا خطا می‌گیرید و هیچ‌چیز برای مشتری‌ها در صف نمی‌رود.
              </p>
            </>
          )}
          <p className="muted">بعد از تایید، جلوی فرستادن را نمی‌شود گرفت.</p>
        </Confirm>
      )}
    </>
  );
}

/**
 * A card, not a modal.
 *
 * The first version of this used `.modal-backdrop` / `.modal-body`, which are
 * the *hub's* class names — scoped to `:where(.hub)` and defined nowhere else,
 * so on a panel screen the confirmation rendered as bare text floating at the
 * top of the page with no surface behind it. The panel has no modal layer at
 * all; every other screen confirms in an inline card. Found by looking at it.
 *
 * ## And it scrolls itself into view
 *
 * A card in the page flow appears wherever the page happens to be long enough
 * to put it, which for the third card down is below the fold: the operator
 * presses the button, the request fires, the card renders — and the screen does
 * not appear to react. Playwright caught it on 2026-08-20, and only because the
 * assertion measures where the card IS rather than that it exists.
 *
 * `block: 'nearest'` scrolls the least that works, so a confirmation already on
 * screen — which is the ordinary case for the first card — does not move the
 * page under the operator's eyes.
 */
/**
 * `busy` and `refused` are two different things and used to be one.
 *
 * `busy` is "the request is in flight"; `refused` is "there is nothing to
 * send". Passing the second as the first made the button read «در حال ارسال…»
 * for a change the panel had already decided it would never make — an operator
 * watching a message that says sending, for ever, about nothing.
 */
function Confirm({
  title,
  children,
  onCancel,
  onConfirm,
  busy,
  refused = false,
}: {
  title: string;
  children: React.ReactNode;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
  refused?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  return (
    <div
      ref={ref}
      className="card"
      style={{ marginBlockStart: 16 }}
      role="group"
      aria-label={title}
    >
      <div className="card__head">
        <span className="card__title">{title}</span>
        <button type="button" className="btn btn-sm" disabled={busy} onClick={onCancel}>
          انصراف
        </button>
      </div>
      {children}
      <button
        type="button"
        className="btn btn-primary"
        disabled={busy || refused}
        onClick={onConfirm}
      >
        {busy ? 'در حال ارسال…' : 'تایید'}
      </button>
    </div>
  );
}
