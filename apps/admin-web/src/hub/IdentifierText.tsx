/**
 * Display a single account identifier in the dashboard.
 *
 * - Always LTR + monospace so leading zeros and dotted forms are preserved.
 * - title attribute carries the full value for hover tooltips.
 * - Plain selectable text — no copy button. Long identifiers stay inside the
 *   cell via `overflow-wrap: break-word`, which breaks only when the value
 *   genuinely cannot fit. `anywhere` would also collapse the container's
 *   min-content width, splitting account numbers mid-digit in narrow columns.
 *
 * That paragraph was right and the code under it was wrong for as long as both
 * existed. It was enforced with an inline `overflowWrap` — which cannot work,
 * because `styles.css` was setting `word-break: break-all` on this same
 * element, and `word-break` is a DIFFERENT PROPERTY that no inline
 * `overflow-wrap` overrides. The min-content collapse this header warns about
 * happened on every wide table until 2026-08-24.
 *
 * So the rule lives in ONE place now — `.identifier-text code` in
 * `styles.css` — and this component states the intent rather than restating
 * the declaration. A defence written twice is a defence that can disagree with
 * itself, and this one did.
 *
 * For secrets (one-time device tokens), use the dedicated Copy button in
 * the device-setup flow, not this component.
 */
import { count } from '../format.js';

export interface IdentifierTextProps {
  value: string | null | undefined;
  /** Optional small label that goes inline with the value (e.g. "(ACCOUNT_NUMBER)"). */
  label?: string;
  /** Class for the outer code element (e.g. "hint" for account_hint tone, "masked" otherwise). */
  tone?: 'masked' | 'hint';
  /** When provided, render as <a> with this href. */
  href?: string;
  /** Tooltip override. Defaults to the value itself. */
  title?: string;
}

export function IdentifierText({
  value,
  label,
  tone = 'masked',
  href,
  title,
}: IdentifierTextProps) {
  if (!value) return <span className="muted">—</span>;
  const body = (
    <code
      className={tone}
      dir="ltr"
      title={title ?? value}
      style={{
        userSelect: 'text',
        cursor: 'text',
      }}
    >
      {value}
    </code>
  );
  return (
    <span className="identifier-text">
      {href ? <a href={href}>{body}</a> : body}
      {label && <small className="muted"> ({label})</small>}
    </span>
  );
}

/** Display the first detected identifier with type label + full value. */
export interface DetectedIdentifierCellProps {
  detected: Array<{
    type: 'ACCOUNT_NUMBER' | 'CARD_LAST_FOUR' | 'IBAN' | 'ACCOUNT_HINT';
    normalized_value: string;
    masked_value: string;
  }>;
  /** When multiple, render "+N" badge for the count of overflow. */
  overflowCount?: boolean;
}

export function DetectedIdentifierCell({ detected, overflowCount }: DetectedIdentifierCellProps) {
  if (detected.length === 0) return <span className="muted">—</span>;
  const head = detected[0]!;
  return (
    <span className="detected-cell">
      <IdentifierText value={head.normalized_value} label={head.type} />
      {overflowCount && detected.length > 1 && (
        <small className="muted"> +{detected.length - 1}</small>
      )}
    </span>
  );
}

/** Renders a list of detected identifiers, one row per line (used in modals/details). */
export function DetectedIdentifierList({
  detected,
}: {
  detected: Array<{
    type: 'ACCOUNT_NUMBER' | 'CARD_LAST_FOUR' | 'IBAN' | 'ACCOUNT_HINT';
    normalized_value: string;
    masked_value: string;
    parser_id: string;
    confidence: number;
  }>;
}) {
  if (detected.length === 0) return <p className="muted">شناسه‌ای تشخیص داده نشد.</p>;
  return (
    <ul className="list-plain detected-list">
      {detected.map((d) => (
        <li key={`${d.type}-${d.normalized_value}`} className="identifier">
          <IdentifierText value={d.normalized_value} />{' '}
          <small className="muted">
            {d.type} — اطمینان {count(Math.round(d.confidence * 100))}٪
          </small>
          <br />
          <small className="muted">تحلیل‌شده توسط {d.parser_id}</small>
        </li>
      ))}
    </ul>
  );
}
