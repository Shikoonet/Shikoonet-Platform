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

  // Stays up for a while after the last row goes: a test send to one customer
  // is over in under a second, and a bar that only exists while something is
  // unsent was never on screen long enough to be seen. Sam, 2026-09-17: «خیلی
  // مهمه برام». Ten minutes is long enough to walk back from another screen.
  const recent = send !== null && Date.now() - send.at < SHOW_FINISHED_FOR_MS;
  if (p === null || p.total === 0 || (left <= 0 && !recent)) return null;

  return (
    <span className="broadcast-progress" role="status">
      {/* The native element for «this much of a known total»; `accent-color`
          is how a browser is told what colour to draw it. */}
      <progress value={done} max={p.total} />
      <span>
        {count(Math.floor((done / p.total) * 100))}٪ رفته —{' '}
        {left > 0 ? `${count(left)} مانده` : 'تمام شد'}
        {p.failed > 0 ? `، ${count(p.failed)} نرسید` : ''}
      </span>
    </span>
  );
}
