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

import { useEffect, useState } from 'react';
import { premiumEmojiTag, renderedLabelLength, stripCustomEmoji } from '@shikoo/contracts';
import { api, type EmojiPack, type ButtonStyle } from '../api.js';
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

/**
 * Twenty-four characters AS DRAWN.
 *
 * Not as typed. A premium emoji is `<tg-emoji emoji-id="…">🔥</tg-emoji>` — 53
 * characters of markup that draw as one glyph, because a button's `text` is
 * plain in the Bot API and the emoji actually travels in `icon_custom_emoji_id`.
 * A raw `maxLength` of 24 refused every badge carrying one, which is the whole
 * of what this field was asked to allow.
 *
 * `renderedLabelLength` is the same function the worker's zod schema and
 * migration 0060's CHECK measure with, so the input, the route and the database
 * cannot disagree about what fits.
 */
export const BADGE_MAX = 24;

/** Room for the cap plus one tag, so typing is bounded without being wrong. */
const BADGE_RAW_MAX = 400;

/**
 * The premium emoji this shop has, and whether the bot will actually send them.
 *
 * Fetched here rather than threaded from four call sites. Its own failure is
 * swallowed for the reason `BotContentPages` swallows the same one: the picker
 * is a convenience beside the field, and a pack list that will not load must not
 * take down the form that edits the shop's catalogue.
 */
function usePremiumEmoji(): { packs: EmojiPack[]; on: boolean } {
  const [state, setState] = useState<{ packs: EmojiPack[]; on: boolean }>({ packs: [], on: false });
  useEffect(() => {
    let live = true;
    void api
      .emojiPacks()
      .then((d) => live && setState({ packs: d.packs, on: d.customEmoji }))
      .catch(() => {
        /* no picker, and the plain field still works */
      });
    return () => {
      live = false;
    };
  }, []);
  return state;
}

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
  const { packs, on: emojiOn } = usePremiumEmoji();
  // Appended, never replaced: a preset and a word already there are two chips
  // and one badge. Refused rather than sliced when it would not fit — slicing a
  // string that contains a `<tg-emoji>` tag cuts the tag in half, which is
  // markup the button cannot draw and the route now refuses by shape.
  // What a chip would leave in the box, so «does this fit» and «what is
  // written» are the same computation rather than two that agree by eye.
  const withChip = (chip: string) => (value.trim() === '' ? chip : `${value.trim()} ${chip}`);
  const fits = (next: string) => renderedLabelLength(next) <= BADGE_MAX;
  const add = (chip: string) => {
    if (fits(withChip(chip))) onChange(withChip(chip));
  };
  // One tag, at the front — the only shape `keyboardFor` can turn into
  // `icon_custom_emoji_id`. Anywhere else Telegram draws literal angle
  // brackets on the customer's screen.
  const addEmoji = (tag: string) => {
    const rest = value.trim();
    const next = rest === '' ? tag : `${tag} ${rest}`;
    if (!hasEmoji && fits(next)) onChange(next);
  };
  const drawn = renderedLabelLength(value);
  /*
   * ANY tag, not just one at the front.
   *
   * `startsWith` was the wrong question. A badge that already carries a tag
   * somewhere in the middle — pasted by hand — answered false, so the picker
   * stayed enabled and prepending a second one built a value the route then
   * refuses by shape. Asking whether there is a tag at all closes that: the
   * operator clears it first, which is what «بدون ایموجی» is for.
   */
  const hasEmoji = value.includes('<tg-emoji');
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
        maxLength={BADGE_RAW_MAX}
        placeholder="🆕 نیو"
        onChange={(e) => onChange(e.target.value)}
      />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBlockStart: 6 }}>
        {PRESETS.map((chipText) => (
          <button
            key={chipText}
            type="button"
            className="btn btn-sm"
            // Disabled rather than inert. It used to slice the result to the
            // cap, which cuts a `<tg-emoji>` tag in half and produces markup no
            // button can draw; refusing silently was the first fix and it left
            // a chip that looks pressable and does nothing. This says why.
            disabled={!fits(withChip(chipText))}
            title={fits(withChip(chipText)) ? undefined : `از ${BADGE_MAX} نویسه بیشتر می‌شود`}
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

      {/*
        The premium emoji, and only when the shop has them switched ON.

        Off, the bot strips the markup before it sends (`keyboardFor`), so the
        customer would see the fallback glyph while the panel showed the picked
        one — a control whose effect is invisible from the screen that offers
        it. Same gate `BotContentPages` puts on the same chips.

        One per badge, at the front, because that is the only place a button has
        to put it: the Bot API parses no markup in a button's `text`, and the
        emoji rides in `icon_custom_emoji_id` instead. Picking a second is
        refused by `addEmoji` rather than being offered and then rejected on
        save.
      */}
      {emojiOn && packs.some((pack) => pack.emoji.length > 0) && (
        <>
          <div className="form-label" style={{ marginBlockStart: 10 }}>
            ایموجی پریمیوم
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {packs.flatMap((pack) =>
              pack.emoji.map((e) => (
                <button
                  key={`${pack.id}-${e.id}`}
                  type="button"
                  className="btn btn-sm"
                  title={`${pack.title} — ${e.fallback}`}
                  disabled={hasEmoji}
                  onClick={() =>
                    addEmoji(premiumEmojiTag({ label: pack.title, fallback: e.fallback, id: e.id }))
                  }
                  {...w}
                >
                  {e.fallback}
                </button>
              )),
            )}
            {hasEmoji && (
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => onChange(value.replace(/^\s*<tg-emoji[^>]*>.*?<\/tg-emoji>\s*/, ''))}
                {...w}
              >
                بدون ایموجی
              </button>
            )}
          </div>
          <p className="muted" style={{ marginBlockStart: 4, marginBlockEnd: 0 }}>
            {/* Said plainly, because the picker cannot show it: these draw as
                the plain glyph for any customer whose client has no Premium. */}
            برای مشتری‌های بدون پریمیوم، همان ایموجی ساده دیده می‌شود.
          </p>
        </>
      )}

      {/* «۴ از ۲۴» — counted as the button draws it, so a badge with a premium
          emoji does not appear to be fifty characters long. */}
      <p className="muted" style={{ marginBlockStart: 4, marginBlockEnd: 0 }}>
        {`${drawn} از ${BADGE_MAX} نویسه روی دکمه`}
      </p>

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
          {/*
            Stripped, because this line claims to be «the button as the bot will
            draw it» and a `<tg-emoji>` tag is the one thing that is never on
            the button. The emoji travels in `icon_custom_emoji_id`; the label
            carries the fallback glyph, which is exactly what `stripCustomEmoji`
            leaves behind — and exactly what a customer without Premium sees.

            Done here rather than at the three call sites that build `preview`,
            so a fourth screen cannot get it wrong.
          */}
          {stripCustomEmoji(preview)}
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
