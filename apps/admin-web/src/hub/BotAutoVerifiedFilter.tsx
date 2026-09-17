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
import { tehranAdjacentDay, tehranTodayDateString } from './historyRangeNav.js';

/** «همه» is the tab unfiltered; the other four split it without overlap. */
export type BotAutoVerifiedSegment =
  | 'ALL'
  | 'FIRST_PURCHASE'
  | 'RENEWAL'
  | 'REPEAT_PURCHASE'
  | 'WALLET_TOPUP';
export type BotAutoVerifiedDateFilter = 'ALL' | 'TODAY' | 'YESTERDAY' | 'DAY_BEFORE_YESTERDAY';

const SEGMENT_TO_QUERY: Record<BotAutoVerifiedSegment, string> = {
  ALL: 'all',
  FIRST_PURCHASE: 'first',
  RENEWAL: 'renewal',
  REPEAT_PURCHASE: 'repeat',
  WALLET_TOPUP: 'wallet',
};
const QUERY_TO_SEGMENT: Record<string, BotAutoVerifiedSegment> = {
  all: 'ALL',
  first: 'FIRST_PURCHASE',
  renewal: 'RENEWAL',
  repeat: 'REPEAT_PURCHASE',
  wallet: 'WALLET_TOPUP',
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
    segmentRaw && segmentRaw in QUERY_TO_SEGMENT ? QUERY_TO_SEGMENT[segmentRaw]! : 'ALL';
  const date = dateRaw && dateRaw in QUERY_TO_DATE ? QUERY_TO_DATE[dateRaw]! : 'TODAY';
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
   *   purchaseType=FIRST_PURCHASE|RENEWAL|REPEAT_PURCHASE|WALLET_TOPUP  (absent on «همه»)
   *   range=today
   *   day=YYYY-MM-DD                     (Tehran calendar day)
   */
  toQueryParams: () => { purchaseType: string | null; range: string; day: string | null };
} {
  const [value, setValue] = useState<BotAutoVerifiedFilterValue>(() =>
    readSearch(window.location.search),
  );
  const purchaseType = value.segment === 'ALL' ? null : value.segment;

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
      return { purchaseType, range: 'all', day: null };
    }
    if (value.date === 'TODAY') {
      return { purchaseType, range: 'today', day: null };
    }
    const today = tehranTodayDateString();
    if (value.date === 'YESTERDAY') {
      return {
        purchaseType,
        range: 'day',
        day: tehranAdjacentDay(today, -1),
      };
    }
    return {
      purchaseType,
      range: 'day',
      day: tehranAdjacentDay(today, -2),
    };
  }

  return { value, setSegment, setDate, toQueryParams };
}

const SEGMENT_OPTIONS: Array<{ value: BotAutoVerifiedSegment; label: string }> = [
  { value: 'ALL', label: 'همه' },
  // The two halves of a new purchase: the customer's first paid service, or
  // one more beside what they already own.
  { value: 'FIRST_PURCHASE', label: 'خرید اولی‌ها' },
  { value: 'RENEWAL', label: 'تمدید' },
  { value: 'REPEAT_PURCHASE', label: 'خرید چندم' },
  { value: 'WALLET_TOPUP', label: 'شارژ کیف پول' },
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
