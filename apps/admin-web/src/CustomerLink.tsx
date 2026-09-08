/**
 * The customer a row is about, as a door rather than as text.
 *
 * Nine screens print a telegram id or an `@username` and stop there. The
 * review on 2026-09-07 called this the panel's central gap: thirty-one screens
 * and no way to cross between them, so «سفارش ناموفق، @reza_kh» means select
 * the handle, open «کاربران», paste, search, press «مدیریت» — five steps to
 * ask the one question every one of those rows provokes.
 *
 * ## Why a real `<a href>` and not a button
 *
 * A `<button onClick>` that pushes state looks the same and loses middle-click
 * and «open in new tab», on exactly the screens where comparing two customers
 * side by side is the job. So the href is real and the click handler is only
 * an optimisation over it: plain left click is intercepted so the SPA does not
 * reload, and every modified click is left alone for the browser.
 *
 * ## Why it needs nothing passed to it
 *
 * `useRoute`'s `navigate` lives in `App`, and threading it through nine call
 * sites — two of them inside the hub's own tree — would be the larger change.
 * `pushState` plus a synthetic `popstate` is what `navigate` itself does
 * (`route.ts`), and `useRoute`'s own listener does the rest.
 *
 * ## Why READ_ONLY gets no link
 *
 * That role cannot open «کاربران»: `READABLE_BY_READER` in `nav.ts` leaves it
 * out and `mayRead` answers 403. But it CAN open «پرداخت‌ها», «امروز» and
 * «آمار مالی», which print telegram ids — so without this branch the one role
 * that is all reading gets a door that answers 403.
 */

import { useRole } from './role.js';
import { pathForPage } from './route.js';

export interface LinkableCustomer {
  /** The internal `users.id`. Absent on the hub's payment rows, which carry
   *  only what the bank told us about. */
  id?: number | null;
  telegramId: number | string;
  username?: string | null;
}

export function CustomerLink({
  customer,
  className,
}: {
  customer: LinkableCustomer;
  className?: string;
}) {
  const label = customer.username ? `@${customer.username}` : String(customer.telegramId);
  const cls = className ?? 'ltr';

  if (useRole() === 'READ_ONLY') return <span className={cls}>{label}</span>;

  // `?id=` is exact. `?q=` is the search box's own fragment match, which is the
  // right fallback but not the same thing: it is one query away from the
  // customer rather than on them.
  const href =
    customer.id != null
      ? `${pathForPage('customers')}?id=${customer.id}`
      : `${pathForPage('customers')}?q=${encodeURIComponent(String(customer.telegramId))}`;

  return (
    <a
      className={cls}
      href={href}
      title={`پروندهٔ ${label}`}
      onClick={(e) => {
        // Ctrl/⌘/shift/middle click, or a right-click menu — the browser's job.
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
          return;
        }
        e.preventDefault();
        window.history.pushState(null, '', href);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }}
    >
      {label}
    </a>
  );
}
