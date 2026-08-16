/**
 * DEV-only filter strip for the "تایید خودکار ربات" view.
 *
 * Renders two segmented controls:
 *
 *   [ New Purchases | Renewals ]
 *   [ All | Today | Yesterday | Day Before Yesterday ]
 *
 * Defaults:
 *   - Purchase-type segment = "خریدهای جدید" the first time the user opens
 *     Bot Auto Verified.
 *   - Date filter           = "امروز".
 *
 * State persists in URL query string so refresh / back-nav keeps the chosen
 * segment. Keys:
 *   ?purchaseType=new|renewal
 *   ?dateFilter=all|today|yesterday|day_before_yesterday
 *
 * The worker accepts the existing `range=today` and `day=YYYY-MM-DD` parameters
 * for date filtering. For "دیروز" / "پریروز" we send
 *   range=day&day=<Tehran YYYY-MM-DD for that day>
 * which the worker already supports (see packages/domain/src/historyRange.ts).
 */

import { useEffect, useState } from 'react';
import {
  tehranAdjacentDay,
  tehranTodayDateString,
} from './historyRangeNav.js';

export type BotAutoVerifiedSegment = 'NEW_PURCHASE' | 'RENEWAL';
export type BotAutoVerifiedDateFilter =
  | 'ALL'
  | 'TODAY'
  | 'YESTERDAY'
  | 'DAY_BEFORE_YESTERDAY';

const SEGMENT_TO_QUERY: Record<BotAutoVerifiedSegment, string> = {
  NEW_PURCHASE: 'new',
  RENEWAL: 'renewal',
};
const QUERY_TO_SEGMENT: Record<string, BotAutoVerifiedSegment> = {
  new: 'NEW_PURCHASE',
  renewal: 'RENEWAL',
};

const DATE_TO_QUERY: Record<BotAutoVerifiedDateFilter, string> = {
  ALL: 'all',
  TODAY: 'today',
  YESTERDAY: 'yesterday',
  DAY_BEFORE_YESTERDAY: 'day_before_yesterday',
};
const QUERY_TO_DATE: Record<string, BotAutoVerifiedDateFilter> = {
  all: 'ALL',
  today: 'TODAY',
  yesterday: 'YESTERDAY',
  day_before_yesterday: 'DAY_BEFORE_YESTERDAY',
};

function readSearch(search: string): {
  segment: BotAutoVerifiedSegment;
  date: BotAutoVerifiedDateFilter;
} {
  const params = new URLSearchParams(search);
  const segmentRaw = params.get('purchaseType');
  const dateRaw = params.get('dateFilter');
  const segment =
    segmentRaw && segmentRaw in QUERY_TO_SEGMENT
      ? QUERY_TO_SEGMENT[segmentRaw]!
      : 'NEW_PURCHASE';
  const date =
    dateRaw && dateRaw in QUERY_TO_DATE ? QUERY_TO_DATE[dateRaw]! : 'TODAY';
  return { segment, date };
}

function writeSearch(
  search: string,
  segment: BotAutoVerifiedSegment,
  date: BotAutoVerifiedDateFilter,
): string {
  const params = new URLSearchParams(search);
  params.set('purchaseType', SEGMENT_TO_QUERY[segment]);
  params.set('dateFilter', DATE_TO_QUERY[date]);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export type BotAutoVerifiedFilterValue = {
  segment: BotAutoVerifiedSegment;
  date: BotAutoVerifiedDateFilter;
};

export function useBotAutoVerifiedFilter(): {
  value: BotAutoVerifiedFilterValue;
  setSegment: (s: BotAutoVerifiedSegment) => void;
  setDate: (d: BotAutoVerifiedDateFilter) => void;
  /**
   * URL params to append to /api/v1/payments. The worker reads:
   *   purchaseType=NEW_PURCHASE|RENEWAL  (only when ENABLE_PURCHASE_TYPE=true)
   *   range=today
   *   day=YYYY-MM-DD                     (Tehran calendar day)
   */
  toQueryParams: () => { purchaseType: string | null; range: string; day: string | null };
} {
  const [value, setValue] = useState<BotAutoVerifiedFilterValue>(() =>
    readSearch(window.location.search),
  );

  useEffect(() => {
    const onPop = () => setValue(readSearch(window.location.search));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  function push(next: BotAutoVerifiedFilterValue) {
    const nextSearch = writeSearch(window.location.search, next.segment, next.date);
    const nextUrl = `${window.location.pathname}${nextSearch}`;
    window.history.pushState(null, '', nextUrl);
    setValue(next);
  }

  function setSegment(s: BotAutoVerifiedSegment) {
    push({ segment: s, date: value.date });
  }

  function setDate(d: BotAutoVerifiedDateFilter) {
    push({ segment: value.segment, date: d });
  }

  function toQueryParams(): {
    purchaseType: string | null;
    range: string;
    day: string | null;
  } {
    if (value.date === 'ALL') {
      return { purchaseType: value.segment, range: 'all', day: null };
    }
    if (value.date === 'TODAY') {
      return { purchaseType: value.segment, range: 'today', day: null };
    }
    const today = tehranTodayDateString();
    if (value.date === 'YESTERDAY') {
      return {
        purchaseType: value.segment,
        range: 'day',
        day: tehranAdjacentDay(today, -1),
      };
    }
    return {
      purchaseType: value.segment,
      range: 'day',
      day: tehranAdjacentDay(today, -2),
    };
  }

  return { value, setSegment, setDate, toQueryParams };
}

const SEGMENT_OPTIONS: Array<{ value: BotAutoVerifiedSegment; label: string }> = [
  { value: 'NEW_PURCHASE', label: 'خریدهای جدید' },
  { value: 'RENEWAL', label: 'تمدیدها' },
];

const DATE_OPTIONS: Array<{ value: BotAutoVerifiedDateFilter; label: string }> = [
  { value: 'TODAY', label: 'امروز' },
  { value: 'YESTERDAY', label: 'دیروز' },
  { value: 'DAY_BEFORE_YESTERDAY', label: 'پریروز' },
  { value: 'ALL', label: 'همه' },
];

export function BotAutoVerifiedFilter({
  value,
  onSegmentChange,
  onDateChange,
}: {
  value: BotAutoVerifiedFilterValue;
  onSegmentChange: (s: BotAutoVerifiedSegment) => void;
  onDateChange: (d: BotAutoVerifiedDateFilter) => void;
}) {
  return (
    <div className="bot-filter">
      <div
        className="segmented"
        role="tablist"
        aria-label="فیلتر پرداخت‌های تاییدشده بر اساس نوع خرید"
      >
        {SEGMENT_OPTIONS.map((opt) => {
          const selected = value.segment === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`segmented__btn${selected ? ' segmented__btn--active' : ''}`}
              onClick={() => onSegmentChange(opt.value)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <div
        className="segmented segmented--dates"
        role="tablist"
        aria-label="فیلتر پرداخت‌های تاییدشده بر اساس تاریخ تایید"
      >
        {DATE_OPTIONS.map((opt) => {
          const selected = value.date === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={selected}
              className={`segmented__btn${selected ? ' segmented__btn--active' : ''}`}
              onClick={() => onDateChange(opt.value)}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
