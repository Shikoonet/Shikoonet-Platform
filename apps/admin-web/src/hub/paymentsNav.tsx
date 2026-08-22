import type { ReactNode } from 'react';
import type { PaymentTab } from './paymentReview.js';
import {
  IconAll,
  IconBotVerified,
  IconDeclined,
  IconIncome,
  IconManualVerified,
  IconPayments,
  IconReseller,
  IconReview,
  IconSuspected,
  IconWaiting,
} from './paymentsIcons.js';

/*
 * The words, in the language the shop is run in.
 *
 * Wherever this codebase already had a Persian name for a state, that name is
 * reused rather than invented: `format.ts` has mapped `NEEDS_REVIEW` to «نیاز به
 * بررسی» and `PENDING` to «در انتظار» since before the panels merged, and two
 * names for one state is worse than an English one.
 *
 * «واریزی‌ها» rather than a literal «درآمد» for Income: these rows are bank
 * credits that no order has claimed yet, which is what the operator is looking
 * at — the shop's income is a different number on a different screen.
 */
const REVIEW_TABS = [
  {
    value: 'income' as const,
    label: 'واریزی‌ها',
    shortLabel: 'واریزی',
    countKey: 'income' as const,
    unreadKey: 'incomeUnread' as const,
    Icon: IconIncome,
  },
  {
    value: 'needs_review' as const,
    label: 'نیاز به بررسی',
    shortLabel: 'بررسی',
    countKey: 'needsReview' as const,
    unreadKey: 'needsReviewUnread' as const,
    Icon: IconReview,
  },
  {
    value: 'waiting' as const,
    label: 'در انتظار',
    shortLabel: 'انتظار',
    countKey: 'waiting' as const,
    Icon: IconWaiting,
  },
  {
    value: 'suspected_fake' as const,
    label: 'مشکوک به جعل',
    shortLabel: 'مشکوک',
    countKey: 'suspectedFake' as const,
    unreadKey: 'suspectedFakeUnread' as const,
    Icon: IconSuspected,
  },
  {
    value: 'bot_auto_verified' as const,
    label: 'تایید خودکار ربات',
    shortLabel: 'ربات',
    countKey: 'botAutoVerified' as const,
    unreadKey: 'botAutoVerifiedUnread' as const,
    Icon: IconBotVerified,
  },
] as const;

const PAYMENTS_TABS = [
  {
    value: 'manually_verified' as const,
    label: 'تایید دستی',
    shortLabel: 'دستی',
    countKey: 'manuallyVerified' as const,
    Icon: IconManualVerified,
  },
  {
    value: 'declined_income' as const,
    label: 'رد شده',
    shortLabel: 'رد شده',
    countKey: 'declinedIncome' as const,
    Icon: IconDeclined,
  },
  {
    value: 'all' as const,
    label: 'همه',
    shortLabel: 'همه',
    countKey: 'all' as const,
    Icon: IconAll,
  },
] as const;

type ReviewTab = (typeof REVIEW_TABS)[number]['value'];
type PaymentsGroupTab = (typeof PAYMENTS_TABS)[number]['value'];
type Level1Group = 'review' | 'reseller' | 'payments';

export function isReviewTab(tab: PaymentTab): tab is ReviewTab {
  return REVIEW_TABS.some((t) => t.value === tab);
}

export function isPaymentsGroupTab(tab: PaymentTab): tab is PaymentsGroupTab {
  return PAYMENTS_TABS.some((t) => t.value === tab);
}

function level1Group(tab: PaymentTab): Level1Group {
  if (tab === 'reseller') return 'reseller';
  if (isPaymentsGroupTab(tab)) return 'payments';
  return 'review';
}

export function level1GroupFromTab(tab: PaymentTab): Level1Group {
  return level1Group(tab);
}

export function parsePaymentTabFromLocation(search = window.location.search): PaymentTab {
  const raw = new URLSearchParams(search).get('tab');
  const allowed: PaymentTab[] = [
    'income',
    'needs_review',
    'declined_income',
    'waiting',
    'suspected_fake',
    'bot_auto_verified',
    'manually_verified',
    'reseller',
    'all',
  ];
  if (raw === 'auto_verified') return 'bot_auto_verified';
  if (raw && allowed.includes(raw as PaymentTab)) return raw as PaymentTab;
  return 'income';
}

export function syncPaymentTabToLocation(tab: PaymentTab) {
  const qs = new URLSearchParams(window.location.search);
  qs.set('tab', tab);
  const next = `${window.location.pathname}?${qs.toString()}`;
  window.history.replaceState(null, '', next);
}

function defaultSubTab(group: Level1Group): PaymentTab {
  if (group === 'payments') return 'manually_verified';
  return 'income';
}

function NavBadge({ count, unread }: { count?: number | undefined; unread?: number | undefined }) {
  const badges: ReactNode[] = [];
  if (count != null && count > 0) {
    badges.push(
      <span key="total" className="ops-nav__badge">
        {count}
      </span>,
    );
  }
  if (unread != null && unread > 0) {
    badges.push(
      <span key="unread" className="ops-nav__badge ops-nav__badge--new">
        +{unread}
      </span>,
    );
  }
  if (badges.length === 0) return null;
  return <span className="ops-nav__badges">{badges}</span>;
}

function navBadgeProps(count: number | undefined, unread?: number | undefined) {
  const props: { count?: number; unread?: number } = {};
  if (count != null) props.count = count;
  if (unread != null) props.unread = unread;
  return props;
}

