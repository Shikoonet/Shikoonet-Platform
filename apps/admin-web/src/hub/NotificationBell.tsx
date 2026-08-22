/**
 * NotificationBell — operational alert with shake + optional ding.
 *
 * Bell unread = Income queue + Bot Auto Verified only (per operator).
 * Baseline rule: first successful counts fetch establishes unread baseline;
 * no ding for historical unread items on page load.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { forMutation, QK } from './queries.js';
import type { Cache } from './query.js';
import {
  isNotificationSoundMuted,
  playNotificationDing,
  prefersReducedMotion,
  setNotificationSoundMuted,
  unlockNotificationAudio,
} from './notificationSound.js';
import { IconBell } from './paymentsIcons.js';

interface NotificationCounts {
  unread: number;
  incomeUnread?: number;
  botAutoVerifiedUnread?: number;
}

interface NotificationBellProps {
  cache: Cache;
  onNavigate?: (
    tab: 'payments' | 'statistics' | 'today',
    filter?: { kind: string; paymentTab?: string },
  ) => void;
}

interface CountsPayload {
  ok: boolean;
  counts: NotificationCounts;
}

export function NotificationBell({ cache, onNavigate }: NotificationBellProps) {
  const countsState = cache.useQuery<CountsPayload>(QK.notificationCounts, {
    fetcher: async (signal) => {
      const r = await fetch('/api/v1/notifications/counts', {
        credentials: 'include',
        signal,
      });
      if (!r.ok) throw new Error('counts-non-ok');
      return (await r.json()) as CountsPayload;
    },
  });
  const counts: NotificationCounts = countsState.data?.counts ?? { unread: 0 };
  const error = countsState.status === 'error';

  const incomeUnread = counts.incomeUnread ?? 0;
  const botUnread = counts.botAutoVerifiedUnread ?? 0;

  const [open, setOpen] = useState(false);
  const [markingAll, setMarkingAll] = useState(false);
  const [muted, setMuted] = useState(isNotificationSoundMuted);
  const [shaking, setShaking] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const baselineUnread = useRef<number | null>(null);

  useEffect(() => {
    if (countsState.status !== 'success' || countsState.data == null) return;
    const unread = counts.unread;
    if (baselineUnread.current === null) {
      baselineUnread.current = unread;
      return;
    }
    if (unread > baselineUnread.current) {
      baselineUnread.current = unread;
      if (!prefersReducedMotion()) {
        setShaking(true);
        window.setTimeout(() => setShaking(false), 450);
      }
      playNotificationDing();
    } else if (unread < baselineUnread.current) {
      baselineUnread.current = unread;
    }
  }, [counts.unread, countsState.status, countsState.data]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const onMarkAllRead = useCallback(async () => {
    setMarkingAll(true);
    try {
      await api.notificationsMarkAllRead();
      cache.invalidate(...forMutation('markAllRead'));
      baselineUnread.current = 0;
    } catch {
      /* ignore */
    } finally {
      setMarkingAll(false);
    }
  }, [cache]);

  const toggleMute = useCallback(() => {
    unlockNotificationAudio();
    setMuted((prev) => {
      const next = !prev;
      setNotificationSoundMuted(next);
      return next;
    });
  }, []);

  const badgeValue = counts.unread;
  const badge = badgeValue > 99 ? '99+' : String(badgeValue);

  return (
    <div className="notification-bell" ref={wrapRef}>
      <button
        type="button"
        className={`notification-bell__button${shaking ? ' notification-bell__button--shake' : ''}`}
        aria-label={`اعلان‌ها${badgeValue > 0 ? `، ${badgeValue} خوانده‌نشده` : ''}`}
        aria-expanded={open}
        aria-controls="notification-bell-dropdown"
        onClick={() => {
          unlockNotificationAudio();
          setOpen((prev) => !prev);
        }}
      >
        <span aria-hidden className="notification-bell__icon">
          <IconBell />
        </span>
        {badgeValue > 0 && (
          <span
            className={`notification-bell__badge${error ? ' notification-bell__badge--error' : ''}`}
          >
            {badge}
          </span>
        )}
      </button>
      {open && (
        <div className="notification-bell__dropdown" id="notification-bell-dropdown" role="menu">
          <div className="notification-bell__sound">
            <span>صدای اعلان</span>
            <button type="button" className="notification-bell__mute" onClick={toggleMute}>
              {muted ? 'بی‌صدا' : 'صدا روشن'}
            </button>
          </div>
          <div className="notification-bell__counts notification-bell__counts--scoped">
            <button
              type="button"
              className="count count--income"
              onClick={() => {
                setOpen(false);
                onNavigate?.('payments', { kind: 'income', paymentTab: 'income' });
              }}
            >
              <span className="count-label">واریزی</span>
              <span className="count-value">{incomeUnread}</span>
            </button>
            <button
              type="button"
              className="count count--verified"
              onClick={() => {
                setOpen(false);
                onNavigate?.('payments', {
                  kind: 'bot_auto_verified',
                  paymentTab: 'bot_auto_verified',
                });
              }}
            >
              <span className="count-label">تایید خودکار ربات</span>
              <span className="count-value">{botUnread}</span>
            </button>
          </div>
          <div className="notification-bell__recent">
            <div className="notification-bell__recent-header">
              <h3 className="notification-bell__heading">Alerts</h3>
              <button
                type="button"
                className="notification-bell__mark-all"
                onClick={onMarkAllRead}
                disabled={markingAll || counts.unread === 0}
              >
                {markingAll ? 'Marking…' : 'خواندن همه'}
              </button>
            </div>
            {counts.unread === 0 ? (
              <p className="notification-bell__empty">
                No unread income or bot auto verified items.
              </p>
            ) : (
              <p className="muted notification-bell__hint">
                {incomeUnread > 0 && `${incomeUnread} income`}
                {incomeUnread > 0 && botUnread > 0 && ' · '}
                {botUnread > 0 && `${botUnread} bot auto verified`}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
