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

/**
 * «۲ از ۳» plus what the missing one costs, or a bare count when unknown.
 *
 * `unit` because a bare «۲» is legible under a column headed «اینباند» and not
 * under one headed «تحویل» — the catalogue screen says «۲ اینباند» in full.
 */
export function InboundCount({ group, unit = '' }: { group: PanelGroupItem; unit?: string }) {
  const total = group.inboundTags?.length;
  if (total === undefined) return <>—</>;
  const live = group.deliverableInbounds;
  if (live === undefined) return <>{count(total) + unit}</>;
  return (
    <>
      <div>{(live === total ? count(total) : `${count(live)} از ${count(total)}`) + unit}</div>
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

/**
 * Name + inbounds — the whole of what a group is, wherever it is made.
 *
 * `id` prefixes the field ids because this form now appears on a screen that
 * can hold two of them at once; a bare `group-name` was fine when only one
 * existed and would silently point two labels at one input here.
 */
export function GroupForm({
  id,
  title,
  name,
  setName,
  tags,
  toggleTag,
  inbounds,
  inboundsReason,
  busy,
  submitLabel,
  onSubmit,
  onCancel,
  w,
}: {
  id: string;
  title: string;
  name: string;
  setName: (v: string) => void;
  tags: string[];
  toggleTag: (tag: string) => void;
  inbounds: Array<{ tag: string; hosted?: boolean }> | null;
  inboundsReason: string | null;
  busy: boolean;
  submitLabel: string;
  onSubmit: () => void;
  onCancel: () => void;
  w: Record<string, unknown>;
}) {
  // Empty selection is not "delivers nothing" — it is "nothing chosen yet".
  const undeliverable = tags.length > 0 && !anyHosted(inbounds, tags);

  return (
    <div className="card" style={{ marginBlock: 12 }}>
      <div className="card__head">
        <span className="card__title">{title}</span>
        <button type="button" className="btn btn-sm" onClick={onCancel}>
          انصراف
        </button>
      </div>
      <div className="filters">
        <div className="grow">
          <label className="form-label" htmlFor={`${id}-name`}>
            نام گروه
          </label>
          <input
            id={`${id}-name`}
            className="form-control"
            type="text"
            maxLength={120}
            placeholder="پلاتینیوم"
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...w}
          />
        </div>
      </div>

      <label className="form-label" style={{ marginBlockStart: 8 }}>
        اینباندها
      </label>
      <InboundPicker
        inbounds={inbounds}
        reason={inboundsReason}
        chosen={tags}
        onToggle={toggleTag}
        disabledProps={w}
      />

      {/* Said before the save, not after: a tier with no delivering inbound
          costs more than the cheap one and hands the customer the same thing,
          and nothing downstream ever complains about it. */}
      {undeliverable && (
        <div className="alert alert-warning">
          هیچ‌کدام از اینباندهای انتخاب‌شده هاست ندارد — مشتریِ این گروه هیچ کانفیگی نمی‌گیرد.
        </div>
      )}

      <div style={{ marginBlockStart: 12 }}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={busy || name.trim() === ''}
          onClick={onSubmit}
          {...w}
        >
          {busy ? 'در حال ذخیره…' : submitLabel}
        </button>
      </div>
    </div>
  );
}