export function PrimaryOpsNav({
  activeGroup,
  counts,
  onChange,
}: {
  activeGroup: Level1Group;
  counts: Record<string, number | undefined> | undefined;
  onChange: (group: Level1Group) => void;
}) {
  const reviewTotal =
    (counts?.income ?? 0) +
    (counts?.needsReview ?? 0) +
    (counts?.waiting ?? 0) +
    (counts?.suspectedFake ?? 0) +
    (counts?.botAutoVerified ?? 0);
  const paymentsTotal = (counts?.manuallyVerified ?? 0) + (counts?.declinedIncome ?? 0);

  return (
    <div
      className="ops-nav__strip ops-nav__strip--primary"
      role="tablist"
      aria-label="بخش‌های پرداخت"
    >
      <button
        type="button"
        role="tab"
        aria-selected={activeGroup === 'review'}
        aria-label="بررسی"
        className={`ops-nav__tab${activeGroup === 'review' ? ' ops-nav__tab--active' : ''}`}
        onClick={() => onChange('review')}
      >
        <IconReview className="ops-nav__tab-icon" />
        <span className="ops-nav__tab-label">بررسی</span>
        {reviewTotal > 0 && <NavBadge count={reviewTotal} />}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeGroup === 'reseller'}
        aria-label="نمایندگی"
        className={`ops-nav__tab${activeGroup === 'reseller' ? ' ops-nav__tab--active' : ''}`}
        onClick={() => onChange('reseller')}
      >
        <IconReseller className="ops-nav__tab-icon" />
        <span className="ops-nav__tab-label">نمایندگی</span>
        <NavBadge {...navBadgeProps(counts?.reseller, counts?.resellerUnread)} />
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={activeGroup === 'payments'}
        aria-label="بایگانی"
        className={`ops-nav__tab${activeGroup === 'payments' ? ' ops-nav__tab--active' : ''}`}
        onClick={() => onChange('payments')}
      >
        <IconPayments className="ops-nav__tab-icon" />
        {/* «بایگانی» rather than a second «پرداخت‌ها»: the sidebar already has
            that word one level up, and this group is the record of decided
            payments — verified, declined, and everything. */}
        <span className="ops-nav__tab-label">بایگانی</span>
        {paymentsTotal > 0 && <NavBadge count={paymentsTotal} />}
      </button>
    </div>
  );
}

/** @deprecated Use PrimaryOpsNav */
export const PrimaryPaymentNav = PrimaryOpsNav;

export function ReviewSubNav({
  activeGroup,
  tab,
  counts,
  onChange,
}: {
  activeGroup: Level1Group;
  tab: PaymentTab;
  counts: Record<string, number | undefined> | undefined;
  onChange: (tab: PaymentTab) => void;
}) {
  if (activeGroup === 'reseller') return null;

  const items = activeGroup === 'review' ? REVIEW_TABS : PAYMENTS_TABS;

  return (
    <div
      className="ops-nav__strip ops-nav__strip--secondary ops-nav__strip--review"
      role="tablist"
      aria-label={activeGroup === 'review' ? 'صف‌های بررسی' : 'فهرست‌های پرداخت'}
    >
      {items.map((item) => {
        const selected = tab === item.value;
        const unreadKey = 'unreadKey' in item ? item.unreadKey : undefined;
        const Icon = item.Icon;
        return (
          <button
            key={item.value}
            type="button"
            role="tab"
            aria-selected={selected}
            className={`ops-nav__subtab${selected ? ' ops-nav__subtab--active' : ''}`}
            onClick={() => onChange(item.value)}
          >
            <Icon className="ops-nav__subtab-icon" />
            <span className="ops-nav__subtab-label">{item.label}</span>
            <NavBadge
              {...navBadgeProps(
                counts?.[item.countKey],
                unreadKey ? counts?.[unreadKey] : undefined,
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

/** @deprecated Use ReviewSubNav */
export const SecondaryPaymentNav = ReviewSubNav;

export function PaymentsGroupedNav({
  tab,
  counts,
  onChange,
}: {
  tab: PaymentTab;
  counts: Record<string, number | undefined> | undefined;
  onChange: (tab: PaymentTab) => void;
}) {
  const activeGroup = level1Group(tab);

  function pickGroup(group: Level1Group) {
    if (group === activeGroup) return;
    if (group === 'reseller') {
      onChange('reseller');
      return;
    }
    onChange(defaultSubTab(group));
  }

  return (
    <nav className="ops-nav" aria-label="Payment hub views">
      <div className="ops-nav__level1 tabs-scroll">
        <PrimaryOpsNav activeGroup={activeGroup} counts={counts} onChange={pickGroup} />
      </div>
      <div className="ops-nav__level2 tabs-scroll">
        <ReviewSubNav activeGroup={activeGroup} tab={tab} counts={counts} onChange={onChange} />
      </div>
    </nav>
  );
}

export function HeaderPrimaryOpsNav({
  tab,
  counts,
  onChange,
}: {
  tab: PaymentTab;
  counts: Record<string, number | undefined> | undefined;
  onChange: (tab: PaymentTab) => void;
}) {
  const activeGroup = level1Group(tab);

  function pickGroup(group: Level1Group) {
    if (group === activeGroup) return;
    if (group === 'reseller') {
      onChange('reseller');
      return;
    }
    onChange(defaultSubTab(group));
  }

  return <PrimaryOpsNav activeGroup={activeGroup} counts={counts} onChange={pickGroup} />;
}
