/**
 * Whose panel this is.
 *
 * ## Why this exists
 *
 * «شیکو» was written into `index.html`, `App.tsx` and `LoginPage.tsx`, and
 * there was not one `VITE_*` variable in the whole app. That is fine for our
 * own installations and it is the one thing that stops the reseller model
 * working: a reseller gets a complete installation of this platform — their own
 * bot, database, domain and dashboard — and they cannot sell a panel with OUR
 * name across the top of it. `deploy/README.md` has had this recorded as the
 * remaining white-label work for a while.
 *
 * ## Why it is not a build-time variable
 *
 * A `VITE_BRAND_NAME` would be baked into the bundle, which means one BUILD per
 * reseller. The whole shape of the reseller plan is one image and many stacks —
 * «ما یک ایمیج داریم و ده استک، نه ده فورک» — and ten bundles is ten forks
 * wearing a different hat. So the name is read at RUN time, from the
 * environment of the container that serves the page, and the same bundle serves
 * every installation.
 *
 * ## Why the default is ours and not empty
 *
 * An unset `BRAND_NAME` has to draw something, and «پنل مدیریت» with no name is
 * a panel that looks broken. Our own boxes set nothing and keep reading «شیکو»,
 * which means this change is invisible to every installation that exists today
 * — and that is the point: a reseller sets one variable, and nobody else has to
 * do anything.
 */

/** What the panel calls itself when `BRAND_NAME` is not set. */
export const DEFAULT_BRAND_NAME = 'شیکو';

/** The longest a brand name may be, in characters. */
export const MAX_BRAND_NAME = 40;

/**
 * A brand name from an untrusted or absent source, made safe to draw.
 *
 * The value reaches the page through a public endpoint and is rendered as
 * text — React escapes it, so this is not about markup. It is about a name that
 * would break the layout or read as a blank: control characters, a newline that
 * turns a one-line header into two, forty characters of padding, or an empty
 * string from a variable somebody set to `""` meaning «no brand».
 *
 * Falls back rather than throwing. A panel that will not open because its own
 * name is malformed is a worse failure than one that opens under the default,
 * and the operator can see which they got.
 */
export function brandName(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return DEFAULT_BRAND_NAME;
  // Control characters, not just whitespace: a name carrying U+0000-U+001F
  // or U+007F survives a `.trim()` when they sit in the middle and draws as
  // nothing, or as a line break that turns a one-line header into two.
  const clean = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (clean === '') return DEFAULT_BRAND_NAME;
  // `Array.from` rather than `.slice`, for the same reason `brandMark` below
  // uses it: `.slice` counts UTF-16 code units, so a name whose 40th character
  // is an emoji would be cut through the middle of a surrogate pair and draw a
  // replacement box as its last letter. The limit is a limit on CHARACTERS.
  return Array.from(clean).slice(0, MAX_BRAND_NAME).join('');
}

/**
 * The single character the sidebar draws in its square.
 *
 * Derived rather than configured. A second variable would be a second thing to
 * set and a second thing to get wrong, and «the first letter of the name» is
 * what the square has always held — «ش» for «شیکو».
 *
 * `Array.from` rather than `[0]`, because a name may open with an emoji or any
 * character outside the BMP, and indexing a string would take half of it and
 * draw a replacement box.
 */
export function brandMark(name: string): string {
  return Array.from(name)[0] ?? DEFAULT_BRAND_NAME[0]!;
}
