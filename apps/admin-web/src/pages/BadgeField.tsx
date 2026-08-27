/**
 * The thing drawn in front of a button's name — «🆕», «🔴 آف», «⭐ ویژه».
 *
 * ONE component for دسته‌بندی‌ها and محصولات because it writes ONE column: 0033
 * renamed `product_categories.emoji` to `badge` and gave `product_plans` the
 * same field with the same CHECK, so a second picker here would be a second
 * idea of what fits on a button.
 *
 * WHY THE COLOUR CHIPS ARE EMOJI AND NOT A COLOUR PICKER.
 *
 * Telegram inline buttons have no colour — not the label, not the background,
 * on no client. The only colour a customer ever sees on a button is a coloured
 * square read as a character. A `<input type="color">` here would let an
 * operator pick #E11D48, save it, and see nothing change in the bot; the chips
 * store the character Telegram will actually draw, so what the panel shows and
 * what the customer gets are the same string.
 *
 * The field itself stays free text. The chips are a shortcut into it, not a
 * closed set — «آف ۳۰٪» is a badge an operator will want and no list would
 * have.
 */

import { useAdminWriteProps } from '../role.js';

/** What Telegram renders as a colour. Squares, not circles: they read wider. */
const COLORS = ['🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪'];

/** The four an operator reaches for, as whole badges rather than as words. */
const PRESETS = ['🆕 نیو', '🔥 آف', '⭐ ویژه', '⚡ سریع'];

export const BADGE_MAX = 24;

export function BadgeField({
  value,
  onChange,
  id,
  /** The button as the bot will draw it, so the preview is not a guess. */
  preview,
}: {
  value: string;
  onChange: (v: string) => void;
  id: string;
  preview: string;
}) {
  const w = useAdminWriteProps();
  // Appended, never replaced: a colour and a word are two chips and one badge.
  // Trimmed to the cap here rather than refused, because the input's own
  // maxLength does the same thing and the two must not disagree.
  const add = (chip: string) =>
    onChange((value.trim() === '' ? chip : `${value.trim()} ${chip}`).slice(0, BADGE_MAX));

  return (
    <div>
      <label className="form-label" htmlFor={id}>
        نشان روی دکمه
      </label>
      <input
        id={id}
        className="form-control"
        value={value}
        maxLength={BADGE_MAX}
        placeholder="🆕 نیو"
        onChange={(e) => onChange(e.target.value)}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBlockStart: 6 }}>
        {COLORS.map((chipColor) => (
          <button
            key={chipColor}
            type="button"
            className="btn btn-sm"
            title={`${chipColor} به نشان اضافه شود`}
            onClick={() => add(chipColor)}
            {...w}
          >
            {chipColor}
          </button>
        ))}
        {PRESETS.map((chipText) => (
          <button
            key={chipText}
            type="button"
            className="btn btn-sm"
            onClick={() => add(chipText)}
            {...w}
          >
            {chipText}
          </button>
        ))}
        {value !== '' && (
          <button type="button" className="btn btn-sm" onClick={() => onChange('')} {...w}>
            پاک کن
          </button>
        )}
      </div>
      <div className="page-head__sub" style={{ marginBlockStart: 6 }}>
        در ربات: <strong>{preview}</strong>
      </div>
    </div>
  );
}

/** What the field sends: an empty box means «no badge», which is NULL. */
export function badgeValue(value: string): string | null {
  const v = value.trim();
  return v === '' ? null : v;
}
