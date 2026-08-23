/**
 * The two widgets that say whether a group can actually deliver anything.
 *
 * They lived inside `PanelsPage` until the catalogue screen needed the same
 * answer — and it needs it more, because that is where a service is built out
 * of a group in the first place. Two copies of "how many of these inbounds
 * reach a customer" is exactly the kind of duplication that lets one of them
 * quietly stop agreeing with the panel.
 *
 * Both encode one measured fact, not a style choice: **an inbound with no host
 * gives the customer nothing.** It is in every listing, counts toward every
 * total, and delivers zero. Measured on the test panel on 2026-08-23 — a `vip`
 * group with two inbounds handed over exactly the same single config that a
 * `normal` group with one did, until a host went on the second and the same
 * subscription link came back with two configs and nothing re-delivered.
 *
 * So a raw count is shown quietly and a deliverable count loudly. An operator
 * building a پلاتینیوم out of "this group has more inbounds" is reading the
 * number that does not decide anything.
 */

import type { PanelGroupItem } from './api.js';
import { count } from './format.js';

/** «۲ از ۳» plus what the missing one costs, or a bare count when unknown. */
export function InboundCount({ group }: { group: PanelGroupItem }) {
  const total = group.inboundTags?.length;
  if (total === undefined) return <>—</>;
  const live = group.deliverableInbounds;
  if (live === undefined) return <>{count(total)}</>;
  return (
    <>
      <div>{live === total ? count(total) : `${count(live)} از ${count(total)}`}</div>
      {live < total && (
        <div className="page-head__sub">
          {count(total - live)} اینباند بدون هاست — به مشتری کانفیگ نمی‌دهد
        </div>
      )}
      {live === 0 && total > 0 && <span className="badge badge-block">هیچ کانفیگی نمی‌دهد</span>}
    </>
  );
}

/**
 * Picking inbounds for a group, out of what the panel actually has.
 *
 * The legacy wizard took a typed comma-separated list, so a mistyped tag saved
 * cleanly and delivered nothing — the tier existed, cost more, and handed the
 * customer the cheap set. Nothing anywhere said so.
 *
 * `hosted === false` is called out on the row rather than hidden, because it is
 * the same failure wearing a different hat.
 */
export function InboundPicker({
  inbounds,
  reason,
  chosen,
  onToggle,
  disabledProps,
}: {
  inbounds: Array<{ tag: string; hosted?: boolean }> | null;
  reason: string | null;
  chosen: string[];
  onToggle: (tag: string) => void;
  disabledProps: Record<string, unknown>;
}) {
  if (inbounds === null) {
    return (
      <div className="alert alert-warning">
        فهرست اینباندها از پنل خوانده نشد{reason ? ` — ${reason}` : ''}.
      </div>
    );
  }
  if (inbounds.length === 0) {
    return <div className="alert alert-warning">این پنل هیچ اینباندی ندارد.</div>;
  }
  return (
    <div className="pick-list">
      {inbounds.map((i) => {
        const on = chosen.includes(i.tag);
        return (
          <label key={i.tag} className={on ? 'pick pick--on' : 'pick'}>
            <input type="checkbox" checked={on} onChange={() => onToggle(i.tag)} {...disabledProps} />
            <span>
              <span className="ltr">{i.tag}</span>
              {i.hosted === false && (
                <div className="page-head__sub">بدون هاست — به مشتری کانفیگ نمی‌دهد</div>
              )}
            </span>
          </label>
        );
      })}
    </div>
  );
}

/** Whether the chosen inbounds include at least one that reaches a customer. */
export function anyHosted(
  inbounds: Array<{ tag: string; hosted?: boolean }> | null,
  chosen: string[],
): boolean {
  if (inbounds === null) return true; // Unknown is not the same as "no".
  return chosen.some((tag) => inbounds.find((i) => i.tag === tag)?.hosted !== false);
}
