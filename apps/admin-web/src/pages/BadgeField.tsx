/**
 * The two things an admin can put on a bot button: the text in front of its
 * name, and the colour of the button itself.
 *
 * ONE component for دسته‌بندی‌ها and محصولات because it writes the SAME two
 * columns on both: 0033 renamed `product_categories.emoji` to `badge` and gave
 * `product_plans` the same field, 0034 gave both `button_style`. A second
 * picker here would be a second idea of what fits on a button.
 *
 * WHY THE COLOUR IS NO LONGER A CHIP THAT TYPES «🔵».
 *
 * It used to be. Telegram inline buttons had no colour on any client, so the
 * only colour a customer could see was a coloured square read as a character,
 * and the eight chips here wrote that square into the badge text. Bot API 9.4
 * (9 February 2026) added `style` to InlineKeyboardButton — "primary" (blue),
 * "success" (green), "danger" (red) — so the colour is now the button, and the
 * squares are a workaround for a thing the API does properly. The squares that
 * are already saved in badges stay: they are text, and deleting an operator's
 * text is not this field's job.
 *
 * The badge stays free text. The presets are a shortcut into it, not a closed
 * set — «آف ۳۰٪» is a badge an operator will want and no list would have.
 */

import type { ButtonStyle } from '../api.js';
import { useAdminWriteProps } from '../role.js';

/** The four an operator reaches for, as whole badges rather than as words. */
const PRESETS = ['🆕 نیو', '🔥 آف', '⭐ ویژه', '⚡ سریع'];

/**
 * Telegram's three, named in Persian and painted in the panel's own tokens.
 *
 * The CSS variable is the panel's colour, not Telegram's: nothing here can know
 * what shade a given client draws, and a swatch that claimed to be exact would
 * be a promise the bot cannot keep. What it does promise is WHICH of the three.
 */
const STYLES: { value: ButtonStyle; label: string; token: string }[] = [
  { value: 'primary', label: 'آبی', token: 'var(--accent)' },
  { value: 'success', label: 'سبز', token: 'var(--success)' },
  { value: 'danger', label: 'قرمز', token: 'var(--danger)' },
];

export const BADGE_MAX = 24;

export function BadgeField({
  value,
  onChange,
  style,
  onStyleChange,
  id,
  /** The button as the bot will draw it, so the preview is not a guess. */
  preview,
}: {
  value: string;
  onChange: (v: string) => void;
  style: ButtonStyle | null;
  onStyleChange: (s: ButtonStyle | null) => void;
  id: string;
  preview: string;
}) {
  const w = useAdminWriteProps();
  // Appended, never replaced: a preset and a word already there are two chips
  // and one badge. Trimmed to the cap here rather than refused, because the
  // input's own maxLength does the same thing and the two must not disagree.
  const add = (chip: string) =>
    onChange((value.trim() === '' ? chip : `${value.trim()} ${chip}`).slice(0, BADGE_MAX));
  const painted = STYLES.find((s) => s.value === style);

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

      <div className="form-label" style={{ marginBlockStart: 10 }}>
        رنگ دکمه
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
        {STYLES.map((s) => (
          <button
            key={s.value}
            type="button"
            className="btn btn-sm"
            aria-pressed={style === s.value}
            title={`دکمه ${s.label} شود`}
            // The chip IS the colour when it is the chosen one, and only an
            // outline when it is not: three filled swatches side by side say
            // nothing about which one the button is wearing.
            style={
              style === s.value
                ? { background: s.token, borderColor: s.token, color: '#fff' }
                : { borderColor: s.token, color: s.token }
            }
            onClick={() => onStyleChange(s.value)}
            {...w}
          >
            {s.label}
          </button>
        ))}
        <button
          type="button"
          className="btn btn-sm"
          aria-pressed={style === null}
          onClick={() => onStyleChange(null)}
          {...w}
        >
          بدون رنگ
        </button>
      </div>

      <div className="page-head__sub" style={{ marginBlockStart: 6 }}>
        در ربات:{' '}
        {/* Drawn as a button rather than as bold text, because a colour on a
            word is not what the customer will see — the whole button is. */}
        <span
          style={{
            display: 'inline-block',
            padding: '4px 10px',
            borderRadius: 8,
            fontWeight: 700,
            background: painted ? painted.token : 'var(--surface-2, rgba(127,127,127,0.18))',
            color: painted ? '#fff' : 'inherit',
          }}
        >
          {preview}
        </span>
      </div>
    </div>
  );
}

/** What the field sends: an empty box means «no badge», which is NULL. */
export function badgeValue(value: string): string | null {
  const v = value.trim();
  return v === '' ? null : v;
}
