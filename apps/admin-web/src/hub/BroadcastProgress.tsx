/**
 * How far the last «پیام همگانی» has got — in the header, beside «حالت تداوم».
 *
 * A broadcast is queued, not sent: the bot paces itself through the recipient
 * snapshot, and at Telegram's ceiling sixteen thousand customers take about
 * eleven minutes. The operator who pressed the button has left the page long
 * before that, so the bar lives in the header, which is on every screen, and
 * shows only while something is still to go. Sam asked for it here and green
 * (2026-09-17).
 *
 * Polls its own endpoint the way `useContinuityMode` does — every thirty
 * seconds to notice a broadcast queued by somebody else, every five while one
 * is in flight so the bar actually moves.
 */

import { useEffect, useState } from 'react';
import { api, type BulkSend } from '../api.js';
import { count } from '../format.js';

const SHOW_FINISHED_FOR_MS = 10 * 60 * 1000;

/**
 * «حدود ۴ دقیقه» — how long the rest should take at the pace so far.
 *
 * Pace is rows done over time since the broadcast was queued, which is the
 * honest average: it includes every 429 pause the bot has already sat
 * through. Nothing is said until something has gone, because a rate from
 * zero rows is not a rate.
 */
function eta(done: number, left: number, queuedAt: number, now: number): string | null {
  const elapsed = now - queuedAt;
  if (done === 0 || elapsed <= 0) return null;
  const ms = (left * elapsed) / done;
  if (ms < 60_000) return 'کمتر از یک دقیقه';
  const min = Math.round(ms / 60_000);
  return min < 60 ? `حدود ${count(min)} دقیقه` : `حدود ${count(Math.round(min / 60))} ساعت`;
}

export function BroadcastProgress() {
  const [send, setSend] = useState<BulkSend | null>(null);
  const p = send?.progress ?? null;
  const done = p === null ? 0 : p.sent + p.failed;
  const left = p === null ? 0 : p.total - done;

  useEffect(() => {
    const refresh = async () => {
      try {
        setSend((await api.bulkRecent()).broadcast);
      } catch {
        /* a bar, not a gate; a failed read hides it */
      }
    };
    void refresh();
    const t = setInterval(() => void refresh(), left > 0 ? 5_000 : 30_000);
    return () => clearInterval(t);
  }, [left > 0]);

  // Stays up for a while after the LAST ROW goes — not after the broadcast was
  // queued, which for a 16k send is ten minutes before it finishes. A test
  // send to one customer is over in under a second, and a bar that only
  // exists while something is unsent was never on screen long enough to be
  // seen. Sam, 2026-09-17: «خیلی مهمه برام».
  const now = Date.now();
  const recent = send !== null && now - (p?.lastAt ?? send.at) < SHOW_FINISHED_FOR_MS;
  if (send === null || p === null || p.total === 0 || (left <= 0 && !recent)) return null;
  const remaining = left > 0 ? eta(done, left, send.at, now) : null;

  return (
    <span className="broadcast-progress" role="status">
      {/* The native element for «this much of a known total»; `accent-color`
          is how a browser is told what colour to draw it. */}
      <progress value={done} max={p.total} />
      <span>
        {count(Math.floor((done / p.total) * 100))}٪ رفته —{' '}
        {left > 0 ? `${count(left)} مانده` : 'تمام شد'}
        {remaining !== null ? ` (${remaining})` : ''}
        {p.failed > 0 ? `، ${count(p.failed)} نرسید` : ''}
        {left > 0 ? ` — ${whatIsHappening(p, now)}` : ''}
      </span>
    </span>
  );
}

/**
 * Why the bar is moving, or why it is not (#364).
 *
 * «مانده» used to be one number for three states, and on 2026-09-17 the bar
 * sat on 12% for fifty minutes with nothing on the screen saying Telegram
 * had asked for exactly that. The order is the order of what an operator
 * should know first: a ban, then a bot that has gone quiet, then the pace.
 */
function whatIsHappening(p: NonNullable<BulkSend['progress']>, now: number): string {
  // Whatever else is queued: a 429 puts ONE row into `waiting` and the pause
  // holds every other one too, so requiring the queue to be empty showed a
  // ban as «ارسالی نمی‌رود» (CodeRabbit on #372).
  if (p.waiting > 0 && p.waitingUntil !== null && p.waitingUntil > now) {
    const min = Math.max(1, Math.ceil((p.waitingUntil - now) / 60_000));
    return `تلگرام گفته صبر کنید — تا حدود ${count(min)} دقیقهٔ دیگر`;
  }
  if (p.stranded > 0) return `${count(p.stranded)} ردیف نیمه‌کاره مانده — ربات وسط ارسال ری‌استارت شده`;
  if (p.lastAt !== null && now - p.lastAt > 60_000 && p.sentLastMinute === 0) {
    return `ارسالی نمی‌رود — آخرین ارسال ${count(Math.round((now - p.lastAt) / 1000))} ثانیه پیش`;
  }
  return `${count(p.sentLastMinute)} در دقیقه`;
}
